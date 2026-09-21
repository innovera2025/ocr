ALTER TYPE document_status ADD VALUE IF NOT EXISTS 'NEEDS_REVIEW';

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS ocr_document_id varchar(255),
  ADD COLUMN IF NOT EXISTS storage_key varchar(512),
  ADD COLUMN IF NOT EXISTS ocr_engine varchar(80),
  ADD COLUMN IF NOT EXISTS ocr_version varchar(40),
  ADD COLUMN IF NOT EXISTS raw_response jsonb,
  ADD COLUMN IF NOT EXISTS structured_result jsonb,
  ADD COLUMN IF NOT EXISTS needs_review boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS error_message text,
  ADD COLUMN IF NOT EXISTS processed_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS confirm_status varchar(32),
  ADD COLUMN IF NOT EXISTS confirm_error text,
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;

ALTER TABLE extraction_jobs
  ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS next_retry_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS locked_by varchar(255);

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
  ) SELECT id, organization_id, run_id, kind, v_token FROM claimed;
END $$;

CREATE OR REPLACE FUNCTION ocr_finish_v1(p_job_id uuid, p_lease_token text, p_outcome job_status, p_now timestamptz DEFAULT now())
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE extraction_jobs SET status=p_outcome, lease_token_hash=NULL, lease_expires_at=NULL,
    locked_at=NULL, locked_by=NULL
  WHERE id=p_job_id AND status='RUNNING' AND lease_expires_at > p_now
    AND lease_token_hash=digest(p_lease_token, 'sha256') RETURNING true;
$$;

DROP INDEX IF EXISTS documents_public_id_key;
