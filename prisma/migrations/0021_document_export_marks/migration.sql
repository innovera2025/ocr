-- 0021_document_export_marks: the export history behind the export dialog's "ยังไม่เคย Export" / "Export แล้ว" groups.
-- Additive and idempotent. Runs as ocr_migrator inside the runner's single transaction. Defines no function and never
-- touches the queue or confirm-outbox SECURITY DEFINER functions (owned by ocr_queue_definer in production).
-- Append-only: one row per event (a completed download, a manual mark, a manual unmark); the current state of a
-- document is its latest event by seq. No UPDATE backfill: FORCE RLS hides every row from the migrator, and existing
-- documents simply start as "never exported".
-- Web runtime only: ocr_app may read and append. Nothing may update or delete an event, and no other role gets anything.
CREATE TABLE IF NOT EXISTS document_export_marks (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,           -- total order of events; the latest is the highest
  organization_id uuid NOT NULL REFERENCES organizations(id),
  document_id uuid NOT NULL,
  kind varchar(8) NOT NULL CHECK (kind IN ('exported','marked','unmarked')),
  source varchar(8) NOT NULL CHECK (source IN ('csv','jsonl','manual')),
  document_updated_at timestamptz NOT NULL,                       -- documents.updated_at as the export or mark saw it
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid NOT NULL,
  request_id uuid NOT NULL,                                       -- the server-minted trace id (joins audit_events)
  FOREIGN KEY (document_id, organization_id) REFERENCES documents(id, organization_id),
  FOREIGN KEY (actor_user_id, organization_id) REFERENCES users(id, organization_id),
  CHECK ((kind = 'exported') = (source IN ('csv','jsonl')))       -- a download is a file format, a manual flip is manual
);
ALTER TABLE document_export_marks ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_export_marks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS export_mark_scope ON document_export_marks;
CREATE POLICY export_mark_scope ON document_export_marks USING (organization_id::text = current_setting('app.current_org', true));
CREATE INDEX IF NOT EXISTS document_export_marks_doc_idx ON document_export_marks(organization_id, document_id, seq DESC);

-- Read and append only. ocr_app already holds REFERENCES on documents (0013) and users (0019) for the two FK checks;
-- nothing references this table, so no new REFERENCES grant.
GRANT SELECT, INSERT ON document_export_marks TO ocr_app;
