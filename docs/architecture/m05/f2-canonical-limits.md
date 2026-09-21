---
dimension: F2 — Canonical Limits
title: INNOVERA OCR AI — Canonical Limits, Layering and Failure Behaviour
status: canonical
date: 2026-09-09
supersedes:
  - docs/architecture/m0/j-security-threat-model.md §8 (item N — all limits), §3.4 page cap, §3.5 MAX_TIFF_FRAMES, §8.8 edge config
  - docs/architecture/m0/g-data-model.md §5.4 (limits table), §10.2 migration 0008 — document_size_bounds, storage_object_size_bounds, document_page_count_bounds
  - docs/architecture/m0/e-native-extraction-routing.md §5.5 (hard budgets), §2.4 ZIP guard constants
  - docs/architecture/m0/m-docker-nginx-resources.md §3.4.3 (upload-cap adjudication), §3.4.4 (413 envelope), open question 3
  - docs/architecture/m0/i-storage.md MAX_UPLOAD_BYTES (line 1377), §4.5 quota HTTP mapping
  - docs/architecture/m0/f-preprocessing-and-confidence.md P1 pixel/frame/page caps
  - docs/architecture/m0/h-queue-and-worker-contract.md §13.2 budget constants
  - docs/architecture/m0/l-api-ui-export.md §16 assumption "100 MB / 500 pages"
owner: F2
consumers: [F1, F3, G-data-model, H-queue, J-security, L-api, M-deployment, E-routing, I-storage, N-observability]
---

# F2 — Canonical Limits

> **Integration status (2026-09-12):** Read the [architecture index](../README.md) and its consolidation report before using these examples. Individual review labels do not close cross-document conflicts; no application implementation is verified.

> **This document owns every numeric limit in INNOVERA OCR AI.** No other document may
> restate a value from the `## CANONICAL VALUES` block at the end of this file. Cite it as
> `f2-canonical-limits.md §CANONICAL VALUES → <key>`. Restating is how M0 produced five
> upload caps and three page caps.

---

## 1. The inventory — every numeric limit found in the M0 corpus

Extracted by grep over all 14 M0 dimension documents plus the adversarial panel
(`/Users/innovera/Documents/OCR/docs/architecture/m0/`, 42,833 lines).

### 1.1 Upload size — **5 competing values across 6 documents, 3 config layers, 1 DB CHECK**

| Value | Source (file:line) | Form it takes | Enforcement hardness |
|---|---|---|---|
| **25 MB** global; PDF 25 / image 15 / TIFF 25 / OOXML 10 | `j-security-threat-model.md` §8.1 (:1415), §8.8 (:1540), D16 (:2077) | prose + `client_max_body_size 26m` | config |
| **100 MB** | `l-api-ui-export.md` §16 (:3365) | stated assumption | none (assumption) |
| **200 MiB** = 209,715,200 | `e-native-extraction-routing.md` §5.5 (:1173) `MAX_UPLOAD_BYTES = 200 * 1024 * 1024` | Python constant | code |
| **200 MiB** = 209,715,200 | `g-data-model.md` §10.2 (:954-956) `CHECK (size_bytes BETWEEN 1 AND 209715200)` ×2 tables | **DB CHECK, migration 0008** | **hardest — needs a migration to change** |
| **200 MB** (recommendation) | `m-docker-nginx-resources.md` §3.4.3 (:2762) | adjudication in prose | none |
| **500 MB** = 524,288,000 | `i-storage.md` (:1377) `MAX_UPLOAD_BYTES = 500 * 1024**2` | **TypeScript constant, in code**, plus worked examples at :51, :184, :484, :662 | code |
| **500m** | `m-docker-nginx-resources.md` §3.3 (:2420) `client_max_body_size 500m` | **shipped nginx config** | edge |
| **8 MiB** | `l-api-ui-export.md` (:1025) | per-request body cap on the multipart-complete route | code |
| **8 MB** | `b-ai-topology-discovery.md` (:1239) | total AI request body | code |
| **1m** (server default), **32k** (CSP report), **1m** (misc) | `m-docker-nginx-resources.md` §3.3 (:2341, :2518, :2528) | nginx | edge |
| **8 KB** | `j-security-threat-model.md` §7.x | CSP report body | code |

The panel (`z-adversarial-panel.md`:606) confirmed all of these independently and noted that
**`m`'s own open-questions list still carries "Max upload size: 200 MB or 500 MB?" as unresolved**
(`m`:4321) *after* §3.4.3 claimed to resolve it — i.e. M0 did not even converge internally.

### 1.2 Page count — **6 competing values**

| Value | Source | Form | Hardness |
|---|---|---|---|
| **50** pages, hard reject at 51 | `j` §8.2 (:1422), §3.4 (:357) | prose + `MAX_TIFF_FRAMES = 50` (:406) | config |
| **200** pages/document | `f` P1 (:313) | prose | none |
| **400** render pages | `e` §5.5 (:1163) `MAX_RENDER_PAGES_PER_DOCUMENT = 400` | Python constant | code |
| **500** pages | `l` §16 (:3365) assumption; `d` (:1193) `max_pages_per_call=500` | assumption / constant | code |
| **1,500** pages | `e` §5.5 (:1162) `MAX_PAGES_PER_DOCUMENT = 1_500` | Python constant | code |
| **2,000** pages | `g` §10.2 (:957) `CHECK (page_count BETWEEN 1 AND 2000)`; `g` §5.4 (:1004) | **DB CHECK, migration 0008** | **hardest** |

`e` itself flags this as a guess (`e`:2301: *"`MAX_PAGES_PER_DOCUMENT = 1500` and
`MAX_RENDER_PAGES_PER_DOCUMENT = 400` are guesses"*).

### 1.3 Per-page OCR wall time — the unmeasured constant three caps hang from

| Value | Source | Basis |
|---|---|---|
| **0.5–1 s/page** | `d` (:209, :349) | third-party blog, RapidOCR, non-Thai. `UNVERIFIED:` in `d` itself |
| **2 s/page** | `d` (:371) | worked example only |
| **12 s/page** | `j` §8.2 (:1424) | assumption; `j` flags it `UNVERIFIED:` and warns *"three separate limits collapse if it is wrong"* (`j`:2291) |
| **25 s/page** | `h` §13.2 (:3134) | assumption, classical branch |
| **45 s/page** | `h` §13.1 (:3120) | *stage timeout*, not expected cost — a ceiling, not a p95 |
| **200 s/page** | `h` §13.2 (:3134) | vision branch |

Spread on the classical branch alone: **0.5 s → 45 s = 90×**. `j`'s 12 s and `h`'s 25 s
differ by 2.1×; `d`'s worked 2 s and `h`'s 45 s stage timeout differ by 22.5×.
**No page cap, no time budget and no worker-pool size in M0 is defensible until this is measured.**

### 1.4 Time budgets — 3 mutually exclusive envelopes (panel FATAL-adjacent finding)

| Envelope | Source | Value |
|---|---|---|
| 50 pp / 10 min OCR / 6 min AI / **15 min hard ceiling**, enforced by lease expiry + supervisor kill | `j` §8.7 (:689, :1528) | 900 s |
| 200 pp, per-document wall clock unspecified | `f` P1 (:313) | — |
| clamp(60 s + pages×25 s + 300 s, 5 min, **45 min**), per claim, `BUDGET_EXCEEDED` **non-retryable** | `h` §13.2 (:3127) | 2,700 s |
| `EXTRACT_TIMEOUT_S = 300` whole document (native extraction only) | `e` §5.5 (:1171) | 300 s |

`z-adversarial-panel.md`:189 rates this **FATAL to the envelope**: `h`'s ceiling is 3× `j`'s, and
`h`'s own arithmetic self-refutes (a 200-page document at 25 s/page hits `BUDGET_EXCEEDED` at
~page 108, and `BUDGET_EXCEEDED` is classified `"retryable": false` at `h`:2219, so the entire
page-checkpoint machinery is unreachable in the exact scenario it was built for). Meanwhile
`e` §5.5 item 4 already designed the correct graceful path (`route=SKIPPED`,
`reason="render_budget_exhausted"`, document completes with a warning) and `h`'s page loop never
calls it — **`e` and `h` produce opposite outcomes (degraded success vs terminal failure) for
identical input.**

### 1.5 Pixels and dimensions

| Value | Source | Note |
|---|---|---|
| `MAX_PIXELS_PER_PAGE = 40_000_000` | `e` §5.5 (:1166); `j` §8.3 (`MAX_PAGE_PIXELS`) | agree |
| `Image.MAX_IMAGE_PIXELS = 20_000_000` **+ warning promoted to error** | `f` (:292-294) | **see §4.9 — this stacks two corrections and silently halves the cap to 20 Mpx** |
| `Image.MAX_IMAGE_PIXELS = 40_000_000` | `j` §8.3 | ineffective on its own (Pillow raises only above 2×) — `f`:2519 correctly refutes `j` |
| `MIN_PAGE_PIXELS = 10_000` (100×100) | `j` §8.3 | no conflict |
| long edge downscale at `> 6000 px` to 6000 | `f` (:299) | conflicts with the 40 Mpx cap for wide formats |
| `MAX_PIXELS_PER_TILE = 12_000_000`, ≤12 tiles/page | `e` §5.5 | no conflict |
| `MAX_BITMAP_BYTES_PER_PAGE = 128 MiB` | `e` §5.5 | corrected in `e` from 64 MiB |
| `MAX_TOTAL_RENDER_PIXELS = 4_000_000_000` per job | `e` §5.5 | not reconciled with the page cap |
| `n_frames <= 64` | `f` (:308) | conflicts with `j`'s `MAX_TIFF_FRAMES = 50` (`j`:406) |
| per-page render ≤ **20 MiB** stored | `g` §5.4 (:1006) | derivative cap, no conflict |
| `render_dpi BETWEEN 72 AND 1200` | `g` §10.2 | DB CHECK |

### 1.6 Structural / archive budgets (no cross-document conflict — inherited)

| Value | Source |
|---|---|
| `MAX_ENTRIES = 5_000`, `MAX_TOTAL_UNCOMPRESSED = 500 MiB` (**actual bytes read**), `MAX_COMPRESSION_RATIO = 200` (declared, first filter), `MAX_ENTRY_UNCOMPRESSED = 200 MiB` | `e` §2.4 (:153-157) |
| PDF page-tree **node budget 10,000**; **cap total indirect objects at 500,000**; never trust `/Count` | `j` §3.4 (:355-356) |
| `FILENAME_MAX_CHARS = 120` | `i` (:2171) |
| `pg_column_size(lines_json) <= 4 MiB`; `metadata <= 4096`; `source_metadata <= 8192`; `requirements <= 8192`; `value_json <= 262144` | `g` §10.2 |

### 1.7 Concurrency, quotas, rate limits, AI

| Value | Source | Conflict |
|---|---|---|
| Worker pool (total concurrent jobs) **4** | `j` §8.6 | vs `m` §2.2.2 `replicas: ${OCR_WORKERS:-2}`; panel:712 lists "worker pool (4 vs 1)" |
| `RENDER_CONCURRENCY = 2` per worker process | `e` §5.5 | — |
| Concurrent jobs/user **2**; Enterprise 4 on a dedicated pool | `j` §8.6 | — |
| Queued documents/user **25** | `j` §8.6 | — |
| In-flight AI calls/tenant **2** | `j` §8.6 | — |
| In-flight multipart uploads/user **3** (sized as 3 × 25 MB) | `j` §8.6 | arithmetic breaks at any cap > 25 MB |
| DB pool/app instance **10** | `j` §8.6 | — |
| Worker memory **2 GB** | `j` §8.3/§8.8 | vs **3 GB** elsewhere — panel:712 |
| Quota tiers (docs/pages/bytes/tokens, monthly + 20 % daily sub-cap) | `j` §8.4 | uncontested |
| Storage quota enforcement: reserve-then-commit, `quota-exceeded` → **HTTP 413** | `i` §4.5 (:1511) | vs `l` (:1435) which returns **429** for quota on create |
| Rate-limit table (8 classes) | `j` §8.5 | uncontested |
| `rate-limiter-flexible` 11.2.0 + Redis | `j` §8.5 | vs `m` O2 "Redis **rejected for M1**" — **contradiction, out of F2 scope, flagged to F-queue** |
| XLSX export cap **50,000 rows / 1,000,000 cells** → 413 `export_too_large` | `l` L-16, §10.4 (:3029) | uncontested |
| Batch status query `?ids=` ≤ **100** | `l` (:1109) | uncontested |
| AI context: `CHAT_CONTEXT_CHAR_BUDGET = 20000` chars, model ceiling **65,536** tokens, Thai ≈ **1 token/char** | Gateway contract (verified, `WeiWutichai/innovera-chat`); `b` E15 (:422) | `j` §8.4 assumes **2 chars/token** for Thai — wrong by 2× against Chat's own verified estimator |
| Timeouts: upload 120 s, GET 10 s, PATCH 15 s, mutation 30 s, health 2 s, `statement_timeout` 10 s, `idle_in_transaction` 30 s, clamd socket 90 s, `proxy_read_timeout` 130 s | `j` §8.7 | upload 120 s was derived from a 25 MB cap and does not survive a larger one |
| `client_body_timeout 120s` "matches the upload route timeout" | `j` §8.8 | **misreads the directive** — see §4.8 |
| `proxy_request_buffering on` | `j` §8.8 | vs `m` §3.4.4 which reasons about `proxy_request_buffering off` on the upload location |
| Orphan sweep 24 h; `STORAGE_WARN_PCT 80` / `STORAGE_REFUSE_PCT 90`; `RESERVE_BYTES = 5 GiB` | `j` §8.4, `m` (:4045-4046), `i` §4.4 | uncontested — **cited, not owned by F2** |

### 1.8 Not present anywhere in M0 (F2 must originate these)

`max files per batch`, `max batch bytes`, `max extracted characters per page`,
`max extracted characters per document`, `max page long-edge in pixels`,
`AI chars per document`, `AI max output tokens`, `global in-flight upload cap`,
`nginx body temp volume size`.

---

## 2. Arbitration method

Three rules decide every conflict below, in order:

1. **A limit whose value the operator will ever want to change is configuration, never a DB
   `CHECK` and never a code constant.** (Owner requirement, §11.)
2. **Two limits that are "the same constraint expressed twice" (`j` §8.2's own phrase) must be
   collapsed into one owned value plus one derived value, with the derivation written down.**
   M0's failure was that `j` derived a *page* cap from a *time* budget and then let four other
   documents restate the page cap without the budget.
3. **Where two documents disagree because they were measuring different things, rename both
   rather than pick one.** Three of M0's nine contradictions dissolve entirely under this rule
   (§4.4 pages, §4.12 concurrency, §4.16 buffering).

Every decision uses the owner's eight-part shape.

---

## 3. Naming and the config surface

### DECISION F2-D1 — env var prefix `OCR_LIMIT_*`, unit suffix mandatory

| | |
|---|---|
| **Competing proposals** | (a) bare `MAX_UPLOAD_BYTES` — what `m` §2.2.2 (:618) actually ships into compose and what `e` and `i` both use as a code constant; (b) `MAX_UPLOAD_MB` — what `m` §3.4.3's layering table uses **for the same value in the same document**; (c) `INNOVERA_OCR_*`; (d) `OCR_*` flat, matching `OCR_STORAGE_ROOT` / `OCR_PUBLIC_ORIGIN` / `OCR_VERSION` / `OCR_WORKERS` already in `m` §2.2; (e) `OCR_LIMIT_*` with a mandatory unit suffix. |
| **Selected** | **(e) `OCR_LIMIT_<NOUN>_<UNIT>`.** Units are `_BYTES`, `_MS`, `_S`, `_PIXELS`, `_PX`, `_CHARS`, `_TOKENS`, or a bare count noun (`..._MAX_PAGES_PER_DOCUMENT`). **Never `_MB`, never `_KB`, never a unitless magnitude.** |
| **Rejected** | (a) unprefixed — collides with any other service on the shared production host, and is invisible to a prefix grep, which is precisely how `m` shipped `client_max_body_size 500m` against `e`'s 200 MiB constant without either side noticing. (b) `_MB` — `m` §3.4.3 uses `MAX_UPLOAD_MB` in its layering table and `MAX_UPLOAD_BYTES` in its compose file **six hundred lines apart in one document**; that is a unit-confusion incident waiting for a night shift. (c) double prefix — Chat does not double-prefix. (d) flat `OCR_*` — cannot be enumerated separately from runtime config, and the boot assertion (§6) and the generated limits module both need exactly that enumeration. |
| **Reason** | Matches the verified INNOVERA convention exactly: `LITELLM_BASE_URL` / `LITELLM_API_KEY` (subsystem prefix + noun), `CHAT_CONTEXT_CHAR_BUDGET` / `CHAT_UPSTREAM_TIMEOUT_MS` (**app prefix + noun + unit** — Chat already puts the unit in the name). `OCR_LIMIT_*` is the same grammar with one extra segment that makes the whole limits surface greppable. |
| **Implementation consequence** | `env \| grep '^OCR_LIMIT_'` returns the complete limits surface and nothing else. One generated module, `@innovera/ocr-limits` (TS) + `innovera_ocr_limits` (Python), is produced from a single `limits.yaml` at build time; nginx and clamd fragments are templated from the same file. No layer reads a literal. |
| **Migration consequence** | Rename in `m`'s compose (`MAX_UPLOAD_BYTES` → `OCR_LIMIT_MAX_UPLOAD_BYTES`), `e`'s Python constants and `i`'s TS constant. Pure config/constant rename, no data migration. Do it before M1's first deploy — after that it is a coordinated restart. |
| **Security consequence** | Positive. A limit that cannot be enumerated cannot be audited. Every one of J's DoS controls is a number in this surface; the grep is the audit. |
| **Config/env consequence** | ~40 new env vars, all with defaults compiled into the generated module, so a `.env` that sets none of them still boots at the canonical defaults. Only values the operator has deliberately tuned appear in `.env`. |

---

## 4. The decisions

### DECISION F2-D2 — `MAX_UPLOAD_BYTES = 209,715,200` (200 MiB)

| | |
|---|---|
| **Competing proposals** | 25 MB (`j` §8.1), 100 MB (`l` §16), 200 MiB (`e` :1173, `g` migration 0008 ×2, `m` §3.4.3 recommendation), 500 MB (`i` :1377 in code, `m` :2420 in shipped nginx). |
| **Selected** | **200 MiB = 209,715,200 bytes**, one value, all types (per-type sub-caps in F2-D3 sit *under* it). |
| **Rejected** | **500 MB** — `m` §3.4.3's own argument stands: 500 MB over a Thai office uplink (2 Mbps floor, `j` §8.7) is 35 minutes and will time out more often than it succeeds; and at ~410 KiB/page it implies ~1,250 pages, three times any page cap anyone proposed. **25 MB** — rejected as a *platform* limit but **retained as the Free-tier per-plan cap** (F2-D13), which is where a number that small belongs; `j`'s D16 argument ("every megabyte multiplies through nginx buffers, ClamAV, worker RAM and storage") is answered by F2-D16 (nginx spills to disk, not RAM) and F2-D3 (scanning moves off the upload path). **100 MB** — an unargued assumption in `l`; no document defends it. |
| **Reason** | It is the only candidate that (i) is already the value in the hardest enforcement point in the system (`g`'s two `CHECK` constraints), (ii) two independent dimensions converged on (`e` in code, `m` in adjudication), and (iii) **produces a coherent pair with a page cap** — see F2-D4: 209,715,200 ÷ 500 pages = 419,430 B/page = 410 KiB/page, which sits exactly inside `j` §8.1's own measured 300–800 KB/page range for a 300 DPI scanned page. Both caps are therefore *reachable*: a 500-page scan at ≤ 410 KiB/page is admitted and only the page cap can reject it at 501; a 250-page scan at 800 KiB/page is rejected on size at page ~250. `g` §5.4's pairing (200 MiB / 2,000 pages = 105 KiB/page) failed exactly this test — only born-digital PDFs could ever reach 2,000 pages, so for the scanned corpus that is the product's actual target, the page cap was unreachable and every rejection surfaced as the unhelpful "file too large". |
| **Implementation consequence** | Client-side hint, app streaming counter and Python worker all read `OCR_LIMIT_MAX_UPLOAD_BYTES` verbatim. `i`'s `MAX_UPLOAD_BYTES = 500 * 1024**2` is deleted; `i` §4.4's worst-case disk preflight (`contentLength ?? MAX_UPLOAD_BYTES`) and §4.5's worst-case quota reservation both become 200 MiB, **reducing** the pessimism of both by 2.5×. |
| **Migration consequence** | `g`'s `document_size_bounds` and `storage_object_size_bounds` CHECKs are **removed** by F2-D7, so the value never enters a migration again. One migration (`0009_relax_tunable_bounds`) drops both constraints and adds the immutable replacements. Existing rows are unaffected — the bound is being loosened, not tightened. |
| **Security consequence** | Raises the DoS surface 8× versus `j`'s 25 MB. Compensated, all of which F2 mandates: (1) malware scanning moves **off** the synchronous upload path into the job path's `SCANNING` state (F2-D3), so a 200 MiB clamd stream never holds an HTTP connection; (2) `MAX_INFLIGHT_UPLOADS_PER_USER = 2` and `MAX_INFLIGHT_UPLOADS_GLOBAL = 8` bound total buffered bytes at 8 × 202 MiB ≈ 1.6 GiB of **disk**, not RAM (F2-D16); (3) `client_body_timeout 60s` is a *per-read* timeout and kills a stalled uploader regardless of total duration (F2-D8); (4) pages stream one at a time, so a 200 MiB document never implies 200 MiB of worker RAM. |
| **Config/env consequence** | `OCR_LIMIT_MAX_UPLOAD_BYTES=209715200`. nginx `client_max_body_size 202m` on the OCR upload location **only** (F2-D8). The shipped `client_max_body_size 500m` at `m`:2420 is wrong and must be changed. Chat's 10M vhost is untouched. |

### DECISION F2-D3 — per-type sub-caps, and malware scanning leaves the upload path

| | |
|---|---|
| **Competing proposals** | `j` §8.1's four-row table (PDF 25 / image 15 / TIFF 25 / OOXML 10 MB) scaled to a 25 MB global; or a single flat cap for all types. |
| **Selected** | Keep per-type differentiation, re-derived against the 200 MiB global: **PDF 200 MiB · TIFF 200 MiB · JPEG/PNG/WebP 52,428,800 (50 MiB) · OOXML 26,214,400 (25 MiB)**. And: **malware scanning is asynchronous, in the job path (`SCANNING` state), never in the HTTP upload path.** |
| **Rejected** | A flat 200 MiB for single-page images — a single image is by definition one page; a 200 MiB JPEG is not a document, it is a decompression bomb with a header. `j`'s 15 MB for images — rejects a legitimate lossless PNG of an A3 page at 400 DPI (30.9 Mpx × 3 B = 93 MB raw, ≈ 45 MB as PNG). `j`'s 10 MB for OOXML — arbitrary; 25 MiB against `e`'s 500 MiB actual-bytes ceiling is a clean 20:1 policy ratio. Synchronous scanning — see below. |
| **Reason** | The per-type cap is the *cheap* guard (one integer compare on `Content-Length`); the pixel cap (F2-D9) and the archive budget (F2-D10) are the *correct* guards. Differentiating by type means the cheap guard is doing real work on three of four types instead of being a formality. **On scanning:** `j` §8.7 sets a 90 s clamd socket timeout against clamd's own 60 s `MaxScanTime` — both derived from a 25 MB cap. At 200 MiB with `ScanPDF yes` on an object-rich PDF, 60 s is not enough, and raising it to 180 s puts a three-minute synchronous scan inside a user's upload request. `m` §2.x (:265) already flagged this as an open question between `j` and `h`. Resolution: the document enters `SCANNING` after the body is durably staged; the HTTP request returns `202` immediately; a scan verdict of "infected" moves the object to `quarantine/` and terminally fails the document. `j` §4.1's rule that signed URLs are gated on a state allowlist (never on a key prefix) already makes this safe. |
| **Implementation consequence** | Type is decided by **content sniff** (`e` §2), never by extension or by the client's `Content-Type`, and the sniff happens on the first 4 KiB *before* the streaming counter's per-type cap is selected. Until the sniff completes, the global 200 MiB cap applies. The upload route's timeout drops from a scan-inclusive number to a transfer-only number (F2-D8). |
| **Migration consequence** | None — no schema involvement. `h`'s job state machine already carries `SCANNING` (`m`:265 confirms `h` owns it); `j` §8.7's clamd socket timeout row and §11.4's `MaxScanTime` move from the web container's config to the worker's. |
| **Security consequence** | **Net positive, and the direction is counter-intuitive so it must be stated:** deferring the scan does *not* widen exposure, because `j` §4.1 already forbids serving an object before its state allowlist is satisfied, and `j` §3.2 already requires that a human reviewer sees only our re-rendered page images, never the original. What deferring removes is a 180-second attacker-controlled hold on a web-tier connection — a far more reachable DoS than the malware path it replaces. `clamd StreamMaxLength`/`MaxFileSize` = `MAX_UPLOAD_BYTES + 5 MiB` = 214,958,080 bytes (205 MiB; see F2-D8's derived table); `MaxScanSize` ≥ that; `MaxScanTime` 180,000 ms in the worker. |
| **Config/env consequence** | `OCR_LIMIT_MAX_UPLOAD_BYTES_PDF`, `..._TIFF`, `..._IMAGE`, `..._OOXML`. A boot assertion requires every per-type cap ≤ the global cap. OOXML ingest may still be *disabled* by the routing dimension (`j` §3.3 recommends deferring, `e` §2.4 implements it) — this cap applies if and when it is enabled and takes no position on that. |

### DECISION F2-D4 — the page cap is **two** limits, not one: admission 500, OCR budget 50

This is the decision that dissolves the panel's FATAL finding.

| | |
|---|---|
| **Competing proposals** | 50 (`j`), 200 (`f`), 400 (`e` render), 500 (`l`, `d`), 1,500 (`e` document), 2,000 (`g` CHECK). The panel offered two incompatible resolutions of its own: *"ship at J's 50-page cap"* (:201) and *"page cap = the minimum of the three currently in play, which is `e`'s `maxRenderPages: 400`"* (:618). |
| **Selected** | **`MAX_PAGES_PER_DOCUMENT = 500`** (admission; hard reject at 501) **and `MAX_OCR_PAGES_PER_DOCUMENT = 50`** (rasterise+OCR budget; **degrades, never rejects**). Native-text pages do not consume the OCR budget. |
| **Rejected** | **One number for both.** Every M0 value is a correct answer to a *different* question, which is why six of them coexisted: `g`'s 2,000 answers "how many rows may one document fan out to?"; `e`'s 1,500 answers "how many pages may a PDF declare?"; `e`'s 400 and `j`'s 50 answer "how many pages may we rasterise inside a time budget?"; `f`'s 200 conflates the two. Forcing one number means either rejecting a 400-page born-digital PDF we could process for free (if you pick 50) or promising OCR on 400 scanned pages we cannot finish (if you pick 400). **`g`'s 2,000** — rejected on row fan-out: `g`'s own `CHECK (pg_column_size(lines_json) <= 4 MiB)` means 2,000 pages is a theoretical 8 GiB of TOAST for one document; at a realistic 150–400 KiB/page of Thai word-level boxes it is 300–800 MiB per document, which makes a single upload a database incident. At 500 pages the same realistic range is 75–200 MiB — large, bounded, and backup-able. **`e`'s 1,500** — `e` calls it a guess and it fails the size-coherence test against any upload cap under 600 MiB. |
| **Reason** | `j` §8.2 is right that *"the page cap and the time budget are the same constraint expressed twice"* — but that is true only of the **OCR** page cap. `j` then applied the conclusion to the **admission** cap, which is bounded by storage and row fan-out and has nothing to do with OCR throughput. That single category error is the origin of the 40× spread. Separating them lets each be derived from its own real constraint, and it makes `e` §5.5 item 4's graceful path (`route=SKIPPED`, `reason="render_budget_exhausted"`, pages 1–20 prioritised, document completes with a warning) the *only* behaviour at the OCR boundary — which is what `e` designed and `h` never called. **A 500-page born-digital PDF now completes in full** (native pages are near-free), which is the outcome `e` §5.5 item 4 promised and `h`'s arithmetic denied. |
| **Implementation consequence** | `e`'s `MAX_PAGES_PER_DOCUMENT` 1,500 → 500 and `MAX_RENDER_PAGES_PER_DOCUMENT` 400 → 50. `h` §8.2's page loop **must** call `e`'s render-budget check — its absence is the panel's identified defect. Enforcement order per document: (1) actual page count from a page-tree walk under `j` §3.4's 10,000-node budget, **never `/Count`**; (2) `> 500` → reject; (3) route each page native vs OCR; (4) OCR-routed pages consume the 50-page budget in `e` §5.5 item 5's priority order (pages 1–20, then user-selected, then ascending); (5) the remainder are `SKIPPED`. Each render **tile** counts as one page against the OCR budget (`e`'s rule) — otherwise one A0 drawing silently consumes twelve. |
| **Migration consequence** | `g`'s `document_page_count_bounds CHECK (... BETWEEN 1 AND 2000)` is **dropped** (F2-D7) and replaced with `CHECK (page_count IS NULL OR page_count >= 1)`. **Grandfathering:** dropping an upper bound never invalidates an existing row, so this migration is safe in either direction of the value change. The reverse is not true and is exactly why the CHECK must go — see F2-D7. |
| **Security consequence** | The admission cap is the DoS control (`j` §3.4's "50,000 real pages" row); it is now 500 rather than 2,000, i.e. **4× tighter than what M0 would actually have shipped**, since `g`'s CHECK was the only enforced value. The OCR cap is a cost control, not a security control, and degrading rather than rejecting removes the retry-storm poison pill the panel identified (`z`:577): a document that exceeds the OCR budget now *succeeds partially* and is never re-queued. |
| **Config/env consequence** | `OCR_LIMIT_MAX_PAGES_PER_DOCUMENT=500`, `OCR_LIMIT_MAX_OCR_PAGES_PER_DOCUMENT=50`. The second is **derived** from F2-D5 and F2-D6 and must be regenerated, not hand-edited, whenever either changes; a boot assertion enforces `MAX_OCR_PAGES_PER_DOCUMENT == floor((JOB_PROCESSING_BUDGET_MS/1000 - JOB_FIXED_OVERHEAD_S - AI_STAGE_BUDGET_S) / PROVISIONAL_PER_PAGE_OCR_S)` and fails readiness on drift. |

### DECISION F2-D5 — `PROVISIONAL_PER_PAGE_OCR_S = 25`, expiring at measurement **M-1**

| | |
|---|---|
| **Competing proposals** | 0.5–1 s (`d`, third-party, non-Thai, `UNVERIFIED:`), 2 s (`d` worked example), 12 s (`j` §8.2), 25 s (`h` §13.2), 45 s (`h` §13.1 stage timeout), 200 s (`h`, vision branch). |
| **Selected** | **25 s/page** for the classical CPU branch, tagged **`UNVERIFIED:` / measurement-blocked (M-1)**. Vision branch: **200 s/page**, also `UNVERIFIED:`, and gated behind the vision question being resolved at all (the deployed model is **text-only** per the verified Chat evidence; `UNVERIFIED:` whether the gateway serves any vision alias). |
| **Rejected** | **12 s (`j`)** — `j` itself calls it an assumption with a 5–20 s working range and warns that three limits collapse if it is wrong; choosing the lower of two guesses optimises for a good-looking page cap rather than for not failing in production. **0.5–2 s** — third-party, a different engine (RapidOCR), and explicitly not Thai; Thai is the adversarial case for detection (no inter-word spaces, stacked tone marks) and the corpus is Thai identity and business documents. **45 s** — that is `h`'s per-page *stage timeout*, a ceiling that must sit above the p95 by design; using a ceiling as an expectation would halve the page cap for no evidential reason. |
| **Reason** | Asymmetric cost of error. **Under**-estimating produces `BUDGET_EXCEEDED` in production on real customer documents; **over**-estimating produces a conservative page cap that is raised by one config change. Between the only two same-genre estimates (12 s and 25 s, both CPU, both this engine class), the conservative one is correct until measured. It is also the value `h`'s budget arithmetic already uses, so adopting it changes one document instead of two. |
| **Implementation consequence** | It is a **config input to a derivation**, not a runtime value: nothing in the code path reads it. It appears exactly twice — in `limits.yaml`, and in the boot assertion of F2-D4. The runtime enforcement is the per-page deadline check (F2-D6), which is measurement-independent. |
| **Migration consequence** | None, by construction. This is the entire payoff of F2-D7: when M-1 lands, `MAX_OCR_PAGES_PER_DOCUMENT` changes by editing one YAML line and redeploying — **not** by taking an `ACCESS EXCLUSIVE` lock on a growing `documents` table. |
| **Security consequence** | None directly. Indirectly: an over-estimate keeps the worker-pool sizing (F2-D12) conservative, which is the safe direction on a host shared with INNOVERA Chat and a GPU workload. |
| **Config/env consequence** | `OCR_LIMIT_PROVISIONAL_PER_PAGE_OCR_S=25` (classical), `OCR_LIMIT_PROVISIONAL_PER_PAGE_OCR_VISION_S=200`. **Expiry trigger, explicit:** measurement **M-1** = p95 wall time for detect+recognise on a 300 DPI Thai A4 page, on the production worker container, over the N-dimension benchmark corpus, at the configured `RENDER_CONCURRENCY` and worker replica count (i.e. **under contention, not on an idle box** — a single-page timing on an idle host is the wrong number and is how this constant got a 90× spread). On M-1 landing: replace the value, regenerate `MAX_OCR_PAGES_PER_DOCUMENT`, and re-run the F2-D6 arithmetic. **Until M-1 lands, `OCR_LIMIT_MAX_OCR_PAGES_PER_DOCUMENT` is a provisional value and every document that hits it must emit the `render_budget_exhausted` counter** — that counter's rate is itself the signal that the guess was wrong. |

### DECISION F2-D6 — job wall clock: 30 min **per claim**; exceeding it is a **partial success**

| | |
|---|---|
| **Competing proposals** | `j`: 10 min OCR + 6 min AI = **15 min hard ceiling**, enforced by lease expiry + supervisor kill, job marked `FAILED`. `h`: `clamp(60 s + pages×25 s + (aiEnabled ? 300 s : 0), 5 min, 45 min)` per claim, `deadline_at = now() + budget_ms` reset on every claim, exceeding it → **non-retryable** `BUDGET_EXCEEDED` → terminal `FAILED`. `e`: `EXTRACT_TIMEOUT_S = 300` for the whole native-extraction pass, with no defined outcome. |
| **Selected** | **`JOB_PROCESSING_BUDGET_MS = 1,800,000` (30 min), per claim**, with `h`'s per-claim semantics (L28) and `h`'s separate `queue_expires_at` (24 h) for queue wait. Composition: **60 s fixed overhead + 1,440 s render/OCR + 300 s AI stage**. **Exceeding the budget with ≥ 1 page completed is `SUCCEEDED_PARTIAL`**, remaining pages `route=SKIPPED, reason="time_budget_exhausted"`; `BUDGET_EXCEEDED` as a terminal failure is reserved for **zero** pages completed. |
| **Rejected** | **`j`'s 15 min with a supervisor kill** — a supervisor kill destroys the page checkpoints `h` §8 exists to write, and `j`'s enforcement (lease expiry) is exactly the mechanism the panel showed produces a DLQ loop. **`h`'s 45 min ceiling** — three times `j`'s and unjustified against a host shared with Chat; and the clamp's own worked example (200 pages × 25 s = 5,060 s → clamped) is `h` admitting the number does not close. **`h`'s non-retryable terminal `BUDGET_EXCEEDED` for a partially-processed document** — the single most damaging behaviour in M0: it throws away completed, checkpointed, already-paid-for work, and `h` §12.2 rule 3's own invariant ("never abandon a paid-for AI response") forbids it. **`e`'s bare `EXTRACT_TIMEOUT_S = 300` with no outcome** — the panel (`z`:577) showed it produces a poison-pill job that re-runs 300 s of CPU on every retry and times out identically. |
| **Reason** | 30 min is chosen so the arithmetic **closes with margin at the conservative per-page estimate**: 1,800 − 60 − 300 = 1,440 s available for pages; at 25 s/page that is 57.6 pages, floored to a 50-page OCR budget with 190 s spare. At `j`'s 12 s/page the same 50 pages cost 600 s and the budget is not binding at all. The partial-success rule is what makes a *provisional* per-page constant survivable: if the guess is 2× low, a document does not fail, it completes with 25 pages OCR'd and 25 skipped, the user sees exactly which pages, and the `render_budget_exhausted` counter tells operations the constant is wrong. |
| **Implementation consequence** | Three enforcement points, all of which `h` §13.2 already lists — but item 2 changes: **before each page, `if now() > deadline: stop the page loop and finalise as partial`**, instead of `raise Terminal("BUDGET_EXCEEDED")`. `deadline` is refreshed from every 30 s heartbeat so an operator can extend a running job by updating `deadline_at`. `e`'s `EXTRACT_TIMEOUT_S` becomes a **stage** budget inside the 1,440 s page allowance and, on breach, returns a partial `NormalizedDocument` plus a resume cursor with the untouched tail marked `SKIPPED, reason="extract_timeout"` (`z`:596(b)). `h` §9.6's error table gains `TIME_BUDGET_PARTIAL` as a **non-error terminal-success** code. |
| **Migration consequence** | `ocr_jobs` needs a terminal state that is neither `SUCCEEDED` nor `FAILED`, or `SUCCEEDED` plus a `partial boolean`/warning set. **Recommendation to the data-model dimension: a `warnings text[]` on the job and `SUCCEEDED` as the single success state** — adding a state to a state machine with `CHECK`-guarded transitions (`h` §6) is far more invasive than adding a column, and every consumer of "did it succeed" stays correct by default. **Not F2's decision** — F2 owns only the requirement that a time-budget breach with ≥1 completed page is not a failure. |
| **Security consequence** | Removes the self-amplifying outage the panel identified: under backlog, `h`'s draft terminally failed work it was capable of doing, and those failures consumed worker slots, deepening the backlog. Bounded worst case per job is `max_attempts × 30 min` (`max_attempts` is owned by the queue dimension and is itself contradictory in M0 — `h` L22 says 4, `h`'s own review note says 5 — **flagged, not arbitrated here**), so 2–2.5 h of processing for a pathological job, visible in `ocr_job_duration_seconds`. |
| **Config/env consequence** | `OCR_LIMIT_JOB_PROCESSING_BUDGET_MS=1800000`, `OCR_LIMIT_JOB_FIXED_OVERHEAD_S=60`, reserved `OCR_LIMIT_AI_STAGE_BUDGET_S=300`, `OCR_LIMIT_JOB_QUEUE_TTL_MS=86400000`. Per-page OCR stage timeouts stay as ceilings: `OCR_LIMIT_PAGE_RENDER_TIMEOUT_S=30` (`e`), `OCR_LIMIT_PAGE_PARSE_TIMEOUT_S=10` (`e`), `OCR_LIMIT_PAGE_OCR_TIMEOUT_S=45` (`h` §13.1 — note it must exceed `PROVISIONAL_PER_PAGE_OCR_S` and does, by 1.8×). AI call timing is owned by F3; `OCR_LIMIT_AI_CALL_TIMEOUT_S` is retired. |

### 4.6a Sizing sanity — the arithmetic, written out

```
JOB_PROCESSING_BUDGET_MS        = 1_800_000 ms          (30 min, per claim)
  − JOB_FIXED_OVERHEAD_S        =        60 s           (fetch, sniff, page-tree walk,
                                                         finalise, result upload)
  − AI_STAGE_BUDGET_S           =       300 s
  = page allowance              =     1_440 s

MAX_OCR_PAGES_PER_DOCUMENT      = floor(1440 / PROVISIONAL_PER_PAGE_OCR_S)
                                = floor(1440 / 25) = 57  → shipped as 50 (headroom 190 s)
```

Cross-checks, all of which must hold and are asserted in CI:

| Check | Arithmetic | Result |
|---|---|---|
| Budget at `j`'s optimistic 12 s/page | 50 × 12 = 600 s ≤ 1,440 s | ✅ budget not binding; page cap binds |
| Budget at the shipped 25 s/page | 50 × 25 = 1,250 s ≤ 1,440 s | ✅ 190 s spare |
| Budget at the per-page **stage ceiling** 45 s | 50 × 45 = 2,250 s > 1,440 s | ⚠️ deadline fires at page ~32 → **`SUCCEEDED_PARTIAL`, not a failure** (F2-D6) |
| Size cap vs page cap coherence | 209,715,200 ÷ 500 = 410 KiB/page, inside `j` §8.1's measured 300–800 KB/page | ✅ both caps reachable |
| Row fan-out at the admission cap | 500 × (1 `document_pages` + 1 `ocr_results`) with realistic 150–400 KiB `lines_json` | 75–200 MiB/document |
| Total render pixels | `MAX_OCR_PAGES × MAX_PAGE_PIXELS` = 50 × 40 M = **2.0 G px** | derived, replaces `e`'s independent 4 G |
| Peak worker RAM | 1 page at a time × 2.2 × bitmap (`e` §5.4) at 300 dpi greyscale ≈ 18 MiB; at the 40 Mpx cap ≈ 264 MiB | fits a 2 GiB container |
| nginx body temp | `MAX_INFLIGHT_UPLOADS_GLOBAL` 8 × 202 MiB ≈ 1.6 GiB | volume sized ≥ 4 GiB |
| AI tokens for a full 50-page OCR document | 50 × ~3,000 Thai chars ≈ 150,000 chars ≈ 150,000 tokens (Chat's verified 1 token/char for Thai) + overhead | ≈ 0.6 % of the 25 M monthly tier |

**What is only defensible after M-1 (measurement-blocked, not owner-blocked):**
`MAX_OCR_PAGES_PER_DOCUMENT` (50), `MAX_CONCURRENT_JOBS_GLOBAL` (4), `PAGE_OCR_TIMEOUT_S` (45),
and the 1,440 s page allowance's adequacy. All four are regenerated from one measured p95. Their
**provisional values ship** and the `render_budget_exhausted` / `ocr_job_duration_seconds` metrics
are the expiry trigger.

### DECISION F2-D7 — both tunable `CHECK` constraints are removed; the immutable ones stay

The owner's rule: *"Avoid DB CHECK constraints for operator-tunable values unless genuinely
immutable."* Applied to the two `CHECK`s M0 proposed, plus the rest of migration 0008.

**The test:** a `CHECK` is legitimate **iff violating it means the row is corrupt**. It is
illegitimate **iff violating it means the operator changed policy.**

| `g` §10.2 constraint | Verdict | Action |
|---|---|---|
| `document_size_bounds CHECK (size_bytes BETWEEN 1 AND 209715200)` | **Tunable.** The upper bound is policy — this document changed it once already. | **Split.** Keep `CHECK (size_bytes > 0)` (a zero-byte document is corrupt, not a policy choice). Drop the upper bound; enforce 200 MiB at nginx + app + worker. |
| `storage_object_size_bounds CHECK (size_bytes BETWEEN 0 AND 209715200)` | **Tunable**, and *wrong* independently: a page render, a thumbnail and an export are all `storage_objects` with completely different natural bounds, so one number cannot be right for all of them. | **Split.** Keep `CHECK (size_bytes >= 0)`. Per-kind caps (`MAX_PAGE_RENDER_BYTES`, `MAX_EXPORT_BYTES`) are config, checked before the write. |
| `document_page_count_bounds CHECK (page_count IS NULL OR page_count BETWEEN 1 AND 2000)` | **Tunable.** F2-D4 changes it to 500 today and M-1 may move it again. | **Split.** Keep `CHECK (page_count IS NULL OR page_count >= 1)`. Enforce 500 during `VALIDATING`. |
| `organization_retention CHECK (retention_days BETWEEN 1 AND 3650)` | **Tunable** (a PDPA retention decision — F-Gate-2 owns it) but the bounds are *sanity*, not policy: 0 days and 100 years are both bugs. | **Keep.** The policy value lives inside the bound, not at it. |
| `document_page_dims_positive CHECK (width_px > 0 AND height_px > 0 AND render_dpi BETWEEN 72 AND 1200)` | **Immutable.** A non-positive dimension is corrupt; 72–1200 DPI is a physical sanity envelope no product decision will leave (our operational DPI knob lives at 150–400, well inside it). | **Keep.** |
| `document_page_rotation CHECK (rotation_applied IN (0,90,180,270))` | **Immutable** — a domain enum. | **Keep.** |
| Ratio bounds (`native_text_coverage`, `thai_script_ratio`, `mean_confidence`, `confidence` `BETWEEN 0 AND 1`) | **Immutable** — a ratio outside [0,1] is corrupt. | **Keep.** |
| Shape regexes (`api_key_hash_shape`, `storage_sha_shape`, `document_sha_shape`, `document_public_id_shape`, `organization_slug_shape`, `user_email_lowercased`, `field_value_money_pairing`) | **Immutable** — encoding invariants. | **Keep.** |
| `job_page_range`, `job_attempts_nonnegative CHECK (attempts >= 0 AND max_attempts BETWEEN 1 AND 20)` | Mixed. `attempts >= 0` and the page-range pairing are immutable; `max_attempts BETWEEN 1 AND 20` is a sanity envelope, and the operational value (4 or 5) sits inside it. | **Keep** as written. |
| JSONB size caps (`pg_column_size(...) <= 4096 / 8192 / 262144 / 4 MiB`) | **Borderline — keep, reclassified.** These are **storage-engine** guards (TOAST and row-size mechanics), not product limits. Their values are set by Postgres, not by policy. | **Keep**, and monitor `ocr_lines_json_size` rejections: a rejection there means a page produced >4 MiB of compressed line JSON, which is a bug signal, not a limit signal. |

| | |
|---|---|
| **Competing proposals** | `g` §10.2: both caps as `CHECK`s in migration 0008. Panel §B (:1160): *keep* the `CHECK`s but change them to 25 MiB / 50 pages and add a CI test asserting the migration's `pg_get_constraintdef()` matches a shared TS module. Panel rec 1 (:716): move everything to a generated limits module. |
| **Selected** | **Remove both tunable upper bounds from the schema; keep the immutable shape/domain `CHECK`s. Enforce tunable limits at nginx + app + worker from one generated module, plus a boot assertion.** Adopt the panel's CI idea in the surviving direction: a test asserts the **generated module** and the **rendered nginx/clamd config** agree, since there is no longer a `CHECK` to compare against. |
| **Rejected** | **The panel's "keep the CHECK, fix the number, test it against a shared module"** — it makes the drift *detectable* but leaves the *change* expensive, which is the wrong half of the problem. The panel's own evidence proves the point: M0's CHECK said 200 MiB while `i`'s shipped code said 500 MB, i.e. **the CHECK was the only real limit and nobody knew**, and the fix the panel proposes still requires a migration every time the product moves. |
| **Reason — the failure mode of a `CHECK` on a tunable, spelled out** | Raising the cap for one enterprise customer becomes `ALTER TABLE documents DROP CONSTRAINT document_size_bounds, ADD CONSTRAINT ...`. In PostgreSQL that takes an **`ACCESS EXCLUSIVE` lock** on `documents`, and `ADD CONSTRAINT` without `NOT VALID` performs a **full table scan** — on the one table in this schema that grows without bound. On a 10 M-row `documents` table that is minutes of *total* write blocking on the hot path, at 02:00, to change a number that should have been an env var. Three further consequences: (i) it cannot be rolled back by restarting a container — it needs a second migration; (ii) **lowering** a limit is worse still, because pre-existing rows violate the new constraint and `ADD CONSTRAINT` **fails outright**, so you must either use `NOT VALID` (leaving a constraint that lies about the data) or delete customer data to satisfy a config change; (iii) the constraint and the application constant drift silently in the meantime — which is the *actual* M0 outcome, not a hypothetical. |
| **Implementation consequence** | Migration `0009_relax_tunable_bounds`: three `DROP CONSTRAINT` + three `ADD CONSTRAINT` with the immutable predicates. All three additions are `IS NULL`-tolerant lower bounds that every existing row already satisfies, so all three may use plain `ADD CONSTRAINT` and complete in a scan the size of the current table (small in M1). The enforcement moves to: nginx (bytes, edge), the app's streaming counter (bytes, mid-stream), the `VALIDATING` step (page count, dims), and the worker (pixels, archive). |
| **Migration consequence** | This is the *last* migration any limit change requires. Every subsequent limit change is a YAML edit plus a rolling restart. **Grandfathering, stated explicitly:** because the DB no longer bounds these values, lowering a limit leaves pre-existing rows above it. Those rows stay readable and exportable; they are simply not re-processable. A nightly job emits `documents_above_current_limits` as a gauge so the operator can see the population before lowering anything. |
| **Security consequence** | **This is the one genuine cost, and it must be named:** removing a `CHECK` removes the last-resort backstop against an application bug that writes an out-of-range value. Mitigated by (a) the limit being enforced at three independent layers, not one; (b) the boot assertion (§6) failing readiness if the layers disagree; (c) the two CI tests the panel specified — upload exactly `cap + 1` bytes → branded 413 from the **app** (proving app ≤ nginx), and an EICAR-in-PDF at exactly `cap` bytes → `QUARANTINED` (proving cap ≤ clamd `StreamMaxLength` and `ScanPDF yes` in one test). The `> 0` / `>= 1` predicates that remain still catch the corrupting class of bug (negative, zero, null-where-forbidden), which is the class a `CHECK` is actually good at. |
| **Config/env consequence** | `OCR_LIMIT_MAX_UPLOAD_BYTES` and `OCR_LIMIT_MAX_PAGES_PER_DOCUMENT` become the only homes for these numbers. Neither appears in `schema.prisma`, in any migration, or in any hand-written nginx file. |

### DECISION F2-D8 — layering: nginx ≥ app = worker = client hint, and what the margin is *for*

| | |
|---|---|
| **Competing proposals** | `j` §8.8: `client_max_body_size = cap + 1 MB`, one server-level value, `client_body_timeout 120s` "matches the upload route timeout". `m` §3.4.3: `client_max_body_size = MAX_UPLOAD_MB + ~2 MB` "multipart boundary and header overhead", per-location (`m` N2). |
| **Selected** | Per-location, exact-match, with `+2 MiB`: |

```
client-side hint (browser JS)   = OCR_LIMIT_MAX_UPLOAD_BYTES            (exactly)
app streaming byte counter      = OCR_LIMIT_MAX_UPLOAD_BYTES            (exactly; abort at cap+1)
Python worker preflight         = OCR_LIMIT_MAX_UPLOAD_BYTES            (exactly)
nginx client_max_body_size      = OCR_LIMIT_MAX_UPLOAD_BYTES + 2 MiB    = 202m
clamd StreamMaxLength/MaxFileSize = OCR_LIMIT_MAX_UPLOAD_BYTES + 5 MiB  = 214,958,080 B
clamd MaxScanSize               >= StreamMaxLength
nginx client_body_temp volume   >= MAX_INFLIGHT_UPLOADS_GLOBAL × (cap + 2 MiB) × 2  → 4 GiB
```

| | |
|---|---|
| **Rejected** | **A single server-level `client_max_body_size`** (`j` §8.8) — `m` N2 is right: the server default must stay `1m` and only the upload location may be large, or every route on the vhost becomes an upload endpoint. **`j`'s `+1 MB`** — no reason to differ from `m`'s already-adjudicated `+2 MiB`. **`client_body_timeout 120s` as "matching the upload route timeout"** — a misreading, see below. |
| **Reason — what the +2 MiB is actually for, because the stated reason is wrong** | `m` §3.4.3 justifies the margin as "multipart boundary and header overhead". The real arithmetic: RFC 7578 overhead for a single file part is a ~70-byte boundary plus ~150 bytes of part headers plus a trailing boundary, and the worst-case filename is `i`'s `FILENAME_MAX_CHARS = 120` Thai characters at ≤ 9 bytes each percent-encoded ≈ 1,080 bytes — **under 4 KiB in total.** 2 MiB is 500× that. The margin's real and much better justification is: **the margin exists so that the *application*, not nginx, produces the error for anything just over the limit.** A body at `cap + 1` byte is accepted by nginx, streamed to the app, and rejected by the app's counter with a branded JSON 413 carrying a request id — instead of nginx's canned 413, which produces no application log line, no `documents` row, and an HTML body where the SPA expected JSON (`m` §3.4.1's exact failure). nginx's 413 then fires only for genuinely absurd bodies (> 202 MiB), where an unbranded error is the right outcome. Stating this correctly matters because a reader who believes the reason is "multipart overhead" will helpfully shrink the margin to 8 KiB and delete the property. |
| **Implementation consequence — `client_body_timeout` corrected** | `j` §8.8 sets `client_body_timeout 120s` with the comment "matches the upload route timeout". nginx's `client_body_timeout` is **the timeout between two successive read operations**, not a total-duration budget. At the 200 MiB cap a legitimate upload over a 2 Mbps Thai uplink takes **838 s (14 min)** and would never trip a per-read timeout anyway. Correct construction: **`client_body_timeout 60s`** (per-read — kills a stalled or slowloris client immediately, and is *tighter* than `j`'s value, not looser), with total duration bounded by `MAX_INFLIGHT_UPLOADS_PER_USER` and `limit_conn perip` rather than by a clock. The **app-side** upload route timeout becomes **900,000 ms (15 min)** — derived from 838 s of transfer plus headroom — and `proxy_read_timeout` on the upload location must exceed it at **930s**. Chat's vhost is 600 s and is not inherited; this is a new location in a new vhost. |
| **Migration consequence** | None. Config only. |
| **Security consequence** | The per-read timeout is the slowloris control and it is now correct rather than nominal. The exact-match `location = /api/documents/upload` outranks every prefix and regex location (`m` §3.4.2's precedence trap), so no later-added regex route can silently inherit a 202 MiB body limit. Every other location, including everything Chat serves on the same host, keeps the `1m` server default. |
| **Config/env consequence** | nginx, clamd and the app all render from `limits.yaml`; no hand-edited literal. Boot assertion (§6) queries the running nginx and clamd for their effective values and fails readiness on mismatch — `j` §8.8 and §11.4.1(4) both asked for this and neither wired it. |

### DECISION F2-D9 — pixel and dimension guards, and the Pillow double-correction bug

| | |
|---|---|
| **Competing proposals** | `j` §8.3: `MAX_PAGE_PIXELS = 40 M`, `Image.MAX_IMAGE_PIXELS = 40_000_000`, `MIN_PAGE_PIXELS = 10_000`. `f` P1: `Image.MAX_IMAGE_PIXELS = 20_000_000` **and** `warnings.simplefilter("error", DecompressionBombWarning)` **and** an explicit post-open assert, plus `n_frames <= 64` and a long-edge downscale above 6,000 px. `e` §5.5: `MAX_PIXELS_PER_PAGE = 40 M`, `MAX_PIXELS_PER_TILE = 12 M`, `MAX_BITMAP_BYTES_PER_PAGE = 128 MiB`, `MAX_TOTAL_RENDER_PIXELS = 4 G`. |
| **Selected** | `MAX_PAGE_PIXELS = 40_000_000`; **`Image.MAX_IMAGE_PIXELS = 40_000_000` *with* the warning promoted to an error**; explicit `w*h <= MAX_PAGE_PIXELS` assert after open; **`MAX_PAGE_EDGE_PX = 20_000` (new)**; `MIN_PAGE_PIXELS = 10_000`; `MAX_PIXELS_PER_TILE = 12_000_000`; `MAX_TILES_PER_PAGE = 12`; `MAX_BITMAP_BYTES_PER_PAGE = 134_217_728`; **`MAX_TOTAL_RENDER_PIXELS = 2_000_000_000` (derived, not independent)**; multi-frame allowed only for TIFF and bounded by `MAX_PAGES_PER_DOCUMENT`; single-image types must have exactly 1 frame. |
| **Rejected** | **`f`'s `MAX_IMAGE_PIXELS = 20_000_000` combined with warning-as-error — this is a live bug and the correction must not be copied as written.** `f`'s reasoning is right in isolation: Pillow warns above `MAX_IMAGE_PIXELS` and only raises above `2 ×`, so `j`'s bare 40 M was ineffective. `f` offers *two* independent fixes — halve the constant, **or** promote the warning — and then applies **both**, which stacks them: with the warning promoted, Pillow raises above `MAX_IMAGE_PIXELS` itself, so setting it to 20 M yields a **hard error at 20 Mpx**, i.e. half the stated policy cap. `f`'s own inline comment admits it (`f`:292: *"-> hard error at 20 MP too"*). Consequence if shipped: **every A4 page scanned at 400 DPI or above (15.5 Mpx is fine, but A3@400 = 30.9 Mpx and A4@600 = 34.8 Mpx are not) is rejected as a decompression bomb** — on a product whose corpus is Thai identity documents and archival scans. Correct construction: promote the warning **and** set the constant to the policy cap. **`f`'s `n_frames <= 64`** — a third page-ish number; frames are pages and belong to `MAX_PAGES_PER_DOCUMENT`. **`j`'s `MAX_TIFF_FRAMES = 50`** — was derived from `j`'s 50-page cap, which F2-D4 reassigned. **`f`'s unconditional long-edge downscale above 6,000 px** — it contradicts the pixel cap for wide formats and `f` itself warns it destroys 3 px Thai tone marks; superseded by `e` §5.5's DPI-reduce-then-tile ladder, which degrades resolution only as far as the budget demands. **`e`'s `MAX_TOTAL_RENDER_PIXELS = 4 G`** — an independent fifth number; replaced by the *product* of two owned caps. |
| **Reason** | `MAX_PAGE_EDGE_PX = 20_000` is new because the pixel cap alone admits a degenerate `1 × 40,000,000` image, which passes every check and then breaks OpenCV allocations, bbox arithmetic, and JPEG (whose own dimension field is 16-bit, max 65,535). 20,000 px admits every shape up to a 10:1 aspect ratio at the pixel cap (20,000 × 2,000 = 40 M) and every legitimate large format (A0 forced to ~160 DPI by the pixel cap is 7,490 px on the long edge). `MAX_TOTAL_RENDER_PIXELS` as `MAX_OCR_PAGES × MAX_PAGE_PIXELS` = 50 × 40 M = 2.0 G px makes it a **derived** guard that tiling cannot evade, and it regenerates automatically whenever M-1 moves the page cap. |
| **Implementation consequence** | The Pillow preamble is exactly three lines and all three are required: `Image.MAX_IMAGE_PIXELS = OCR_LIMIT_MAX_PAGE_PIXELS`; `warnings.simplefilter("error", Image.DecompressionBombWarning)`; and `assert w*h <= OCR_LIMIT_MAX_PAGE_PIXELS and max(w,h) <= OCR_LIMIT_MAX_PAGE_EDGE_PX` after `Image.open()` and **before** `load()`/`convert()` (`j`:417 — `open()` is lazy, so the check costs one header read). `e` §5.5's enforcement ladder is unchanged: reduce DPI in 50-DPI steps → tile at ≤ 12 M px with 5 % overlap, ≤ 12 tiles → `page_tiling_incomplete` warning. Each tile counts one page against the OCR budget. |
| **Migration consequence** | None. `g`'s `document_page_dims_positive` CHECK stays (F2-D7) and is unaffected by any value here. |
| **Security consequence** | Restores the decompression-bomb guard to the intended 40 Mpx (`f`'s version was accidentally at 20 Mpx and would have *over*-rejected, which is the safe direction for security and the wrong direction for the product). Adds edge-ratio protection that neither `j` nor `f` had. Decoded RGBA footprint at the cap is 40 M × 4 = 160 MB, which sets the 2 GiB worker container limit (F2-D12). |
| **Config/env consequence** | `OCR_LIMIT_MAX_PAGE_PIXELS=40000000`, `OCR_LIMIT_MAX_PAGE_EDGE_PX=20000`, `OCR_LIMIT_MIN_PAGE_PIXELS=10000`, `OCR_LIMIT_MAX_PIXELS_PER_TILE=12000000`, `OCR_LIMIT_MAX_TILES_PER_PAGE=12`, `OCR_LIMIT_MAX_BITMAP_BYTES_PER_PAGE=134217728`, `OCR_LIMIT_MAX_TOTAL_RENDER_PIXELS` **derived**, `OCR_LIMIT_MAX_PAGE_RENDER_BYTES=20971520` (`g` §5.4's 20 MiB derivative cap, adopted). |

### DECISION F2-D10 — structural budgets: archives, PDF object graph, filenames

| | |
|---|---|
| **Competing proposals** | Only `e` §2.4 and `j` §3.4 propose these, and they do not conflict. The question is whether F2 owns them or cites them. |
| **Selected** | **F2 owns them**, at `e`'s and `j`'s values, because they are operator-tunable DoS numbers that belong in one greppable surface with everything else: `MAX_ARCHIVE_ENTRIES = 5000`; `MAX_ARCHIVE_TOTAL_UNCOMPRESSED_BYTES = 524_288_000` (**actual bytes read from the decompressor**, not declared); `MAX_ARCHIVE_ENTRY_UNCOMPRESSED_BYTES = 209_715_200`; `MAX_ARCHIVE_COMPRESSION_RATIO = 200` (declared, first filter only); `MAX_PDF_PAGE_TREE_NODES = 10_000`; `MAX_PDF_INDIRECT_OBJECTS = 500_000`; `FILENAME_MAX_CHARS = 120`. |
| **Rejected** | Leaving them in `e` and `j` — that is precisely the pattern that produced five upload caps. Deriving the archive ceiling from the OOXML input cap — the two are independent (input is compressed, the ceiling is decompressed); stating the **ratio** as a derived observation (524,288,000 ÷ 26,214,400 = **20:1** effective policy ratio) is enough. |
| **Reason** | `e` §2.4's central insight must survive verbatim into the canonical set: **the ZIP central directory's `file_size` and `compress_size` are attacker-controlled metadata**, so `MAX_ARCHIVE_COMPRESSION_RATIO` is a *cheap first filter only* and the binding limit is a byte counter on the decompressed stream. `j` §3.4's is the same shape: **never trust `/Count`**; enumerate the page tree under a node budget with a visited-set and use the actual count. Both are the difference between a working guard and a guard that a bomb lies its way past. |
| **Implementation consequence** | `e` §2.4's `guard_zip` + `read_entry_bounded` shipped as written, reading these constants. Path-traversal entry names, encrypted entries and macro-enabled packages behave per `e` §2.4 (`E_ARCHIVE_TRAVERSAL`, `E_ARCHIVE_ENCRYPTED`, `ooxml_macro_enabled` flag). The page-tree walk feeds the **actual** page count into the F2-D4 admission check. |
| **Migration consequence** | None. |
| **Security consequence** | These are the highest-leverage numbers in the document — they bound the classes of attack that a size cap alone cannot (a 20 KB Flate bomb, a `/Pages` cycle, a 100,000-page tree behind `/Count 3`). `MAX_PDF_INDIRECT_OBJECTS = 500_000` and the 10,000-node budget are the only defence against `j` §3.4's "lying `/Count`" row. |
| **Config/env consequence** | Seven `OCR_LIMIT_*` vars. The 20:1 effective ratio is asserted at boot: `MAX_ARCHIVE_TOTAL_UNCOMPRESSED_BYTES / MAX_UPLOAD_BYTES_OOXML` must be between 10 and 40, so a future OOXML cap change cannot silently create a bomb window. |

### DECISION F2-D11 — extracted-character caps (new; M0 had none)

| | |
|---|---|
| **Competing proposals** | None in M0. The only adjacent value is `g`'s `pg_column_size(lines_json) <= 4 MiB`, which bounds the *storage* of OCR geometry and says nothing about text volume. |
| **Selected** | **`MAX_CHARS_PER_PAGE = 200_000`** and **`MAX_CHARS_PER_DOCUMENT = 10_000_000`**. Both **truncate with a warning; neither fails the document.** |
| **Rejected** | No cap — a born-digital PDF whose single page carries a megabyte of text is a legal input today and would flow unbounded into `ocr_results`, the export, the search index and the AI chunker. Failing the document on breach — text extraction is the near-free path; partial text is strictly better than no text, and this is not a security boundary (the archive and object-graph budgets of F2-D10 are). |
| **Reason** | A dense Thai A4 page holds **2,500–3,500 characters** (`j` §8.4). 200,000 is **60×** the dense worst case, so it can only be reached by a pathological or machine-generated page — exactly the case worth truncating. The document cap is 500 pages × 20,000 chars/page (6× the dense case), rounded to 10 M, and it is what bounds the export size, the tsvector/trigram index growth (`m` §4.5.1 measures Thai trigram GIN at 120–200 MB per 1,000 documents), and the AI chunk arithmetic in F2-D14. |
| **Implementation consequence** | Truncation is at a **grapheme-cluster boundary after NFC normalisation**, never mid-codepoint and never mid-cluster — truncating between a Thai base character and its tone mark produces a different word, which is a correctness bug in a document-intelligence product, not a cosmetic one. Page warning `text_truncated`, document warning `document_text_truncated`, both surfaced in the UI and the API response. |
| **Migration consequence** | None. |
| **Security consequence** | Closes an unbounded-write path into Postgres that M0 left open. Combined with `g`'s 4 MiB `lines_json` guard, one document's text footprint is now bounded above by ~10 MB of text plus ~2 GiB theoretical / 75–200 MiB realistic of geometry. |
| **Config/env consequence** | `OCR_LIMIT_MAX_CHARS_PER_PAGE=200000`, `OCR_LIMIT_MAX_CHARS_PER_DOCUMENT=10000000`. |

### DECISION F2-D12 — concurrency: global 4 = 2 replicas × 2, per-user 2

| | |
|---|---|
| **Competing proposals** | `j` §8.6: worker pool **4**, per-user **2**, queued/user **25**, in-flight AI/tenant **2**, in-flight uploads/user **3**, DB pool **10**, worker memory **2 GB**. `m` §2.2.2: `replicas: ${OCR_WORKERS:-2}`. `e` §5.5: `RENDER_CONCURRENCY = 2` per worker process. Panel (:712) lists the unresolved pairs as "worker pool (4 vs 1)" and "worker memory (2 GB vs 3 GB)". |
| **Selected** | **These were never in conflict — they measure different things.** `MAX_CONCURRENT_JOBS_GLOBAL = 4` **= `WORKER_REPLICAS (2) × WORKER_JOB_CONCURRENCY (2)`**, asserted at boot. `MAX_CONCURRENT_JOBS_PER_USER = 2`; `MAX_QUEUED_DOCS_PER_USER = 25`; `MAX_INFLIGHT_AI_CALLS_PER_TENANT = 2`; `RENDER_CONCURRENCY = 2` per worker process; `DB_POOL_PER_APP_INSTANCE = 10`; worker container memory limit **2 GiB**. **Changed from `j`: `MAX_INFLIGHT_UPLOADS_PER_USER = 2`** (was 3) and **`MAX_INFLIGHT_UPLOADS_GLOBAL = 8`** (new). |
| **Rejected** | Picking 4 *or* 2 — `j`'s "4" is total concurrent jobs, `m`'s "2" is container replicas; both are right and the product is 4. **`j`'s 3 in-flight uploads/user** — `j` sized it as "3 × 25 MB = 75 MB per user of buffered body"; at the 200 MiB cap that arithmetic yields 600 MiB per user and the number no longer defends anything. **`3 GB` worker memory** — 2 GiB is `j`'s own derivation from the 40 Mpx cap (40 M × 4 B RGBA = 160 MB peak page, ×2.2 for the PDFium+Pillow+encoder copies of `e` §5.4 ≈ 350 MB, plus the model and runtime), and it is the value that fits the box. |
| **Reason** | Verified ground truth: the dev box gives Docker **8 vCPU / 8 GiB total for every service**, and the production host is **shared with INNOVERA Chat and a GPU workload**. Container *limits* sum to 2×2 GiB (workers) + 1 GiB (Postgres) + 512 MiB (web) + 64 MiB (nginx) ≈ 5.6 GiB, inside 8 GiB. **The distinction that M0 lost (`m`:3589 totalled 8.2 GB on an 8 GB box): limits are ceilings, reservations are commitments — the boot assertion must compare *reservations*, not limits, or every sizing exercise over-counts.** Per-user 2 of a pool of 4 preserves `j`'s fairness argument exactly (a cap of 3 would let one tenant hold 75 % of the pool), and `h`'s round-robin-across-tenants queue ordering does the rest. |
| **Implementation consequence** | `MAX_CONCURRENT_JOBS_GLOBAL` is not itself enforced — it is an *assertion* over two values that are (replica count, per-worker concurrency). The enforced values are the per-user and per-tenant caps, checked before the claim. In-flight upload caps are enforced in the app, not nginx, because nginx cannot key on a user. |
| **Migration consequence** | `tenant_quotas` (`h` §13.2 already introduces it for `queueTtlMs`) gains per-org overrides for `MAX_CONCURRENT_JOBS_PER_USER` so an Enterprise tenant gets a **dedicated pool**, never a raised shared cap (`j` §8.6's rule, preserved). |
| **Security consequence** | Bounds the DoS surface a single tenant can occupy. `MAX_INFLIGHT_UPLOADS_GLOBAL = 8` is what makes the nginx body-temp volume sizing in F2-D8 finite: 8 × 202 MiB ≈ 1.6 GiB, volume provisioned at 4 GiB. Without a global cap that number is unbounded and a disk-full incident takes Postgres with it (`i` §4.4's exact scenario). |
| **Config/env consequence** | `OCR_LIMIT_MAX_CONCURRENT_JOBS_GLOBAL=4` (derived/asserted), `OCR_WORKERS=2` (existing, `m`), `OCR_LIMIT_WORKER_JOB_CONCURRENCY=2`, `OCR_LIMIT_MAX_CONCURRENT_JOBS_PER_USER=2`, `OCR_LIMIT_MAX_QUEUED_DOCS_PER_USER=25`, `OCR_LIMIT_MAX_INFLIGHT_AI_CALLS_PER_TENANT=2`, `OCR_LIMIT_MAX_INFLIGHT_UPLOADS_PER_USER=2`, `OCR_LIMIT_MAX_INFLIGHT_UPLOADS_GLOBAL=8`, `OCR_LIMIT_RENDER_CONCURRENCY=2`, `OCR_LIMIT_DB_POOL_PER_APP_INSTANCE=10`. **Measurement-blocked (M-1):** the global 4 is provisional until worker RSS under contention is measured; the boot assertion `sum(reservations) <= 0.85 × host RAM` fails readiness rather than letting the host OOM. |

### DECISION F2-D13 — quotas: `j` §8.4's tiers adopted, with 25 MB restored as the Free-tier upload cap

| | |
|---|---|
| **Competing proposals** | `j` §8.4's two-tier table (uncontested by any other document). Panel (:618): *"Record 25 MB / 50 pages as the per-plan Free-tier cap in §8.4, which is where a number that small legitimately belongs, and delete it from §8.1 so D16 stops competing with the platform limit."* |
| **Selected** | `j` §8.4's Standard tier becomes the **default for a new organisation**, seeded into `tenant_quotas`; per-org overrides are rows, not env vars. Env vars carry only the seed defaults. Adopt the panel's placement: **Free tier upload cap = 26,214,400 (25 MiB), Free tier OCR pages/document = 50**; Standard = the platform values. `j`'s **20 % daily sub-cap under every monthly cap** rule is retained as a *rule*, not just as numbers. |
| **Rejected** | Free tier as the default for a new org — this is a private, operator-run platform with a small number of known tenants, not a self-serve signup funnel; defaulting to Free would make every new tenant an immediate support ticket. Quotas as env vars only — they are per-tenant by nature and belong in a table; env vars that pretend to be per-tenant are how a "temporary" override becomes permanent. |
| **Reason** | The quota axes are the only limits in this document that are **commercial** rather than technical, so F2 owns their *shape* (every axis capped, a daily sub-cap under every monthly cap, checked **before** the storage PUT and **before** the AI call, decremented in the same transaction as the usage row) and defers their *packaging* to the owner — see **OWNER-BLOCKED (B-2)**. `j`'s enforcement ordering rule is the load-bearing part and is adopted verbatim: *"A check-after-work quota is a quota that has already been exceeded."* |
| **Implementation consequence** | Reuses the jawbong `outbox_events` / `idempotency_records` foundation for the same-transaction decrement, and `i` §4.5's two-phase reserve→settle for storage bytes (reservation = `contentLength ?? MAX_UPLOAD_BYTES`, now 200 MiB not 500 MB, halving the pessimism). AI token quota is checked before **each chunk**, not once per document, so a long document degrades to `ai_quota_exhausted` partial rather than overshooting the tier. |
| **Migration consequence** | `tenant_storage_usage` and `storage_reservations` per `i` §4.5, plus `tenant_quotas` per `h` §13.2 — both already planned. F2 adds no new tables. |
| **Security consequence** | The quota is the cost-DoS control and the abuse control. The daily sub-cap is the part that matters: it stops a single day burning the month, which is what both an abuser and a runaway integration bug do. |
| **Config/env consequence** | `OCR_LIMIT_DEFAULT_*` seeds (see the canonical table). **OWNER-BLOCKED (B-2): commercial tier packaging.** Named default that ships if the owner stays silent: **every new organisation is seeded at the Standard tier below; the Free tier exists in the schema and is used by no one.** |

| Axis | Free / trial | **Standard (default)** | Source |
|---|---|---|---|
| Upload cap per file | 26,214,400 (25 MiB) | 209,715,200 (200 MiB) | panel :618 placement of `j` §8.1 |
| OCR pages per document | 50 | 50 | F2-D4 (same until M-1) |
| Documents / month | 50 | 500 | `j` §8.4 |
| Documents / day | 20 | 100 | `j` §8.4 (20 % sub-cap) |
| Pages / month | 200 | 5,000 | `j` §8.4 |
| Pages / day | 80 | 1,000 | `j` §8.4 (20 % sub-cap) |
| Upload bytes / month | 262,144,000 (250 MiB) | 5,368,709,120 (5 GiB) | `j` §8.4 |
| Stored bytes | 524,288,000 (500 MiB) | 16,106,127,360 (15 GiB) | `j` §8.4 |
| AI tokens / month | 1,000,000 | 25,000,000 | `j` §8.4 |
| AI tokens / day | 400,000 | 5,000,000 | `j` §8.4 (20 % sub-cap) |

> **Arithmetic check on the AI tier, because `j`'s premise was wrong.** `j` §8.4 assumed Thai at
> "1 token per 1.5–2.5 characters". The **verified** INNOVERA estimator (`src/lib/ai/context/tokens.ts`,
> read from the public `WeiWutichai/innovera-chat` repo) treats non-ASCII BMP — Thai included — as
> **1 token per character**, i.e. `j`'s premise was optimistic by ~2×. Re-running `j`'s arithmetic on
> the verified ratio: a dense page ≈ 3,000 Thai chars ≈ 3,000 tokens, plus ~800 system/schema and
> ~500 output ≈ **4,300 tokens/page** — against `j`'s rounded-up 4,000. Standard tier: 5,000 pages ×
> 4,300 = 21.5 M, × 1.16 safety = **25 M. `j`'s number survives**, but only because `j` rounded 2,800
> up to 4,000; the reasoning it published does not. Use 4,300 and the verified ratio going forward.
> `UNVERIFIED:` whether the OCR gateway's model shares Chat's tokeniser.

### DECISION F2-D14 — AI context budget = 20,000 chars per chunk, citing Chat's precedent

| | |
|---|---|
| **Competing proposals** | Adopt Chat's verified `CHAT_CONTEXT_CHAR_BUDGET = 20000`; or size our own budget up toward the verified 65,536-token model ceiling since our payload (OCR text + JSON schema) is bounded per request rather than accumulating like a conversation; or `b`'s 8 MB total-request-body cap as the only bound. |
| **Selected** | **`AI_CONTEXT_CHAR_BUDGET = 20_000` characters per request**, matching Chat exactly. Plus `AI_MAX_OUTPUT_TOKENS = 4_096`, `AI_MAX_CHUNKS_PER_DOCUMENT = 60`, `AI_MAX_REQUEST_BODY_BYTES = 8_388_608` (`b`'s 8 MiB, adopted). |
| **Rejected** | **Sizing up toward 65,536.** The argument for it is real — our payload does not accumulate — but it rests on assumptions about a gateway we cannot reach: the authorised model for an OCR key, its true context window, its KV-cache pressure under the GPU host's concurrent Chat load, and whether it persists request bodies are all **UNVERIFIED and owner-blocked**. Chat chose 20,000 *deliberately far below the ceiling* to bound prefill cost, latency and KV-cache pressure **on the host we would be sharing**. Adopting a larger number would be claiming knowledge of that gateway that this session does not have. **`b`'s 8 MB body cap alone** — a byte cap on a base64 payload says nothing about token cost, which is what the GPU actually spends. |
| **Reason** | 20,000 Thai characters ≈ **20,100 tokens** on the verified estimator (`b` E15: *"20,000 characters of pure Thai — the worst realistic case the char budget permits — estimates at roughly 20,100 tokens"*). Adding ~1,000 tokens of system prompt and JSON schema plus 4,096 output tokens gives **≈ 25,200 tokens, or 38 % of the verified 65,536 ceiling** — leaving room for a repair retry that appends the validation error, and for the tokeniser estimate being wrong by 1.5×. **Scope note:** Chat's 20,000 bounds an accumulating conversation; ours bounds one stateless extraction request, so the *reason* differs even though the *value* is adopted. The value is adopted because the constraint it protects (the shared GPU host) is identical. |
| **Implementation consequence** | Chunking is by character budget with overlap at document-structure boundaries, never mid-page. 60 chunks × 20,000 = 1.2 M characters of any one document ever reach the AI; beyond that the document carries `ai_context_truncated` and **the deterministic OCR output is still complete** — the AI layer must never gate the deterministic path (mirroring Chat's rule that **LiteLLM is not part of readiness**). A 50-page OCR'd document is ~150,000 chars ≈ 8 chunks, well inside the cap; the 60-chunk ceiling only binds on a 500-page native-text document. |
| **Migration consequence** | None. |
| **Security consequence** | Bounds the token bill per document at ~60 × 25,200 ≈ **1.5 M tokens worst case = 6 % of the Standard monthly tier**, so one pathological document cannot exhaust a tenant's month. The per-chunk quota check (F2-D13) is what enforces it. Request bodies stay under `b`'s 8 MiB so a lying/oversized payload cannot be used to probe the gateway. |
| **Config/env consequence** | `OCR_LIMIT_AI_CONTEXT_CHAR_BUDGET=20000`, `OCR_LIMIT_AI_MAX_OUTPUT_TOKENS=4096`, `OCR_LIMIT_AI_MAX_CHUNKS_PER_DOCUMENT=60`, `OCR_LIMIT_AI_MAX_REQUEST_BODY_BYTES=8388608`. **OWNER-BLOCKED (B-1):** the authorised model for an OCR virtual key, its real context window, and whether the gateway persists prompt/response bodies. **Named default that ships if the owner stays silent: 20,000 chars, text-only, no image bytes sent, AI features hard-disabled when `AI_GATEWAY_BASE_URL` is empty** (`m` §2.2's existing behaviour). `UNVERIFIED:` the model alias `innovera-ai`; `UNVERIFIED:` any vision capability — the only verified evidence (Chat's `src/lib/extraction/parsers/image.ts`) says the deployed model is **text-only**, and that proves it for Chat's model, not for the gateway's alias list. Treat as text-only until a live probe proves otherwise. |

### DECISION F2-D15 — one error code per failure, `payload_too_large` wins

| | |
|---|---|
| **Competing proposals** | `l` §1.3's envelope uses `payload_too_large` (413) and `export_too_large` (413). `i` throws `StorageError('too-large')` and maps quota exhaustion to **413**. `m` §3.4.4's nginx `@too_large` block returns `{"error":{"code":"too-large",...}}`, deliberately aligned to `i` rather than to `l`. `l` (:1435) returns **429** for quota on create. |
| **Selected** | **`payload_too_large` (413)** everywhere the *body* is too large — app **and** nginx, so a client that special-cases one matches the other. `i`'s internal `StorageError('too-large')` stays as a **domain** code and maps to it at the transport boundary. **Quota is never 413:** time-windowed quotas (docs/day, pages/month, tokens/month) → **429 `quota_exceeded`** with `Retry-After`; the storage-bytes quota → **507 `storage_quota_exceeded`**. |
| **Rejected** | **`too-large` as the wire code** — `m` aligned nginx to `i`'s internal domain code, but `l` owns the public API envelope and it is the client-visible contract; an internal storage-adapter enum must not leak into it. **413 for quota** (`i` §4.5) — 413 means *this request's body is too large*, so a client that retries with a smaller file is misled into an infinite shrink loop when the real problem is that the account is full. |
| **Reason** | An error code is a contract with an integrator. Two codes for one condition, or one code for two conditions, both produce the same outcome: the integrator writes a string match against whichever they saw first, and the other path renders "Something went wrong" (`m` §3.4.1's exact failure mode, from the other direction). |
| **Implementation consequence** | `m` §3.4.4's nginx `@too_large` body changes `"code":"too-large"` → `"code":"payload_too_large"` and its `limitBytes` renders from `limits.yaml`. The `@rate_limited` and `@upstream_down` blocks keep their codes. `m`'s two nginx traps stand and must not be undone by this edit: `default_type` already sets `Content-Type` (a second `add_header Content-Type` is a protocol error), and **any** `add_header` at location level drops every inherited security header, so the security-headers snippet must be re-included in each error location. |
| **Migration consequence** | None. |
| **Security consequence** | 507 for storage quota is more informative than 413 but reveals only that the tenant's own account is full — no cross-tenant information. Every 429 carries `Retry-After`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` (`j` §8.5's rule): a limit an integrator cannot see is a limit they will hammer. |
| **Config/env consequence** | Error codes render from one table (§5) into the OpenAPI document, the nginx error locations and the app's envelope. |

### DECISION F2-D16 — `proxy_request_buffering on` for the upload location

| | |
|---|---|
| **Competing proposals** | `j` §8.8: `proxy_request_buffering on` ("protects Node from slowloris body attacks"). `m` §3.4.4: reasons explicitly about the behaviour "with `proxy_request_buffering off` on the upload location", including the consequence that a client 90 s into an oversized upload is cut off with a TCP RST before it reads the JSON 413. |
| **Selected** | **`on`**, with `client_body_buffer_size 128k` (spill to disk beyond that) and `client_body_temp_path` on a volume sized ≥ 4 GiB. |
| **Rejected** | **`off`** — it buys mid-stream rejection by the app, which sounds better and is not: `m` §3.4.4 documents its own cost (an RST before the JSON body is read, so the browser reports a network error rather than a branded 413), and it exposes the Node event loop directly to a slow body. The mid-stream app-side byte counter is kept regardless — it is needed because `Content-Length` is attacker-supplied, and because `l` L-1's presigned direct-to-object-store path bypasses nginx entirely. |
| **Reason** | With buffering **on** and a `Content-Length` present, nginx rejects an oversized body **before reading it**, so the branded JSON 413 is delivered cleanly and `m` §3.4.4's RST problem does not arise for the common case. Buffering to **disk** also refutes `j` D16's headline objection to a larger cap: a 200 MiB body costs 128 KiB of RAM and 200 MiB of temp disk, not 200 MiB of RAM. The remaining case — a chunked body with no `Content-Length` — is inherently unfixable at the edge and is handled where `m` says it must be: **in the client**, by checking `file.size` before the upload starts (a UX feature, never a security control). |
| **Implementation consequence** | Uploads go to a **Route Handler that streams**, never a Server Action (Next.js Server Actions have a 1 MB body limit — `j` §8.8). The app counts bytes as they stream and aborts at `cap + 1` in addition to trusting `Content-Length`. |
| **Migration consequence** | None. |
| **Security consequence** | Slowloris body attacks terminate at nginx. Combined with `client_body_timeout 60s` (per-read, F2-D8) and `MAX_INFLIGHT_UPLOADS_GLOBAL = 8`, the buffered-body surface is bounded in both bytes and time. |
| **Config/env consequence** | The upload location gets `proxy_request_buffering on; client_body_buffer_size 128k; client_body_timeout 60s; client_max_body_size 202m; proxy_read_timeout 930s;` — an **exact-match `location =`** block so no regex location can outrank it (`m` §3.4.2). |

### DECISION F2-D17 — batch limits (new; M0 had none)

| | |
|---|---|
| **Competing proposals** | None. `l` reasons about "20 in-flight files" in the upload UI (:2361) and caps the batch **status** query at `?ids=` ≤ 100 (:1109); neither is a batch ingest limit. |
| **Selected** | **`MAX_FILES_PER_BATCH = 20`**, **`MAX_BATCH_BYTES = 1_073_741_824` (1 GiB)**, **`MAX_STATUS_IDS_PER_QUERY = 100`** (`l`'s value, adopted). A "batch" is a client-side grouping plus a `batch_id`: **each file is its own HTTP request**, never one giant multipart body. |
| **Rejected** | One multipart body per batch — it would put 20 × 200 MiB through a single request, defeat per-file dedup and per-file resume, and make one bad file fail nineteen good ones. No batch limit at all — a directory drop (`l` :2463 supports `webkitdirectory`) can select thousands of files, and without a cap the browser opens them all against `MAX_INFLIGHT_UPLOADS_PER_USER` with an unbounded client-side queue and an unbounded quota reservation. |
| **Reason** | 20 matches the number `l`'s own UI reasoning already assumes and keeps the batch-status poll (one request every 2 s for the whole batch, `l` :2361) inside the 100-id query cap with room for retries. 1 GiB = 20 × ~50 MiB average, and it is the number the **quota reservation** is taken against up front, so a batch that cannot fit the tenant's remaining storage fails at file 1 rather than at file 17. |
| **Implementation consequence** | The upload page enforces both client-side; the API enforces `MAX_FILES_PER_BATCH` per `batch_id` and reserves `MAX_BATCH_BYTES` (or the sum of declared sizes, whichever is smaller) in one `i` §4.5 phase-1 reservation. A batch that exceeds either is rejected whole with `422 batch_limit_exceeded` before any byte is uploaded. |
| **Migration consequence** | `documents` needs a nullable `batch_id uuid` and an index on `(organization_id, batch_id)` for the status query. **Recommendation to the data-model dimension**, not an F2 decision. |
| **Security consequence** | Bounds the directory-drop amplification path and makes the quota check happen once, before work, rather than 2,000 times during it. |
| **Config/env consequence** | `OCR_LIMIT_MAX_FILES_PER_BATCH=20`, `OCR_LIMIT_MAX_BATCH_BYTES=1073741824`, `OCR_LIMIT_MAX_STATUS_IDS_PER_QUERY=100`. |

### DECISION F2-D18 — rate limits: `j` §8.5 adopted, one arithmetic correction

| | |
|---|---|
| **Competing proposals** | `j` §8.5's eight-class table (uncontested). Its browser-upload row is justified as *"10 × 25 MB = 250 MB/min of ingress per user — already generous"*, arithmetic that does not survive the cap change. |
| **Selected** | `j` §8.5's values adopted **unchanged**, with the justification for the upload row replaced: the real throttle is **`MAX_INFLIGHT_UPLOADS_PER_USER = 2`**, not the request rate, because a 200 MiB upload occupies a slot for minutes and the per-minute counter never binds. `j` §8.5.1's `X-Forwarded-For` handling is adopted in full and is a **hard requirement**, not an option. |
| **Rejected** | Lowering the browser-upload rate to "fix" the arithmetic — it would penalise the common case (many small files) to bound a case that the in-flight cap already bounds. Per-IP limits as the primary control — `j` §8.5.1 is right that Thai enterprise and mobile networks are heavily NAT'd/CGNAT, so IP is a poor key; every meaningful limit is keyed on **user or API key**, and per-IP exists only as a backstop for unauthenticated routes. |
| **Reason** | The table is internally coherent, has a rationale per row, and nothing else in M0 contradicts it. The one broken derivation is the one the cap change broke. |
| **Implementation consequence** | `j` §8.5.1's five mitigations are mandatory, because without them **six limits in the table are bypassed by one request header**: (1) `TRUSTED_PROXY_HOPS` default 1, client IP taken as the *n*-th value **from the right**, never the left-most and never `req.ip` untrusted; (2) nginx **assigns** `proxy_set_header X-Forwarded-For $remote_addr` — assignment, not `$proxy_add_x_forwarded_for`; (3) strip `Forwarded`, `X-Real-IP`, `X-Client-IP`, `True-Client-IP`, `CF-Connecting-IP`, `X-Forwarded-Host`, `X-Forwarded-Proto` at the edge; (4) a startup assertion that `TRUSTED_PROXY_HOPS` is set and "trust all proxies" is off; (5) a test that a forged `X-Forwarded-For` still counts against the real peer. **`j` §8.5's chosen limiter is `rate-limiter-flexible` 11.2.0 with a Redis backend, which contradicts `m` O2's "Redis rejected for M1" — out of F2 scope, flagged to the queue/deployment dimension.** F2 owns the *values*; whichever store wins must implement them shared across app instances (in-memory limiting means N instances = N × the limit). |
| **Migration consequence** | None. |
| **Security consequence** | The login limiter (5/min/IP + 20/hour/IP + 10/hour/account) is the control standing between the platform and credential stuffing; it is fictional without §8.5.1. Treat a per-IP 429 on an *authenticated* route as a bug in the limiter key, not as a working control. |
| **Config/env consequence** | `OCR_LIMIT_RATE_*` per the canonical table; `OCR_LIMIT_TRUSTED_PROXY_HOPS=1`. |

---

## 5. Failure behaviour — one row per limit

Columns: **Where** = the layer that produces the response. **Partial upload** = what happens to
bytes already received and to any storage reservation.
Thai strings are the user-facing copy; they are drafted here and **must be reviewed by a native
speaker before M1 ships** (flagged as `UNVERIFIED: copy`).

| Limit breached | HTTP | Error code | Where | Thai (user-visible) | Partial upload / reservation |
|---|---|---|---|---|---|
| Body > `MAX_UPLOAD_BYTES` (known `Content-Length`) | 413 | `payload_too_large` | **app** (nginx never sees it — the +2 MiB margin exists for this, F2-D8) | ไฟล์มีขนาดเกินขีดจำกัด 200 MB กรุณาลดขนาดไฟล์หรือแบ่งเอกสาร | Nothing written. No reservation taken (the check precedes phase 1). |
| Body > `MAX_UPLOAD_BYTES` (lying/absent `Content-Length`) | 413 | `payload_too_large` | **app**, mid-stream at `cap + 1` | same | Staged object unlinked and reservation released in a `finally`. |
| Body > `client_max_body_size` (> 202 MiB) | 413 | `payload_too_large` | **nginx** `@too_large` (JSON, security-headers snippet re-included) | same | nginx unlinks its own temp file. No app row exists. |
| Body > per-type cap after sniff | 413 | `payload_too_large` | **app**, post-sniff | ไฟล์ชนิดนี้มีขนาดเกินขีดจำกัด | As mid-stream row above. |
| Type not in the allowlist | 415 | `unsupported_media_type` | **app**, post-sniff | ไม่รองรับไฟล์ชนิดนี้ | As mid-stream row above. |
| Animated / multi-frame single-image type | 415 | `unsupported_media_type` (`reason=animated_image`) | **app**, header read only | ไม่รองรับภาพเคลื่อนไหว | Discarded. |
| Pages > `MAX_PAGES_PER_DOCUMENT` (501+) | 422 | `page_limit_exceeded` | **app**, during `VALIDATING`, from the **actual** page-tree walk (never `/Count`) | เอกสารมีจำนวนหน้าเกิน 500 หน้า กรุณาแบ่งไฟล์ | Bytes are already durably stored; the document row is `FAILED` and the object is swept by the orphan lifecycle. Quota is settled then released. |
| 0 pages / encrypted / corrupt | 422 | `document_encrypted` · `document_corrupt` | **app**, `VALIDATING` | ไม่พบหน้าเอกสาร / ไฟล์ถูกเข้ารหัส / ไฟล์เสียหาย | As above. |
| Page pixels > `MAX_PAGE_PIXELS`, unfixable by DPI reduction and tiling | 422 | `pixel_limit_exceeded` | **worker**, per page | ภาพมีความละเอียดสูงเกินไป | Page-level; the document continues. |
| Page long edge > `MAX_PAGE_EDGE_PX` | 422 | `pixel_limit_exceeded` (`reason=edge_ratio`) | **worker**, header read | same | Page-level. |
| Page pixels < `MIN_PAGE_PIXELS` | — | — (warning `page_too_small`) | **worker** | (warning only) | Page flagged, not processed, document continues. |
| Archive entry/ratio/actual-bytes/traversal/encrypted-entry | 422 | `archive_limit_exceeded` · `archive_traversal` · `archive_encrypted` | **worker** | ไฟล์บีบอัดภายในเกินขีดจำกัดที่กำหนด | Whole document refused (partial parse of a hostile archive is worse than an error). |
| PDF node budget / indirect-object cap / `/Pages` cycle | 422 | `document_corrupt` (`reason=pdf_structure_budget`) | **worker** | ไฟล์เสียหายหรือมีโครงสร้างผิดปกติ | Whole document. |
| OCR pages > `MAX_OCR_PAGES_PER_DOCUMENT` | **200** | — (warning `render_budget_exhausted`) | **worker** | ประมวลผล OCR ได้ 50 หน้าแรก หน้าที่เหลือถูกข้าม | **Not a failure.** Pages 1–20 first, then user-selected, then ascending (`e` §5.5 item 5); remainder `route=SKIPPED`. |
| Job exceeds `JOB_PROCESSING_BUDGET_MS`, ≥ 1 page done | **200** | — (warning `time_budget_exhausted`) | **worker**, deadline check before each page | ประมวลผลได้บางส่วน เนื่องจากเกินขีดจำกัดเวลา | **`SUCCEEDED_PARTIAL`.** Checkpoints kept. Not re-queued. |
| Job exceeds budget, **0** pages done | 200 (job `FAILED`) | `BUDGET_EXCEEDED` | **worker** | ไม่สามารถประมวลผลได้ภายในเวลาที่กำหนด | Terminal, non-retryable. This is the only surviving `BUDGET_EXCEEDED`. |
| Queue wait > `JOB_QUEUE_TTL_MS` (24 h) | 200 (job `FAILED`) | `QUEUE_WAIT_EXCEEDED` | **reaper** | ระบบมีงานค้างจำนวนมาก กรุณาส่งเอกสารใหม่อีกครั้ง | A **capacity** signal, `userFacing`, pages an operator. Never counted as a processing failure. |
| Page stage timeout (render 30 s / parse 10 s / OCR 45 s) | **200** | — (page warning `render_timeout` · `parse_timeout` · `ocr_timeout`) | **worker** | (page-level badge) | One bad page never kills the job (`e` §4.6). |
| Extracted chars > per-page or per-document cap | **200** | — (warning `text_truncated` · `document_text_truncated`) | **worker** | ข้อความบางส่วนถูกตัดทอน | Truncated at a grapheme-cluster boundary after NFC. |
| Storage bytes quota exhausted | **507** | `storage_quota_exceeded` | **app**, `i` §4.5 phase 1, **before any byte is written** | พื้นที่จัดเก็บเต็ม | Nothing written; reservation refused atomically (0 rows updated). |
| Host disk below `RESERVE_BYTES` | 507 | `insufficient_storage` | **app**, `i` §4.4 preflight | ระบบมีพื้นที่ไม่เพียงพอชั่วคราว | Nothing written. |
| Docs/pages/tokens quota (windowed) | **429** | `quota_exceeded` | **app**, before the PUT and before each AI chunk | โควตาการใช้งานเต็ม กรุณาลองใหม่ภายหลัง | `Retry-After` = window reset. AI case degrades the document to `ai_quota_exhausted` partial. |
| Batch > 20 files or > 1 GiB | 422 | `batch_limit_exceeded` | **app**, before file 1 | จำนวนไฟล์หรือขนาดรวมเกินขีดจำกัดต่อชุด | Whole batch refused before any upload. |
| Queued docs/user > 25 | 429 | `queue_full` | **app** | มีเอกสารรอประมวลผลมากเกินไป | `Retry-After` set. |
| Concurrent jobs/user > 2 | — | — | **claim step** | (UI shows "รอคิว") | Not an error; the job waits. |
| In-flight uploads/user > 2 | 429 | `too_many_uploads` | **app** | กำลังอัปโหลดหลายไฟล์พร้อมกันเกินไป | Client retries the queued file. |
| Rate limit (any class) | 429 | `rate_limited` | **app** (per-principal) or **nginx** `@rate_limited` (per-IP backstop) | คำขอมากเกินไป | `Retry-After`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` always present. |
| Export > 50,000 rows or 1,000,000 cells | 413 | `export_too_large` | **app** | ข้อมูลเกินขีดจำกัดของไฟล์ XLSX กรุณาใช้ CSV หรือ NDJSON | Names the alternative format, per `l` L-16. |
| AI chunks > 60 | **200** | — (warning `ai_context_truncated`) | **worker** | การวิเคราะห์ด้วย AI ครอบคลุมบางส่วนของเอกสาร | Deterministic OCR output is complete regardless. |
| AI gateway unreachable / not configured | **200** | — (warning `ai_unavailable`) | **worker** | ระบบ AI ไม่พร้อมใช้งาน ผลลัพธ์ OCR ยังสมบูรณ์ | **Never gates readiness or the OCR result** — mirrors Chat's rule that LiteLLM is not part of readiness. |

**The invariant behind this table:** an ingest-time limit **rejects**; a processing-time limit
**degrades**. M0 mixed the two, which is how a 200-page document became a terminal failure.

---

## 6. Enforcement wiring — one source, three assertions, two tests

**Source of truth:** `config/limits.yaml`, generated into `@innovera/ocr-limits` (TypeScript) and
`innovera_ocr_limits` (Python), plus templated fragments for nginx (`client_max_body_size`,
timeouts, `@too_large` body) and clamd (`StreamMaxLength`, `MaxFileSize`, `MaxScanSize`,
`MaxScanTime`). **No layer reads a literal.**

**Boot assertions — all four fail readiness, they do not warn:**

1. `app.MAX_UPLOAD_BYTES <= nginx.client_max_body_size` (queried from the running nginx) **and**
   `app.MAX_UPLOAD_BYTES < clamd.StreamMaxLength` (queried from the running daemon per `j` §11.4.1).
   `j` §8.8 and §11.4.1(4) both asked for this; neither wired it.
2. `MAX_OCR_PAGES_PER_DOCUMENT == floor((JOB_PROCESSING_BUDGET_MS/1000 − JOB_FIXED_OVERHEAD_S − AI_STAGE_BUDGET_S) / PROVISIONAL_PER_PAGE_OCR_S)`, floored to the shipped value — catches a hand-edited page cap.
3. `MAX_CONCURRENT_JOBS_GLOBAL == OCR_WORKERS × WORKER_JOB_CONCURRENCY`, and
   `sum(container memory **reservations**) <= 0.85 × host RAM` — **reservations, not limits** (`m`:3589's error).
4. `TRUSTED_PROXY_HOPS` is set and "trust all proxies" is off (`j` §8.5.1 item 4).

**CI tests (the panel's two, kept verbatim in intent):**

- Upload exactly `MAX_UPLOAD_BYTES + 1` bytes → a **branded JSON 413 from the application**, with a
  request id and an application log line. Proves `app ≤ nginx` and that the margin does its job.
- EICAR embedded in a PDF at exactly `MAX_UPLOAD_BYTES` → `QUARANTINED`. Proves
  `cap ≤ clamd StreamMaxLength` **and** `ScanPDF yes` in one test.
- Plus: a rendered-config diff test asserting the nginx and clamd fragments match `limits.yaml`
  (this replaces the panel's `pg_get_constraintdef()` test, which has no target after F2-D7).

---

## 7. Open items

| Tag | Item | Named default that ships if unresolved |
|---|---|---|
| **OWNER-BLOCKED (B-1)** | Authorised model for an OCR virtual key, its real context window, whether the gateway persists prompt/response bodies, and whether any vision alias exists. Unreachable from this session (the gateway runs on a remote production GPU host). | `AI_CONTEXT_CHAR_BUDGET = 20000`, text-only, **no image bytes sent**, AI hard-disabled when `AI_GATEWAY_BASE_URL` is empty. |
| **OWNER-BLOCKED (B-2)** | Commercial tier packaging (the quota numbers in F2-D13). | Every new organisation seeded at **Standard**; the Free tier exists in the schema and is used by no one. |
| **OWNER-BLOCKED (B-3)** | Whether OOXML ingest is enabled at all (`j` §3.3 says defer, `e` §2.4 implements it). F2 sets the limit either way and takes no position. | OOXML **disabled** in M1; `MAX_UPLOAD_BYTES_OOXML` present and unused. |
| **MEASUREMENT (M-1)** | p95 per-page render+OCR wall time, on the production worker container, **under contention**, over the N-dimension Thai corpus. Currently a 90× spread across M0. | `PROVISIONAL_PER_PAGE_OCR_S = 25`; `MAX_OCR_PAGES_PER_DOCUMENT = 50`; regenerate both on landing. |
| **MEASUREMENT (M-2)** | Worker RSS under contention at `RENDER_CONCURRENCY = 2`. Sets whether the global concurrency of 4 is safe on the shared host. | Global 4, worker memory limit 2 GiB, boot assertion 3 as the guard. |
| **Flagged, not arbitrated (out of F2 scope)** | (a) `max_attempts` = 4 (`h` L22) vs 5 (`h`'s own review note) → queue dimension. (b) `rate-limiter-flexible` + **Redis** (`j` §8.5) vs "**Redis rejected for M1**" (`m` O2) → deployment dimension; F2 owns the *values*, not the store. (c) The terminal-state shape for `SUCCEEDED_PARTIAL` (new state vs `SUCCEEDED` + warnings) → data-model dimension; F2 owns only the requirement that a time-budget breach with ≥ 1 completed page is not a failure. (d) `batch_id` column and index → data-model dimension. | — |
| `UNVERIFIED: copy` | Every Thai user-facing string in §5 is drafted here and needs native review. | Ship after review; the error **codes** are the contract and are stable regardless. |

---

## CANONICAL VALUES

**Every value below is owned by this document.** Cite as
`f2-canonical-limits.md §CANONICAL VALUES → <key>`. Do not restate.
Env var prefix and unit-suffix grammar per **F2-D1**. Values marked *derived* are computed by the
generator and asserted at boot; do not hand-edit them.

### Ingest — size

| key | value | env var | reason | failure behaviour |
|---|---|---|---|---|
| `MAX_UPLOAD_BYTES` | `209715200` (200 MiB) | `OCR_LIMIT_MAX_UPLOAD_BYTES` | Only candidate coherent with a page cap (410 KiB/page at 500 pages, inside `j` §8.1's measured 300–800 KB/page); already the value in `g`'s CHECKs and `e`'s constant (F2-D2) | 413 `payload_too_large` from the **app**; nothing written; reservation released |
| `MAX_UPLOAD_BYTES_PDF` | `209715200` | `OCR_LIMIT_MAX_UPLOAD_BYTES_PDF` | PDF is the multi-page type; equals the global cap | 413 `payload_too_large`, app, post-sniff |
| `MAX_UPLOAD_BYTES_TIFF` | `209715200` | `OCR_LIMIT_MAX_UPLOAD_BYTES_TIFF` | Multi-page; bounded by `MAX_PAGES_PER_DOCUMENT` on frames | 413 `payload_too_large`, app, post-sniff |
| `MAX_UPLOAD_BYTES_IMAGE` | `52428800` (50 MiB) | `OCR_LIMIT_MAX_UPLOAD_BYTES_IMAGE` | Admits a lossless PNG of A3@400 DPI (~45 MB); above that the 40 Mpx cap is the correct guard, not the byte cap (F2-D3) | 413 `payload_too_large`, app, post-sniff |
| `MAX_UPLOAD_BYTES_OOXML` | `26214400` (25 MiB) | `OCR_LIMIT_MAX_UPLOAD_BYTES_OOXML` | 20:1 policy ratio against the 500 MiB decompressed ceiling; **OWNER-BLOCKED (B-3)** whether OOXML ships at all | 413 `payload_too_large`, app, post-sniff |
| `NGINX_CLIENT_MAX_BODY_SIZE` | `202m` = `MAX_UPLOAD_BYTES + 2 MiB` — *derived* | rendered into nginx | Margin exists so the **app**, not nginx, produces the error just over the limit (F2-D8) — **not** multipart overhead, which is < 4 KiB | 413 `payload_too_large` from nginx `@too_large` (JSON + security-headers snippet) |
| `CLAMD_STREAM_MAX_LENGTH_BYTES` | `214958080` = `MAX_UPLOAD_BYTES + 5 MiB` — *derived* | rendered into clamd | `MaxFileSize` = same; `MaxScanSize` ≥ same; asserted `> app cap` at boot | scan verdict → `QUARANTINED` document state |
| `MAX_PAGE_RENDER_BYTES` | `20971520` (20 MiB) | `OCR_LIMIT_MAX_PAGE_RENDER_BYTES` | `g` §5.4's derivative cap; bounds one hostile 30,000×30,000 page render | page warning; page skipped, document continues |
| `AI_MAX_REQUEST_BODY_BYTES` | `8388608` (8 MiB) | `OCR_LIMIT_AI_MAX_REQUEST_BODY_BYTES` | `b`'s value; fail fast in the app, never at the gateway | request refused before dispatch; `ai_unavailable` warning |

### Ingest — batch

| key | value | env var | reason | failure behaviour |
|---|---|---|---|---|
| `MAX_FILES_PER_BATCH` | `20` | `OCR_LIMIT_MAX_FILES_PER_BATCH` | Matches `l`'s own UI assumption; keeps the batch-status poll inside the 100-id query cap (F2-D17) | 422 `batch_limit_exceeded` before file 1 |
| `MAX_BATCH_BYTES` | `1073741824` (1 GiB) | `OCR_LIMIT_MAX_BATCH_BYTES` | 20 × ~50 MiB; taken as one quota reservation up front so a batch fails at file 1, not file 17 | 422 `batch_limit_exceeded`; nothing uploaded |
| `MAX_STATUS_IDS_PER_QUERY` | `100` | `OCR_LIMIT_MAX_STATUS_IDS_PER_QUERY` | `l` (:1109), adopted unchanged | 422 `validation_failed` |

### Pages

| key | value | env var | reason | failure behaviour |
|---|---|---|---|---|
| `MAX_PAGES_PER_DOCUMENT` | `500` | `OCR_LIMIT_MAX_PAGES_PER_DOCUMENT` | **Admission** cap, bounded by row fan-out (75–200 MiB of realistic `lines_json` per document) and coherent with the size cap (F2-D4). Applies to PDF pages and TIFF IFDs alike | 422 `page_limit_exceeded` at 501, during `VALIDATING`, from the **actual** page-tree walk — never `/Count` |
| `MAX_OCR_PAGES_PER_DOCUMENT` | `50` — *derived*, **provisional (M-1)** | `OCR_LIMIT_MAX_OCR_PAGES_PER_DOCUMENT` | `floor((1800 − 60 − 300) / 25)` = 57, shipped as 50 with 190 s spare (F2-D4/D6). Native-text pages do **not** consume it; each render tile counts as one page | **200 + warning `render_budget_exhausted`.** Never a rejection. Pages 1–20 first, then user-selected, then ascending; remainder `route=SKIPPED` |
| `SINGLE_IMAGE_MAX_FRAMES` | `1` | `OCR_LIMIT_SINGLE_IMAGE_MAX_FRAMES` | A JPEG/PNG/WebP is one page by definition; supersedes `f`'s 64 and `j`'s `MAX_TIFF_FRAMES = 50` (F2-D9) | 415 `unsupported_media_type` (`reason=animated_image`) |

### Pixels and dimensions

| key | value | env var | reason | failure behaviour |
|---|---|---|---|---|
| `MAX_PAGE_PIXELS` | `40000000` | `OCR_LIMIT_MAX_PAGE_PIXELS` | A4@600 = 34.8 Mpx, A3@400 = 30.9 Mpx, both admitted. **Set `Image.MAX_IMAGE_PIXELS` to this value AND promote `DecompressionBombWarning` to an error — do not also halve the constant (F2-D9)** | DPI reduced in 50-DPI steps → tiled → 422 `pixel_limit_exceeded` only if still unfixable |
| `MAX_PAGE_EDGE_PX` | `20000` | `OCR_LIMIT_MAX_PAGE_EDGE_PX` | Blocks a degenerate 1 × 40,000,000 image that passes the pixel cap and breaks OpenCV/bbox/JPEG (16-bit dimension field). Admits every shape to 10:1 at the pixel cap | 422 `pixel_limit_exceeded` (`reason=edge_ratio`), header read only |
| `MIN_PAGE_PIXELS` | `10000` (100×100) | `OCR_LIMIT_MIN_PAGE_PIXELS` | Below this OCR is meaningless | warning `page_too_small`; page flagged, document continues |
| `MAX_PIXELS_PER_TILE` | `12000000` | `OCR_LIMIT_MAX_PIXELS_PER_TILE` | `e` §5.5; a tile must be smaller than a page or tiling amplifies instead of bounding | tile count exceeded → warning `page_tiling_incomplete` |
| `MAX_TILES_PER_PAGE` | `12` | `OCR_LIMIT_MAX_TILES_PER_PAGE` | `e` §5.5; each tile costs one page of OCR budget | as above |
| `MAX_BITMAP_BYTES_PER_PAGE` | `134217728` (128 MiB) | `OCR_LIMIT_MAX_BITMAP_BYTES_PER_PAGE` | `e`'s corrected value; ≥ `MAX_PAGE_PIXELS × 3` = 120 MB, so the two constants agree on the colour path | 422 `pixel_limit_exceeded` |
| `MAX_TOTAL_RENDER_PIXELS` | `2000000000` = `MAX_OCR_PAGES_PER_DOCUMENT × MAX_PAGE_PIXELS` — *derived* | `OCR_LIMIT_MAX_TOTAL_RENDER_PIXELS` | Replaces `e`'s independent 4 G with a product of two owned caps, so tiling cannot evade it and M-1 regenerates it automatically | job-level backstop → `SUCCEEDED_PARTIAL`, remaining pages `SKIPPED` |
| `RENDER_DPI_DEFAULT` | `300` | `OCR_LIMIT_RENDER_DPI_DEFAULT` | `e` §5.4's default; 8.7 Mpx A4, ≈18 MiB peak greyscale | reduced per page by the F2-D9 ladder, recorded as `dpi_reduced_for_budget` |

### Structural budgets

| key | value | env var | reason | failure behaviour |
|---|---|---|---|---|
| `MAX_ARCHIVE_ENTRIES` | `5000` | `OCR_LIMIT_MAX_ARCHIVE_ENTRIES` | `e` §2.4 | 422 `archive_limit_exceeded`; whole document refused |
| `MAX_ARCHIVE_TOTAL_UNCOMPRESSED_BYTES` | `524288000` (500 MiB) | `OCR_LIMIT_MAX_ARCHIVE_TOTAL_UNCOMPRESSED_BYTES` | **Counted on bytes actually produced by the decompressor** — declared sizes are attacker-controlled (`e` §2.4) | 422 `archive_limit_exceeded` |
| `MAX_ARCHIVE_ENTRY_UNCOMPRESSED_BYTES` | `209715200` | `OCR_LIMIT_MAX_ARCHIVE_ENTRY_UNCOMPRESSED_BYTES` | `e` §2.4 | 422 `archive_limit_exceeded` |
| `MAX_ARCHIVE_COMPRESSION_RATIO` | `200` | `OCR_LIMIT_MAX_ARCHIVE_COMPRESSION_RATIO` | Declared-size **first filter only**; never the binding limit | 422 `archive_limit_exceeded` |
| `MAX_PDF_PAGE_TREE_NODES` | `10000` | `OCR_LIMIT_MAX_PDF_PAGE_TREE_NODES` | `j` §3.4; walk with a visited-set, abort on revisit, **never trust `/Count`** | 422 `document_corrupt` (`reason=pdf_structure_budget`) |
| `MAX_PDF_INDIRECT_OBJECTS` | `500000` | `OCR_LIMIT_MAX_PDF_INDIRECT_OBJECTS` | `j` §3.4 | as above |
| `FILENAME_MAX_CHARS` | `120` | `OCR_LIMIT_FILENAME_MAX_CHARS` | `i` (:2171); bounds the Thai header-size bomb at 120 × 9 = 1,080 bytes | filename truncated after NFC at a grapheme boundary; not an error |

### Text volume

| key | value | env var | reason | failure behaviour |
|---|---|---|---|---|
| `MAX_CHARS_PER_PAGE` | `200000` | `OCR_LIMIT_MAX_CHARS_PER_PAGE` | 60× the 2,500–3,500-char dense Thai A4 (`j` §8.4); only a pathological page reaches it | **200 + warning `text_truncated`**; truncated at a grapheme-cluster boundary after NFC — never mid-cluster |
| `MAX_CHARS_PER_DOCUMENT` | `10000000` | `OCR_LIMIT_MAX_CHARS_PER_DOCUMENT` | 500 pages × 20,000; bounds export size and Thai trigram-GIN growth | **200 + warning `document_text_truncated`** |

### Time

| key | value | env var | reason | failure behaviour |
|---|---|---|---|---|
| `JOB_PROCESSING_BUDGET_MS` | `1800000` (30 min) | `OCR_LIMIT_JOB_PROCESSING_BUDGET_MS` | **Per OCR claim**, reset on every claim (`h` L28). 60 s overhead + 1,440 s page allowance + 300 s safety headroom; AI runs as a separate F3 job and is not charged to this clock | ≥1 page done → **`SUCCEEDED_PARTIAL`**, remainder `SKIPPED`. 0 pages → terminal `BUDGET_EXCEEDED` |
| `JOB_FIXED_OVERHEAD_S` | `60` | `OCR_LIMIT_JOB_FIXED_OVERHEAD_S` | Fetch, sniff, page-tree walk, finalise, result upload | — (input to the derivation) |
| `AI_STAGE_BUDGET_S` | `300` | `OCR_LIMIT_AI_STAGE_BUDGET_S` | Reserved headroom retained in the OCR sizing arithmetic; the AI stage is a separate F3 job and owns its effective budget | AI job stops under F3 policy; OCR result unaffected |
| `JOB_QUEUE_TTL_MS` | `86400000` (24 h) | `OCR_LIMIT_JOB_QUEUE_TTL_MS` | Queue wait is **not** part of the processing budget (`h` L28) | `QUEUE_WAIT_EXCEEDED` — a **capacity** signal that pages an operator, not a processing failure |
| `PROVISIONAL_PER_PAGE_OCR_S` | `25` — **`UNVERIFIED:` / measurement-blocked (M-1)** | `OCR_LIMIT_PROVISIONAL_PER_PAGE_OCR_S` | Conservative of the two same-genre estimates (`j` 12 s, `h` 25 s); under-estimating fails production jobs, over-estimating costs one config change (F2-D5) | not enforced at runtime — a derivation input only |
| `PROVISIONAL_PER_PAGE_OCR_VISION_S` | `200` — **`UNVERIFIED:`** | `OCR_LIMIT_PROVISIONAL_PER_PAGE_OCR_VISION_S` | `h` §13.2; gated behind **OWNER-BLOCKED (B-1)** — the only verified evidence says the deployed model is text-only | as above |
| `PAGE_RENDER_TIMEOUT_S` | `30` | `OCR_LIMIT_PAGE_RENDER_TIMEOUT_S` | `e` §5.5 | page warning `render_timeout`; document continues |
| `PAGE_PARSE_TIMEOUT_S` | `10` | `OCR_LIMIT_PAGE_PARSE_TIMEOUT_S` | `e` §5.5 — parse bombs are not render bombs | page warning `parse_timeout`; document continues |
| `PAGE_OCR_TIMEOUT_S` | `45` | `OCR_LIMIT_PAGE_OCR_TIMEOUT_S` | `h` §13.1; a **ceiling**, must exceed `PROVISIONAL_PER_PAGE_OCR_S` and does, by 1.8× | page warning `ocr_timeout`; document continues |
| `AI_CALL_TIMEOUT_S` | **retired** | — | F3 `ai.timeout.call_ms` is the sole per-call clock. A second timeout would reintroduce the M0 drift this file prevents | F3 classifies the AI failure; OCR result unaffected |
| `UPLOAD_ROUTE_TIMEOUT_MS` | `900000` (15 min) | `OCR_LIMIT_UPLOAD_ROUTE_TIMEOUT_MS` | 200 MiB at a 2 Mbps Thai uplink = 838 s (F2-D8). `j`'s 120 s was derived from a 25 MB cap | 408; staged object unlinked, reservation released |
| `NGINX_CLIENT_BODY_TIMEOUT_S` | `60` | rendered into nginx | **Per-read**, not total — `j` §8.8 misread the directive. This is the slowloris control | connection closed by nginx |
| `NGINX_PROXY_READ_TIMEOUT_UPLOAD_S` | `930` — *derived* (`> UPLOAD_ROUTE_TIMEOUT_MS`) | rendered into nginx | Must exceed the app route or nginx cuts a legitimate upload. **Chat's 600 s vhost is not inherited** | 504 → `@upstream_down` JSON |
| `READ_ROUTE_TIMEOUT_S` · `PATCH_ROUTE_TIMEOUT_S` · `MUTATION_TIMEOUT_S` · `HEALTH_TIMEOUT_S` | `10` · `15` · `30` · `2` | `OCR_LIMIT_READ_ROUTE_TIMEOUT_S` etc. | `j` §8.7, uncontested | 504 / 503 |
| `PG_STATEMENT_TIMEOUT_S` · `PG_IDLE_IN_TX_TIMEOUT_S` | `10` · `30` | set on the app role | `j` §8.7; set on the role, not per query. Migrations use a different role | query aborted |
| `CLAMD_MAX_SCAN_TIME_MS` | `180000` | rendered into clamd (**worker-side**) | Scanning 200 MiB needs more than `j`'s 60 s — which is why scanning moved off the HTTP path (F2-D3) | document `SCAN_FAILED`, retried on the job path |

### Concurrency

| key | value | env var | reason | failure behaviour |
|---|---|---|---|---|
| `MAX_CONCURRENT_JOBS_GLOBAL` | `4` = `OCR_WORKERS × WORKER_JOB_CONCURRENCY` — *derived*, **provisional (M-2)** | `OCR_LIMIT_MAX_CONCURRENT_JOBS_GLOBAL` | `j`'s "pool 4" and `m`'s "replicas 2" measured different things (F2-D12) | boot assertion fails readiness on mismatch, or if reservations exceed 0.85 × host RAM |
| `WORKER_JOB_CONCURRENCY` | `2` | `OCR_LIMIT_WORKER_JOB_CONCURRENCY` | With `OCR_WORKERS=2` (`m`), gives `j`'s pool of 4 | — |
| `MAX_CONCURRENT_JOBS_PER_USER` | `2` | `OCR_LIMIT_MAX_CONCURRENT_JOBS_PER_USER` | 2 of 4 leaves 2 slots for everyone else; 3 would let one tenant hold 75 % (`j` §8.6). Enterprise gets a **dedicated pool**, never a raised shared cap | not an error — the job waits; UI shows "รอคิว" |
| `MAX_QUEUED_DOCS_PER_USER` | `25` | `OCR_LIMIT_MAX_QUEUED_DOCS_PER_USER` | `j` §8.6; stops a backlog that looks like acceptance but is a four-hour wait | 429 `queue_full` with `Retry-After` |
| `MAX_INFLIGHT_UPLOADS_PER_USER` | `2` | `OCR_LIMIT_MAX_INFLIGHT_UPLOADS_PER_USER` | `j`'s 3 was sized as 3 × 25 MB; at 200 MiB the arithmetic no longer defends anything (F2-D12) | 429 `too_many_uploads` |
| `MAX_INFLIGHT_UPLOADS_GLOBAL` | `8` | `OCR_LIMIT_MAX_INFLIGHT_UPLOADS_GLOBAL` | Makes the nginx body-temp volume finite: 8 × 202 MiB ≈ 1.6 GiB → provision 4 GiB | 429 `too_many_uploads` (global backstop) |
| `MAX_INFLIGHT_AI_CALLS_PER_TENANT` | `2` | `OCR_LIMIT_MAX_INFLIGHT_AI_CALLS_PER_TENANT` | The shared GPU is the scarcest resource (`j` §6.3/§8.6) | call queued behind the AI stage budget |
| `RENDER_CONCURRENCY` | `2` | `OCR_LIMIT_RENDER_CONCURRENCY` | Per worker process (`e` §5.5); 400 dpi RGB at 4 concurrent renders is 390 MiB in bitmaps alone | — |
| `DB_POOL_PER_APP_INSTANCE` | `10` | `OCR_LIMIT_DB_POOL_PER_APP_INSTANCE` | `j` §8.6; must stay under `max_connections` with room for migrations and psql | 503 `service_unavailable` |
| `WORKER_MEMORY_LIMIT_BYTES` | `2147483648` (2 GiB) | rendered into compose | `j`'s derivation from the 40 Mpx cap (160 MB RGBA × 2.2 copies ≈ 350 MB peak, plus model and runtime). Resolves the 2 GB/3 GB conflict | container OOM kills one job, not the worker pool |

### Quotas (defaults seeded into `tenant_quotas`; per-org overrides are rows, not env vars)

| key | value | env var | reason | failure behaviour |
|---|---|---|---|---|
| `DEFAULT_TIER` | `standard` | `OCR_LIMIT_DEFAULT_TIER` | Private operator-run platform, not self-serve. **OWNER-BLOCKED (B-2)** | — |
| `DEFAULT_STORAGE_QUOTA_BYTES` | `16106127360` (15 GiB) | `OCR_LIMIT_DEFAULT_STORAGE_QUOTA_BYTES` | `j` §8.4 Standard | **507 `storage_quota_exceeded`**, refused atomically in `i` §4.5 phase 1 **before any byte is written** |
| `DEFAULT_DOCS_PER_MONTH` · `_PER_DAY` | `500` · `100` | `OCR_LIMIT_DEFAULT_DOCS_PER_MONTH` / `_PER_DAY` | `j` §8.4; the daily value is the mandatory 20 % sub-cap | 429 `quota_exceeded` + `Retry-After` |
| `DEFAULT_PAGES_PER_MONTH` · `_PER_DAY` | `5000` · `1000` | `OCR_LIMIT_DEFAULT_PAGES_PER_MONTH` / `_PER_DAY` | `j` §8.4; pages, not documents, are the cost driver | 429 `quota_exceeded` |
| `DEFAULT_UPLOAD_BYTES_PER_MONTH` | `5368709120` (5 GiB) | `OCR_LIMIT_DEFAULT_UPLOAD_BYTES_PER_MONTH` | `j` §8.4 | 429 `quota_exceeded` |
| `DEFAULT_AI_TOKENS_PER_MONTH` · `_PER_DAY` | `25000000` · `5000000` | `OCR_LIMIT_DEFAULT_AI_TOKENS_PER_MONTH` / `_PER_DAY` | `j` §8.4's total survives re-derivation on the **verified** 1 token/char Thai ratio at 4,300 tokens/page (F2-D13) — though `j`'s published premise (2 chars/token) does not | checked **before each chunk**; document degrades to `ai_quota_exhausted` partial, never overshoots |
| `FREE_TIER_MAX_UPLOAD_BYTES` | `26214400` (25 MiB) | seeded row | `j`'s 25 MB relocated to where a number that small belongs (panel :618) | 413 `payload_too_large` |
| `QUOTA_CHECK_ORDERING` | before the storage PUT **and** before each AI call; decrement in the **same transaction** as the usage row | — | *"A check-after-work quota is a quota that has already been exceeded"* (`j` §8.4) | — |

### AI context

| key | value | env var | reason | failure behaviour |
|---|---|---|---|---|
| `AI_CONTEXT_CHAR_BUDGET` | `20000` | `OCR_LIMIT_AI_CONTEXT_CHAR_BUDGET` | Adopted verbatim from Chat's verified `CHAT_CONTEXT_CHAR_BUDGET`. 20,000 Thai chars ≈ 20,100 tokens; +schema +output ≈ 25,200 = 38 % of the verified 65,536 ceiling. Chat chose it to bound prefill cost and KV-cache pressure **on the host we share** (F2-D14) | chunked; no error |
| `AI_MAX_OUTPUT_TOKENS` | `4096` | `OCR_LIMIT_AI_MAX_OUTPUT_TOKENS` | Bounds a structured-extraction JSON and leaves room for one repair retry | truncated output → repair retry → `ai_parse_failed` warning |
| `AI_MAX_CHUNKS_PER_DOCUMENT` | `60` | `OCR_LIMIT_AI_MAX_CHUNKS_PER_DOCUMENT` | 1.2 M chars ≈ 1.5 M tokens = 6 % of the Standard monthly tier, so one document cannot exhaust a month | **200 + warning `ai_context_truncated`**; deterministic OCR output remains complete |
| `AI_READINESS_COUPLING` | **none** | — | Mirrors Chat: LiteLLM is **not** part of readiness. `AI_GATEWAY_BASE_URL` empty ⇒ AI hard-disabled, OCR unaffected (`m` §2.2) | warning `ai_unavailable`; never a 5xx, never a failed readiness probe |

### Rate limits (`j` §8.5 adopted unchanged — F2-D18)

| key | value | env var | reason | failure behaviour |
|---|---|---|---|---|
| `RATE_UPLOAD_BROWSER` | `10/min/user`, burst `20` | `OCR_LIMIT_RATE_UPLOAD_BROWSER` | The real throttle is `MAX_INFLIGHT_UPLOADS_PER_USER`, not the request rate | 429 `rate_limited` + `Retry-After` |
| `RATE_UPLOAD_API` | `60/min/key`, burst `120`; **and** `600/hour/key` | `OCR_LIMIT_RATE_UPLOAD_API` / `_HOURLY` | 1 rps sustained; the hourly bucket catches what a fast-bucket-only limiter misses | 429 `rate_limited` |
| `RATE_READ` | `120/min/user`, burst `240` | `OCR_LIMIT_RATE_READ` | A 2 s status poll × a few tabs | 429 `rate_limited` |
| `RATE_PATCH` | `60/min/user`, burst `120` | `OCR_LIMIT_RATE_PATCH` | Faster than a human corrects; slow enough to make scripted mass-rewrite obvious | 429 `rate_limited` |
| `RATE_AUTH` | `5/min/IP`, burst `10`; **and** `20/hour/IP`, `10/hour/account` | `OCR_LIMIT_RATE_AUTH` | The credential-stuffing control — **fictional without `TRUSTED_PROXY_HOPS`** | 429 `rate_limited` |
| `RATE_CSP_REPORT` | `30/min/IP`, burst `60`; body ≤ `8192` bytes | `OCR_LIMIT_RATE_CSP_REPORT` | An uncapped report endpoint is a free DoS amplifier; contents are never logged verbatim | 429 / 413 |
| `RATE_GLOBAL_PER_IP` | `300/min`, burst `600`; `limit_conn perip 20` | `OCR_LIMIT_RATE_GLOBAL_PER_IP` | nginx backstop for any route added later without its own limit. Generous, because Thai CGNAT shares addresses | 429 via nginx `@rate_limited` |
| `TRUSTED_PROXY_HOPS` | `1` | `OCR_LIMIT_TRUSTED_PROXY_HOPS` | Client IP = the *n*-th value **from the right** of `X-Forwarded-For`; nginx **assigns** `X-Forwarded-For $remote_addr` and strips the other forwarding headers. Without this, six limits above are bypassed by one request header | boot assertion fails readiness if unset |
| `MAX_EXPORT_ROWS` · `MAX_EXPORT_CELLS` | `50000` · `1000000` | `OCR_LIMIT_MAX_EXPORT_ROWS` / `_CELLS` | `l` L-16 / §10.4, uncontested | 413 `export_too_large`, naming CSV and NDJSON as the alternatives |

### Schema constraints that survive (F2-D7)

| key | value | env var | reason | failure behaviour |
|---|---|---|---|---|
| `CHECK_documents_size_positive` | `CHECK (size_bytes > 0)` | — (migration `0009`) | Immutable: a zero-byte document is corrupt. **Replaces `BETWEEN 1 AND 209715200`** | 23514 → 500; an application bug, never a user-facing limit |
| `CHECK_storage_objects_size_nonneg` | `CHECK (size_bytes >= 0)` | — | Immutable; an empty derivative is legal. **Replaces `BETWEEN 0 AND 209715200`** | 23514 → 500 |
| `CHECK_documents_page_count_positive` | `CHECK (page_count IS NULL OR page_count >= 1)` | — | Immutable. **Replaces `BETWEEN 1 AND 2000`** | 23514 → 500 |
| `TUNABLE_LIMITS_IN_SCHEMA` | **none** | — | Owner rule. A `CHECK` on a tunable turns a config change into an `ACCESS EXCLUSIVE` lock plus a full scan of an unbounded table — and **fails outright** when lowering a limit against existing rows (F2-D7) | — |
| `GRANDFATHERING` | nightly gauge `documents_above_current_limits` | — | Removing the DB bound means lowering a limit leaves pre-existing rows above it. They stay readable and exportable, not re-processable | operator sees the population before lowering anything |
