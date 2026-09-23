# Reading accuracy + a real learning loop (Local AI v3.3 → v3.5, app learning store)

Status: proposed, not approved. Inputs: `release1-plan.md`, `release1-report-2026-09-22.md`, `baseline-accuracy-2026-09-22.md`,
`design-2026-09-22.md`, `scan-variation-2026-09-22.md`, plus the offline experiments in the operator scratch dir
(`realdata/eval-c/`: `dict-calib/`, `text-fields/`, `visual/`, `model-side/`, `final.txt`). Branch `feature/release2-login-export`.
Order: this work runs **beside** Release 2 (login + export) and **before** Release 3 (other formats); §7 says why that order is
forced rather than chosen. Aggregates only — page numbers, field names and counts; no customer values anywhere in this file.

The user's request behind it: *"check and improve reading accuracy further, and add learning"* — the system must get better from
staff corrections over time. Two findings decide the whole plan:

1. **The cheapest accuracy left is not in the model.** Zero-model-call parser fixes move the customer fields by +10 / +9 / +3
   pages with **0 regressions**, measured on the stored production answers, so they cost nothing per page. Zero-model-call
   geometry fixes move the body map from 33 to 50 exactly-right pages **on a simulated 1610 px render** — re-measuring them on
   the archived production PNGs is a precondition, not a formality (§0 render caveat, §4 G0).
2. **The learning hook that exists today makes accuracy worse, not better.** Replayed page by page on the 95 labelled pages with
   the production token gate in place, it buys +1 right page per field and creates **8 confident-wrong therapist values and 1
   extra silent treatment error** (`eval-c/dict-calib/out_memory_gate.txt`). It must be switched off before any volume is fed
   into it, and replaced by a store that votes, scopes, conflicts and retires.

---

## 0. Baseline — production v3.2, 95 real pages (2026-09-22)

Right / wrong-but-flagged / wrong-and-**UN**flagged, scored on the **stored production responses** (`results-prod`, 95 pages)
— including the body-map rows, which an earlier draft of this table took from a simulated render (see the caveat below it).
"Corrected" restates the figure after the scorer bug of §1E is fixed; where the two differ, the corrected column is the one this
plan optimises.

| Field | Right | W&flagged | W&UNflagged | Corrected / note |
|---|---|---|---|---|
| Form number | 95/95 | 0 | 0 | done |
| Gender | 94/95 | 1 | 0 | done; the miss is a tick drawn beside the box |
| Referral sources | 94/95 | 1 | 0 | done |
| Pressure | 89–90/95 | 5 | 0 | 6 misses are genuine double marks / circled labels — by design |
| Date | 84/95 | 11 | 0 | 9 year/month digit misreads, 2 unread; every form in the batch shares one visit date |
| Nationality | 81/95 strict | 13 | 0 | **83/95, W&F 12** measured; 81 was an *asymmetric* key (§1E) |
| Health conditions | reported 81 % | 18 | 0 | **91/95 value-exact** (77 + the 14 marker-only pages), W&F 4 — confirmed |
| Oil / scrub | reported 59 % | 39 | 0 | **91/95 value-exact**, W&F 4 (56 + the 35 marker-only pages); "89" did not match its own arithmetic |
| Hotel | 73/95 | 21 | 1 | the 1 unflagged is a parser fault, not handwriting |
| Room | 73/95 | 21 | 1 | 16 distinct rooms exist at this branch |
| Customer name | 41/95 exact | 51 | 3 | 66 at similarity ≥ 0.8; character error rate 52 % |
| Treatment names | 46/95 | 47 | 2 | 50/95 under the labels' own hot-oil convention |
| Treatments + durations | 42/95 | 51 | 2 | |
| Written total minutes | 19/31 | — | — | only 31 pages carry a written total |
| Body map — preferred | 38/95 | 54 | 3 | item recall 272/384 |
| Body map — avoid | 55/95 | 39 | 1 | item recall 14/30 |
| **Body map — both lists as one unit** | **35/95** | 60 | **0** | the only honest body-map metric (§1E) |
| Therapist | 6/95 | 89 | 0 | labels marked uncertain on 91/95 — **not measurable today** |

> **This table is now produced by code, not by hand.** `local-ai/tools/benchmark.py --data <operator dir>` replays all 95
> stored production answers through today's parsers and prints every row above plus the §4 gate verdicts, with 0 model
> calls. Its frozen output is `local-ai/tools/baseline-v3.2-prod-95.txt` and **that file, not this table, is the baseline
> every later change is gated against.** Measured 2026-09-23: every row above reproduces except the three restated in the
> "Corrected" column. Three further corrections the harness forced:
> * **`staffOnly.totalMinutes` has no flag carrier at all.** It is a bare integer on `staffOnly` with no `needsReview`, so
>   all **12 of its 31** wrong written totals are silent by construction and cannot be gated. W4b targets the cause; a
>   carrier for it is a separate, unplanned piece of work.
> * **Silent errors on the model-read text fields are 9, not 10** — name 3, hotel 1, room 1, treatment names 2, treatments
>   +durations 2 (the same 2 pages) — on 7 distinct pages. §4 G1's "treatment 5" is not reproducible from `results-prod`.
> * **Body map, one unit, at item level: 286 of 414 labelled items found, 128 missed, 88 extra.** The page-level unit row
>   above (35 right, 0 W&U) cannot see any of that; §4 G1b is what gates it.

> **Render caveat — read this before any body-map number in §3.** Production ran 1610 px renders of the source PDF. The offline
> harness can only re-render the native 1400 px JPEGs, either as they are (`source=jpg`) or bilinearly upsampled to 1610 px
> (`source=prod`, `eval-c/harness.py:5-6,41-48`). **Neither reproduces production.** Against the stored production responses the
> upsample agrees on preferred 49/95 and avoid 60/95; the plain JPEG agrees on 56/95 and 67/95; the body-map *evidence* is
> identical on 12/95 and 11/95 pages respectively (`eval-c/baseline.txt`, `eval-c/fix/fidelity.py`). Every W2 body-map figure in
> §3 is therefore **measured on the simulated 1610 px render and labelled `sim-1610`**, not on production. §4 **G0** makes
> re-measuring on the archived production PNGs a precondition for shipping W2, and G1's body-map baseline is production's.

Review load and runtime (the two budgets every change is charged against):

* **95/95 pages need review** today (94/95 even if therapist is ignored); median 3 flagged text fields per page.
  Flagged pages per field: name 76, treatments 75, room 33, hotel 30, nationality 20, therapist 95.
* Page median **51.7 s**, p90 53.9 s, max 78.7 s; 82 min for the 95-page batch; one Ollama slot, one model call ≈ **25.6 s**
  of which ≈ 23.9 s is fixed prompt+image prefill. All deterministic work together is **85–105 ms/page**.
* Image cost is **fixed per image** (~1,070 tokens) regardless of crop size: a 0.08 MP header strip takes 24.3 s, a 0.21 MP
  stack 25.2 s. **Prompt text and crop geometry are therefore free; an extra call costs a flat 25.6 s.**

Run-to-run noise, which bounds every claim: the two stored v3.2 runs of the same 87 pages differ on 8–13 pages per field;
identical inputs reproduce exactly (14/14). A variant must beat the baseline by more than that band to have proved anything.

---

## 1. Error taxonomy (95 pages, counts are page-errors unless marked "items")

### A — Parser / normalisation. Zero model calls to fix. 26 page-errors.
| Cause | Field | Count | Code |
|---|---|---|---|
| English label written mid-line (`Name … Nationality国籍 …`) or "labels block then values block" | name 10, nationality 6, hotel 3 | 19 | `ocr_normalize.py:907-914` `_is_label`, `:938-948` |
| A mark with no letters accepted as a value | hotel | 2 | `ocr_normalize.py:966-968` `normalize_free_text` |
| Country code missing from the aliases, or a two-token answer with one exact alias | nationality | 3 | `ocr_normalize.py:971-975` |
| Bracketed model notes and 1-letter unit fragments became treatment items | treatments | 3 | `ocr_normalize.py:239-241` `_MODEL_NOTE`, `:518` `_MIN` |
| Box glyph before the room number | room | 1 | `ocr_normalize.py:299` |

On page 31 the customer's name currently lands in the hotel field **unflagged** — the only wrong-and-unflagged hotel in
production, and a parser fault.

### B — Model reading. Needs prompt / crop / resolution / model work.
| Cause | Field | Count |
|---|---|---|
| Oil abbreviation written as a Latin/digit look-alike or another Thai word | treatments | **26** |
| Other treatment word misread (3 of them whole-line, taking the guest count with them) | treatments | 12 |
| Duration or hour-unit misread (3 are hour-unit shapes missing from `visualAliases.hourUnit`) | treatments | 7 |
| Handwriting near-miss, similarity ≥ 0.8 (1–2 characters; 9 labels uncertain; 3 unflagged) | name | 25 |
| Handwriting misread, similarity < 0.8 (13 labels uncertain) | name | 16 |
| Box has ink, model returned the label with no value | name | 2 |
| Near-miss ≤ 2 characters (dictionary-fixable) | hotel | 6 |
| Misread / hallucination (1 invented for a near-empty box) | hotel | 9 |
| Written past the customer crop's right edge (x = 352) | hotel | 2 |
| Misread or empty | nationality | 5 |
| Leading "1" drawn on the printed left border — dropped or doubled | room | 9 |
| No digits in the answer (model note or tick glyph instead) | room | 6 |
| Single-digit misread | room | 6 |
| Written total past the STAFF crop's right edge (x = 710) | totalMinutes | 5 |
| Hour unit read as digits after "=" ; notes; dash instead of "=" | totalMinutes | 7 |
| Year/month digit misread (9) or unread (2) — all flagged | date | 11 |
| Scrawled nickname, no roster to match against | therapist | 86 |

### C — Deterministic marks (body map, checkboxes). Zero model calls to fix.
| Cause | Field | Count |
|---|---|---|
| Circle read as a cross → the item surfaces (flagged) in `avoidAreas` instead | preferred | **43 items** / 24 pages |
| One mark spans two printed label rows (13 of them one label pair 5 ref px apart) | preferred | 31 items / 20 pages |
| One large figure mark near several leader dots | preferred | 12 items |
| Pen on the orange figures not in the ink mask (`FIGURE_LUM` 125 vs figure luminance ≈ 180) | both | 15 items |
| No ink component at the label at all (very faint stroke, dash on the leader line) | preferred | 6 items |
| Extra area: a big loop or figure scribble mapped to the nearest dot | both | 19 items |
| Cross read as a circle | avoid | 6 items |
| Fragment of a broken loop assigned to a neighbouring label | both | 5 items |
| Ink that is not a body-map mark (margin note, stamp, stray line) | both | 5 items |
| Labelled area is not printed on the form (no such label exists) | avoid | 4 items |
| **Correct but flagged** (confidence capped at 0.6 for any mark not on a printed label) | preferred | **204 of 283 correct items** |
| Struck-out row → correct empty list, still flagged | oil 36, health 15 | 51 pages |
| Genuine double marks / circled labels / tick beside the box | pressure 6, gender 1 | 7 — by design |

Every body-map false positive is flagged: **0 unflagged FP entries**, in the eval and in production. The body map's real
failure mode is *misses*, which no current counter treats as an error (§1E).

### D — Learning-loop defects (measured by page-ordered replay, staff confirming every page to its label).
| Defect | Count | Evidence |
|---|---|---|
| Therapist memory creates confident wrong values (with the production token gate) | **8** (12 without the gate) | `out_memory_gate.txt` |
| Treatment memory hits that return a wrong value | 13 of 77 hits (9 with a key ≤ 4 chars, 5 keys with conflicting history) | `learning/sim_memory_results-prod.txt` |
| Treatment memory breaks a previously right, unflagged value | 1–2 | `out_memory_gate.txt` |
| A **right** memory value is still flagged, so staff never see the learning | 0 of 63 flagged hits cleared; in production 4 of 4 real hits (p026–p029) | `ocr_confidence.py:36,186-187` |
| Junk rows written by a *genuine* confirmation (flagged-but-unedited suggestion) | 15 treatment items + 13 therapist suggestions | `document-view.ts:305,362`; `workbench.ts:417,473` |
| Raw→value memory for rooms (if it were ever allowed) | right rooms 73 → 64 | `learning/sim_memory_results-prod.txt` |
| A confirmation is lost for good after ≈ 30 s of Local AI downtime (2+4+8+16 s, then DEAD, no re-drive) | mechanism | `0010_outbox_dispatcher/migration.sql:19-29` |
| One confirmation delivered twice (legacy route + the 1 s outbox loop) | mechanism | `server.ts:347-373`; `index.ts:681-707` |
| Memory is global — no tenant, no branch, no undo, no delete | by design | `ocr_normalize.py:58-72,121-125`; `api.py:609-616` |

Structural cause: the key is `(field, exact raw string)` and **the last row written wins** (`ocr_normalize.py:71`). A model
reading is not an identity — of 117 aligned treatment items, 7 later items would be *fixed* by an alias while **15** hit a key
already confirmed to a different value (`out_alias_ceiling.txt`). Any raw→value scheme must therefore retire on conflict.

### E — Metric artefacts. Fix the scorer, not the reader.
* `compare.py:12` scores `value or raw`, so the value-less `"struck out: …"` marker (`api.py:303-306`) counts as a list item:
  **35 oil and 14 health pages** are reported wrong although their value sets match the labels exactly. Measured with the
  value-set fix: oil **56 → 91/95**, health **77 → 91/95**; 38 oil and 14 health pages carry a marker and stay flagged
  (review cost, not an error). The oil figure quoted as "89" elsewhere in this plan was wrong — 56 + 35 is 91.
* `compare.py`'s nationality map lacks 2 country codes; all 5–7 nationality "wrong & unflagged" cases disappear once both sides
  go through `normalize_nationality`. Measured with that fix: **83/95 right, W&F 12, W&U 0** (strict text alone is 62/95).
  The replaced `natkey` was worse than "missing 2 codes" — it was **asymmetric**, matching the read value without its
  token branch and the label with it, so **2 pages whose reading was character-for-character identical to the label scored
  wrong**. The rule the harness now keeps: the scorer applies *the reader's own* normaliser, identically to both sides, and
  never carries an alias the reader lacks — otherwise W1c's master-list additions would be invisible instead of measurable.
* The A8 claim *"checkbox lists exactly right on 87/95, 0 unflagged false positives"* covers **referral + health + oils only**
  (`eval_det.py:124-127`) and counts only false *positives*; a **missed** mark is counted separately and can never carry a flag.
  In the same A8 run the body map was 42/95 preferred and 56/95 avoid **on the 1400 px JPEGs**, against production's own
  38/95 (40 %) and 55/95 (58 %) — i.e. **no metric discrepancy**; the residual 4 and 1 pages are the render difference of the
  last bullet. The 112 missed preferred items are the real, and silent, body-map error.
* A circle read as a cross makes `preferredAreas` wrong-and-unflagged while the flag sits in `avoidAreas`. **The body map must
  be scored, and flagged, as one unit.**
* The remaining production-vs-eval difference is the render: production ran 1610 px pages, the eval reads the native 1400 px
  JPEGs; the same code changes body-map values on 30/95 pages between them, and **neither simulated render reproduces
  production** (§0 caveat). Render stability is a first-class gate (§4 G5); re-measuring on the archived production PNGs is a
  precondition (§4 G0).

---

## 2. The learning loop

### 2.1 What exists today
`POST /v1/ocr/confirm` (`api.py:609-616`) accepts only `field ∈ {treatment, therapist}` and appends six fields to
`corrections.jsonl`; `ocr_normalize.verified_match` looks the exact raw string up and returns the value at confidence 1.0 with
`needsReview: false`. The app captures far more — an `ocr_corrections` row for every changed field, the full `raw_response` with
its evidence, the reviewed `structured_result` and the original image — but on the way to the Local AI the tenant, the branch,
the previous value, the token confidence, the engine/prompt/parser version and the *changed-vs-merely-confirmed* distinction are
all dropped. Measured effect on the 95 pages: **+1 right page per field, +9 silent errors** (§1D).

### 2.2 What is learned — four kinds, four different rules
The single worst property of today's hook is that everything is one kind (`raw → value`, trusted absolutely). Split it:

| Kind | Learned from | Matched on | Effect on the value | Fields |
|---|---|---|---|---|
| **A** value dictionary | the confirmed **value** | fuzzy vs the read value (≥ 0.80) | replaces the value, **always flagged** | `hotelName` |
| **B** alias | (read raw → confirmed master value) | normalised key, then fuzzy | sets the value, `needsReview` unchanged | `treatment`, `nationality`, later `therapist` |
| **C** validation list | the confirmed **value** | exact membership | **never** changes the value; *raises* the flag when the read value is not in the list | `roomNo`, later per-branch durations |
| **D** calibration | right/wrong outcome of each confirmed field | per-field threshold + reliability table | moves the review threshold either way | every model-read field |
| **E** visual sample | a confirmed crop's 128-float signature | **k-NN: ≥ 2 agreeing samples from ≥ 2 distinct documents**, same render scale | second opinion; may override only `roomNo`, **always flagged** (§3 W5a) | room digits, body-map marks, struck rows |

Measured on the 95 pages (`dict-calib/out_sim_dict.txt`, page-ordered, staff confirming every page):
hotel dictionary at **≥ 1 vote**, threshold 0.80 → right 73 → 75, W&U unchanged (0.75/0.80/0.85/0.90 give 74/75/74/74, so the peak
is flat, not a knife edge); **at ≥ 2 votes the gain is exactly 0 — 73 right, the baseline, at all four thresholds.** That single
line decides the hotel question (§2.8, §8.2). Room validation list → W&U 1 → 0 **at ≥ 1 vote for R&F 12 → 21**, or at ≥ 2 votes
for 12 → 31 — the same silent-error removal for 10 more flagged pages; aliases at ≥ 2 votes with
the master guard → **no page-level change at this volume**, which is exactly why they ship for safety and compounding rather than
for a 95-page number. Reuse estimates say which kind belongs where: room 99 %, treatment name 98 %, nationality 73 %, hotel 56 %,
therapist **26 %** (Good–Turing on the 95 labelled pages, `out_dict_growth.txt`) — hotels are a genuine open dictionary that
compounds, rooms and treatments are closed sets that want lists and aliases, and **therapist cannot be learned from
confirmations at all** without the roster. Every learning figure in this plan is a *page-ordered replay in which staff confirm
every page to its label* — a perfect oracle reviewer, which §2.8 says cannot be assumed before login. Read them as ceilings.

### 2.3 Where it lives
The **app DB is the system of record**; the Local AI receives an immutable, versioned snapshot. `corrections.jsonl` is demoted to
an audit artefact.

```sql
-- migration 0019_learned_values (0018 is the last one today)
ocr_learned_entries(id, organization_id uuid NOT NULL REFERENCES organizations(id), branch, kind, norm_key, value,
                    votes, conflict_votes, status,            -- CANDIDATE|ACTIVE|RETIRED|APPROVED|BLOCKED
                    first_seen_at, last_seen_at, approved_by, retired_by, retired_reason,
                    engine_version, master_version,
                    UNIQUE(organization_id, branch, kind, norm_key, value),
                    UNIQUE(id, organization_id));
ocr_learned_votes(entry_id, organization_id uuid NOT NULL, document_id, correction_id, verified_by, weight, created_at,
                  PRIMARY KEY(entry_id, document_id),          -- one vote per document ⇒ re-delivery is a no-op
                  FOREIGN KEY (entry_id, organization_id) REFERENCES ocr_learned_entries(id, organization_id),
                  FOREIGN KEY (document_id, organization_id) REFERENCES documents(id, organization_id),
                  FOREIGN KEY (correction_id) REFERENCES ocr_corrections(id));
ocr_visual_samples(id, organization_id uuid NOT NULL REFERENCES organizations(id), branch, field_kind, shape_class,
                   sig bytea, recipe, geom_version, render_scale_px, src_document_id,  -- see §2.7 on label/ref_bbox
                   votes, conflicts, status, created_at, retired_at, retire_reason,
                   FOREIGN KEY (src_document_id, organization_id) REFERENCES documents(id, organization_id));
```

**Tenant isolation is not optional and not an implementation detail.** Every tenant table in this repo carries
`ENABLE`+`FORCE ROW LEVEL SECURITY`, an `app.current_org` policy and explicit grants
(`prisma/migrations/0006_correction_audit_outbox/migration.sql:27-32`,
`prisma/migrations/0017_batch_processing/migration.sql:14-17,35-36`). 0019 does the same for all three tables:

```sql
ALTER TABLE ocr_learned_entries  ENABLE ROW LEVEL SECURITY; ALTER TABLE ocr_learned_entries  FORCE ROW LEVEL SECURITY;
ALTER TABLE ocr_learned_votes    ENABLE ROW LEVEL SECURITY; ALTER TABLE ocr_learned_votes    FORCE ROW LEVEL SECURITY;
ALTER TABLE ocr_visual_samples   ENABLE ROW LEVEL SECURITY; ALTER TABLE ocr_visual_samples   FORCE ROW LEVEL SECURITY;
CREATE POLICY learned_entry_scope  ON ocr_learned_entries USING (organization_id::text = current_setting('app.current_org', true));
CREATE POLICY learned_vote_scope   ON ocr_learned_votes   USING (organization_id::text = current_setting('app.current_org', true));
CREATE POLICY visual_sample_scope  ON ocr_visual_samples  USING (organization_id::text = current_setting('app.current_org', true));
GRANT SELECT, INSERT, UPDATE ON ocr_learned_entries TO ocr_app;   GRANT SELECT ON ocr_learned_entries TO ocr_worker;
GRANT SELECT, INSERT         ON ocr_learned_votes   TO ocr_app;   GRANT SELECT ON ocr_learned_votes   TO ocr_worker;
GRANT SELECT, INSERT, UPDATE ON ocr_visual_samples  TO ocr_app;   GRANT SELECT ON ocr_visual_samples  TO ocr_worker;
```

`ocr_learned_votes` also closes the double-delivery hole: a vote is keyed by document, so the legacy route and the outbox loop
delivering the same confirmation twice cannot inflate a count. **Precondition (§2.5.9): no vote row is written at all while the
shared auto-auth subject is in use** — a ledger whose writers are anonymous cannot support any of the rules below.

**Transport.** One JSON snapshot per tenant, shaped like `master_data.json` so the existing `_FileCache` loader
(`ocr_normalize.py:32-56`) is reused verbatim: `{snapshotVersion, generatedAt, tenantId, masterVersion, engineVersion,
branches:{<branch>:{hotelValues, roomValues, treatmentAliases, nationalityAliases, therapistAliases}}}`, PUT to a new
`PUT /v1/learned` (with `GET /v1/learned` surfaced in `/health`). Snapshots are stored at a **per-tenant path** and held in a
**dict of `_FileCache` instances keyed by tenant**: `_FileCache` holds exactly one `(key, value)` pair per instance
(`ocr_normalize.py:33-56`) and the module creates one instance per file (`:117`), so a single shared instance would either serve
one tenant's learned values to another or re-parse on every alternating request. **The snapshot carries raw strings, not
normalised keys** — the
Local AI normalises on load with its own `_key()` (`ocr_normalize.py:150`), so a TypeScript re-implementation can never drift out
of sync. Because the PUT is whole-state and idempotent, the DEAD-row problem of `0010` disappears by construction: a failed
publish is simply retried on the next maintenance tick. `publishLearnedSnapshot` replaces `confirmSender`
(`services/ocr-worker/src/index.ts:252-278`).

### 2.4 Promotion, conflict, retirement
```
CANDIDATE → ACTIVE    votes ≥ minVotes(kind), conflict_votes = 0, key ≥ 3 chars and not digits-only,
                      and (kind B) the value exists in the current master list
ACTIVE    → RETIRED   kind B: any conflicting vote; kind A: two conflicting documents
any       → BLOCKED   admin; never promotes again  (the anti-poisoning lever)
any       → APPROVED  admin; exempt from the vote rule and the ONLY status that may clear a review flag
```
`minVotes`: hotel 1, room 2, treatment alias 2, nationality alias 2, therapist alias 2 **and** admin approval, **kind E 2**
(≥ 2 agreeing samples from ≥ 2 distinct documents before a sample may be used, and a disagreeing confirmation retires the
sample). Votes are counted per **distinct document**; `weight = 1` for an edited field, `weight = 0` for a
confirmed-but-unedited one, and weight-0 votes can never activate an entry on their own. Rejecting a learned suggestion in the
workbench is automatically a conflict vote, so bad entries retire themselves without anyone visiting the admin page.

**One promotion regime, stated once (this supersedes any looser reading of §2.8, §7 or §8.2).** Post-login, `requireDistinctUsers
= true` and kinds A/B need **≥ 2 distinct reviewers**. Pre-login, nothing promotes: §2.5.9's auth precondition means no vote is
even written. The measured consequence, which the plan does not hide: **at ≥ 2 votes the hotel dictionary contributes +0 on the
95-page set** (`out_sim_dict.txt`, 73 right at every threshold). The hotel dictionary therefore ships **dark** — justified by the
growth argument (Good–Turing steady-state reuse ≈ 56 %, §2.2), not by a 95-page number. `minVotes: hotel 1` applies **only** to
counting distinct documents *within* the ≥ 2-distinct-reviewer rule; it is not a licence to activate a hotel value on one
confirmation.

### 2.5 Safety invariants (non-negotiable)
1. **A learned entry never clears a review flag by itself.** Only `APPROVED` entries may, and only at score ≥ 0.95 with ≥ 2 votes.
   Measured basis: letting learned entries override the token flag clears 7–9 of ~112 flagged treatment items and adds **+2 to
   +3** new silent errors per 95 pages — wrong-and-unflagged 2 → 4 under policies P1/P2/P4 and 2 → 5 under P3
   (`learning/sim_policy_results-prod.txt`). **W5b (§3) is the one proposed exception and it is not granted by default**: see
   the exception clause there; until it has its own gate, W5b only *orders the review queue* and clears nothing.
2. **Confirmed-unchanged is not a correction.** `document-view.ts:305` and `:362` currently turn *any* flagged item with a value
   into a verified row because the workbench posts the whole draft. Change to: changed ⇒ weight 1; flagged-but-unchanged ⇒
   weight 0. Removes the 28-item junk-row exposure of §1D.
3. **Conflict retires**, always. 15 conflicts against 7 fixable items is the measured ratio.
4. **No raw→value memory for digits or identity fields.** `roomNo` is validation-only; `customer.name` is never learned.
5. **Scoped by tenant and branch**, always — and that means **both** identifiers on the wire. `POST /v1/ocr`
   (`api.py:573`) carries neither today, and the branch is detected out of the STAFF answer itself
   (`ocr_normalize.py:216-226`), which is too late. Add **`tenantId` and `branch`** to `POST /v1/ocr`, to the confirm payload and
   to `PUT /v1/learned`, and **fail closed**: a request missing either scope gets no learned match at all and degrades to pure
   v3.2 rather than reading from whatever snapshot happens to be loaded.
6. **Version-keyed.** `nameRaw` is post-visual-alias text (`ocr_normalize.py:782-783`), so a prompt, parser or `visualAliases`
   change silently changes what a kind-B key means. On a version bump, kind-B entries drop back to `CANDIDATE` (keeping their
   votes); kinds A, C, D are version-independent and survive.
7. **Human-verified confidence is not token confidence.** `ocr_confidence._SKIP_SOURCES` is `("ink-mark","none","checkbox")`
   (`ocr_confidence.py:36`), so a memory or learned match is re-scored down by the model's logprobs — measured 1.0 → 0.223,
   flagged. Report reading confidence separately instead of overwriting the field's confidence; keep the flag.
8. **Nothing a staff member types ever enters a model prompt.** Roster and look-alike hints come only from admin-edited
   `master_data.promptHints`, validated (2–12 chars, Thai/Latin letters and digits only, no newline or brackets), capped at 20
   names. A learned string in a prompt is a prompt-injection vector.
9. **Auth — this is the learning store's precondition, not a footnote.** The pre-login problem is not only *attribution*
   (§2.8), it is *write access*. `GET /api/web-token` is handled as the first statement in the request handler, before any
   authentication, and mints a 15-minute JWT whenever `OCR_WEB_AUTO_AUTH=1` (`apps/ocr-web/src/server.ts:385-393`, minted at
   `:102-140`); that token is accepted by `POST ocr/confirm` (`:347-373`) and `saveReview` (`:333`), and the web service is
   published publicly (`deploy/docker-compose.yml:31,33`). On the Local AI side `POST /v1/ocr` (`api.py:573`) and
   `POST /v1/ocr/confirm` (`api.py:610`) have no auth at all, `OcrClient` sends only a content-type header
   (`packages/ocr-client/src/index.ts:144-150`), and `OCR_API_BASE_URL` is a **public gateway URL between two different VPS**
   (`deploy/docker-compose.yml:38,68`) — so "private network" is not the topology this system has. Therefore:
   * **No `ocr_learned_votes` row is written while `OCR_WEB_AUTO_AUTH` is set.** The write path fails closed on the auto-auth
     subject id. "Collect votes from day one" starts the day Release 2 deletes that variable (`release2-plan.md:1435,1483`),
     not before.
   * A **shared secret on every Local AI write route** — `PUT /v1/learned` *and* `POST /v1/ocr` *and* `POST /v1/ocr/confirm`
     until W3a disables it — plus a gateway allow-list, **verified on the host before W3 starts**, not listed as unverified.
10. **Kill switch:** `OCR_LEARNED_DISABLE=1` restores pure v3.2 behaviour without a rollback.

### 2.6 Undo and admin
`GET /api/learned?branch=&kind=&status=` lists entries with votes, conflicts, first/last seen and the linked `ocr_corrections`
ids; `POST /api/learned/:id/{approve,retire,block}`. **The same list/approve/retire/block surface covers `ocr_visual_samples`**
(`GET /api/learned/visual`, `POST /api/learned/visual/:id/{approve,retire,block}`) — that table already carries `votes`,
`conflicts`, `status`, `retired_at`, `retire_reason` and without endpoints nothing can reach them. **Every mutating route
requires the Release 2 `ADMIN` role** (`release2-plan.md:477,494,509`); until that role exists the page ships **read-only**,
because `packages/auth` has no role, scope or admin concept today. Retire requires a reason, is audited (`retired_by`,
`retired_reason`) and
bumps `snapshotVersion`, so the Local AI drops the entry within one maintenance tick (~1 s). This is the undo that does not exist
today: `api.py:609-616` is append-only, `ocr_normalize.py:71` last-wins is the only override, and clearing a value never sends.
In the workbench a learned value is rendered with a badge and its vote count (from a new `evidence.learned` block), so staff can
see what the system learned and why.

### 2.7 Privacy and retention (PDPA)
* **Learned:** the model's raw *text* reading and the confirmed value. Customer **names are never learned**.
* **Body-map and checkbox visual samples.** The earlier claim that storing a "shape class only" keeps health data out of the
  store **does not hold as the schema was written**, and the schema is corrected in §2.3 rather than the claim being repeated.
  The reference geometry is a fixed public constant — `ocr_layout.py:9` pins the reference page at 805×569, `:24-38` gives every
  health condition its own fixed `(x, y)` and `:63-73` does the same for the 14 body areas — so a stored `ref_bbox` plus
  `geom_version` **is a lookup table for the exact health item or body area**, and `src_document_id` links it to one identified
  customer document. Two consequences, both binding:
  1. `label` and `ref_bbox` are **removed** from `ocr_visual_samples`; a row keeps `field_kind` + `shape_class` + `branch` +
     `render_scale_px` only. Provenance (`src_document_id`, `src_correction_id`) lives in a separate short-lived harvest table
     that follows the documents' 90-day clock and is covered by erasure.
  2. For as long as any row can be re-linked to a health item or body area — which includes the harvest table, and includes
     `field_kind = healthConditions` rows whatever else is dropped — those rows are treated as **PDPA s.26 sensitive personal
     data**: explicit consent basis, admin-only access, the documents' **90-day** clock rather than 24 months, and inclusion in
     erasure. §8.8 (seeding the visual store from the 95 labelled pages) is decided on this classification, not the old one.
* **Visual samples are 128-byte int8 signatures**, not pixels: an 8×8 blurred ink-density grid plus a 4×4×4 gradient histogram of
  one glyph. Raw crops only behind an off-by-default debug flag with a short TTL.
* **Vote rows carry `document_id` and `verified_by`** — a link back to an identified customer document and to a named employee.
  They are also the *only* thing that makes §2.8's "retire one bad reviewer's whole session" executable, and `retention.md`'s own
  text says cleanup "must not delete correction audit rows or verified values". So the rule is **not** a flat 90 days: a vote row
  survives **at least as long as the entry it justifies stays `ACTIVE` or `APPROVED`**; when its votes expire, the entry
  auto-retires with them. Aggregate counters (which are not personal data) are kept either way. Visual-sample TTL: 24 months for
  non-sensitive kinds, 90 days for anything re-linkable to health or body-area data (above), per-tenant and per-therapist
  deletable.
* **Retention and erasure must name every copy, because today they name almost none.** `docs/operations/retention.md` has rows
  for uploads, crops, results, jobs, keys and logs — and no row for any of these: `corrections.jsonl` (appended forever with no
  tenant, branch or expiry, `api.py:609-616`, `ocr_normalize.py:128-134`), **its unbounded deploy backups**
  (`local-ai/README.md:287` copies it to `/opt/backups/corrections-<date>.jsonl` on every deploy), the published learned
  snapshots, and `OCR_UPLOAD_DIR/{documentId}{ext}` (`api.py:588-592`, **no clean-up code anywhere in `local-ai/*.py`** while app
  originals follow 90 days; the visual harvest job re-cuts crops from exactly those uploads). Add all four rows in this release,
  and define **erasure as a procedure that touches DB + snapshot + `corrections.jsonl` + backups**, with the `pg_dump` /
  `/opt/innovera-backups` residency limit stated explicitly. A retire/block that only bumps `snapshotVersion` touches one file;
  it is an undo, not an erasure.
* **No image ever moves between app and Local AI for learning** — the confirm payload carries `(documentId, fieldPath, value)`
  and the Local AI already holds the page.

### 2.8 Why Release 2's login is what makes this loop trustworthy
Today every confirmation is attributed to one shared subject: the workbench authenticates through `/api/web-token` with
`sub = OCR_WEB_SUBJECT_ID` (`apps/ocr-web/src/server.ts:115,129`), `verifiedBy = principal.userId` (`:351`) and `saveCorrection`
even defaults `verifiedBy` to the tenant id (`packages/ocr-persistence/src/index.ts:656`). So `ocr_corrections.verified_by` is a
constant. That has four consequences the learning store cannot work around:

* **Vote independence is unenforceable.** "N distinct documents" is the only rule available; "N distinct *reviewers*" — the
  strongest anti-poisoning rule there is — needs real identities.
* **A bad reviewer cannot be undone.** With per-user attribution, retiring one reviewer's whole session is one query on
  `ocr_learned_votes.verified_by`; without it, every entry has to be judged one by one.
* **Reviewer quality cannot be measured.** Per-user overturn rates (a confirmation later corrected by someone else) are the
  natural weight for `weight` and the natural trigger for retraining a person rather than a model.
* **The PDPA audit trail is incomplete** for the very table that holds the learned copies of customer data.

There is a fifth consequence, and it is the one that actually gates the schedule: **pre-login the write path is open**
(§2.5.9), so a "dark ledger" filled today would be a ledger of rows whose origin nobody can establish — and every later
promotion, per-user weight and "retire that reviewer's session" remedy would be computed over them.

Therefore, stated once and binding on §7 and §8.2: **the vote ledger does not start until Release 2 deletes
`OCR_WEB_AUTO_AUTH`.** From that day votes are written *and* `learning.requireDistinctUsers = true` (≥ 2 distinct reviewers for
kinds A/B, admin approval for therapist); before it, the only learning that may touch a value is kind C (which can never change
one) and the W3a shutdown of the old hook. The measured price of that choice is stated in §2.4 and §8.2: hotel learning is worth
**+0** on the 95-page set under any ≥ 2-vote rule. Release 2's **export** is the other half: `confirmed_by` and
`confirmed_at` per row let the client sample-audit what the system learned from whom, which is the review the promotion rules
need in order to be trusted rather than merely asserted.

---

## 3. Accuracy workstreams, ordered by gain ÷ cost

Cost key: **0 calls** = scored offline on stored answers, no model time, no per-page cost. Every target below is on the 95-page
frozen set unless stated.

### W1 — Parser and vocabulary fixes (`local-ai/`, 0 calls) — **do first**
W1a Accept `Nationality` / `Hotel Name` anywhere in a line, including glued to their Chinese label, and assign the
"labels block then values block" answer shape in form order, flagged (`ocr_normalize.py:907-914,938-948`).
W1b Drop values that contain no letters (`:966-968`).
W1c Nationality: match token by token against exact master aliases; add the 2 missing country codes (`:971-975`, `master_data.json`).
W1d STAFF: strip bracketed English notes and trailing bracketed Thai restatements; merge 1-letter/mark-only unit fragments into
the previous item; strip box glyphs before the room number (`:239-241`, `:518`, `:299`).
W1e Extend `visualAliases.hourUnit` with the observed hour-unit look-alikes; flag a post-"=" total below 30 or above 240 that
starts with 1–4 as an hour reading.
W1f Lower the treatment fuzzy threshold 0.72 → 0.60 **for suggestions only** (they are already flagged below 0.85). Stopping at
0.60 rather than 0.50 is **precautionary, not measured**: `out_fuzzy_thresholds.txt` records `0.5: names +5 [1, 4, 42, 61, 78]
-0 []`, i.e. no harm on this set — 0.50 is simply two more matches at a similarity where a coincidence becomes plausible, and
this set has 95 pages to rule that out with. Revisit on held-out evidence, not on a hunch.

> **Target (W1a–e):** name 41 → **51**, nationality 81 → **90**, hotel 73 → **76**, room 73 → **74**, treatment names 46 → **49**,
> treatments+durations 42 → **45**, hotel W&U 1 → **0**, **0 regressions** (`text-fields/out_variants_prod.txt`, confirmed on the
> independent v3.2 run: name 40 → 47, nationality 75 → 83, hotel 68 → 70). Name character error rate 52 % → 19 %.
> **W1f adds, on top of that and on disjoint pages:** treatment names 49 → **52** (+3, pages 1/61/78 against W1a–e's 56/81/93,
> `out_fuzzy_thresholds.txt`) and nationality +1 at the 0.60 nationality threshold. Quote 52, not 49, as W1's treatment-name
> output — §4's label-hygiene work then restates it as 56 under the corrected hot-oil convention (+4 on pages 15/16/23/24).
> **Cost:** ~2 days, one file plus master aliases, 0 model calls, 0 ms/page.

### W2 — Body-map and checkbox geometry (`local-ai/ocr_marks.py`, 0 calls)
W2a **Enclosure shape rule**: a group whose ink encloses ≥ 5 % of its bbox (flood fill from outside the 1 px dilated stroke) is a
circle; only call it a cross when the ink is diagonal (≥ 0.60) **and** angular coverage ≤ 0.67; otherwise circle at confidence
≤ 0.6 (flagged). Replaces the hand-tuned score comparison at `ocr_marks.py:502-535`.
W2b **Multi-label marks**: when one component covers two printed label rows on the same side, or its interior contains two or
more leader dots, emit **every** covered area (each flagged) instead of only the nearest (`ocr_marks.py:563-568`).
W2c **Margin ink**: drop body-map ink lying entirely outside the printed label columns (`ocr_layout.py:73` `BODY_REGION` starts
9 px left of the first label, so margin notes and stamp ink fall inside it).
W2d **Figure ink**: inside the figure rectangle count a pixel as ink when luminance < 150, or when it is no longer orange
(r−b < 40) and darker than 210, instead of the single `FIGURE_LUM = 125` rule (`ocr_marks.py:28,458-470`).
W2e **One-dot certainty**: a loop enclosing exactly one leader dot is not a guess — do not cap its confidence at 0.6.
W2f Score **and flag** the body map as one unit, in the eval and in the response — **and report both lists separately as well**,
because the merge is also what would hide a per-list regression (see the target below). The unit flag needs a carrier that does
not depend on an entry existing: add a **group-level `possibleMissedMark` boolean on `recommendationCard`** (set when either
body list is flagged, when a mark was detected but not assigned, or when the figure region carries unexplained ink). On **11 of
95 pages both body lists are empty**, so without it a miss on those pages is silent by construction, and §4's scorer — which
counts a miss as an unflagged error "unless the group carries an explicit possible-missed-mark flag" — has nothing to read.

> **Target — all figures on the `sim-1610` render, which is not production (§0 caveat):** preferred 39 → **51**,
> avoid 58 → **73**, both lists right on the same page 33 → **50**, item recall 273 → **340 of 384**, confidently-correct items
> 77 → **123**, and the pages whose body map flips between the two renders drop **30 → 9**. On the JPEG render: unit 35 → 52
> (`eval-c/final.txt`, configuration P3).
> **The regression this merge would otherwise hide, stated plainly:** P3 takes `avoidAreas` wrong-and-**UN**flagged from
> **4 → 9** on `sim-1610` and **2 → 8** on the JPEG render, while avoid item recall is unchanged (11/30 before and after) — the
> avoid gain is entirely the removal of false crosses, and the cost is silent misses. It is threshold-driven, not incidental
> (`exp_prod.txt` S1/S1b/S1c give 9/11/10). "Unflagged body-map errors unchanged at 2" was **only** true after merging the lists,
> and is dropped. **W2b and W2d do not ship until the `possibleMissedMark` carrier of W2f exists and the per-list avoid figure
> has been re-measured on the archived production PNGs (G0), against production's own baseline of preferred W&U 3, avoid W&U 1,
> unit W&U 0.**
> **Cost:** ~3 days; deterministic time 91 → 103 ms/page median, max 152 → 174 ms (against ~52 000 ms of model time); 0 calls.
> **Explicitly rejected:** the blanket "struck row ⇒ empty, unflagged" rule. Population: **43 struck oil pages, 35 confirmed
> empty, 8 non-empty** (`visual/out_struck_crop.txt`). The blanket rule clears all 43 flags and is wrong on those **8 pages**;
> under this plan's page-level list scorer that shows up as **2 wrong-and-unflagged pages** (`final.txt` P1/P4) because the other
> 6 differ from the label in ways the set comparison already counted. Both numbers are real; the 8 is the safety-relevant one.
> See W5b for the safe version.

### W3 — Learning store, and switching off the one that exists (app + `local-ai/`)
W3a **Stop the bleeding.** Make `POST /v1/ocr/confirm` audit-only so `verified_match` can no longer serve anything
(`api.py:610`, `ocr_normalize.py:121`), and fix `document-view.ts:305,362` so a flagged-but-unedited suggestion is weight 0.
W3b Migration `0019_learned_values` (with the RLS, policies, grants and foreign keys of §2.3) +
`packages/ocr-persistence/src/learning.ts`; `saveReview` (`index.ts:839-880`) writes votes in the same transaction — **but the
vote writer refuses the auto-auth subject id, so nothing is written until Release 2 deletes `OCR_WEB_AUTO_AUTH`** (§2.5.9);
widen `ReviewChange.provider` from `treatment|therapist` to a learning descriptor covering `hotelName`, `nationality`,
`roomNo`, `treatment`, `therapistName` (`document-view.ts:13-14,291-371`).
W3c `local-ai/ocr_learned.py` (reusing `_FileCache`, `_key`, `_best`, `_skeleton`) + `PUT/GET /v1/learned`;
`publishLearnedSnapshot` in the worker maintenance loop.
W3d Wire the kinds: room validation (`normalize_room`), hotel dictionary (new `normalize_hotel`), nationality aliases merged into
the master alias list at load time, treatment/therapist aliases **after** the master lookup and never before it.
W3e Admin API + workbench "Learned values" page (§2.6); `evidence.learned` in the response.
W3f Outbox hygiene: hours-long backoff instead of ~30 s, automatic re-drive of DEAD rows, and update
`ocr_corrections.confirm_status` / `documents.confirm_status` on delivery (they stay PENDING forever today).

> **Target:** therapist wrong-and-unflagged **8 → 0** and treatments **6 → 5** per 95 pages (the avoided regression is the gain);
> room W&U **1 → 0**; junk-row exposure **28 items → 0**; confirmations lost to a Local AI restart **→ 0**.
> **Hotel: +0 on this set, and that is the honest number.** Under the ≥ 2-vote regime of §2.4/§2.8 the dictionary gives 73 —
> the baseline — at every threshold tried. The +2 that appears at *one* vote (73 → 75) is not available under the promotion
> rules this plan commits to. Applied on top of W1's parser output rather than on the raw baseline, one vote is worth
> **+2 [pages 59, 82] −1 [page 53], net 76 → 77 exact-string** (`text-fields/out_sim_lists.txt`) — note the **−1: the
> dictionary overwrote a hotel W1 had already read correctly**, which is why W1's "0 regressions" does not extend to W3.
> (`out_sim_hotel.txt`'s "+2/−0" scores by hotel *identity class*, not by the exact string the tables in this plan use.)
> **Steady-state dictionary hit rate ≈ 56 % for hotels** (Good–Turing, `out_dict_growth.txt`), not 90 %: the 75→99 % projection
> in the same file resamples whole pages *with replacement from the 95 observed pages* (`dict_growth.py:57-70`), so its
> vocabulary is closed and it converges to 100 % by construction. Read it as the upper bound for a closed vocabulary; ~44 % of
> the next hotel readings will be values never seen before. Room 99 %, treatment 98 %, nationality 73 % by the same estimator.
> **Cost:** ~1–1.5 weeks; 0 model calls; ≤ 4 fuzzy lookups/page. `_best` measures 2.1 ms at 50 entries, 9.6 ms at 200 and 42 ms
> at 1 000, so **4 lookups against the 2 000-entry cap would be ~300 ms/page — twice G4's budget**. The prefilter (exact key,
> length band, first two characters) is what is supposed to prevent that and it has **not been measured**: measuring `_best`
> with the prefilter at the cap is a W3 exit condition, and until it passes the cap stays at 500 entries per kind per branch.

### W4 — Model-side free levers (`local-ai/`, 0 extra calls, but each needs a model run)
W4a **Prompt hints.** Turn the hard-coded `STAFF_VOCAB` (`ocr_model.py:87-90`) into a builder over master data: add an
oil-look-alike hint (the largest single error class, 26 pages) and, once the roster exists, the branch roster in place of "a short
Thai nickname". Precedent, with the parser held constant and the **identical** STAFF crop: `STAFF_PROMPT` → `STAFF_VOCAB_PROMPT`
took treatment names **9 → 17 of 32** shared pages and Thai characters read 233 → 454, therapist lines with Thai script 21 → 30
(`model-side/out_model_side.txt`). Prompt text is bounded at +3.1 s/page for 150 tokens.
W4b **Conditional wide STAFF crop.** `STAFF_CROP = (410,485,710,570)`; ≥ 35 px of pen ink right of x = 710 on the treatment row on
**9/95 pages**, 5 of which have a wrong written total. Widen to x = 797 only on those pages (the ink mask already exists at
`api.py:466`); the printed logo words are already stripped (`ocr_normalize.py:189`).
W4c **Lift the caps we impose on ourselves.** `_Crops.rows` (`api.py:236-243`) caps a crop at 2 × reference width, `_stack`
(`api.py:255-262`) pads narrower parts with white, and `_render_scale` (`api.py:90-95`) caps any render at 1610 px. Measured with
the model stubbed at three source resolutions: at 3470 px (≈ 300 dpi) the staff crop is **downsampled 2.15×** by our own code, and
the customer rows would fall from 100 % to **54 %** of the stacked canvas — i.e. a scan-quality upgrade would make the customer
fields *worse*. Replace with an encoder-budget rule (`OCR_MODEL_IMAGE_TOKENS`, `OCR_PDF_RENDER_MAX_PX`). **No-op at 1400 and
1610 px by arithmetic — prove it with a byte-identical crop replay on all 95 pages before shipping.**
W4d **Decoding hygiene.** Ollama's default `repeat_penalty` is 1.1 and still shifts a greedy argmax — a known hazard for repeated
digits and repeated duration units. Ship a derived tag (`PARAMETER repeat_penalty 1.0`, `top_k 1`, `seed 0`) and point
`OCR_MODEL` at it: no code change, pinned digest, one env var to revert. Raise `top_logprobs` to 5 behind `OCR_EVAL_DUMP_TOKENS`
(free — the distribution is computed anyway).

> **Target: unmeasured, and deliberately not booked.** The oil-look-alike hint is the largest single error class (26 pages) and
> the STAFF_VOCAB precedent is real, but **nothing in `eval-c` measures this hint**; R2 (§6) is what produces a number. Score it
> against the right baseline: after W1a–e (49), W1f (+3 → 52) and §4's label hygiene (+4 → 56), so "≥ 53" is *below* where the
> zero-call work already lands and must not be quoted as a gain. **Written total 19 → ≤ 24 of 31** (wide crop, W4b) and 2.15×
> more real stroke detail per character at 300 dpi (cap lift, prerequisite for W8) stand as stated.
> **The therapist Thai-script projection is withdrawn.** "84 → ≈ 94 of 95" was the v3.2 subset figure (30 of 32 shared pages,
> `out_model_side.txt`) re-presented as a future page count — but that row **is the prompt already in production**
> (`ocr_model.py:87-90`), and production today already returns Thai script in the therapist field on **84/95 pages**. Any
> therapist gain must come from the roster (W8a), measured by a probe of the roster prompt, not from this table.
> **Cost:** ~3 days of code; **3–5 model runs** (§6). Page runtime unchanged (≤ 54.8 s worst case with the roster).
> **Explicitly rejected:** giving the customer rows their own call. Measured *worse* — name/nationality/hotel 11/22/24 (stacked)
> vs 10/18/22 (alone) on 33 shared pages — for +25.6 s/page.

### W5 — Visual second reader (`local-ai/ocr_visual.py`, 0 calls, ~5 ms/page)
A 128-float signature of a deterministically registered crop (0.49 ms each, 0.02 ms per lookup over 1 000 samples), harvested from
confirmed pages, used to **agree** (raise confidence) or **disagree** (flag; override for two fields only), never to invent a
value. All numbers leave-one-**page**-out.
W5a **Room digits**: segment glyph columns, **k-NN with ≥ 2 agreeing samples** at distance ≤ 0.10 (§2.2 kind E), abstain
otherwise. Full reading available on 12/95 pages, **12/12 correct** *on the same render the samples were harvested from*;
overrides the model on the 2 pages where they disagree (model wrong on both) — **room 73 → 75, fixed 2, broke 0**
(`visual/out_room_policy.txt`), override always flagged. Two numbers that belong next to that one:
* **Cross-render it is 10 of 11, not 12 of 12** (`visual/out_render_drift.txt`: store harvested at 1400 px, read at 1610 px,
  T = 0.10). The same glyph moves by median 0.020 / p90 0.063 / **max 0.360** between renders, against a 0.10 gate. Therefore
  **store `render_scale_px` with every sample and refuse a match whose sample render differs**, or re-harvest on a render change.
* The gate is one step from a regression: T = 0.12 already gives `broke = 1` and wrong-and-unflagged 2, and 0.10 was chosen on
  this same 95-page set. Keeping the override flagged is what stops a cross-render miss becoming silent.
W5b **Struck checkbox rows.** Population everywhere in this plan: **43 struck oil pages — 35 confirmed empty, 8 non-empty**;
health **16 — 14 empty, 2 non-empty** (`visual/out_struck_crop.txt`). A learned gate on the row-crop signature + the 3 box scores
scores p ≥ 0.80 on 11 of the 43 with 0 wrong among them, where the blanket rule clears all 43 and is wrong on the 8.
**Unflagging on that basis would violate invariant §2.5.1 and gate G6, and is not granted by default.** Default shipping form:
the probability **orders the review queue** and clears nothing. Auto-unflagging requires a *named, bounded exception* carrying
all of:
* a **held-out** acceptance, not leave-one-out — the saved model is 132 parameters (128 signature floats + 3 box scores + bias)
  fitted on 43 rows (`visual/struck_crop.py:37-47`), and a different feature set on the same data already shows 2 silent errors
  at p ≥ 0.90 (`out_struck_clf.txt`), so "0 silent errors" is not a property of the approach;
* a **minimum negative count per branch** — with 8 negatives, 0/8 bounds the miss rate only at roughly 31 % (rule of three), so
  hold oil at ~60 negatives exactly as health is already held;
* training on **confirmations**, which is what production has, where the experiment trained on ground-truth labels
  (`struck_crop.py:38` reads the label set), plus a refit rule for when confirmations are later overturned;
* an admin on/off switch equivalent to `APPROVED`, and the G6 exemption written down in §4 rather than implied here.
Health clears 0 at every threshold today — leave it flagged.
W5c **Body-map mark classifier** (phase 2, after W2): a 3-class softmax on the features `detect_body_marks` already computes,
LOO 296 → **310 of 377**, circle-read-as-cross **43 → 3**, pages with a mis-shaped real mark 28 → 21, one full refit ≈ 45 ms.
The saved run is unweighted and under-detects real crosses (2 of 19), so ship it only with class weights re-measured and only
where it agrees with W2's rule; where they disagree, keep the flag.

> **Target:** room 74 → **75** with W1 — *not 76*: W5a's two override pages are 11 and 12, and **page 11 is also W1's single
> room fix**, so the union of the two changes is two pages, not three (measured, `eval-c/fix/room_overlap.py`). Oil review load
> falls only if W5b's exception above is granted; by default the flag rate is unchanged and the queue is merely better ordered.
> Body-map shape errors down a further ~30 items once W5c is weighted and validated.
> **Cost:** ~1 week + the store of W3; +4–6 ms/page; 0 model calls. Requires `branch` and `tenantId` on the OCR request.
> **Explicitly rejected:** whole-room-box NN without segmentation (top-1 26–29/95, breaks 22–51 pages) and treatment-word NN
> (AUC 0.597 against a 0.55 base rate — chance; Thai has no inter-word spaces, so blob segmentation does not isolate words).

### W6 — Review-threshold calibration (config + a guardrailed job)
Ship **two downward moves, clamped**: `OCR_MODEL_CONFIDENCE_NATIONALITY` 0.85 → **0.80** and `..._DATE` 0.90 → **0.85**, and let
the recalibration job walk them further on held-out evidence. What the experiment actually measured, stated precisely: the
*all-data argmin* is 0.50 for nationality (R&F 6 → 4) and 0.75 for date (R&F 19 → 16), both at 0 wrong-and-unflagged **on the
95 pages they were fitted on**. There is **no out-of-sample evidence for those two values.** The LOO and odd/even columns of
`dict-calib/out_calib_cv.txt` score the refit *procedure*, not the fixed numbers, and for date that procedure already shows a
silent error (`date … fit_t(all) 0.75 | LOO W&U 1 … | oddeven W&U 1`); across all six fields the procedure gives LOO 8 W&U /
121 R&F and odd/even 12 / 106 against a baseline of 10 / 102. `out_calib_sweep.txt`'s learning curve adds that fitting on the
first 20 pages makes things **worse** (W&U 8 → 10). Moves of −0.35 and −0.15 fitted on 95 documents, with only 14 wrong
nationality pages behind the larger one, break this plan's own §8.6 rule (≥ 200 confirmed documents, held-out improvement,
±0.05 per release) — so they are clamped to ±0.05 now.
Everything else waits for the recalibration job: ≥ 200 confirmed documents containing the field and ≥ 50 wrong, fit on the older
70 % by document time, accept only if the held-out cost improves, clamp each move to ±0.05 per release, and record
`acceptedBecause` in the calibration file. **The full refit on 95 pages looks like W&U 10 → 3 but is 10 → 8 leave-one-out and 12 — worse than the shipped thresholds —
on an odd/even split** (`dict-calib/out_calib_cv.txt`). Therapist is excluded until the roster lands.

> **Target:** the clamped pair is worth ~0–2 fewer right-but-flagged pages, 0 new silent errors; the −5 figure belongs to the
> unclamped argmin and is not booked. **Cost:** config change + ~2 days for the job; 0 calls.

### W7 — Gated room re-read (+2.4 s/page)
The gate "room value contains no digit" fires on **9/95 pages, all 9 wrong** (`model-side/out_model_side.txt`; pages
3, 11, 12, 27, 75, 81, 83, 90, 93, reproduced independently). That is the measured part — **precision 9/9. The yield is not
measured at all:** no experiment in `eval-c` ever put a room-only crop through the model. A room-only crop (~40 × 20 ref px)
still costs the same ~1,070 image tokens, so the encoder grids it at ~16× the linear magnification the digits get inside the
596 × 168 staff crop. **The analogy to treatment names does not transfer and should not be quoted as if it did:** in
`out_model_side.txt` every treatment-name figure improves with a dedicated staff crop (9 → 17, and 1 → 17 against the customer
crop) while room is **flat or worse** — 25/32 with the v3.0 staff crop, 25/32 with the v3.2 staff crop, but **28/32 with the
*larger combined* image** — and `out_probe_prompts.txt` repeats the pattern (staff-alone 13–14/16, combined 13/16). Magnifying
the room may help; the only evidence available says bigger context helped it more.
Hard cap: **one** gated re-read per page on top of the existing ≤ 2 fallbacks, and the re-read never clears a flag on its own.
**Raise `OCR_REQUEST_TIMEOUT` from the production 120 s to ≥ 300 s first** (a 4-call page is ~103 s).

> **Target: unknown.** The ceiling after W1 and W5a is **75 → 82**: W1 fixes page 11 (which then leaves the gate, since its value
> gains digits) and W5a fixes 11 and 12 — **both W5a override pages are inside the gate set** (measured,
> `eval-c/fix/room_overlap.py`) — leaving **7 gate pages** (3, 27, 75, 81, 83, 90, 93) for the re-read. 82 is what a 7/7 re-read
> would give and nothing suggests 7/7 is achievable.
> **Sequence:** R5 is a **9-page probe** first (~4 min of the single slot, §6), not a full 86-min batch. Commit the
> 86 min/batch only if the probe fixes enough of the 7 to be worth 2.4 s on every page.
> **Cost if committed:** 82 → 86 min per 95-page batch (1.16 → 1.11 pages/min).
> **Deferred:** the treatment gate (fires 34/95, 100 % precision, but +9.2 s/page → 96 min/batch for a measured +4/87 pages with
> the weakest possible re-read). Revisit only if the image-first cache probe (§6) makes a re-ask cost ~2 s instead of 25.6 s.

### W8 — Client-blocked and long-term
W8a **Therapist roster per branch** (§5). Replaces the 10 seeds, re-validates every `therapistAlias` (an alias whose value is not
on the roster is auto-`BLOCKED`), unlocks the roster-in-prompt of W4a. Projected top-1 6 → **28–35 of 87** single-name pages,
top-3 44–54 — but therapist labels must be redone against the roster before any accuracy is claimed.
W8b **300 dpi scans** from the client — the only lever that adds information rather than re-using it. Useless before W4c.
W8c **LoRA on STAFF crops**, gated by a cheap step 0: convert the *unmodified* base to GGUF + mmproj, quantise Q4_K_M and
reproduce today's 95-page numbers. If that fails, the whole path is blocked for ~20 min of CPU and one eval run. Targets ~45
treatment page-errors + ~21 room errors: the staff side is a small stable set of the spa's own writers over a closed vocabulary,
which is the LoRA setting; customer names are a different tourist every page and are **not** a LoRA target. Needs ≥ 300 confirmed
staff crops (1 000–2 000 comfortable), an off-host GPU (USD 2–10 per run, USD 100–400 for a programme), a DPA, and
`OLLAMA_MAX_LOADED_MODELS ≥ 2` so the staff tag and the stock tag both stay resident.

### Projected end state on the 95-page set
| Field | Today | After W1–W3 (0 calls) | + W4–W7 | Blocked on the client |
|---|---|---|---|---|
| Customer name | 41 | 51 | 51 | 300 dpi (W8b) |
| Nationality | 81 | 90 | 90 | — |
| Hotel | 73 (W&U 1) | **76** (W&U 0) — W1 only; W3 adds +0 under the ≥2-vote rule | 76 | — |
| Room | 73 (W&U 1) | 74 (W&U 0) | **75** with W5a; W7 ceiling 82, yield unmeasured | — |
| Treatment names | 46 | **52** (W1a–e 49 + W1f 3); 56 under the corrected hot-oil convention | W4a unmeasured — see §6 R2 | — |
| Body map (one unit) | **35 (W&U 0)**, production | **not yet measured on production inputs** — `sim-1610` says 50, G0 decides | same | form labels for 4 items (§5) |
| Oil / scrub | **91** value-exact, 55.8 % flagged | 91, 55.8 % flagged (queue re-ordered, no flags cleared) | same | — |
| Therapist | 6 | 6 | 6 | **roster (W8a)** |
| Silent errors, all model-read text fields | 10 | ≤ 8 | ≤ 8 | — |

The row this table can no longer state is the body map: its "after" figures exist only on the `sim-1610` render, and W2's
per-list avoid regression (4 → 9 there) has to be re-measured on the archived production PNGs before any of them is a target.

---

## 4. Benchmark and gates

**One scorer — SHIPPED 2026-09-23 as `local-ai/tools/` (`replay.py`, `scoring.py`, `benchmark.py`).** It replaces `compare.py`
and `calibrate.py` (code only — labels, page images and raw responses stay in the operator scratch dir, given on the command
line with `--data`, never in git). It scores list fields by **value set**, with markers counted as review cost and not as
items; puts both sides of nationality through `normalize_nationality`; scores and flags the body map **as one unit** and reports
each list separately as well; counts every **miss** at item level, where a miss is an unflagged error unless the group carries an
explicit "possible missed mark" flag (G1b — v3.2 has no such carrier, so today every miss is silent); and reports
`n / right / right-flagged / wrong-flagged / wrong-unflagged` per field, marking the pages whose label is uncertain. Its output is
counts, page numbers, field names and error categories only, so a run can be pasted into a report or a commit unedited.

**Replay, not re-run — SHIPPED.** `local-ai/tools/replay.py` rebuilds the v3.2 values by calling the service's own functions
(`api._customer_text_fields`, `N.header_fields`, `N.parse_treatments`, `N.normalize_therapist`, `N.normalize_room`) and re-applies
the token gate from the stored `evidence.tokenConfidence`. With the code unchanged it reproduces **95/95 pages exactly on
`value`, `raw` and `needsReview`**; 91/95 also on `source` and `confidence`, the four exceptions (pages 26-29) being treatment
items production served from the `verified-memory` hook, which the stored response does not carry and W3a removes. Two limits
that are properties of the method, not bugs: the **image-derived fields are copied through** from the stored response (no page
pixels offline, so no checkbox or body-map *change* is scorable here — G0 stands), and the gate is replayed from the stored
per-field statistics, which describe the field's exact `raw` string, so a variant that changes a `raw` gets an explicit
`staleGate` warning instead of an unbacked flag. Round-trip tests on synthetic pages (`tests/test_benchmark_replay.py`) hold the
replay to `api.process_image` in both section modes. Consequence: W1, W2, W3, W5 and W6 are scored with **zero model calls**, and
any future parser, dictionary or threshold change is scored the same way on every reviewed document.

**Freeze the inputs — do this first, before any body-map work.** Archive the exact page PNGs the Local AI received (they are in
`OCR_UPLOAD_DIR`, `api.py:588-592`, or re-split the source PDF with the deployed worker) with a `sha256` manifest and point the
deterministic eval at those instead of `pages/*.jpg`. Production ran 1610 px renders while the eval reads 1400 px JPEGs, and that
alone moves the body map on 30/95 pages. Neither offline render is a usable stand-in: against production's own answers the
1610 px upsample agrees on preferred 49/95 and avoid 60/95, the plain JPEG on 56/95 and 67/95, and the body-map evidence is
identical on 12/95 and 11/95 pages. Until the archived PNGs exist, **every W2 figure is labelled `sim-1610` and none of them is
a release target.**

**The frozen baseline is `local-ai/tools/baseline-v3.2-prod-95.txt`** (committed 2026-09-23, counts and page numbers only).
`benchmark.py --baseline <that file>` checks **G1, G1b, G2, G3 and G6** and exits non-zero on a failure; **G0, G4, G5 and G7
cannot be computed from stored answers** and the tool says so on every run rather than silently omitting them. The G1 numbers
below are superseded where the frozen file differs — the file is the baseline, this paragraph is the explanation.

**Gates — every change, both sources (1400 px and 1610 px):**
* **G0 frozen inputs (blocking, precedes G1–G7):** the archived production PNGs exist with a `sha256` manifest and the
  deterministic eval runs on them. No body-map or checkbox change ships against a simulated render.
* **G1 safety (blocking):** total wrong-and-**unflagged** must not rise, and no field may rise above its **production** frozen
  baseline, measured on `results-prod`: hotel 1, room 1, **treatment 2** (names and names+durations alike, pages 23 and 88 —
  "5" was not reproducible), name 3, nationality 0, date 0, **body map preferred 3, avoid 1, and 0 as one unit**. The earlier "body map 2 as one unit" was the simulated render's figure; production's is **0**,
  and freezing the higher number would have silently authorised two new silent errors. The per-list numbers are frozen
  **as well as** the unit number, because W2's measured regression is per-list (avoid 4 → 9 on `sim-1610`) and the merge hides
  it. **0 new unflagged errors** is the release condition, not a target.
* **G1b misses (blocking, separate):** §4's scorer counts a **miss** as an unflagged error unless the group carries
  `possibleMissedMark`. That redefinition changes the body-map baseline by an order of magnitude (production item recall is
  272/384 preferred and 14/30 avoid — about 112 + 16 missed items against a page-level W&U of 0), so misses are gated here on
  their own **recall** baseline and are deliberately **not** folded into G1's page counts, which would otherwise be
  incomputable.
* **G2 accuracy:** paired page-flip accounting; every flip named. A deterministic change must explain **all** of them.
* **G3 review budget:** right-but-flagged may rise by at most +5 per field unless wrong-and-unflagged falls. Room validation
  (12 → **21** at ≥ 1 vote, or 12 → 31 at ≥ 2 — both remove the same one silent error, see §8.3) and the body-map work are the
  two pre-agreed exceptions; they need the decision in §8.
* **G4 runtime:** deterministic **median ≤ 120 ms/page and max ≤ 200 ms/page**, model-stubbed — a single "≤ 150 ms" figure is
  not computable against a baseline whose max is already 152 ms and whose W2 configuration peaks at 174 ms (`final.txt`,
  `base`/`P3 source=prod`). Includes the learned-lookup budget: `_best` with its prefilter, measured at the entry cap (W3).
  Model runs ≤ baseline calls/page × 26 s.
* **G5 render stability:** checkbox and body-map value sets must agree across the 1400/1610 render pair at least as well as the
  baseline (today 30/95 differ; W2 target ≤ 9/95).
* **G6 learning:** the page-ordered replay must be deterministic across two runs; no threshold moves without a held-out
  improvement recorded in `acceptedBecause` and no move larger than ±0.05 per release; no learned entry clears a flag unless
  `APPROVED`. **The only admissible exception is W5b, and only when every condition listed there is met and written into this
  gate as a named exemption** — otherwise a learned probability may reorder the review queue and nothing more. Kind E overrides
  are re-measured on **both** renders before every release (W5a).
* **G7 inertness:** W4c must produce byte-identical crops on all 95 pages at 1400 and 1610 px.

**Label hygiene** (1 hour, and it changes the headline): canonicalise the hot-oil naming (labelled as plain oil on 6 pages and as
hot oil on 3 — worth +4 treatment-name pages), decide whether derived durations are filled in, record labeller uncertainty per
body-map item, add the missing treatment master entry for one page's label, and re-check the one page whose treatment label looks
wrong on visual inspection. Report certain and uncertain labels separately — therapist is uncertain on 91/95 and name on 25/95.

---

## 5. What needs the client's official master lists

| Needed from the client | Blocks | Consequence today |
|---|---|---|
| **Therapist roster per branch** (replacing the 10 seeds) | W8a, W4a's roster-in-prompt, all therapist learning, therapist calibration | therapist is 6/95 and 95/95 flagged; exact memory gets 1 of 13 hits right; labels uncertain on 91/95, so the field **cannot be scored at all** |
| **Treatment and allowed-duration list per branch** | kind-C duration validation, the enum for any constrained re-read | `_allowed_durations` covers 6 of 12 treatments; one page's labelled treatment is not in the master |
| **Room list per branch** | seeds kind C on day 1 instead of learning it over ~40 pages | 16 distinct rooms, 99 % reuse — the list is small and stable |
| **Whether "struck oil row" always means "nothing selected"** | the deterministic version of W5b | **35 of 43** struck oil pages say yes, 8 do not (health: 14 of 16, 2 do not) — ask the client with that ratio, not a narrower one |
| **Form change: labels for 3 body areas that customers cross but the form does not print** | 4 avoid items that are undetectable by design | only 14 printed areas exist |
| **300 dpi scans** | W8b | native pages are 1400 px ≈ 121 dpi |
| **Consent / DPA for training data** | W8c, and seeding the visual store from the 95 labelled pages | without the seed, each branch restarts the visual learning curve from zero (5 donor pages give 1.6 fully-read room pages vs 12 at 70) |

---

## 6. Model runs on the eval container, and their CPU time

**Nothing in W1, W2, W3, W5 or W6 needs a model run.** They are scored by replay on stored answers. Model time is spent only on
W4, W7 and W8c.

| Run | Purpose | CPU time |
|---|---|---|
| 16-page probe, 1 call/page | screen a prompt or decoding variant | **6.8 min** |
| 95-page full run, 2 calls/page | any accepted variant, paired against the baseline | **82 min**, blocks the single Ollama slot |
| R0 instrumentation (no accuracy change) | capture `usage.prompt_tokens`, real per-call service time, `evidence.model`/`promptId`/`masterVersion`, `top_logprobs: 5` | 1 probe |
| R1 **image-first probe** | does llama-server's prefix cache serve a second question on the same image in ~2 s instead of 25.6 s? | 1 probe — **highest-value single experiment in this plan**; it decides whether per-field re-reads cost 25 s or 2 s |
| R2 W4a oil hint | probe, then full | 6.8 min + 82 min |
| R3 W4b+W4c crops | full (after the G7 inertness proof) | 82 min |
| R4 W4d decoding tag | probe, then full | 6.8 min + 82 min |
| R5a W7 room gate | **probe on the 9 gate pages only**, one room-only call each — decides whether W7 exists | **~4 min** |
| R5b W7 room gate | full, only if R5a fixes enough of the 7 post-W1/W5a gate pages | ~86 min |
| R6 W8c step 0 | base → GGUF → Q4_K_M round-trip, reproduce today's numbers | ~20 min CPU conversion + 82 min |

Protocol: same image digest as production, separate port, `OCR_VERIFIED_FILE` pointing at an empty file, `OCR_UPLOAD_DIR` in
scratch, Ollama version and model digest recorded, frozen PNG set, **off-hours** (a full run halves production throughput),
one pass per variant, first-sight timings only (repeats hit the prompt cache at 1.7–2.4 s). Single-run probe variance is ±3 of 16:
a variant must beat the baseline by more than that to earn a full run. Raw responses are copied to the operator scratch dir only.

---

## 7. Fit with Release 2 and Release 3

**Release 2 (login + export) — runs in parallel; two hard couplings.**
1. *Learning needs attributed confirmations — and, before that, authenticated ones* (§2.5.9, §2.8). **The vote ledger does not
   start until Release 2 deletes `OCR_WEB_AUTO_AUTH`**; the day it does, votes begin *and* `requireDistinctUsers` flips on, and
   kinds A/B start promoting. Until then the only learning that may affect a value is kind C (room validation, which can never
   change a value) and the W3a shutdown of the old hook. This is the single regime; §8.2 states the same rule and its price.
   Release 2's **`ADMIN` role** (`release2-plan.md:477,494,509`) is a hard dependency of W3e: `BLOCKED` is the anti-poisoning
   lever and `APPROVED` is the only flag-clearing lever, and `packages/auth` has no role concept today, so the learned-values
   page ships read-only until that role exists.
2. *Export carries the audit.* The export already has to show the original file name and page position; add `confirmed_by`,
   `confirmed_at` and a per-row flagged-field count so the client can sample-audit what was learned from whom. The same columns
   make the export the natural source for the weekly "what did the system learn" report.
   Release 2 also carries two carried-over items this plan depends on: **`OCR_REQUEST_TIMEOUT` must go from the production 120 s
   to ≥ 300 s** (required before W7), and the batch-strip clock fix.

**Release 3 (other formats) — this plan is what makes it affordable, and it constrains it.**
* Everything in W1 (parser shapes, label-anywhere, no-letter values) is **format-independent** and carries straight over.
* Everything in W2 and W5 is **template-specific**: `ocr_layout` boxes, mark thresholds and visual signatures are keyed to the
  fitted geometry of *this* form. Learned entries therefore carry `engine_version` + `master_version` today and must gain a
  `form_template` scope before a second template exists, or one form's learning will leak into another's.
* The benchmark must gain a per-template label set; the `known / uncertain / unknown` verdict already exists to route a page.
* The learning store is the right shape for Release 3 precisely because it is per-tenant, per-branch and versioned: a new format
  starts with an empty store and a cold curve, not with a poisoned global one.

---

## 8. Open decisions (recommended defaults)

1. **May a learned entry ever clear a review flag?** *Default: no* — a learned value is always a flagged suggestion; only an
   admin-`APPROVED` entry (score ≥ 0.95, ≥ 2 votes) may clear one. Overriding the token flag clears 7–9 flags per 95 pages and
   adds **+2 to +3** silent errors (W&U 2 → 4, or 2 → 5 under P3), and today's always-clear behaviour costs 8 silent therapist
   errors per 95 pages. W5b's auto-unflagging is the one exception on the table and is **not** granted by this default.
2. **Promotion threshold, and must votes come from different users?** *Default: **≥ 2 distinct reviewers for kinds A/B from the
   first vote onwards**, because there are no votes before login (§2.5.9 — the pre-login write path is open, so a pre-login
   ledger would be unattributable as well as unattributed).* The price is stated rather than hidden: at 95 pages a ≥ 2-vote
   hotel rule gives **73 right, the baseline — hotel learning is worth +0 on this set** (`out_sim_dict.txt`, all four
   thresholds); the +2 exists only at one vote per document. The hotel dictionary therefore ships **dark**, justified by the
   Good–Turing growth argument (~56 % steady-state reuse), and `minVotes: hotel 1` in §2.4 counts distinct *documents* inside
   the ≥ 2-reviewer rule, never instead of it. *Alternative, if the client wants the +2 now:* an explicit one-vote-per-document
   rule for kind A only, which needs the authenticated write path either way. Pick one — the plan may not carry both.
3. **Accept the review-load increase?** Room validation removes the one silent room error at **≥ 1 vote for right-but-flagged
   12 → 21**, or at ≥ 2 votes for 12 → 31 — *the same* W&U 1 → 0 either way (`out_sim_dict.txt`). *Default: ask for the
   12 → 21 version*: kind C can never change a value (§2.2), so a poisoned room entry costs review load only, never a silent
   error, and there is no measured reason to pay 10 extra flagged pages for a second vote. (≥ 3 votes puts W&U back to 1.) The
   body-map work raises the preferred flag rate slightly. Accept with a per-field budget (G3) that a release may not exceed —
   every page is already opened for review because therapist is flagged 95/95, so this is extra fields to glance at, not extra
   pages to open.
4. **Ship the figure-ink change (W2d)?** It costs 3–4 exactly-right *preferred* pages but gains +67 recovered items, +4 avoid
   pages, and cuts render sensitivity 30 → 9 of 95. *Default: yes* — the body map is scored and flagged as one unit (W2f), where it
   is a clear win, and render stability is worth more than a per-list page count.
5. **Where does the learning store live?** *Default: the app DB, with versioned snapshots PUT to the Local AI, and
   `corrections.jsonl` demoted to audit.* Votes, branch scope, conflict detection, undo, de-duplication and version invalidation
   are all impossible in the current 6-field append-only row.
6. **When may recalibration move a threshold?** *Default: never automatically below 200 confirmed documents for that field, only on
   a held-out improvement, clamped to ±0.05 per release, with the evidence written into the calibration file* — **and the two
   W6 moves obey the same rule**: 0.85 → 0.80 for nationality and 0.90 → 0.85 for date, not the all-data argmin of 0.50 and 0.75
   that has no out-of-sample support (W6).
7. **Authentication for the learning transport.** *Default: a shared secret on **every** Local AI write route — `PUT /v1/learned`,
   `POST /v1/ocr` and `POST /v1/ocr/confirm` until W3a disables it — plus a gateway allow-list, **verified on the host before
   W3 starts**.* "Private network only" is not available: `OCR_API_BASE_URL` is a public gateway URL between two VPS
   (`deploy/docker-compose.yml:38,68`), `api.py:573,610` have no auth and `OcrClient` sends only a content-type header. The app
   side is the same problem: `GET /api/web-token` answers before any authentication (`server.ts:385-393`) and the web service is
   published publicly, so **no vote row may be written while `OCR_WEB_AUTO_AUTH` is set** (§2.5.9).
8. **Seed the visual store from the 95 hand-labelled pages?** *Default: yes for `roomNo` digits, with written client consent;
   **no** for health-condition and body-area samples until §2.7's corrected classification is agreed.* It is the difference
   between day-1 coverage of 12/95 room pages and 1.6/95 — and the seed must carry `render_scale_px`, because a store harvested
   at 1400 px and read at 1610 px drops to 10 correct of 11 readings (W5a).
9. **Do handwriting crops ever leave the host?** *Default: no for customer crops, ever; yes for STAFF crops only, under a signed
   DPA with delete-on-completion, and only when W8c step 0 has passed.* Learning itself is text-only; crops are a training-project
   decision, not a learning-loop one.
10. **Retention.** *Default: `ocr_learned_votes` deleted on the documents' 90-day clock **or when the entry they justify stops
    being `ACTIVE`/`APPROVED`, whichever is later** — otherwise §2.8's "retire that reviewer's session" remedy outlives its own
    evidence — aggregate counters kept; visual signatures 24 months, or 90 days for anything re-linkable to health or body-area
    data (§2.7), per-tenant and per-therapist deletable. `retention.md` gains rows for `corrections.jsonl`, its deploy backup
    copies (`local-ai/README.md:287`), the published learned snapshots and `OCR_UPLOAD_DIR`, and erasure is defined as a
    procedure over DB + snapshot + jsonl + backups.*
11. **Gated re-reads.** *Default: room gate only (9/95 pages, +2.4 s/page); treatment gate off* until the R1 image-first probe says
    what a re-ask really costs.
12. **Daily page volume.** Unknown, and it sets the calendar for everything learned: the dictionaries reach 90–95 % hit rates at
    250–500 confirmed pages, the LoRA needs ≥ 300 staff crops. Please supply it.

---

## 9. Sequencing

```
now      §4 scorer fix + replay harness                          DONE 2026-09-23 (§11), local-ai/tools/
         FROZEN INPUTS (G0), label hygiene                      0 calls ~1 d  ← still blocks every W2 measurement
         verify Local AI auth on the host (§2.5.9)                         0 calls ~0 d  ← precondition for W3
then     W1 parser/vocabulary (incl. W1f)                                  0 calls ~2 d  ← biggest measured gain per day
         W2 body-map/checkbox geometry, re-measured on the frozen PNGs;
            W2f's possibleMissedMark carrier ships BEFORE W2b/W2d          0 calls ~3 d
         W3a stop the bleeding (confirm audit-only, weight-0 rule)         0 calls ~1 d  ← must precede any new volume
         W3b-d learning store + snapshot, schema with RLS, outbox          0 calls ~1 w  (no votes written yet)
         W6 the two CLAMPED threshold moves (±0.05)                        config  ~0 d
parallel R0 instrumentation, R1 image-first probe                                  2 probes
         R5a W7 room-gate probe on 9 pages                                         ~4 min
         W4 prompt / crops / decoding                                              3-4 runs
         W5a room visual second reader (render-scale-keyed)                0 calls ~1 w
on login OCR_WEB_AUTO_AUTH deleted → the vote ledger STARTS; promotion enabled
         (≥2 distinct reviewers); W3e admin page becomes writable with the ADMIN
         role; export audit columns
on roster W8a therapist roster, alias re-validation, roster-in-prompt
later    W5b struck-row gate (queue ordering; unflagging only under the §4 G6
         exemption) · W7 room re-read if R5a justifies it · W5c weighted mark
         classifier · W8b 300 dpi · W8c LoRA step 0
```

---

## 10. Review record (adversarial review, 2026-09-23)

Two independent reviews (feasibility/measurement against the 95-page set; privacy/safety against `local-ai/`, the app and the
migrations) raised 20 findings. Checks were re-run before each change; new measurements are in
`eval-c/fix/{fidelity,unit,room_overlap,struck}.py`.

**Fixed**

1. §0's body-map rows were the *simulated* 1610 px render, under a "production v3.2" heading — restated from `results-prod`
   (preferred 38/54/3, avoid 55/39/1, unit 35/60/**0**), with a render caveat and a new blocking gate **G0**.
2. G1 froze "body map 2 as one unit", a number production never produced (it is 0) — G1 now carries production's per-list *and*
   unit baselines.
3. W2's merge hid a per-list regression: `avoidAreas` wrong-and-unflagged 4 → 9 (`sim-1610`) / 2 → 8 (JPEG) under P3 — stated,
   gated, and W2b/W2d held until the `possibleMissedMark` carrier exists (11/95 pages have no entry to carry a flag).
4. Hotel was double counted (W1 +3 and W3 +2 both against 73) — replaced by the measured joint figure, including the **−1**
   regression where the dictionary overwrote a correct hotel, and the identity-class vs exact-string scoring difference.
5. The promotion rule contradicted itself across §2.4/§2.8/§7/§8.2 — one regime now, stated in §2.4, with hotel learning's
   honest value on this set (**+0** at ≥ 2 votes) written into §8.2 and the end-state table.
6. W6 shipped the all-data argmin (−0.35, −0.15) against the plan's own ±0.05 / ≥ 200-document rule, and misread the LOO
   columns (they score the refit *procedure*; for date it shows a silent error) — clamped to 0.80 / 0.85 and restated.
7. W4a's "treatment names ≥ 53" was the label-hygiene gain and omitted W1f's +3; the therapist "84 → ≈ 94" reused the
   already-shipped prompt's subset figure — both withdrawn, baselines restated (52, then 56 under the corrected convention).
8. W7's "+6" had no measurement and its stated mechanism is contradicted by the only crop-magnification evidence (room is flat
   or worse with a dedicated crop) — gain marked unknown, ceiling recomputed to 75 → 82 over **7** gate pages after W1/W5a
   (both W5a override pages are inside the gate; page 11 is also W1's fix — newly measured), and R5 split into a 9-page probe.
9. W3's "~90 % hit rate" came from a closed-vocabulary bootstrap — replaced by the Good–Turing steady state (hotel ~56 %).
10. W5a's 12/12 is same-render; cross-render it is 10/11 — stated, and samples now carry `render_scale_px`.
11. Three different struck-oil populations (36 / 36-of-38 / 43) — unified to 43 (35 empty, 8 non-empty), and the two
    blanket-rule costs (8 wrong pages, of which 2 become page-level silent errors) reconciled.
12. The vote ledger would have been filled over an open write path (`/api/web-token` answers before authentication; the Local
    AI write routes have none; the transport is a public gateway, not a private network) — §2.5.9 rewritten, votes blocked
    while `OCR_WEB_AUTO_AUTH` is set, host verification made a W3 precondition.
13. W5b auto-unflagged from a learned classifier, violating invariant §2.5.1 and gate G6 — demoted to queue ordering, with a
    named, bounded exception (held-out acceptance, minimum negatives, confirmation-trained, admin switch) if it is ever wanted.
14. Kind E had no threshold, conflict rule, admin surface or undo — added to §2.2/§2.4/§2.6 and to G6.
15. Migration 0019 dropped the repo's RLS convention and `ocr_learned_votes` had no `organization_id` — SQL corrected with
    FKs, `ENABLE`+`FORCE` RLS, `app.current_org` policies and grants.
16. §2.7's "health data out of the store entirely" was falsified by §2.3's own `label`/`ref_bbox`/`src_document_id` (the
    reference geometry is a public constant) — schema and claim both corrected, sensitive-data classification stated.
17. Retention was missing for `corrections.jsonl`, its deploy backups, the snapshots and `OCR_UPLOAD_DIR`, while vote rows were
    deleted before the entries they justify — both directions fixed, erasure defined across every copy.
18. Invariant 5 said "tenant and branch, always" but only `branch` was added, and `_FileCache` holds one value per instance —
    `tenantId` added to all three routes, per-tenant snapshot paths and cache, fail-closed lookup.
19. The `ADMIN` role was never named as a dependency of the learned-values admin page — added to §7 and §2.6.
20. Smaller corrections: §2.5.1 "+1 to +2" → "+2 to +3" silent errors; §8.3 re-derived at ≥ 1 vote (12 → 21, same W&U 1 → 0);
    W1f's 0.60 stop labelled precautionary (0.50 measures +5/−0); G4 restated as median + max with the learned-lookup budget
    measured at the entry cap; misses gated separately as **G1b** so G1 stays computable.

**Rejected / partly rejected**

* *"§1E closes the A8-vs-`compare.py` question with the wrong evidence."* Rejected. §1E's resolution is correct and was
  verified independently (`eval-a/eval_det.py:35-37`: `LIST_GROUPS` is referral + health + oils only, body map scored
  separately). Its numbers were simply quoted from the JPEG render; §1E now gives production's 38/95 and 55/95 alongside and
  attributes the residual to the render. The mislabelled §0 baseline, which is the real defect, is fixed above.
* *"73 + 9 = 82 and 76 + 6 = 82 cannot both hold."* The arithmetic objection as phrased does not apply — the plan never
  claimed 73 + 9. The underlying point does: the ceiling had to be recomputed because page 11 is counted by W1 *and* by W5a,
  which also means the plan's "room 76 with W5a" was itself one page too high (now 75). Fixed under item 8.
* The learning-curve evidence for W6 is in `dict-calib/out_calib_sweep.txt`, not `out_calib_cv.txt` as cited; the substance
  (fitting on 20 pages makes it worse) is correct and is now quoted from the right file.

---

## 11. Step 1 — measurement harness built and baseline frozen (2026-09-23)

`local-ai/tools/{replay,scoring,benchmark}.py` + `local-ai/tools/baseline-v3.2-prod-95.txt` + `tests/test_benchmark_replay.py`
and `tests/test_benchmark_scoring.py` (24 tests, synthetic fixtures only). §9's first line ("§4 scorer fix, replay harness") is
done; **FROZEN INPUTS (G0) is not** — it needs the archived 1610 px PNGs and is still what blocks every W2 number.

What the corrected scorer changed, all measured on the 95 stored production answers with 0 model calls:

| Field | Reported 2026-09-22 | Corrected | Why |
|---|---|---|---|
| Oil / scrub | 56/95 (the "59 %" row) | **91/95** | the struck-out marker is review cost, not a selected item (§1E) |
| Health conditions | 77/95 (the "81 %" row) | **91/95** | same marker artefact, 14 pages |
| Nationality | 81/95 | **83/95** | the old key was asymmetric and failed 2 character-identical readings (§1E) |
| Body map, one unit | 35/95 pages | 35/95 pages, **286 of 414 items** | page-level scoring cannot see a miss; G1b now gates recall |
| Written total | 19/31 | 19/31, **all 12 errors unflaggable** | `staffOnly.totalMinutes` has no `needsReview` carrier |

Everything else in §0 reproduced exactly: form number 95, gender 94, referral 94, pressure 90, date 84, hotel 73 (W&U 1),
room 73 (W&U 1), name 41 (W&U 3), treatment names 46 (W&U 2), treatments+durations 42 (W&U 2), body map preferred 38 (W&U 3),
avoid 55 (W&U 1), unit 35 (W&U 0), therapist 6.

Three things the harness proved about itself, because a benchmark nobody has checked is not evidence:

1. **The replay is faithful.** Code unchanged, it reproduces `value`, `raw` and `needsReview` on **95/95** pages. The only
   divergences are `source` on 4 pages and `confidence` on 2 (pages 26-29), all of them treatment items production served from
   the `verified-memory` hook of §2.1 — state that lives in `corrections.jsonl`, not in the response. That is §1D's "in
   production 4 of 4 real hits (p026-p029)", found independently, and W3a removes it.
2. **The gates fire.** Scored against a different stored run the harness reports G1 failures, G1b recall losses and the named
   page flips of G2; it also warns when the page counts differ, so a baseline from another page set cannot be read as a verdict.
3. **It is deterministic** across two runs (G6), and it refuses to pretend about the gates it cannot compute: G0, G4, G5 and G7
   are printed as NOT MEASURABLE with the reason, on every run.

One rule the harness now enforces and the old scripts did not: **the scorer uses the reader's own normalisers and never carries
an alias the reader lacks.** The old `natkey` hard-coded two country codes the master list is missing, which would have made
W1c's master-list fix score as +0 while genuinely improving the product.
