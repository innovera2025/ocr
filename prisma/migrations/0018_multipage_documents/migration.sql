-- Multi-page files: one child document per page. Defines no function (queue/outbox functions are owned by ocr_queue_definer).
ALTER TYPE document_status ADD VALUE IF NOT EXISTS 'SPLIT';   -- not referenced again in this migration (unusable in the adding transaction)
ALTER TABLE documents ADD COLUMN IF NOT EXISTS parent_document_id uuid;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS page_number integer;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS page_count integer;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='documents_parent_fk' AND conrelid='documents'::regclass) THEN
    ALTER TABLE documents ADD CONSTRAINT documents_parent_fk
      FOREIGN KEY (parent_document_id, organization_id) REFERENCES documents(id, organization_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='documents_page_shape_chk' AND conrelid='documents'::regclass) THEN
    ALTER TABLE documents ADD CONSTRAINT documents_page_shape_chk CHECK (
      (parent_document_id IS NULL) = (page_number IS NULL)
      AND (page_number IS NULL OR page_number BETWEEN 1 AND 1000)
      AND (page_count  IS NULL OR page_count  BETWEEN 1 AND 1000));
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS documents_parent_page_uidx
  ON documents(organization_id, parent_document_id, page_number) WHERE parent_document_id IS NOT NULL;

-- The worker creates page documents, their runs and their OCR jobs under the same tenant RLS as ocr_app (mirrors 0016).
GRANT INSERT ON documents, document_runs TO ocr_worker;
GRANT INSERT ON extraction_jobs TO ocr_worker;
GRANT SELECT (id, organization_id, run_id) ON extraction_jobs TO ocr_worker;   -- INSERT … RETURNING id + RLS column
