ALTER TABLE ocr_confirm_outbox
  ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS locked_by varchar(255);

CREATE OR REPLACE FUNCTION ocr_claim_confirm_outbox_v1(p_worker_id text, p_now timestamptz DEFAULT now())
RETURNS TABLE(outbox_id uuid, payload jsonb)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH candidate AS (
    SELECT id FROM ocr_confirm_outbox
    WHERE status IN ('PENDING','RETRY') AND next_attempt_at <= p_now
    ORDER BY next_attempt_at ASC, id ASC
    FOR UPDATE SKIP LOCKED LIMIT 1
  )
  UPDATE ocr_confirm_outbox o SET status='PROCESSING', attempts=attempts+1, locked_at=p_now, locked_by=p_worker_id
  FROM candidate c WHERE o.id=c.id RETURNING o.id, o.payload;
$$;

CREATE OR REPLACE FUNCTION ocr_finish_confirm_outbox_v1(p_id uuid, p_worker_id text, p_success boolean, p_error text DEFAULT NULL, p_now timestamptz DEFAULT now())
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE ocr_confirm_outbox SET
    status = CASE WHEN p_success THEN 'SUCCEEDED' WHEN attempts >= max_attempts THEN 'DEAD' ELSE 'RETRY' END,
    last_error = CASE WHEN p_success THEN NULL ELSE p_error END,
    next_attempt_at = CASE WHEN p_success OR attempts >= max_attempts THEN next_attempt_at ELSE p_now + make_interval(secs => LEAST(3600, (2 ^ LEAST(attempts, 10))::integer)) END,
    sent_at = CASE WHEN p_success THEN p_now ELSE sent_at END,
    locked_at = NULL, locked_by = NULL
  WHERE id=p_id AND status='PROCESSING' AND locked_by=p_worker_id
  RETURNING true;
$$;
CREATE OR REPLACE FUNCTION ocr_recover_confirm_outbox_v1(p_now timestamptz DEFAULT now())
RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH recovered AS (
    UPDATE ocr_confirm_outbox SET status='RETRY', next_attempt_at=p_now, locked_at=NULL, locked_by=NULL
    WHERE status='PROCESSING' AND locked_at < p_now - interval '120 seconds' RETURNING id
  ) SELECT count(*)::integer FROM recovered;
$$;
REVOKE ALL ON FUNCTION ocr_claim_confirm_outbox_v1(text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION ocr_finish_confirm_outbox_v1(uuid,text,boolean,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION ocr_recover_confirm_outbox_v1(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ocr_claim_confirm_outbox_v1(text,timestamptz) TO ocr_worker;
GRANT EXECUTE ON FUNCTION ocr_finish_confirm_outbox_v1(uuid,text,boolean,text,timestamptz) TO ocr_worker;
GRANT EXECUTE ON FUNCTION ocr_recover_confirm_outbox_v1(timestamptz) TO ocr_worker;
