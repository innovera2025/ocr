-- Web runtime creates extraction jobs after an authenticated upload.
-- Keep privileges minimal: INSERT plus columns required by RLS,
-- idempotency lookup and INSERT ... RETURNING id.

GRANT INSERT ON extraction_jobs TO ocr_app;

GRANT SELECT (id, organization_id, run_id)
ON extraction_jobs TO ocr_app;
