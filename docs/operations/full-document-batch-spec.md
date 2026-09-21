# Full-document OCR, batch upload and table UI — implementation contract

Status: approved direction (user spec 2026-09-21, continued from Codex). This file is the single
contract every implementer codes against. If a detail here is wrong, stop and report instead of
silently diverging — other components depend on the same names.

Working repo: `/tmp/ocr-push`, branch `feature/full-document-batch` (production snapshot `845a053`
merged with `origin/main`). Commands (from repo root, local Node 22 / pnpm 12):

```
pnpm --config.engine-strict=false typecheck
pnpm --config.engine-strict=false lint
pnpm --config.engine-strict=false test
```

Existing production behaviour that MUST survive: queue SECURITY DEFINER model (`ocr_queue_definer`),
tenant RLS on every table (`app.current_org`), worker heartbeat, ClamAV `zPING` readiness,
`/api/web-token` server-side auto-auth (`OCR_WEB_AUTO_AUTH`), therapistName→therapist provider mapping,
migration 0016 grants, Prometheus config, the legacy single-field confirm endpoint.

---

## 1. Local AI response — schema v3 (`local-ai/`, served at `POST /v1/ocr`)

Engine `typhoon-sections`, version `3.0`. Backward compatible with v2.2 clients: `staffOnly.treatment`,
`staffOnly.therapistName`, `staffOnly.roomNo`, `evidence.staffCropRaw` keep their v2.2 shapes.

```jsonc
{
  "documentId": "uuid",                 // Local AI id, used by /v1/ocr/confirm
  "sourceFile": "a.png",
  "engine": "typhoon-sections",
  "version": "3.0",
  "schemaVersion": 3,
  "layout": { "template": "makkha-intake-v1", "imageWidth": 805, "imageHeight": 569,
              "scaleX": 1.0, "scaleY": 1.0, "aspectMatch": true, "warnings": [] },
  "customerInformation": {
    "name": Field, "gender": Field, "nationality": Field, "hotelName": Field,
    "referralSources": [CheckField], "healthConditions": [CheckField]
  },
  "recommendationCard": {
    "pressure": Field, "massageOilScrub": [CheckField],
    "preferredAreas": [CheckField], "avoidAreas": [CheckField]
  },
  "staffOnly": {
    "treatments": [TreatmentField],
    "treatment": { "raw": "...", "durations": ["90 นาที"], "items": [TreatmentField], "needsReview": false }, // legacy v2.2
    "therapistName": Field,
    "roomNo": Field
  },
  "evidence": { "staffCropRaw": "...", "customerCropRaw": "...", "checkboxScores": { "gender.female": 0.31 } },
  "timings": { "preprocessMs": 12, "checkboxMs": 8, "inferenceMs": 2900, "inferenceWallMs": 1600,
               "normalizeMs": 2, "totalMs": 1650,
               "sections": [ { "name": "staffOnly", "ms": 1500 }, { "name": "customerInformation", "ms": 1400 } ] },
  "needsReview": true
}
```

- `Field` = `{ raw: string|null, value: string|null, confidence: number /*0..1*/, source: Source, needsReview: boolean }`
- `CheckField` = `Field` + `{ checked: true }` — arrays contain only checked (or ambiguous → `needsReview:true`) boxes; `raw`/`value` = the printed English label (e.g. `"Menstruation"`).
- `TreatmentField` = `Field` + `{ nameRaw: string|null, duration: string|null, durationMinutes: number|null }`
  - `raw` = whole segment (`"ไทย 90 นาที"`), `nameRaw` = service text used for matching and verified memory (`"ไทย"`), `value` = master name (`"นวดไทย"`).
- `Source` ∈ `ocr | checkbox | ink-mark | rule | master-fuzzy | verified-memory | none | human`.
- Empty but confidently blank field: `{raw:null, value:null, confidence:≥0.9, source:"ink-mark", needsReview:false}`.
- Confirm API unchanged: `POST /v1/ocr/confirm {documentId, field: "treatment"|"therapist", raw, verifiedValue}`.
  Verified memory lookup for treatments tries `nameRaw` first, then `raw`.

## 2. Canonical structured result stored by the app (`documents.structured_result`)

The app never stores evidence/timings in `structured_result` (they stay in `raw_response`).

```jsonc
{ "schemaVersion": 3,
  "customerInformation": { ... as above ... },     // {} when absent
  "recommendationCard":  { ... },                   // {} when absent
  "staffOnly": { "treatments": [TreatmentField], "therapistName": Field, "roomNo": Field } }
```

Legacy rows already in production are flat v2.2 staff results
(`{treatment:{raw,durations,items,needsReview}, therapistName, roomNo}`) or whole v2.2 responses
(`{documentId, staffOnly:{treatment,...}}`). `normalizeStructuredResult(value)` converts any of these
to the canonical shape (legacy `treatment.items` → `staffOnly.treatments`). Every read path
(list, review GET, review save, legacy confirm) goes through it.

## 3. Database — migration `prisma/migrations/0017_batch_processing/migration.sql`

Runs as `ocr_migrator` inside one transaction (see `packages/db-runtime`). Must NOT `CREATE OR REPLACE`
any queue/outbox function (production owner is `ocr_queue_definer`; migrator is not owner → failure).

```sql
CREATE TABLE IF NOT EXISTS ocr_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  created_by varchar(255) NOT NULL,
  label varchar(200),
  expected_total integer NOT NULL CHECK (expected_total BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id)
);
ALTER TABLE ocr_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE ocr_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY batch_scope ON ocr_batches USING (organization_id::text = current_setting('app.current_org', true));

ALTER TABLE documents ADD COLUMN IF NOT EXISTS batch_id uuid;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS reviewed_by varchar(255);
-- composite FK keeps a document and its batch in the same tenant (MATCH SIMPLE: NULL batch_id allowed)
ALTER TABLE documents ADD CONSTRAINT documents_batch_fk FOREIGN KEY (batch_id, organization_id) REFERENCES ocr_batches(id, organization_id);
CREATE INDEX IF NOT EXISTS documents_org_batch_idx   ON documents(organization_id, batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS documents_org_created_idx ON documents(organization_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS documents_org_status_idx  ON documents(organization_id, status);

GRANT SELECT, INSERT ON ocr_batches TO ocr_app;
GRANT REFERENCES ON ocr_batches TO ocr_app, ocr_worker;
```

Batch counters are derived from document rows on read (no stored counters → nothing to drift or repair).
Status buckets: `VALIDATING|SCANNING|CLEAN → queued`, `PROCESSING → processing`, `SUCCEEDED → succeeded`,
`NEEDS_REVIEW → needsReview`, `FAILED|QUARANTINED → failed`, `DELETED` excluded.
`confirmed` = rows with `reviewed_at IS NOT NULL` (a subset of succeeded).

Provisioning (`deploy/provision-roles.sh`, bootstrap/superuser section): also record the production-only
manual fix for the confirm outbox — `GRANT SELECT, UPDATE ON ocr_confirm_outbox TO ocr_queue_definer`,
`ALTER FUNCTION ocr_claim_confirm_outbox_v1(text,timestamptz) / ocr_finish_confirm_outbox_v1(uuid,text,boolean,text,timestamptz) / ocr_recover_confirm_outbox_v1(timestamptz) OWNER TO ocr_queue_definer`,
`REVOKE ALL … FROM PUBLIC`, `GRANT EXECUTE … TO ocr_worker`. Idempotent.

## 4. Persistence — `packages/ocr-persistence`

New pure module `src/document-view.ts` (re-exported from `src/index.ts`):

```ts
export type DocumentView = { schemaVersion: 3; customerInformation: Record<string, unknown>;
  recommendationCard: Record<string, unknown>; staffOnly: Record<string, unknown> };
export function normalizeStructuredResult(value: unknown): DocumentView;       // §2, never throws
export function toStructuredResult(response: OcrResponse): DocumentView;       // from Local AI response
export type DocumentSummary = { customerName: string|null; gender: string|null; nationality: string|null;
  treatments: Array<{ name: string|null; duration: string|null }>; therapist: string|null; room: string|null;
  minConfidence: number|null; reviewFieldCount: number };
export function summarizeDocument(view: DocumentView): DocumentSummary;
export type ReviewChange = { path: string /* e.g. "customerInformation.name", "staffOnly.treatments[1]" */;
  oldRaw: string|null; oldValue: string|null; newValue: string|null;
  provider?: { field: "treatment"|"therapist"; raw: string; verifiedValue: string } };
export function applyReviewEdits(current: DocumentView, edited: unknown): { merged: DocumentView; changes: ReviewChange[] };
```

`applyReviewEdits` rules: only `value` and `duration` leaves are editable, plus adding/removing items of
known arrays (`staffOnly.treatments`, `customerInformation.referralSources|healthConditions`,
`recommendationCard.massageOilScrub|preferredAreas|avoidAreas`). All other keys come from `current`
(raw/confidence/source preserved; unknown keys preserved). Values are strings ≤ 500 chars (else
`REVIEW_INVALID`), at most 50 items per array. After merge every field gets `needsReview:false`; changed
fields get `source:"human"` and keep `raw`. Added array items get `raw:null, source:"human"`.
`provider` is set for treatment items (`field:"treatment"`, `raw = nameRaw ?? raw`) and
`staffOnly.therapistName` (`field:"therapist"`) when the value changed OR the field had `needsReview:true`,
and both raw and new value are non-empty.
`hasReviewFields` stays and is applied to the canonical view.

`PostgresOcrDocumentStore` additions (every method: own transaction + `set_config('app.current_org',…)`):

```ts
type BatchSummary = { batchId: string; label: string|null; createdAt: string; expectedTotal: number;
  uploaded: number; queued: number; processing: number; succeeded: number; needsReview: number;
  failed: number; confirmed: number; completed: number /* succeeded+needsReview+failed */;
  finishedAt: string|null /* max(processed_at) once completed===expectedTotal */;
  durationMs: number|null; throughputPerMinute: number|null };
createBatch(tenantId, { createdBy, expectedTotal, label? }): Promise<BatchSummary>
getBatch(tenantId, batchId): Promise<BatchSummary|null>
listBatches(tenantId, limit = 20): Promise<BatchSummary[]>
// createUploadedDocument input gains optional batchId; throws BATCH_NOT_FOUND (not in tenant) or
// BATCH_FULL (uploaded >= expected_total; small concurrent overshoot is acceptable, documented)
type DocumentListItem = { documentId: string; batchId: string|null; filename: string; mimeType: string;
  status: string; statusCategory: "queued"|"processing"|"review"|"succeeded"|"confirmed"|"failed";
  needsReview: boolean; errorMessage: string|null; createdAt: string; processedAt: string|null;
  reviewedAt: string|null; deliveryStatus: DeliveryStatus; summary: DocumentSummary };
type DeliveryStatus = "NONE"|"PENDING"|"DELIVERED"|"RETRYING"|"FAILED"; // derived from ocr_confirm_outbox rows of the document
listDocuments(tenantId, { limit /*1..200, default 50*/, offset, status?: statusCategory, q?: string, batchId?: string }):
  Promise<{ total: number; documents: DocumentListItem[] }>
// q: case-insensitive match on filename, customerInformation.name.value, staffOnly.therapistName.value (escape % _ \)
retryDocument(tenantId, documentId): Promise<{ jobId: string }>
// lock document FOR UPDATE; only status FAILED is retryable (else DOCUMENT_NOT_RETRYABLE; missing → DOCUMENT_NOT_FOUND);
// set status CLEAN, error_message NULL; INSERT a new extraction_jobs row for the latest run (ocr_app has INSERT + SELECT(id,…))
saveReview(tenantId, documentId, { structuredResult: unknown; reviewedBy: string; expectedUpdatedAt?: string }):
  Promise<{ corrections: number; delivery: "PENDING"|"NOT_REQUIRED"; document: ReviewDocument }>
// lock row; status must be NEEDS_REVIEW or SUCCEEDED (else DOCUMENT_NOT_REVIEWABLE); expectedUpdatedAt mismatch → REVIEW_CONFLICT;
// applyReviewEdits; UPDATE structured_result, needs_review=false, status='SUCCEEDED', reviewed_at=now(), reviewed_by,
// confirm_status = PENDING (provider changes) | NULL, updated_at=now();
// one ocr_corrections row per change (field = path, old_raw, normalized_value = oldValue, verified_value = newValue ?? '',
// confirm_status 'PENDING' for provider changes else 'NOT_REQUIRED'; ON CONFLICT (organization_id, document_id, field, verified_value) DO UPDATE);
// one ocr_confirm_outbox row per provider change, payload {documentId: ocr_document_id, field, raw, verifiedValue}
// (delivery is asynchronous through the worker's outbox dispatcher; no synchronous Local AI call)
markRetrying(tenantId, documentId, message): Promise<void>   // status CLEAN, error_message 'RETRYING: …'
```

`getReviewDocument` keeps its fields and adds `batchId, reviewedAt, reviewedBy, updatedAt, errorMessage,
createdAt, processedAt, deliveryStatus`; its `structuredResult` is the canonical view.
Legacy `saveCorrection(…, field, …)` becomes path-aware: when the stored result has `staffOnly`,
`therapistName|roomNo` resolve to `staffOnly.<field>`; otherwise top-level (old flat rows).

`packages/queue/src/postgres.ts`: add `finishDetailed(jobId, leaseToken, outcome, error?) →
{ accepted: boolean; finalStatus: "PENDING"|"SUCCEEDED"|"FAILED"|"DEAD"|null }` using the `final_status`
column already returned by `ocr_finish_retry_v1`. Keep `finish()`.

## 5. HTTP API — `apps/ocr-web/src/server.ts`

All `/api/*` routes except `/api/web-token` authenticate with the Bearer JWT (`principalFor`); tenant is
always `principal.tenantId` (headers such as `x-tenant-id` are ignored). Error body `{ error: CODE }`.
Status mapping: auth errors 401; `*_NOT_FOUND` 404; `BATCH_FULL`, `IDEMPOTENCY_CONFLICT`,
`DOCUMENT_NOT_RETRYABLE`, `DOCUMENT_NOT_REVIEWABLE`, `REVIEW_CONFLICT` 409; `PAYLOAD_TOO_LARGE` 413;
`UNSUPPORTED_MEDIA_TYPE` 415; other validation 400.

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/` | – | workbench HTML (`workbench.ts`), CSP with per-response script nonce |
| GET | `/review/:id` | – | 302 → `/?document=:id` (the old page prompted for a token) |
| GET | `/api/web-token` | – | unchanged |
| POST | `/api/batches` | `{ total: 1..500, label?: string≤200 }` | 201 `BatchSummary` |
| GET | `/api/batches` | `?limit` | 200 `{ batches: BatchSummary[] }` |
| GET | `/api/batches/:id` | – | 200 `BatchSummary` / 404 |
| POST | `/api/documents` | raw body (existing) + optional `X-Batch-Id: <uuid>`; `X-Upload-Filename-Encoding: uri` ⇒ filename is `encodeURIComponent`-encoded | 202 (existing shape + `batchId`) |
| GET | `/api/documents` | `?limit&offset&status&q&batchId` | 200 `{ total, limit, offset, documents: DocumentListItem[] }` |
| GET | `/api/documents/:id/ocr` | – | 200 `{ document: ReviewDocument }` (extended) |
| GET | `/api/documents/:id/content` | – | original bytes (existing) |
| POST | `/api/documents/:id/ocr/review` | `{ structuredResult, expectedUpdatedAt? }` (≤1 MiB) | 200 `{ status:"confirmed", delivery, corrections, document }` |
| POST | `/api/documents/:id/retry` | – | 202 `{ status:"queued", jobId }` |
| POST | `/api/documents/:id/ocr/confirm` | legacy single field | unchanged behaviour, path-aware |

Invalid UUIDs in path/query → 404 (`DOCUMENT_NOT_FOUND`/`BATCH_NOT_FOUND`) without hitting SQL casts.
HTML responses add `x-content-type-options: nosniff`, `referrer-policy: no-referrer`,
`content-security-policy` with `frame-ancestors 'none'`, `img-src 'self' blob: data:`,
`frame-src 'self' blob:`, `script-src 'nonce-…'`, fonts only from Google Fonts.

## 6. Worker — `services/ocr-worker`

- `processOcrJob`: `structuredResult = toStructuredResult(result)`, `needsReview = hasReviewFields(structuredResult)`,
  `rawResponse = result` (keeps evidence/timings). Log and record metrics `ocr_inference_ms_sum`
  (from `result.timings.inferenceMs` when present), `document_processing_ms_sum`, `documents_processed_total{status}`.
- On failure: non-retryable `OcrClientError` (4xx) → finish `DEAD`; otherwise `finishDetailed(FAILED)`;
  if `finalStatus === "PENDING"` → `store.markRetrying`, else `store.markFailure`. Lost lease (`accepted:false`) → do not touch the document.
- Concurrency: `OCR_WORKER_CONCURRENCY` (1..8, default 2) independent job loops; one maintenance loop
  (every 1 s: `queue.recoverExpired`, `outbox.recoverExpired`, drain up to 10 outbox items). Every loop
  catches and logs errors with backoff (an exception must never kill a loop). Heartbeat unchanged (30 s).
- Outbox sender keeps `therapistName → therapist` mapping (new payloads already use `therapist`).

## 7. UI — `apps/ocr-web/src/workbench.ts`

Evolve Codex's dependency-free draft. Visual language follows the repository owner's Vercel light taste
(CLAUDE.md "Design Taste — Vercel"): canvas `#FAFAFA`, cards `#FFFFFF` with the triple-ring shadow,
pure-neutral gray text ramp `#171717/#4D4D4D/#666666/#7D7D7D/#A8A8A8`, primary action = solid black
pill `#171717` with white text, pills = clickable / 8px rectangles = surfaces, color only for meaning
(status: failed `#E5484D` tint, needs-review yellow tint, confirmed teal tint, succeeded blue `#52AEFF` tint;
always paired with a text label), Geist + Geist Mono with Thai fallback (Noto Sans Thai / IBM Plex Sans Thai),
display tracking −0.04em, body 14px, inputs ≥16px, 150 ms motion, `prefers-reduced-motion`, visible
`:focus-visible` rings. Thai UI copy.

Behaviour: header with connection status (auto-auth via `/api/web-token`, token kept in memory only);
multi-file picker + drag/drop (≤100 files per selection, accept PNG/JPEG/WebP/PDF); `POST /api/batches`
then per-file raw uploads (3 concurrent, XHR progress, `X-Batch-Id`, URI-encoded filename, per-file
Idempotency-Key, per-file retry; one failure never blocks siblings); batch summary strip (total, queued,
processing, succeeded, needs review, failed, confirmed, elapsed, docs/min) from `GET /api/batches/:id`,
restored after reload from `GET /api/batches?limit=1`; server-side search + status filter + batch
filter + pagination against `GET /api/documents`; table columns File, Customer, Gender, Nationality,
Treatment (all treatments, one per line), Duration, Therapist, Room, Status, Confidence (min %, `—` if none),
Actions (Review/Edit, Retry for failed); rows needing review highlighted; `—` for missing values;
review drawer (`<dialog>`): original preview (image/PDF, zoom), grouped editor for customer /
recommendation / staff sections, needsReview fields highlighted with raw OCR text shown, repeatable
treatment items (add/remove), checkbox arrays editable as lists, “บันทึกและยืนยัน” posts the full edited
`structuredResult` with `expectedUpdatedAt`, shows delivery state, conflicts keep the draft; optional
raw JSON (`rawResponse`) in a collapsed details block; open drawer from `?document=<id>`; polling every
3 s while work is active, 15 s otherwise, paused when the tab is hidden, never overwriting a dirty draft.
All OCR text enters the DOM via `textContent`.

## 8. Tests (must be added)

TS (node:test): document-view normalization of v3 / legacy flat / legacy response; summary; applyReviewEdits
(value edits, add/remove treatments, provider mapping incl. therapistName→therapist, unknown-key preservation,
oversize rejection); server routes with fake store (auth 401, tenant from token only, batch create/get/list,
list query validation, review 200/409/400, retry 202/409, legacy confirm still works, `/` has no token prompt
and sets CSP); worker (full-document result → NEEDS_REVIEW, non-retryable → DEAD, retrying → markRetrying,
heartbeat interval cleared); ingest filename URI decoding; migration SQL assertions (RLS forced on ocr_batches,
no function redefinition). DB integration tests (`test/db/*.test.ts`) run only when
`OCR_TEST_DATABASE_URL_BOOTSTRAP` is set: provision roles like production (incl. `ocr_queue_definer`
ownership), apply all migrations as `ocr_migrator`, then as `ocr_app`/`ocr_worker`/`ocr_queue` verify batch
creation, partial failures, tenant isolation (tenant B cannot see/modify tenant A's batch/documents),
retry, review save + outbox rows, queue claim/heartbeat/recovery.
Python (pytest, python:3.11-slim container): full-document response shape, checkbox detection on
`sample2.png` (Female, Menstruation, Standard pressure), multiple treatments + duration matching,
therapist verified-memory correction, legacy fields present, confirm field validation.
