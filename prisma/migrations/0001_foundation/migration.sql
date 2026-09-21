CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TYPE document_status AS ENUM ('VALIDATING','SCANNING','CLEAN','PROCESSING','SUCCEEDED','FAILED','QUARANTINED','DELETED');
CREATE TYPE run_outcome AS ENUM ('RUNNING','SUCCEEDED','FAILED','CANCELLED');
CREATE TYPE job_status AS ENUM ('PENDING','RUNNING','SUCCEEDED','FAILED','DEAD','CANCELLED');
CREATE TABLE organizations (id uuid PRIMARY KEY, name varchar(200) NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE documents (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), public_id varchar(32) NOT NULL,
 status document_status NOT NULL, filename varchar(120) NOT NULL, mime_type varchar(127) NOT NULL,
 size_bytes bigint NOT NULL CHECK (size_bytes > 0), content_hash varchar(64) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
 UNIQUE (id, organization_id), UNIQUE (organization_id, public_id)
);
CREATE TABLE document_runs (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, document_id uuid NOT NULL, outcome run_outcome NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 FOREIGN KEY (document_id, organization_id) REFERENCES documents(id, organization_id), UNIQUE (id, organization_id)
);
CREATE UNIQUE INDEX document_run_one_active ON document_runs(organization_id, document_id) WHERE outcome = 'RUNNING';
CREATE TABLE document_pages (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, document_id uuid NOT NULL, page_no integer NOT NULL CHECK (page_no >= 1),
 created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY (document_id, organization_id) REFERENCES documents(id, organization_id),
 UNIQUE (id, organization_id), UNIQUE (organization_id, document_id, page_no)
);
CREATE TABLE extraction_jobs (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, run_id uuid NOT NULL, kind varchar(32) NOT NULL,
 status job_status NOT NULL, priority integer NOT NULL DEFAULT 100, available_at timestamptz NOT NULL DEFAULT now(),
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0), lease_token_hash bytea, lease_expires_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY (run_id, organization_id) REFERENCES document_runs(id, organization_id), UNIQUE (organization_id, id)
);
CREATE INDEX extraction_job_claim_pending_idx ON extraction_jobs(priority ASC, available_at ASC) WHERE status = 'PENDING';
CREATE TABLE ocr_results (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, run_id uuid NOT NULL, document_page_id uuid NOT NULL,
 engine_id varchar(80) NOT NULL, text_nfc text NOT NULL, confidence numeric(6,5), geometry_json jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY (run_id, organization_id) REFERENCES document_runs(id, organization_id),
 FOREIGN KEY (document_page_id, organization_id) REFERENCES document_pages(id, organization_id),
 UNIQUE (organization_id, run_id, document_page_id, engine_id)
);
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE extraction_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ocr_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
ALTER TABLE document_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE document_pages FORCE ROW LEVEL SECURITY;
ALTER TABLE extraction_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE ocr_results FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_scope ON organizations USING (id::text = current_setting('app.current_org', true));
CREATE POLICY document_scope ON documents USING (organization_id::text = current_setting('app.current_org', true));
CREATE POLICY run_scope ON document_runs USING (organization_id::text = current_setting('app.current_org', true));
CREATE POLICY page_scope ON document_pages USING (organization_id::text = current_setting('app.current_org', true));
CREATE POLICY job_scope ON extraction_jobs USING (organization_id::text = current_setting('app.current_org', true));
CREATE POLICY ocr_scope ON ocr_results USING (organization_id::text = current_setting('app.current_org', true));
