-- Login credentials are provisioned outside migrations. These grants only define runtime capability.
GRANT USAGE ON SCHEMA public TO ocr_app, ocr_worker, ocr_queue;
GRANT SELECT, INSERT, UPDATE ON organizations, documents, document_runs, document_pages, ocr_results, ocr_corrections, ocr_confirm_outbox TO ocr_app;
GRANT SELECT, UPDATE ON documents, document_runs, document_pages, ocr_results TO ocr_worker;
GRANT SELECT ON extraction_jobs TO ocr_queue;
GRANT EXECUTE ON FUNCTION ocr_claim_v1(timestamptz) TO ocr_queue;
GRANT EXECUTE ON FUNCTION ocr_heartbeat_v1(uuid,text,timestamptz) TO ocr_worker;
GRANT EXECUTE ON FUNCTION ocr_finish_retry_v1(uuid,text,job_status,text,timestamptz) TO ocr_worker;
GRANT EXECUTE ON FUNCTION ocr_recover_expired_v1(timestamptz) TO ocr_worker;
