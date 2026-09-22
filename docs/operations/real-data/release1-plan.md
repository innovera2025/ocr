# Release 1 — real-scan accuracy (Local AI v3.1) + multi-page PDF split

Approved by the user 2026-09-22 (order 1 → 2 → 3; Release 2 = user login + export, Release 3 = other formats).
Production deploy of this release needs a separate approval. Inputs: `design-2026-09-22.md` (§1, §4.1, §4.4),
`scan-variation-2026-09-22.md`, `baseline-accuracy-2026-09-22.md`. Branch `feature/real-data-release1` (from main `32e75e4`).

Real-data facts that drive this release: 95 real pages = one form, clean scans, ~0.7 % smaller than the calibration
sample after resizing, rotation −0.4…+0.1°; v3.0 crops land on the wrong region and counts box borders as ticks
(treatments 3 %, therapist 12 %, name 30 % correct). ~45 therapist names at SUKHUMVIT 33; services not in the masters
(ประคบ, ยาหม่อง, สครับ, ออยร้อน, หินร้อน, หัวอินเดีย); totals ("ไทย + เท้า 30 = 90"), guest counts ("4 ไทย 1 ชม."),
two therapists ("อิน / ป๊อป"); pink PAID stamps (17–19 pages, two over the customer text boxes).

## Workstream A — Local AI v3.1 (`local-ai/`)

A1 **Fitted registration** used for ALL geometry (checkbox windows, text boxes, body-map labels/dots, every model crop):
coarse search scale 0.97–1.02 (step 0.0025) × shift ±24 px over all 39 checkboxes; per-box local search ±3 px;
least-squares fit (scale x/y, rotation, shift) dropping boxes > 1.5 px; crops are cut through the fitted transform (rotate
the page by the fitted angle first when |rotation| > 0.3°). Must stay ≤ ~40 ms extra on the hot path.
A2 **Checkbox scoring** per the variation study: blue pen ink at a 2 px inset, dark-only pixels at a 3 px inset; stroke-through
only when one stroke passes both opposite sides; ticks drawn beside a box (on its label) count as marks; one stroke across ≥ 3
boxes of a row = "row struck out" → no selection, needsReview; single-choice groups (gender, pressure) with ≠ 1 mark → needsReview.
A3 **Template detection**: S = mean ring contrast of the 39 boxes at fitted positions, `foundRatio` = share with contrast ≥ 20
within ±1 px. Verdict `known` if S ≥ 28, foundRatio ≥ 0.75, rmsPx ≤ 1.0, scale 0.95–1.05, |rotationDeg| ≤ 3; `uncertain`
if 20 ≤ S < 28 (process as the form, everything needsReview); `unknown` if S < 20 (no template crops or checkbox reading;
empty sections, `needsReview: true`, warning; the generic full-page path comes in Release 3).
A4 **Header + branch**: add the form header (printed "No." number, handwritten DATE and TIME) as a third crop inside the SAME
combined image (image tokens are fixed per call, so no extra model call); branch detected from the STAFF text against a new
`branches` master list (`SUKHUMVIT 33`, `PLOENCHIT`) and removed from treatment text.
A5 **Masters**: add treatments ประคบ (aliases ประคบสมุนไพร, compress), ยาหม่อง, สครับ (scrub), ออยร้อน (hot oil), หินร้อน (hot stone),
หัวอินเดีย (Indian head), alias ออย/ออยล์/oil → นวดน้ำมัน; durations [] (unrestricted) for new services. Therapists get an optional
`branch` and a `seed` flag: seed names (the frequent names read from the real scan) are suggestions only — a match to a seed
never clears needsReview. The official lists from the client replace seeds later.
A6 **Parsing**: "A + B 30 = 90" → derive the one missing duration from the written total (flag when inconsistent); leading guest
count "4 ไทย 1 ชม." → `guests: 4` on the items, not a duration; totals kept as `staffOnly.totalMinutes`; two therapists
("A / B", "A + B") → one Field whose value joins the normalised names with " / " (needsReview unless all are non-seed masters).
A7 **PAID stamp**: remove pink/red stamp pixels from model crops before sending.
A8 **Evaluation** (outside git; labels and page images live in the operator scratch dir): deterministic accuracy on all 95 pages
vs ground truth (gender, pressure, referral, health, oils, body map, blank-box detection, template verdict), parser accuracy on
the 95 labelled treatment lines, visual check of STAFF/customer/header crops on a sample. Targets before the real-model run:
gender ≥ 95 %, pressure ≥ 90 %, checkbox lists exactly right on ≥ 90 % of pages and **0 unflagged false positives**, template
verdict `known` on 95/95, parser treatment names right on ≥ 90 % of labelled lines.

### v3.1 response additions (backward compatible; engine `typhoon-sections`, version `3.1`)
```jsonc
"header": { "formNumber": Field, "date": Field, "time": Field },
"staffOnly": { …, "branch": Field, "totalMinutes": number|null },          // TreatmentField gains "guests": number|null
"layout": { …, "detection": { "verdict": "known|uncertain|unknown", "score": 45.3, "foundRatio": 1.0, "rmsPx": 0.5,
            "scaleX": 0.993, "scaleY": 0.993, "rotationDeg": -0.15, "dx": 1.2, "dy": -2.0 } }
```

## Workstream B — app: multi-page PDF split (design §1, §4.1, §4.4)

B1 Migration `0018_multipage_documents` exactly as design §1.6 (SPLIT enum value, parent_document_id / page_number /
page_count, composite FK, CHECK, partial unique index, worker INSERT grants). No function is created or replaced.
B2 Worker: `poppler-utils` in `deploy/Dockerfile.worker`; `services/ocr-worker/src/split.ts` (pdfinfo checks, chunked
`pdftoppm -png -scale-to 1610`, deterministic child keys, per-chunk transaction, advisory lock, idempotent resume, page
render failure rows, timeouts and memory limits); dispatch split vs OCR from the document; `ocrUploadName`; re-render a
missing child page; `OCR_MAX_PDF_PAGES` (default 300; raise `limits.maxOcrPagesPerDocument` and its test).
B3 Persistence: visibility (SPLIT parents hidden), batch fields `rows, pages, pagesExpected, splitting, finished`, capacity
counts top-level files, page ordering, `parentId` filter, list/review fields `parentDocumentId, pageNumber, pageCount,
parentFilename`, `statusCategoryOf('SPLIT')`, retry of a FAILED PDF parent re-splits.
B4 Fair priority: PDF pages `100 + (page-1)`, k-th file of a batch `100 + k`, single upload / retry 100.
B5 `OCR_REQUEST_TIMEOUT` default 300 s (compose + config); ingest refuses DOCX/XLSX with 415.
B6 Canonical view keeps the v3.1 additions (`header` section, `staffOnly.branch`, `totalMinutes`, treatment `guests`);
summary adds `formNumber`, `branch`; review editor shows and edits header/branch values.
B7 UI: page label "หน้า 12/95", batch strip uses rows/pages and the server's `finished`, "กำลังแยก PDF เป็นรายหน้า",
drawer title "file.pdf · หน้า 12/95" with a link to the original PDF page, upload copy for PDFs, form number and branch in
the drawer (and as a table column if it fits).

## Verification and rollout
TS + DB integration + pytest green; deterministic real-data targets (A8) met; adversarial review; then (with approval) a
real-model run of all 95 pages in the isolated eval container, deploy (Local AI first, then web → worker), press Retry on
the user's 95-page row, and report per-field accuracy and timings.
