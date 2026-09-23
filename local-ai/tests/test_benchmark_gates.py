"""`benchmark.py`'s §4 gate verdicts, on synthetic counts. No customer data: every page number here is invented.

A gate that a change can walk past is worse than no gate, because the release is then justified by a green line that
measured nothing. Each test here pins one hole the adversarial review of 2026-09-23 found in `print_gates`.
"""

import pytest

from tools import benchmark, scoring


def totals_of(pages):
    """{field: {page: (right, flagged)}} -> a scoring.Totals with exactly those buckets."""
    totals = scoring.Totals()
    by_page = {}
    for field, rows in pages.items():
        for page, (right, flagged) in rows.items():
            by_page.setdefault(page, {})[field] = {"right": right, "flagged": flagged, "uncertain": 0, "markers": 0,
                                                  "want": 0, "hit": 0, "missed": 0, "extra": 0}
    for page in sorted(by_page):
        totals.add(page, by_page[page])
    return totals


def frozen(tmp_path, totals, name="baseline.txt"):
    path = tmp_path / name
    benchmark.freeze(totals, path, {"pages": 3})
    return path


def gates(tmp_path, base_totals, now_totals, **kw):
    fields, wrong, cross = benchmark.read_frozen(frozen(tmp_path, base_totals))
    return benchmark.print_gates(now_totals, fields, wrong, cross, True, **kw)


def test_a_silent_error_that_merely_moves_pages_fails_g1(tmp_path, capsys):
    """One field losing a silent error while GAINING a different one nets to zero, and G2's diff unions the two wrong
    buckets, so the page never appears there either. The frozen file stores the page list; the gate must use it."""
    base = totals_of({"customerInformation.name": {1: (False, False), 2: (True, False), 3: (True, False)}})
    now = totals_of({"customerInformation.name": {1: (True, False), 2: (False, False), 3: (True, False)}})
    assert gates(tmp_path, base, now) is False
    out = capsys.readouterr().out
    assert "G1   FAIL" in out and "[2]" in out


def test_a_page_sliding_from_flagged_to_silent_fails_g1(tmp_path, capsys):
    """wrongFlagged -> wrongUnflagged on the same page: the count of wrong pages does not move at all."""
    base = totals_of({"customerInformation.name": {1: (False, True), 2: (False, False)}})
    now = totals_of({"customerInformation.name": {1: (False, False), 2: (False, False)}})
    assert gates(tmp_path, base, now) is False
    assert "G1   FAIL" in capsys.readouterr().out


def test_fixing_a_silent_error_passes(tmp_path):
    base = totals_of({"customerInformation.name": {1: (False, False), 2: (True, False)}})
    now = totals_of({"customerInformation.name": {1: (True, False), 2: (True, False)}})
    assert gates(tmp_path, base, now) is True


def test_a_scored_field_with_no_baseline_row_fails_g1_unless_allowed(tmp_path, capsys):
    """A renamed or newly scored field would otherwise ship entirely ungated -- exactly the shape of W2f's planned
    group-level `possibleMissedMark` carrier."""
    base = totals_of({"customerInformation.name": {1: (True, False)}})
    now = totals_of({"customerInformation.name": {1: (True, False)},
                     "recommendationCard.bodyMap": {1: (False, True)}})
    assert gates(tmp_path, base, now) is False
    assert "not in the frozen baseline" in capsys.readouterr().out
    assert gates(tmp_path, base, now, allow_new_field=True) is True


def test_the_cross_field_total_is_gated_not_only_printed(tmp_path, capsys):
    """§4 G1's first clause is "total wrong-and-unflagged must not rise". Two fields can each stay at their own
    baseline while the total rises, if a NEW field carries the rise -- so the total needs its own line in the file."""
    base = totals_of({"customerInformation.name": {1: (False, False)}, "staffOnly.roomNo": {1: (True, False)}})
    now = totals_of({"customerInformation.name": {1: (False, False)}, "staffOnly.roomNo": {1: (False, False)}})
    assert gates(tmp_path, base, now) is False
    assert "cross-field TOTAL wrong-and-unflagged 1 -> 2" in capsys.readouterr().out


def test_the_cross_field_total_counts_the_body_map_once(tmp_path):
    """The per-list body-map rows and `staffOnly.totalMinutes` are superseded views: summing them would double count."""
    totals = totals_of({"recommendationCard.bodyMap": {1: (False, False)},
                        "recommendationCard.preferredAreas": {1: (False, False)},
                        "recommendationCard.avoidAreas": {1: (False, False)},
                        "staffOnly.totalMinutes": {1: (False, False)}})
    assert benchmark.cross_field_unflagged(totals) == 1


def test_a_route_stale_page_is_named_and_kept_out_of_the_g1_and_g2_verdicts(tmp_path, capsys):
    """A page whose model-CALL GRAPH today's parser would change is scored from an answer the shipped code would never
    receive (`replay.staleRoute`). Scoring it as a pass or a fail would both be wrong; it is excluded and named."""
    base = totals_of({"customerInformation.name": {1: (True, False), 2: (True, False)}})
    now = totals_of({"customerInformation.name": {1: (False, False), 2: (True, False)}})
    assert gates(tmp_path, base, now) is False                                   # without the note it is a G1 failure
    assert gates(tmp_path, base, now, stale_route={1: ["customerInformation"]}) is True
    out = capsys.readouterr().out
    assert "DIFFERENT model-call graph" in out and "[1]" in out


def test_the_frozen_files_gate_documentation_is_emitted_by_the_code_that_enforces_it(tmp_path):
    """The committed baseline once documented a superseded G3 rule while `print_gates` enforced another. The comment
    block is written by `freeze()`, so re-freezing is all it takes to keep the artefact and the code in step."""
    text = frozen(tmp_path, totals_of({"customerInformation.name": {1: (True, False)}})).read_text(encoding="utf-8")
    assert f"rightFlagged + wrongFlagged, the review budget) may rise by at most +{benchmark.REVIEW_BUDGET}" in text
    assert "rightFlagged may rise by at most" not in text  # the superseded wording


@pytest.mark.parametrize("bucket", ["wrongFlagged", "wrongUnflagged"])
def test_freeze_and_read_frozen_round_trip(tmp_path, bucket):
    totals = totals_of({"customerInformation.name": {1: (False, bucket == "wrongFlagged"), 2: (True, False)}})
    fields, wrong, cross = benchmark.read_frozen(frozen(tmp_path, totals))
    assert fields["customerInformation.name"]["n"] == 2 and fields["customerInformation.name"][bucket] == 1
    assert wrong[("customerInformation.name", bucket)] == {1}
    assert cross["wrongUnflagged"] == (1 if bucket == "wrongUnflagged" else 0)
