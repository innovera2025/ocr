# INNOVERA Local AI OCR — v3.1 (`typhoon-sections`)

FastAPI service that reads a scanned **Makkha Health & Spa intake form** and returns the whole document as schema v3
(version `3.1`). Contract: `docs/operations/full-document-batch-spec.md` §1 plus the v3.1 additions of
`docs/operations/real-data/release1-plan.md` (Workstream A). It is served as `uvicorn api:app` on port 5000, with
`/app = /opt/innovera-ocr`, and talks to Ollama (`scb10x/typhoon-ocr1.5-3b`) through the OpenAI-compatible endpoint.

## What changed in v3.1 (release 1: real SUKHUMVIT 33 scans)

v3.0 was calibrated on one PLOENCHIT scan. On the first real production file (95 pages, one form per page) its
translation-only registration put every region 1.5-7.6 px off (the scans are ~0.7 % smaller after resizing and rotated
by up to -0.4 degrees), so printed box borders were counted as ticks and the model crops missed their text.

| Area | v3.0 | v3.1 |
|---|---|---|
| Registration (A1, `ocr_register.py`) | shift only, ±5 px, 10 boxes | Fitted over all 39 printed checkboxes (numpy): coarse scale 0.97-1.02 (step 0.0025) x shift ±24 px, per-box search ±3 px, weighted least-squares affine (scale x/y, rotation, shift) dropping boxes > 1.5 px off, then one more local search + fit. **Every** region is placed through the fit: each checkbox window at its own fitted position, handwriting boxes as 4 strips (a rotated border never enters the interior), body-map labels, leader lines, dots and figures one by one, and every model crop. Crops are plain pixel copies up to 0.3 degrees of fitted rotation, above that they are resampled from the de-rotated page (AFFINE transform of the crop area). ~14 ms. |
| Template verdict (A3) | contrast < 15 ⇒ warning | `layout.detection` = `{verdict, score, foundRatio, rmsPx, scaleX, scaleY, rotationDeg, dx, dy}`. S = mean ring contrast of the 39 boxes at their fitted positions, `foundRatio` = share with contrast ≥ 20 within ±1 px. **known**: S ≥ 28, foundRatio ≥ 0.75, rmsPx ≤ 1.0, scale 0.95-1.05, rotation ≤ 3 degrees. **uncertain** (otherwise, S ≥ 20): read as the form, every field `needsReview` + warning. **unknown** (S < 20): no model call and no checkbox reading, every section present with empty fields (`needsReview:true`) + warning; the generic full-page path comes in Release 3. |
| Checkbox scoring (A2) | ink at a 2 px inset; any stroke > 48 px ⇒ review | Blue pen counts at a 2 px inset, darker-than-paper (non-blue) pixels only at a 3 px inset (real printed borders have luminance ~180). A stroke through a box is **struck** (never a selection) when it runs through ≥ 3 boxes (row struck out), is longer than any tick (≥ 110 px), is a flat line longer than the box, or is flat and passes both opposite sides; big long-tailed ticks stay ticks. A struck group returns one marker `{raw:"struck out: Jasmine, Rose, …", value:null, checked:true, needsReview:true}` (no selection), drops faint/light fragments and flags its other ticks. A tick next to a box (6 px ring or its printed label, compact, not a straight line, not the start of a handwritten note) counts as an unsure mark (`needsReview`). Light ticks (fill < 16 %), filled boxes (≥ 50 %: X marks and scribbles look alike) and ticks reaching 8+ px past both sides are `needsReview`. Handwriting on the referral "Others" line counts as an unsure Others. Single choice (gender, pressure) with ≠ 1 mark or a struck box ⇒ `needsReview`. Notes per box in `evidence.checkboxNotes`. |
| Header + branch (A4) | – | `header: {formNumber, date, time}`. The combined image now stacks **header** (DATE label + box, printed "No." number + TIME label + box, with the paper next to them where dates are often written) + customer rows + the unchanged STAFF crop; `COMBINED_PROMPT` gains `No.:`, `Date:`, `Time:` lines (still one model call). `formNumber` = the printed digits; `date` = ISO `YYYY-MM-DD` (day first, Buddhist-era years such as `16.8.69` converted), `null` + `needsReview` when the year is missing; `time` = `HH:MM`; an empty DATE/TIME area is a confident ink-mark blank. `staffOnly.branch` is matched against the new `branches` masters (`SUKHUMVIT 33`, `PLOENCHIT`) in the STAFF text; branch names are removed from the treatment text (no more fake "SUKHUMVIT 33" treatment). `OCR_SECTION_MODE=separate` does not read the header. |
| Masters (A5) | 6 treatments, 3 therapists | New services with unrestricted durations (`[]`): ประคบ (ประคบสมุนไพร, Compress), ยาหม่อง, สครับ (Scrub), ออยร้อน (Hot Oil, ออยวอม), หินร้อน (Hot Stone), หัวอินเดีย (Indian Head); ออย/ออยล์/oil ⇒ นวดน้ำมัน; คอบ่า/บ่าคอไหล่ ⇒ คอ บ่า ไหล่. Therapists get optional `branch` (null = every branch) and `seed`; 10 **seed** names for `SUKHUMVIT 33` (names on ≥ 2 hand-labelled real pages) are suggestions only: a seed match never clears `needsReview`. The client's official lists replace the seeds. |
| Parsing (A6) | – | Written totals (`= 90`, `> 2 ชม`, `รวม …`, `= 2 ช`) become `staffOnly.totalMinutes`; exactly one treatment without a duration gets it derived from the total (`ไทย + เท้า 30 = 90` ⇒ ไทย 60, with a warning); a total that does not add up flags every item; several treatments without durations keep `null` (review). Without a marker, a duration written only after the last of several treatments (`ออย + หน้า 2 ชม`) is their total. A leading guest count (`4 ไทย 1 ชม.`) goes to `guests` on every item (TreatmentField gains `guests`). Two therapists (`อิน / ป๊อป`, `A + B`) give one Field whose value joins the names with " / " (unmatched names as written), `needsReview` unless all are confident non-seed masters. An empty `Treatment`/`Therapist Name` label no longer captures the next label ("Room No. 5"); a treatment written before its label is recovered. |
| PAID stamp (A7) | – | Pink/red stamp pixels (red − max(green, blue) ≥ 40, blue ≥ green − 5) become white in every model crop (`evidence.stampPixelsRemoved`). Blue/black pen, gray print and the orange form print are kept; a red pen would be removed too. |
| Body map | nearest label or dot | A mark only counts as "on the label" when it overlaps the printed label; otherwise it is kept but flagged (staff notes written left of the labels were read as circles). |

Response additions (backward compatible; v3.0 readers ignore them):
```jsonc
"layout": { …, "detection": { "verdict": "known", "score": 45.3, "foundRatio": 1.0, "rmsPx": 0.5, "scaleX": 0.993, "scaleY": 0.993,
                              "rotationDeg": -0.15, "dx": 1.2, "dy": -2.0 } },
"header": { "formNumber": Field, "date": Field, "time": Field },                  // after "layout"
"staffOnly": { …, "branch": Field, "totalMinutes": number|null }                  // TreatmentField gains "guests": number|null
```
`version` is `"3.1"`, `schemaVersion` stays `3`, and `engine` stays `typhoon-sections`. Evidence gains `stampPixelsRemoved` and the
header ink counts in `textInk`; `layoutOffset` now reports the fitted shift and template score.

## What changed in v3.0 (since v2.2 `typhoon-crop-only`)

| Area | v2.2 | v3.0 |
|---|---|---|
| Output | `staffOnly` only | Adds `customerInformation`, `recommendationCard`, `layout`, `timings` and top-level `needsReview` (spec §1). Legacy `staffOnly.treatment`, `therapistName`, `roomNo` and `evidence.staffCropRaw` keep their v2.2 shapes. |
| Checkboxes (gender, 12 referral sources, 16 health conditions, pressure, 5 oils/scrubs) | – | Deterministic, with no model call. Pen ink is measured inside each box interior (printed border excluded) plus a 3px margin. A long stroke through a box is `needsReview`, never `checked`. Gender and pressure are single-choice (none or several marked ⇒ `needsReview`). More than half of the referral or health boxes read as checked ⇒ layout warning, and every checkbox/ink field gets `needsReview`. Per-box scores go in `evidence.checkboxScores`. |
| Body map (FRONT/BACK) | – | Pen ink around each printed label (or on the figure, near its leader dot) is classified as a circle (⇒ `preferredAreas`) or a cross (⇒ `avoidAreas`), e.g. `"Shoulder (front)"`. Low-confidence marks, marks on the figure and merged neighbouring marks get `needsReview:true`. |
| Name / Nationality / Hotel | – | One extra model call on a crop of those rows (the Gender row is left out). A box with no ink returns `{raw:null, value:null, source:"ink-mark", confidence≥0.9}` and is never sent to the model; when all three are blank, the call is skipped. Nationality is matched against masters (English/Thai/Chinese, fuzzy). |
| STAFF ONLY | crop `(410,485,710,570)` + prompt | Same crop and the same prompt, word for word, so the model gets pixel-identical input for an 805×569 scan (other sizes: same region, scaled). |
| Treatments | durations paired **by index** | Split on `+ , / ; newline &`. Each name is paired with **its own** duration, normalised to `durationMinutes` (`นาที/min`, `ชม./ชั่วโมง/hr`, `1.5 ชม.`=90, `1 ชม. 30 นาที`=90, `1 ชม. 30`/`1h30`=90, `1:30`=90, `ชม.ครึ่ง`, Thai digits). A duration not allowed for that treatment ⇒ `needsReview`. A number that no duration used (`ไทย 90 นาที 15`, also after a separator: `ไทย 90 นาที + 30`) ⇒ warning + `needsReview`, never silently dropped. A trailing total equal to the sum (`… + หน้า 1 ชม. 2.5 ชม.`) is recognised as a total, not a treatment. |
| Masters | hard-coded lists | `master_data.json` (editable; reloaded when the file changes; an edit that does not load, e.g. a JSON typo, keeps the last good masters in use and `/health` answers `status:"degraded"` with `masterData:"stale: …"` until the file is fixed; the worker keeps processing in that state; a missing section or `"durations": null` reads as an empty list). Treatments with aliases (`ไทย`⇒`นวดไทย`, `หน้า`⇒`นวดหน้า`, English names) and allowed durations, therapists (`ฟ้า`, `พีพี`, `เอี้ยง`), and nationalities. |
| Verified memory | re-read `corrections.jsonl` on every lookup | Cached by file mtime and size. Treatment lookup tries `nameRaw`, then `raw`. `POST /v1/ocr/confirm` is unchanged (same body, same 400 for a bad `field`). |
| Concurrency | `async def` endpoint doing blocking I/O on the event loop | Plain `def` endpoint (FastAPI threadpool). Section calls run concurrently in a `ThreadPoolExecutor`, and checkbox/body-map detection runs while the model works. Crops are sent as in-memory PNG; only the uploaded original is saved (as before). |
| Inputs | PNG/JPG/JPEG | Adds WebP, EXIF rotation, alpha→white and any resolution (coordinates scale by width/805 and height/569; aspect mismatch ⇒ warning + `needsReview`). PDF (first page) works when `pypdfium2` or `PyMuPDF` is importable (the production base image has `pypdfium2` through `paddleocr` → `paddlex[ocr-core]`), otherwise **415**. Renders are serialised by a process-wide lock (neither library is thread-safe), the long side is rendered at 1610 px, and pages larger than 14400 pt are **400**. Raster images over 89.5 MP are **400**, except JPEGs (e.g. 108 MP phone modes), which are decoded at 1/2–1/8 scale first (at least 4096 px on both sides). Other types **400**, undecodable files **400**, internal/model errors **500**, too large **413**. |

Extra, additive keys (not in the spec example, safe to ignore):
- `evidence`: `checkboxNotes` (`stroke-through` / `faint` / `mark-beside-box`), `bodyMap` (shape features), `textInk` (ink pixels per handwriting box), `layoutOffset` (registration shift), `treatmentWarnings`, `treatmentTotalMinutes`.
- `/health`: `engine`, `schemaVersion`, `model`, `pdfSupport`, `masterData`. `status` is `"degraded"` (HTTP 200) while master data does not load.
- `evidence.customerCropRaw` is `null` when the customer call was skipped.

## Files

| File | Role |
|---|---|
| `api.py` | FastAPI app: upload handling, orchestration, crops (fitted geometry, stamp removal), response assembly, `/health`, `/v1/ocr`, `/v1/ocr/confirm` |
| `ocr_register.py` | Fitted registration (numpy) and the template verdict; `Geometry` maps template coordinates to the scan |
| `ocr_layout.py` | Template `makkha-intake-v1`: calibrated reference coordinates (805×569), header regions, `layout` block |
| `ocr_marks.py` | Deterministic ink detection: pen mask with form dropout, checkboxes (strokes, strikes, beside-box marks), handwriting emptiness, body map |
| `ocr_normalize.py` | Masters, verified memory, header / STAFF ONLY / customer parsing, branch, treatments, totals, guests, therapists |
| `ocr_model.py` | Ollama/OpenAI-compatible client and the prompts |
| `master_data.json` | Editable masters (treatments + allowed durations, therapists with branch/seed, branches, nationalities) |
| `tests/` | pytest suite, `synthetic_form.py` (draws the template; scaled/rotated pages, PAID-like stamps), `fake_ollama.py`, `bench_deterministic.py` |
| `Dockerfile.test` | Throwaway python:3.11 test image |

Runtime dependencies: fastapi, uvicorn, python-multipart, Pillow and **numpy** (new in v3.1, for the registration and stamp
removal; the production base image has it through `paddlepaddle`/`paddleocr`). OpenCV is not needed.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `OLLAMA_URL` | `http://host.docker.internal:11434/v1/chat/completions` | Chat-completions endpoint |
| `OCR_MODEL` | `scb10x/typhoon-ocr1.5-3b` | Model name |
| `OCR_MODEL_TIMEOUT` | `600` | Seconds per model call (v2.2 value) |
| `OCR_SECTION_PARALLELISM` | `2` | Concurrent section calls per document (1–8); `1` = sequential |
| `OCR_CUSTOMER_CROP_SCALE` | `1.0` | Upscale factor for the customer crop (0.5–4); tuning knob for the real model |
| `OCR_UPLOAD_DIR` | `/app/uploads` | Where the uploaded original is saved |
| `OCR_VERIFIED_FILE` | `/app/verified_dataset/corrections.jsonl` | Verified memory (human confirmations) |
| `OCR_MASTER_DATA` | `<module dir>/master_data.json` | Masters file |
| `OCR_MAX_UPLOAD_BYTES` | `31457280` (30 MiB) | Larger uploads ⇒ 413 |

## Calibration (sample2.png)

Coordinates were measured on `tests/fixtures/sample2.png`. The fixture is gitignored and must never leave the repo.
Each box position was found with a ring detector over the printed gray borders, then verified as locally optimal (±3 px).
Every region was also checked visually on 3–4× zoomed crops.

Visual ground truth for that scan:
- Ticked: gender **Female**, health **Menstruation** and pressure **Standard**.
- A wavy pen line is scribbled across the whole massage-oil row: through Jasmine, Rose and Lavender, and grazing Orange-Cinnamon. v3 reports those three boxes as `needsReview`, not as choices.
- No referral source is ticked.
- Name `Chun`, Nationality `Chinese`, Hotel empty.
- Body map: circles around **Shoulder (front)**, **Neck (back)** and **Back (back)**, no crosses.
- STAFF ONLY: `ไทย 90 นาที + หน้า 1 ชม.` (+ `2.5 ชม.` written outside the box), therapist `พีพี`, room `3`.

Ink model: blue pen strokes are bluish (B − max(R,G) ≥ 10–18). Printed text on this form is dark gray (luminance ≥ 73) or light cyan-gray, so it never counts as ink. Inside template-blank zones (box interiors, handwriting boxes, the body map minus labels, leader lines and figures), any non-orange pixel darker than luminance 185 *and* more than 30 levels darker than the *local* paper (brightest level within ~10 px) is also ink, so shadows, dim photocopies and grayish photos do not fill the boxes while thin pen strokes on dim JPEGs still count. This form dropout keeps black/red pens and JPEG uploads working. Inside checkboxes the dark-only part counts only from a 3 px inset (v3.1).

## Real-scan calibration and evaluation (v3.1)

The v3.1 rules were calibrated and measured on the 95 pages of the first production upload (SUKHUMVIT 33, clean flatbed
scans, 1400×995 JPEG renders), hand-labelled page by page. Labels, page images and the evaluation scripts stay in the
operator's scratch directory and are not in git (customer data). The evaluation runs the real `api.process_image` with the
model stubbed, so it measures everything except the model. Aggregate results (v3.0 → v3.1):

| Measure (95 pages) | v3.0 | v3.1 | Target |
|---|---|---|---|
| Template verdict `known` | – (11 "grid not found") | 95/95 (score 42.2-50.0, rmsPx 0.38-0.73, foundRatio 1.0) | 95/95 |
| Gender value right | 37 (38.9 %) | 94 (98.9 %), 0 wrong and unflagged | ≥ 95 % |
| Pressure value right | 11 (11.6 %) | 89 (93.7 %), 0 wrong and unflagged | ≥ 90 % |
| Referral / health / oil lists exactly right (per page, all three) | 0 (0 %) | 87 (91.6 %) | ≥ 90 % |
| … referral / health / oils exact | 41 / 27 / 2 | 94 / 91 / 92 | |
| Unflagged false positives in those lists | 450 | **0** | 0 |
| Body map preferred / avoid exact (not targeted) | 41 / 60, 3 unflagged FPs | 42 / 56, 2 unflagged FPs | |
| Name / nationality / hotel blank-vs-written | 86 / 73 / 60 right | 94 / 94 / 88 right (the rest `uncertain`, still read), 0 written read as blank | |
| Parser: treatment names right (labelled lines) | 40 (42 %) | 89 (94 %); 95 (100 %) counting the labels' own "hot oil = นวดน้ำมัน" naming | ≥ 90 % |
| Parser: guest counts / written totals | 0/6 / 0/31 | 6/6 / 31/31 | |

Remaining misses, by category: genuine double marks in pressure (4 pages, flagged), a pressure tick joined to the oil-row
strike (1), a circled pressure pair (1), a loop drawn around a gender box (1, flagged); flagged false entries from a
handwritten note or a strike fragment through a health box (2), the start or hook of a diagonal strike in the health "Others" box (2), a
scribbled-out oil box (1) and a staff note on the referral "Others" line (1); two oil ticks whose tail becomes the strike line
(struck marker, flagged). Visual check of the fitted STAFF, customer and header crops on 6 pages (both crop paths, both
PAID-stamp pages): every crop covers its region; totals written to the right of the Treatment box (e.g. "= 3 ชม") can be cut
at the unchanged STAFF crop's right edge.

Registration limits (synthetic pages): exact for scale 0.97-1.02 and rotation up to ±1.0 degree; from ~1.2 degrees the fit
fails visibly (verdict `uncertain`, everything flagged), never silently. Real scans stay within ±0.4 degrees.

## Testing

```bash
docker build -t ocr-local-ai-test:py311 - < local-ai/Dockerfile.test
docker run --rm -v "$PWD/local-ai":/app -w /app -e PYTHONDONTWRITEBYTECODE=1 ocr-local-ai-test:py311
# without the fixture: sample2 tests are skipped, synthetic-form tests still cover every detector
docker run --rm -v "$PWD/local-ai":/app --tmpfs /app/tests/fixtures -w /app ocr-local-ai-test:py311
# deterministic-path timing (everything except the model)
docker run --rm -v "$PWD/local-ai":/app -w /app -e OCR_VERIFIED_FILE=/tmp/x.jsonl ocr-local-ai-test:py311 \
  python tests/bench_deterministic.py tests/fixtures/sample2.png --runs 40
```

The model call is mocked in `tests/test_api.py`. `tests/test_fake_ollama.py` runs the real HTTP client against `tests/fake_ollama.py`.

Whole stack locally, without a GPU:

```bash
cd local-ai
python tests/fake_ollama.py --port 11434 --latency-ms 800 &          # canned STAFF/CUSTOMER answers
OLLAMA_URL=http://127.0.0.1:11434/v1/chat/completions OCR_UPLOAD_DIR=/tmp/ocr-uploads \
OCR_VERIFIED_FILE=/tmp/ocr-verified/corrections.jsonl uvicorn api:app --port 5000
curl -s -F file=@tests/fixtures/sample2.png http://127.0.0.1:5000/v1/ocr | python -m json.tool
```

Measured locally (Docker Desktop, python 3.11, Pillow 12.3, numpy 2.4; `bench_deterministic.py`, same script run against
v3.0 and v3.1 interleaved, median totalMs):

| Input | v3.0 | v3.1 |
|---|---|---|
| Real page (1400×995 JPEG), 3 pages | 85-88 ms | 90-93 ms |
| sample2.png (805×569) | 61 ms | 70 ms |
| synthetic form | 45 ms | 73 ms |

The registration costs ~14 ms; the single combined PNG encode is cheaper than v3.0's two encodes plus re-stack. Checkbox
and body-map detection (7-22 ms) overlaps the model call in production.

## Measured on the production Local AI VPS (2026-09-22)

The host is CPU-only (8 vCPU AMD EPYC, 32 GB, no GPU; `size_vram: 0`). Ollama 0.34.2 runs one request at a time
(one slot, `n_ctx_slot 4096`) and resizes every image to about 1,070 tokens whatever its size, so each model call
costs about 24-25 s for a document it has not seen. Ollama's prompt cache answers an image it has seen before in
1-2 s: the "1.5-1.8 s warm latency" quoted for v2.2 came from re-sending the same sample. Measure with
cache-defeating variants (±1 pixel jitter) for real numbers.

| Build | New document (cache miss) | Repeated sample (cache hit) |
|---|---|---|
| v2.2 (STAFF crop only) | 24.7-27.6 s | 1.7-2.4 s |
| v3 `OCR_SECTION_MODE=separate` (2 calls) | 50.2-51.3 s | 2.3-4.0 s |
| v3 default `combined` (1 call) | 23.9-24.7 s (12/12 fields correct on 6 fresh variants) | ~1.9 s |

Throughput is bounded by the single Ollama slot: about 2.5 new documents per minute, whatever
`OCR_WORKER_CONCURRENCY` is (2 keeps the slot busy; the second request waits in Ollama's queue).
`OCR_SECTION_MODE` (`combined` default, `separate`) selects one or two model calls; `combined` falls back to a
second, STAFF-only call only when its answer contains no staff label.

## Must be validated against the real model on the Local AI VPS

v3.1 changes what the model sees (fitted crops, header part, stamp removal) but not how it is called: still one combined
call, the STAFF crop region and STAFF_PROMPT are unchanged, and the combined prompt only gains three label lines. Check on
the 95-page run (isolated evaluation container, as for the v3.0 baseline):

1. **Header lines.** `evidence.combinedRaw` should start with `No. …`, `Date …`, `Time …`; the number of fallback calls
   (`timings.sections`) must not grow. `COMBINED_MAX_TOKENS` is 380 (was 340).
2. **Branch.** The model reads the printed `SUKHUMVIT 33`: `staffOnly.branch` must be set and no treatment may contain it.
3. **Treatment text.** v3.0 read `ชม.` as `5ม.` on several real pages (`1 5ม.`) and put values before their labels; the parser
   recovers the second case, not the first (such items stay `needsReview`).
4. **Totals outside the Treatment box.** Totals written past the box's right edge can be cut by the STAFF crop; if the real
   answers lose them often, widening the crop is a separate decision (it changes the proven STAFF input).
5. **Customer names / hotels.** With the fitted crop the customer rows are complete; compare with the labels (v3.0: name 30 %).
6. **Durations in `master_data.json`** are placeholders; the new services accept any duration. Seeds are suggestions only.

## Safe blue/green deployment on the Local AI VPS

No new dependencies beyond numpy (already in the paddleocr base image: check with `python -c "import numpy"` in the live
container first), so the **same image** as the live container is used. Only the code directory changes.
Run everything as the service owner, and never overwrite `/opt/innovera-ocr` in place.

```bash
# 0. Record the live container (name, image, ports, mounts, env, extra hosts, restart policy)
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}'
LIVE=innovera-ocr            # replace with the real container name
docker inspect "$LIVE" > /root/innovera-ocr-v22-inspect-$(date +%F).json
IMAGE=$(docker inspect -f '{{.Config.Image}}' "$LIVE")

# 1. Backups (code + verified memory); keep them for at least 2 weeks
mkdir -p /opt/backups
tar czf /opt/backups/innovera-ocr-v22-$(date +%F-%H%M).tgz -C /opt --exclude='innovera-ocr/uploads' innovera-ocr
cp -a /opt/innovera-ocr/verified_dataset/corrections.jsonl /opt/backups/corrections-$(date +%F-%H%M).jsonl

# 2. Stage v3 next to v2.2 (never copy tests/fixtures to the server)
rsync -a --delete --exclude 'tests/fixtures/' --exclude '__pycache__/' ./local-ai/ /opt/innovera-ocr-v3/
mkdir -p /opt/innovera-ocr-v3/uploads
cp -a /opt/innovera-ocr/verified_dataset /opt/innovera-ocr-v3/verified_dataset   # a COPY while testing

# 3. Green container on another port, same image, same Ollama (mirror any other flags from step 0)
docker run -d --name innovera-ocr-v3 -p 127.0.0.1:5001:5000 \
  -v /opt/innovera-ocr-v3:/app --add-host=host.docker.internal:host-gateway \
  -e OCR_SECTION_PARALLELISM=2 "$IMAGE" uvicorn api:app --host 0.0.0.0 --port 5000
curl -s http://127.0.0.1:5001/health          # expect "version":"3.1","masterData":"ok"

# 4. Compare with the live v2.2 on forms that are ALREADY on the server (e.g. the upload of the sample2 form and a few
#    recent ones in /opt/innovera-ocr/uploads). Do not copy the repo fixture to the server.
SAMPLE=/opt/innovera-ocr/uploads/<existing-upload>.png
for port in 5000 5001; do
  for i in 1 2 3 4 5; do curl -s -o /tmp/ocr-$port.json -w "$port %{time_total}s\n" -F "file=@$SAMPLE" http://127.0.0.1:$port/v1/ocr; done
done
jq '{t: .staffOnly.treatment.raw, th: .staffOnly.therapistName.value, r: .staffOnly.roomNo.value, raw: .evidence.staffCropRaw}' /tmp/ocr-5000.json /tmp/ocr-5001.json
jq '{c: .customerInformation, rec: .recommendationCard, timings, needsReview}' /tmp/ocr-5001.json
```

Acceptance before swapping:
- `staffCropRaw` and the staff values match v2.2.
- Customer and checkbox fields match the paper form.
- Warm `totalMs` is within about +0.3 s of v2.2 (if not, see validation item 1).
- No 5xx responses in `docker logs innovera-ocr-v3`.

```bash
# 5. Swap (a few seconds of downtime; the worker retries 5xx/network errors, so no job is lost)
#    Prefer a quiet moment (queue empty). The live data dirs are mounted over the copies.
docker rm -f innovera-ocr-v3
docker stop "$LIVE" && docker rename "$LIVE" innovera-ocr-v22
docker run -d --name "$LIVE" --restart unless-stopped -p <LIVE PORT MAPPING FROM STEP 0> \
  -v /opt/innovera-ocr-v3:/app \
  -v /opt/innovera-ocr/verified_dataset:/app/verified_dataset \
  -v /opt/innovera-ocr/uploads:/app/uploads \
  --add-host=host.docker.internal:host-gateway -e OCR_SECTION_PARALLELISM=2 \
  "$IMAGE" uvicorn api:app --host 0.0.0.0 --port 5000
curl -s http://127.0.0.1:5000/health          # version 3.1; then push one real document through the app

# 6. Rollback (seconds): the v2.2 container and /opt/innovera-ocr are untouched
docker stop "$LIVE" && docker rename "$LIVE" innovera-ocr-v3-failed
docker rename innovera-ocr-v22 "$LIVE" && docker start "$LIVE"
```

Notes:
- Confirmations written by v3 use the unchanged JSONL format in the live `verified_dataset`, so rollback needs no data migration.
- v3 is backward compatible for v2.2 readers, because the legacy fields are kept. So the app/worker upgrade can ship before or after this swap.
- PDF uploads: check `pdfSupport` in `/health` (or `python -c 'import pypdfium2.version as v; print(v.PDFIUM_INFO)'` in the container). The production base image normally includes `pypdfium2` through `paddleocr`; without it the service answers 415, and the worker treats that as non-retryable.

## Known limitations

- **One template.** Only `makkha-intake-v1` (PLOENCHIT and SUKHUMVIT 33 prints share its geometry). Other layouts are
  `unknown` (nothing read, flagged); the generic full-page path, orientation (90/180/270) and deskew beyond ~1 degree come in
  Release 3. Phone photos with perspective are not corrected.
- **Heavy JPEG.** At quality ≤ ~75 with 4:2:0 chroma subsampling, ticks and handwriting presence are still detected (form
  dropout). A long scribble through a row of boxes can lose its colour outside the boxes. PNG, or JPEG ≥ 90, is recommended.
- **Body map** is the weakest part (real scans: preferred areas exactly right on 44 % of pages, avoid areas 59 %): marks on
  the figure itself, ticks and hearts instead of circles, one loop around two labels, and areas the map has no label for
  (chest, abdomen, buttocks). Uncertain marks are flagged.
- **Strikes and ticks drawn as one stroke** (a tick whose tail becomes the strike line) are read as struck, with a
  review marker. X marks and scribbled-out boxes are equally dense: both are returned for review.
- **Free text.** Customer name and hotel have no master, so they are taken as read (confidence 0.8) unless the answer looks
  malformed. Dates without a year are returned for review.
- **Red pen** is removed from model crops together with pink/red stamps.
