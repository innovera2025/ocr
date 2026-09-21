-- Batch upload + review metadata. Runs as ocr_migrator inside one transaction.
-- Deliberately defines no functions: in production the queue and confirm-outbox SECURITY DEFINER
-- functions are owned by ocr_queue_definer, so CREATE OR REPLACE here would fail (and must not happen).
-- Batch counters are derived from document rows on read; there are no stored counters to drift.
CREATE TABLE IF NOT EXISTS ocr_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  created_by varchar(255) NOT NULL,
  label varchar(200),
  expected_total integer NOT NULL CHECK (expected_total BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id)
);
ALTER TABLE ocr_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE ocr_batches FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS batch_scope ON ocr_batches;
CREATE POLICY batch_scope ON ocr_batches USING (organization_id::text = current_setting('app.current_org', true));
CREATE INDEX IF NOT EXISTS ocr_batches_org_created_idx ON ocr_batches(organization_id, created_at DESC);

ALTER TABLE documents ADD COLUMN IF NOT EXISTS batch_id uuid;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS reviewed_by varchar(255);
-- Composite FK keeps a document and its batch in the same tenant (MATCH SIMPLE: NULL batch_id allowed).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_batch_fk' AND conrelid = 'documents'::regclass) THEN
    ALTER TABLE documents ADD CONSTRAINT documents_batch_fk FOREIGN KEY (batch_id, organization_id) REFERENCES ocr_batches(id, organization_id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS documents_org_batch_idx   ON documents(organization_id, batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS documents_org_created_idx ON documents(organization_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS documents_org_status_idx  ON documents(organization_id, status);

-- Web runtime creates batches and reads them; no UPDATE/DELETE (counters are derived). The queue role gets nothing.
GRANT SELECT, INSERT ON ocr_batches TO ocr_app;
GRANT REFERENCES ON ocr_batches TO ocr_app, ocr_worker;
