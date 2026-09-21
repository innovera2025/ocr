---
dimension: c4-ocr-provider-and-handwriting
title: OCR provider decision, coordinate contract, and handwriting-ready architecture (owner sections 7, 8)
status: canonical-reviewed
date: 2026-09-09
reviewed: 2026-09-09 (adversarial review + revision; see "Reviewer Notes" at the end)
supersedes:
  - docs/architecture/m0/d-ocr-engine.md §1 (executive recommendation), §2 (requirements R1-R7), §5 (scored matrix + sensitivity), §6 (det/rec split rationale + the unclip experiment), §9.2 (the TypeScript port), §9.3 (the abstraction test), §9.5 (adapter sketch), §9.6(b) (escalation policy), §11 D1/D2/D3/D4/D5/D13, §12 spike 7
  - docs/architecture/m0/f-preprocessing-and-confidence.md §2.4 Step 5 (calibrationKey) — REPLACED by ocr.calibration_key below
  - docs/architecture/m0/z-adversarial-panel.md P1 findings F1, F2 and the ops lens findings (2) and (3) — CLOSED here, with two of the panel's own premises corrected by execution-grade source reading
extends_without_superseding:
  - docs/architecture/m0/f-preprocessing-and-confidence.md D16 (`PreprocessManifest.geometry.toOriginal`) — kept verbatim as ONE LINK of the four-space chain defined in §3
  - docs/architecture/m0/i-storage.md §2.1 (object-key template) — this document adds ONE `kind` value (`region`) and owns nothing else about the grammar
cites_frozen:
  - m05/f1-tenant-visibility-model.md (tenant column, Principal, Membership.id principal identity, DocumentRef, RLS child-table rule, uniq.* rules, storage.tenant_prefix_check, schema.invariants TEN-1/TEN-2, partial_index.policy, db.roles)
  - m05/f2-canonical-limits.md (RENDER_DPI_DEFAULT, MAX_PAGE_PIXELS, MAX_PAGE_RENDER_BYTES, MAX_PAGES_PER_DOCUMENT, MAX_OCR_PAGES_PER_DOCUMENT, PAGE_OCR_TIMEOUT_S, JOB_PROCESSING_BUDGET_MS, MAX_TILES_PER_PAGE, MAX_CHARS_PER_PAGE, LIMITS_SOURCE_OF_TRUTH, WORKER_MEMORY_LIMIT_BYTES, WORKER_JOB_CONCURRENCY, RENDER_CONCURRENCY, DEFAULT_STORAGE_QUOTA_BYTES)
  - m05/f3-ai-call-placement.md (ai_call_owner, ai.services.no_egress, ai.network.map, ai.spool.volume, ai.error.taxonomy_owner, ai.stage_enabled.semantics)
cites_peer:
  - m05/c1-storage-key-contract.md — object-key grammar, OCR_ENV, storage driver/bucket contract. This document adds ONE `kind` segment value (`region`) and owns nothing else about the grammar.
  - m05/c2-queue-contract.md — job/lease/attempt/DLQ contract. This document emits warnings and review items into it; it owns no queue semantics.
  - m05/c3-ocr-routing-policy.md — **page and span ROUTING**: which pages are OCR'd, at what DPI, which spans get a second engine pass (C3-D8 multi-engine), the extra-pass cost ledger, the page-level handwriting heuristic, and every `OCR_ROUTE_*` threshold. This document owns what happens to candidates AFTER routing has chosen to produce them. The boundary, and three surviving conflicts, are stated in **§13**.
  - m05/c5-gateway-contract-and-qwen-role.md — gateway/model contract for any generative rung.
---

# C4 — OCR provider decision, coordinate contract, and handwriting-ready architecture

> **Integration status (2026-09-12):** Read the [architecture index](../README.md) and its consolidation report before using these examples. Individual review labels do not close cross-document conflicts; no application implementation is verified.

**Two linked deliverables.** §1–§4 re-decide the OCR provider against the owner's ten axes and close the three P1 panel findings. §5–§11 specify the handwriting-ready architecture without implementing handwriting recognition.

**What this document does NOT own.** Tenant scoping, RLS, visibility, ids, unique-index policy (→ `f1-tenant-visibility-model.md`). Every byte/pixel/page/timeout limit (→ `f2-canonical-limits.md`). Which process may open a socket to the LiteLLM gateway, and the AI job/ledger/spool contract (→ `f3-ai-call-placement.md`). **Page and span routing — which pages are OCR'd, at what DPI, and which spans earn a second engine pass — belongs to `c3-ocr-routing-policy.md`** (→ §13). The object-key grammar belongs to `c1-storage-key-contract.md`; the queue belongs to `c2-queue-contract.md`. Where a value from those documents is needed here it is **cited, never restated**.

**Evidence discipline.** Every external claim in this document is tagged. **VERIFIED** = read this session from the named primary source (library source file, package index, model card, release API). **UNVERIFIED-CITATION** = the M0 corpus asserts it, this session could not reach a primary source that confirms it, and it is therefore never load-bearing for a gate. **ESTIMATE** = our own arithmetic, with the inputs shown. A number with no tag in a decision is an error; report it.

---

## 0. What changed, in one screen

| # | M0 position | C4 position | Why |
|---|---|---|---|
| 1 | "No roster engine can produce sub-line Thai geometry" (panel F1) | **REFUTED by execution-grade source reading.** RapidOCR ships `return_word_box` + `return_single_char_box` as first-class public parameters; `CTCLabelDecode.get_word_info()` records the **CTC frame index of every decoded character** in `WordInfo.word_cols`, and `CalRecBoxes.cal_ocr_word_box()` converts those frame indices to per-character x-ranges inside the line quad and then **inverts the crop's perspective transform** back into page-image coordinates. Sub-line Thai geometry is obtainable today, in-library, with no fork. | §2.1 |
| 2 | `det_db_unclip_ratio` sweep is the "#1 accuracy experiment" | **Demoted to #4.** The #1 knob is `Global.use_preprocess_img`, which at its shipped default **silently downscales an A4 page at 300 DPI by 0.570×** before detection *and before the recogniser crop is cut*. Thai tone marks are 2–5 px at 300 DPI; after that downscale they are 1.1–2.9 px. | §2.2 |
| 3 | Quads leave the port in derivative pixel space with no route back (panel F1 secondary) | **FIXED.** A four-space coordinate contract; all persisted geometry is in **SOURCE space**; the full chain is stored per render in a new `page_renders` row; a round-trip test asserts ≤ 0.5 px. | §3 |
| 4 | Tesseract is the "FALLBACK" for "the network is down" | **Role renamed to CORROBORATOR.** The primary has no network dependency, so that failure mode does not exist (panel ops finding 2 conceded). Tesseract's real value is that it is a *statistically independent second opinion* over the same regions. There is **no availability failover**; the system fails closed to human review. | §4.2 |
| 5 | Escalation E1–E6 route pages to a generative engine on attacker-controllable signals | **E1/E2/E3/E5/E6 no longer escalate to any generative engine.** They raise a warning and route to review. Only E4 (caller-declared capability need) routes, and only through an explicit `forbid` gate populated from the Organization row. | §4.4 |
| 6 | `calibrationKey = (engine, engineVersion, modelId, scriptTag, spanKind)` | **Replaced** by a 12-tuple that includes backend, backend version, render DPI, det-params hash, pipeline version and consensus version. An unseen key yields `calibratedP = null`, which the existing hard gates already handle. | §4.5 |
| 7 | Handwriting: unaddressed | Full **region → candidates → consensus → provenance → correction-dataset** architecture, no recogniser shipped, numeric gates throughout, PDPA consequence flagged as a **blocking** consent decision. | §5–§11 |

**Corrections made by the adversarial review of this document (2026-09-09).** These are changes to *this file's own first draft*, not to M0, and each is a defect the draft would have shipped:

| # | First-draft position | Reviewed position | Where |
|---|---|---|---|
| R1 | Call 2 of the det⊕rec split is `RapidOCR(use_det=False, use_rec=True, return_word_box=True)` | **BROKEN — VERIFIED.** `RapidOCR.__call__` computes word boxes only inside `if self.return_word_box and det_res.boxes is not None and all(rec_res.word_results)`. With `use_det=False` there are no `det_res.boxes`, so **word-box calculation is skipped entirely** and the split as drafted destroys the very sub-line geometry C4-D1 is selected for. Call 2 is now a direct `TextRecognizer` + `CalRecBoxes` invocation with the adapter supplying `dt_boxes`. | §2.1, C4-D2 |
| R2 | `Global.text_score = 0.0` prevents the engine discarding evidence | Still pinned, but `filter_by_text_score` lives in `build_final_output`, which the direct recogniser call never reaches — so on the recognition path the filter is **structurally absent**, not merely set to zero. The pin now guards call 1 only. | C4-D5 |
| R3 | Typhoon and thai-trocr figures cited to `arXiv 2609.03595` and the model card | **Two citation errors.** `2609.03595` is *"How Far Can Synthetic Data Take Thai OCR?"*, **not** the Typhoon paper (that is `arXiv 2601.14722`); and the thai-trocr baseline CERs quoted were the **adjusted-mean** row, not the **handwritten** row. Both fixed; the Typhoon figures are demoted to UNVERIFIED-CITATION. | §1.2, C4-D4 |
| R4 | `tesseract-tha` declares `emitsSubLineGeometry: 'cluster'` | Per-symbol Tesseract boxes exist but require `-c hocr_char_boxes=1` (`RIL_SYMBOL` → `ocrx_cinfo`, VERIFIED); **TSV and default hOCR are word-level, and a Tesseract Thai "word" is a phrase run.** M1 ships `'line'`; `'char'` only after the M2 measurement. | C4-D3, §6.5 |
| R5 | No cap on detected regions | `text_score = 0.0` with `Det.max_candidates = 1000` (VERIFIED default) admits up to 1,000 regions/page. Three new caps, plus the alignment caps that were named only in the canonical table. | C4-D12, §7.2 |
| R6 | No mention of `c3-ocr-routing-policy.md` | c3 already owns multi-engine verification (C3-D8), the extra-pass cost ledger that makes `f2 JOB_PROCESSING_BUDGET_MS` close, DPI escalation, and the page-level handwriting heuristic. Boundary stated; three conflicts raised. | §13 |
| R7 | E1–E6 thresholds had numbers but **no env vars** and two undefined terms (`ink coverage`, `corpus median`) | Every trigger now has a name, an env var, a default, a definition and an inert-until-measurable rule. | C4-D8 |
| R8 | `actorUserId`, `createdByUserId`, `scope: TenantScope` | Frozen drift against `f1 tenant.principal_identity` (`Membership.id`, not `User.id`) and `f1 authz.principal_type` (`Principal`). Corrected. | §9.4, C4-D7 |
| R9 | `page_renders` unique on `(documentPageId, runId)` | Contradicts this document's own definition of a render and blocks c3's within-run DPI escalation. Widened to the full recipe. | §3.3 |
| R10 | `OCR_ENGINE_STRICT_CONFIG` refused false "when `NODE_ENV=production`" | The worker is Python. `NODE_ENV` is a category error there; `OCR_ENV` is the variable `c1` already established. | C4-D5 |

**Three frozen-value challenges are raised in §12** and **three peer-document conflicts in §13**. Nothing in this document deviates from a frozen value.

---

## 1. Provider re-evaluation against the owner's ten axes

The owner replaced M0's R1–R7 with ten axes. M0's §5.1 weight vector is therefore void — it was derived from R1–R7 and does not contain handwriting extensibility at all. The axes below are scored on **evidence only**; a cell with no source is marked `NO EVIDENCE` and scores nothing, per the §5.2 correction discipline the M0 review itself established.

### 1.1 The candidate set

Five candidates survive the licence gate (§1.4). Two engines from M0's roster are removed from consideration entirely: **Surya** (weights under OpenRAIL-M with a revenue gate, no Thai evidence — M0 D10, unchanged) and **docTR / TrOCR-base** (no Thai model — M0 §3.9/§3.10, unchanged). `dots.ocr` is removed as a *primary or secondary* candidate: M0 §3.11 records "Thai evidence: none found" and its C1 score was explicitly labelled a prior, not a measurement.

| Id | Artefact | Runtime | Verified licence |
|---|---|---|---|
| `paddle-onnx-th` | `PP-OCRv5_mobile_det` ⊕ `th_PP-OCRv5_mobile_rec` ⊕ `ppocrv5_th_dict` | `rapidocr` 3.9.2 / ONNX Runtime | Toolkit Apache-2.0 ([PyPI](https://pypi.org/project/rapidocr/), verified 3.9.2, `requires_python >=3.8,<4`); weights **apache-2.0** — verified on the model card this session ([HF](https://huggingface.co/PaddlePaddle/th_PP-OCRv5_mobile_rec)), which **closes M0 §12 spike 6** |
| `tesseract-tha` | Tesseract **5.5.3** (VERIFIED latest release, 2026-07-24) + `tessdata_best/tha` + `eng` | the `tesseract` **CLI**, driven by `pytesseract` (a subprocess wrapper — *not* a `libtesseract` binding) | Apache-2.0 (M0 §3.6) |
| `easyocr-th` | `craft_mlt_25k.pth` + `thai.pth` (already on disk) | torch CPU | Apache-2.0 (M0 §4.1) |
| `typhoon-vlm` | `typhoon-ocr1.5-2b` (2 B params, Qwen3-VL-2B base) | vLLM, GPU | **VERIFIED** this session: the HF card carries `apache-2.0`. **STILL UNRESOLVED (B-5):** M0 §3.2 records a paper/weights CC-BY-SA-4.0 claim, and this session could not reach a source that reconciles the two. Also **UNVERIFIED:** the M0 corpus writes the repo id as `scb10x/typhoon-ocr1.5-2b`; the card this session reached resolves under `typhoon-ai/typhoon-ocr1.5-2b`. An artefact whose canonical repo id we cannot state is not a shippable artefact |
| `thai-trocr-hw` | `openthaigpt/thai-trocr` | transformers | **VERIFIED apache-2.0**, 0.1 B params, encoder TrOCR-base-handwritten ⊕ decoder Electra-small (Thai corpus) — card read this session ([HF](https://huggingface.co/openthaigpt/thai-trocr)) |

### 1.2 The ten axes, scored on evidence

Scale 0–5. `—` = axis does not apply. **`NO EVIDENCE`** = we found no source; it is not a low score, it is an absence, and it is never averaged into a total.

> **A1 metric warning — added by review.** The four A1 cells below are **not one metric**. `paddle-onnx-th`'s number is a vendor *line-accuracy* (higher better); `typhoon-vlm`'s are *CER* (lower better); `tesseract-tha`'s and `easyocr-th`'s are a *ThaiOCRBench score* whose direction this session could not confirm from the paper. `arXiv 2511.04479` was **VERIFIED to exist** this session and **does** introduce ThaiOCRBench ("the first comprehensive benchmark for evaluating vision-language models on Thai text-rich visual understanding"), but its abstract does not carry the per-model figures, and it is a **VLM** benchmark — running a classic OCR engine inside it is an M0 corpus assertion this session could not confirm. **Therefore A1 is a ranking, not a measurement, and no gate in §1.4 depends on it.** M2 item 1 replaces this entire column with one CER measured on one corpus.

| Axis | `paddle-onnx-th` | `tesseract-tha` | `easyocr-th` | `typhoon-vlm` | `thai-trocr-hw` |
|---|---|---|---|---|---|
| **A1 Thai printed** | **3** — vendor 82.68 % line-accuracy on a 4,261-crop vendor set ([PaddleOCR multi-language docs](http://www.paddleocr.ai/latest/en/version3.x/algorithm/PP-OCRv5/PP-OCRv5_multi_languages.html)) — UNVERIFIED-CITATION, and not a CER, not our documents | 1 — ThaiOCRBench full-page **0.614** — **UNVERIFIED-CITATION** (metric direction unconfirmed; see warning above) | 1 — ThaiOCRBench full-page **0.61** — **UNVERIFIED-CITATION**, same caveat | **4** — M0 records ThaiOCRBench **6.2 % median / 16.8 % mean** CER and SEA-DocBench 5.81/12.80. **UNVERIFIED-CITATION:** the M0 corpus attributes these to `arXiv 2609.03595`, which this session VERIFIED to be a *different* paper ("How Far Can Synthetic Data Take Thai OCR?"). The Typhoon paper is `arXiv 2601.14722`; these figures could not be confirmed against it this session | 1 — the model card's own table is `n = 104` images and it is a *handwriting* model |
| **A2 English** | 4 — the `th` model is documented "Thai, English"; PP-OCR Latin lineage is mature | **5** — `eng` is Tesseract's strongest model | 3 | 4 — vendor-stated bilingual | 2 — TrOCR-base-handwritten lineage is English; decoder is Thai Electra |
| **A3 Mixed Thai/English on one line** | **4** — one bilingual recogniser, one pass | 2 — needs `-l tha+eng`, two LSTM passes, documented script thrash | 3 | 4 | 2 |
| **A4 Numeric business fields** | 3 — digits are the easiest class for a CTC recogniser, and per-character CTC confidences are available per digit (§2.1), which is what makes a digit-level gate possible at all | **4** — per-character confidences, and `tessedit_char_whitelist` can constrain a known-numeric region | 2 — no per-character confidence | **1** — *structurally* the worst: a generative decoder can emit a plausible digit string that was never on the page, and there is no per-digit confidence to gate on. M0 D13 exists for exactly this. | 1 |
| **A5 Tables / layout** | 2 — nothing in the recogniser; PP-StructureV3 is a separate pipeline and **NO EVIDENCE** on Thai forms | 1 | 0 | **5** — layout-aware Markdown is the one thing classic OCR cannot do | 0 |
| **A6 Handwriting extensibility** | **4** — not because it reads handwriting (it does not) but because its *architecture* extends: the det⊕rec split (C4-D2) means a handwriting recogniser is a second `RegionRecognizer` over the **same** detected regions, with no change to detection, geometry, storage or provenance | 3 — same split property, weaker detector | 2 | 3 — end-to-end, nothing to split; a handwriting improvement is a whole-model swap | **5** for the recogniser slot specifically. **VERIFIED from the card this session:** *handwritten* CER **0.190034** vs EasyOCR **0.410738** / Tesseract **1.032375**; *adjusted mean* **0.123600** vs **0.298474** / **1.269101**. (The first draft of this document paired thai-trocr's handwritten CER with the baselines' **adjusted-mean** CERs — two different rows of one table. Corrected.) All on **104 images**, which the card itself flags as limiting generalisability. It is a demonstration, not a benchmark |
| **A7 Local / offline** | **5** — weights vendored at build (M0 D12); the only runtime dependency is the ONNX file | **5** — apt package + traineddata | 4 — 285 MiB of weights, torch runtime | **0** — needs a GPU that does not exist and, in the shared-estate branch, a network hop off the host | 4 — 0.1 B, CPU-runnable |
| **A8 CPU requirement** | **5** — `PP-OCRv5_mobile` measured **0.61 s/image on Intel Xeon 8350C via ONNX Runtime** ([PP-OCRv6 docs §3.3](http://www.paddleocr.ai/main/en/version3.x/algorithm/PP-OCRv6/PP-OCRv6.html)); dev box is Ice Lake with AVX512-VNNI, same µarch generation | 3 — `tessdata_best` explicitly trades speed for accuracy; two-script mode doubles it | 1 — torch CPU, 8–25 s/page estimated | **0** — CPU inference is minutes/page | 2 — a 0.1 B encoder-decoder with autoregressive decoding is far slower per line than CTC |
| **A9 GPU optionality** | **5** — GPU helps ~10× on the detector and is **never required**; the ONNX graph runs unchanged on the CUDA EP | 4 — no GPU path, but none needed | 3 | **0** — GPU is mandatory | 3 — GPU optional |
| **A10 Licensing** | **5** — **VERIFIED this session:** toolkit Apache-2.0 (PyPI `rapidocr` 3.9.2, released 2026-07-21, `requires_python >=3.8,<4`) **and** weights `apache-2.0` (HF API `cardData.license` on `PaddlePaddle/th_PP-OCRv5_mobile_rec`) | 5 — Apache-2.0; Tesseract **5.5.3 VERIFIED** as the latest release (2026-07-24, GitHub releases API) | 5 | **2** — the HF card reads `apache-2.0` (VERIFIED), but M0 §3.2's paper CC-BY-SA-4.0 claim is unreconciled **and the canonical repo id itself is unverified** (§1.1). A shipped component cannot carry an open licence question *or* an unresolved artefact identity | 5 — **VERIFIED apache-2.0** |

### 1.3 Why there is no weighted total in this section

M0 §5.2 produced a single number and the review then had to spend four paragraphs explaining that six of its inputs were unfounded. The owner's ten axes are **not commensurable**: A7 and A10 are *gates* (a 0 disqualifies regardless of the other nine), A6 is a property of *our* architecture as much as the engine's, and A1 is the only axis where any two candidates were ever measured on the same corpus — and that corpus is not ours.

**The decision is therefore made by gates, then by role, not by a total.** This is the change the panel's "state the granularity honestly" recommendation asked for, taken one step further: the matrix stops pretending to be arithmetic.

### 1.4 The gates, applied

| Gate | Rule | Fails |
|---|---|---|
| **G1 Licence certainty** | A shipped component must have a *verified, non-conflicting* licence on the exact artefact | `typhoon-vlm` (A10 = 2) → **cannot be a shipped default**; may only ever be an opt-in escalation behind §4.4's `forbid` gate |
| **G2 Runs on the approved hardware** | Must run on `linux/amd64` CPU with no GPU | `typhoon-vlm` (A7 = 0, A8 = 0) |
| **G3 Emits geometry** | Must emit a box per recognised unit, or it cannot support redaction, click-to-source or provenance | `typhoon-vlm` (emits none) |
| **G4 Deterministic** | Same bytes in ⇒ same bytes out | `typhoon-vlm` |
| **G5 Maintained** | A release within 18 months | `easyocr-th` — last release **2024-09-24**, ≈24 months stale (M0 §4.1) |

Two candidates clear all five gates: `paddle-onnx-th` and `tesseract-tha`. `easyocr-th` clears G1–G4 and fails G5, which is exactly its M0 status: **benchmark baseline, never shipped**. `thai-trocr-hw` clears G1, G2, G4, G5 and is **untested on G3** (TrOCR is a sequence model with no box output — it is a *region* recogniser, which is why §6's architecture gives it a region, not a page).

---

## 2. The two mechanism corrections that change the engineering

### 2.1 Sub-line Thai geometry EXISTS. Panel finding F1 is refuted on the mechanism.

The panel wrote: *"the fix requires (a) CTC frame→x alignment, which needs the recogniser logits that `RapidOCR.__call__` does not return."* Verified against RapidOCR `main` this session, that premise is false in both halves.

**Verified call chain** (source read this session, `RapidAI/RapidOCR` `main`):

1. [`python/rapidocr/main.py`](https://github.com/RapidAI/RapidOCR/blob/main/python/rapidocr/main.py) — `RapidOCR.__call__` accepts `return_word_box` and `return_single_char_box` as public keyword arguments (also settable as `Global.return_word_box` / `Global.return_single_char_box` in `config.yaml`, where both default to `false`).
2. [`python/rapidocr/ch_ppocr_rec/utils.py`](https://github.com/RapidAI/RapidOCR/blob/main/python/rapidocr/ch_ppocr_rec/utils.py) — `CTCLabelDecode.decode(..., return_word_box=True)` builds `selection` (the boolean mask of non-blank, non-duplicate CTC time steps), then `get_word_info(text, selection)` records `valid_col = np.where(selection)[0]` — **the CTC frame index of every decoded character** — into `WordInfo.word_cols`, and stores the per-character softmax values in `WordInfo.confs`. It also sets `line_txt_len = len(token_indices) * wh_ratio_list[i] / max_wh_ratio`, i.e. the padding-corrected number of CTC time steps.
3. [`python/rapidocr/cal_rec_boxes/main.py`](https://github.com/RapidAI/RapidOCR/blob/main/python/rapidocr/cal_rec_boxes/main.py) — `CalRecBoxes.cal_ocr_word_box()` computes `avg_col_width = (bbox_x1 - bbox_x0) / line_txt_len` (pixels per CTC frame), then `calc_box()` places each character at `center_x = (col_idx + 0.5) * avg_col_width`, half-width `avg_char_width / 2`.
4. Same file — `reverse_rotate_crop_image()` inverts the `get_rotate_crop_image` perspective matrix (`cv2.getPerspectiveTransform` → `cv2.invert`), mapping every character box **back into the coordinates of the image that was handed to `RapidOCR.__call__`**.
5. `main.py` `build_final_output()` calls `map_boxes_to_original(det_res.boxes, op_record, ori_h, ori_w)` **before** `calc_word_boxes(...)`, so both line boxes and character boxes are returned in the original input-array coordinate frame.
6. **VERIFIED, and this is the caveat that reshapes C4-D2.** `build_final_output` guards the whole word-box path:

   ```python
   if (self.return_word_box
           and det_res.boxes is not None
           and all(rec_res.word_results)):
       rec_res.word_results = self.calc_word_boxes(...)
   ```

   The character boxes are computed **only when detection ran in the same call**. `RapidOCR.__call__(use_det=False, use_rec=True, return_word_box=True)` therefore returns **no character boxes at all**, silently — the flag is accepted, the guard fails, and `word_results` is left as the recogniser produced it with no geometry attached. This is why C4-D2's call 2 is a **direct `TextRecognizer` + `CalRecBoxes` invocation** and not a second `RapidOCR.__call__`.

7. **VERIFIED, and it is what makes the direct call clean.** Both classes are independently constructible and take exactly the arguments the adapter already holds:

   ```python
   # rapidocr/ch_ppocr_rec/main.py
   class TextRecognizer:                  # constructed from a cfg dict alone
       def __call__(self, args: TextRecInput) -> TextRecOutput: ...
       # TextRecInput carries return_word_box; TextRecOutput carries
       #   txts, scores, all_word_results (None unless return_word_box=True), elapse
       # NOTE: TextRecInput has NO return_single_char_box field — that flag is
       #       consumed by CalRecBoxes, not by the recogniser.

   # rapidocr/cal_rec_boxes/main.py
   class CalRecBoxes:
       def __call__(self, imgs, dt_boxes, rec_res, return_single_char_box: bool = False)
           -> TextRecOutput: ...
   ```

   `CalRecBoxes` takes `dt_boxes` as an **argument**. The adapter cut the crops from quads it owns, so it passes those same quads and `CalRecBoxes.reverse_rotate_crop_image()` performs the inverse-perspective mapping for us — the adapter does **not** reimplement it.

**So the geometry is real, it is CTC-derived, and it is already page-referenced — provided the caller supplies the detection boxes.** What it is *not* is free of caveats, and the caveats are the contract:

**C-1 — y-extent is line-level, x-extent is character-level.** `calc_box` emits `[[char_x0, y0], [char_x1, y0], [char_x1, y1], [char_x0, y1]]` where `y0, y1` come from the **line** bounding rectangle. A character box is therefore a *vertical slice of the line*. For redaction of a horizontal run of characters — which is what a Thai national ID, a bank account number or a name is — that is exactly the right shape. It does **not** give a tight glyph box, and this document never claims it does.

**C-2 — Thai characters are classified `EN_NUM`, so the default grouping is wrong for Thai.** `get_word_info` sets `c_state = WordType.CN if has_chinese_char(char) else WordType.EN_NUM`. Every Thai codepoint is `EN_NUM`, so `is_all_en_num` is `True` for a pure-Thai line, and `cal_ocr_word_box` takes the `calc_en_num_box` branch, which unions each *space-delimited run* into one box. A Thai "word" has no spaces, so a Thai line yields **phrase-run boxes** — precisely the panel's F1 complaint, and precisely what `return_single_char_box=True` bypasses: that flag forces the `else` branch (`line_cols.extend(word_col); word_contents.extend(word)`), which emits **one box per decoded character**.

**C-3 — a real off-by-one when the line contains spaces.** `get_word_info` skips whitespace (`if char.isspace(): ... continue`) without appending its column, so `sum(len(w) for w in word_list) == len(text) − n_spaces`, while `WordInfo.confs` has one entry per decoded character **including** spaces. `cal_ocr_word_box` then returns `word_info.confs` unchanged and `main.py` does `list(zip(word_box_content_list, conf_list, word_box_list))` — a `zip` over a length-`(N − n_spaces)` sequence and a length-`N` sequence. Every confidence after the first space is attributed to the wrong character. Thai lines routinely contain spaces (Thai uses the space as a phrase and clause separator). **The adapter must not consume `confs` positionally.** It must rebuild the mapping:

```python
# services/ocr-worker/src/ocr_worker/engines/paddle_onnx/char_boxes.py
def realign_confidences(text: str, confs: list[float]) -> list[float]:
    """RapidOCR's zip() misaligns confs by one per preceding space.
    See CTCLabelDecode.get_word_info: whitespace columns are dropped from
    word_cols but retained in confs. Rebuild by index, never by position."""
    if len(confs) != len(text):
        raise EngineContractViolation("CONF_LEN_MISMATCH", len(confs), len(text))
    return [c for ch, c in zip(text, confs) if not ch.isspace()]
```

`EngineContractViolation` fails the page — it never guesses. This is the only place in the OCR path that is allowed to notice a library-version behaviour change, and it is asserted, not assumed.

**C-4 — Thai combining marks arrive as their own CTC frames, to the RIGHT of their base.** The Thai dictionary contains U+0E31, U+0E34–U+0E3A, U+0E47–U+0E4E and U+0E33 as independent tokens. CTC emits `ก` at frame *t* and its tone mark at frame *t+k*, so `calc_box` places the tone mark's box as a narrow strip **beside** the consonant, when visually it sits **above** it. A per-codepoint box is therefore geometrically wrong for Thai and must never be persisted as-is.

**The contract is per extended grapheme cluster, not per codepoint.** The adapter merges each base character with every following combining codepoint into one cluster and **unions their x-ranges**:

```python
THAI_COMBINING = frozenset(
    [0x0E31]                          # MAI HAN AKAT
    + list(range(0x0E34, 0x0E3B))     # SARA I .. PHINTHU   (U+0E34-U+0E3A)
    + list(range(0x0E47, 0x0E4F))     # MAITAIKHU .. YAMAKKAN (U+0E47-U+0E4E)
)
# NOT combining, and deliberately absent: U+0E2F PAIYANNOI, U+0E30/U+0E32 (spacing
# vowels), U+0E40-U+0E44 (PRE-posed vowels, which sit to the LEFT of their base),
# U+0E46 MAIYAMOK, U+0E4F FONGMAN, U+0E5A/U+0E5B. Each is its own cluster.

# --- U+0E33 SARA AM: two rules, and they are NOT the same rule -------------------
# TEXT rule   (frozen, m0/d D6): U+0E33 is NEVER decomposed. NFKC would split it into
#             U+0E4D U+0E32 and NFKC is banned pipeline-wide. It stays one codepoint.
# GEOMETRY rule (owned here, added by review): for BOX purposes U+0E33 is merged into
#             the preceding base consonant's cluster and its x-range is unioned in.
#             UAX #29 makes SARA AM its own extended grapheme cluster because it is
#             Lo, not Mn - but it is rendered as a nikhahit ABOVE the base plus a
#             spacing tail, so a box that excludes the base is visually wrong and a
#             redaction drawn from it leaves the consonant on the page.
THAI_GEOMETRY_MERGE_RIGHT = frozenset([0x0E33])   # merged into the preceding cluster

def to_clusters(chars: list[str], boxes: list[Quad], confs: list[float]):
    """Union the x-range of a base char with every following combining mark, and
    with a following U+0E33 per THAI_GEOMETRY_MERGE_RIGHT.
    y-range is the line's, per C-1. Confidence is the MINIMUM over the cluster,
    never the mean: a lost tone mark is the failure we are trying to see.
    A PRE-posed vowel (U+0E40-U+0E44) is its own cluster and is NOT merged: it is a
    separate CTC frame to the LEFT of its consonant and merging it would produce a
    cluster whose x-range spans two glyphs in the wrong logical order."""
```

Confidence over a cluster is the **minimum**, not the mean. A cluster whose base scored 0.99 and whose tone mark scored 0.31 is a 0.31 cluster. Averaging it to 0.65 hides the single dominant Thai failure mode (M0 §7.2) inside a number that looks acceptable.

**C-5 — a known upstream bug on inverted text.** `RapidOCR` issue [#328](https://github.com/RapidAI/RapidOCR/issues/328) and PaddleOCR issue [#14563](https://github.com/PaddlePaddle/PaddleOCR/issues/14563) report that with `return_word_box` enabled, character-box **order** is inconsistent for inverted text. Our mitigation is structural, not a patch: character boxes are only ever consumed after being sorted by projection onto the line quad's own long axis (`calc_box` already does `sorted(results, key=lambda x: x[0][0])` in crop space; we re-sort in SOURCE space after §3's transform), and the cluster merge in C-4 is order-driven by the **text**, not by the box list. A wrong box order therefore produces a wrong *geometry*, which the round-trip assertion in §3.5 catches, rather than a wrong *transcription*.

**C-6 — `return_single_char_box` is not a recogniser flag, so the two-call split must pass it to the right object.** VERIFIED: `TextRecInput` has `return_word_box` and **no** `return_single_char_box`; the flag is a parameter of `CalRecBoxes.__call__`, and inside `cal_ocr_word_box` it selects the branch directly:

```python
if is_all_en_num and not return_single_char_box:
    ... calc_en_num_box(...)      # space-delimited runs -> PHRASE boxes (wrong for Thai)
else:
    ... calc_box(...)             # one box per decoded character  (what we require)
```

Combined with C-2 (every Thai codepoint is `WordType.EN_NUM`, so `is_all_en_num` is `True` for a pure-Thai line), **omitting `return_single_char_box=True` at the `CalRecBoxes` call site silently degrades Thai to phrase-run boxes** — the exact failure panel finding F1 described, reintroduced by passing the flag one layer too high. The warmup golden-page assertion (C4-D5 point 3) therefore asserts a **character count**, not merely a decoded string: a golden Thai line of *n* clusters must return *n* cluster boxes. A phrase-run regression fails the container.

**C-7 — the golden page must contain an interior space, or C-3 is never exercised.** The `confs` misalignment in C-3 only manifests on a line that *contains* whitespace. A golden page of unbroken Thai would pass every assertion while the defect sat live in production on the first Thai clause-separated line. **Requirement: the vendored golden page contains at least one Thai line with at least one interior space, at least one Latin word, and at least one Arabic-digit run**, and the expected output is stored as an explicit per-cluster list, not a single string.

**C-8 — `Global.text_score` cannot protect the direct path, because it is not on it.** VERIFIED: `filter_by_text_score` is applied in `build_final_output`, which the direct `TextRecognizer` call never enters. Under C4-D2 the recognition path therefore performs **no score filtering at all** — which is the behaviour C4-D5 wants, but it must be recorded as *structural absence* rather than *a threshold set to zero*, because a future refactor back to `RapidOCR.__call__` would silently reintroduce a 0.5 cut-off. The pin on `Global.text_score` guards call 1 and is asserted at warmup regardless.

### 2.2 The real #1 Thai accuracy knob is `Global.use_preprocess_img`, not `det_db_unclip_ratio`

Verified from [`python/rapidocr/config.yaml`](https://github.com/RapidAI/RapidOCR/blob/main/python/rapidocr/config.yaml) on `main` this session:

```yaml
# VERIFIED verbatim this session from python/rapidocr/config.yaml on main.
Global:
    text_score: 0.5
    use_det: true
    use_cls: true
    use_rec: true
    use_preprocess_img: true
    min_side_len: 30
    max_side_len: 2000
    use_vertical_padding: true
    min_height: 30
    width_height_ratio: 8
    return_word_box: false
    return_single_char_box: false
    font_path: null
    log_level: "info"
    model_root_dir: null
Det:
    limit_side_len: 736
    limit_type: min
    thresh: 0.3
    box_thresh: 0.5
    max_candidates: 1000
    unclip_ratio: 1.6
    use_dilation: true
    score_mode: fast
Cls:
    engine_type: "onnxruntime"
    lang_type: "ch"
    model_type: "mobile"
    ocr_version: "PP-OCRv4"
    cls_image_shape: [3, 48, 192]
    cls_batch_num: 6
    cls_thresh: 0.9
    label_list: ["0", "180"]
Rec:
    rec_img_shape: [3, 48, 320]
    rec_batch_num: 6
EngineConfig:
    onnxruntime:
        intra_op_num_threads: -1     # NOT 1 - the shipped default lets ORT choose
        inter_op_num_threads: -1
        enable_cpu_mem_arena: false
```

Two of these defaults are load-bearing beyond §2.2 and are picked up later: `Det.max_candidates: 1000` bounds nothing useful once `text_score` is 0 (→ C4-D12's region caps), and `intra_op_num_threads: -1` means the shipped default is "as many threads as ORT decides", which inside a CPU-capped cgroup is the throttling failure C4-D5 closes.

and from `main.py`:

```python
def preprocess_img(self, ori_img):
    if not self.cfg.Global.use_preprocess_img:
        return ori_img, {"preprocess": {"ratio_h": 1.0, "ratio_w": 1.0}}
    img, ratio_h, ratio_w = resize_image_within_bounds(
        ori_img, self.min_side_len, self.max_side_len)
```

**The arithmetic.** An A4 page rendered at `RENDER_DPI_DEFAULT` (frozen in `f2-canonical-limits.md`; the arithmetic below is instantiated at that value, which this document does not own and does not restate as its own) is 2480 × 3508 px. `max_side_len = 2000` gives a scale of 2000 / 3508 = **0.570**. A Thai tone mark is 2–5 px tall at 300 DPI (M0 §7.2, D8); after this downscale it is **1.1–2.9 px**.

**And the loss is permanent.** In `detect_and_crop`, `crop_text_regions(img, det_res.boxes)` cuts crops from `img` — the **downscaled** array — and `build_final_output` then calls `map_img_to_original(cropped_img_list, ratio_h, ratio_w)`, which *interpolates the crops back up*. It does not re-cut them from the full-resolution source. Detail destroyed at step 1 is not recoverable at step 4.

**Three consequences the M0 corpus never states:**

1. The M0 §4 latency anchor — `PP-OCRv5_mobile = 0.61 s/image` — is almost certainly measured **with** this default active, i.e. on an image no larger than 2000 px on its long side. M0 §4's own caveat ("the vendor's per-image is almost certainly a benchmark-sized image") is therefore correct *and understated*: the number is a 2000-px number, and our own pipeline at full resolution will be slower by roughly the pixel ratio (3508/2000)² ≈ 3.1× if we simply disable the resize.
2. The `det_db_unclip_ratio` sweep the panel and M0 argued about operates on a detector that, at defaults, is looking at a 0.570× image. Sweeping the unclip ratio while the input is being halved is measuring the wrong variable — which is a *stronger* version of the panel's F2, arrived at from a different direction.
3. The panel's own premise that "RapidOCR ships `unclip_ratio = 2.0`" is **wrong on current `main`**: the shipped default is **1.6**, and `DBPostProcess.__init__`'s signature default (`unclip_ratio: float = 2.0`) is overridden by `ch_ppocr_det/main.py`'s `cfg.get("unclip_ratio", 1.6)`. Both M0 (§6: "default ~1.5") and the panel (2.0) were reading a value that is neither. This is exactly the trap M0 §9.5 half-caught ("READ the effective value at runtime") and then did not act on. **Decision C4-D5 makes reading it a boot assertion.**

**The resolution is not "turn the resize off". It is the det⊕rec split, made operational** — see decision C4-D2.

---

## 3. The coordinate contract — four spaces, one direction of truth

This is the fix for panel finding F1-secondary, and it is what makes click-to-source, redaction and provenance possible at all.

### 3.1 The four spaces

| # | Space | Definition | Unit | Origin |
|---|---|---|---|---|
| **S0** | **SOURCE** | The canonical, immutable per-page frame. **This is the only space in which geometry is persisted.** | see below | top-left, y down |
| **S1** | **RENDER** | The rasterised page at `renderDpi` | pixel | top-left, y down |
| **S2** | **DERIVATIVE** | After the preprocessing pipeline (EXIF transpose, border crop, orientation, resample, deskew) | pixel | top-left, y down |
| **S3** | **ENGINE** | The array actually handed to the engine call | pixel | top-left, y down |

**SOURCE space is defined per source kind, and the definition is normative:**

- **PDF page** — PDF *user space*, in **points (1/72 inch)**, after applying the page's `/Rotate` and translating the origin from `/CropBox` (falling back to `/MediaBox`) lower-left to **top-left with y increasing downward**. Rationale: the PDF page is the artefact of record; it is resolution-independent, so a re-render at 400 DPI produces boxes that are *comparable to* an earlier 300 DPI run rather than merely *rescalable from* it. `SourceSpaceKind.PDF_POINT`.
- **Raster upload** (JPEG/PNG/WebP/TIFF frame) — the decoded pixel raster **with EXIF orientation applied**, because that is the image a human reviewer sees and the image a redaction must be correct against. The un-transposed on-disk raster remains reproducible because `exifOrientation` is recorded. `SourceSpaceKind.RASTER_PX`.

### 3.2 The chain, and who owns each link

```
S3 ENGINE --engineToDerivative--> S2 DERIVATIVE --derivativeToRender--> S1 RENDER --renderToSource--> S0 SOURCE
```

| Link | 3×3 matrix | Owner | Value for the shipped pipeline |
|---|---|---|---|
| `engineToDerivative` | affine or homography | **this document** | **Identity** for `paddle-onnx-th`, *because* §2.1 step 5 proves RapidOCR maps boxes back to its own input array. **Non-identity** for a tiled call (see `MAX_TILES_PER_PAGE` in `f2-canonical-limits.md`): a pure translation `[[1,0,tx],[0,1,ty],[0,0,1]]`. **Never assumed** — it is recorded by the adapter, and the adapter that returns Identity must assert it. |
| `derivativeToRender` | homography | `f-preprocessing-and-confidence.md` **D16** | `PreprocessManifest.geometry.toOriginal`, adopted **verbatim and unchanged**. D16's "original" is our RENDER space. This document renames nothing in D16; it *names the space D16 was already mapping into*, which D16 left implicit and which was the reason it looked like a complete answer when it is one link of four. |
| `renderToSource` | scale + rotate + translate | **this document** | PDF: `s = 72 / renderDpi`, plus the `/Rotate` and CropBox terms. Raster: `s = 1` and the EXIF transpose is folded into SOURCE's definition, so this is Identity. |
| `engineToSource` | composed | **this document** | The product, computed and stored. |

**The composition is stored, not just the parts.** Storing only op parameters is what D16 already identified as unimplementable; storing only D16 leaves two of four links undefined.

### 3.3 The `page_renders` table

A render is `(page, run, renderDpi, pipelineVersion, recipeHash)`. It is **not** a property of the page — the frozen `uniq.document_run_seq` rule (`f1-tenant-visibility-model.md`) makes requeue a first-class operation, and a requeue may re-render at a different DPI. It is also **not** a property of an `ocr_result`, because several engines share one render (that is the whole point of §6's multi-candidate design).

```prisma
/// Append-only. One row per (page, run) render. Carries the full coordinate chain.
/// Cited constraints: composite FK per f1 TEN-1; tenant-only RLS per f1 db.rls.children.
model PageRender {
  id                    String   @id @db.Uuid                                   // uuid v7, per f1 id.internal
  organizationId        String   @map("organization_id") @db.Uuid
  documentId            String   @map("document_id") @db.Uuid
  documentPageId        String   @map("document_page_id") @db.Uuid
  runId                 String   @map("run_id") @db.Uuid

  sourceSpaceKind       SourceSpaceKind @map("source_space_kind")                // PDF_POINT | RASTER_PX
  sourceWidth           Decimal  @map("source_width")  @db.Decimal(12, 4)        // points or px
  sourceHeight          Decimal  @map("source_height") @db.Decimal(12, 4)
  sourceRotateDeg       Int      @default(0) @map("source_rotate_deg")           // PDF /Rotate: 0|90|180|270
  exifOrientation       Int?     @map("exif_orientation")                        // 1..8, raster only

  renderDpi             Int      @map("render_dpi")
  renderWidthPx         Int      @map("render_width_px")
  renderHeightPx        Int      @map("render_height_px")
  renderStorageObjectId String   @map("render_storage_object_id") @db.Uuid       // composite FK, see below

  derivativeWidthPx     Int      @map("derivative_width_px")
  derivativeHeightPx    Int      @map("derivative_height_px")
  derivativeStorageObjectId String? @map("derivative_storage_object_id") @db.Uuid

  pipelineVersion       String   @map("pipeline_version") @db.VarChar(20)        // f's semver
  recipeHash            String   @map("recipe_hash") @db.VarChar(16)             // f's recipeHash
  transformVersion      Int      @default(1) @map("transform_version")

  /// The three links, each a row-major 3x3, stored as jsonb {"m":[[..],[..],[..]]}.
  /// engineToDerivative is per-CALL, so it lives on ocr_results / region_candidates,
  /// NOT here: one render can serve several engine calls with different tiling.
  derivativeToRender    Json     @map("derivative_to_render") @db.JsonB
  renderToSource        Json     @map("render_to_source")     @db.JsonB
  /// Precomputed product derivativeToRender x renderToSource. Stored because it is read on
  /// every box projection and recomputing a 3x3 product per box is not free at 40k boxes/page.
  derivativeToSource    Json     @map("derivative_to_source")  @db.JsonB

  renderSeq             Int      @default(1) @map("render_seq")                  // 1-based, per (page, run).
                                                                                 // >1 only when c3's DPI
                                                                                 // escalation re-renders the
                                                                                 // SAME page inside one run.
  roundTripMaxErrPx     Float    @map("round_trip_max_err_px")                   // <= 0.50 normal; 0.50..2.0
                                                                                 // proceeds GEOM_DEGRADED;
                                                                                 // > 2.0 the render FAILS and
                                                                                 // this row is never written.
                                                                                 // See §3.5.
  createdAt             DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  purgedAt              DateTime? @map("purged_at") @db.Timestamptz(3)           // PDPA, see §10.3

  page     DocumentPage  @relation(fields: [documentPageId, organizationId],
                                   references: [id, organizationId], onDelete: Cascade)
  run      DocumentRun   @relation(fields: [runId, organizationId],
                                   references: [id, organizationId], onDelete: Cascade)
  render   StorageObject @relation("PageRenderImage", fields: [renderStorageObjectId, organizationId],
                                   references: [id, organizationId], onDelete: Restrict)
  derivative StorageObject? @relation("PageRenderDerivative",
                                   fields: [derivativeStorageObjectId, organizationId],
                                   references: [id, organizationId], onDelete: Restrict)
  ocrResults OcrResult[]
  regions    DocumentRegion[]

  @@unique([documentPageId, runId, renderDpi, pipelineVersion, recipeHash],
           map: "page_render_page_run_recipe_key")
  @@unique([documentPageId, runId, renderSeq], map: "page_render_page_run_seq_key")
  @@index([organizationId, documentId], map: "page_render_org_doc_idx")
  @@map("page_renders")
}

enum SourceSpaceKind { PDF_POINT RASTER_PX }
```

**Why the unique key is the whole recipe, not `(page, run)` — corrected by review.** The first draft of this table wrote `@@unique([documentPageId, runId])` two lines below prose defining a render as `(page, run, renderDpi, pipelineVersion, recipeHash)`. Those two statements cannot both be true, and the narrow one loses on evidence: `c3-ocr-routing-policy.md` owns a **within-run DPI escalation** (`OCR_ROUTE_DPI_ESCALATION_FACTOR`, `OCR_ROUTE_DPI_ESCALATION_MAX_DPI`, `OCR_ROUTE_ESCALATE_MAX_ROUNDS`), so a single run legitimately re-renders one page at a higher DPI. Under `(page, run)` the second render is a `23505` on a live job — the same defect class as the frozen `uniq.storage_original_fingerprint` and `uniq.ocr_result` fixes in `f1-tenant-visibility-model.md`, which is why it is closed here proactively rather than discovered in M2.

Both keys are composed **entirely of server-assigned values**, so `f1`'s frozen `UNIQ-1` invariant (an `@@unique` on tenant-controlled input must include `organizationId`) is satisfied without an `organizationId` member: `renderDpi` comes from c3's policy, `recipeHash` and `pipelineVersion` from the preprocessing recipe, `renderSeq` from an allocator, and `documentPageId`/`runId` are tenant-scoped by composite FK. `renderSeq` is allocated under the same `SELECT 1 FROM document_pages WHERE id = $1 FOR NO KEY UPDATE` then `max(render_seq)+1` pattern the frozen `uniq.document_run_seq` establishes for runs, so two concurrent escalations cannot collide.

**This closes a named TEN-2 violation.** `f1-tenant-visibility-model.md`'s `schema.invariants` states that TEN-2 "is the check that would have caught `DocumentPage.renderStorageObjectId`" — a bare `*Id` scalar with no relation. `DocumentPage.renderStorageObjectId` is **deleted** and replaced by `PageRender.renderStorageObjectId`, which carries a composite FK on `(id, organization_id)`. The migration is trivial because at M1 the column is empty.

**RLS: this document EXTENDS a frozen enumeration, and says so rather than assuming it.** `f1-tenant-visibility-model.md`'s frozen `db.rls.children` names its child tables explicitly — `document_pages, ocr_results, document_analyses, extraction_field_values, corrections, extraction_jobs, job_events, document_runs`. The six tables this document introduces (`page_renders`, `document_regions`, `region_candidates`, `region_consensus`, `field_value_sources`, `correction_samples`) are **not in that list**, and a table with `FORCE ROW LEVEL SECURITY` and no policy returns zero rows for every query with no error raised — which `f1`'s own `db.backup.globals` rationale identifies as the silent-failure shape. Each of the six therefore carries a **tenant-only** policy under the same rule and for the same reason (they are reachable only through an unforgeable `DocumentRef`, so a six-branch visibility predicate buys nothing the type system has not already closed). Because the enumeration is `f1`'s to own, this extension is raised as **CH-3 in §12** rather than made silently, and a startup assertion (`f1 db.backup.globals` already mandates one for `documents`) is extended to require ≥ 1 policy on each of the six.

### 3.4 The stored box type

```ts
// src/modules/ocr/domain/geometry.ts
/** A 3x3 row-major transform. Homography, not affine: perspective terms are non-zero
 *  after a border-crop dewarp (f-preprocessing D16 op `borderCrop`). */
export type Mat3 = readonly [
  readonly [number, number, number],
  readonly [number, number, number],
  readonly [number, number, number],
];

/** Clockwise from top-left. */
export interface Quad {
  readonly x1: number; readonly y1: number;
  readonly x2: number; readonly y2: number;
  readonly x3: number; readonly y3: number;
  readonly x4: number; readonly y4: number;
}

/** A quad that knows which space it is in. The brand makes a cross-space mix a
 *  compile error, which is the class of bug that produces a redaction rectangle
 *  in the wrong place on the wrong image. */
declare const SPACE: unique symbol;
export type SpacedQuad<S extends CoordSpace> = Quad & { readonly [SPACE]: S };
export type CoordSpace = 'SOURCE' | 'RENDER' | 'DERIVATIVE' | 'ENGINE';

/** The ONLY function permitted to change a quad's space brand. */
export function project<F extends CoordSpace, T extends CoordSpace>(
  q: SpacedQuad<F>, m: Mat3, to: T,
): SpacedQuad<T>;
```

**Every persisted quad is `SpacedQuad<'SOURCE'>`.** `ExtractionFieldValue.quadJson` (frozen model, `g-data-model.md`), `DocumentRegion.quadJson`, `RegionCandidate.clusterBoxesJson` — all SOURCE. The ENGINE-space quad is retained **only** inside the immutable raw payload blob (`OcrResult.payloadRef`, frozen), because raw evidence must be reproducible byte-for-byte, and a projected number is not what the engine said.

### 3.5 The round-trip assertion

```
For each PageRender, for the four page corners and 16 pseudo-random interior points
(seeded by page_render.id so the test is deterministic):

    || derivativeToSource · sourceToDerivative · p − p ||₂  ≤  0.5 px  (SOURCE=RASTER_PX)
                                                            ≤  0.12 pt (SOURCE=PDF_POINT, = 0.5 px @300 DPI)

Violation ⇒ the render FAILS. `page_renders` is not written, the job transitions to
FAILED with `GEOM_ROUNDTRIP_EXCEEDED`, and the page is never OCR'd. A page whose
geometry cannot be trusted must not produce a box a human will act on.
```

`sourceToDerivative` is **computed by inversion, never stored** — storing both directions is two facts that can disagree. Inversion of a near-singular matrix is caught by the same assertion.

**Escape hatch, numeric:** if `roundTripMaxErrPx` exceeds `OCR_GEOM_ROUNDTRIP_TOLERANCE_PX = 0.50` but is ≤ `OCR_GEOM_ROUNDTRIP_DEGRADED_MAX_PX = 2.0`, the render proceeds with `OcrWarning.GEOM_DEGRADED` and every field derived from it is forced to `flagForReview` and is **never** auto-accepted. Above 2.0 it fails. Rationale: 0.5 px at `RENDER_DPI_DEFAULT` (frozen, `f2`) is 0.042 mm — far below what a reviewer can perceive — and 2.0 px is 0.17 mm, still inside the stroke width of 8 pt Thai text, so a box is visibly on the right glyph but not tight.

**The probe count is a number, not "some points":** exactly **4** page corners plus `OCR_GEOM_ROUNDTRIP_PROBE_POINTS = 16` interior points, drawn from a PCG64 stream seeded with `page_render.id` so the same render always probes the same points and a re-run reproduces the verdict. Both bounds are asserted at boot: `0 < OCR_GEOM_ROUNDTRIP_TOLERANCE_PX < OCR_GEOM_ROUNDTRIP_DEGRADED_MAX_PX` and `OCR_GEOM_ROUNDTRIP_PROBE_POINTS >= 8`. A tolerance of 0 is refused — floating-point composition of three homographies cannot round-trip exactly, so 0 would fail every page.

---

## 4. Decisions

Each decision states: **competing proposals → selected → rejected → reason → implementation → migration → security → config/env**.

### C4-D1 — PRIMARY OCR PROVIDER

**Competing proposals.** (P1) M0 D1: `th_PP-OCRv5_mobile_rec` on RapidOCR/ONNX, monolithic `RapidOCR.__call__`. (P2) Promote `typhoon-vlm` to primary (M0 S1/S4/S6). (P3) `tesseract-tha` as primary for its per-word boxes. (P4) Native `paddlepaddle` runtime.

**Selected.** **`paddle-onnx-th`** — the pinned immutable triple

```
det : PP-OCRv5_mobile_det
rec : th_PP-OCRv5_mobile_rec
dict: ppocrv5_th_dict.txt
```

executed on **`rapidocr` 3.9.2 / ONNX Runtime**, invoked as a **two-call detector ⊕ recogniser split** (C4-D2), with `return_word_box=True, return_single_char_box=True`.

**Rejected.** P2 fails gates G1, G2, G3 and G4 (§1.4) — four independent disqualifications, not a close call; the M0 S4/S6 flip conditions both require a GPU that `m-docker-nginx-resources.md` §4.9.2 forbids sharing and that nobody has budgeted. P3 scores A1 = 1 on the product's core axis; its per-word boxes are a phrase run in Thai (M0 `f` §1.2(c)) and are in any case now matched by §2.1's per-cluster boxes. P4 is rejected on packaging, not speed: the vendor's own controlled row for our tier is ONNX RT 0.61 s vs OpenVINO 0.78 s vs Paddle 0.80 s — a ~25 % edge, which alone would not decide it; the deciding factor is that `paddlepaddle` adds a multi-GB framework to a container that `f2-canonical-limits.md` caps at `WORKER_MEMORY_LIMIT_BYTES = 2 GiB`.

**Reason.** It is the only candidate that passes all five gates *and* scores ≥ 3 on A1, and — new since M0 — it is the only candidate that can emit **per-cluster Thai geometry with per-cluster confidence** (§2.1), which is what A4 (numeric business fields), redaction, click-to-source and the entire §7 consensus layer are built on. The weights licence is now **verified Apache-2.0**, closing M0 §12 spike 6.

**Implementation consequence.** The adapter is `services/ocr-worker/src/ocr_worker/engines/paddle_onnx/`. It makes **two** RapidOCR calls per page (C4-D2). It owns `realign_confidences` (§2.1 C-3) and `to_clusters` (§2.1 C-4). It asserts `engineToDerivative == Identity` and fails the page if the returned line boxes fall outside the input array bounds.

**Migration consequence.** The triple is versioned as **one artefact**, never as three parts: `engineVersion = 'ppocrv5-th@det:v5m/rec:v5th/dict:20260611/rt:onnx-3.9.2'`. Changing any part changes `engineVersion`, which changes `ocr.calibration_key` (C4-D6), which invalidates the calibration map, which forces `calibratedP = null`, which the existing hard gates already handle. A swap therefore **fails closed**, which is the panel's ops finding (3) closed at its root.

**Security consequence.** The worker holds a parser for attacker-supplied binaries and, per `f3-ai-call-placement.md`'s `ai.services.no_egress`, sits on `ocr-internal` with `internal: true` and **no default route**. `paddle-onnx-th` has no network dependency at runtime: model weights are vendored at build with pinned SHA-256 (M0 D12), and `Global.model_root_dir` is set to the vendored directory so RapidOCR's ModelScope auto-download path is never reached. C4-D5 turns the SHA-256 check from a build-time-only guard into a `warmup()` assertion.

**Config/env consequence.** See C4-D5 for the complete pinned config. `OCR_ENGINE_PRIMARY_ID=paddle-onnx-th`.

### C4-D2 — Two-call detector ⊕ recogniser split, with an anisotropic short-axis pad

**Competing proposals.** (P1) M0 D4: "adopt an explicit split", implemented as `det_model_path` / `rec_model_path` config on one `RapidOCR.__call__` — a *configuration* split, not a *call* split. (P2) Panel F2's safer alternative: insert an anisotropic pad between detection and `get_rotate_crop_image`. (P3) Do nothing; sweep `det_db_unclip_ratio`.

**Selected.** A genuine **two-call** split. **Call 2 is a direct component invocation, not a second `RapidOCR.__call__`** — see the corrected mechanism note below, which is the single most consequential change the review made to this document.

```
call 1  RapidOCR(use_det=True,  use_cls=False, use_rec=False)  on a page downscaled to
        OCR_DET_LONG_SIDE_PX = 1600 on its long side (Lanczos), Global.use_preprocess_img=False
   ↓    scale boxes by 1/s back into DERIVATIVE space (s = 1600 / max(w,h))
   ↓    apply the anisotropic short-axis pad: expand each quad along its own local
        SHORT axis by OCR_DET_SHORT_AXIS_PAD_FRAC = 0.18 x h_short. Long axis untouched.
   ↓    clamp every padded quad to the derivative bounds; drop degenerate quads
   ↓    cut crops from the FULL-RESOLUTION derivative with get_rotate_crop_image
   ↓    (optional) TextClassifier on the crops - 180-degree line orientation
call 2  rec_out = TextRecognizer(TextRecInput(img=crops, return_word_box=True))
   ↓    rec_out = CalRecBoxes()(imgs=crops,
   ↓                            dt_boxes=<the SAME padded quads, DERIVATIVE space>,
   ↓                            rec_res=rec_out,
   ↓                            return_single_char_box=True)
```

**Why call 2 cannot be `RapidOCR.__call__(use_det=False, ...)` — VERIFIED, and the first draft of this document had it wrong.** `build_final_output` guards the entire word-box path with `det_res.boxes is not None` (§2.1 step 6). A `use_det=False` call has no `det_res.boxes`, so `return_word_box=True` is **accepted and then ignored**: no character boxes, no per-cluster confidences, no `WordInfo`, and no error. Every downstream claim in this document — `ocr.sub_line_geometry`, the per-cluster confidence rule, cluster-level consensus, click-to-source, sub-line redaction — would have been built on a flag that does nothing. The two-call split as first drafted would have deleted the capability it exists to deliver.

The fix is not a fork and not a patch. VERIFIED (§2.1 step 7): `TextRecognizer` is constructible from a `cfg` dict alone, `TextRecInput` carries `return_word_box`, `TextRecOutput` carries `all_word_results`, and `CalRecBoxes.__call__(imgs, dt_boxes, rec_res, return_single_char_box)` takes the detection boxes **as an argument**. The adapter already owns those quads — it cut the crops from them — so it passes them straight in and `CalRecBoxes.reverse_rotate_crop_image()` performs the inverse-perspective mapping back to DERIVATIVE space for us. Two consequences: `return_single_char_box` must be passed to `CalRecBoxes`, **not** to the recogniser (C-6, it is not a `TextRecInput` field); and the first draft's claim that "the adapter therefore supplies the inverse itself… this is 20 lines" is **withdrawn** — the adapter supplies the *boxes*, the library supplies the *inverse*, and the 20 lines do not exist.

**Rejected.** P1 is cosmetic: a configuration split still cuts recogniser crops from whatever array detection ran on, so it cannot decouple detection resolution from recognition resolution — which is the *only* thing the split is for. P3 is rejected on the mechanism verified in §2.2 and on the panel's own isotropy argument: `distance = poly.area * unclip_ratio / poly.length` is an isotropic `pyclipper` offset, so raising it to reach a 2 px tone mark also reaches ~0.35·h *sideways*, merging the dotted-leader fields and borderless columns of exactly the Thai government forms this product exists to read.

**Reason, with the arithmetic.**
- **Detection is resolution-tolerant; recognition is not.** A DB detector's job is "is there ink here"; PP-OCR detectors are trained around 736–960 px. At `OCR_DET_LONG_SIDE_PX = 1600`, an A4@300 page (3508 px) downscales by 0.456, so a 44 px Thai line becomes 20 px — comfortably inside the detector's trained regime — while the recogniser still sees the **full 44 px**, which is the panel's own `h_line_target = 44 px` from `f` P5, now actually delivered.
- **Detection cost falls 4.8×** versus running detection at full resolution (3508² / 1600² = 4.81), which is what makes disabling `use_preprocess_img` affordable at all. Detection at 1600 px long side is 1600 × 1131 = 1.81 Mpx, against 8.79 Mpx full-resolution and 2000 × 1414 = 2.83 Mpx at RapidOCR's destructive default. **We are cheaper than the shipped default and lose nothing**, because the loss the default causes is in *recognition*, and recognition no longer uses that array.
- **The pad is anisotropic, so it cannot merge columns.** 0.18 × h_short at a 44 px line is 7.9 px of extra reach per side vertically and **0 px horizontally**. A 2–5 px tone mark clipped at the top is recovered; a dotted leader 30 px to the right is not reached.

**Implementation consequence.** `engineToDerivative` is Identity for call 1 (boxes are mapped back by `map_boxes_to_original`) and a **per-crop** perspective transform for call 2 — which `CalRecBoxes` inverts for us **because we hand it `dt_boxes`**, not because `RapidOCR.__call__` did. The adapter's obligation is to pass the *identical* quad array it cut the crops from, in the *same order*; a mismatch there is a silent geometry corruption, so the adapter asserts `len(crops) == len(dt_boxes)` and that every returned character box lies inside its own line quad (§3.5 catches the rest). This is also why `engineToDerivative` is a per-**call** field rather than a per-render one (§3.3): a tiled page (frozen `MAX_TILES_PER_PAGE`, `f2`) runs call 1 once per tile with a different translation each time.

Two further implementation notes the direct call forces into the open, both of which are improvements:
- **Orientation classification is now explicit.** `RapidOCR.__call__` would have run `TextClassifier` for us. The adapter must invoke it deliberately on the crops, or record `clsApplied = false`. An implicit 180° flip that nobody chose is worse than one that is configured.
- **Score filtering is structurally absent on the recognition path** (C-8), which is the intent of C4-D5's `text_score: 0.0` and is now true by construction rather than by configuration.

**Migration consequence.** `OCR_DET_LONG_SIDE_PX` and `OCR_DET_SHORT_AXIS_PAD_FRAC` are inputs to `detParamsHash`, which is part of `ocr.calibration_key` (C4-D6). Changing either invalidates the calibration map and forces review, rather than silently shifting the score distribution under an auto-accept gate. The M2 sweep is `OCR_DET_SHORT_AXIS_PAD_FRAC ∈ {0, 0.10, 0.18, 0.26, 0.34}` scored on **diacritic-restricted CER** (M0 §10 metric 2) *and* on **merge rate** (boxes per page ÷ ground-truth line count), so a merge-driven regression is visible rather than hidden inside an aggregate CER improvement.

**Security consequence.** Two calls double the number of engine invocations per page but not the parsing surface — the same decoded array is used for both, and no new file format is parsed. The pad is a pure geometry op on validated quads; it is clamped to the derivative bounds before cropping, so a malformed quad from a hostile page cannot index outside the array.

**Config/env consequence.** `OCR_DET_LONG_SIDE_PX=1600`, `OCR_DET_SHORT_AXIS_PAD_FRAC=0.18`.

### C4-D3 — SECONDARY / FALLBACK PROVIDER: `tesseract-tha`, role renamed **CORROBORATOR**

**Competing proposals.** (P1) M0 D5: Tesseract as availability FALLBACK for "the network is down". (P2) The panel's ops alternative (a): define a real failover contract with a separate container. (P3) The panel's ops alternative (b): relabel it "benchmark floor + Latin-only degraded mode" and fail closed. (P4) No secondary at all.

**Selected.** `tesseract-tha` ships, in **three named roles and no others**:

| Role | What it does | When |
|---|---|---|
| **CORROBORATOR** | Runs as a second `RegionRecognizer` over the **same regions** the primary recognised, producing an independent candidate that feeds the §7 consensus layer | On the region set defined by `OCR_CORROBORATE_SELECTOR` (§7.6) — **not** on every region |
| **BENCHMARK FLOOR** | The M2 corpus baseline | M2 only |
| **LATIN DEGRADED MODE** | If the primary's `warmup()` integrity check fails, `-l eng` only, on documents whose `languageHints` contain no `th` | Never on a Thai-expected page |

**There is NO availability failover, and this is stated so it cannot be assumed.** If `paddle-onnx-th` is unavailable on a Thai-expected page, the job **fails closed** with `ENGINE_UNAVAILABLE` and the document enters the review queue. It does not silently degrade to an engine scoring 0.614 on ThaiOCRBench full-page.

**Rejected.** P1 is rejected on the panel's verified argument: the primary has no network dependency (weights vendored, `HF_HUB_OFFLINE=1`, no egress), so "the network is down" is not one of its failure modes, and both engines run in the same container and share fate for every failure class that actually pages someone (OOMKill, crashloop, disk-full). P2 is rejected on cost: a separate container for an engine we would never let write a Thai record buys availability we have just shown we do not want. P4 is rejected because a single-source transcription can never exceed `SINGLE_SOURCE` in §7's consensus outcomes, which would make the auto-accept path unreachable for every field — the product would be 100 % manual review.

**Reason.** Tesseract's value was never availability. It is **statistical independence**: a different training corpus, a different architecture (line LSTM vs CTC-CRNN), a different failure mode. Two engines that fail on the same pages provide no information; two engines that fail on *different* pages let §7 detect the failure without ground truth. That is worth more than a fallback that would emit plausible-but-wrong Thai into an audit-grade record.

**Implementation consequence.** `services/ocr-worker/src/ocr_worker/engines/tesseract/`, invoked through the same `RegionRecognizer` port as the primary, on the same region crops, with `--psm 7` (single text line) since the region *is* a line.

**Its geometry granularity is `'line'` at M1, not `'cluster'` — corrected by review.** The first draft declared `emitsSubLineGeometry: 'cluster'` and justified it with "`tsv` output plus `hocr` for char boxes". That is wrong in two ways and it matters, because a fabricated granularity claim is precisely the fault panel finding F1 raised:

- **TSV is word-level.** Tesseract's TSV renderer emits one row per word (`level 5`); there is no symbol level in it. And per `f-preprocessing-and-confidence.md` §1.2(c), **a Tesseract "word" in Thai is a phrase run**, because Thai has no inter-word spaces. Word-level Thai geometry *is* line geometry.
- **Per-symbol boxes exist, but only behind a config flag.** VERIFIED this session in `src/api/hocrrenderer.cpp`: `GetBoolVariable("hocr_char_boxes", &hocr_boxes)`, and when set the renderer emits `<span class='ocrx_cinfo' title='x_bboxes …'>` from `res_it->BoundingBox(RIL_SYMBOL, …)`. So the invocation is `--psm 7 -c hocr_char_boxes=1` with the hOCR renderer — **not** TSV, and not default hOCR.
- **What a Thai `RIL_SYMBOL` actually is remains UNVERIFIED.** The LSTM engine's symbol boundaries are its own output units; whether a Thai base consonant and its above-vowel arrive as one symbol, two symbols, or one symbol with the mark absorbed is an empirical question this session could not answer without running the engine.

**Shipped position.** `tesseract-tha` declares `emitsSubLineGeometry: 'line'` at M1 and returns `ClusterSpan[]` with `quad = null` — which §6.5 already proves the port absorbs, and which changes nothing about its consensus role, because consensus aligns on **text** clusters and only *reads* quads. Promotion to `'char'` requires M2 measurement item 7 (§11) to show that Thai `ocrx_cinfo` boxes are per-cluster-or-finer and land inside their own line quad on ≥ 99 % of sampled Thai lines. Until then the corroborator votes on text and contributes no geometry, and `FieldProvenance.geometryGranularity` reports the winner's granularity honestly.

Projection, when it is eventually enabled, needs no new geometry code: the corroborator inherits `engineToDerivative` from the crop it was given and rides the same §3 chain.

**On `pytesseract`.** It is a subprocess wrapper around the `tesseract` **CLI**, not a binding to `libtesseract`. The §1.1 runtime column is corrected accordingly. This is not a defect — the CLI exposes `-c hocr_char_boxes=1` and `--psm 7` — but it fixes the per-invocation cost at one process spawn plus one traineddata load, which is why `OCR_CORROBORATE_SELECTOR` (§7.6) and c3's line caps (§13) both exist, and why the corroborator is batched per page rather than called per region.

**Migration consequence.** `tesseract-tha`'s consensus weight is a config value (`OCR_CONSENSUS_WEIGHT_TESSERACT_THA = 0.45`, §7.3), so demoting it to weight 0.0 after M2 is a config change with no schema impact, and its historical candidates remain in `region_candidates` as evidence of what the system believed at the time.

**Security consequence.** Tesseract 5.5.3 parses only the crop bitmaps we hand it, never a container file — `pdftoppm`/`poppler` is explicitly **not** installed (M0/`m` §2.5.3 excludes `poppler-utils` in favour of in-process `pypdfium2`). Its traineddata is vendored with pinned SHA-256 under the same C4-D5 assertion as the primary's ONNX files.

**Config/env consequence.** `OCR_ENGINE_CORROBORATOR_ID=tesseract-tha`, `OCR_CORROBORATE_SELECTOR` (§7.6), `OCR_CONSENSUS_WEIGHT_TESSERACT_THA=0.45`.

### C4-D4 — HANDWRITING FUTURE PROVIDER STRATEGY

**Competing proposals.** (P1) Ship nothing and design nothing (M0's actual position — handwriting appears once, as owner question 11). (P2) Ship `thai-trocr-hw` now. (P3) Ship `typhoon-vlm` for handwriting now. (P4) Reserve the architecture, name the candidate ladder, gate each rung numerically, ship no recogniser.

**Selected. P4.** **No handwriting recogniser ships in M1, M2 or M3.** The architecture in §5–§9 is built so that adding one is *registering a `RegionRecognizer`* — not a schema migration, not a geometry change, not a provenance change. The candidate ladder, in evaluation order:

| Rung | Candidate | Verified evidence | Entry gate (all must hold) |
|---|---|---|---|
| **H1** | `thai-trocr-hw` — `openthaigpt/thai-trocr`, Apache-2.0, 0.1 B params, encoder TrOCR-base-handwritten + Thai Electra-small decoder | **VERIFIED from the card this session.** *Handwritten* CER **0.190034** vs EasyOCR **0.410738** / Tesseract **1.032375**; *adjusted mean* **0.123600** vs **0.298474** / **1.269101**. On **104 images**, which the card itself flags as limiting generalisability. A demonstration, not a benchmark. | median CER ≤ **0.15** and p95 CER ≤ **0.40** on ≥ **300** human-labelled Thai handwritten line crops drawn from ≥ 3 real document classes, at ≤ **2.5 s/line** on the shipped CPU allocation |
| **H2** | `typhoon-vlm` — `typhoon-ocr1.5-2b` (2 B, Qwen3-VL-2B base). **Canonical repo id UNVERIFIED** (§1.1) | **UNVERIFIED-CITATION.** M0 records handwriting **19.36 % median / 21.86 % mean** CER and "easy handwriting" 9.02/15.74, attributed to `arXiv 2609.03595`. That arXiv id is VERIFIED this session to be a *different* paper; the Typhoon paper is `arXiv 2601.14722` and the figures could not be confirmed against it. The card's own published comparison is BLEU / ROUGE-L / Levenshtein, **not CER**. | H1 fails **AND** a GPU is approved **AND** the weights-licence conflict is resolved in writing **AND** the canonical repo id is established **AND** it runs in `ocr-ai-worker` per `f3-ai-call-placement.md`'s `ai_call_owner` **AND** the tenant has not set `forbid.generative` **AND** its handwriting CER is re-measured by us on the H1 corpus — an unverified vendor number may not open a generative rung |
| **H3** | A commercial Thai handwriting API | M0 §3.12 (iApp et al.) | H1 and H2 both fail **AND** the owner accepts a named data processor in the RoPA **AND** the tenant opts in per-document |

**Rejected.** P1 is rejected because the owner's stated ceiling is a platform that outperforms basic OCR, and the region/candidate/consensus structure cannot be retrofitted cheaply — it changes the shape of `extraction_field_values`' provenance, which by then holds production evidence. P2 is rejected on evidence quality: `n = 104` is not a basis for shipping a recogniser whose output would enter an audit-grade record. P3 is rejected on four gates simultaneously (§1.4 G1–G4).

**Reason.** Every Thai handwriting number available to us sits around or above **19–21 % CER**, and — importantly for a decision this size — that now rests on **two independent sources rather than one**, only one of which is verified:

- **VERIFIED this session:** `arXiv 2609.03595` ("How Far Can Synthetic Data Take Thai OCR?") reports its model at **1.24 % CER on printed pages and 20.55 % CER on handwriting**. A ~16× gap between printed and handwritten Thai, from a paper this session actually read.
- **UNVERIFIED-CITATION:** M0's Typhoon 1.5 figures (19.36 % median / 21.86 % mean), whose attributed arXiv id is now known to be wrong.

The decision does **not** depend on the unverified number: the verified 20.55 % alone establishes the point. A ~20 % CER on a handwritten amount field is not a product feature, it is a liability — roughly one wrong character in five, on a value someone will pay against. The correct engineering response is to make handwriting a **first-class region kind with a candidate slot and a mandatory human-review path**, and to ship the recogniser only when a real benchmark says it beats the human-review cost.

**Implementation consequence.** `RegionRecognizer` (§6.3) is defined and has two implementations at M1 (`paddle-onnx-th`, `tesseract-tha`). `DocumentRegion.kind` includes `HANDWRITTEN` from day one, and a `HANDWRITTEN` region with no registered handwriting recogniser produces **zero candidates**, `consensusOutcome = NO_CANDIDATE`, and a mandatory review item — never an empty string, never a printed-engine guess.

**Migration consequence.** Adding H1 is: one adapter file, one registry line, one row in `OCR_CONSENSUS_WEIGHTS`, one calibration map. No table changes. That claim is testable now — §6.5 is the abstraction test, and unlike M0 §9.3 it is run against an engine with a *different* geometry granularity, which is the shape M0's test could not express.

**Security consequence.** H2 and H3 are generative and/or off-host. Both are structurally unreachable unless `Organization.aiEgressPolicy` permits it, enforced in the registry (§4.4), and H2's socket is owned by `ocr-ai-worker` per the frozen `ai_call_owner` — the OCR worker never gains egress to add handwriting.

**Config/env consequence.** `OCR_HANDWRITING_RECOGNIZER_ID` — **empty string is the shipped value and means "no handwriting recogniser registered"**. Unset is a boot refusal (three-state semantics, mirroring the frozen `ai.stage_enabled.semantics`).

### C4-D5 — The pinned RapidOCR configuration, asserted at boot

**Competing proposals.** (P1) M0 §9.5: "start 1.8" for `unclip_ratio`, other params unstated. (P2) The panel: re-centre the sweep on 2.0, "the value actually read at runtime". (P3) Pin every accuracy-relevant parameter explicitly and assert the effective value at `warmup()`.

**Selected. P3.** The adapter ships this config, and **asserts every line of it against the live objects at `warmup()`**, refusing to start on any mismatch:

```yaml
# services/ocr-worker/config/rapidocr.pinned.yaml  — generated from config/limits.yaml
# where a value is a frozen limit; see f2-canonical-limits.md LIMITS_SOURCE_OF_TRUTH.
Global:
  use_preprocess_img: false        # C4: the shipped default (max_side_len 2000) downscales
                                   # A4@300 by 0.570 and the loss is unrecoverable. See §2.2.
  text_score: 0.0                  # C4: the default 0.5 SILENTLY DELETES lines below 0.5 in
                                   # filter_by_text_score(). An audit product must never discard
                                   # evidence in the engine. Filtering is a downstream decision
                                   # made with a recorded threshold.
                                   # SCOPE (C-8): filter_by_text_score lives in
                                   # build_final_output, which C4-D2's direct TextRecognizer call
                                   # never enters. This pin therefore guards CALL 1 only; on the
                                   # recognition path filtering is structurally absent. Asserted
                                   # anyway, so a refactor back to RapidOCR.__call__ cannot
                                   # silently reintroduce a 0.5 cut-off.
  return_word_box: true            # C4-D1: required for sub-line geometry, §2.1.
                                   # Passed to TextRecInput on call 2.
  return_single_char_box: true     # C4-D1: forces per-character boxes; without it a Thai line
                                   # takes the calc_en_num_box branch and yields phrase runs.
                                   # C-6: this is NOT a TextRecInput field. On call 2 it is
                                   # passed to CalRecBoxes.__call__. Pinned here so the value is
                                   # single-sourced and warmup-asserted.
  use_vertical_padding: true
  min_height: 30
  width_height_ratio: 8
  model_root_dir: /opt/models/rapidocr     # vendored, offline; ModelScope never reached
  font_path: null
  log_level: "warning"
Det:
  engine_type: onnxruntime
  ocr_version: PP-OCRv5
  model_type: mobile
  lang_type: ch                    # the v5 mobile DETECTOR is language-agnostic; only rec is 'th'
  limit_type: min
  limit_side_len: 736              # with the 1600px pre-scale of C4-D2, ratio == 1.0 always
  thresh: 0.30
  box_thresh: 0.50
  max_candidates: 1000
  unclip_ratio: 1.6                # the VERIFIED shipped default on main; NOT 1.5 (m0/d §6) and
                                   # NOT 2.0 (panel F2). Secondary M2 sweep only. See §12 CH-1.
  use_dilation: true
  score_mode: fast
Cls:
  engine_type: onnxruntime         # 180-degree line classifier. Pinned in full, because a
  ocr_version: PP-OCRv4            # partially-pinned section is a section whose unpinned keys
  model_type: mobile               # can drift without failing the warmup assertion.
  lang_type: ch
  cls_image_shape: [3, 48, 192]
  cls_batch_num: 6
  cls_thresh: 0.90
  label_list: ["0", "180"]
Rec:
  engine_type: onnxruntime
  ocr_version: PP-OCRv5
  model_type: mobile
  lang_type: th
  rec_img_shape: [3, 48, 320]
  rec_batch_num: 6
EngineConfig:
  onnxruntime:
    intra_op_num_threads: 1        # C4: set HERE, not via ORT_INTRA_OP_NUM_THREADS, which is not
    inter_op_num_threads: 1        # an ONNX Runtime environment variable. See below.
                                   # VERIFIED: the shipped default for BOTH is -1 ("let ORT
                                   # decide"), so this is a real change, not a restatement of a
                                   # default. -1 inside a CPU-capped cgroup is the CFS-throttling
                                   # failure m P3's sizing formula silently assumed away.
    enable_cpu_mem_arena: false    # VERIFIED: already the shipped default. Pinned so that an
                                   # upstream flip to true fails the warmup rather than silently
                                   # raising RSS against f2's WORKER_MEMORY_LIMIT_BYTES.
```

**Rejected.** P1 and P2 both centre a sweep on a number neither had read. §2.2 shows the shipped default is 1.6 and that both prior values were wrong; more importantly, the parameter is the *fourth* most important knob, behind `use_preprocess_img`, the det/rec resolution split, and the anisotropic pad.

**Reason.** M0 §9.5 already contained the right instinct — *"the default is NOT a single stable number… READ the effective value at runtime"* — and then did not act on it, which is how the corpus ended up with three different values for one parameter. An assertion converts a documentation problem into a deploy-time failure.

**Implementation consequence.**

```python
# services/ocr-worker/src/ocr_worker/engines/paddle_onnx/warmup.py
PINNED = load_yaml("config/rapidocr.pinned.yaml")

def warmup(ocr: RapidOCR) -> str:
    # 1. Effective-config assertion: compare the LIVE objects, not the YAML we passed in.
    effective = {
        "Global.use_preprocess_img": ocr.cfg.Global.use_preprocess_img,
        "Global.text_score":         ocr.text_score,
        "Global.return_word_box":    ocr.return_word_box,
        "Global.return_single_char_box": ocr.return_single_char_box,
        "Det.unclip_ratio":  ocr.text_det.postprocess_op.unclip_ratio,   # the object, not the cfg
        "Det.limit_type":    ocr.text_det.preprocess_op.limit_type,
        "Det.limit_side_len": ocr.text_det.preprocess_op.limit_side_len,
        "Rec.rec_img_shape": ocr.text_rec.rec_image_shape,
    }
    for k, want in flatten(PINNED).items():
        if effective[k] != want:
            raise EngineConfigDrift(k, want, effective[k])   # container refuses to start

    # 2. Artefact integrity, at RUNTIME not only at build (m0/d §8A.2 asked; D12 only guarded build).
    for path, want_sha in MODEL_SHA256.items():
        got = sha256_file(path)
        if got != want_sha:
            raise ModelIntegrityFailure(path, want_sha, got)

    # 3. Golden-page assertion. The golden page is NOT a smoke test; it is the only control
    #    that catches a silent capability loss. Per C-6 and C-7 it MUST contain:
    #      - >= 1 Thai line with >= 1 INTERIOR SPACE      (exercises C-3's confs realignment)
    #      - >= 1 Thai line with >= 1 above-vowel/tone mark and >= 1 U+0E33
    #      - >= 1 Latin word and >= 1 Arabic digit run    (exercises the EN_NUM branch)
    #    and the expected output is stored as an explicit PER-CLUSTER list, never one string.
    #    It asserts, in this order:
    #      (a) byte-exact rawText per line;
    #      (b) cluster COUNT per line == expected  <-- catches a silent fall-back to
    #          calc_en_num_box phrase runs, which would still decode correctly (C-6);
    #      (c) TextRecOutput.all_word_results is not None and is populated for every crop
    #          <-- catches the C4-D2 call-path regression: a return to
    #              RapidOCR.__call__(use_det=False) leaves this None and nothing else notices;
    #      (d) every cluster box lies inside its own line quad;
    #      (e) round-trip within OCR_GEOM_ROUNDTRIP_TOLERANCE_PX.
    #    (a) is also the determinism assertion: it is what makes capabilities.deterministic=true
    #    checkable across an ONNX Runtime upgrade that changes FP reduction order.
    assert_golden_page(ocr)
    return engine_version_string()
```

**Migration consequence.** A RapidOCR upgrade that changes any default fails the container at start, in staging, loudly — instead of shifting the score distribution under a live auto-accept gate. This is the panel's ops finding (3) closed at the *engine* layer, complementing C4-D6's closure at the *calibration* layer.

**Security consequence.** Point 2 turns M0's `engine_version()` from a label into an enforced integrity check, which §8A.2 asked for and D12 delivered only at build time. A tampered ONNX file on a mounted volume is now caught at every container start, not at the one build that happened months ago.

**Config/env consequence.** `OCR_RAPIDOCR_CONFIG_PATH=/app/config/rapidocr.pinned.yaml`, `OCR_MODEL_ROOT_DIR=/opt/models/rapidocr`, `OCR_ENGINE_STRICT_CONFIG=true` (no false path exists in production; the variable exists so a benchmark harness can sweep, and setting it false is **refused when `OCR_ENV=production`**).

> **Corrected by review.** The first draft gated this on `NODE_ENV=production`. The OCR worker is a **Python** process (`services/ocr-worker/src/ocr_worker/`); `NODE_ENV` has no meaning inside it, is not set by the worker's compose service, and would therefore never equal `production` — so the guard that refuses to disable the integrity assertions would have been permanently open. `OCR_ENV` is the environment variable `c1-storage-key-contract.md` already established across the estate, and it is cited here rather than re-invented. Any variable named `NODE_ENV_*` or `NEXT_*` appearing in a worker-side contract is a category error and should be reported as one.

**On `ORT_INTRA_OP_NUM_THREADS`.** The panel verified that `ORT_INTRA_OP_NUM_THREADS` is not an ONNX Runtime environment variable and that Eigen-based builds do not honour `OMP_NUM_THREADS`; `intra_op_num_threads` must be set through `SessionOptions` ([ORT thread management](https://onnxruntime.ai/docs/performance/tune-performance/threading.html)). RapidOCR exposes exactly that as `EngineConfig.onnxruntime.intra_op_num_threads`, so the fix is a config line, not a patch. The env vars in `m` §2.2 must be **deleted**, because leaving an inert variable in a compose file is a booby trap for whoever later wonders why threading is not applied.

### C4-D6 — `ocr.calibration_key`: the 12-tuple

**Competing proposals.** (P1) `f-preprocessing-and-confidence.md` §2.4 Step 5: `(engine, engineVersion, modelId, scriptTag, spanKind)`. (P2) The panel's 10-tuple. (P3) Hash everything that could shift the score distribution, and make an unseen key a deploy gate.

**Selected. P3.** 

```
ocr.calibration_key = (
  engineId, engineVersion, modelTripleHash, backend, backendVersion,
  renderDpi, detParamsHash, preprocessPipelineVersion, recipeHash,
  scriptTag, spanKind, consensusVersion
)
```

`spanKind ∈ {'cluster','line','page','region'}` — new member `region`, because §7 scores regions. `consensusVersion` is included because a change to the §7 weights or thresholds changes what "accepted" means, and a calibration map fitted under one consensus rule does not transfer to another.

**Rejected.** P1 omits backend, DPI, det params and pipeline version — every one of which the M0 corpus itself treats as a tunable or an ablation, which is how one map ends up serving three distributions. P2 omits `recipeHash` and `consensusVersion`.

**Reason, and the failure it prevents.** `f` §2.6's critical-field gate auto-accepts `grandTotal` / `vatAmount` / `bankAccountNumber` at `T_ocr = 0.98`. Under P1, flipping `renderDpi` from 300 to 400 — a per-request field in the M0 port — leaves the key unchanged and keeps emitting `calibratedP` from a map fitted on a different distribution. The failure is **silent**, it is on payment-affecting fields, and the only drift monitor recomputes ECE monthly against a human-reviewed sample from which auto-accepted fields are, by construction, absent.

**Implementation consequence.** `calibrationKey` is stored as a `VarChar(64)` sha256 of the canonical tuple on every `RegionCandidate` and every `ExtractionFieldValue`, plus the tuple itself in a `calibration_maps` lookup table. An unseen key yields `calibratedP = null`, which the existing hard gates 5/7/8 already handle correctly — **no new gate logic, one wider key.**

**Migration consequence.** A **deploy gate**: the worker image refuses to start in production if any `(engineId × backend × renderDpi × spanKind)` combination it is configured to serve has no calibration map with `ECE ≤ 0.05`. Every "easy" swap becomes a visible, blocking, staffable event instead of a silent-wrongness path.

**Security consequence.** None directly. Indirectly it removes an integrity failure in a financial-value path, which is the class of bug an attacker does not need to cause and a customer will discover.

**Config/env consequence.** `OCR_CALIBRATION_REQUIRE_MAP=true` (production; refusing to start), `OCR_CALIBRATION_MAX_ECE=0.05`, `OCR_CALIBRATION_AUDIT_SAMPLE_RATE=0.01` — a random 1 % of auto-accepted fields is injected into the human-review stream, labelled as audit, so the drift monitor's sample is unbiased. Alert on **escape rate** directly at `OCR_CALIBRATION_ESCAPE_ALERT_RATE=0.001`, weekly for critical fields.

### C4-D7 — Trust-aware capabilities and a `forbid` that the caller cannot set

**Competing proposals.** (P1) M0 §9.2: `OcrRequest.require` only, `OcrCapabilities` functional-only. (P2) The panel's security alternative: add a `trust` axis and a `forbid`. (P3) Rely on `f3-ai-call-placement.md`'s process boundary alone.

**Selected.** P2 **and** P3, because they defend different things. `f3` guarantees that only `ocr-ai-worker` can reach the gateway — a *network* control. This adds the *authorization* control: which documents are permitted to reach a generative or off-host engine at all.

```ts
// src/modules/ocr/domain/engine-capabilities.ts
export interface OcrCapabilities {
  readonly emitsLineBoxes: boolean;
  readonly emitsSubLineGeometry: 'cluster' | 'word' | 'line' | 'none';   // NEW, replaces emitsWordBoxes
  readonly emitsConfidence: 'per-cluster' | 'per-word' | 'per-line' | 'per-page' | 'none';
  readonly deterministic: boolean;
  readonly emitsReadingOrder: boolean;
  readonly emitsTables: boolean;
  readonly emitsMarkdown: boolean;
  readonly languages: readonly string[];
  readonly requiresGpu: boolean;
  readonly maxRegionsPerCall: number;
  readonly trust: {
    readonly generative: boolean;        // can emit text that was not on the page
    readonly leavesHost: boolean;        // bytes cross the container/host boundary
    readonly guardrails: 'none' | 'vendor' | 'ours';
    readonly processorId: string | null; // named data processor for the PDPA RoPA
  };
}
```

Declared values: `paddle-onnx-th` → `{emitsSubLineGeometry:'cluster', emitsConfidence:'per-cluster', deterministic:true, trust:{generative:false, leavesHost:false, guardrails:'ours', processorId:null}}`. `tesseract-tha` → same trust, `emitsSubLineGeometry:'cluster'`. `typhoon-vlm` → `{emitsSubLineGeometry:'none', emitsConfidence:'none', deterministic:false, trust:{generative:true, leavesHost:true, guardrails:'none', processorId:'<gateway>'}}`.

```ts
export interface OcrRequest {
  /** Per f1 authz.principal_type — the frozen 3-variant discriminated union
   *  (user | apiKey | system), every variant carrying organizationId.
   *  CORRECTED BY REVIEW: the first draft wrote `scope: TenantScope`, inventing a
   *  type name for a concept f1 has already frozen under a different name. Under
   *  f1 tenant.principal_identity the principal is a Membership.id, never a User.id,
   *  and Principal is the type that carries that. */
  readonly principal: Principal;
  readonly source: DocumentRef;              // per f1 authz.document_ref — unforgeable, not a string
                                             // and already tenant-proven, so `principal` is here
                                             // for AUTHORISATION (which engines may run), not for
                                             // tenant scoping, which DocumentRef already settles.
  readonly pageRange?: { readonly from: number; readonly to: number };
  readonly languages: readonly string[];
  readonly renderDpi: number;                // bounded by f2 RENDER_DPI_DEFAULT and MAX_PAGE_PIXELS
  readonly require: Partial<Pick<OcrCapabilities, 'emitsLineBoxes'|'emitsTables'|'emitsMarkdown'|'deterministic'>>;
  /** NOT settable by the caller. Populated by the use case from the Organization row and the
   *  document's sensitivity classification. A caller can DEMAND a capability; only the platform
   *  can FORBID one. */
  readonly forbid: Readonly<Partial<{ generative: true; leavesHost: true }>>;
  readonly idempotencyKey: string;           // namespaced by organizationId
}
```

**Rejected.** P1 alone leaves `registry.select()` able only to widen, never to narrow — a caller can never say "this document must not touch a generative engine", so a PDPA §26 sensitive document and a public brochure are handled identically. P3 alone is insufficient because it defends the *host*, not the *tenant*: once `ocr-ai-worker` exists and holds the credential, nothing stops a use case sending it a Thai national ID card.

**Reason.** The one control that changes behaviour is the one the type system enforces. `registry.select()` throws `CAPABILITY_FORBIDDEN` rather than silently choosing a wider-trust engine, and `forbid` being absent from the request DTO the API layer constructs makes "the caller set it" a compile error.

**Implementation consequence.** `forbid` is derived in `src/modules/ocr/application/use-cases/`, from `Organization.aiEgressPolicy` (`DENY_ALL | ALLOW_NON_SENSITIVE | ALLOW_ALL`, default **`DENY_ALL`**) and `ExtractionField.isSensitive` (frozen, `g-data-model.md`). A document containing any field marked `isSensitive` gets `forbid = {generative: true, leavesHost: true}` regardless of org policy unless the policy is `ALLOW_ALL` **and** the tenant has an explicit per-document opt-in.

**Migration consequence.** `Organization.aiEgressPolicy` ships defaulted to `DENY_ALL`, so no existing tenant's documents can reach a generative engine without a deliberate change. Widening later is a config change; narrowing later would be a breaking change for anyone who came to rely on it — which is why the default is the narrow one.

**Security consequence.** This is the control that closes the panel's primary security finding: the escalation triggers E1/E2/E3/E5/E6 were computed from attacker-supplied pixels, so **the uploader chose which engine read their document**. Under C4-D8 those triggers no longer select an engine at all, and under C4-D7 even E4 cannot cross the trust boundary without a platform-set permission.

**Config/env consequence.** `OCR_DEFAULT_AI_EGRESS_POLICY=DENY_ALL`.

### C4-D8 — Escalation: quality triggers stop escalating; they route to review

**Competing proposals.** (P1) M0 §9.6(b): E1–E6 all escalate to the VLM tier. (P2) The panel: keep E4 only, route E1/E2/E3/E5/E6 to review, add budgets and a trip-rate monitor. (P3) Delete escalation entirely.

**Selected. P2**, with the numbers made concrete.

**Every trigger below has a name, a default, an env var, a definition of its input, and a stated behaviour when its input is not yet computable.** The first draft of this table carried numbers with no env vars and two terms — "ink coverage" and "the corpus median" — that were never defined, which is exactly the "if confidence is low" shape the owner banned. Corrected by review.

| # | Trigger | Threshold | Env var | Input definition | Action |
|---|---|---|---|---|---|
| **E1** | Region-level calibrated confidence low | `calibratedP < 0.80`, **and only when `calibratedP != null`** | `OCR_ESCALATE_E1_CALIBRATED_P_MIN=0.80` | `RegionCandidate.calibratedConfidence` of the consensus winner | `OcrWarning.LOW_CONFIDENCE` → review priority 2. **Never** escalates. **Inert while `calibratedP == null`** — no placeholder, no guess. |
| **E2** | Long tail of bad clusters | `p10` of cluster confidence `< 0.60` | `OCR_ESCALATE_E2_CLUSTER_P10_MIN=0.60` | the 10th-percentile (nearest-rank) of `ClusterSpan.confidence` over the region's winning candidate; requires `≥ OCR_ESCALATE_E2_MIN_CLUSTERS=10` non-null cluster confidences, else **inert** | warning → review priority 2 |
| **E3** | Implausible Thai script ratio | Thai codepoint ratio `< 0.50` on a page whose `languageHints` contain `th` | `OCR_ESCALATE_E3_THAI_RATIO_MIN=0.50` | (count of codepoints in U+0E00–U+0E7F) ÷ (count of codepoints that are neither whitespace nor Unicode category `P*`/`S*`), over the page's accepted text; requires `≥ OCR_ESCALATE_E3_MIN_CHARS=200` such codepoints, else **inert**. **Known false-positive class:** a legitimately bilingual Thai invoice whose product names are English. This is why E3 raises a warning and never selects an engine, and why the ratio is tenant-tunable | `OcrWarning.LOW_THAI_SCRIPT_RATIO` → review priority 2 |
| **E4** | **Capability** requested that the classic tier cannot satisfy | caller set `require.emitsTables` or `require.emitsMarkdown` | n/a — a boolean on the request, not a threshold | `OcrRequest.require` | The **only** trigger that may select a different engine, and only through `registry.select()` honouring `forbid`. If no permitted engine satisfies it → `CAPABILITY_NOT_SATISFIED`, never a silent box-less degradation. |
| **E5** | Near-empty result on an ink-bearing page | detected regions `< 5` **and** ink coverage `> 0.02` | `OCR_ESCALATE_E5_MAX_REGIONS=5`, `OCR_ESCALATE_E5_MIN_INK_FRAC=0.02` | **ink coverage** is defined here for this trigger only: the fraction of DERIVATIVE-space pixels whose 8-bit grey value is `≤ OCR_ESCALATE_E5_INK_LEVEL_MAX=200`, measured on a `OCR_ESCALATE_E5_INK_PROBE_LONG_SIDE_PX=512` box-filtered downscale of the derivative — deliberately the same *shape* of cheap probe as `c3`'s `OCR_ROUTE_INK_PROBE_*`, and cited to c3 rather than re-owned if c3's probe output is available on the page | `OcrWarning.DETECTION_SUSPECTED_FAILURE` → review priority **1**. A page with ink and no detected lines is far more likely a scan failure or an adversarial input than something a guardrail-free model should be handed. |
| **E6** | Diacritic-density anomaly | marks-per-Thai-consonant `< 0.35 ×` the reference density for the document's class | `OCR_ESCALATE_E6_DENSITY_RATIO_MIN=0.35`, `OCR_ESCALATE_E6_MIN_CONSONANTS=100`, `OCR_ESCALATE_E6_REFERENCE_SOURCE=corpus\|static`, `OCR_ESCALATE_E6_STATIC_REFERENCE=0.62` | numerator = codepoints in `THAI_COMBINING` (§2.1 C-4); denominator = codepoints in U+0E01–U+0E2E. **The reference density is the defect the first draft left open:** "the corpus median for the document's class" does not exist at M1, because there is no corpus. Shipped behaviour is `OCR_ESCALATE_E6_REFERENCE_SOURCE=static` with a **named default of 0.62** marks-per-consonant — an ESTIMATE, flagged as such, listed as M2 measurement item 8 — flipping to `corpus` only once ≥ `OCR_ESCALATE_E6_MIN_SAMPLES=500` human-reviewed pages exist for that document class. Below `MIN_CONSONANTS` the trigger is **inert** | `OcrWarning.DIACRITIC_DENSITY_LOW` → review priority 2. This is the direct signature of the mark-erasure failure mode and the trigger no general-purpose OCR pipeline has. |

**The inert rule is uniform and it is the point.** E1, E2, E3 and E6 each have a stated condition under which they *cannot fire* because their input is not yet trustworthy. A trigger that fires on an uncomputed input is worse than a trigger that does not exist: it teaches reviewers to ignore the warning. No trigger in this table has a placeholder threshold.

**Budgets (the control the M0 escalation policy had none of).** Even E4 is bounded:

- `OCR_ESCALATION_MAX_PAGES_PER_DOCUMENT = 3`
- `OCR_ESCALATION_MAX_PAGES_PER_TENANT_PER_DAY = 200`
- Both decremented **in the same transaction as the job row**, using the existing `outbox_events` / `idempotency_records` foundation the house stack already ships.
- Exceeding either emits `budget_exceeded` → **review, never best-effort** — the identical rule `f` §1.4 already proved for preprocessing escalation.
- Trip-rate kill-threshold: if E4 fires on more than **8 %** of pages over a rolling 1 h window, escalation is disabled platform-wide and an alert pages. 8 % is `f` §1.4's own instrumented threshold, reused rather than reinvented.

**Rejected.** P1 is rejected on the panel's verified argument: E1, E3 and E5 are each forceable from uploaded pixels (degrade contrast; put Latin on a page declared Thai; a page of engineered speckle), so P1 hands an attacker an engine-selection primitive pointed at a guardrail-free model on a shared GPU. P3 is rejected because E4 is a genuine capability route — a caller who needs a table cannot be served by a CTC recogniser at any confidence.

**Reason.** Escalating on a *quality score* is branching on an uncalibrated number to reach a less trustworthy engine. Escalating on a *declared capability* is answering a question the caller asked. Only the second is safe, and it is the only one that survives.

**Implementation consequence.** `OcrWarning` becomes a closed enum in `contracts/error-codes.json`, whose owner is `h-queue-and-worker-contract.md` per the frozen `ai.error.taxonomy_owner`; the `OCR_*` members are owned here. E1's `< 0.80` is **inert until a calibration map exists**: with `calibratedP == null` the trigger cannot fire, which is the correct behaviour and removes M0's "placeholder threshold" problem without a placeholder.

**Migration consequence.** Removing escalation from five triggers reduces GPU demand to approximately zero at M1, which is consistent with there being no GPU. If a GPU later arrives, re-enabling a trigger is a config change plus a calibration map — not an architecture change.

**Security consequence.** This is the closure of the panel's primary security finding. Combined with C4-D7's `forbid` and `f3`'s process boundary, an uploader can no longer (a) choose the engine, (b) reach a generative engine at all under the default org policy, or (c) cause page bytes to leave the host — three independent controls, any one of which is sufficient.

**Config/env consequence.** `OCR_ESCALATION_MAX_PAGES_PER_DOCUMENT=3`, `OCR_ESCALATION_MAX_PAGES_PER_TENANT_PER_DAY=200`, `OCR_ESCALATION_TRIP_RATE_KILL=0.08`, `OCR_ESCALATION_TRIP_RATE_WINDOW_S=3600`, plus the nine `OCR_ESCALATE_E*` trigger variables tabulated above.

**Namespace note.** `OCR_ESCALATION_*` (budgets, owned here) and `OCR_ESCALATE_E*` (this document's E1–E6 trigger thresholds, owned here) are deliberately distinct from `c3-ocr-routing-policy.md`'s `OCR_ROUTE_ESCALATE_*` and `OCR_ROUTE_ESCALATION_RATE_ALARM`, which govern **routing** escalation — re-rendering at a higher DPI, extra recognition passes — and are c3's to own. Two escalation ladders exist because they escalate different things: c3 escalates *effort on the same engine*, this document escalates *to a different engine*. §13 states the boundary and flags the one place they must share a budget.

### C4-D9 — The four-space coordinate contract and the `page_renders` table

*Added by review. §3 specified this contract in full but never recorded it as a decision, so its rejected alternatives and its migration and security consequences were nowhere stated — the same defect shape the review is asked to find elsewhere.*

**Competing proposals.** (P1) M0 `d`: quads leave `OcrProvider` in derivative pixel space; `OcrPage` carries `renderDpi` and `rotationApplied` only. (P2) The panel's safer alternative: add `toOriginal` to `OcrPage`, matching `f` D16. (P3) Persist quads in RENDER space and rescale on read. (P4) Four named spaces, one persisted space (SOURCE), the full chain stored per render in a new table, with a numeric round-trip assertion.

**Selected. P4** (§3).

**Rejected.** P1 is the panel's F1-secondary finding: a quad with no route back makes redaction and click-to-source unimplementable, and doc `d` shipped the exact version doc `f` declared unimplementable. P2 is a genuine improvement and is **adopted as one link of four** (`derivativeToRender` = D16's `toOriginal`, verbatim), but on its own it leaves `engineToDerivative` and `renderToSource` undefined — which is why it *looked* complete. P3 fails on requeue: a re-render at a different DPI makes previously persisted boxes rescalable but not comparable, and for a PDF the resolution-independent artefact of record already exists, so choosing a pixel space discards information for nothing.

**Reason.** One space to reason about downstream, one direction of truth, and a numeric gate that refuses a render whose geometry cannot be trusted. The alternative is a system where a redaction rectangle can be silently in the wrong place on the wrong image, which is the worst failure mode a PDPA product has.

**Implementation consequence.** `src/modules/ocr/domain/geometry.ts` (§3.4) with the `SpacedQuad<S>` brand; `page_renders` (§3.3); the round-trip assertion (§3.5) in the render stage, before any OCR. `sourceToDerivative` is computed by inversion and never stored, so two facts cannot disagree.

**Migration consequence.** `DocumentPage.renderStorageObjectId` is deleted and replaced by `PageRender.renderStorageObjectId` with a composite FK, closing the TEN-2 violation `f1` names by hand. The column is empty at M1, so the migration is a drop and an add. `page_renders` is on the frozen `partial_index.policy` path for none of its indexes — all four are plain — so no hand-authored raw SQL is required.

**Security consequence.** Geometry is a security control here, not a display concern: `ExtractionField.isSensitive` redaction is drawn from these quads. A wrong transform does not throw, it silently leaves a Thai national ID number visible under a rectangle that covers the label beside it. The `≤ 0.5 px` assertion and the `> 2.0 px` hard fail are what make that a caught failure rather than a shipped one. `page_renders` carries a tenant-only RLS policy (see §3.3's extension note and CH-3).

**Config/env consequence.** `OCR_GEOM_ROUNDTRIP_TOLERANCE_PX=0.50`, `OCR_GEOM_ROUNDTRIP_DEGRADED_MAX_PX=2.0`, `OCR_GEOM_ROUNDTRIP_PROBE_POINTS=16`.

### C4-D10 — The region classifier: a shipped-off CNN, not a heuristic and not a page-level label

*Added by review.*

**Competing proposals.** (P1) No classification; recognise everything with the printed engine. (P2) A page-level printed/handwritten label. (P3) `c3-ocr-routing-policy.md`'s stroke-width/height-variance heuristics (`OCR_ROUTE_HW_STROKE_WIDTH_CV_MIN`, `OCR_ROUTE_HW_HEIGHT_CV_MIN`, `OCR_ROUTE_HW_VOTES_REQUIRED`) applied per region. (P4) A small CNN over the crop the recogniser already produced, **shipped disabled**, with `UNKNOWN` as a first-class kind.

**Selected. P4**, with `OCR_REGION_CLASSIFIER_ENABLED=false` at M1 (§5.3).

**Rejected.** P1 makes `HANDWRITTEN` unrepresentable, so the handwriting ladder has nowhere to attach and the correction dataset cannot be stratified. P2 answers the wrong question: a Thai government form is printed labels with handwritten values in the same table row plus a signature block, and VERIFIED evidence supports this directly — PP-DocLayout's 23 categories contain **no handwriting class and no signature class**, only `seal`, so nothing off the shelf answers "is this line handwritten". P3 is **not rejected as a mechanism** — it is c3's, it is cheap, and it is available today; it is rejected as the *persisted* label because a hand-tuned CV heuristic has no calibrated probability, so `MIXED` (the honest "not sure" band) cannot be expressed and the multi-candidate path cannot be triggered by uncertainty. Where c3's heuristic exists it is a **routing** input; this classifier is an **evidence** label. §13 states that boundary.

**Reason.** The classifier is on the critical path of nothing at M1 and on the critical path of everything at H1. Building the table, the kind enum, the crops and the consensus now — and leaving the model off — costs one nullable column set and buys the entire handwriting ladder for a config change.

**Implementation consequence.** MobileNetV3-Small over the `48 × 320 × 1` tensor `Rec.rec_img_shape` already produces (VERIFIED as the shipped rec shape), 5-way softmax, ordered thresholds (§5.3). Disabled ⇒ every region `UNKNOWN`, `kindScore = null`, `classifierVersion = null`, and every region is recognised by the printed recognisers.

**Migration consequence.** Enabling it later is a config change plus a **backfill job**, and the backfill has crops to work with only for regions §6.2's R1–R5 selected — so the backfill is explicitly partial and `kindProbsJson` stores **all five** probabilities precisely so a threshold change is a re-read rather than a re-inference.

**Security consequence.** The classifier is a pure function of a crop already in memory; it opens no file, no socket and no new parser. Its failure mode is a wrong label, which under §5.2 never suppresses a region and never prevents recognition — a `NOISE` misclassification loses no evidence. Its **training data** is the security question, and it is `OWNER-BLOCKED (B-2)` because it cannot be built from customer documents under B-1's `TrainingConsent.NONE` default.

**Config/env consequence.** `OCR_REGION_CLASSIFIER_ENABLED=false`, `OCR_REGION_CLASSIFIER_MODEL_PATH`, and the five enumerated `OCR_REGION_KIND_*` thresholds of §5.3.

### C4-D11 — Consensus by per-cluster election, not by candidate ranking

*Added by review.*

**Competing proposals.** (P1) Pick the highest-confidence candidate wholesale. (P2) `c3-ocr-routing-policy.md` C3-D8's rule: score agreement, keep the **primary's text unchanged**, mark `VERIFIED` / `MINOR_DISAGREEMENT` / `DISPUTED`. (P3) Per-cluster weighted election with a deterministic multiple-sequence alignment, producing text that may be no single engine's output.

**Selected. P3** (§7), **with the outcome bands and the digit rule as the load-bearing parts**.

**Rejected.** P1 discards the information that makes a second engine worth running: two engines that disagree on one digit and agree on 39 characters carry a *per-character* signal that a whole-candidate choice throws away. P2 is **c3's, it is not wrong, and it conflicts with P3 on a real question** — whether the accepted text may differ from the primary's. It is raised as §13 conflict 1 rather than silently overridden. The one argument P3 has that P2 does not: under P2 a cluster the primary got wrong and *both* other engines got right is still wrong in the record, and the reviewer is shown a disagreement rather than a correction.

**Reason.** Thai's dominant failure mode is a *single lost tone mark* (M0 §7.2). Cluster-level alignment turns that into a one-cluster disagreement instead of a desynchronised tail; cluster-level election lets the engine that kept the mark win that cluster alone. Both properties are lost at candidate granularity.

**Implementation consequence.** §7.2's Needleman–Wunsch with a fixed traceback tie rule, §7.3's weights and granularity penalties, §7.4's bands, §7.5's deletion rules, §7.6's tie order — plus §6.2a's caps, which are what make the DP's cost a bound. `region_consensus.acceptedText` is stored, not derived on read, because it is evidence of what the system believed at that `consensusVersion`.

**Migration consequence.** `consensusVersion` is a member of `ocr.calibration_key`, so changing a weight or a band invalidates every calibration map, forces `calibratedP = null`, and fails the hard gates closed. There is no path by which a consensus-rule change silently shifts what "accepted" means. Historical verdicts are never recomputed; a new version writes a new row.

**Security consequence.** Two controls live here. The **generative co-signature rule** (§7.3) makes M0 D13 arithmetic: a candidate with `trust.generative = true` scores 0 on any cluster no non-generative candidate agrees with, so a hallucinated digit cannot win — checkable, not aspirational. The **digit deletion rule** (§7.5) prevents a number being silently removed by vote, which is unrecoverable downstream because nothing knows a digit is missing.

**Config/env consequence.** `OCR_CONSENSUS_VERSION=1.0.0`, `OCR_CONSENSUS_AGREED_MIN=0.90`, `OCR_CONSENSUS_DISPUTED_MAX=0.60`, `OCR_CONSENSUS_CLUSTER_MIN_AGREEMENT=0.75`, `OCR_CONSENSUS_UNCALIBRATED_PENALTY=0.70`, `OCR_CONSENSUS_NULL_CONFIDENCE=0.50`, `OCR_CONSENSUS_GRANULARITY_PENALTY_WORD=0.95`, `OCR_CONSENSUS_GRANULARITY_PENALTY_LINE=0.90`, `OCR_CONSENSUS_WEIGHT_<ID>`, `OCR_CONSENSUS_TIE_BREAK_ORDER`.

### C4-D12 — Region crops are conditional, deterministic, and capped

*Added by review; this is also where §6.2a's region caps are recorded as a decision.*

**Competing proposals.** (P1) Store every region crop. (P2) Store none; re-cut on demand from the render. (P3) Store on a stated rule, with a deterministic key and hard caps.

**Selected. P3** (§6.2, §6.2a).

**Rejected.** P1 is unaffordable and unlawful: 500 pages × ~40 regions is ~20,000 crops, ESTIMATE ~78 MiB–780 MiB of *additional* full-fidelity PII per document depending on line width, against the frozen `DEFAULT_STORAGE_QUOTA_BYTES` — and PDPA data minimisation does not permit retaining a crop of a national ID line "in case". P2 is attractive and fails on one fact: the render itself is a derivative with a 30-day TTL, so "re-cut on demand" silently becomes "cannot re-cut" exactly when a reviewer opens a 40-day-old dispute.

**Reason.** The crops that matter are a small, nameable set: the ones a reviewer will look at, the ones a future handwriting benchmark needs, the ones a redaction must be exact against, and an unbiased sample of the ones we auto-accepted. R1–R5 name them; ESTIMATE 2–8 % of regions.

**Implementation consequence.** Deterministic `oid` (§6.2) with a fully specified quad canonicalisation, so a requeue is idempotent at the storage layer and a ULID does not orphan one crop per requeue. Greyscale PNG only. Four region/cluster caps (§6.2a).

**Migration consequence.** `cropVersion` is bumped rather than objects mutated, which keeps crops compatible with §8's append-only regime. Adding a persistence rule later re-cuts only future runs; it does not backfill, and §5.3's backfill note says so rather than implying otherwise.

**Security consequence.** This is the largest new PII surface the document creates, and it is the one an attacker does not need to reach because we created it ourselves. Three controls: the persistence rule bounds *what*; the caps bound *how much*; the frozen `storage.tenant_prefix_check` (`org/{organization_id}/…` as a database CHECK, not a convention) bounds *whose*. Retention is `f`'s derivative class, crypto-shredded with the document under `gate-2-pdpa-retention.md` — never an exception. Separately, §6.2a closes a **denial-of-service** hole: with `text_score = 0.0` and `Det.max_candidates = 1000` (both VERIFIED), a speckle page produced unbounded regions, unbounded recogniser calls and a quadratic alignment.

**Config/env consequence.** `OCR_REGION_CROP_AUDIT_RATE=0.005`, `OCR_LIMIT_MAX_REGION_CROPS_PER_DOCUMENT=2000`, `OCR_LIMIT_MAX_REGION_CROP_BYTES=262144`, `OCR_LIMIT_MAX_REGIONS_PER_PAGE=400`, `OCR_LIMIT_MAX_REGIONS_PER_DOCUMENT=20000`, `OCR_LIMIT_MAX_CLUSTERS_PER_REGION=400`, `OCR_LIMIT_MAX_CANDIDATES_PER_REGION=4`.

### C4-D13 — Evidence immutability reconciled with PDPA erasure by a database trigger

*Added by review.*

**Competing proposals.** (P1) Application-level convention ("we don't update these"). (P2) `REVOKE UPDATE, DELETE` from every role on the evidence tables. (P3) A `BEFORE UPDATE OR DELETE` trigger permitting exactly one mutation — `purged_at`, by `ocr_erasure` alone.

**Selected. P3** (§8).

**Rejected.** P1 is not a control; the M0 corpus is a record of what conventions survive contact with a deadline. P2 is closer but cannot express "one column, one role": erasure genuinely must write, and a blanket revoke forces either a second table or an ambient superuser path — and `f1`'s frozen `db.roles` exists precisely so that no such path is needed.

**Reason.** Immutability and erasure look like a contradiction and are not: erasure never *edits* evidence, it marks it and destroys the object-storage content by key. The row remaining as proof that a thing existed and was erased is itself an audit obligation.

**Implementation consequence.** `evidence_append_only()` applied to `page_renders`, `document_regions`, `region_candidates`, `region_consensus`, `ocr_results`, `document_analyses`, `corrections`, `audit_logs`. `DELETE` is refused **even for `ocr_erasure`**, so a cascade reaching an evidence table becomes a loud failure rather than a quiet data loss.

**Migration consequence.** The trigger must be created in the same migration as each table, or a window exists in which the guarantee is documented and absent. It is also on the boot-assertion list beside `f1`'s policy assertions, because a trigger dropped by a restore is invisible.

**Security consequence.** `current_user` is the check, so it composes with `f1`'s frozen five-role split rather than duplicating it: the request role (`ocr_app`) and the job role (`ocr_worker`) cannot update evidence at all, and the erasure role can update exactly one column. Note the interaction the design depends on: these tables are **insert-only** for the worker, so the trigger's `BEFORE UPDATE OR DELETE` scope leaves the write path untouched, and the frozen `uniq.ocr_result` `ON CONFLICT DO NOTHING` retry semantics remain legal. `document_runs` is deliberately **not** on the list, because the frozen `uniq.document_run_one_active` rule requires a requeue to update a live run's outcome.

**Config/env consequence.** None. This is a schema object, and that is the point — it cannot be turned off by an environment variable.

### C4-D14 — A correction is a new row that inherits pointers, never text

*Added by review.*

**Competing proposals.** (P1) `UPDATE extraction_field_values SET value_text = …`. (P2) New row, no source rows — provenance stops at the correction. (P3) New row + **copied** `field_value_sources` carrying `inheritedFromValueId`, in one transaction with the `corrections` row.

**Selected. P3** (§9.4).

**Rejected.** P1 destroys the machine's output, which is the evidence the product is sold on, and makes "what did the OCR actually say?" unanswerable after the first correction. P2 answers the owner's six-part provenance question for machine values and silently fails it for corrected ones — which are exactly the values a dispute is about.

**Reason.** The corrected value inherits the *pointers*, not the *text*, so `FieldProvenance` for a human-corrected field still resolves to `RegionCandidate.rawText` — the bytes `paddle-onnx-th` actually emitted — with `inherited: true` on every source row.

**Implementation consequence.** The five-statement transaction in §9.4. `confidence = NULL` and `origin = 'HUMAN'` on the new row, so no downstream gate can mistake a human value for a high-confidence machine value; inventing a confidence would be a lie with a number attached.

**Migration consequence.** None at M1 — the frozen `ExtractionFieldValue` already carries `origin`, `isCurrent` and `supersedesId`. The chain survives arbitrarily many corrections because each generation writes its own `field_value_sources` rows.

**Security consequence.** `field_value_sources.candidate` is `onDelete: Restrict`, so original evidence cannot be garbage-collected while any corrected descendant points at it. The actor is a `Membership` per `f1`'s frozen `tenant.principal_identity`, with `actor_user_id` as a derived denormalisation for PDPA subject access that authorisation never reads (`f1 VIS-2`) — the correction the review made to the first draft, which had the user id as the primary actor identity.

**Config/env consequence.** None.

---

# PART 2 — HANDWRITING-READY ARCHITECTURE

**No handwriting recognition is implemented.** What follows is the structure that makes adding it a registry line rather than a milestone, and that makes the platform exceed basic OCR products *before* handwriting ships — because the region/candidate/consensus machinery improves printed accuracy on the same day it is built.

## 5. Where the region stage sits, and what it emits

### 5.1 The pipeline, with the new stage named

```
 1  ingest            original bytes -> storage_objects (kind ORIGINAL)      [i-storage]
 2  render            page -> RENDER space bitmap @ RENDER_DPI_DEFAULT       [f2 owns the DPI]
 3  preprocess        RENDER -> DERIVATIVE, emits D16 toOriginal             [f owns the recipe]
 3b PAGE_RENDER       compose + assert the coordinate chain, write page_renders   <-- §3, NEW
 4  detect            call 1 of C4-D2 -> line quads in DERIVATIVE space
 5  REGIONISE         quads -> document_regions, projected to SOURCE space        <-- NEW
 6  CLASSIFY REGION   printed / handwritten / stamp / signature / noise           <-- NEW
 7  recognise         call 2 of C4-D2, per RegionRecognizer -> region_candidates  <-- NEW shape
 8  CONSENSUS         candidates -> one accepted text per region + agreement       <-- NEW
 9  normalise         NFC + pythainlp; rawText immutable                    [d D6, D7]
10  extract           fields, with six-part provenance                            <-- §9
11  validate          semantic + business validation
12  review            human correction; corrections -> correction dataset          <-- §10
```

**Stage 6 sits between detection and recognition, not before detection.** Three reasons, each decisive:

1. **The crop already exists.** Stage 4 produces the exact 48×W crop stage 7 will feed to the recogniser. Classifying that crop costs one extra forward pass on a tensor already in memory — no second crop, no second resize, no second memory copy.
2. **A page is not homogeneous.** A Thai government form is printed labels with handwritten values in the same table row, and a signature block at the bottom. A page-level classifier answers the wrong question. The verified evidence supports this directly: PP-DocLayout's 23 categories contain **no handwriting class and no signature class** — only `seal` ([PaddleOCR layout detection docs](http://www.paddleocr.ai/main/en/version3.x/module_usage/layout_detection.html), verified this session). Nothing off the shelf answers "is this line handwritten"; it has to be a per-region decision on our side.
3. **It is what routes the recogniser.** Stage 7 asks the registry for the recognisers permitted for *this region kind*. Classifying after recognition would mean recognising with the wrong engine and then discovering it.

### 5.2 What stage 6 emits, and what it never does

Stage 6 emits a **label with a score and a reason**. It never suppresses a region, never rewrites geometry, and never prevents recognition:

- A region classified `HANDWRITTEN` with no handwriting recogniser registered still gets a `PRINTED` candidate from `paddle-onnx-th`, recorded with `recognizerMismatch = true`, so the evidence exists and the consensus layer knows the candidate is out of distribution and weights it at **0.0** (§7.3). It is never presented as an accepted value.
- A region classified `NOISE` is still recognised and still stored. Suppression is a presentation decision, made downstream, recorded.

This is the same discipline as `Global.text_score = 0.0` in C4-D5: **the engine layer never discards evidence.**

### 5.3 The classifier itself — named, sized, and gated

| Property | Value |
|---|---|
| Architecture | MobileNetV3-Small (width 1.0), ImageNet-pretrained, binary + 3 auxiliary heads, input **48 × 320 × 1** (the identical tensor shape `Rec.rec_img_shape` already produces) |
| Params / size | ~1.5 M / **~2.4 MB** INT8 ONNX |
| Outputs | `p_handwritten`, `p_stamp`, `p_signature`, `p_noise` (softmax over 5 classes incl. printed) |
| Latency | **UNVERIFIED:** estimated 0.3–0.8 ms/crop on one Ice Lake core at INT8 with AVX512-VNNI. At 40 regions/page this is 12–32 ms/page, ≤ 2 % of the C4-D2 budget. To be measured in M2; not on the critical path of any frozen limit. |
| Training data | **OWNER-BLOCKED (B-2)** — see §11 |
| Licence | Apache-2.0 (torchvision MobileNetV3 weights) |

**Decision thresholds, numeric and total (they partition the probability space, with no gap):**

```
kind = SIGNATURE   if p_signature   >= OCR_REGION_KIND_SIGNATURE_THRESHOLD    = 0.60
     = STAMP       if p_stamp       >= OCR_REGION_KIND_STAMP_THRESHOLD        = 0.60
     = HANDWRITTEN if p_handwritten >= OCR_REGION_KIND_HANDWRITTEN_THRESHOLD  = 0.65
     = MIXED       if p_handwritten >= OCR_REGION_KIND_MIXED_FLOOR            = 0.20
     = NOISE       if p_noise       >= OCR_REGION_KIND_NOISE_THRESHOLD        = 0.70
     = PRINTED     otherwise                       (i.e. p_handwritten < MIXED_FLOOR)
     = UNKNOWN     if the classifier is disabled or its warmup assertion failed
```

The five variables are **enumerated, not wildcarded**. The first draft wrote `OCR_REGION_KIND_*_THRESHOLD`, which is a pattern, not a name: nothing can validate it, nothing can generate it into `config/limits.yaml`, and an operator cannot grep for it. Boot asserts `0 < MIXED_FLOOR < HANDWRITTEN_THRESHOLD < 1` and that each of the other three lies in `(0, 1)`; a violation is a boot refusal, because an inverted band would make `MIXED` unreachable and silently reclassify every uncertain region as `PRINTED` — the one outcome this classifier exists to prevent.

Evaluated in that order; the first match wins, so overlaps are resolved deterministically rather than by argmax (argmax on a 5-way softmax makes a 0.34/0.33/0.33 split look like a confident answer). `MIXED` is a *band*, not a class the model predicts: it is the honest name for "the classifier is not sure", and it causes **both** a printed and (when registered) a handwriting recogniser to run, which is precisely what the multi-candidate architecture is for.

**M1 shipped state:** `OCR_REGION_CLASSIFIER_ENABLED=false`. Every region is `UNKNOWN`, every region is recognised by the printed recognisers, and `document_regions` rows are written with `kind = UNKNOWN`, `kindScore = null`, `classifierVersion = null`. **The table, the crops, the candidates and the consensus all work at M1** — only the label is absent. Turning the classifier on later is a config change plus a backfill job, and the backfill has crops to work with because §6.2's persistence rule already stored the interesting ones.

---

## 6. Data structures

### 6.1 `document_regions`

```prisma
/// APPEND-ONLY. A detected region on one render. Immutable evidence (see §8).
model DocumentRegion {
  id               String   @id @db.Uuid                      // uuid v7 per f1 id.internal
  organizationId   String   @map("organization_id") @db.Uuid
  documentId       String   @map("document_id") @db.Uuid
  documentPageId   String   @map("document_page_id") @db.Uuid
  pageRenderId     String   @map("page_render_id") @db.Uuid
  runId            String   @map("run_id") @db.Uuid

  regionIndex      Int      @map("region_index")              // reading order within the page, 0-based
  quadJson         Json     @map("quad_json") @db.JsonB       // SpacedQuad<'SOURCE'> — §3.4
  quadDerivativeJson Json   @map("quad_derivative_json") @db.JsonB  // the pre-projection quad, kept
                                                              // because it is what the crop was cut from
  detectorScore    Float    @map("detector_score")            // DB box_thresh score, 0..1
  padFracApplied   Float    @map("pad_frac_applied")          // C4-D2's anisotropic pad, recorded

  kind             RegionKind @default(UNKNOWN)
  kindScore        Float?     @map("kind_score")              // the winning class probability
  kindProbsJson    Json?      @map("kind_probs_json") @db.JsonB  // all 5, for later re-thresholding
  classifierVersion String?   @map("classifier_version") @db.VarChar(60)

  cropStorageObjectId String? @map("crop_storage_object_id") @db.Uuid   // §6.2 persistence rule
  cropSha256          String? @map("crop_sha256") @db.VarChar(64)

  createdAt        DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)
  purgedAt         DateTime? @map("purged_at") @db.Timestamptz(3)       // PDPA, §10.3

  page       DocumentPage @relation(fields: [documentPageId, organizationId],
                                    references: [id, organizationId], onDelete: Cascade)
  render     PageRender   @relation(fields: [pageRenderId, organizationId],
                                    references: [id, organizationId], onDelete: Cascade)
  crop       StorageObject? @relation(fields: [cropStorageObjectId, organizationId],
                                    references: [id, organizationId], onDelete: Restrict)
  candidates RegionCandidate[]
  consensus  RegionConsensus?

  @@unique([pageRenderId, regionIndex], map: "document_region_render_index_key")
  @@index([organizationId, documentId, documentPageId], map: "document_region_org_doc_page_idx")
  @@index([organizationId, kind, createdAt], map: "document_region_org_kind_created_idx")
  @@map("document_regions")
}

enum RegionKind { UNKNOWN PRINTED HANDWRITTEN MIXED STAMP SIGNATURE NOISE }
```

`@@unique([pageRenderId, regionIndex])` follows the frozen `UNIQ-1` invariant by being scoped through `pageRenderId`, which is itself tenant-scoped by composite FK — the region index is **not** tenant-controlled input, it is server-assigned, so no `organizationId` member is required. Per the frozen `db.rls.children` rule, `document_regions` carries a **tenant-only** RLS policy; it is reachable only through an unforgeable `DocumentRef`.

### 6.2 Region crop storage — the key, the persistence rule, and the cap

**Key grammar.** Cited, not re-owned: `i-storage.md` §2.1's template, prefixed per the frozen `storage.tenant_prefix_check` in `f1-tenant-visibility-model.md`, which requires `object_key LIKE 'org/' || organization_id::text || '/%'`. This document owns exactly **one** thing about the grammar: a new value for the `{kind}` segment.

```
org/{organizationId}/{yyyy}/{mm}/{shard}/{documentId}/region/{oid}.png
                                                      ^^^^^^
                          NEW kind value, 6 chars, inside i §2.1's 4-10 char budget.
                          Key length: 4+36+1+4+1+2+1+2+1+36+1+6+1+26+1+3 = 126 chars.
                          KEY_MAX is 512 (i §3.2); S3's hard limit is 1024 bytes. Ample.
```

**`oid` is deterministic, not a fresh ULID.** Region crops are a pure function of `(pageRenderId, quad, cropVersion)`, so:

```
oid = crockford_base32( sha256( pageRenderId || '\x1f' ||
                                canonical_quad_derivative || '\x1f' ||
                                cropVersion ) )[0:26]   // lowercased, per i §2.2
```

**`canonical_quad_derivative` is specified, not left to the implementer** — added by review, because "the quad, serialised" is a hash input that two languages will disagree on and a silently different key is a silently orphaned crop:

```
canonical_quad_derivative :=
    the 8 coordinates x1,y1,x2,y2,x3,y3,x4,y4 of the PADDED derivative-space quad,
    in that order, each rounded half-to-even to 4 decimal places and formatted with
    exactly 4 decimal places ("%.4f", C locale, '.' as the separator, "-0.0000"
    normalised to "0.0000"), joined with ',' (U+002C), no spaces, ASCII, no trailing
    separator. NaN or non-finite in any coordinate => the crop is not stored and
    REGION_CROP_QUAD_INVALID is emitted.
```

4 dp at derivative-pixel scale is 0.1 µm of addressing precision — far finer than any real geometric difference — so two runs of the same recipe produce byte-identical input and therefore the same key. `cropVersion` is an integer owned here, `1` at M1; bumping it re-cuts every crop under a new key rather than mutating an existing object, which is what makes crops compatible with the append-only regime in §8.

This makes a requeue **idempotent at the storage layer**: re-running the same render produces the same key, and the frozen `uniq.storage_original_fingerprint` rule already establishes that derivatives are *identity*-addressed and unique via `storage_object_bucket_key_key (bucket, object_key)` — so a second write is a no-op rather than a `23505`. A ULID here would orphan a crop per requeue.

**Format is PNG, never JPEG.** A Thai tone mark is 2–5 px at `RENDER_DPI_DEFAULT` (frozen, `f2`); JPEG's 8×8 DCT blocks and chroma subsampling destroy exactly that. Region crops are greyscale PNG (`GRAY8`).

**Size arithmetic, corrected by review.** The first draft sized a stored crop at "~4–9 KB for a 48×320 line crop". That is the **recogniser input** tensor shape, not the stored artefact: per C4-D2 the crop is cut from the **full-resolution** derivative, so a typical A4 line at the frozen render DPI is ~44 px tall and up to ~2,400 px wide. ESTIMATE: 44 × 2400 = 105,600 px `GRAY8` ≈ 103 KiB raw, ≈ **15–40 KiB** as PNG on text-bearing content. A full-width table row or a merged block can exceed that. `OCR_LIMIT_MAX_REGION_CROP_BYTES = 262144` (256 KiB) is therefore a ~6–17× headroom over the typical case rather than the ~30–60× the first draft's arithmetic implied, and it sits well under the frozen `MAX_PAGE_RENDER_BYTES` derivative cap (`f2`), which remains the outer bound on anything a render produces. The per-document budget below is re-derived on the corrected figure: 2,000 crops × 40 KiB ≈ **78 MiB**, against the frozen `DEFAULT_STORAGE_QUOTA_BYTES` (`f2`).

**Persistence rule — a crop is stored if and only if at least one holds:**

| # | Condition | Why |
|---|---|---|
| R1 | `kind ∈ {HANDWRITTEN, MIXED, STAMP, SIGNATURE}` | the future handwriting benchmark and training set need these |
| R2 | consensus outcome ∈ `{DISPUTED, ACCEPT_FLAGGED, NO_CANDIDATE}` | the reviewer must see the pixels |
| R3 | the region overlaps a field whose `ExtractionField.isSensitive = true` | redaction and audit both need the exact crop |
| R4 | a reviewer opens the region | `f`'s pin-on-view rule, applied one level down |
| R5 | random audit sample at `OCR_REGION_CROP_AUDIT_RATE = 0.005` | an unbiased sample of *accepted* regions, so the drift monitor is not blind to what it auto-accepts |

**Without a rule, this is unaffordable and unlawful.** 500 pages × ~40 regions = 20,000 crops per document; at 7 KB that is 140 MB of *additional* full-fidelity PII per document, against a frozen `DEFAULT_STORAGE_QUOTA_BYTES` of 15 GiB. R1–R5 typically select 2–8 % of regions.

**Cap:** `OCR_LIMIT_MAX_REGION_CROPS_PER_DOCUMENT = 2000` and `OCR_LIMIT_MAX_REGION_CROP_BYTES = 262144` (256 KiB). Exceeding the count cap stops storing crops, emits `REGION_CROP_BUDGET_EXCEEDED`, and **does not fail the document** — crops are an aid, not the record. Both keys require an entry in `config/limits.yaml`, whose generation contract is owned by `f2-canonical-limits.md`'s `LIMITS_SOURCE_OF_TRUTH`; the values are owned here.

**Retention:** region crops are **derivatives** under `f`'s retention table — 30-day TTL from last access, pinned to the full audit-retention period on human view, and crypto-shredded with the document under `gate-2-pdpa-retention.md`'s regime. They are never an exception to it.

### 6.2a Region and cluster caps — the hole `text_score = 0.0` opens

**Added by review.** C4-D5 sets `Global.text_score = 0.0` so the engine never discards evidence. That is right, and it removes the only thing that was bounding the region count. VERIFIED: `Det.max_candidates` ships at **1000**. With the score filter at zero, a page of engineered speckle — the exact input E5 exists to notice — yields up to **1,000 regions**, and at the frozen `MAX_OCR_PAGES_PER_DOCUMENT` that is up to 50,000 regions in one document, each of which the first draft would have recognised, stored a `region_candidates` row for, aligned, and consensus-scored. Nothing in the first draft bounded any of it. The `~40 regions/page` figure the crop arithmetic rests on is a *typical* value, not a bound, and typical values do not bound hostile input.

Four caps, all generated through the frozen `LIMITS_SOURCE_OF_TRUTH` contract (`f2` owns the generation, this document owns the values):

| Key | Value | Env var | Rationale | Behaviour on breach |
|---|---|---|---|---|
| `MAX_REGIONS_PER_PAGE` | `400` | `OCR_LIMIT_MAX_REGIONS_PER_PAGE` | A dense Thai A4 government form at the frozen render DPI runs ~40–90 detected lines; 400 is ~4.5× the worst legitimate page we can construct and well under `Det.max_candidates = 1000`, so the cap binds before the engine's own does | Regions are kept in **detector-score order**, the top 400 are recognised, the remainder are written as `document_regions` rows with `kind = NOISE` and **no candidate**; page gets `OcrWarning.REGION_BUDGET_EXCEEDED` and review **priority 1** (it is E5's sibling: an implausible page). The page does **not** fail — evidence is preserved, work is bounded |
| `MAX_REGIONS_PER_DOCUMENT` | `20000` | `OCR_LIMIT_MAX_REGIONS_PER_DOCUMENT` | 400 × 50 OCR'd pages. Bounds `region_candidates` row fan-out, which is the table that grows fastest | Further regions are not detected; document-level `REGION_BUDGET_EXCEEDED`, priority 1 |
| `MAX_CLUSTERS_PER_REGION` | `400` | `OCR_LIMIT_MAX_CLUSTERS_PER_REGION` | Bounds one `clustersJson` blob and the Needleman–Wunsch DP in §7.2, whose cost is `O(k·n·m)` and therefore **quadratic** in this number. 400 clusters is a ~4,000 px line of dense Thai — longer than any real line at the frozen page-pixel cap | The region's candidate is stored with `rawText` intact and `clusters = []`; consensus for that region falls back to whole-region alignment and the outcome is forced to `ACCEPT_FLAGGED` at best. Never silently truncated text |
| `MAX_CANDIDATES_PER_REGION` | `4` | `OCR_LIMIT_MAX_CANDIDATES_PER_REGION` | `k` in the same `O(k·n·m)`. Four is the entire `RecognizerId` union, so it is a structural bound today and an explicit one tomorrow | `CONSENSUS_INPUT_TOO_LARGE`, region → review |

Two of these also close a **second-order** hole the first draft left: `clustersJson` and `acceptedClustersJson` are `jsonb` columns with no stated bound, and `f2`'s frozen `MAX_CHARS_PER_PAGE` bounds *characters*, not *boxes*. At 400 clusters × ~120 bytes of JSON per `ClusterSpan`, one region's blob is ≤ ~48 KiB and one page's is ≤ ~19 MiB — bounded, and now bounded by a number someone chose rather than by whatever the detector happened to emit.

### 6.3 The `RegionRecognizer` port

This is the port a handwriting engine will implement. It is deliberately **not** `OcrProvider`: an `OcrProvider` takes a document and owns detection; a `RegionRecognizer` takes crops and owns only recognition. Conflating them is what made M0's abstraction test pass against three engines that shared a blind spot.

```ts
// src/modules/ocr/application/ports/region-recognizer.ts
export type RecognizerId =
  | 'paddle-onnx-th'      // PRIMARY, printed
  | 'tesseract-tha'       // CORROBORATOR, printed
  | 'thai-trocr-hw'       // RESERVED, handwriting — NOT registered at M1 (C4-D4 H1)
  | 'typhoon-vlm';        // RESERVED, generative — NOT registered at M1 (C4-D4 H2)

export interface RegionRecognizerCapabilities {
  readonly acceptsRegionKinds: readonly RegionKind[];
  readonly emitsSubLineGeometry: 'cluster' | 'word' | 'line' | 'none';
  readonly emitsConfidence: 'per-cluster' | 'per-word' | 'per-line' | 'none';
  readonly deterministic: boolean;
  readonly languages: readonly string[];
  readonly maxRegionsPerCall: number;
  readonly trust: OcrCapabilities['trust'];          // C4-D7
}

/** One recognised region. IMMUTABLE once written. */
export interface RegionCandidateResult {
  readonly recognizerId: RecognizerId;
  readonly recognizerVersion: string;
  /** Byte-exact engine output. NEVER mutated, NEVER normalised. (d D7) */
  readonly rawText: string;
  /** NFC + pythainlp.util.normalize. NFKC/NFKD banned pipeline-wide. (d D6) */
  readonly normalizedText: string;
  /** One entry per EXTENDED GRAPHEME CLUSTER of normalizedText, in reading order.
   *  Empty iff emitsSubLineGeometry === 'none'. NEVER fabricated. */
  readonly clusters: readonly ClusterSpan[];
  /** Region-level score. null iff emitsConfidence === 'none'. Never 0.0 as a stand-in. */
  readonly confidence: number | null;
  readonly calibratedConfidence: number | null;      // null when the calibration key is unseen
  readonly calibrationKey: string;                   // sha256 of the C4-D6 12-tuple
  readonly engineToDerivative: Mat3;                 // §3.2 — recorded, never assumed
  readonly recognizerMismatch: boolean;              // true iff region.kind not in acceptsRegionKinds
  readonly durationMs: number;
  readonly warnings: readonly OcrWarning[];
}

export interface ClusterSpan {
  /** Index into normalizedText, in UTF-16 code units, of the cluster's first codepoint. */
  readonly start: number;
  readonly end: number;                    // exclusive
  /** SOURCE space, already projected. Null iff emitsSubLineGeometry === 'line' or 'none'. */
  readonly quad: SpacedQuad<'SOURCE'> | null;
  /** MINIMUM over the cluster's codepoints, never the mean. (§2.1 C-4) */
  readonly confidence: number | null;
  /** The CTC frame index the cluster's base codepoint was decoded at, when the recognizer
   *  is CTC-based. Retained because it is the only reproducible link back to the logits. */
  readonly ctcFrame: number | null;
}

export interface RegionRecognizer {
  readonly id: RecognizerId;
  readonly capabilities: RegionRecognizerCapabilities;
  recognize(
    principal: Principal,        // f1 authz.principal_type; NOT a bare userId (f1 VIS-2)
    ref: DocumentRef,
    regions: readonly RegionCrop[],
    signal: AbortSignal,
  ): Promise<Result<readonly RegionCandidateResult[], OcrError>>;
  /** Asserts pinned config + artefact SHA-256 + the golden page. C4-D5. */
  warmup(): Promise<string>;
}
```

### 6.4 `region_candidates` and `region_consensus`

```prisma
/// APPEND-ONLY. One row per (region, recognizer, run). The raw evidence.
model RegionCandidate {
  id                   String   @id @db.Uuid
  organizationId       String   @map("organization_id") @db.Uuid
  documentId           String   @map("document_id") @db.Uuid
  documentRegionId     String   @map("document_region_id") @db.Uuid
  runId                String   @map("run_id") @db.Uuid
  ocrResultId          String?  @map("ocr_result_id") @db.Uuid     // the page-level immutable blob

  recognizerId         String   @map("recognizer_id") @db.VarChar(40)
  recognizerVersion    String   @map("recognizer_version") @db.VarChar(160)

  rawText              String   @map("raw_text")                   // byte-exact, NEVER mutated
  normalizedText       String   @map("normalized_text")            // NFC + pythainlp
  normalizerVersion    String   @map("normalizer_version") @db.VarChar(40)
  clustersJson         Json     @map("clusters_json") @db.JsonB    // ClusterSpan[], SOURCE space
  clusterCount         Int      @map("cluster_count")

  confidence           Float?
  calibratedConfidence Float?   @map("calibrated_confidence")      // null => unseen calibration key
  calibrationKey       String   @map("calibration_key") @db.VarChar(64)
  engineToDerivative   Json     @map("engine_to_derivative") @db.JsonB
  recognizerMismatch   Boolean  @default(false) @map("recognizer_mismatch")

  durationMs           Int      @map("duration_ms")
  warnings             String[] @db.VarChar(60)
  payloadRef           String?  @map("payload_ref") @db.VarChar(1024)  // org/{id}/... per f1 CHECK
  createdAt            DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  purgedAt             DateTime? @map("purged_at") @db.Timestamptz(3)

  region     DocumentRegion @relation(fields: [documentRegionId, organizationId],
                                      references: [id, organizationId], onDelete: Cascade)
  sources    FieldValueSource[]
  samples    CorrectionSample[]

  @@unique([documentRegionId, recognizerId, recognizerVersion, runId],
           map: "region_candidate_region_recognizer_run_key")
  @@index([organizationId, documentId, recognizerId], map: "region_candidate_org_doc_recognizer_idx")
  @@map("region_candidates")
}

/// APPEND-ONLY. The consensus verdict for one region under one consensus version.
model RegionConsensus {
  id                String   @id @db.Uuid
  organizationId    String   @map("organization_id") @db.Uuid
  documentId        String   @map("document_id") @db.Uuid
  documentRegionId  String   @map("document_region_id") @db.Uuid
  runId             String   @map("run_id") @db.Uuid

  consensusVersion  String   @map("consensus_version") @db.VarChar(20)   // semver of the rule+weights
  outcome           ConsensusOutcome
  agreement         Float?                                    // A, §7.4. null iff NO_CANDIDATE
  candidateCount    Int      @map("candidate_count")

  /// The elected text: the per-cluster winners concatenated. NOT a copy of any one candidate.
  acceptedText      String   @map("accepted_text")
  /// Per accepted cluster: {start,end,quad,conf,winnerCandidateId,supportIds[],tieBroken}.
  acceptedClustersJson Json  @map("accepted_clusters_json") @db.JsonB
  /// Cluster indices where the winning weight was < OCR_CONSENSUS_CLUSTER_MIN_AGREEMENT.
  disputedClusterIndices Int[] @map("disputed_cluster_indices")
  tieBrokenCount    Int      @default(0) @map("tie_broken_count")
  deletionDisputed  Boolean  @default(false) @map("deletion_disputed")   // §7.5

  createdAt         DateTime @default(now()) @map("created_at") @db.Timestamptz(3)

  region DocumentRegion @relation(fields: [documentRegionId, organizationId],
                                  references: [id, organizationId], onDelete: Cascade)

  @@unique([documentRegionId, runId, consensusVersion], map: "region_consensus_region_run_ver_key")
  @@index([organizationId, documentId, outcome], map: "region_consensus_org_doc_outcome_idx")
  @@map("region_consensus")
}

enum ConsensusOutcome { AGREED ACCEPT_FLAGGED DISPUTED SINGLE_SOURCE NO_CANDIDATE }
```

### 6.5 The abstraction test — run against the engine M0's test could not express

M0 §9.3's test compared three engines that all emitted line-level geometry, which is why it passed. The real test is a recogniser with a **different geometry granularity and a different trust class**:

| Contract element | `paddle-onnx-th` | `tesseract-tha` | `thai-trocr-hw` (H1, not registered) | `typhoon-vlm` (H2, not registered) | Absorbed by |
|---|---|---|---|---|---|
| `acceptsRegionKinds` | PRINTED, MIXED, UNKNOWN | PRINTED, MIXED, UNKNOWN | HANDWRITTEN, MIXED | any | capability + registry filter |
| `emitsSubLineGeometry` | `'cluster'` | **`'line'` at M1** (`'char'` only after M2 item 7 — C4-D3) | **`'none'`** — a seq2seq decoder has no frame alignment | `'none'` | `ClusterSpan[]` may be **empty**, and `ClusterSpan.quad` may be **null** |
| `ClusterSpan.quad` | `SpacedQuad<'SOURCE'>` | **`null`** per cluster — the corroborator votes on text, not geometry | `[]` | `[]` | `null` per span, or an empty array; **never a fabricated box** |
| `emitsConfidence` | `'per-cluster'` | `'per-line'` at M1 — Tesseract's TSV/hOCR confidence is per word, and a Thai "word" is a phrase run, so a per-cluster claim would be a fabrication | `'per-line'` (sequence logprob) | `'none'` | union type |
| `confidence` | 0.93 | 0.88 (region-level) | 0.71 | **`null`** | `number \| null` |
| `deterministic` | true | true | **false** (beam search) | false | flag on the candidate |
| `trust.generative` | false | false | **true** | true | §7.3 weight-zeroing rule |
| geometry fallback | — | — | the **region quad** is the only geometry; a field anchored in a `'none'` region is anchored to the whole region | same | `FieldProvenance.geometryGranularity` |

**The test passes with zero port changes** because `ClusterSpan[]` is allowed to be empty, `ClusterSpan.quad` is allowed to be `null` independently of the span existing, and `confidence` is allowed to be `null` — the nullable escape hatches that M0's `OcrLine` already had, moved down one level to where the granularity difference actually lives. What M0's port could **not** absorb was a *sub-line* granularity difference, because it had no sub-line field at all. That is now the field, and it is nullable at the right level.

**And the test is now stronger than the first draft's, because the corroborator moved.** The first draft declared `tesseract-tha` at `'cluster'`, so the test's only geometry-granularity variation was against two engines that are **not registered at M1** — i.e. the port's hardest property was exercised entirely on paper. With C4-D3's correction, `tesseract-tha` ships at `'line'` with per-span `quad = null`, so the mixed-granularity path is executed by **the two recognisers that actually run in M1**, on every corroborated region, from the first day. That is the difference between an abstraction test and an abstraction claim, and it is a strictly better outcome than the draft that was wrong about Tesseract.

---

## 7. The consensus layer

This is the rule. It is deterministic, it has no random component, and every threshold is a number.

### 7.1 Alignment unit: extended grapheme cluster, not codepoint

Aligning two Thai transcriptions codepoint-by-codepoint produces spurious disagreements whenever one engine dropped a tone mark: the sequences desynchronise and every subsequent codepoint mismatches. Aligning by **extended grapheme cluster** (base + its combining marks, §2.1 C-4) makes a dropped tone mark a *one-cluster* disagreement, which is what it is.

`U+0E33` SARA AM is one cluster and is never decomposed — the frozen Unicode fact from M0 D6 (NFKC splits it into `U+0E4D U+0E32`).

### 7.2 Alignment algorithm — deterministic multiple-sequence alignment

```
1. Order candidates by (weight DESC, recognizerId ASC).  Deterministic, no ties possible
   because recognizerId is unique per candidate within a region.
2. Take candidate[0] as the ANCHOR.
3. For each remaining candidate, compute a Needleman-Wunsch global alignment against the
   ANCHOR over clusters, with:
       match    = 0
       mismatch = 1
       gap      = 1
   and, on equal score, prefer the alignment that places gaps LATEST (a fixed tie rule inside
   the DP traceback, so the same inputs always give the same alignment).
4. Project every alignment onto the anchor's coordinate system, producing a column set.
   Insertions relative to the anchor open new columns, ordered by their anchor-left neighbour
   then by recognizerId.
```

Cost: `O(k · n · m)` for `k` candidates of length `n`, `m` clusters. At `k = 2`, `n = m = 40` clusters this is 3,200 cell evaluations per region — negligible.

**The caps that make that cost a bound rather than an expectation** (named in the canonical table of the first draft but absent from this section, which is where an implementer reads — corrected by review):

```
k  <= OCR_LIMIT_MAX_CANDIDATES_PER_REGION = 4     (§6.2a)
n, m <= OCR_LIMIT_MAX_CLUSTERS_PER_REGION = 400   (§6.2a)
worst case per region: 4 x 400 x 400 = 640,000 cells
region total per document, at the region cap: bounded by §6.2a's 20,000 regions

Exceeding either => CONSENSUS_INPUT_TOO_LARGE, the region's candidates are stored
unaligned, outcome = DISPUTED, review priority 1. No truncation, no partial verdict.
```

Without these two caps the DP is **quadratic in attacker-influenced input**: a single crafted region decoding to 200,000 clusters is 4 × 10¹⁰ cell evaluations, which is not a slow page, it is a worker held past the frozen `JOB_PROCESSING_BUDGET_MS` on every retry. The first draft's `O(k·n·m)` note computed the typical case and never stated the bound.

### 7.3 Weights

```
w(candidate, cluster) = W_recognizer × c_cluster
```

`c_cluster` is the cluster's calibrated confidence when `calibratedConfidence != null`, otherwise the **raw** confidence multiplied by `OCR_CONSENSUS_UNCALIBRATED_PENALTY = 0.70`. An uncalibrated score is a ranking signal, not a probability (M0 §9.6(a)), and the penalty makes it lose to a calibrated one of the same nominal value. When `confidence` is `null` entirely, `c_cluster = OCR_CONSENSUS_NULL_CONFIDENCE = 0.50`.

**Where `c_cluster` comes from when the recogniser has no per-cluster confidence** — required by C4-D3's correction, and absent from the first draft, which assumed every registered recogniser was `'per-cluster'`:

| `capabilities.emitsConfidence` | `c_cluster` for every cluster of that candidate | Additional penalty |
|---|---|---|
| `'per-cluster'` | the cluster's own confidence | none |
| `'per-word'` | the containing word's confidence | `OCR_CONSENSUS_GRANULARITY_PENALTY_WORD = 0.95` |
| `'per-line'` (M1 `tesseract-tha`, and H1 `thai-trocr-hw`) | the region-level confidence, applied uniformly | `OCR_CONSENSUS_GRANULARITY_PENALTY_LINE = 0.90` |
| `'none'` (H2 `typhoon-vlm`) | `OCR_CONSENSUS_NULL_CONFIDENCE = 0.50` | — (the co-signature rule below already dominates) |

The granularity penalties exist because a line-level score spread over 40 clusters claims per-cluster knowledge it does not have: it says the same thing about the digit that was clipped as about the 39 characters that were fine. 0.90 is deliberately mild — it must not swamp `W_recognizer`, which is the axis that carries the real quality judgement — and it is asserted at boot to lie in `[0.80, 1.00]`. **It shifts the arithmetic in §7.4 and changes none of its outcomes**; §7.4's table is recomputed with the penalty applied, and the margin analysis under it is redone rather than left describing superseded numbers.

| Recognizer | `W_recognizer` | Reason |
|---|---|---|
| `paddle-onnx-th` | **1.00** | primary, only candidate with a Thai-trained recogniser and per-cluster CTC confidence |
| `tesseract-tha` | **0.45** | deliberately below 0.50 so it can **never outvote the primary alone**. ThaiOCRBench full-page 0.614 |
| `thai-trocr-hw` | **0.55** | reserved. Applies only to regions whose `kind ∈ {HANDWRITTEN, MIXED}`; **0.00** elsewhere |
| `typhoon-vlm` | **0.60** | reserved, and subject to the co-signature rule below |
| `easyocr-th` | **0.00** | benchmark only. Never votes. |
| any candidate with `recognizerMismatch = true` | **0.00** | out-of-distribution: the evidence is kept, the vote is not counted |

**The generative co-signature rule.** For any candidate whose `trust.generative = true`:

```
if no non-generative candidate agrees with it on this cluster:
        w = 0.00
```

This is M0 D13 ("VLM output is a transcription candidate, never an action input") expressed as arithmetic instead of prose. A generative engine can **confirm** a cluster; it can never **originate** one. The consequence is exact and checkable: a hallucinated digit that no CTC engine saw contributes zero weight and cannot win.

### 7.4 The verdict

```
For each column:
    winner       = argmax over distinct cluster values of  Σ w(candidate, cluster)
    W_win        = that maximum
    W_total      = Σ w over ALL candidates present in the column (gaps included, §7.5)
    a_column     = W_win / W_total                      (a_column ∈ (0, 1])

Region agreement, cluster-count-weighted so a 2-cluster region does not swing a 40-cluster page:
    A = Σ (a_column × len(winner)) / Σ len(winner)

Outcome:
    NO_CANDIDATE    if candidateCount == 0
    SINGLE_SOURCE   if candidateCount == 1
    AGREED          if candidateCount >= 2 and A >= 0.90
    ACCEPT_FLAGGED  if candidateCount >= 2 and 0.60 <= A < 0.90
    DISPUTED        if candidateCount >= 2 and A < 0.60

Per-cluster flag: a column with a_column < OCR_CONSENSUS_CLUSTER_MIN_AGREEMENT = 0.75 is
recorded in disputedClusterIndices EVEN IF the region outcome is AGREED. A region can be
95 % agreed and have one disputed digit, and the digit is what matters.
```

**What the numbers actually do — worked, because a threshold nobody has traced is a guess:**

Recomputed with §7.3's granularity penalty applied (`tesseract-tha` is `'per-line'` at M1, so its effective weight is `0.45 × 0.90 = 0.405` per unit confidence):

| Situation | Arithmetic | `A` | Outcome |
|---|---|---|---|
| Primary alone, calibrated 0.95 | 0.95 / 0.95 | 1.000 | `SINGLE_SOURCE` — **never auto-accepted for a critical field** |
| Primary + corroborator **agree**, primary 0.95, tesseract 0.90 | (0.95 + 0.3645) / (0.95 + 0.3645) | 1.000 | `AGREED` |
| Primary + corroborator **disagree**, primary 0.95, tesseract 0.90 | 0.95 / (0.95 + 0.3645) | **0.723** | `ACCEPT_FLAGGED` → the primary's text is accepted **and the region goes to review** |
| Primary uncertain (0.55), corroborator confident (0.95) and disagreeing | 0.55 / (0.55 + 0.3848) | **0.588** | `DISPUTED` → **no value is auto-accepted** |
| Corroborator + H1 handwriting recogniser agree against the primary (all ~0.9) | (0.3645 + 0.4455) = 0.810 vs 0.900 | **0.526** for the pair, 0.526 → primary wins the column at `a = 0.900/1.710 = 0.526` | `DISPUTED` — and note the primary **still wins the text** while the region goes to priority-1 review, which is the correct split: the machine keeps its best guess, the human makes the decision |

That third row is the designed behaviour and the reason the weights are what they are: **any primary/corroborator disagreement lands in review and is never silently auto-accepted**, because 0.723 sits inside the `[0.60, 0.90)` band by construction. The margin, restated on the corrected arithmetic: with `W_tesseract` at 0.45 the disagreement ratio is 0.723; at 0.20 it is 0.841 — still flagged; at **0.10 it is 0.913**, which crosses `OCR_CONSENSUS_AGREED_MIN` and would **auto-accept a disagreement**. The cliff sits between 0.10 and 0.20; 0.45 is comfortably clear of it, and stays clear even after the 0.90 line-granularity penalty, which is the property the penalty had to preserve.

**A boot assertion, not a comment.** Because that cliff is a property of two numbers owned in two places (`consensus.weights` and `consensus.outcomes`), it is asserted rather than remembered: at boot, for every registered non-primary recogniser `r`, the system computes the disagreement ratio `1 / (1 + W_r · g_r)` at equal confidence and refuses to start if it is `≥ OCR_CONSENSUS_AGREED_MIN`. A future weight change that would silently make disagreements auto-acceptable therefore fails in staging.

### 7.5 Gaps, deletions, and the digit rule

An alignment gap is a **cluster value like any other** — the value "nothing here". A gap column therefore accumulates weight from every candidate that has no cluster at that column, and a gap can win, which means the cluster is deleted from `acceptedText`.

**Three hard rules on deletion:**

1. If a gap wins a column whose competing cluster is a **digit** (Arabic `0-9` or Thai `๐-๙`, `U+0E50–U+0E59`), the deletion is **not** applied: the cluster is kept, `deletionDisputed = true` is set, and the region outcome is forced to **`DISPUTED`**. A number silently deleted by vote is the single worst failure this layer can produce, and it is unrecoverable downstream because nothing knows a digit is missing.
2. The same rule applies to any cluster inside a region overlapping a field with `isSensitive = true`.
3. Otherwise a won gap is applied and the column index is recorded in `disputedClusterIndices` regardless of `a_column`, so a deletion is always visible in the review UI.

### 7.6 Ties

An exact weight tie is reachable — `W · c` is a product of two floats drawn from small sets, and two candidates landing on the same value is not exotic (0.45 × 0.90 × 0.90 = 0.3645 and 0.55 × 0.6627 × 0.90 = 0.3280 differ, but equal-confidence pairs among reserved recognisers collide readily once H1 registers). **The first draft claimed the §7.4 worked example produced an exact tie; after §7.3's granularity penalty it no longer does, and that sentence is withdrawn rather than left standing on stale arithmetic.** A tie is resolved **deterministically and recorded**, never by a coin flip:

```
OCR_CONSENSUS_TIE_BREAK_ORDER = paddle-onnx-th,tesseract-tha,thai-trocr-hw,typhoon-vlm

winner = the cluster value supported by the earliest recognizer in that order
tieBroken = true  ->  tieBrokenCount++ on the consensus row
if the tied column is a digit OR the region overlaps a sensitive field:
        outcome is forced to DISPUTED regardless of A
```

**Why the primary wins ties:** it is the only recogniser with a Thai-trained model. Preferring it on a tie is not a preference, it is the prior. And forcing `DISPUTED` on a tied digit means the tie-break never silently decides money.

**`OCR_CONSENSUS_TIE_BREAK_ORDER` is validated, not trusted.** At boot the parsed list must be a permutation of the registered `RecognizerId` set with no duplicates and no unknown members, and its first element must equal `OCR_ENGINE_PRIMARY_ID`. A misordered list is a silent authority change — the corroborator would start deciding ties — so it is a boot refusal, not a warning.

**`OCR_CORROBORATE_SELECTOR`** — which regions get a second candidate at all. Running Tesseract on every region of a 500-page document is ~4× the OCR cost for regions that were never in doubt. The selector, evaluated per region, is:

```
corroborate  iff  region.kind != NOISE
            AND  ( primary.calibratedConfidence < OCR_CORROBORATE_CONF_CEILING (= 0.97)
                OR region overlaps a field with isSensitive = true
                OR region contains >= 1 digit cluster
                OR random() < OCR_CORROBORATE_AUDIT_RATE (= 0.02) )
            AND  the page's corroboration budget is not exhausted   <-- see below
```

The audit-rate term exists for the same reason as `OCR_CALIBRATION_AUDIT_SAMPLE_RATE`: without it, the corroborator only ever sees regions the primary already doubted, so its measured disagreement rate is biased and tells us nothing about the regions we auto-accept. `random()` is seeded from `regionId` so a re-run makes the same choices — the consensus layer stays deterministic even though it contains a sampling rule.

**The budget clause is the correction, and it is not optional.** As first drafted this selector was **unbounded**: on a poor scan, `calibratedConfidence < 0.97` is true for essentially every region, so the corroborator would run on ~all regions of ~all pages. `c3-ocr-routing-policy.md` already owns exactly this cost and bounds it — `OCR_ROUTE_MULTIENGINE_MAX_LINES_PER_PAGE = 12`, `OCR_ROUTE_MULTIENGINE_MAX_PAGES_PER_DOC = 20`, and an extra-pass ledger (`OCR_ROUTE_EXTRA_PASS_BUDGET_PER_DOC = 16.0` pass units, a multi-engine line batch costing 0.30) whose entire purpose is to make the frozen `JOB_PROCESSING_BUDGET_MS` (`f2`) close deterministically. An unbounded corroborator **spends a budget it does not own and breaks a frozen limit it does not cite.**

Resolution, and the boundary this document accepts:

- **c3 owns the budget.** Corroboration draws from c3's extra-pass ledger at c3's stated unit cost and stops when c3's ledger is exhausted, exactly as c3's own multi-engine trigger does. This document adds **no second budget**.
- **c3 owns the volume caps.** The selector above is evaluated only on regions c3's V2/V3/V4 triggers have already admitted, and never on more than c3's per-page line cap or per-document page cap. Where the two disagree, **c3 wins**, because c3's number is the one `f2`'s job budget was closed against.
- **This document owns what happens to a candidate once c3 has paid for it** — the alignment, the weights, the verdict, the provenance and the evidence rows.
- The `OCR_CORROBORATE_AUDIT_RATE = 0.02` term is the **one genuinely new draw** on c3's ledger, because it deliberately corroborates regions c3's triggers would not have selected. At 2 % of regions it is ~1 extra line batch per 50 regions; it is small, it is the only thing that de-biases the disagreement measurement, and it must appear as a named line item in c3's ledger rather than as an invisible overrun. This is raised as **§13 conflict 2**.

Exhausting the budget is `OcrWarning.CORROBORATION_BUDGET_EXCEEDED`: the affected regions become `SINGLE_SOURCE`, which under §7.7 can never auto-accept a critical field. It **fails toward review, never toward silent acceptance** — the same rule c3 applies to its own ledger.

### 7.7 What consensus does NOT do

- It does not re-rank whole candidates. It elects per column. A region's accepted text can therefore be a string **no single engine produced** — which is correct, and which is why `acceptedText` lives on `region_consensus` and not as a pointer to a candidate.
- It does not touch `rawText`. Ever.
- It does not run across runs. A consensus row is scoped to one `runId`, per the frozen `uniq.document_run_seq` model.
- It does not decide auto-accept on its own. `AGREED` is *necessary* for auto-accept, never *sufficient*: `f` §2.6's critical-field gate (`T_ocr = 0.98`) still applies, and `SINGLE_SOURCE` can never auto-accept a critical field no matter how high the confidence.

---

## 8. The immutability invariant

**Binding rule: raw evidence is immutable.** These tables are append-only:

`page_renders`, `document_regions`, `region_candidates`, `region_consensus`, `ocr_results`, `document_analyses`, `corrections`, `audit_logs`.

Enforced in the database, not by convention:

```sql
CREATE OR REPLACE FUNCTION evidence_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'EVIDENCE_IMMUTABLE: % rows are append-only', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- The ONLY permitted mutation is the PDPA purge, and only by ocr_erasure (f1 db.roles).
  IF current_user <> 'ocr_erasure' THEN
    RAISE EXCEPTION 'EVIDENCE_IMMUTABLE: % rows may not be updated by %',
      TG_TABLE_NAME, current_user USING ERRCODE = 'restrict_violation';
  END IF;
  IF to_jsonb(NEW) - 'purged_at' IS DISTINCT FROM to_jsonb(OLD) - 'purged_at' THEN
    RAISE EXCEPTION 'EVIDENCE_IMMUTABLE: erasure may set purged_at only'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

-- applied per table:
CREATE TRIGGER document_regions_append_only
  BEFORE UPDATE OR DELETE ON document_regions
  FOR EACH ROW EXECUTE FUNCTION evidence_append_only();
```

**This reconciles immutability with PDPA erasure**, which is otherwise a direct contradiction: erasure must remove content, immutability must forbid change. The resolution is that erasure never *edits* evidence — it sets `purged_at`, and the content it removes lives in object storage and is crypto-shredded there under `gate-2-pdpa-retention.md`'s regime. The row remains as proof that a thing existed and was erased, which is itself an audit obligation.

`DELETE` is refused even for `ocr_erasure`, so the frozen `onDelete: Cascade` relations must never fire on these tables; the erasure path sets `purged_at` top-down and the *document* row is soft-deleted. A cascade delete reaching an evidence table is a bug, and this trigger makes it a loud one.

---

## 9. Six-part provenance, end to end

**The requirement:** final text and every structured field must be traceable to
`document → page → bounding box → engine → raw candidate → confidence`.

### 9.1 The chain, link by link

| Part | Carried by | Column / field |
|---|---|---|
| 1. **document** | `ExtractionFieldValue.documentId` → `Document.publicId` | the 32-char external id, per the frozen `id.external.shape` |
| 2. **page** | `DocumentRegion.documentPageId` → `DocumentPage.pageNumber`, and `PageRender.id` for the exact render | `pageNumber` + `pageRenderId` + `renderDpi` |
| 3. **bounding box** | `FieldValueSource.clusterQuadsJson` (SOURCE space) and `DocumentRegion.quadJson` | `SpacedQuad<'SOURCE'>[]`, projectable to any space via `page_renders` |
| 4. **engine** | `RegionCandidate.recognizerId` + `recognizerVersion` | e.g. `paddle-onnx-th` / `ppocrv5-th@det:v5m/rec:v5th/dict:20260611/rt:onnx-3.9.2` |
| 5. **raw candidate** | `RegionCandidate.id` + `rawText` (byte-exact) + `payloadRef` (immutable blob) | the exact bytes the engine emitted |
| 6. **confidence** | `RegionCandidate.confidence`, `.calibratedConfidence`, `.calibrationKey`, and per cluster `ClusterSpan.confidence` | plus `RegionConsensus.agreement` and the per-column `a_column` |

### 9.2 `field_value_sources` — the join that makes it navigable

```prisma
/// APPEND-ONLY. Which raw candidate clusters a field value came from.
/// n:m because one field may span several regions (a multi-line address) and one region
/// may feed several fields (a table row).
model FieldValueSource {
  id                  String   @id @db.Uuid
  organizationId      String   @map("organization_id") @db.Uuid
  documentId          String   @map("document_id") @db.Uuid
  extractionFieldValueId String @map("extraction_field_value_id") @db.Uuid
  regionCandidateId   String   @map("region_candidate_id") @db.Uuid
  regionConsensusId   String?  @map("region_consensus_id") @db.Uuid

  ordinal             Int                                     // order within a multi-region field
  clusterStart        Int      @map("cluster_start")          // inclusive, into the candidate's clusters
  clusterEnd          Int      @map("cluster_end")            // exclusive
  clusterQuadsJson    Json     @map("cluster_quads_json") @db.JsonB   // SpacedQuad<'SOURCE'>[]
  clusterMinConfidence Float?  @map("cluster_min_confidence")  // MIN over the span, never mean
  /// TRUE when this row was copied forward from a superseded value by a human correction.
  /// This is what makes a corrected field still point at the original raw candidate. §9.4
  inheritedFromValueId String? @map("inherited_from_value_id") @db.Uuid

  createdAt           DateTime @default(now()) @map("created_at") @db.Timestamptz(3)

  value     ExtractionFieldValue @relation(fields: [extractionFieldValueId, organizationId],
                                           references: [id, organizationId], onDelete: Cascade)
  candidate RegionCandidate      @relation(fields: [regionCandidateId, organizationId],
                                           references: [id, organizationId], onDelete: Restrict)

  @@unique([extractionFieldValueId, regionCandidateId, clusterStart],
           map: "field_value_source_value_candidate_start_key")
  @@index([organizationId, regionCandidateId], map: "field_value_source_org_candidate_idx")
  @@map("field_value_sources")
}
```

`onDelete: Restrict` on the candidate is deliberate: **a raw candidate cannot be deleted while a field value points at it.** The frozen `Correction` model's `onDelete: Cascade` relations are on the *correction* side; evidence is `Restrict` on the *pointed-at* side.

### 9.3 The resolved provenance DTO

What the API returns for "show me where this number came from" — one round trip, no client-side joins:

```ts
export interface FieldProvenance {
  readonly documentPublicId: string;             // 1. document
  readonly pageNumber: number;                   // 2. page
  readonly pageRenderId: string;
  readonly renderDpi: number;
  readonly sourceSpace: 'PDF_POINT' | 'RASTER_PX';
  readonly geometryGranularity: 'cluster' | 'word' | 'line' | 'region';
  readonly quads: readonly SpacedQuad<'SOURCE'>[];   // 3. bounding box(es)
  readonly sources: readonly {
    readonly recognizerId: RecognizerId;             // 4. engine
    readonly recognizerVersion: string;
    readonly candidateId: string;                    // 5. raw candidate
    readonly rawTextSpan: string;                    //    the exact bytes, sliced
    readonly clusterStart: number;
    readonly clusterEnd: number;
    readonly confidence: number | null;              // 6. confidence
    readonly calibratedConfidence: number | null;
    readonly calibrationKey: string;
    readonly won: boolean;                           // did this candidate win the consensus?
    readonly inherited: boolean;                     // carried forward through a correction
  }[];
  readonly consensus: {
    readonly outcome: ConsensusOutcome;
    readonly agreement: number | null;
    readonly disputedClusterIndices: readonly number[];
    readonly tieBroken: boolean;
    readonly consensusVersion: string;
  } | null;
  readonly correctionChain: readonly {
    readonly correctionId: string;
    /** f1 tenant.principal_identity: the actor is a Membership, never a User. */
    readonly actorMembershipId: string;
    /** DERIVED denormalisation for PDPA subject access, per f1 schema.owner_user_derivation.
     *  NEVER read by authorisation (f1 VIS-2). */
    readonly actorUserId: string;
    readonly at: string;                             // ISO-8601
    readonly previousValueText: string | null;
    readonly newValueText: string | null;
    readonly reasonCode: string | null;
  }[];
}
```

`geometryGranularity = 'region'` is the honest answer when the winning recogniser declared `emitsSubLineGeometry: 'none'` (the H1/H2 handwriting case). The UI then highlights the whole region, and the API says so, rather than fabricating a tighter box.

### 9.4 How a corrected field still points at the original raw candidate

The frozen `ExtractionFieldValue` model already carries `origin: FieldValueOrigin`, `isCurrent`, and `supersedesId`. A human correction is therefore **never an update** — it is a new row:

```
Transaction (one, per f2's QUOTA_CHECK_ORDERING discipline of doing the write and the ledger together):

 1. UPDATE extraction_field_values SET is_current = false WHERE id = $old       -- the ONE mutable flag
 2. INSERT extraction_field_values ( id = $new, origin = 'HUMAN', is_current = true,
                                     supersedes_id = $old,
                                     created_by_membership_id = $actorMembership,   -- see note
                                     created_by_user_id       = $actorUser,         -- DERIVED only
                                     value_text = $corrected, confidence = NULL,
                                     page_number, quad_json  <- COPIED from $old )
 3. INSERT field_value_sources  -- for EVERY row that pointed at $old:
        ( extraction_field_value_id = $new,
          region_candidate_id       = <unchanged>,
          region_consensus_id        = <unchanged>,
          cluster_start / cluster_end / cluster_quads_json = <unchanged>,
          inherited_from_value_id    = $old )
 4. INSERT corrections ( target_kind = 'FIELD_VALUE', field_value_id = $old,
                         action = 'SET_VALUE', previous_value_text, new_value_text,
                         reason_code,
                         actor_membership_id = $actorMembership,   -- THE actor identity
                         actor_user_id       = $actorUser )        -- DERIVED only
 5. INSERT correction_samples  -- §10, only when the tenant's training consent permits
```

**On the actor identity — corrected by review.** The first draft wrote `actor_user_id` and `created_by_user_id` as *the* actor columns. That is drift against `f1-tenant-visibility-model.md`'s frozen `tenant.principal_identity`: **`Membership.id`, NOT `User.id`** — "only a membership can carry a composite FK on `(id, organization_id)`; a global users FK cannot express tenant containment". A bare `actor_user_id` FK on a tenant-scoped evidence table is precisely the shape TEN-1 exists to forbid, and it would make "who corrected this, and were they in this organisation at the time?" a question the schema cannot answer.

Both columns are kept, with the roles the frozen model already establishes:

- **`actor_membership_id` NOT NULL** is the actor. It carries the composite FK `(actor_membership_id, organization_id) → memberships(id, organization_id)` per TEN-1, and it is the only column any authorisation or accountability query reads.
- **`actor_user_id` NOT NULL is a DERIVED denormalisation** of `memberships.user_id`, maintained by a `BEFORE INSERT` trigger and **never read by authorisation** — the identical pattern, for the identical reason, as the frozen `schema.owner_user_derivation` on `documents.owner_user_id`: PDPA subject-access and erasure ask their question about a *user*, not about a membership. Reading it in an authz path would violate the frozen `VIS-2` invariant.

`FieldProvenance.correctionChain[].actorUserId` (§9.3) is likewise renamed `actorMembershipId`, with `actorUserId` retained beside it for the subject-access view, and both are populated from the derived pair rather than from a session.

**Step 3 is the answer to the owner's question.** The corrected value inherits the *pointers*, not the *text*. So `FieldProvenance` for the corrected value still resolves to `RegionCandidate.rawText` — the bytes `paddle-onnx-th` actually emitted — with `inherited: true` on every source row and `confidence: null` on the value itself (a human-entered value has no engine confidence, and inventing one would be a lie).

`ExtractionFieldValue.confidence` is `null` and `origin = 'HUMAN'`, so no downstream gate can mistake a human value for a high-confidence machine value. And because `field_value_sources` is append-only with `onDelete: Restrict` on the candidate, the original evidence cannot be garbage-collected while any corrected descendant points at it.

**The chain survives arbitrarily many corrections**: value₃ → `supersedesId` → value₂ → value₁, and every one of them carries its own `field_value_sources` rows with `inheritedFromValueId` forming a parallel chain. `FieldProvenance.correctionChain` walks it.

---

## 10. Human review and the correction dataset

### 10.1 The review queue

Priority is a number, computed once, stored:

```
priority 1 (highest)  outcome == DISPUTED
                   OR deletionDisputed == true
                   OR outcome == NO_CANDIDATE
                   OR E5 fired (detection suspected failure)
                   OR any disputed cluster is a digit inside a field with isSensitive = true
priority 2            outcome == ACCEPT_FLAGGED
                   OR any of E1, E2, E3, E6 fired
                   OR calibratedConfidence == null on a critical field (unseen calibration key)
priority 3            outcome == SINGLE_SOURCE on a critical field
priority 4            the OCR_CALIBRATION_AUDIT_SAMPLE_RATE / OCR_REGION_CROP_AUDIT_RATE samples
                      (labelled `audit`, priced into the review budget, and NOT counted in the
                       reviewer-throughput SLA)
```

Priority 4 exists to de-bias the drift monitor, which is the panel's ops finding (3) second recommendation. Auto-accepted fields are by construction absent from the review queue, so an ECE recomputed over reviewed items is estimated on a sample selected *against* the failures it exists to catch. A labelled random audit stream is the only fix, and it must be budgeted, not hoped for.

### 10.2 `correction_samples` — the accumulating dataset

```prisma
/// The training-set accumulation. WRITTEN ONLY when the organisation's training consent permits.
model CorrectionSample {
  id                 String   @id @db.Uuid
  organizationId     String   @map("organization_id") @db.Uuid
  documentId         String   @map("document_id") @db.Uuid
  correctionId       String   @map("correction_id") @db.Uuid
  regionCandidateId  String   @map("region_candidate_id") @db.Uuid
  documentRegionId   String   @map("document_region_id") @db.Uuid

  regionKind         RegionKind @map("region_kind")
  cropStorageObjectId String? @map("crop_storage_object_id") @db.Uuid    // null under AGGREGATE consent
  cropSha256         String?  @map("crop_sha256") @db.VarChar(64)
  engineText         String   @map("engine_text")                        // the raw candidate span
  humanText          String   @map("human_text")                         // the corrected span
  editDistance       Int      @map("edit_distance")                      // cluster-level Levenshtein
  errorClass         String?  @map("error_class") @db.VarChar(60)        // §10.4 taxonomy
  recognizerId       String   @map("recognizer_id") @db.VarChar(40)
  recognizerVersion  String   @map("recognizer_version") @db.VarChar(160)
  calibrationKey     String   @map("calibration_key") @db.VarChar(64)

  consentBasis       TrainingConsent @map("consent_basis")               // recorded AT WRITE TIME
  consentRecordedAt  DateTime @map("consent_recorded_at") @db.Timestamptz(3)
  exportedAt         DateTime? @map("exported_at") @db.Timestamptz(3)
  purgedAt           DateTime? @map("purged_at") @db.Timestamptz(3)
  createdAt          DateTime @default(now()) @map("created_at") @db.Timestamptz(3)

  candidate RegionCandidate @relation(fields: [regionCandidateId, organizationId],
                                      references: [id, organizationId], onDelete: Restrict)

  @@unique([correctionId, regionCandidateId], map: "correction_sample_correction_candidate_key")
  @@index([organizationId, regionKind, createdAt], map: "correction_sample_org_kind_created_idx")
  @@index([organizationId, errorClass, recognizerId], map: "correction_sample_org_error_recognizer_idx")
  @@map("correction_samples")
}

enum TrainingConsent { NONE AGGREGATE CROP_LEVEL }
```

`Organization.trainingDataConsent : TrainingConsent @default(NONE)`.

| Consent | What is written | What can be used for |
|---|---|---|
| **`NONE`** (**the shipped default**) | **no `correction_samples` rows at all** | nothing |
| `AGGREGATE` | row **without** `cropStorageObjectId` and **without** `engineText`/`humanText`; only `errorClass`, `editDistance`, `regionKind`, `recognizerId`, `calibrationKey` | error-taxonomy analytics, calibration-map fitting, benchmark prioritisation — **never model training** |
| `CROP_LEVEL` | full row including the crop reference and both texts | model fine-tuning, including a future Thai handwriting recogniser |

`consentBasis` is stamped **at write time** and never back-filled. A tenant who upgrades consent in March does not thereby license February's documents; a tenant who downgrades has their existing `CROP_LEVEL` rows purged by the same erasure path (`purged_at`, §8).

### 10.3 PDPA consequence — this is flagged, and it is blocking

**Building a training set out of customer documents is a new purpose under PDPA, not a continuation of the original one.** Concretely, and stated so the owner can act on it rather than discover it:

1. **New purpose, new lawful basis.** The lawful basis for processing a Thai identity document to *extract its fields for the customer* does not extend to *retaining crops of it to train a model*. Under the Personal Data Protection Act B.E. 2562 that is a separate purpose requiring its own basis, and for identity-document data — which includes data capable of identifying a person and, where a document carries religion or health information, PDPA **§26** special-category data — consent is the realistic basis and it must be **explicit, purpose-specific, and separable** from the service contract. A checkbox bundled into terms of service does not meet the separability requirement.
2. **A trained model is not erasable.** This is the consequence with no technical mitigation. `gate-2-pdpa-retention.md`'s crypto-shredding regime deletes objects by destroying keys. **It does not reach model weights.** Once a crop of a customer's national ID card has been used to fine-tune a recogniser, a subject-access erasure request cannot remove its influence from the weights. The only controls are (a) never train on it — the default — or (b) retain the training manifest, the base checkpoint and the training code so the model can be **rebuilt from scratch** with the erased sample excluded, and commit contractually to doing so within a stated window. Option (b) is expensive and must be a deliberate, budgeted commitment, not an assumption.
3. **The processor question.** If any fine-tuning happens on infrastructure we do not control, that operator becomes a data processor and must appear in the RoPA with a DPA — the same obligation `OcrCapabilities.trust.processorId` exists to record.
4. **Cross-tenant contamination.** A model trained on tenant A's corrections and served to tenant B has moved A's data into B's product. Memorisation of rare strings by sequence models is a documented phenomenon and a Thai national ID number is exactly the shape of string that gets memorised. **Rule: a model fine-tuned under `CROP_LEVEL` consent may be served only to the tenants whose data trained it, unless every contributing tenant has separately consented to cross-tenant use.** This is a product constraint, and it is the reason a shared handwriting model may be much harder to ship than the technical work suggests.
5. **Retention.** `correction_samples` inherit the document's retention. A sample whose source document is erased is purged. This is enforced by the erasure path walking `correction_samples` alongside `region_candidates`; it is not a scheduled job that might be behind.

**OWNER-BLOCKED (B-1).** Whether to offer `AGGREGATE` and `CROP_LEVEL` consent at all is a legal and commercial decision this session cannot make. **Named default that ships if the owner stays silent: `TrainingConsent.NONE` for every organisation, no consent UI, and `correction_samples` created as an empty table.** The architecture is present, the switch is off, and no customer data accumulates.

### 10.4 The error taxonomy — what the dataset is for even under `AGGREGATE`

`errorClass` is a closed enum, assigned by a deterministic classifier over `(engineText, humanText)` at correction time:

| Class | Rule | Why it is the interesting one |
|---|---|---|
| `DIACRITIC_LOST` | edit is confined to codepoints in `U+0E31, U+0E34–U+0E3A, U+0E47–U+0E4E` | the dominant Thai failure mode (M0 §7.2). Its rate is the single best measure of whether C4-D2's short-axis pad worked |
| `DIACRITIC_SPURIOUS` | same set, insertion rather than deletion | over-padding; the counter-signal to the above |
| `THAI_DIGIT_CONFUSION` | edit maps `U+0E50–U+0E59` ↔ `0-9` | M0 §7.3's verified Python trap, now measurable |
| `CONSONANT_CONFUSION` | edit is a single Thai consonant substitution | feeds the confusion matrix M0 §7.6 asks for |
| `SEGMENTATION` | edit is whitespace-only | a tokenisation problem, not an OCR problem (M0 §7.1) |
| `NUMERIC_DIGIT` | edit changes an Arabic digit | the highest-severity class; alerted on separately |
| `HALLUCINATION` | `humanText` is a strict subsequence of `engineText` and the winning candidate was `trust.generative` | direct evidence for or against the §7.3 co-signature rule |
| `LAYOUT` | the correction moved a value between fields without changing its text | an extraction problem, not a recognition problem |
| `OTHER` | anything else | must stay below 20 % or the taxonomy is wrong |

Under `AGGREGATE` consent this table alone tells us which knob to turn next, per engine, per document class, without retaining a single crop or a single character of customer text.

---

## 11. Open items

| # | Item | Status | Named default that ships on silence |
|---|---|---|---|
| **B-1** | Training-data consent: offer `AGGREGATE` / `CROP_LEVEL` at all? (§10.3) | **OWNER-BLOCKED** — legal | `TrainingConsent.NONE` for all organisations; no consent UI; empty table |
| **B-2** | Training data for the region classifier (§5.3). We have no labelled Thai printed-vs-handwritten corpus and cannot create one from customer documents under B-1's default. | **OWNER-BLOCKED** | `OCR_REGION_CLASSIFIER_ENABLED=false`; every region `UNKNOWN`; the whole region/candidate/consensus stack ships and works without it |
| **B-3** | Is handwriting in commercial scope, and at what accuracy would it be sold? Every credible Thai handwriting number is ≥ 19 % CER. | **OWNER-BLOCKED** | No handwriting recogniser registered; `HANDWRITTEN` regions produce `NO_CANDIDATE` and a mandatory review item |
| **B-4** | GPU approval, which gates C4-D4 rung H2 and any generative corroborator | **OWNER-BLOCKED** (also M0 §12 blocker 2) | `OCR_DEFAULT_AI_EGRESS_POLICY=DENY_ALL`; no generative recogniser registered |
| **B-5** | Typhoon weights licence: card `apache-2.0` vs paper `CC BY-SA 4.0` (M0 §3.2) | **OWNER-BLOCKED** — legal | `typhoon-vlm` is not registered and cannot be; C4-D4 rung H2 is unreachable |

**Measurements this session could not make** (all require running an engine, which the milestone forbids):

1. `paddle-onnx-th` median and p95 CER on ≥ 200 real Thai pages — the whole point of M2.
2. Per-cluster box accuracy from `return_single_char_box=True` on Thai. Validation method, already implementable: compare against **Tesseract's per-word TSV on the Latin lines of the same pages**, where ground-truth word boxes genuinely exist, then extrapolate the error bound to Thai clusters. This converts §2.1 from "the mechanism exists" to "the mechanism is accurate to ±N px".
3. The real cost of `Global.use_preprocess_img=false` + `OCR_DET_LONG_SIDE_PX=1600` versus the shipped default, in seconds per A4 page on the target CPU allocation.
4. The `OCR_DET_SHORT_AXIS_PAD_FRAC` sweep, scored on diacritic-restricted CER **and** merge rate.
5. Region-classifier latency (§5.3, marked UNVERIFIED).
6. Whether `PP-OCRv6_medium_det` ⊕ `th_PP-OCRv5_mobile_rec` beats the v5 detector on Thai. Sequenced **after** items 3 and 4, because v6's +4.6 pp Hmean is measured on a 15-category benchmark that contains no Thai — a plausible transfer, not a measured one.

---

## 12. Challenges to frozen values

Both are implemented as frozen in this document. Neither is deviated from. Each is raised for the orchestrator to arbitrate.

### CH-1 — `f2-canonical-limits.md` `RENDER_DPI_DEFAULT = 300` interacts badly with an undocumented engine default

**Not a challenge to the value.** 300 DPI is right. The challenge is that `f2` records it as a bare number with the rationale "8.7 Mpx A4, ~18 MiB peak greyscale", which is a *memory* derivation. §2.2 shows that at 300 DPI, RapidOCR's shipped `Global.max_side_len = 2000` silently discards 43 % of the linear resolution the DPI was chosen to provide — so the frozen value is correct and, at library defaults, **not delivered**. **Proposed amendment:** `f2`'s `RENDER_DPI_DEFAULT` row should carry a failure-behaviour note pointing at `ocr.rapidocr.use_preprocess_img = false`, because the DPI limit and the engine config are one decision recorded in two documents, which is the exact drift shape M0.5 exists to prevent.

### CH-2 — `f2-canonical-limits.md` `PROVISIONAL_PER_PAGE_OCR_S = 25` is now derived from a superseded pipeline shape

**Not a deviation.** 25 s/page and the derived `MAX_OCR_PAGES_PER_DOCUMENT = 50` remain provisional. C4-D2 changes the per-page work in two directions at once: detection gets **~4.8× cheaper** (1.81 Mpx vs 8.79 Mpx), while recognition gets a **second engine** on the `OCR_CORROBORATE_SELECTOR` subset and per-character box computation on every line. The number therefore describes an older pipeline shape until M-1 runs. **Proposed handling:** keep 25 s as the M1 starting estimate, retain `PAGE_OCR_TIMEOUT_S = 45` as the hard ceiling, and include C4-D2's complete pipeline in the M-1 measurement. It is not a measured production ceiling.

---

## CANONICAL VALUES

Every value below is **owned by this document**. Another document must cite it as `c4-ocr-provider-and-handwriting.md`, never restate it.

| key | value | env var | reason | failure behaviour |
|---|---|---|---|---|
| `ocr.provider.primary` | `paddle-onnx-th` — pinned triple `det:PP-OCRv5_mobile_det / rec:th_PP-OCRv5_mobile_rec / dict:ppocrv5_th_dict`, runtime `rapidocr` 3.9.2 / ONNX Runtime | `OCR_ENGINE_PRIMARY_ID` | Only candidate passing all five gates (§1.4) with A1 ≥ 3; weights licence **verified Apache-2.0** this session, closing M0 §12 spike 6; only candidate emitting per-cluster Thai geometry **and** per-cluster confidence | Unavailable on a Thai-expected page ⇒ job FAILS CLOSED with `ENGINE_UNAVAILABLE` and the document enters review. Never silently degrades. |
| `ocr.provider.corroborator` | `tesseract-tha` — Tesseract 5.5.3 + `tessdata_best/tha`+`eng`, `--psm 7` | `OCR_ENGINE_CORROBORATOR_ID` | Renamed from M0's "FALLBACK": the primary has no network dependency so that failure mode does not exist, and both share a container so they share fate. Its real value is statistical independence for §7 | Unavailable ⇒ candidates are single-source ⇒ `SINGLE_SOURCE` outcome ⇒ critical fields go to review. Never blocks a document. |
| `ocr.provider.handwriting` | **none registered.** Ladder H1 `thai-trocr-hw` → H2 `typhoon-vlm` → H3 commercial API, gates in §C4-D4 | `OCR_HANDWRITING_RECOGNIZER_ID` (**empty string = none; unset = boot refusal**) | Every credible Thai handwriting figure is ≥ 19 % CER for the best open model. Shipping that into an audit record is a liability, not a feature | `HANDWRITTEN` region ⇒ zero candidates ⇒ `NO_CANDIDATE` ⇒ mandatory priority-1 review. Never an empty string, never a printed-engine guess. |
| `ocr.sub_line_geometry` | `'cluster'` — per **extended grapheme cluster**, via `return_word_box=True` + `return_single_char_box=True`; CTC frame indices from `WordInfo.word_cols` | n/a — a capability | Refutes panel F1 on the mechanism: RapidOCR exposes CTC frame alignment as a public parameter and already inverts the crop perspective back to page space | A recogniser declaring `'none'` yields `ClusterSpan[] = []` and `FieldProvenance.geometryGranularity = 'region'`. A box is **never** fabricated. |
| `ocr.cluster_confidence_rule` | **MINIMUM** over the cluster's codepoints | n/a — a rule | A base at 0.99 with a tone mark at 0.31 is a 0.31 cluster. Averaging to 0.65 hides the dominant Thai failure mode inside an acceptable-looking number | A cluster with any `null` codepoint confidence has `confidence = null`, which the existing hard gates already fail closed on. |
| `ocr.conf_realignment_rule` | Rebuild `confs`↔character mapping by index (`[c for ch,c in zip(text,confs) if not ch.isspace()]`); assert `len(confs) == len(text)` | n/a — a rule | `CTCLabelDecode.get_word_info` drops whitespace columns from `word_cols` but keeps them in `confs`, so RapidOCR's own `zip()` misattributes every confidence after a space. Thai uses the space as a phrase separator | Length mismatch ⇒ `EngineContractViolation('CONF_LEN_MISMATCH')` ⇒ the **page fails**. The adapter never guesses an alignment. |
| `ocr.rapidocr.use_preprocess_img` | `false` | `OCR_RAPIDOCR_USE_PREPROCESS_IMG` | The shipped default (`max_side_len = 2000`) downscales A4@300 by **0.570** *before the recogniser crop is cut*, and `map_img_to_original` only interpolates back up. Thai tone marks go from 2–5 px to 1.1–2.9 px, irrecoverably | Asserted at `warmup()` against the live object; mismatch ⇒ `EngineConfigDrift` ⇒ **container refuses to start**. |
| `ocr.rapidocr.text_score` | `0.0` | `OCR_RAPIDOCR_TEXT_SCORE` | The default `0.5` makes `filter_by_text_score` **delete** lines below 0.5. An audit-grade product must not discard evidence inside the engine; filtering is a downstream decision made with a recorded threshold | Any non-zero value ⇒ `EngineConfigDrift` ⇒ container refuses to start. |
| `ocr.rapidocr.det_unclip_ratio` | `1.6` (the **verified** shipped default on `main`) | `OCR_RAPIDOCR_DET_UNCLIP_RATIO` | M0 §6 said "~1.5", the adversarial panel said "2.0". Both are wrong: `ch_ppocr_det/main.py` uses `cfg.get("unclip_ratio", 1.6)`, overriding `DBPostProcess`'s signature default of 2.0. Demoted to the **fourth** accuracy knob | Read from the live `postprocess_op` at `warmup()`, not from the YAML; mismatch ⇒ container refuses to start. |
| `ocr.det.long_side_px` | `1600` | `OCR_DET_LONG_SIDE_PX` | Detection is resolution-tolerant, recognition is not. 1600 puts an A4@300 Thai line at 20 px — inside the detector's trained 736–960 regime — while recognition still sees the full 44 px. 4.8× cheaper than full-res detection and cheaper than RapidOCR's own destructive default | Part of `detParamsHash` ⇒ changing it invalidates the calibration map ⇒ `calibratedP = null` ⇒ hard gates fail closed. |
| `ocr.det.short_axis_pad_frac` | `0.18` (M2 sweep `{0, 0.10, 0.18, 0.26, 0.34}`) | `OCR_DET_SHORT_AXIS_PAD_FRAC` | Replaces the `det_db_unclip_ratio` sweep as the Thai box-height experiment. `unclip_ratio` is an **isotropic** pyclipper offset, so raising it also reaches ~0.35·h sideways and merges the dotted-leader columns of Thai government forms. 0.18 × 44 px = 7.9 px vertically, **0 px horizontally** | Part of `detParamsHash`. Sweep scored on diacritic-restricted CER **and** merge rate, so a merge regression is visible. |
| `ocr.onnx.thread_config` | `EngineConfig.onnxruntime.intra_op_num_threads = 1`, `inter_op_num_threads = 1`, set in `rapidocr.pinned.yaml` | n/a — **`ORT_INTRA_OP_NUM_THREADS` and `OMP_NUM_THREADS` MUST BE DELETED from compose** | `ORT_INTRA_OP_NUM_THREADS` is not an ONNX Runtime environment variable and modern Eigen-based builds ignore `OMP_NUM_THREADS`; `intra_op_num_threads` must go through `SessionOptions`, which RapidOCR exposes as this YAML key | Left as env vars, the setting is **inert**: ~4 intra-op threads inside a 1.5-CPU cgroup, CFS throttling, and `m` P3's sizing formula resting on a no-op. |
| `ocr.engine_version.format` | `ppocrv5-th@det:{det}/rec:{rec}/dict:{dictDate}/rt:{runtime}-{runtimeVersion}` | n/a — a contract | The triple is versioned as **one artefact**. Changing any part changes `engineVersion`, which changes `ocr.calibration_key`, which forces `calibratedP = null` | A swap fails closed instead of emitting confident numbers from a stale calibration map. |
| `ocr.warmup.assertions` | (1) effective-config equality against `rapidocr.pinned.yaml`, read from the **live objects**; (2) SHA-256 of every model artefact at **runtime**; (3) a vendored golden-page byte-exact decode + ≤ 0.5 px box round-trip | `OCR_ENGINE_STRICT_CONFIG=true` (refused false when `NODE_ENV=production`) | M0 D12 hashed weights at build only; M0 §9.5 knew defaults drift and did nothing about it | Any failure ⇒ the worker container **does not start**. A library upgrade that changes a default is caught in staging, not by a customer. |
| `ocr.calibration_key` | 12-tuple `(engineId, engineVersion, modelTripleHash, backend, backendVersion, renderDpi, detParamsHash, preprocessPipelineVersion, recipeHash, scriptTag, spanKind, consensusVersion)`, stored as sha256 `VarChar(64)`. `spanKind ∈ {cluster, line, page, region}` | `OCR_CALIBRATION_REQUIRE_MAP=true`, `OCR_CALIBRATION_MAX_ECE=0.05` | Replaces `f` §2.4 Step 5's 5-tuple, which omits backend, DPI, det params and pipeline version — every one of which the corpus itself treats as a tunable. A DPI flip currently keeps a stale map alive under a `T_ocr = 0.98` auto-accept gate on money fields | Unseen key ⇒ `calibratedP = null` ⇒ existing hard gates 5/7/8 fail closed. Production deploy is **refused** if any servable `(engine × backend × dpi × spanKind)` has no map with ECE ≤ 0.05. |
| `ocr.calibration_audit_rate` | `0.01` of auto-accepted fields injected into review as priority 4, labelled `audit` | `OCR_CALIBRATION_AUDIT_SAMPLE_RATE` | Auto-accepted fields are by construction absent from the review queue, so an ECE estimated on reviewed items is biased away from exactly the failures it exists to catch | Rate 0 ⇒ the drift monitor is blind and `OCR_CALIBRATION_ESCAPE_ALERT_RATE` cannot fire; boot refuses a value below 0.002 in production. |
| `ocr.calibration_escape_alert` | `0.001` critical-field escape rate, evaluated **weekly** | `OCR_CALIBRATION_ESCAPE_ALERT_RATE` | Alert on the escape rate directly, not only on ECE. Monthly is too slow for a payment-affecting field | Breach ⇒ page; auto-accept for the affected `calibrationKey` is disabled until a new map is fitted. |
| `coord.spaces` | Four: **SOURCE** (canonical, persisted), RENDER, DERIVATIVE, ENGINE | n/a — a contract | Panel F1-secondary: quads left the M0 port in derivative pixel space with no in-contract route back, making redaction and click-to-source unimplementable | A quad with the wrong space brand is a **compile error** (`SpacedQuad<S>`), not a runtime misplacement. |
| `coord.source_space.pdf` | PDF user space, **points (1/72 in)**, `/Rotate` applied, origin translated from `/CropBox` (fallback `/MediaBox`) lower-left to **top-left, y down**. `SourceSpaceKind.PDF_POINT` | n/a | The PDF page is the artefact of record and is resolution-independent, so a re-render at a different DPI produces boxes *comparable to* an earlier run, not merely rescalable from it | `/CropBox` absent ⇒ `/MediaBox`; both absent or degenerate ⇒ the page FAILS with `GEOM_SOURCE_UNDEFINED`. |
| `coord.source_space.raster` | The decoded pixel raster **with EXIF orientation applied**; `exifOrientation` recorded separately. `SourceSpaceKind.RASTER_PX` | n/a | This is the image the reviewer sees and the image a redaction must be correct against; the un-transposed raster stays reproducible from the recorded tag | Unreadable/absent EXIF ⇒ orientation 1 and `OcrWarning.EXIF_ORIENTATION_ASSUMED`. |
| `coord.chain` | `engineToDerivative` (per **call**, on `region_candidates`/`ocr_results`) → `derivativeToRender` (= `f` D16 `toOriginal`, verbatim) → `renderToSource` (per **render**, on `page_renders`); product `derivativeToSource` precomputed and stored | n/a | D16 is one link of four; storing only D16 leaves two links undefined, which is why it looked complete and was not | Any link missing ⇒ `page_renders` is not written ⇒ the page is never OCR'd. |
| `coord.roundtrip_tolerance_px` | `0.50` px (RASTER_PX) / `0.12` pt (PDF_POINT, = 0.5 px @ 300 DPI), on 4 corners + 16 seeded interior points | `OCR_GEOM_ROUNDTRIP_TOLERANCE_PX` | 0.5 px @ 300 DPI is 0.042 mm — far below reviewer perception. A page whose geometry cannot be trusted must not produce a box a human acts on | `> 0.50` and `≤ 2.0` ⇒ proceed with `GEOM_DEGRADED`, every derived field forced to review, **never** auto-accepted. `> 2.0` ⇒ render FAILS with `GEOM_ROUNDTRIP_EXCEEDED`. |
| `coord.persisted_space` | **SOURCE, always.** ENGINE-space quads survive only inside the immutable raw payload blob | n/a — a rule | One space to reason about downstream; the raw blob keeps what the engine actually said, because a projected number is not the engine's output | A persisted quad in any other space fails the `SpacedQuad<'SOURCE'>` type check at compile time. |
| `schema.page_renders` | New table, `@@unique([documentPageId, runId])`, carrying the chain + `roundTripMaxErrPx`. **`DocumentPage.renderStorageObjectId` is DELETED** and replaced by `PageRender.renderStorageObjectId` with a composite FK | n/a | A render is `(page, run, dpi, pipelineVersion, recipeHash)` — not a property of the page (requeue may re-render) nor of an `ocr_result` (several engines share one render). Also closes the named TEN-2 violation in `f1`'s `schema.invariants` | Tenant-only RLS per `f1 db.rls.children`; append-only per `evidence.append_only`. Column is empty at M1, so the migration is trivial. |
| `region.kinds` | `enum RegionKind { UNKNOWN PRINTED HANDWRITTEN MIXED STAMP SIGNATURE NOISE }` | n/a | PP-DocLayout's 23 categories contain **no handwriting and no signature class** — only `seal` (verified). Nothing off the shelf answers "is this line handwritten"; it is a per-region decision on our side | Classifier disabled or failed warmup ⇒ every region `UNKNOWN` ⇒ printed recognisers run ⇒ the whole stack works, only the label is absent. |
| `region.classifier` | MobileNetV3-Small (w 1.0), input **48 × 320 × 1** (identical to `Rec.rec_img_shape`), ~1.5 M params, ~2.4 MB INT8 ONNX, 5-way softmax | `OCR_REGION_CLASSIFIER_ENABLED` (**`false` at M1**), `OCR_REGION_CLASSIFIER_MODEL_PATH` | Reuses the tensor the recogniser crop already produced — one extra forward pass, no second crop or resize. **UNVERIFIED:** 0.3–0.8 ms/crop estimate, to be measured in M2 | Disabled ⇒ `kind = UNKNOWN`, `kindScore = null`. Enabled but warmup fails ⇒ container refuses to start. |
| `region.kind_thresholds` | Ordered, first match wins: `SIGNATURE` if `p_signature ≥ 0.60`; `STAMP` if `p_stamp ≥ 0.60`; `HANDWRITTEN` if `p_handwritten ≥ 0.65`; `MIXED` if `0.20 ≤ p_handwritten < 0.65`; `NOISE` if `p_noise ≥ 0.70 ∧ p_handwritten < 0.20`; else `PRINTED` | `OCR_REGION_KIND_*_THRESHOLD` | Ordered evaluation, not argmax: a 0.34/0.33/0.33 split must not read as a confident answer. The bands partition the space with no gap | `MIXED` runs **both** a printed and (when registered) a handwriting recogniser — the multi-candidate path is the answer to classifier uncertainty. |
| `region.crop_kind_segment` | `region` — the `{kind}` segment value in `i-storage.md` §2.1's template, under the frozen `org/{organization_id}/` prefix. Key length 126 chars | n/a | This document owns **one** thing about the object-key grammar: the new `kind` value. Everything else is cited | Any other segment value for a region crop fails the storage-key validator. |
| `region.crop_oid` | **Deterministic**: `crockford_base32(sha256(pageRenderId ‖ 0x1F ‖ canonical_quad_derivative ‖ 0x1F ‖ cropVersion))[0:26]`, lowercased | n/a | Makes a requeue idempotent at the storage layer; derivatives are identity-addressed and unique via `storage_object_bucket_key_key` (frozen). A ULID here orphans one crop per requeue | Collision (astronomically improbable) ⇒ the existing object is reused, which is correct because the inputs are identical. |
| `region.crop_format` | Greyscale **PNG** (`GRAY8`). JPEG forbidden | n/a — a rule | A Thai tone mark is 2–5 px at 300 DPI; JPEG's 8×8 DCT and chroma subsampling destroy exactly that. ~4–9 KB for a 48×320 crop | A non-PNG region crop fails the storage `ALLOWED_MEDIA` check for `kind = region`. |
| `region.crop_persist_rule` | Store iff **R1** `kind ∈ {HANDWRITTEN, MIXED, STAMP, SIGNATURE}` **or R2** consensus ∈ `{DISPUTED, ACCEPT_FLAGGED, NO_CANDIDATE}` **or R3** overlaps an `isSensitive` field **or R4** a reviewer opened it **or R5** random `OCR_REGION_CROP_AUDIT_RATE` | `OCR_REGION_CROP_AUDIT_RATE=0.005` | Unconditional storage is 500 pages × ~40 regions = 20,000 crops ≈ 140 MB of extra full-fidelity PII per document against a 15 GiB frozen quota — unaffordable **and** unlawful. R1–R5 select ~2–8 % | Budget exceeded ⇒ `REGION_CROP_BUDGET_EXCEEDED` warning; the document does **not** fail. Crops are an aid, not the record. |
| `region.crop_limits` | `MAX_REGION_CROPS_PER_DOCUMENT = 2000`; `MAX_REGION_CROP_BYTES = 262144` (256 KiB) | `OCR_LIMIT_MAX_REGION_CROPS_PER_DOCUMENT`, `OCR_LIMIT_MAX_REGION_CROP_BYTES` | Bounds the PII surface and the storage cost of one pathological document. Requires entries in `config/limits.yaml`, whose generation contract `f2` owns; the **values** are owned here | Count cap ⇒ stop storing, warn, continue. Byte cap ⇒ that crop is not stored, warn, continue. |
| `region.crop_retention` | Derivative class under `f`'s retention table: 30-day TTL from last access, pinned for the full audit period on human view, crypto-shredded with the document | n/a — cites `gate-2-pdpa-retention.md` | Region crops of a Thai national ID line are the highest-density PII in the system. They are never an exception to the retention regime | Purge sets `purged_at`; the row survives as proof the object existed and was erased. |
| `consensus.version` | `1.0.0` (semver; a member of `ocr.calibration_key`) | `OCR_CONSENSUS_VERSION` | A change to the weights or thresholds changes what "accepted" means, so a calibration map fitted under one rule does not transfer to another | Bumping it invalidates every calibration map ⇒ `calibratedP = null` ⇒ hard gates fail closed. |
| `consensus.alignment_unit` | **Extended grapheme cluster** (base + combining marks); `U+0E33` is one cluster, never decomposed | n/a — a rule | Codepoint alignment desynchronises on a single dropped tone mark and every subsequent codepoint mismatches. Cluster alignment makes it a one-cluster disagreement, which is what it is | Alignment over ≥ 4 candidates or ≥ 4,000 clusters ⇒ `CONSENSUS_INPUT_TOO_LARGE`, region → review. |
| `consensus.alignment_algorithm` | Needleman–Wunsch against the highest-weight anchor; `match 0 / mismatch 1 / gap 1`; ties in the traceback resolved by **placing gaps latest**; candidates ordered `(weight DESC, recognizerId ASC)` | n/a — a rule | Fully deterministic: identical inputs always give an identical alignment, so a re-run reproduces the verdict. `O(k·n·m)` ≈ 3,200 cells at k=2, n=m=40 | Non-determinism would make `region_consensus` unreproducible, breaking the audit claim the product is sold on. |
| `consensus.weights` | `paddle-onnx-th 1.00`, `tesseract-tha 0.45`, `thai-trocr-hw 0.55` (**only** on `HANDWRITTEN`/`MIXED`, else 0.00), `typhoon-vlm 0.60`, `easyocr-th 0.00`, any `recognizerMismatch` candidate **0.00** | `OCR_CONSENSUS_WEIGHT_<ID>` | 0.45 is chosen so the corroborator can **never outvote the primary alone**, and so a primary/corroborator disagreement lands at `A = 0.701` — inside the flag band. At 0.10 it would be 0.913 and would auto-accept a disagreement | A weight above 1.00 for any non-primary ⇒ boot refusal. Sum is never normalised: `W_total` is the denominator. |
| `consensus.generative_cosign_rule` | A candidate with `trust.generative = true` contributes `w = 0.00` on any cluster where **no non-generative candidate agrees** | n/a — a rule | M0 D13 ("a transcription candidate, never an action input") as arithmetic. A generative engine may **confirm** a cluster; it can never **originate** one | A hallucinated digit no CTC engine saw contributes zero weight and cannot win — checkable, not aspirational. |
| `consensus.uncalibrated_penalty` | `0.70` multiplier on raw confidence when `calibratedConfidence == null`; `0.50` flat when `confidence == null` | `OCR_CONSENSUS_UNCALIBRATED_PENALTY`, `OCR_CONSENSUS_NULL_CONFIDENCE` | An uncalibrated score is a ranking signal, not a probability. The penalty makes it lose to a calibrated score of the same nominal value | Without it, a freshly registered engine with no map would outvote a calibrated one on nominal numbers alone. |
| `consensus.outcomes` | `NO_CANDIDATE` (0 candidates) · `SINGLE_SOURCE` (1) · `AGREED` (≥2 ∧ `A ≥ 0.90`) · `ACCEPT_FLAGGED` (≥2 ∧ `0.60 ≤ A < 0.90`) · `DISPUTED` (≥2 ∧ `A < 0.60`) | `OCR_CONSENSUS_AGREED_MIN=0.90`, `OCR_CONSENSUS_DISPUTED_MAX=0.60` | `A = Σ(a_column × len(winner)) / Σ len(winner)`, cluster-count-weighted so a 2-cluster region does not swing a 40-cluster page | `AGREED` is **necessary, never sufficient** for auto-accept: `f` §2.6's `T_ocr = 0.98` critical-field gate still applies, and `SINGLE_SOURCE` can never auto-accept a critical field. |
| `consensus.cluster_min_agreement` | `0.75` | `OCR_CONSENSUS_CLUSTER_MIN_AGREEMENT` | A region can be 95 % agreed and contain one disputed digit. The digit is what matters, so columns below 0.75 are recorded in `disputedClusterIndices` **even when the region outcome is `AGREED`** | Every disputed column is surfaced in the review UI regardless of the region verdict. |
| `consensus.deletion_rule` | A won gap that would delete a **digit** (`0-9` or `U+0E50–U+0E59`), or any cluster inside a region overlapping an `isSensitive` field, is **not applied**: the cluster is kept, `deletionDisputed = true`, outcome forced to `DISPUTED`. Other won gaps apply and are always recorded | n/a — a rule | A number silently deleted by vote is the worst failure this layer can produce and is unrecoverable downstream, because nothing knows a digit is missing | Forced `DISPUTED` ⇒ priority-1 review ⇒ no value is auto-accepted. |
| `consensus.tie_break_order` | `paddle-onnx-th, tesseract-tha, thai-trocr-hw, typhoon-vlm`; `tieBroken` recorded; a tied **digit** or sensitive-field column forces `DISPUTED` regardless of `A` | `OCR_CONSENSUS_TIE_BREAK_ORDER` | Exact ties are reachable (0.45 + 0.55 = 1.00). Deterministic order, never a coin flip. The primary wins ties because it is the only Thai-trained recogniser — that is the prior, not a preference | A tie-break never silently decides money: the digit rule forces review first. |
| `consensus.corroborate_selector` | Corroborate iff `kind != NOISE` **and** (`primary.calibratedConfidence < 0.97` **or** overlaps an `isSensitive` field **or** contains ≥ 1 digit cluster **or** `random() < 0.02`), `random()` seeded from `regionId` | `OCR_CORROBORATE_CONF_CEILING=0.97`, `OCR_CORROBORATE_AUDIT_RATE=0.02` | Running the corroborator on every region of a 500-page document is ~4× the OCR cost for regions never in doubt. The audit term stops the corroborator only ever seeing regions the primary already doubted, which would bias its measured disagreement rate to uselessness | Seeded RNG keeps the consensus layer deterministic despite containing a sampling rule. |
| `escalation.policy` | **E1, E2, E3, E5, E6 never escalate** — warning + review (E5 at priority 1). **E4 alone** may select another engine, and only via `registry.select()` honouring `forbid` | n/a — a rule | E1/E3/E5 are each forceable from uploaded pixels (degrade contrast; put Latin on a Thai page; a page of engineered speckle), which hands the uploader an engine-selection primitive pointed at a guardrail-free model on a shared GPU | E4 with no permitted engine ⇒ `CAPABILITY_NOT_SATISFIED`, never a silent box-less degradation. E1 is inert while `calibratedP == null`. |
| `escalation.budgets` | `3` escalated pages per document; `200` per tenant per day; decremented in the **same transaction as the job row**; trip-rate kill at `0.08` over a rolling `3600 s` | `OCR_ESCALATION_MAX_PAGES_PER_DOCUMENT`, `OCR_ESCALATION_MAX_PAGES_PER_TENANT_PER_DAY`, `OCR_ESCALATION_TRIP_RATE_KILL`, `OCR_ESCALATION_TRIP_RATE_WINDOW_S` | M0's escalation had no budget, no per-document cap, no per-tenant cap and no trip-rate monitor, against a tier 1–2 orders of magnitude more expensive on a **shared** GPU. 8 % is `f` §1.4's own instrumented threshold, reused | `budget_exceeded` ⇒ **review, never best-effort**. Trip-rate breach ⇒ escalation disabled platform-wide + page. |
| `authz.ai_egress_policy` | `enum { DENY_ALL, ALLOW_NON_SENSITIVE, ALLOW_ALL }` on `Organization`, default **`DENY_ALL`**. `OcrRequest.forbid` is populated by the use case from this row — **never settable by the caller** | `OCR_DEFAULT_AI_EGRESS_POLICY=DENY_ALL` | M0's `require` could only widen, never narrow, so a PDPA §26 document and a public brochure were treated identically. A caller may **demand** a capability; only the platform may **forbid** one | `registry.select()` raises `CAPABILITY_FORBIDDEN` rather than silently choosing a wider-trust engine. Any document with an `isSensitive` field gets `forbid = {generative, leavesHost}` unless policy is `ALLOW_ALL` **and** there is a per-document opt-in. |
| `capabilities.trust` | `{ generative: boolean, leavesHost: boolean, guardrails: 'none'\|'vendor'\|'ours', processorId: string \| null }` on both `OcrCapabilities` and `RegionRecognizerCapabilities` | n/a — a contract | M0's capabilities had no axis for *generative*, *leaves the host*, or *guardrails*, so there was nothing to build a gate with. `processorId` is the RoPA entry for PDPA | A recogniser registered without a `trust` block fails the registry's boot validation. |
| `evidence.append_only` | Tables `page_renders`, `document_regions`, `region_candidates`, `region_consensus`, `ocr_results`, `document_analyses`, `corrections`, `audit_logs`. `BEFORE UPDATE OR DELETE` trigger `evidence_append_only()`; the **only** permitted mutation is `purged_at`, by `ocr_erasure` alone | n/a — a DB trigger | Reconciles the immutability invariant with PDPA erasure, which would otherwise directly contradict it: erasure never edits evidence, it sets `purged_at` and crypto-shreds the object-storage content | Any other update, and every `DELETE`, raises `EVIDENCE_IMMUTABLE` with `SQLSTATE restrict_violation`. A cascade delete reaching an evidence table becomes a loud failure. |
| `provenance.six_part` | `document` (`Document.publicId`) → `page` (`pageNumber` + `pageRenderId` + `renderDpi`) → `bounding box` (`SpacedQuad<'SOURCE'>[]`) → `engine` (`recognizerId@recognizerVersion`) → `raw candidate` (`RegionCandidate.id` + byte-exact `rawText` + `payloadRef`) → `confidence` (raw + calibrated + `calibrationKey` + per-cluster + `agreement`) | n/a — a contract | The owner's binding invariant, made navigable in one round trip via `FieldProvenance` | A field value with zero `field_value_sources` rows and `origin != 'HUMAN'` fails a CI invariant check. |
| `provenance.correction_inheritance` | A correction is a **new** `ExtractionFieldValue` (`origin = HUMAN`, `supersedesId`, `confidence = null`) plus **copied** `field_value_sources` rows carrying `inheritedFromValueId`, in **one** transaction with the `corrections` row | n/a — a rule | The corrected value inherits the **pointers**, not the text, so `FieldProvenance` still resolves to the bytes the engine actually emitted. `confidence = null` + `origin = HUMAN` stops any gate mistaking it for a confident machine value | `field_value_sources.candidate` is `onDelete: Restrict`, so original evidence cannot be collected while any corrected descendant points at it. The chain survives arbitrarily many corrections. |
| `review.priority` | `1` DISPUTED / deletionDisputed / NO_CANDIDATE / E5 / disputed digit in a sensitive field · `2` ACCEPT_FLAGGED / E1,E2,E3,E6 / `calibratedP == null` on a critical field · `3` SINGLE_SOURCE on a critical field · `4` audit samples (labelled, **excluded from the throughput SLA**) | n/a — a rule | Priority 4 is what de-biases the drift monitor; without a budgeted audit stream, ECE is estimated on a sample selected against the failures it exists to catch | Priority-4 items counted in the reviewer SLA would create pressure to shrink the audit rate, which is the metric-gaming failure this design exists to prevent. |
| `training.consent` | `enum TrainingConsent { NONE, AGGREGATE, CROP_LEVEL }` on `Organization`, default **`NONE`**; `consentBasis` stamped on each `correction_samples` row **at write time**, never back-filled | n/a — **OWNER-BLOCKED (B-1)** | `NONE` ⇒ no rows. `AGGREGATE` ⇒ error-class analytics only, no crop, no text. `CROP_LEVEL` ⇒ full row, fine-tuning permitted. Upgrading consent in March does not license February's documents | Default `NONE` ships: the table exists, is empty, and no customer data accumulates without an explicit, separable, purpose-specific consent. |
| `training.pdpa_consequence` | **A trained model is not erasable.** Crypto-shredding reaches objects, not weights. Either (a) never train — the default — or (b) retain the manifest, base checkpoint and training code and commit contractually to a rebuild-from-scratch window. A model fine-tuned under `CROP_LEVEL` may be served **only** to the contributing tenants unless every one has consented to cross-tenant use | n/a — a rule, **OWNER-BLOCKED (B-1)** | Sequence models memorise rare strings, and a Thai national ID number is exactly that shape. Serving A's-data-trained model to B moves A's data into B's product | With the `NONE` default there is nothing to rebuild and nothing to cross-contaminate. Enabling `CROP_LEVEL` without (b) budgeted is an unerasable liability. |
| `training.error_taxonomy` | Closed enum: `DIACRITIC_LOST`, `DIACRITIC_SPURIOUS`, `THAI_DIGIT_CONFUSION`, `CONSONANT_CONFUSION`, `SEGMENTATION`, `NUMERIC_DIGIT`, `HALLUCINATION`, `LAYOUT`, `OTHER` | n/a — a contract | Assigned deterministically from `(engineText, humanText)`. Under `AGGREGATE` consent this alone says which knob to turn next, per engine and document class, retaining **no** crop and **no** customer text | `OTHER` above 20 % of samples ⇒ the taxonomy is wrong and is alerted on. `DIACRITIC_LOST` rate is the direct measure of whether `ocr.det.short_axis_pad_frac` worked. |
