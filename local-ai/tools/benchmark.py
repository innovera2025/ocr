"""The repo's reproducible reading-accuracy benchmark (accuracy-learning-plan.md §4): replay, score, gate.

    python tools/benchmark.py --data <operator data dir>                    # report + gates against the frozen baseline
    python tools/benchmark.py --data <dir> --results results-v32            # any other stored run
    python tools/benchmark.py --data <dir> --freeze tools/baseline-....txt  # re-freeze after a scorer change
    python tools/benchmark.py --data <dir> --learning-loop                  # + the page-ordered confirmation replay (W3a)
    python tools/benchmark.py --data <dir> --thresholds                     # + the review-threshold evidence (W6)

No customer data lives in this repository. `--data` points at the operator's own directory, which must contain
`labels.json` and a results directory of stored v3 responses (`pNNN.json`). Nothing but counts, page numbers, field names
and error categories is ever printed, so the output of this tool is safe to paste into a report or a commit.

Every number here is produced with ZERO model calls: `tools/replay.py` rebuilds the text fields from the answers the model
already gave, and the image-derived fields are production's own (the archived 1610 px renders are not available offline, so
no checkbox or body-map CHANGE can be scored here yet -- plan §4 G0 -- but production's stored answers for them are scored,
which is what makes the body-map baseline a production number rather than a simulated one).
"""

import argparse
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE.parent)]
sys.dont_write_bytecode = True

from tools import learning_loop, replay, scoring, thresholds  # noqa: E402

DEFAULT_BASELINE = HERE / "baseline-v3.2-prod-95.txt"
COLUMNS = ("n", "right", "rightFlagged", "wrongFlagged", "wrongUnflagged", "markers", "uncertain", "want", "hit", "missed", "extra")
REVIEW_BUDGET = 5  # §4 G3: flagged pages (right+wrong) may rise by at most this per field unless wrong-and-unflagged falls
# The table has three overlapping views on purpose, so one sum of it would double count: the two body-map lists are
# superseded by the merged `recommendationCard.bodyMap` row (§1E), and `staffOnly.totalMinutes` is scored on its own
# 31 pages with no flag carrier at all. The cross-field total that §4 G1's first clause names excludes these three.
SUPERSEDED = ("recommendationCard.preferredAreas", "recommendationCard.avoidAreas", "staffOnly.totalMinutes")


def cross_field_unflagged(totals, exclude=()):
    """§4 G1's first clause: total wrong-and-unflagged, body map as ONE unit, every other field counted once.
    `exclude` drops the named pages (the route-stale ones), and the caller drops them from the baseline too."""
    return sum(len(set(row["pages"]["wrongUnflagged"]) - set(exclude))
               for field, row in totals.ordered() if field not in SUPERSEDED)


def load(data_dir, results):
    labels = {p["page"]: p for p in json.loads((data_dir / "labels.json").read_text(encoding="utf-8"))}
    pages = {}
    for path in sorted((data_dir / results).glob("p*.json")):
        pages[int(path.stem[1:4])] = json.loads(path.read_text(encoding="utf-8"))
    missing = sorted(set(pages) - set(labels))
    if missing:
        sys.exit(f"{len(missing)} stored page(s) have no label: {missing}")
    return labels, pages


def run(labels, pages):
    """-> (Totals, fidelity mismatches {page: [(path, attr)]}, notes {page: replay notes})."""
    totals, mismatches, notes = scoring.Totals(), {}, {}
    for page in sorted(pages):
        sections, note = replay.replay_page(pages[page])
        bad = replay.fidelity(pages[page], sections)
        if bad:
            mismatches[page] = bad
        notes[page] = note
        totals.add(page, scoring.score_page(sections, labels[page]))
    return totals, mismatches, notes


# ------------------------------------------------------------------ frozen baseline file

def freeze(totals, path, meta):
    lines = ["# INNOVERA OCR reading-accuracy benchmark - frozen baseline (counts, page numbers and field names only).",
             "# Produced by local-ai/tools/benchmark.py. Every number is scored on stored production responses with 0 model calls.",
             *(f"# {k}: {v}" for k, v in meta.items()),
             "[fields] " + " ".join(("field", *COLUMNS))]
    for field, row in totals.ordered():
        lines.append(field + " " + " ".join(str(row[c]) for c in COLUMNS))
    lines.append("[pages] field bucket comma-separated page numbers (the wrong pages; every other page was right)")
    for field, row in totals.ordered():
        for bucket in ("wrongFlagged", "wrongUnflagged"):
            lines.append(f"{field} {bucket} " + (",".join(str(p) for p in row["pages"][bucket]) or "-"))
    lines.append("[totals] name value")
    lines.append(f"wrongUnflagged {cross_field_unflagged(totals)}")
    lines += ["", "# Gate thresholds this file freezes (plan §4). `benchmark.py --baseline <this file>` checks G1, G1b, G2, G3, G6.",
              "# This block is EMITTED BY freeze(), so it cannot drift from the code that enforces it.",
              "#   G1  no field's wrongUnflagged may exceed the number above, no page may be NEWLY in a field's",
              "#       wrongUnflagged page list, the cross-field [totals] wrongUnflagged may not rise, and every scored",
              "#       field must have a baseline row (--allow-new-field to score one that does not).",
              "#   G1b no list field's `hit` may fall or `missed` may rise: a missed item has no entry and so no flag, and",
              "#       v3.2 has no possibleMissedMark carrier (plan W2f), so every miss is silent by construction.",
              "#   G2  every page that flips right<->wrong must be named and explained; the page lists above are what it diffs.",
              f"#   G3  flagged pages (rightFlagged + wrongFlagged, the review budget) may rise by at most +{REVIEW_BUDGET} per",
              "#       field unless that field's wrongUnflagged falls.",
              "#   G6  the replay and the scorer must be deterministic across two runs of the same inputs.",
              "#   G0, G4, G5, G7 are NOT computable from stored answers: they need the archived 1610 px production renders",
              "#       (G0/G5/G7) or the full deterministic image pipeline (G4, tests/bench_deterministic.py)."]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def read_frozen(path):
    """-> (per-field rows, {(field, bucket): page set}, cross-field totals). `totals` is {} in a file frozen before the
    [totals] block existed; the caller then says the cross-field gate has nothing to compare against."""
    fields, wrong, totals = {}, {}, {}
    section = None
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("#") or not line.strip():
            continue
        if line.startswith("["):
            section, line = line.split("]", 1)[0][1:], line.split("]", 1)[1].strip()
            continue
        parts = line.split()
        if section == "fields":
            fields[parts[0]] = dict(zip(COLUMNS, (int(v) for v in parts[1:])))
        elif section == "pages":
            wrong[(parts[0], parts[1])] = set() if parts[2] == "-" else {int(p) for p in parts[2].split(",")}
        elif section == "totals":
            totals[parts[0]] = int(parts[1])
    return fields, wrong, totals


# ------------------------------------------------------------------ report

def print_report(totals, mismatches, notes, pages):
    print(f"pages scored: {len(pages)}   engine: {pages[min(pages)]['engine']} v{pages[min(pages)]['version']}   "
          f"replay mode: {notes[min(pages)]['mode']}")
    stale = sorted({key for n in notes.values() for key in n["staleGate"]})
    print("replayed by today's code: header, customer text, treatments, therapist, room   |   "
          "copied from the stored response (image-derived, needs the 1610 px renders): gender, referralSources, "
          "healthConditions, pressure, massageOilScrub, preferredAreas, avoidAreas")
    if stale:
        print(f"WARNING: {len(stale)} confidence key(s) changed their raw value, so the stored token statistics no longer "
              f"describe them; their flags are NOT evidence-backed: {stale[:8]}{' ...' if len(stale) > 8 else ''}")
    routed = {p: n["staleRoute"] for p, n in notes.items() if n["staleRoute"]}
    if routed:
        by_section = {}
        for page, sections in sorted(routed.items()):
            for section in sections:
                by_section.setdefault(section, []).append(page)
        print(f"WARNING: on {len(routed)} page(s) today's parser would change the MODEL-CALL GRAPH (api.py:493-496 "
              f"decides its two re-reads from parsers this change touches), so the stored answer is one the shipped code "
              f"would not receive: " + "; ".join(f"{s} {p}" for s, p in sorted(by_section.items())))

    print("\n== replay fidelity (does today's code reproduce the stored production answers?) ==")
    scored = [b for bad in mismatches.values() for b in bad if b[1] in ("value", "raw", "needsReview", "count", "durationMinutes")]
    scored_pages = {p for p, bad in mismatches.items() if any(b[1] in ("value", "raw", "needsReview", "count", "durationMinutes") for b in bad)}
    print(f"pages reproduced field for field on the SCORED attributes (value, raw, needsReview): "
          f"{len(pages) - len(scored_pages)}/{len(pages)}   [{len(scored)} attribute mismatch(es)]")
    print(f"pages identical on every attribute (adding source and confidence): {len(pages) - len(mismatches)}/{len(pages)}")
    by_kind = {}
    for page, bad in mismatches.items():
        for path, attr, got, want in bad:
            by_kind.setdefault((f"{path}.{attr}", f"{got} <- was {want}" if attr == "source" else ""), []).append(page)
    for (kind, detail), ps in sorted(by_kind.items()):
        print(f"  {kind:46} {detail:34} {len(ps):3} page(s): {ps}")
    if not mismatches:
        print("  no mismatch: the replay is exact, so every number below is production's own.")

    print("\n== per-field accuracy (page level) ==")
    print(f"{'field':38} {'n':>4} {'right':>6} {'R&flag':>7} {'W&flag':>7} {'W&UNFLAGGED':>12} {'marker':>7} {'uncrt':>6}")
    for field, row in totals.ordered():
        print(f"{field:38} {row['n']:4} {row['right']:6} {row['rightFlagged']:7} {row['wrongFlagged']:7} "
              f"{row['wrongUnflagged']:12} {row['markers']:7} {row['uncertain']:6}")
    print(f"\nTOTAL wrong-and-unflagged (SILENT errors), body map as one unit (§1E), every other field once: "
          f"{cross_field_unflagged(totals)}")
    per_list = {f: (totals.field(f) or {}).get("wrongUnflagged") for f in SUPERSEDED[:2]}
    print("  the same body map per list (the merge is what would hide a per-list regression, §4 G1): "
          f"preferred {per_list['recommendationCard.preferredAreas']}, avoid {per_list['recommendationCard.avoidAreas']}")
    no_carrier = totals.field("staffOnly.totalMinutes")
    if no_carrier:
        print(f"  NO FLAG CARRIER: staffOnly.totalMinutes is a bare integer with no needsReview, so all "
              f"{no_carrier['wrongUnflagged']} of its {no_carrier['n']} errors are silent by construction and cannot be gated.")

    print("\n== item level: what a page-level list score cannot see (§4 G1b) ==")
    print(f"{'list field':38} {'labelled':>9} {'found':>6} {'MISSED':>7} {'extra':>6} {'recall':>7}")
    for field in scoring.LIST_FIELDS:
        row = totals.field(field)
        if row and row["want"]:
            print(f"{field:38} {row['want']:9} {row['hit']:6} {row['missed']:7} {row['extra']:6} {row['hit'] / row['want']:6.0%}")
    print("  A missed item has no entry and therefore no needsReview: v3.2 has no `possibleMissedMark` carrier, so every")
    print("  one of these is silent. They are gated on this recall baseline (G1b), never folded into the page counts above.")

    uncertain = [(f, r) for f, r in totals.ordered() if r["uncertain"] >= r["n"] * 0.5]
    if uncertain:
        print("\n  labels are uncertain on >= half the pages for: " + ", ".join(f"{f} ({r['uncertain']}/{r['n']})" for f, r in uncertain)
              + " -- not measurable today.")


def print_gates(totals, frozen_fields, frozen_wrong, frozen_totals, deterministic, stale_route=None, allow_new_field=False):
    """-> True when every gate this harness can compute passes.

    `stale_route` is {page: [section]} from `replay.replay_page`: pages whose model-call graph today's code would change,
    so their score is not a verdict on this change. They are named and kept OUT of G1's per-page check and G2's flip
    lists rather than being scored as if the shipped reader had seen that answer.
    """
    print("\n== §4 gate verdicts ==")
    g1 = g1b = g3 = True
    stale_route = stale_route or {}
    routed = {page for page, sections in stale_route.items() if sections}
    if routed:
        print(f"  ---- {len(routed)} page(s) would take a DIFFERENT model-call graph under today's parser "
              f"(replay.staleRoute): {sorted(routed)}. They are excluded from the per-page checks of G1 and G2 below.")
    if frozen_fields is None:
        print("  G1/G1b/G2/G3: no frozen baseline given (--baseline); the table above is the candidate baseline (--freeze).")
    else:
        for field, row in totals.ordered():
            base = frozen_fields.get(field)
            if base is None:
                if allow_new_field:
                    print(f"  G1   NEW FIELD {field}: not in the frozen baseline, nothing to compare (--allow-new-field)")
                    continue
                g1 = False
                print(f"  G1   FAIL {field}: scored but not in the frozen baseline, so it ships ungated. Re-freeze the "
                      f"baseline, or pass --allow-new-field to accept it for this run.")
                continue
            if base["n"] != row["n"]:
                print(f"  ---- {field}: {row['n']} pages scored against a baseline of {base['n']}. The gates below compare "
                      f"different page sets and are NOT a verdict on this change.")
            # Route-stale pages are dropped from BOTH sides, so the comparison stays symmetric.
            now_silent = set(row["pages"]["wrongUnflagged"]) - routed
            base_silent = frozen_wrong.get((field, "wrongUnflagged"), set()) - routed
            if len(now_silent) > len(base_silent):
                g1 = False
                print(f"  G1   FAIL {field}: wrong-and-unflagged {len(base_silent)} -> {len(now_silent)}")
            # A count cannot see a silent error that MOVES: one page losing a silent error while another gains one nets
            # to zero, and G2's diff unions the two wrong buckets, so a page sliding wrongFlagged -> wrongUnflagged is
            # invisible to both. The frozen file already stores the page list; compare identity, not size.
            newly_silent = sorted(now_silent - base_silent)
            if newly_silent:
                g1 = False
                print(f"  G1   FAIL {field}: page(s) {newly_silent} are wrong-and-unflagged now and were not in the baseline")
            if row["missed"] > base["missed"] or row["hit"] < base["hit"]:
                g1b = False
                print(f"  G1b  FAIL {field}: items found {base['hit']} -> {row['hit']}, missed {base['missed']} -> {row['missed']}")
            # The review budget is the number of pages a reviewer must open: rightFlagged + wrongFlagged. Counting
            # rightFlagged alone would call a fix a regression -- correcting the value on an already-flagged page moves
            # it from wrongFlagged to rightFlagged at identical review cost (W1: name 76 -> 76 flagged pages).
            flagged, base_flagged = row["rightFlagged"] + row["wrongFlagged"], base["rightFlagged"] + base["wrongFlagged"]
            rise = flagged - base_flagged
            if rise > REVIEW_BUDGET and row["wrongUnflagged"] >= base["wrongUnflagged"]:
                g3 = False
                print(f"  G3   FAIL {field}: flagged pages {base_flagged} -> {flagged} (+{rise}, budget +{REVIEW_BUDGET}) with no "
                      f"fall in silent errors; right-but-flagged {base['rightFlagged']} -> {row['rightFlagged']}")
        now_total = cross_field_unflagged(totals, routed)
        base_total = frozen_totals.get("wrongUnflagged")
        if base_total is not None and routed:  # the same pages leave the baseline's side of the comparison
            base_total -= sum(len(frozen_wrong.get((f, "wrongUnflagged"), set()) & routed)
                              for f in frozen_fields if f not in SUPERSEDED)
        if base_total is None:
            print("  ---- the frozen baseline predates the [totals] block, so §4 G1's cross-field total has nothing to "
                  "compare against. Re-freeze it.")
        elif now_total > base_total:
            g1 = False
            print(f"  G1   FAIL cross-field TOTAL wrong-and-unflagged {base_total} -> {now_total}")
        print(f"  G1   {'PASS' if g1 else 'FAIL'}  no field and no page newly silent, cross-field total "
              f"{'not risen' if base_total is not None else 'NOT COMPARED'}, every scored field gated")
        print(f"  G1b  {'PASS' if g1b else 'FAIL'}  no list field lost item recall")
        print(f"  G3   {'PASS' if g3 else 'FAIL'}  review budget (flagged pages +{REVIEW_BUDGET}/field unless silent errors fall)")
        print("  G2   paired page flips (a deterministic change must explain all of them):")
        flips = 0
        for field, row in totals.ordered():
            was = frozen_wrong.get((field, "wrongFlagged"), set()) | frozen_wrong.get((field, "wrongUnflagged"), set())
            now = set(row["pages"]["wrongFlagged"]) | set(row["pages"]["wrongUnflagged"])
            fixed, broke = sorted(was - now - routed), sorted(now - was - routed)
            if fixed or broke:
                flips += len(fixed) + len(broke)
                print(f"       {field:36} fixed {len(fixed):3} {fixed}   broke {len(broke):3} {broke}")
        if not flips:
            print("       none: identical page-for-page to the frozen baseline")
    print(f"  G6   {'PASS' if deterministic else 'FAIL'}  the replay + scorer are deterministic across two runs")
    print("  G0   NOT MEASURABLE HERE (blocking for W2): needs the archived 1610 px production PNGs + sha256 manifest.")
    print("  G4   NOT MEASURABLE HERE: deterministic ms/page covers the image pipeline; use tests/bench_deterministic.py.")
    print("  G5   NOT MEASURABLE HERE: render stability needs both the 1400 px and 1610 px renders (G0 first).")
    print("  G7   NOT MEASURABLE HERE: crop inertness needs the page images.")
    return g1 and g1b and g3 and deterministic


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--data", required=True, type=Path, help="operator directory holding labels.json and the results dirs")
    parser.add_argument("--results", default="results-prod", help="results subdirectory of --data (default: results-prod)")
    parser.add_argument("--baseline", type=Path, default=DEFAULT_BASELINE, help="frozen baseline to gate against")
    parser.add_argument("--freeze", type=Path, help="write the run's counts to this file as the new frozen baseline")
    parser.add_argument("--no-baseline", action="store_true", help="report only, do not gate")
    parser.add_argument("--allow-new-field", action="store_true", help="accept a scored field that has no row in the frozen "
                                                                       "baseline instead of failing G1 on it")
    parser.add_argument("--learning-loop", action="store_true", help="also replay the pages IN ORDER with the confirm route "
                                                                     "live (plan §1D, §3 W3a); the W3a invariant joins the gates")
    parser.add_argument("--thresholds", action="store_true", help="also report what each review threshold costs and catches "
                                                                  "(plan §3 W6, §8.6): a report, never a gate")
    parser.add_argument("--verified", type=Path, help="operator copy of the production corrections.jsonl. W3a made the confirm "
                                                      "route audit-only, so this ALSO re-enables the retired raw->value memory "
                                                      "in-process: archaeology only, never a candidate run")
    args = parser.parse_args(argv)

    if args.verified:
        os.environ["OCR_VERIFIED_FILE"] = str(args.verified)
        replay.N.VERIFIED_MEMORY_ENABLED = True
        print("WARNING: --verified re-enables the raw->value memory W3a retired. This run scores the PRE-W3a reader and "
              "its gate verdicts are not a verdict on the current code.")
    labels, pages = load(args.data, args.results)
    totals, mismatches, notes = run(labels, pages)
    again, _, _ = run(labels, pages)
    deterministic = [(f, {k: r[k] for k in COLUMNS}) for f, r in totals.ordered()] == \
                    [(f, {k: r[k] for k in COLUMNS}) for f, r in again.ordered()]

    print_report(totals, mismatches, notes, pages)
    frozen_fields, frozen_wrong, frozen_totals = None, {}, {}
    if not args.no_baseline and args.baseline and args.baseline.exists():
        frozen_fields, frozen_wrong, frozen_totals = read_frozen(args.baseline)
    ok = print_gates(totals, frozen_fields, frozen_wrong, frozen_totals, deterministic,
                     {page: note["staleRoute"] for page, note in notes.items()}, args.allow_new_field)

    if args.learning_loop:
        runs = {mode: learning_loop.run(labels, pages, mode) for mode in learning_loop.MODES}
        # §4 G6 covers the page-ordered replay too: a loop whose result depends on the run is not a measurement.
        repeat = {mode: learning_loop.run(labels, pages, mode) for mode in learning_loop.MODES}
        stable = all([(f, {k: r[k] for k in COLUMNS}) for f, r in runs[m][0].ordered()]
                     == [(f, {k: r[k] for k in COLUMNS}) for f, r in repeat[m][0].ordered()] for m in learning_loop.MODES)
        ok = learning_loop.print_report(runs) and stable and ok
        print(f"       {'PASS' if stable else 'FAIL'}  the page-ordered loop is deterministic across two runs (§4 G6)")

    if args.thresholds:  # a report, not a gate: it changes nothing and never moves `ok`
        thresholds.print_report(labels, pages)

    if args.freeze:
        scored_bad = {p for p, bad in mismatches.items() if any(b[1] not in ("source", "confidence") for b in bad)}
        freeze(totals, args.freeze, {
            "results": args.results, "pages": len(pages),
            "engine": f"{pages[min(pages)]['engine']} v{pages[min(pages)]['version']}",
            "replay fidelity": f"{len(pages) - len(scored_bad)}/{len(pages)} pages reproduce the stored production value, raw and "
                               f"needsReview exactly; {len(pages) - len(mismatches)}/{len(pages)} also reproduce source and confidence"})
        print(f"\nfrozen baseline written to {args.freeze}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
