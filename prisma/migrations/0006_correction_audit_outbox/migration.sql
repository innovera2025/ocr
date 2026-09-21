CREATE TABLE IF NOT EXISTS ocr_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  document_id uuid NOT NULL,
  field varchar(120) NOT NULL,
  old_raw text,
  normalized_value text,
  verified_value text NOT NULL,
  verified_by varchar(255) NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  confirm_status varchar(32) NOT NULL DEFAULT 'PENDING',
  confirm_error text,
  UNIQUE (organization_id, document_id, field, verified_value),
  FOREIGN KEY (document_id, organization_id) REFERENCES documents(id, organization_id)
);
CREATE TABLE IF NOT EXISTS ocr_confirm_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  correction_id uuid NOT NULL UNIQUE REFERENCES ocr_corrections(id),
  payload jsonb NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'PENDING',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  sent_at timestamptz
);
ALTER TABLE ocr_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE ocr_corrections FORCE ROW LEVEL SECURITY;
ALTER TABLE ocr_confirm_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE ocr_confirm_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY correction_scope ON ocr_corrections USING (organization_id::text = current_setting('app.current_org', true));
CREATE POLICY correction_outbox_scope ON ocr_confirm_outbox USING (organization_id::text = current_setting('app.current_org', true));
