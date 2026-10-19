-- Queue control (plan queue-control_PLAN_19-10-26, Release A). Runs as ocr_migrator inside one transaction.
-- Additive. Creates no routine and removes nothing: the queue and confirm-outbox SECURITY DEFINER routines are owned by
-- ocr_queue_definer in production and stay exactly as they are; the claim keeps ordering by (priority, available_at).

-- The web applies this at startup; the ALTERs below take an ACCESS EXCLUSIVE lock on ocr_batches. Waiting at most 5 s for
-- it (instead of queueing behind a long transaction while every upload and batch read queues behind this one) makes a
-- busy moment fail the startup cleanly; the web restarts and the migration runs again from the start.
SET LOCAL lock_timeout = '5s';

-- 1. Batch-first order. Every batch gets a queue sequence number; the web and the worker give each new job
--    priority = its batch's queue_seq (a job without a batch keeps priority 0, ahead of every batch).
CREATE SEQUENCE IF NOT EXISTS ocr_batch_queue_seq;
ALTER TABLE ocr_batches ADD COLUMN IF NOT EXISTS queue_seq integer;
ALTER TABLE ocr_batches ALTER COLUMN queue_seq SET DEFAULT nextval('ocr_batch_queue_seq');

-- Backfill of the existing batches, oldest first by (created_at, id). ocr_batches and organizations both FORCE row-level
-- security and ocr_migrator has no BYPASSRLS, so under FORCE the table owner sees no batch and no organization at all
-- (an UPDATE here, or a loop over organizations, would touch 0 rows). The owner lifts FORCE on ocr_batches for this one
-- UPDATE and restores it before the transaction ends; the ALTER holds an ACCESS EXCLUSIVE lock until COMMIT, so no other
-- session ever sees the table without FORCE. Rows that already have a number are left alone, so a re-run changes nothing.
ALTER TABLE ocr_batches NO FORCE ROW LEVEL SECURITY;
UPDATE ocr_batches b SET queue_seq = r.base + r.rank
FROM (SELECT x.id, row_number() OVER (ORDER BY x.created_at, x.id)::int AS rank,
             (SELECT COALESCE(max(y.queue_seq), 0) FROM ocr_batches y) AS base
      FROM ocr_batches x WHERE x.queue_seq IS NULL) r
WHERE b.id = r.id;
SELECT setval('ocr_batch_queue_seq', (SELECT COALESCE(max(queue_seq), 0) + 1 FROM ocr_batches), false);
ALTER TABLE ocr_batches FORCE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX IF NOT EXISTS ocr_batches_queue_seq_idx ON ocr_batches(queue_seq);

-- 2. The platform-wide queue control (one row). No row-level security: it holds no tenant data, and the worker reads
--    it before every claim without a tenant. Deployment-wide by design (the worker claims across tenants).
CREATE TABLE IF NOT EXISTS queue_control (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  stopped_at timestamptz,
  stopped_by varchar(255),
  round_cap integer CHECK (round_cap IS NULL OR round_cap BETWEEN 1 AND 100000),
  round_no integer NOT NULL DEFAULT 1,
  round_started_at timestamptz NOT NULL DEFAULT now(),
  round_done integer NOT NULL DEFAULT 0 CHECK (round_done >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by varchar(255)
);
INSERT INTO queue_control(id) VALUES (true) ON CONFLICT DO NOTHING;

-- 3. Grants (minimal). The web reads and changes the control row and numbers new batches; the worker reads the row,
--    counts finished pages (round_done only) and reads its batch's number for the pages it creates. The queue role
--    gets nothing.
GRANT SELECT ON queue_control TO ocr_app, ocr_worker;
GRANT UPDATE (stopped_at, stopped_by, round_cap, round_no, round_started_at, round_done, updated_at, updated_by) ON queue_control TO ocr_app;
GRANT UPDATE (round_done) ON queue_control TO ocr_worker;
GRANT USAGE ON SEQUENCE ocr_batch_queue_seq TO ocr_app;
GRANT SELECT (id, organization_id, queue_seq) ON ocr_batches TO ocr_worker;
