CREATE OR REPLACE FUNCTION ocr_recover_expired_v1(p_now timestamptz DEFAULT now())
RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH recovered AS (
    UPDATE extraction_jobs
    SET status='PENDING', available_at=COALESCE(next_retry_at, p_now), lease_token_hash=NULL, lease_expires_at=NULL, locked_at=NULL, locked_by=NULL
    WHERE status='RUNNING' AND lease_expires_at <= p_now
    RETURNING id
  ) SELECT count(*)::integer FROM recovered;
$$;
REVOKE ALL ON FUNCTION ocr_recover_expired_v1(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ocr_recover_expired_v1(timestamptz) TO ocr_worker;
