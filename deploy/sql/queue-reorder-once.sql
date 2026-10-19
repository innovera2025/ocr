-- One-off reorder of the jobs that were queued before batch-first order (plan queue-control D4, approval gate AP-3).
-- Run AFTER migration 0022_queue_control, as the bootstrap superuser (it must see every organization's rows; every
-- table it reads has FORCE row-level security, so any other role would see 0 rows). It refuses to run, in every mode,
-- unless the current role is a superuser or has BYPASSRLS.
--
--   psql -X -v ON_ERROR_STOP=1 -v apply=0 -d innovera_ocr -f queue-reorder-once.sql   # dry run: counts only, changes nothing
--   psql -X -v ON_ERROR_STOP=1 -v apply=1 -d innovera_ocr -f queue-reorder-once.sql   # apply, in one transaction
--   psql -X -v ON_ERROR_STOP=1 -v apply=2 -v backup_date=YYYYMMDD -d innovera_ocr -f queue-reorder-once.sql   # revert
--
-- The backup table is queue_reorder_backup_<YYYYMMDD>; apply names it after today (UTC) unless -v backup_date is given.
-- REVERT REQUIRES -v backup_date: the YYYYMMDD of the apply (the apply prints it as backup_table|...). Apply refuses
-- while ANY queue_reorder_backup_* table exists: one apply per database; a later apply needs the operator to drop or
-- rename the old backup on purpose first (after deciding it is no longer needed for a revert).
--
-- Apply: (1) numbers any batch that still has no queue_seq, oldest first by (created_at, id); (2) records every PENDING
-- job it is about to change in queue_reorder_backup_<YYYYMMDD> (old and new priority / available_at); (3) sets those
-- jobs to priority = their batch's queue_seq (0 without a batch) and, for a page of a split PDF, available_at = the
-- parent's created_at + page number in microseconds. RUNNING, SUCCEEDED, FAILED and DEAD jobs are never touched, and
-- nothing is deleted. It refuses to run when the backup table already exists (one apply per backup). Revert restores the
-- recorded old values of the jobs that are still PENDING and keeps the backup table.
-- Note: in production every PENDING job carries an old priority (100 + position / page) and almost all of them belong to
-- a batch, so an apply changes nearly every PENDING job (the dry run's pending_would_change says how many).
-- Output is counts only (key|value lines): no file name, no customer value, no id.
\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on
\pset footer off

\if :{?apply}
\else
  \echo 'usage: psql -v apply=0|1|2 [-v backup_date=YYYYMMDD, required for 2] -f queue-reorder-once.sql'
  DO $$ BEGIN RAISE EXCEPTION 'apply is required (0 dry run, 1 apply, 2 revert)'; END $$;
\endif
\if :{?backup_date}
\else
  \set backup_date ''
\endif
SELECT :'apply' IN ('0','1','2') AS apply_ok,
       :'apply' = '0' AS is_dry_run, :'apply' = '1' AS is_apply, :'apply' = '2' AS is_revert,
       :'backup_date' = '' OR :'backup_date' ~ '^[0-9]{8}$' AS date_ok,
       'queue_reorder_backup_' || COALESCE(NULLIF(:'backup_date', ''), to_char(now() AT TIME ZONE 'UTC', 'YYYYMMDD')) AS backup_table \gset
\if :apply_ok
\else
  DO $$ BEGIN RAISE EXCEPTION 'apply must be 0, 1 or 2'; END $$;
\endif
\if :date_ok
\else
  DO $$ BEGIN RAISE EXCEPTION 'backup_date must be YYYYMMDD'; END $$;
\endif
-- Every table here has FORCE RLS: without superuser or BYPASSRLS the script would see no row at all, report zeros and
-- (apply) create an empty backup. Refuse before anything is read or written.
SELECT (rolsuper OR rolbypassrls) AS sees_all_rows FROM pg_roles WHERE rolname = current_user \gset
\if :sees_all_rows
\else
  DO $$ BEGIN RAISE EXCEPTION 'run this as the bootstrap superuser (or a BYPASSRLS role): under FORCE row-level security this role sees no rows'; END $$;
\endif
SELECT :'apply' = '2' AND :'backup_date' = '' AS revert_without_date \gset
\if :revert_without_date
  DO $$ BEGIN RAISE EXCEPTION 'revert needs -v backup_date=YYYYMMDD (the date of the apply''s backup table)'; END $$;
\endif
SELECT to_regclass(:'backup_table') IS NOT NULL AS backup_exists,
       count(*) FILTER (WHERE tablename LIKE 'queue\_reorder\_backup\_%') AS backups_existing,
       count(*) FILTER (WHERE tablename LIKE 'queue\_reorder\_backup\_%') > 0 AS any_backup
FROM pg_tables WHERE schemaname = 'public' \gset
SELECT 'mode|' || CASE :'apply' WHEN '0' THEN 'dry_run' WHEN '1' THEN 'apply' ELSE 'revert' END;
SELECT 'backup_table|' || :'backup_table';

-- ---- dry run: counts of what an apply would see and change; read only -----------------------------------------
\if :is_dry_run
BEGIN TRANSACTION READ ONLY;
SELECT 'pending_total|' || count(*) FROM extraction_jobs WHERE status = 'PENDING';
SELECT 'running_total|' || count(*) FROM extraction_jobs WHERE status = 'RUNNING';
SELECT 'pending_page|' || count(*) FILTER (WHERE d.parent_document_id IS NOT NULL)
    || E'\npending_file|' || count(*) FILTER (WHERE d.parent_document_id IS NULL AND d.mime_type <> 'application/pdf')
    || E'\npending_split_parent|' || count(*) FILTER (WHERE d.parent_document_id IS NULL AND d.mime_type = 'application/pdf')
    || E'\npending_no_batch|' || count(*) FILTER (WHERE d.batch_id IS NULL)
FROM extraction_jobs j
JOIN document_runs r ON r.id = j.run_id AND r.organization_id = j.organization_id
JOIN documents d ON d.id = r.document_id AND d.organization_id = r.organization_id
WHERE j.status = 'PENDING';
SELECT 'batches_without_queue_seq|' || count(*) FROM ocr_batches WHERE queue_seq IS NULL;
SELECT 'pending_would_change|' || count(*)
FROM extraction_jobs j
JOIN document_runs r ON r.id = j.run_id AND r.organization_id = j.organization_id
JOIN documents d ON d.id = r.document_id AND d.organization_id = r.organization_id
LEFT JOIN documents p ON p.id = d.parent_document_id AND p.organization_id = d.organization_id
LEFT JOIN ocr_batches b ON b.id = d.batch_id AND b.organization_id = d.organization_id
WHERE j.status = 'PENDING'
  AND (j.priority, j.available_at) IS DISTINCT FROM
      (COALESCE(b.queue_seq, 0), CASE WHEN d.parent_document_id IS NOT NULL THEN p.created_at + d.page_number * interval '1 microsecond' ELSE j.available_at END);
SELECT 'backup_exists|' || :'backup_exists';
SELECT 'backup_tables_existing|' || :'backups_existing';
COMMIT;
\endif

-- ---- apply: number missing batches, back up and reorder the PENDING jobs, in one transaction ---------------------
\if :is_apply
\if :any_backup
  DO $$ BEGIN RAISE EXCEPTION 'a queue_reorder_backup_* table already exists: the reorder was applied before (revert with apply=2 and its backup_date; drop or rename the old backup on purpose before another apply)'; END $$;
\endif
BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT 'batches_numbered|' || count(*) FROM ocr_batches WHERE queue_seq IS NULL;
-- One nextval per batch in (created_at, id) order: the same sequence the column default uses, so a batch created
-- meanwhile can never collide, and the batches numbered here queue after every batch numbered before.
DO $$
DECLARE batch record;
BEGIN
  FOR batch IN SELECT id FROM ocr_batches WHERE queue_seq IS NULL ORDER BY created_at, id LOOP
    UPDATE ocr_batches SET queue_seq = nextval('ocr_batch_queue_seq') WHERE id = batch.id;
  END LOOP;
END $$;
CREATE TABLE :"backup_table" (
  job_id uuid PRIMARY KEY,
  old_priority integer NOT NULL,
  old_available_at timestamptz NOT NULL,
  new_priority integer NOT NULL,
  new_available_at timestamptz NOT NULL,
  taken_at timestamptz NOT NULL DEFAULT now()
);
-- The PENDING jobs are locked first (FOR UPDATE): a claim running meanwhile skips them (SKIP LOCKED) instead of taking
-- a job whose order is being rewritten, and a job claimed just before is RUNNING and left alone.
WITH target AS (
  SELECT j.id, j.priority AS old_priority, j.available_at AS old_available_at, COALESCE(b.queue_seq, 0) AS new_priority,
         CASE WHEN d.parent_document_id IS NOT NULL THEN p.created_at + d.page_number * interval '1 microsecond' ELSE j.available_at END AS new_available_at
  FROM extraction_jobs j
  JOIN document_runs r ON r.id = j.run_id AND r.organization_id = j.organization_id
  JOIN documents d ON d.id = r.document_id AND d.organization_id = r.organization_id
  LEFT JOIN documents p ON p.id = d.parent_document_id AND p.organization_id = d.organization_id
  LEFT JOIN ocr_batches b ON b.id = d.batch_id AND b.organization_id = d.organization_id
  WHERE j.status = 'PENDING'
  FOR UPDATE OF j)
INSERT INTO :"backup_table" (job_id, old_priority, old_available_at, new_priority, new_available_at)
SELECT id, old_priority, old_available_at, new_priority, new_available_at FROM target
WHERE (old_priority, old_available_at) IS DISTINCT FROM (new_priority, new_available_at);
WITH changed AS (
  UPDATE extraction_jobs j SET priority = k.new_priority, available_at = k.new_available_at
  FROM :"backup_table" k WHERE k.job_id = j.id AND j.status = 'PENDING' RETURNING 1)
SELECT 'jobs_reordered|' || count(*) FROM changed;
SELECT 'backup_rows|' || count(*) FROM :"backup_table";
SELECT 'pending_total|' || count(*) FROM extraction_jobs WHERE status = 'PENDING';
COMMIT;
\endif

-- ---- revert: restore the recorded order of the jobs that are still PENDING; the backup table stays -------------
\if :is_revert
\if :backup_exists
\else
  DO $$ BEGIN RAISE EXCEPTION 'no backup table to revert from (pass -v backup_date=YYYYMMDD of the apply)'; END $$;
\endif
BEGIN;
SET LOCAL lock_timeout = '5s';
WITH restored AS (
  UPDATE extraction_jobs j SET priority = k.old_priority, available_at = k.old_available_at
  FROM :"backup_table" k WHERE k.job_id = j.id AND j.status = 'PENDING' RETURNING 1)
SELECT 'jobs_restored|' || count(*) FROM restored;
SELECT 'backup_rows|' || count(*) FROM :"backup_table";
COMMIT;
\endif
