"""Review-threshold evidence (accuracy-learning-plan.md §3 W6, §4 G6, §8.6): what a threshold costs and what it catches.

    python tools/benchmark.py --data <operator data dir> --thresholds

Same replayed pages, same scorer and the same zero model calls as the benchmark itself -- this module only asks a
different question of them. Per model-read scalar field:

  * the sweep: how right-but-flagged / wrong-but-flagged / wrong-and-UNFLAGGED move as the threshold moves;
  * the margin: how far the threshold in force sits above the most confident WRONG page, i.e. how much room a re-render
    or a model update has before that page becomes a silent error;
  * the refit columns: what an all-data argmin would choose, and what that *procedure* scores leave-one-out and
    odd/even. A fixed, pre-specified threshold has nothing to leave out (dropping a page cannot move it); the LOO and
    odd/even numbers below score the REFIT PROCEDURE, which is the thing that overfits -- plan §10, item 6.

Counts, page numbers and confidences only: no customer value is read or printed here.
"""

import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE.parent)]
sys.dont_write_bytecode = True

import ocr_confidence as C  # noqa: E402

from tools import replay, scoring  # noqa: E402

# Scored field path -> confidence kind. `header.time` has no label column and so no right/wrong, and the treatment
# threshold applies per item inside a page-level list score; neither can be swept honestly here.
FIELDS = (("header.formNumber", "formNumber"), ("header.date", "date"), ("customerInformation.name", "name"),
          ("customerInformation.nationality", "nationality"), ("customerInformation.hotelName", "hotelName"),
          ("staffOnly.roomNo", "room"), ("staffOnly.therapistName", "therapist"))
GRID = (1.00, 0.95, 0.90, 0.85, 0.80, 0.75, 0.70, 0.65, 0.60, 0.55, 0.50, 0.00)


def rows(labels, pages):
    """{field path: [{page, conf, tokenMin, rule, right, stale, uncertain}]} -- one row per page and field.

    `conf` is the modelConfidence the gate compares against the threshold (the weakest token for the digit fields, the
    mean otherwise), None when the page carries no statistics for that field. `rule` is True when the field is flagged
    for a reason the threshold cannot clear (a parser rule): the sweep must never pretend to unflag those. It is read
    from `notes["ruleFlag"]`, which `replay_page` records BEFORE the gate runs -- inferring it as "needsReview and not
    gated at the threshold in force" mislabelled every field flagged by BOTH a rule and the gate as rule-free, and so
    modelled those pages as un-flaggable below the threshold in force (adversarial review, 2026-09-23).
    """
    out = {path: [] for path, _ in FIELDS}
    for page in sorted(pages):
        sections, notes = replay.replay_page(pages[page])
        scored = scoring.score_page(sections, labels[page])
        stored = pages[page]["evidence"].get("tokenConfidence") or {}
        for path, kind in FIELDS:
            stats = stored.get(path)
            conf = None if stats is None else (stats["min"] if kind in C.DIGIT_KINDS else stats["mean"])
            token_min = None if stats is None else stats["min"]
            out[path].append({"page": page, "conf": conf, "tokenMin": token_min,
                              "rule": bool(notes["ruleFlag"].get(path)),
                              "right": scored[path]["right"], "stale": path in notes["staleGate"],
                              "uncertain": scored[path]["uncertain"]})
    return out


def flagged(row, threshold, floor):
    """Would this page be flagged at `threshold`? The parser's own flags and the token floor are part of the answer."""
    return bool(row["rule"] or (row["conf"] is not None and (row["conf"] < threshold or row["tokenMin"] < floor)))


def buckets(field_rows, threshold, floor):
    """(right-but-flagged, wrong-but-flagged, wrong-and-unflagged) at `threshold`."""
    right_flagged = sum(1 for r in field_rows if r["right"] and flagged(r, threshold, floor))
    wrong = [r for r in field_rows if not r["right"]]
    wrong_flagged = sum(1 for r in wrong if flagged(r, threshold, floor))
    return right_flagged, wrong_flagged, len(wrong) - wrong_flagged


def fit(field_rows, floor):
    """The threshold this page set would choose: fewest silent errors first, then fewest right-but-flagged, and the
    HIGHEST of the ties (a tie broken downwards would buy no page and spend margin)."""
    def cost(threshold):
        right_flagged, _, unflagged = buckets(field_rows, threshold, floor)
        return unflagged, right_flagged, -threshold

    return min(GRID, key=cost)


def leave_one_out(field_rows, floor):
    """The refit PROCEDURE scored out of sample: fit on every page but one, classify the one, sum the held-out pages."""
    totals = [0, 0, 0]
    for index, row in enumerate(field_rows):
        threshold = fit(field_rows[:index] + field_rows[index + 1:], floor)
        for slot, value in enumerate(buckets([row], threshold, floor)):
            totals[slot] += value
    return tuple(totals)


def odd_even(field_rows, floor):
    """The same procedure over one 2-fold split: fit on the odd pages, score the even ones, and the other way round."""
    halves = ([r for r in field_rows if r["page"] % 2], [r for r in field_rows if not r["page"] % 2])
    scores = [buckets(other, fit(half, floor), floor) for half, other in (halves, halves[::-1])]
    return tuple(a + b for a, b in zip(*scores))


def source_of(kind):
    """Where the threshold in force comes from, so the report cannot quietly measure a number the service does not use."""
    env_name = C.ENV_PREFIX + re.sub(r"(?<=[a-z])(?=[A-Z])", "_", kind).upper()
    if env_name in os.environ:
        return env_name
    try:
        return "calibration.json" if kind in C.calibration() else "REVIEW_BELOW"
    except Exception as error:
        return f"REVIEW_BELOW (calibration.json rejected: {error})"


def print_report(labels, pages):
    """The whole report. Read-only: it never changes a threshold, and it is not a gate."""
    floor = C.threshold("token")
    print("\n== review thresholds: what each one costs and what it catches (plan §3 W6, §8.6) ==")
    print(f"token floor in force: {floor} ({source_of('token')}) -- a value whose weakest token is below it is flagged "
          "whatever the field threshold says. For the digit fields (room, formNumber, date, time) modelConfidence IS that\n"
          "weakest token, so there the field threshold is the only guard: nothing else stands between a wrong value and a "
          "silent error.")
    collected = rows(labels, pages)
    for path, kind in FIELDS:
        field_rows = collected[path]
        in_force = C.threshold(kind)
        stale = [r["page"] for r in field_rows if r["stale"]]
        wrong = sorted((r for r in field_rows if not r["right"]), key=lambda r: (r["conf"] is None, -(r["conf"] or 0)))
        no_stats = [r for r in field_rows if r["conf"] is None]
        print(f"\n{path}   kind={kind}   in force {in_force} ({source_of(kind)}; REVIEW_BELOW {C.REVIEW_BELOW[kind]})")
        print(f"  pages {len(field_rows)}: {len(field_rows) - len(no_stats)} with token statistics, {len(no_stats)} without "
              f"(not read, or the value was not found in the answer), {sum(r['rule'] for r in field_rows)} flagged by a parser "
              f"rule the threshold cannot clear,\n  {sum(r['uncertain'] for r in field_rows)} with an uncertain label, "
              f"{len(stale)} whose stored statistics no longer describe the replayed value{' ' + str(stale) if stale else ''}"
              " -- on those the flag is not evidence-backed.")
        print("  threshold :  R&flagged  W&flagged  W&UNFLAGGED   (the parser flags and the token floor are included)")
        for t in GRID:
            right_flagged, wrong_flagged, unflagged = buckets(field_rows, t, floor)
            mark = " <- in force" if abs(t - in_force) < 1e-9 else (" <- REVIEW_BELOW" if abs(t - C.REVIEW_BELOW[kind]) < 1e-9 else "")
            print(f"     {t:5.2f}  : {right_flagged:9} {wrong_flagged:10} {unflagged:12}{mark}")
        with_conf = [r for r in wrong if r["conf"] is not None]
        if with_conf:
            worst = with_conf[0]
            silent_below = [t for t in GRID if buckets(field_rows, t, floor)[2] > buckets(field_rows, 1.0, floor)[2]]
            print(f"  margin: the most confident WRONG page is p{worst['page']} at modelConfidence {worst['conf']:.3f}; the "
                  f"threshold in force sits {in_force - worst['conf']:+.3f} from it.")
            print(f"  a wrong page first goes silent at threshold {max(silent_below):.2f} or below." if silent_below
                  else "  no threshold on the grid makes a wrong page silent: every wrong page is held by the token floor or a rule.")
        else:
            print("  margin: no wrong page carries token statistics, so this threshold catches none of this field's errors.")
        fitted = fit(field_rows, floor)
        print(f"  in force {in_force:.2f}: R&F {buckets(field_rows, in_force, floor)[0]}  W&F {buckets(field_rows, in_force, floor)[1]}"
              f"  W&U {buckets(field_rows, in_force, floor)[2]}   <- pre-specified, so these 95 pages EVALUATE it")
        print(f"  all-data argmin {fitted:.2f}: R&F {buckets(field_rows, fitted, floor)[0]}  W&F {buckets(field_rows, fitted, floor)[1]}"
              f"  W&U {buckets(field_rows, fitted, floor)[2]}   <- fitted on the same pages it is scored on; NOT shippable "
              f"beyond ±{C.CALIBRATION_MAX_MOVE} (§8.6)")
        print("  the same refit procedure scored out of sample:  leave-one-out R&F {} W&F {} W&U {}   |   odd/even R&F {} W&F {} W&U {}"
              .format(*leave_one_out(field_rows, floor), *odd_even(field_rows, floor)))
    print("\n  A fixed threshold has nothing to leave out -- dropping a page cannot move it, so its LOO is its own count.")
    print("  The two columns above therefore score the REFIT PROCEDURE, which is what overfits (plan §10 item 6): compare")
    print("  them with the 'in force' line, not with the argmin. §8.6 admits a move only on >= 200 confirmed documents,")
    print("  >= 50 wrong, a held-out improvement, at most ±0.05 per release, with the evidence in calibration.json.")
