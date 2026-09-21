CREATE TABLE IF NOT EXISTS upload_idempotency_keys (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  idempotency_key varchar(255) NOT NULL,
  request_fingerprint varchar(64) NOT NULL,
  document_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, idempotency_key),
  FOREIGN KEY (document_id, organization_id) REFERENCES documents(id, organization_id)
);
ALTER TABLE upload_idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE upload_idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY upload_idempotency_scope ON upload_idempotency_keys USING (organization_id::text = current_setting('app.current_org', true));
GRANT SELECT, INSERT, DELETE ON upload_idempotency_keys TO ocr_app;
