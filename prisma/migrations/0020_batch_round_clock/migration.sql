-- Batch clock by processing round (Release 1 carry-over). Additive; defines no function
-- (the queue/outbox functions are owned by ocr_queue_definer in production).
-- A batch retried hours after its upload used to show the whole wait as elapsed time and a rate near 0, because both
-- counted from ocr_batches.created_at. The round columns move the clock to the current processing round instead.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS processing_started_at timestamptz;  -- worker: first claim since the row was (re)queued
ALTER TABLE ocr_batches ADD COLUMN IF NOT EXISTS round_opened_at timestamptz;      -- web: a retry into an idle batch opens a new round

-- The only column of ocr_batches the web runtime may change; the label and the capacity stay as they were created
-- (0017 granted SELECT and INSERT only). The worker already has table-level UPDATE on documents (0009).
GRANT UPDATE (round_opened_at) ON ocr_batches TO ocr_app;
