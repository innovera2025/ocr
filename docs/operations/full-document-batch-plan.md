# Full-document OCR and batch processing plan

## Inspection result

The application repository already has the production path for upload, ClamAV, PostgreSQL, the persistent extraction queue, the OCR worker, review persistence, correction audit, and the confirm outbox. The current client contract and persistence helpers are staff-only oriented: `OcrResponse` exposes `staffOnly`, `hasReviewFields` walks only that object, and the review page is a single-document view. Upload ingestion accepts one raw body per request. No batch entity or batch progress endpoint was found.

The public Local AI endpoint was checked over HTTPS. It is healthy and returns `engine: typhoon-crop-only`, `version: 2.2`, with `staffOnly` and `evidence.staffCropRaw`; it does not currently return customer information or recommendation-card fields. SSH inspection of `/opt/innovera-ocr` and `/opt/innovera-ocr-app/ocr` is still blocked because both VPSs reject the available root credentials. The server-side changes below therefore must be applied only after operator SSH access is provided; no OCR response is being fabricated in the application.

## Implementation sequence

1. **Local AI contract (backward compatible):** extend the OCR response with `customerInformation`, `recommendationCard`, and a richer `staffOnly.treatments[]`. Every field keeps `raw`, `value`/`items`, `confidence`, `source`, and `needsReview`; retain `staffOnly.treatment` while clients migrate. Add section crops only where they improve handwriting and checkbox recognition. Keep verified-memory normalization and map `therapistName` to provider field `therapist` for confirmation.
2. **Application contract:** update `@innovera/ocr-client` types and response validation without making existing staff-only responses invalid. Make review-field traversal recursive/section-aware and store the complete response in the existing JSONB columns. Preserve raw evidence and existing RLS.
3. **Batch persistence:** add a migration only after confirming the deployed schema names. The expected shape is `ocr_batches` (`id`, `organization_id`, `created_by`, `total`, counters, timestamps) with tenant RLS and `documents.batch_id` (or an equivalent join table). Existing document/run/job rows remain the unit of work. A batch upload creates one document/run/job per file in one transaction and returns a batch id; one file failure changes only that document and its counter.
4. **Batch API:** add authenticated multipart batch upload, batch progress, document list/search/filter, retry-failed, and review/confirm endpoints by reusing current auth, storage, queue, and persistence services. Never process files synchronously in the request. Enforce tenant scope on every query and correction.
5. **Worker:** keep the current DB claim/lease model. Process each document independently, persist the complete OCR response, derive `NEEDS_REVIEW` from all sections, and update batch counters transactionally with the document result. Measure inference and total document duration.
6. **Table UI:** replace the raw JSON-first page with a tenant-authenticated table. Columns are file, customer, gender, nationality, treatment/duration, therapist, room, status, confidence, and actions. Add multi-select/drag-drop upload, progress counters, search, status filtering, review highlighting, original preview, edit/confirm, retry, and optional raw JSON details. Use the existing server-side auth flow; do not ask the browser for a JWT.
7. **Verification:** add contract tests for sections, checkboxes, multiple treatments and duration matching; batch tests for atomic creation and partial failures; auth/RLS and provider mapping tests; then run an authenticated production-like E2E with a real sample document after the Local AI deployment has been updated.

## Files expected to change

- `packages/ocr-client/src/index.ts` and tests: full-document response types and validation.
- `packages/ocr-persistence/src/index.ts` and tests: section-aware review mapping, batch persistence, counters, and tenant checks.
- `packages/ingest/src/http.ts` and `apps/ocr-web/src/server.ts`: multipart batch endpoint, progress/list/retry APIs, and server-side auth wiring.
- `services/ocr-worker/src/index.ts` and tests: complete-response mapping and batch counter updates.
- `apps/ocr-web` review assets/server tests: table UI and correction workflow.
- `prisma/migrations/<timestamp>_batch_processing/migration.sql` (or the repository's existing migration format): only the confirmed batch schema/RLS changes.
- Local AI repository `/opt/innovera-ocr`: section extraction, response schema, and OCR tests; this cannot be edited until SSH access is available.

## Migration rules

Do not manually patch production. Inspect the actual migration history first, then add one idempotent migration with tenant RLS, indexes on `(organization_id, status)`, and foreign keys to existing document/run rows. Keep batch counters repairable from document state, and add a reconciliation query/test rather than trusting client supplied counts.

## Current blocker

Provide an operator SSH user and key/password (or run the documented commands on each VPS and return the output). Without that access the repository can be prepared and tested, but the Local AI full-document implementation, deployed application inspection, and production E2E cannot be truthfully completed.
