"""Page-ordered learning-loop replay (accuracy-learning-plan.md §1D, §2.1, §3 W3a, §4 G6).

`benchmark.py` on its own replays every page INDEPENDENTLY, so it can never see the one defect class §1D measures: the
v2.2 confirmation memory is *state*, and a confirmation made on page 12 changes what page 47 reads. This module replays
the same 95 stored answers **in page order** with the real `POST /v1/ocr/confirm` route live, a reviewer confirming each
page to its label before the next page is read -- which is the only way a stored-answer benchmark can score a feedback
loop. Still zero model calls: the confirmations are simulated, the readings are not.

Three runs are compared:

    stateless   `benchmark.py`'s ordinary run -- no confirmations at all
    v3.2        the PRE-W3a RULES: the app confirms a field the reviewer CHANGED *or* merely accepted while it was
                flagged (`document-view.ts:305,362`), and `ocr_normalize.verified_match` serves the result back at
                confidence 1.0 with `needsReview: false`
    w3a         after W3a: the app confirms only what the reviewer actually changed (weight 1; flagged-but-unedited is
                weight 0), and the confirm route is audit-only -- the record is written, nothing reads it back

The mode key "v3.2" names the RULES, not the binary: every run reads the pages through `replay.replay_page`, i.e.
through TODAY's parser, and only `VERIFIED_MEMORY_ENABLED` and the weight rule are reverted. Its accuracy columns are
therefore an honest measurement of the loop's harm (both sides share one parser), while its confirmation VOLUME is a
post-W1 count and must not be quoted as production's (adversarial review, 2026-09-23). `MODE_LABELS` prints it as
"pre-W3a rules" so the report cannot be read the other way.

W3a's claim is an INVARIANT, not a score: the `w3a` run must come out identical, page for page, to the stateless run,
because a confirmation may no longer change any later reading. `verdict()` is that check. The `v3.2` run is kept so the
harm that was removed stays measurable from this repository instead of from a one-off script.

Confirmations are simulated exactly as `packages/ocr-persistence/src/document-view.ts` builds them, because that is the
only thing that reaches the Local AI: `mergeField` for `staffOnly.therapistName` (key = the field's `raw`) and
`mergeArray` for `staffOnly.treatments` (key = `nameRaw`, falling back to `raw`), both requiring a non-empty key and a
non-empty saved value. Treatment items are paired with the label positionally and ONLY when the counts match --
`legacyTreatmentIndex` refuses an ambiguous target for the same reason, and a guessed pairing would invent
confirmations production never made. The pages where that happens are reported, never silently dropped.
"""

import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE.parent)]
sys.dont_write_bytecode = True

import api  # noqa: E402
import ocr_normalize as N  # noqa: E402

from tools import replay, scoring  # noqa: E402

MODES = ("stateless", "v3.2", "w3a")
# What each run IS, printed instead of the bare mode key. The "v3.2" run is NOT the v3.2 binary: every run replays the
# CURRENT parser and reverts only the weight rule and the memory switch, so its confirmation VOLUME is a post-W1 count,
# not production's (adversarial review, 2026-09-23). Its accuracy columns are still the honest measure of the loop's
# harm, because both sides of that comparison are the same parser.
MODE_LABELS = {"stateless": "stateless", "v3.2": "pre-W3a rules", "w3a": "W3a"}
# The only two fields the confirm route accepts (`api.confirm_ocr`), and so the only ones this loop can move.
LOOP_FIELDS = ("staffOnly.therapistName", "staffOnly.treatmentNames", "staffOnly.treatmentsWithDuration")


def confirmations(sections, label, rule):
    """What the app would POST to `/v1/ocr/confirm` after a reviewer saved this page to its label.

    `rule` is "v3.2" (edited OR flagged-but-accepted -- the pre-W3a condition) or "w3a" (edited only). Returns
    ([(field, raw, verifiedValue, edited)], ambiguous) where `ambiguous` is True when the treatment item count does not
    match the label's, so no treatment confirmation can be attributed to an item.
    """
    if rule not in ("v3.2", "w3a"):
        raise ValueError(f"unknown weight rule: {rule}")
    out = []

    def weigh(field, key, want, edited, flagged):
        if not key or not want:  # document-view.ts: nonEmpty(oldRaw) && nonEmpty(newValue)
            return
        if edited or (rule == "v3.2" and flagged):
            out.append((field, key, want, edited))

    therapist = sections["staffOnly"]["therapistName"]
    want = label["staff"].get("therapist")
    weigh("therapist", therapist.get("raw"), want, (therapist.get("value") or None) != (want or None),
          therapist.get("needsReview") is True)

    items = sections["staffOnly"]["treatments"]
    wants = [t["name"] for t in label["staff"]["treatments"]]
    ambiguous = len(items) != len(wants)
    if not ambiguous:
        for item, name in zip(items, wants, strict=True):
            weigh("treatment", item.get("nameRaw") or item.get("raw"), name,
                  (item.get("value") or None) != (name or None), item.get("needsReview") is True)
    return out, ambiguous


def _memory_sources(sections):
    """How many fields on this page were served BY the confirmation memory rather than read."""
    hits = 1 if sections["staffOnly"]["therapistName"].get("source") == "verified-memory" else 0
    return hits + sum(1 for item in sections["staffOnly"]["treatments"] if item.get("source") == "verified-memory")


def run(labels, pages, mode):
    """One page-ordered run -> (Totals, stats). `mode` is one of MODES.

    The confirm route is called for real (`api.confirm_ocr`), against a throwaway `corrections.jsonl`, so the audit-only
    switch this measures is the one production runs. `OCR_VERIFIED_FILE` and `VERIFIED_MEMORY_ENABLED` are always
    restored, including on failure.
    """
    if mode not in MODES:
        raise ValueError(f"unknown mode: {mode}")
    totals, stats = scoring.Totals(), {"confirmations": 0, "weight0": 0, "memoryHits": 0, "ambiguousPages": [],
                                       "byField": {"therapist": [0, 0], "treatment": [0, 0]},  # [posted, of which weight 0]
                                       "weight0Keys": set()}
    if mode == "stateless":
        for page in sorted(pages):
            totals.add(page, scoring.score_page(replay.replay_page(pages[page])[0], labels[page]))
        return totals, stats

    before_env, before_flag = os.environ.get("OCR_VERIFIED_FILE"), N.VERIFIED_MEMORY_ENABLED
    with tempfile.TemporaryDirectory() as tmp:
        os.environ["OCR_VERIFIED_FILE"] = str(Path(tmp) / "corrections.jsonl")
        N.VERIFIED_MEMORY_ENABLED = mode == "v3.2"  # W3a is the audit-only route: written, never read back
        try:
            for page in sorted(pages):
                sections, _ = replay.replay_page(pages[page])
                stats["memoryHits"] += _memory_sources(sections)
                totals.add(page, scoring.score_page(sections, labels[page]))
                sent, ambiguous = confirmations(sections, labels[page], "v3.2" if mode == "v3.2" else "w3a")
                if ambiguous:
                    stats["ambiguousPages"].append(page)
                for field, raw, verified_value, edited in sent:
                    stats["confirmations"] += 1
                    stats["weight0"] += not edited
                    stats["byField"][field][0] += 1
                    stats["byField"][field][1] += not edited
                    if not edited:  # §1D counts distinct junk ROWS; a POST count is larger because a key repeats
                        stats["weight0Keys"].add((field, raw))
                    api.confirm_ocr(api.ConfirmRequest(documentId=f"p{page:03d}", field=field, raw=raw, verifiedValue=verified_value))
        finally:
            N.VERIFIED_MEMORY_ENABLED = before_flag
            os.environ.pop("OCR_VERIFIED_FILE", None)
            if before_env is not None:
                os.environ["OCR_VERIFIED_FILE"] = before_env
    return totals, stats


def _row(totals, field):
    row = totals.field(field) or {}
    return {k: row.get(k, 0) for k in ("right", "rightFlagged", "wrongFlagged", "wrongUnflagged")} | \
           {"wrongPages": sorted(set(row.get("pages", {}).get("wrongFlagged", [])) | set(row.get("pages", {}).get("wrongUnflagged", [])))}


def verdict(runs):
    """[(field, attribute, w3a, stateless)] where the W3a loop differs from the stateless replay. Empty = the invariant
    holds: a confirmation changed no later reading. Every field is compared, not only the two the route accepts."""
    out = []
    fields = {f for mode in ("stateless", "w3a") for f, _ in runs[mode][0].ordered()}
    for field in sorted(fields):
        got, want = _row(runs["w3a"][0], field), _row(runs["stateless"][0], field)
        for attr in ("right", "rightFlagged", "wrongFlagged", "wrongUnflagged", "wrongPages"):
            if got[attr] != want[attr]:
                out.append((field, attr, got[attr], want[attr]))
    return out


def print_report(runs):
    """-> True when the W3a invariant holds. Counts, page numbers and field names only."""
    print("\n== learning loop: what a confirmation does to the NEXT page (§1D, §2.1, §3 W3a) ==")
    print("  page-ordered replay of the same stored answers, a reviewer confirming every page to its label before the")
    print("  next is read; 0 model calls. 'pre-W3a rules' = the app's pre-W3a weight rule + the raw->value memory")
    print("  applied; 'W3a' = only an EDITED field confirms, and the confirm route is audit-only.")
    print("  ALL THREE RUNS USE TODAY'S PARSER: only the weight rule and the memory switch are reverted, so the")
    print("  confirmation counts below are post-W1 counts, not the volume the v3.2 binary produced in production.")
    print(f"\n{'field':38} {'run':14} {'right':>6} {'R&flag':>7} {'W&flag':>7} {'W&UNFLAGGED':>12}")
    for field in LOOP_FIELDS:
        for mode in MODES:
            row = _row(runs[mode][0], field)
            print(f"{field if mode == MODES[0] else '':38} {MODE_LABELS[mode]:14} {row['right']:6} {row['rightFlagged']:7} "
                  f"{row['wrongFlagged']:7} {row['wrongUnflagged']:12}")
    for mode in ("v3.2", "w3a"):
        stats = runs[mode][1]
        by_field = "  ".join(f"{name} {posted} ({weight0} weight-0)" for name, (posted, weight0) in stats["byField"].items())
        print(f"\n  {MODE_LABELS[mode]:13} confirmations posted {stats['confirmations']:3}, of which weight-0 (flagged but NOT edited, "
              f"§2.5.2) {stats['weight0']:3}; memory served {stats['memoryHits']:3} field(s)")
        print(f"        by field: {by_field}   distinct weight-0 keys (the junk ROWS of §1D): {len(stats['weight0Keys'])}")
        if stats["ambiguousPages"]:
            print(f"        treatment pairing ambiguous (item count != label count), so no treatment confirmation was "
                  f"attributed on {len(stats['ambiguousPages'])} page(s): {stats['ambiguousPages']}")
    removed = [(f, _row(runs["v3.2"][0], f)["wrongUnflagged"], _row(runs["w3a"][0], f)["wrongUnflagged"]) for f in LOOP_FIELDS]
    print("\n  silent errors the loop CAUSED, and W3a removes: "
          + " | ".join(f"{f.split('.')[1]} {a} -> {b}" for f, a, b in removed))
    bad = verdict(runs)
    print("\n  W3a invariant: a recorded confirmation may change no later reading and clear no flag")
    if bad:
        for field, attr, got, want in bad:
            print(f"       FAIL {field:36} {attr:12} w3a {got}  vs stateless {want}")
    else:
        print("       PASS  the W3a run is identical to the stateless replay on every field, page for page")
    return not bad
