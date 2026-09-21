-- SECURITY DEFINER owner for the queue and confirm-outbox functions. Run as the bootstrap administrator
-- (superuser: BYPASSRLS can only be granted by one) AFTER all migrations. Idempotent.
--
-- Why: extraction_jobs and ocr_confirm_outbox use FORCE ROW LEVEL SECURITY, and the workers call these functions
-- without app.current_org (they work across tenants). Owned by the table owner (ocr_migrator) they would see no
-- rows, so ownership moves to a NOLOGIN BYPASSRLS role that holds only the table privileges the functions need.
-- Consequence for migrations: ocr_migrator no longer owns these functions and must never CREATE OR REPLACE them.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ocr_queue_definer') THEN
    CREATE ROLE ocr_queue_definer NOLOGIN BYPASSRLS;
  ELSE
    ALTER ROLE ocr_queue_definer NOLOGIN BYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO ocr_queue_definer;

-- Queue (extraction jobs).
GRANT SELECT, UPDATE ON extraction_jobs TO ocr_queue_definer;
ALTER FUNCTION ocr_claim_v1(timestamptz) OWNER TO ocr_queue_definer;
ALTER FUNCTION ocr_heartbeat_v1(uuid,text,timestamptz) OWNER TO ocr_queue_definer;
ALTER FUNCTION ocr_finish_retry_v1(uuid,text,job_status,text,timestamptz) OWNER TO ocr_queue_definer;
ALTER FUNCTION ocr_recover_expired_v1(timestamptz) OWNER TO ocr_queue_definer;
REVOKE ALL ON FUNCTION ocr_claim_v1(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION ocr_heartbeat_v1(uuid,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION ocr_finish_retry_v1(uuid,text,job_status,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION ocr_recover_expired_v1(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ocr_claim_v1(timestamptz) TO ocr_queue;
GRANT EXECUTE ON FUNCTION ocr_heartbeat_v1(uuid,text,timestamptz) TO ocr_worker;
GRANT EXECUTE ON FUNCTION ocr_finish_retry_v1(uuid,text,job_status,text,timestamptz) TO ocr_worker;
GRANT EXECUTE ON FUNCTION ocr_recover_expired_v1(timestamptz) TO ocr_worker;

-- Confirm outbox (records the production-only manual fix so fresh environments match production).
GRANT SELECT, UPDATE ON ocr_confirm_outbox TO ocr_queue_definer;
ALTER FUNCTION ocr_claim_confirm_outbox_v1(text,timestamptz) OWNER TO ocr_queue_definer;
ALTER FUNCTION ocr_finish_confirm_outbox_v1(uuid,text,boolean,text,timestamptz) OWNER TO ocr_queue_definer;
ALTER FUNCTION ocr_recover_confirm_outbox_v1(timestamptz) OWNER TO ocr_queue_definer;
REVOKE ALL ON FUNCTION ocr_claim_confirm_outbox_v1(text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION ocr_finish_confirm_outbox_v1(uuid,text,boolean,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION ocr_recover_confirm_outbox_v1(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ocr_claim_confirm_outbox_v1(text,timestamptz) TO ocr_worker;
GRANT EXECUTE ON FUNCTION ocr_finish_confirm_outbox_v1(uuid,text,boolean,text,timestamptz) TO ocr_worker;
GRANT EXECUTE ON FUNCTION ocr_recover_confirm_outbox_v1(timestamptz) TO ocr_worker;
