"""The §1E scorer fixes, on synthetic pages. No customer data: every value here is invented.

Each test pins one metric artefact the old ad-hoc scorers had, so a later change to `tools/scoring.py` cannot silently
undo it and make an accuracy claim look better than it is.
"""

import pytest

from tools import scoring


def page(**over):
    """A synthetic v3 response body: everything right, nothing flagged, unless a test overrides it."""
    def f(value, review=False, raw=None):
        return {"raw": raw if raw is not None else value, "value": value, "source": "ocr", "confidence": 0.9, "needsReview": review}

    body = {
        "header": {"formNumber": f("01234"), "date": f("2026-08-16"), "time": f(None)},
        "customerInformation": {"name": f("Anna Example"), "nationality": f("Thai"), "hotelName": f("Blue Hotel"),
                                "gender": f("female"), "referralSources": [f("google")], "healthConditions": []},
        "recommendationCard": {"pressure": f("standard"), "massageOilScrub": [f("rose")],
                               "preferredAreas": [f("shoulders")], "avoidAreas": []},
        "staffOnly": {"treatments": [{**f("thai"), "durationMinutes": 90}], "therapistName": f("Nok"),
                      "roomNo": f("3"), "totalMinutes": 90},
    }
    for path, value in over.items():
        section, key = path.split("__")
        body[section][key] = value
    return body


def label(**over):
    body = {"page": 1, "formNo": "01234", "date": "16/08/26", "uncertainFields": [],
            "customer": {"name": "Anna Example", "nationality": "Thai", "hotelName": "Blue Hotel", "gender": "female",
                         "referralSources": ["google"], "healthConditions": []},
            "recommendation": {"pressure": "standard", "massageOilScrub": ["rose"], "preferredAreas": ["shoulders"], "avoidAreas": []},
            "staff": {"treatments": [{"name": "thai", "durationMinutes": 90}], "totalAsWritten": "90", "therapist": "Nok", "room": "3"}}
    for path, value in over.items():
        if "__" in path:
            section, key = path.split("__")
            body[section][key] = value
        else:
            body[path] = value
    return body


MARKER = {"raw": "struck out: rose, jasmine, lavender", "value": None, "source": "checkbox", "confidence": 0.35,
          "needsReview": True, "checked": True}


def test_baseline_page_is_right_everywhere():
    scored = scoring.score_page(page(), label())
    assert all(s["right"] for s in scored.values()), [f for f, s in scored.items() if not s["right"]]
    assert not any(s["flagged"] for s in scored.values())


def test_struck_out_marker_is_review_cost_not_a_selected_item():
    """§1E fix 1: `compare.py:12` scored `value or raw`, so this marker counted as an item and made the page wrong."""
    scored = scoring.score_page(page(recommendationCard__massageOilScrub=[MARKER]),
                                label(recommendation__massageOilScrub=[]))
    oil = scored["recommendationCard.massageOilScrub"]
    assert oil["right"] and oil["flagged"] and oil["markers"] == 1


def test_a_marker_beside_a_real_selection_still_only_flags():
    entries = [page()["recommendationCard"]["massageOilScrub"][0], MARKER]
    oil = scoring.score_page(page(recommendationCard__massageOilScrub=entries), label())["recommendationCard.massageOilScrub"]
    assert oil["right"] and oil["flagged"] and oil["markers"] == 1


def test_nationality_is_scored_through_the_readers_own_master_list():
    """§1E fix 2: an equivalent spelling must not count as an error, and the scorer may not be more lenient than the reader."""
    reading = page()["customerInformation"]["nationality"] | {"value": "Thailand"}
    assert scoring.nationality_key("Thailand") == scoring.nationality_key("Thai")
    assert scoring.score_page(page(customerInformation__nationality=reading), label())["customerInformation.nationality"]["right"]


def test_nationality_key_is_symmetric():
    """The old `natkey` used a different branch for the read value than for the label, so two identical strings could
    score wrong. Whatever the key does, it must do the same thing to both sides."""
    for text in ("Thai", "Thailand", "Norwegian", "Wakandan", "CHN", ""):
        assert scoring.nationality_key(text) == scoring.nationality_key(text)


def test_body_map_is_scored_as_one_unit_and_per_list():
    """§1E fix 3: a circle read as a cross moves the item between the lists -- wrong-and-UNFLAGGED on `preferredAreas`
    while the flag sits in `avoidAreas`. As one unit it is one wrong, flagged page."""
    moved = page(recommendationCard__preferredAreas=[],
                 recommendationCard__avoidAreas=[{"raw": "shoulders", "value": "shoulders", "source": "ink-mark",
                                                  "confidence": 0.6, "needsReview": True, "checked": True}])
    scored = scoring.score_page(moved, label())
    assert not scored["recommendationCard.preferredAreas"]["right"]
    assert not scored["recommendationCard.preferredAreas"]["flagged"], "the flag went to the other list: a SILENT error"
    assert not scored["recommendationCard.bodyMap"]["right"]
    assert scored["recommendationCard.bodyMap"]["flagged"], "as one unit the page is flagged, which is the truth"


def test_a_missed_item_is_counted_at_item_level_because_no_flag_can_carry_it():
    """§4 G1b: a miss has no entry, so nothing can flag it; only item recall sees it."""
    scored = scoring.score_page(page(recommendationCard__preferredAreas=[]),
                                label(recommendation__preferredAreas=["shoulders", "lower back"]))
    pref = scored["recommendationCard.preferredAreas"]
    assert pref["want"] == 2 and pref["hit"] == 0 and pref["missed"] == 2 and pref["extra"] == 0
    assert not pref["right"] and not pref["flagged"]


def test_uncertain_labels_are_marked_not_dropped():
    scored = scoring.score_page(page(), label(uncertainFields=["staff.therapist", "staff.treatments[0].durationMinutes"]))
    assert scored["staffOnly.therapistName"]["uncertain"]
    assert scored["staffOnly.treatmentNames"]["uncertain"]
    assert not scored["customerInformation.name"]["uncertain"]


@pytest.mark.parametrize("written, minutes", [("90", 90), ("2 ชม.", 120), ("1.5 ชม.", 90), ("2", 120), (None, None), ("??", "unparsed")])
def test_written_total_parses_the_labels_own_shorthand(written, minutes):
    assert scoring.written_total(written) == minutes


def test_written_total_has_no_flag_carrier_so_its_errors_are_silent():
    scored = scoring.score_page(page(), label(staff__totalAsWritten="120"))
    assert not scored["staffOnly.totalMinutes"]["right"] and not scored["staffOnly.totalMinutes"]["flagged"]


def test_totals_split_right_from_right_but_flagged():
    totals = scoring.Totals()
    totals.add(1, scoring.score_page(page(), label()))
    flagged = page()
    flagged["customerInformation"]["name"] = flagged["customerInformation"]["name"] | {"needsReview": True}
    totals.add(2, scoring.score_page(flagged, label()))
    row = totals.field("customerInformation.name")
    assert (row["n"], row["right"], row["rightFlagged"], row["wrongFlagged"], row["wrongUnflagged"]) == (2, 2, 1, 0, 0)
