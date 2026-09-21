-- Queue claims are security-definer functions; the queue role must not read tables directly.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ocr_queue;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ocr_queue;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ocr_queue;
GRANT USAGE ON SCHEMA public TO ocr_queue;
GRANT EXECUTE ON FUNCTION ocr_claim_v1(timestamptz) TO ocr_queue;
GRANT EXECUTE ON FUNCTION ocr_heartbeat_v1(uuid,text,timestamptz) TO ocr_worker;
GRANT EXECUTE ON FUNCTION ocr_finish_retry_v1(uuid,text,job_status,text,timestamptz) TO ocr_worker;
GRANT EXECUTE ON FUNCTION ocr_recover_expired_v1(timestamptz) TO ocr_worker;
GRANT EXECUTE ON FUNCTION ocr_claim_confirm_outbox_v1(text,timestamptz) TO ocr_worker;
GRANT EXECUTE ON FUNCTION ocr_finish_confirm_outbox_v1(uuid,text,boolean,text,timestamptz) TO ocr_worker;
GRANT EXECUTE ON FUNCTION ocr_recover_confirm_outbox_v1(timestamptz) TO ocr_worker;
