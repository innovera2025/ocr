-- DML roles need REFERENCES for PostgreSQL foreign-key checks when inserting tenant rows.
GRANT REFERENCES ON organizations, documents, document_runs, document_pages, ocr_results, ocr_corrections, ocr_confirm_outbox TO ocr_app;
GRANT REFERENCES ON documents, document_runs, document_pages, ocr_results TO ocr_worker;
