CREATE OR REPLACE FUNCTION ocr_finish_retry_v1(p_job_id uuid, p_lease_token text, p_outcome job_status, p_error text DEFAULT NULL, p_now timestamptz DEFAULT now())
RETURNS TABLE(accepted boolean, final_status job_status)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE extraction_jobs
  SET status = CASE
      WHEN p_outcome = 'FAILED' AND attempts < max_attempts THEN 'PENDING'::job_status
      WHEN p_outcome = 'FAILED' THEN 'DEAD'::job_status
      ELSE p_outcome END,
      available_at = CASE WHEN p_outcome = 'FAILED' AND attempts < max_attempts THEN p_now + interval '5 seconds' ELSE available_at END,
      next_retry_at = CASE WHEN p_outcome = 'FAILED' AND attempts < max_attempts THEN p_now + interval '5 seconds' ELSE NULL END,
      last_error = p_error,
      lease_token_hash = NULL, lease_expires_at = NULL, locked_at = NULL, locked_by = NULL
  WHERE id = p_job_id AND status = 'RUNNING' AND lease_expires_at > p_now
    AND lease_token_hash = digest(p_lease_token, 'sha256')
  RETURNING true, status;
$$;
REVOKE ALL ON FUNCTION ocr_finish_retry_v1(uuid,text,job_status,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ocr_finish_retry_v1(uuid,text,job_status,text,timestamptz) TO ocr_worker;
