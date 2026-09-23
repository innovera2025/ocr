"""W3a: the confirm route is audit-only, and the page-ordered harness that proves it (plan §2.5, §3 W3a, §1D).

No customer data: the pages are the synthetic form, the answers are generated and the labels are invented here. What is
pinned is the mechanism -- that a confirmation made on one page can no longer change what the next page reads, and that
the harness which measures it still reproduces the harm W3a removed when the retired switch is flipped in-process.
"""

import ocr_model
import ocr_normalize as N
import pytest
import synthetic_form as S
from conftest import FakeModel, png_of
from tools import learning_loop

MISREAD = "Treatment : ใทบ 90 นาที\nTherapist Name : พิพิ\nRoom No. : 3"


def label(page, therapist="ฟ้า", treatments=(("นวดไทย", 90),)):
    """One labels.json entry for the synthetic page. Only the staff fields matter here; the rest must merely be valid."""
    return {"page": page, "formNo": "01234", "date": "16/08/26", "uncertainFields": [],
            "customer": {"name": "Chun", "nationality": "Chinese", "hotelName": None, "gender": None,
                         "referralSources": [], "healthConditions": []},
            "recommendation": {"pressure": None, "massageOilScrub": [], "preferredAreas": [], "avoidAreas": []},
            "staff": {"treatments": [{"name": n, "durationMinutes": m} for n, m in treatments],
                      "totalAsWritten": None, "therapist": therapist, "room": "3"}}


def sections(therapist_value="พีพี", flagged=True, raw="พิพิ", treatments=(("นวดไทย", False, "ไทย"),)):
    """A replayed page, reduced to what `confirmations` reads."""
    return {"staffOnly": {
        "therapistName": {"raw": raw, "value": therapist_value, "needsReview": flagged},
        "treatments": [{"raw": f"{name_raw} 90", "nameRaw": name_raw, "value": value, "needsReview": review}
                       for value, review, name_raw in treatments]}}


@pytest.fixture
def stored(client, monkeypatch):
    """One stored v3 response for a page whose therapist is a flagged fuzzy match, as `results-prod/pNNN.json` holds it."""
    monkeypatch.setenv("OCR_SECTION_MODE", "staff-separate")
    monkeypatch.setattr(ocr_model, "call_ocr", FakeModel(staff=MISREAD, logprob=-0.05))
    body = client.post("/v1/ocr", files={"file": ("form.png", png_of(S.filled_form()), "image/png")}).json()
    therapist = body["staffOnly"]["therapistName"]
    assert (therapist["raw"], therapist["value"], therapist["source"], therapist["needsReview"]) == ("พิพิ", "พีพี", "master-fuzzy", True)
    return body


# ------------------------------------------------------------------ the app's weight rule (document-view.ts:305,362)

def test_an_edited_field_confirms_under_both_rules():
    for rule in ("v3.2", "w3a"):
        sent, ambiguous = learning_loop.confirmations(sections(), label(1, therapist="ฟ้า"), rule)
        assert not ambiguous
        assert ("therapist", "พิพิ", "ฟ้า", True) in sent


def test_a_flagged_but_unedited_field_confirms_only_under_the_pre_w3a_rule():
    """§2.5.2: the workbench posts the whole draft, so 'still flagged' is not 'the reviewer said yes to this value'."""
    page, want = sections(therapist_value="ฟ้า", flagged=True), label(1, therapist="ฟ้า")
    assert learning_loop.confirmations(page, want, "v3.2")[0] == [("therapist", "พิพิ", "ฟ้า", False)]
    assert learning_loop.confirmations(page, want, "w3a")[0] == []


def test_an_unflagged_unedited_field_never_confirms_under_either_rule():
    page, want = sections(therapist_value="ฟ้า", flagged=False), label(1, therapist="ฟ้า")
    assert learning_loop.confirmations(page, want, "v3.2")[0] == []
    assert learning_loop.confirmations(page, want, "w3a")[0] == []


@pytest.mark.parametrize("page,want", [
    (sections(raw=None), label(1, therapist="ฟ้า")),   # no raw reading: document-view.ts requires nonEmpty(oldRaw)
    (sections(), label(1, therapist=None)),            # the reviewer cleared the field: nonEmpty(newValue) fails
])
def test_a_confirmation_needs_both_a_key_and_a_saved_value(page, want):
    assert learning_loop.confirmations(page, want, "v3.2")[0] == []


def test_treatments_confirm_by_name_raw_and_only_when_the_pairing_is_unambiguous():
    page = sections(treatments=(("นวดไทย", True, "ไทย"), (None, True, "ฟุต")))
    sent, ambiguous = learning_loop.confirmations(page, label(1, treatments=(("นวดไทย", 90), ("นวดเท้า", 60))), "v3.2")
    assert not ambiguous
    assert [c for c in sent if c[0] == "treatment"] == [("treatment", "ไทย", "นวดไทย", False), ("treatment", "ฟุต", "นวดเท้า", True)]
    # One item read, two labelled: `legacyTreatmentIndex` refuses an ambiguous target and so does the simulation.
    sent, ambiguous = learning_loop.confirmations(page, label(1, treatments=(("นวดไทย", 90),)), "v3.2")
    assert ambiguous and [c for c in sent if c[0] == "treatment"] == []


def test_an_unknown_weight_rule_is_refused():
    with pytest.raises(ValueError):
        learning_loop.confirmations(sections(), label(1), "whatever")


# ------------------------------------------------------------------ the loop itself

def test_a_confirmation_can_no_longer_change_the_next_page(stored):
    """The whole of W3a in one assertion: the same two pages, page 1 confirmed to a different therapist."""
    pages, labels = {1: stored, 2: stored}, {1: label(1, therapist="ฟ้า"), 2: label(2, therapist="ฟ้า")}

    totals, stats = learning_loop.run(labels, pages, "w3a")
    assert stats["confirmations"] == 4 and stats["weight0"] == 0  # therapist + treatment, both edited, on both pages
    assert stats["memoryHits"] == 0, "the confirm route is audit-only: nothing may be served back from it"
    assert totals.field("staffOnly.therapistName")["right"] == 0

    was_v32, _ = learning_loop.run(labels, pages, "v3.2")
    assert was_v32.field("staffOnly.therapistName")["right"] == 1, "the retired memory made page 2 'right' from page 1"


def test_the_w3a_loop_is_identical_to_the_stateless_replay(stored):
    pages = {1: stored, 2: stored, 3: stored}
    labels = {p: label(p, therapist="ฟ้า") for p in pages}
    runs = {mode: learning_loop.run(labels, pages, mode) for mode in learning_loop.MODES}
    assert learning_loop.verdict(runs) == []
    assert learning_loop.print_report(runs) is True
    assert runs["v3.2"][1]["memoryHits"] > 0, "the comparison run must still exercise the retired memory"


def test_the_loop_restores_the_switch_and_the_environment(stored, monkeypatch):
    monkeypatch.setenv("OCR_VERIFIED_FILE", "/tmp/should-not-be-touched.jsonl")
    learning_loop.run({1: label(1)}, {1: stored}, "v3.2")
    assert N.VERIFIED_MEMORY_ENABLED is False, "a measurement run must never leave the retired memory switched on"
    assert str(N.verified_path()) == "/tmp/should-not-be-touched.jsonl"
    assert not N.verified_path().exists(), "the loop writes to its own throwaway file, never to the configured one"


def test_an_unknown_mode_is_refused(stored):
    with pytest.raises(ValueError):
        learning_loop.run({1: label(1)}, {1: stored}, "v9")
