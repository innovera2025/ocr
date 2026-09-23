"""The review-threshold report (tools/thresholds.py), on synthetic pages. No customer data: every row here is invented.

Two things have to hold or the report is measuring itself instead of the product: the sweep must reproduce the flag the
service actually set at the threshold in force, and the refit columns must expose the overfit that an all-data argmin
hides (accuracy-learning-plan.md §10 item 6 -- the reason W6's moves are clamped to ±0.05 instead of fitted).
"""

import pytest

import ocr_confidence as C
import ocr_model
from conftest import FakeModel, png_of
from test_benchmark_scoring import label
from tools import thresholds
import synthetic_form as S

FLOOR = 0.5


def row(page, conf, right=True, rule=False, token_min=None):
    return {"page": page, "conf": conf, "tokenMin": conf if token_min is None else token_min,
            "rule": rule, "right": right, "stale": False, "uncertain": False}


def test_buckets_count_the_three_review_outcomes():
    rows = [row(1, 0.95), row(2, 0.70), row(3, 0.95, right=False), row(4, 0.40, right=False)]
    assert thresholds.buckets(rows, 0.85, FLOOR) == (1, 1, 1)  # right-but-flagged, wrong-but-flagged, wrong-and-UNFLAGGED
    assert thresholds.buckets(rows, 1.00, FLOOR) == (2, 2, 0)


def test_a_parser_flag_survives_every_threshold():
    """Lowering a model threshold may not pretend to clear a flag the parser set for its own reason."""
    rows = [row(1, None, rule=True), row(2, None, right=False, rule=True)]
    assert thresholds.buckets(rows, 0.0, FLOOR) == (1, 1, 0)


def test_the_token_floor_flags_a_value_whose_mean_is_high():
    rows = [row(1, 0.95, token_min=0.30)]
    assert thresholds.buckets(rows, 0.50, FLOOR) == (1, 0, 0)
    assert thresholds.buckets(rows, 0.50, 0.20) == (0, 0, 0)  # with a lower floor the same page is not flagged


def test_fit_puts_silent_errors_first_and_breaks_ties_upwards():
    rows = [row(1, 0.80), row(2, 0.74, right=False)]
    assert thresholds.fit(rows, FLOOR) == 0.80  # 0.70 makes page 2 silent; among the ties, the one that keeps the margin
    assert thresholds.buckets(rows, 0.80, FLOOR) == (0, 1, 0)


def test_leave_one_out_exposes_the_silent_error_the_all_data_argmin_hides():
    """The fitted threshold sits just above the one wrong page, so it looks free -- until that page is the held-out one
    and the fold has no reason to stay above it. This is the measurement W6's clamp is built on."""
    rows = [row(1, 0.749, right=False), row(2, 0.72), row(3, 0.76)]
    fitted = thresholds.fit(rows, FLOOR)
    assert fitted == 0.75 and thresholds.buckets(rows, fitted, FLOOR) == (1, 1, 0)  # in sample: no silent error
    assert thresholds.leave_one_out(rows, FLOOR)[2] == 1  # out of sample: one
    assert thresholds.buckets(rows, 0.85, FLOOR)[2] == 0  # a fixed, pre-specified threshold keeps its margin


def test_odd_even_fits_on_one_half_and_scores_the_other():
    rows = [row(1, 0.71), row(3, 0.73), row(2, 0.749, right=False), row(4, 0.80)]
    assert thresholds.odd_even(rows, FLOOR)[2] == 1  # the odd half has no wrong page, so its fit leaves page 2 silent


def test_the_sweep_reproduces_the_flag_the_service_set(client, monkeypatch):
    """At the threshold in force the report must agree with the service field for field, or every number it prints is
    about the report rather than about the product."""
    monkeypatch.setenv("OCR_SECTION_MODE", "staff-separate")
    monkeypatch.setattr(ocr_model, "call_ocr", FakeModel(logprob=-0.05, low={"3": -3.0, "Chun": -0.4}))
    body = client.post("/v1/ocr", files={"file": ("form.png", png_of(S.filled_form()), "image/png")}).json()
    assert body["evidence"]["tokenConfidence"], "the token gate must be exercised, not skipped"
    collected = thresholds.rows({1: label()}, {1: body})
    floor = C.threshold("token")
    for path, kind in thresholds.FIELDS:
        section, name = path.split(".")
        assert thresholds.flagged(collected[path][0], C.threshold(kind), floor) is body[section][name]["needsReview"], path


@pytest.mark.parametrize("path, kind", thresholds.FIELDS)
def test_every_swept_field_is_scored_and_has_a_threshold(path, kind):
    """A field the scorer does not score, or a kind with no threshold, would silently print an empty column."""
    import tools.scoring as scoring
    assert path in scoring.ORDER and kind in C.REVIEW_BELOW
