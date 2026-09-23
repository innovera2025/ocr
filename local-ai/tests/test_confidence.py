"""Token-logprob confidence (ocr_confidence): span mapping, thresholds, application to fields."""

import json
import math

import pytest

import fake_ollama
import ocr_confidence as C
import ocr_model
import ocr_normalize as N


def answer(text, logprob=-0.01, low=None, size=4):
    return ocr_model.ModelText(text, [(bytes(t["bytes"]), t["logprob"]) for t in fake_ollama.fake_tokens(text, logprob, low, size)])


def test_spans_map_to_byte_level_tokens_that_split_thai_characters():
    text = "Treatment : ไทย 90 นาที\nTherapist Name : พีพี\nRoom No. : 3"
    token_map = C.TokenMap(answer(text, low={"พีพี": -1.2}))
    assert token_map.ok
    span = token_map.find("พีพี", "therapist")
    assert text[span[0]:span[1]] == "พีพี"
    stats = token_map.stats(span)
    assert stats["mean"] == round(math.exp(-1.2), 3) and stats["min"] == round(math.exp(-1.2), 3) and stats["tokens"] == 4  # 12 bytes / 4


def test_values_are_found_after_their_label_with_digit_boundaries_and_loose_separators():
    token_map = C.TokenMap(answer("SUKHUMVIT 33\nTreatment: ไทย / ๙๐นาที + หน้า 1 ชม.\nRoom No. 3"))
    start, end = token_map.find("3", "room")
    assert token_map.text[start:end] == "3" and start > 20  # not the 3 of "33"
    start, end = token_map.find("ไทย 90 นาที", "treatment")  # Thai digits and a separator in between
    assert token_map.text[start:end] == "ไทย / 90นาที"
    assert token_map.find("เท้า", "treatment") is None


def test_tokens_that_do_not_spell_the_answer_are_ignored():
    broken = ocr_model.ModelText("ไทย 90", [(b"x", -0.1), (b"y", -0.2)])
    assert not C.TokenMap(broken).ok and not C.TokenMap("plain text, no logprobs").ok
    prefixed = ocr_model.ModelText("ไทย", [(b"\n", -0.5), ("ไทย".encode(), -0.1)])  # a leading token the text lost
    token_map = C.TokenMap(prefixed)
    assert token_map.ok and token_map.stats(token_map.find("ไทย"))["mean"] == round(math.exp(-0.1), 3)


def test_thresholds_have_env_overrides(monkeypatch):
    assert C.threshold("name") == 0.85 and C.threshold("treatment") == 0.80 and C.threshold("room") == C.threshold("formNumber") == 0.90
    monkeypatch.setenv("OCR_MODEL_CONFIDENCE_HOTEL_NAME", "0.5")
    monkeypatch.setenv("OCR_MODEL_CONFIDENCE_FORM_NUMBER", "7")
    monkeypatch.setenv("OCR_MODEL_CONFIDENCE_ROOM", "high")
    assert C.threshold("hotelName") == 0.5 and C.threshold("formNumber") == 1.0 and C.threshold("room") == 0.90


def test_apply_uses_min_confidence_and_skips_fields_the_model_did_not_read():
    staff_text = "Treatment : ไทย 90 นาที\nTherapist Name : พีพี\nRoom No. : 3"
    items = N.parse_treatments("ไทย 90 นาที")[0]
    sections = {
        "header": {"formNumber": N.field("01234", "01234", 0.9, "ocr", False), "date": N.field(None, None, 0.95, "ink-mark", False),
                   "time": N.field(None, None, 0.0, "none", True)},
        "customerInformation": {"name": N.field("Chun", "Chun", 0.8, "ocr", False), "nationality": N.field(None, None, 0.93, "ink-mark", False),
                                "hotelName": N.field(None, None, 0.93, "ink-mark", False)},
        "staffOnly": {"treatments": items, "therapistName": N.field("พีพี", "พีพี", 1.0, "master-fuzzy", False),
                      "roomNo": N.field("3", "3", 0.95, "ocr", False)},
    }
    evidence = C.apply(sections, {"header": answer("No. 01234\nName: Chun", low={"Chun": -0.3}), "customer": None,
                                  "staff": answer(staff_text, low={"3": -0.1})})
    assert set(evidence) == {"header.formNumber", "staffOnly.treatments.0", "staffOnly.therapistName", "staffOnly.roomNo"}
    assert sections["header"]["formNumber"]["confidence"] == 0.9 and not sections["header"]["formNumber"]["needsReview"]
    assert sections["customerInformation"]["name"]["confidence"] == 0.8  # its answer (customer) is None: rules stand
    assert sections["staffOnly"]["roomNo"]["confidence"] == 0.905 and sections["staffOnly"]["roomNo"]["needsReview"] is False  # >= 0.90
    assert sections["staffOnly"]["therapistName"]["confidence"] == 0.99
    assert sections["header"]["date"] == N.field(None, None, 0.95, "ink-mark", False)  # untouched
    no_logprobs = C.apply(sections, {"header": "No. 01234", "customer": None, "staff": staff_text})
    assert no_logprobs == {}


@pytest.mark.parametrize("value", ["ไทย 90 นาที", "90 นาที ไทย"])
def test_a_value_the_answer_does_not_hold_is_reported_as_unmapped(value):
    items = N.parse_treatments(value)[0]
    sections = {"header": {k: N.field(None, None, 0.0, "none", True) for k in N.HEADER_FIELDS},
                "customerInformation": {k: N.field(None, None, 0.0, "none", True) for k in N.CUSTOMER_FIELDS},
                "staffOnly": {"treatments": items, "therapistName": N.field(None, None, 0.0, "none", True),
                              "roomNo": N.field(None, None, 0.0, "none", True)}}
    evidence = C.apply(sections, {"header": None, "customer": None, "staff": answer("Treatment: เท้า 30 นาที")})
    assert evidence == {"staffOnly.treatments.0": None} and items[0]["confidence"] in (0.95, 1.0)


# ---------------------------------------------------------------- review fixes (adversarial review of v3.2)

def ollama_answer(text, logprob=-0.01, low=None):
    """The answer as Ollama's OpenAI endpoint returns it from llama-server (fake_ollama.ollama_view): a Thai character split
    over two tokens comes back as "" + "\\ufffd", and "bytes" are taken from that text."""
    choice = {"message": {"content": text}, "logprobs": {"content": fake_ollama.ollama_view(fake_ollama.fake_tokens(text, logprob, low))}}
    return ocr_model.ModelText(text, ocr_model._tokens(choice))


def char_answer(text, low=None, logprob=-0.01):
    """One token per character; low = {character index: probability}."""
    return ocr_model.ModelText(text, [(c.encode("utf-8"), math.log((low or {}).get(i, math.exp(logprob)))) for i, c in enumerate(text)])


def test_split_thai_characters_without_their_bytes_still_map():
    """Ollama takes a token's bytes from its text, and llama-server cuts a partial UTF-8 character off a token's text: one
    split Thai character made the whole answer unmappable (every staff field fell back to its rule confidence)."""
    text = "SUKHUMVIT 33\nTreatment : ไทย 90 นาที + หน้า 1 ชม.\nTherapist Name : พีพี\nRoom No. : 3"
    answer = ollama_answer(text, low={"พีพี": -1.2, "หน้า 1": -0.7})
    assert b"".join(data for data, _ in answer.tokens) != text.encode("utf-8")  # the tokens lost bytes
    token_map = C.TokenMap(answer)
    assert token_map.ok
    assert token_map.stats(token_map.find("พีพี", "therapist"))["mean"] == round(math.exp(-1.2), 3)
    assert token_map.stats(token_map.find("3", "room"))["mean"] == round(math.exp(-0.01), 3)
    assert token_map.stats(token_map.find("ไทย 90 นาที", "treatment"))["min"] == round(math.exp(-0.01), 3)
    assert token_map.stats(token_map.find("หน้า 1 ชม."))["min"] == round(math.exp(-0.7), 3)
    assert not C.TokenMap(ocr_model.ModelText("ไทย 90", [(b"", -0.1), (b"x", -0.2)])).ok  # still: tokens that spell something else


@pytest.mark.parametrize("text", ["ไทย", "ไทย 90 นาที", "a ไ b", "ไ"])
def test_every_answer_byte_is_covered_by_a_token_after_alignment(text):
    token_map = C.TokenMap(ollama_answer(text))
    assert token_map.ok and token_map.stats((0, len(text))) is not None
    covered = set()
    for start, end, _ in token_map.bounds:
        covered.update(range(start, end))
    assert covered == set(range(len(text.encode("utf-8"))))


def test_digit_fields_are_judged_by_their_weakest_digit():
    """"One wrong digit is a wrong value": a date with one 40 % digit among nine confident tokens averaged 0.904 >= 0.90."""
    text = "Date: 16/08/2026"
    sections = {"header": {"formNumber": N.field(None, None, 0.0, "none", True), "date": N.field("16/08/2026", "2026-08-16", 0.8, "ocr", False),
                           "time": N.field(None, None, 0.0, "none", True)},
                "customerInformation": {k: N.field(None, None, 0.0, "none", True) for k in N.CUSTOMER_FIELDS},
                "staffOnly": {"treatments": [], "therapistName": N.field(None, None, 0.0, "none", True), "roomNo": N.field(None, None, 0.0, "none", True)}}
    evidence = C.apply(sections, {"header": char_answer(text, {text.index("8"): 0.4}), "customer": None, "staff": None})
    assert evidence["header.date"]["mean"] >= 0.9 and evidence["header.date"]["min"] == 0.4
    assert sections["header"]["date"]["needsReview"] is True and sections["header"]["date"]["confidence"] == 0.4


@pytest.mark.parametrize("kind, text, value, doubtful", [
    ("name", "Name: Cynthia De La Cruz", "Cynthia De La Cruz", "z"),       # one 30 % letter in 18 tokens: mean 0.927
    ("treatment", "Treatment: ไทย 90 นาที", "ไทย 90 นาที", "9"),          # one 40 % duration digit: mean 0.82
])
def test_one_doubtful_token_in_a_longer_value_needs_review(kind, text, value, doubtful):
    items = N.parse_treatments(value)[0] if kind == "treatment" else []
    sections = {"header": {k: N.field(None, None, 0.0, "none", True) for k in N.HEADER_FIELDS},
                "customerInformation": {**{k: N.field(None, None, 0.0, "none", True) for k in N.CUSTOMER_FIELDS},
                                        **({"name": N.field(value, value, 0.8, "ocr", False)} if kind == "name" else {})},
                "staffOnly": {"treatments": items, "therapistName": N.field(None, None, 0.0, "none", True), "roomNo": N.field(None, None, 0.0, "none", True)}}
    answer = char_answer(text, {text.rindex(doubtful): 0.3 if kind == "name" else 0.4})
    evidence = C.apply(sections, {"header": None, "customer": answer if kind == "name" else None, "staff": answer if kind == "treatment" else None})
    key, field = ("customerInformation.name", sections["customerInformation"]["name"]) if kind == "name" else ("staffOnly.treatments.0", items[0])
    assert evidence[key]["mean"] >= C.threshold(kind) and evidence[key]["min"] < C.threshold("token")
    assert field["needsReview"] is True


def test_the_token_floor_has_an_env_override(monkeypatch):
    assert C.threshold("token") == 0.5
    monkeypatch.setenv("OCR_MODEL_CONFIDENCE_TOKEN", "0.2")
    assert C.threshold("token") == 0.2


def test_non_finite_logprobs_are_not_used():
    """Python's json accepts NaN / Infinity: a NaN logprob made the field NaN and the response unserialisable (HTTP 500)."""
    for bad in (float("nan"), float("inf"), float("-inf")):
        assert ocr_model._tokens({"logprobs": {"content": [{"token": "a", "logprob": bad}]}}) is None
    assert ocr_model._tokens({"logprobs": {"content": [{"token": "a", "logprob": 0.2}]}}) == ((b"a", 0.0),)  # never above p = 1


def test_review_is_decided_on_unrounded_probabilities():
    """exp(mean) = 0.8496 was rounded to 0.85 before the comparison with the 0.85 name threshold: not flagged."""
    lp = math.log(0.8496)
    answer = ocr_model.ModelText("Name: Chun", [(b"Name: ", -0.01), (b"Chun", lp)])
    sections = {"header": {k: N.field(None, None, 0.0, "none", True) for k in N.HEADER_FIELDS},
                "customerInformation": {**{k: N.field(None, None, 0.0, "none", True) for k in N.CUSTOMER_FIELDS},
                                        "name": N.field("Chun", "Chun", 0.8, "ocr", False)},
                "staffOnly": {"treatments": [], "therapistName": N.field(None, None, 0.0, "none", True), "roomNo": N.field(None, None, 0.0, "none", True)}}
    evidence = C.apply(sections, {"header": None, "customer": answer, "staff": None})
    assert evidence["customerInformation.name"]["mean"] == 0.85  # reported rounded
    assert sections["customerInformation"]["name"]["needsReview"] is True


# ------------------------------------------------------------------ calibration file (plan §3 W6, §4 G6, §8.6)


def calibration_file(tmp_path, monkeypatch, thresholds):
    path = tmp_path / "calibration.json"
    path.write_text(json.dumps({"thresholds": thresholds}), encoding="utf-8")
    monkeypatch.setenv("OCR_CALIBRATION_FILE", str(path))
    return path


def test_the_shipped_calibration_file_holds_the_two_w6_moves():
    """The W6 release: nationality 0.85 -> 0.80 and date 0.90 -> 0.85, each with its evidence. REVIEW_BELOW keeps v3.2's
    values as the fallback, so losing the file only flags MORE fields."""
    entries = json.loads((C.HERE / "calibration.json").read_text(encoding="utf-8"))["thresholds"]
    assert set(entries) == {"nationality", "date"}
    assert C.threshold("nationality") == 0.80 and C.threshold("date") == 0.85
    assert C.REVIEW_BELOW["nationality"] == 0.85 and C.REVIEW_BELOW["date"] == 0.90
    for kind, entry in entries.items():
        assert entry["movedFrom"] == C.REVIEW_BELOW[kind] and entry["acceptedBecause"].strip()
        assert abs(entry["reviewBelow"] - entry["movedFrom"]) <= C.CALIBRATION_MAX_MOVE + 1e-9
    assert C.calibration_state() == "ok"


def test_the_calibration_file_moves_a_threshold_and_an_env_override_still_wins(tmp_path, monkeypatch):
    calibration_file(tmp_path, monkeypatch, {"hotelName": {"reviewBelow": 0.80, "movedFrom": 0.85,
                                                           "acceptedBecause": "measured on the 95-page benchmark"}})
    assert C.threshold("hotelName") == 0.80 and C.threshold("name") == 0.85  # untouched types keep REVIEW_BELOW
    monkeypatch.setenv("OCR_MODEL_CONFIDENCE_HOTEL_NAME", "0.95")
    assert C.threshold("hotelName") == 0.95


@pytest.mark.parametrize("entry, why", [
    ({"reviewBelow": 0.80, "movedFrom": 0.85}, "no acceptedBecause"),
    ({"reviewBelow": 0.80, "movedFrom": 0.85, "acceptedBecause": "  "}, "empty acceptedBecause"),
    ({"reviewBelow": 0.50, "movedFrom": 0.85, "acceptedBecause": "the all-data argmin"}, "moves further than ±0.05"),
    ({"reviewBelow": 0.80, "acceptedBecause": "no previous value to clamp against"}, "no movedFrom"),
    ({"reviewBelow": "0.80", "movedFrom": 0.85, "acceptedBecause": "a string"}, "not a number"),
    ({"reviewBelow": 0.50, "movedFrom": 0.55, "acceptedBecause": "a self-declared baseline"}, "movedFrom is not the value in force"),
    ({"reviewBelow": 0.00, "movedFrom": 0.05, "acceptedBecause": "a self-declared baseline"}, "movedFrom is not the value in force"),
])
def test_a_threshold_move_without_evidence_or_beyond_the_clamp_is_refused(tmp_path, monkeypatch, entry, why):
    """§4 G6: no threshold moves without recorded held-out evidence, and none further than ±0.05 per release. A refused
    file leaves REVIEW_BELOW in force -- more review, never a silently unflagged field -- and says so on /health."""
    calibration_file(tmp_path, monkeypatch, {"hotelName": entry})
    assert C.threshold("hotelName") == 0.85, why
    assert C.calibration_state().startswith("rejected: "), why


def test_the_clamp_is_measured_against_the_threshold_in_force_not_against_the_files_own_claim(tmp_path, monkeypatch):
    """The first implementation compared `reviewBelow` with the file's own `movedFrom`, which made the ±0.05 clamp
    self-declared and therefore vacuous: a file could put any value in force in one step while /health said "ok"
    (adversarial review, 2026-09-23). For `date` that threshold is the ONLY thing between a wrong date and a silent
    error, because a digit field's modelConfidence already IS its weakest token and the 0.50 token floor adds nothing."""
    calibration_file(tmp_path, monkeypatch, {
        "date": {"reviewBelow": 0.00, "movedFrom": 0.05, "acceptedBecause": "x"},
        "name": {"reviewBelow": 0.30, "movedFrom": 0.35, "acceptedBecause": "x"},
        "nationality": {"reviewBelow": 0.50, "movedFrom": 0.55, "acceptedBecause": "x"}})
    assert C.calibration_state().startswith("rejected: ")  # refused WHOLE: not one entry of it applies
    assert (C.threshold("date"), C.threshold("name"), C.threshold("nationality")) == (0.90, 0.85, 0.85)


def test_an_unknown_field_type_is_refused(tmp_path, monkeypatch):
    calibration_file(tmp_path, monkeypatch, {"roomNo": {"reviewBelow": 0.88, "movedFrom": 0.90, "acceptedBecause": "typo: the kind is 'room'"}})
    assert C.threshold("room") == 0.90 and C.calibration_state().startswith("rejected: ")


def test_a_missing_calibration_file_is_not_an_error(tmp_path, monkeypatch):
    monkeypatch.setenv("OCR_CALIBRATION_FILE", str(tmp_path / "absent.json"))
    assert C.calibration() == {} and C.calibration_state() == "default"
    assert C.threshold("nationality") == C.REVIEW_BELOW["nationality"]
