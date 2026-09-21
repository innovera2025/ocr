# INNOVERA Local AI OCR — v3.0 (`typhoon-sections`)

FastAPI service that reads a scanned **Makkha Health & Spa intake form** and returns the whole document as schema v3.
Contract: `docs/operations/full-document-batch-spec.md` §1. It is served as `uvicorn api:app` on port 5000, with
`/app = /opt/innovera-ocr`, and talks to Ollama (`scb10x/typhoon-ocr1.5-3b`) through the OpenAI-compatible endpoint.

## What changed since v2.2 (`typhoon-crop-only`)

| Area | v2.2 | v3.0 |
|---|---|---|
| Output | `staffOnly` only | Adds `customerInformation`, `recommendationCard`, `layout`, `timings` and top-level `needsReview` (spec §1). Legacy `staffOnly.treatment`, `therapistName`, `roomNo` and `evidence.staffCropRaw` keep their v2.2 shapes. |
| Checkboxes (gender, 12 referral sources, 16 health conditions, pressure, 5 oils/scrubs) | – | Deterministic, with no model call. Pen ink is measured inside each box interior (printed border excluded) plus a 3px margin. A long stroke through a box is `needsReview`, never `checked`. Gender and pressure are single-choice (none or several marked ⇒ `needsReview`). More than half of the referral or health boxes read as checked ⇒ layout warning, and every checkbox/ink field gets `needsReview`. Per-box scores go in `evidence.checkboxScores`. |
| Body map (FRONT/BACK) | – | Pen ink around each printed label (or on the figure, near its leader dot) is classified as a circle (⇒ `preferredAreas`) or a cross (⇒ `avoidAreas`), e.g. `"Shoulder (front)"`. Low-confidence marks, marks on the figure and merged neighbouring marks get `needsReview:true`. |
| Name / Nationality / Hotel | – | One extra model call on a crop of those rows (the Gender row is left out). A box with no ink returns `{raw:null, value:null, source:"ink-mark", confidence≥0.9}` and is never sent to the model; when all three are blank, the call is skipped. Nationality is matched against masters (English/Thai/Chinese, fuzzy). |
| STAFF ONLY | crop `(410,485,710,570)` + prompt | Same crop and the same prompt, word for word, so the model gets pixel-identical input for an 805×569 scan (other sizes: same region, scaled). |
| Treatments | durations paired **by index** | Split on `+ , / ; newline &`. Each name is paired with **its own** duration, normalised to `durationMinutes` (`นาที/min`, `ชม./ชั่วโมง/hr`, `1.5 ชม.`=90, `1 ชม. 30 นาที`=90, `1 ชม. 30`/`1h30`=90, `1:30`=90, `ชม.ครึ่ง`, Thai digits). A duration not allowed for that treatment ⇒ `needsReview`. A number that no duration used (`ไทย 90 นาที 15`) ⇒ warning + `needsReview`, never silently dropped. A trailing total equal to the sum (`… + หน้า 1 ชม. 2.5 ชม.`) is recognised as a total, not a treatment. |
| Masters | hard-coded lists | `master_data.json` (editable; reloaded when the file changes; an edit that does not load, e.g. a JSON typo, keeps the last good masters in use and `/health` answers `status:"degraded"` with `masterData:"stale: …"` until the file is fixed). Treatments with aliases (`ไทย`⇒`นวดไทย`, `หน้า`⇒`นวดหน้า`, English names) and allowed durations, therapists (`ฟ้า`, `พีพี`, `เอี้ยง`), and nationalities. |
| Verified memory | re-read `corrections.jsonl` on every lookup | Cached by file mtime and size. Treatment lookup tries `nameRaw`, then `raw`. `POST /v1/ocr/confirm` is unchanged (same body, same 400 for a bad `field`). |
| Concurrency | `async def` endpoint doing blocking I/O on the event loop | Plain `def` endpoint (FastAPI threadpool). Section calls run concurrently in a `ThreadPoolExecutor`, and checkbox/body-map detection runs while the model works. Crops are sent as in-memory PNG; only the uploaded original is saved (as before). |
| Inputs | PNG/JPG/JPEG | Adds WebP, EXIF rotation, alpha→white and any resolution (coordinates scale by width/805 and height/569; aspect mismatch ⇒ warning + `needsReview`). PDF (first page) works when `pypdfium2` or `PyMuPDF` is importable (the production base image has `pypdfium2` through `paddleocr` → `paddlex[ocr-core]`), otherwise **415**. Renders are serialised by a process-wide lock (neither library is thread-safe), the long side is rendered at 1610 px, and pages larger than 14400 pt are **400**. Raster images over 89.5 MP are **400**. Other types **400**, undecodable files **400**, internal/model errors **500**, too large **413**. |

Extra, additive keys (not in the spec example, safe to ignore):
- `evidence`: `checkboxNotes` (`stroke-through` / `faint` / `mark-beside-box`), `bodyMap` (shape features), `textInk` (ink pixels per handwriting box), `layoutOffset` (registration shift), `treatmentWarnings`, `treatmentTotalMinutes`.
- `/health`: `engine`, `schemaVersion`, `model`, `pdfSupport`, `masterData`. `status` is `"degraded"` (HTTP 200) while master data does not load.
- `evidence.customerCropRaw` is `null` when the customer call was skipped.

## Files

| File | Role |
|---|---|
| `api.py` | FastAPI app: upload handling, orchestration, response assembly, `/health`, `/v1/ocr`, `/v1/ocr/confirm` |
| `ocr_layout.py` | Template `makkha-intake-v1`: calibrated reference coordinates (805×569), scaling, `layout` block |
| `ocr_marks.py` | Deterministic ink detection: pen mask with form dropout, registration, checkboxes, handwriting emptiness, body map |
| `ocr_normalize.py` | Masters, verified memory, STAFF ONLY and customer transcription parsing, treatments and durations |
| `ocr_model.py` | Ollama/OpenAI-compatible client and both prompts |
| `master_data.json` | Editable masters (treatments + allowed durations, therapists, nationalities) |
| `tests/` | pytest suite, `synthetic_form.py` (draws the template), `fake_ollama.py`, `bench_deterministic.py` |
| `Dockerfile.test` | Throwaway python:3.11 test image |

Runtime dependencies are unchanged: fastapi, uvicorn, python-multipart and Pillow (from the paddleocr base image). numpy is not used.

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

Ink model: blue pen strokes are bluish (B − max(R,G) ≥ 10–18). Printed text on this form is dark gray (luminance ≥ 73) or light cyan-gray, so it never counts as ink. Inside template-blank zones (box interiors, handwriting boxes, the body map minus labels, leader lines and figures), any non-orange pixel more than 70 levels darker than the *local* paper (brightest level within ~10 px) is also ink, so shadows, dim photocopies and grayish photos do not fill the boxes. This form dropout keeps black/red pens and JPEG uploads working. Registration searches ±5 px for the printed checkbox grid.

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

Measured locally (Docker Desktop, python 3.11, Pillow 12.3):
- Deterministic path on sample2: median ≈ 69 ms in total. Decode is ≈ 24 ms (v2.2 also decoded), preprocess ≈ 24 ms, checkbox + body map ≈ 18 ms (overlaps inference) and normalize ≈ 2 ms.
- With fake 800 ms model calls: `inferenceMs` ≈ 1615 ms, `inferenceWallMs` ≈ 810 ms and `totalMs` ≈ 870 ms.

## Must be validated against the real model on the Local AI VPS

1. **Ollama parallelism.** Two section calls run at once. If Ollama serialises them (`OLLAMA_NUM_PARALLEL=1`, or a CPU-bound box), `inferenceWallMs` ≈ `inferenceMs` and latency roughly doubles (≈ 3 s instead of 1.5–1.8 s).
   - Check `timings`, then set `OLLAMA_NUM_PARALLEL=2` on the Ollama service (this needs memory for a second context).
   - Otherwise accept the extra call, or set `OCR_SECTION_PARALLELISM=1` to keep a predictable order.
2. **Customer prompt and parsing.** The code assumes the model answers with `Name: … / Nationality: … / Hotel Name: …` lines. The parser also accepts echoed Chinese labels (`姓名 国籍 酒店`), markdown bold, tables, HTML, full-width colons, placeholders such as `-` or `N/A`, and an unlabeled one-line-per-field answer (that last case is flagged `needsReview`). A label word only counts at the start of a line or table cell, or right before a colon (Chinese labels also as separate words), so `Kaname`, `Hotel Nikko` or `Anna Hotelling` inside a value are kept whole.
   - Check `evidence.customerCropRaw` on 10–20 real forms.
   - The crop stacks the Name row over the Nationality + Hotel rows at native resolution (324×93 px for an 805×569 scan). If handwriting is misread, try `OCR_CUSTOMER_CROP_SCALE=2`.
3. **STAFF ONLY output.** The crop pixels and the prompt are exactly v2.2's, so `evidence.staffCropRaw` should equal v2.2's output for the same file. The treatment capture is now multi-line: it runs until `Therapist Name` / `Room No`, and printed `STAFF ONLY / 仅前台使用 / PLOENCHIT / MAKKHA` lines are dropped. Confirm that the real output does not contain other printed text that would become a fake treatment.
4. **Totals outside the box.** Check whether the model transcribes the `2.5 ชม.` total that sits outside the Treatment box. If it does, the parser treats it as a total, not a treatment.
5. **Unit spelling.** Watch for `ชม.` read as `ซม.` (accepted as hours) and for durations without a unit (read as minutes with a warning).
6. **Durations in `master_data.json`** are placeholders. Confirm them against the spa menu; any other value is flagged `needsReview`.

## Safe blue/green deployment on the Local AI VPS

No new dependencies, so the **same image** as the live v2.2 container is used. Only the code directory changes.
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
curl -s http://127.0.0.1:5001/health          # expect "version":"3.0","masterData":"ok"

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
curl -s http://127.0.0.1:5000/health          # version 3.0; then push one real document through the app

# 6. Rollback (seconds): the v2.2 container and /opt/innovera-ocr are untouched
docker stop "$LIVE" && docker rename "$LIVE" innovera-ocr-v3-failed
docker rename innovera-ocr-v22 "$LIVE" && docker start "$LIVE"
```

Notes:
- Confirmations written by v3 use the unchanged JSONL format in the live `verified_dataset`, so rollback needs no data migration.
- v3 is backward compatible for v2.2 readers, because the legacy fields are kept. So the app/worker upgrade can ship before or after this swap.
- PDF uploads: check `pdfSupport` in `/health` (or `python -c 'import pypdfium2.version as v; print(v.PDFIUM_INFO)'` in the container). The production base image normally includes `pypdfium2` through `paddleocr`; without it the service answers 415, and the worker treats that as non-retryable.

## Known limitations

- **Fixed template.** Only `makkha-intake-v1` is supported. Small shifts (±5 px) and uniform scaling are handled. Rotated or perspective photos are not: the aspect warning or the "checkbox grid not found" warning sets `needsReview`.
- **Heavy JPEG.** At quality ≤ ~75 with 4:2:0 chroma subsampling, ticks and handwriting presence are still detected (form dropout). A long scribble through a row of boxes can lose its colour outside the boxes and then reads as ticks instead of `needsReview`. Faint body-map circles drop to `needsReview`. PNG, or JPEG ≥ 90, is recommended for scans.
- **Body map.** Marks drawn on the figure itself are mapped to the nearest leader dot and flagged for review. Circling two adjacent labels with one stroke (Back/Waist, Calf/Plantar) is reported once, with `needsReview`.
- **Free text.** Customer name and hotel have no master, so they are taken as read (confidence 0.8) unless the answer looks malformed.
