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
      lease_token_hash=v_hash, lease_expires_at=p_now + interval '120 seconds',
      locked_at=p_now, locked_by=current_user
    FROM candidate c WHERE j.id=c.id
    RETURNING j.id, j.organization_id, j.run_id, j.kind
  ) SELECT c.id, c.organization_id, c.run_id, c.kind, v_token FROM claimed c;
END $$;
