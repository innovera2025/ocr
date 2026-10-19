# Queue control, Release A: report (skeleton, rename to the deploy date at Phase 6.7)

Plan: `process/features/queue-control/active/queue-control_PLAN_19-10-26.md` (harness repo). Aggregates only: no customer
value, no file name, no credential. Sections marked PENDING are filled at Phase 6 (production, gates AP-1 to AP-4).

## What Release A changes

- **Batch-first order.** Migration `0022_queue_control` numbers every batch (`ocr_batches.queue_seq`, sequence
  `ocr_batch_queue_seq`). Every new job takes its batch's number as priority (0 without a batch): the upload enqueue,
  the page jobs of a split PDF (`available_at` = parent `created_at` + page number in microseconds) and a retry (back
  of its batch). `ocr_claim_v1` and the other definer-owned queue functions are unchanged.
- **Queue control.** One deployment-wide row `queue_control` (no RLS; it holds no tenant data). The worker reserves a
  slot before every claim (`packages/queue/src/control.ts`): closed while stopped, or while
  `round_done + inflight >= round_cap`. Only an accepted SUCCEEDED OCR finish counts. Admin: Stop, Resume, N pages per
  round. Staff and admin: Start next round (any time; idempotent per `roundNo`). Every change writes an audit row.
- **Progress.** `GET /api/queue`: pages read of total over the open batches, files, measured seconds per page (median
  gap of the last 21 reads in 24 h, gaps over 15 minutes dropped, at least 5 gaps), ETA, round counter. Workbench card
  `คิวการอ่าน` above the batch card; the stale "2-3 pages per minute" note is gone.
- **Export default.** The export dialog opens with รอตรวจสอบ, อ่านสำเร็จ, ยืนยันแล้ว ticked; button
  `เฉพาะที่อ่านเสร็จแล้ว`.
- **Operator script.** `deploy/sql/queue-reorder-once.sql` (dry run / apply / revert) reorders the jobs queued before the
  deploy, with a backup table.

## Code and verification (local, 2026-10-19)

Branch `feature/queue-control` from `main` `8f60669`; see the plan's execution log for the commit list, the test
counts and the recorded deviations (DEV-1 backfill under FORCE RLS, DEV-2 timing statistic).

## Deploy (PENDING, Phase 6)

| Step | Gate | Result |
|---|---|---|
| Merge to GitHub `main`, tag `queue-control-a-1` | AP-1 | PENDING |
| Pre-flight (read-only): head, images, `/health/ready`, migrations end `0021`, `ocr_batches` owner = `ocr_migrator` (DEV-1) | - | PENDING |
| Backup (dump sha256, image tags `pre-queue-control-a`) + web deploy, migration `0022` | AP-2 | PENDING |
| Reorder dry run counts, then apply (backup table name, rows) | AP-3 | PENDING |
| Worker swap | AP-4 | PENDING |
| No-credential checks, smoke, 3-minute soak | - | PENDING |
| `APPLIED_IN_PRODUCTION` bumped to `0022_queue_control` | - | PENDING |
| User check UC-A | user | PENDING |

## Known limitations and notes

- The control row is deployment-wide: a second organization would share Stop/Resume and N (backlog note in the plan's
  feature folder).
- A crash between a page's finish and its count loses at most one count per crash (the cap undercounts by one).
- The old worker ignores the gate until the worker swap (AP-4); the web deploy alone does not stop anything.
- The unreleased `ocr-review-ledger` branch also used `0022`; it must renumber (file, version string, checksum pin) when it
  rebases onto this `main`.
- Out of scope (separate decisions): `OCR_REQUEST_TIMEOUT` 300 to 600; the AI host CPU steal (the real cause of the slow
  rate); the cosmetic `document_runs` RUNNING rows.
