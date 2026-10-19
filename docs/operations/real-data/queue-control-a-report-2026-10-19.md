# Queue control, Release A: deploy report (2026-10-19)

Plan: `process/features/queue-control/active/queue-control_PLAN_19-10-26.md` (harness repo). Aggregates only: no customer
value, no file name, no credential, no job or document id. All times UTC (Asia/Bangkok = UTC+7).

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
  gap of the last 21 reads in 24 h, gaps over 15 minutes dropped, at least 5 gaps), ETA, round counter; served from a
  2 s per-tenant cache. Workbench card `คิวการอ่าน` above the batch card; the stale "2-3 pages per minute" note is gone.
- **Export default.** The export dialog opens with รอตรวจสอบ, อ่านสำเร็จ, ยืนยันแล้ว ticked; button
  `เฉพาะที่อ่านเสร็จแล้ว`.
- **Operator script.** `deploy/sql/queue-reorder-once.sql` (dry run / apply / revert) reordered the jobs queued before
  the deploy, with a backup table. It refuses unless run as the superuser (or a BYPASSRLS role), refuses an apply while
  any `queue_reorder_backup_*` table exists, and a revert needs `-v backup_date=YYYYMMDD`.

## Code

GitHub `innovera2025/ocr` `main` `8f60669` -> `2b85bc9` (fast-forward, AP-1, tag `queue-control-a-1`), then this report
commit. Local gates on `2b85bc9`: typecheck 0, lint 0, `pnpm test` 563/563; DB suites (batch, order, control, reorder)
green on an unloaded host (production-shaped seed: overview median 91 ms / p95 107 ms, batch strip median 23 ms).

## Deploy

| Step | Gate | Result |
|---|---|---|
| Merge to GitHub `main`, tag `queue-control-a-1` | AP-1 | `main` `8f60669` -> `2b85bc9`, branch `feature/queue-control`, tag `queue-control-a-1` (fast-forward, no force) |
| Pre-flight (read-only, 16:24Z) | - | host `main` `7d49e90` clean; web `dedc7111ef10`, worker `4c2eaf094643`; `schema_migrations` ends `0021` (21); `ocr_batches` owner `ocr_migrator`, FORCE RLS; PENDING 17,639 (priorities 107-208), RUNNING 1, SUCCEEDED 7,112, DEAD 58; 252 batches; 44 GB free |
| Backup + web deploy with migration 0022 (16:41:59-16:44:03Z) | AP-2 | see "AP-2" |
| Reorder dry run (16:44:25Z) | AP-3 | pending 17,632; would change 17,571; backup tables 0 |
| Reorder apply + worker swap (16:56:07-16:58:59Z) | AP-3, AP-4 | see "AP-3 and AP-4"; script summary PASS 15, FAIL 0, WARN 0 |
| User check | UC-A | done; the user accepted Release A on 2026-10-20 |

### AP-2 (backup and web only)

- Backup `/opt/innovera-backups/queue-control-a-20261019/` (mode 700, files mode 600): database dump 13,289,343 bytes,
  sha256 `9d728586245380e51bf26fdadfadbf9dfc85d0bc9366225b07e35710245b5b37`, 179 TOC entries (7 of 7 key tables with
  data); head file, stash list, jobs by status, PENDING jobs by priority bucket (100:81 110:1768 120:3141 130:2992
  140:2698 150:2222 160:1655 170:1174 180:963 190:869 200:70).
- Rollback tags by image id: `deploy-web:pre-queue-control-a` = `dedc7111ef10`, `deploy-worker:pre-queue-control-a` =
  `4c2eaf094643`.
- Host checkout fast-forwarded `7d49e90` -> `2b85bc9` (`git fetch origin`, `merge --ff-only`), tree clean.
- Web build 16:42:05-16:42:37Z (31 readiness probes, 0 non-200: the old web served throughout); new image `0e6e104971a8`.
- Swap from 16:42:37.65Z: 34 probes at 0.5 s, 5 non-200 from 16:42:48.19Z to 16:42:50.56Z, **downtime about 2.4 s**;
  new web container `92274e30c96e`, 0 restarts.
- Verified: `schema_migrations` ends `0022_queue_control` (22); `ocr_batches` FORCE RLS back on; `queue_seq` 1..252, 0
  NULL, 252 distinct; sequence at 253; `queue_control` one row (open, no cap, round 1, 0 done); the four queue
  functions still owned by `ocr_queue_definer`; worker untouched (same container, image, start time, 0 restarts);
  web log one start line, 0 `request_failed`; local and public `/` serve `คิวการอ่าน` and `เริ่มรอบถัดไป`, 0 stale-note
  matches; `/api/queue`, `/api/documents`, `/api/batches` 401 without a session; `deploy/auth-smoke.sh` public PASS 9,
  FAIL 0; 60 s soak 36 probes, 0 non-200.
- Server-side query time (read-only superuser, warm): open-batch read about 57-75 ms; batch strip 3-5 ms; 222 open
  batches.

### AP-3 and AP-4 (reorder, then worker swap; web untouched)

- Guards passed: host `2b85bc9`, web `0e6e104971a8`, worker `4c2eaf094643` (single container), 0022 applied,
  `queue_control` open with no cap, no backup table, ready 200, 44 GB free. Jobs before: PENDING 17,629, RUNNING 1,
  SUCCEEDED 7,129, DEAD 58.
- Worker image built first, 16:56:09-16:56:42Z: `366809a66d70`.
- Reorder apply (`apply=1`, backup `queue_reorder_backup_20261019`): batches numbered 0, **17,568 jobs reordered**,
  17,568 backup rows (dry run said 17,571; difference 3); PENDING total 17,629 unchanged; 0 PENDING jobs off their
  batch's `queue_seq`; 0 batch-less jobs off priority 0; the lowest 20 PENDING jobs all belong to one batch (58 left in
  it); PENDING priorities now 11-252.
- Worker swap 16:56:45Z: new container `fe6655e6a3f7` on `366809a66d70`, running with 0 restarts for 2 minutes, one
  `worker_started` (schema 0022 accepted, concurrency 1), 0 `worker_loop_error`.
- First claim: priority 11 = the lowest PENDING priority = the lowest open batch's `queue_seq`.
- The old worker's in-flight page ended SUCCEEDED (attempt 1 of 3); one `jobs_recovered` event.
- After: `queue_control` still open with no cap (round 1); web container identical; ready 200. Jobs after: PENDING
  17,628, RUNNING 1, SUCCEEDED 7,130, DEAD 58.

### Pins and downtime

- `APPLIED_IN_PRODUCTION` moved to `0022_queue_control` in `test/migration-checksums.test.ts` with this report.
- Downtime: web about 2.4 s at AP-2; the worker swap lost no page (the in-flight page finished).

## Rollback (not used)

On the host in `/opt/innovera-ocr-app/ocr` (scripts piped over ssh; the command line never names the env file):
worker `docker tag deploy-worker:pre-queue-control-a deploy-worker:latest` + `up -d --no-deps worker`; web
`docker tag deploy-web:pre-queue-control-a deploy-web:latest` + `up -d --no-deps web`; code `git reset --hard 7d49e90`.
Reorder revert: `queue-reorder-once.sql` with `-v apply=2 -v backup_date=20261019` (restores priority/available_at of
the jobs still PENDING; the backup table stays). Migration 0022 stays (additive). The dump is for real data damage only,
as its own approved step with the web stopped.

## Known limitations and notes

- N1: exactly one worker process is supported (the round slot count is in-process).
- N2: a stopped or round-full queue also pauses PDF splitting; new uploads show no pages until reading resumes.
- N3: Stop, Resume, N and the round counter are deployment-wide (one row for every organization).
- N4: upload order inside a batch is approximate (enqueue time); a PDF's pages always stay together and in order.
- N5: jobs without a batch have priority 0 and run before every batch.
- A crash between a page's finish and its count loses at most one count per crash.
- The unreleased `ocr-review-ledger` branch also used `0022`; it must renumber when it rebases onto this `main`.
- Out of scope (separate decisions): `OCR_REQUEST_TIMEOUT` 300 to 600; the AI host CPU steal (the real cause of the
  slow rate); the cosmetic `document_runs` RUNNING rows.
- Release B (per-batch Stop/Resume, migration `0023_batch_holds`) is not started.
