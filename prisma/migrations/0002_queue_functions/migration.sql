-- Queue writes are function-only. The worker roles receive no table DML.
DO $$ BEGIN CREATE ROLE ocr_app NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE ocr_queue NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE ocr_worker NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT USAGE ON SCHEMA public TO ocr_app, ocr_queue, ocr_worker;
GRANT SELECT, INSERT, UPDATE ON organizations, documents, document_runs, document_pages, ocr_results TO ocr_app;
GRANT SELECT ON organizations, documents, document_runs, document_pages, ocr_results TO ocr_queue;
REVOKE ALL ON extraction_jobs FROM ocr_worker;

CREATE OR REPLACE FUNCTION ocr_claim_v1(p_now timestamptz DEFAULT now())
RETURNS TABLE(job_id uuid, organization_id uuid, run_id uuid, kind text, lease_token text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_token text; v_hash bytea;
BEGIN
  v_token := encode(gen_random_bytes(32), 'hex');
  v_hash := digest(v_token, 'sha256');
  RETURN QUERY
  WITH candidate AS (
    SELECT j.id FROM extraction_jobs j
    WHERE j.status = 'PENDING' AND j.available_at <= p_now
    ORDER BY j.priority ASC, j.available_at ASC
    FOR UPDATE SKIP LOCKED LIMIT 1
  ), claimed AS (
    UPDATE extraction_jobs j SET status='RUNNING', attempts=j.attempts+1,
      lease_token_hash=v_hash, lease_expires_at=p_now + interval '120 seconds'
    FROM candidate c WHERE j.id=c.id
    RETURNING j.id, j.organization_id, j.run_id, j.kind
  ) SELECT id, organization_id, run_id, kind, v_token FROM claimed;
END $$;

CREATE OR REPLACE FUNCTION ocr_heartbeat_v1(p_job_id uuid, p_lease_token text, p_now timestamptz DEFAULT now())
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE extraction_jobs SET lease_expires_at=p_now + interval '120 seconds'
  WHERE id=p_job_id AND status='RUNNING' AND lease_expires_at > p_now
    AND lease_token_hash=digest(p_lease_token, 'sha256') RETURNING true;
$$;

CREATE OR REPLACE FUNCTION ocr_finish_v1(p_job_id uuid, p_lease_token text, p_outcome job_status, p_now timestamptz DEFAULT now())
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE extraction_jobs SET status=p_outcome, lease_token_hash=NULL, lease_expires_at=NULL
  WHERE id=p_job_id AND status='RUNNING' AND lease_expires_at > p_now
    AND lease_token_hash=digest(p_lease_token, 'sha256') RETURNING true;
$$;

REVOKE ALL ON FUNCTION ocr_claim_v1(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION ocr_heartbeat_v1(uuid,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION ocr_finish_v1(uuid,text,job_status,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ocr_claim_v1(timestamptz) TO ocr_queue;
GRANT EXECUTE ON FUNCTION ocr_heartbeat_v1(uuid,text,timestamptz) TO ocr_worker;
GRANT EXECUTE ON FUNCTION ocr_finish_v1(uuid,text,job_status,timestamptz) TO ocr_worker;
