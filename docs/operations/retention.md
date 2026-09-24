# Retention and cleanup policy

The database is the audit source of truth. Human corrections, their audit columns (`old_raw`, `normalized_value`, `verified_value`, `verified_by`, `verified_at`), and successful/failed outbox records are retained for the configured regulatory retention period and are never removed by artifact cleanup.

| Artifact | Default policy | Cleanup action |
| --- | --- | --- |
| Uploaded originals | 90 days after document completion, or tenant policy if longer | delete storage object, then set `documents.deleted_at` |
| Local AI working copy (`OCR_UPLOAD_DIR`) | the duration of one `POST /v1/ocr`; a leftover from a crash expires after `OCR_UPLOAD_TTL_MINUTES` (default 60) | automatic, nothing to run: the request deletes its own copy and a sweeper removes crash leftovers. Monitor `uploads.files` (≈0) and `uploads.keep` (`false`) in the Local AI `/health` |
| Temporary crops/staging files | 24 hours | delete by storage-key prefix |
| OCR raw/structured result | 90 days with document | remove only after audit/legal hold check |
| Failed jobs | 30 days after terminal state | delete queue row after incident review |
| Idempotency keys | 24 hours | delete expired keys; retries after expiry create a new document |
| Logs/metrics | 30 days | rotate outside application containers |

Cleanup must run with a dedicated operator/retention role and must filter by tenant and legal hold. It must not delete correction audit rows or verified values. Before enabling the job, take and verify a backup.
