# Full-document OCR + batch upload — production rollout runbook

Branch `feature/full-document-batch`. Order: inspect → Local AI side-by-side test → Local AI swap → app deploy
(migration 0017 at web startup) → worker → browser E2E → merge to `main`. Every step that changes production is
marked **[CHANGE]** and needs operator approval before it runs. SSH uses key `~/.ssh/innovera_codex`.

## A. Read-only inspection

Application VPS `72.61.123.78` (`/opt/innovera-ocr-app/ocr`):

- Backup from 2026-09-21 is complete and valid: `ls -la /opt/innovera-backups/full-document-20260921/`
  (`app-source-before.tar.gz`, `production-hotfixes.patch`, `database-before.dump` non-empty;
  `pg_restore --list database-before.dump | head`), image tags `innovera-ocr-{web,worker}:before-full-document-20260921`.
- Source unchanged since the snapshot: `git status --short`, `git log -1` = `4004ff0`, and the working tree
  matches commit `845a053` of this branch (no newer hotfixes).
- Database, as `ocr_bootstrap`: table owners (`pg_tables`), `documents` grants for `ocr_app`/`ocr_worker`
  (table-level UPDATE), owners of the 8 `ocr_*` functions, `ocr_queue_definer` privileges on
  `ocr_confirm_outbox`, `schema_migrations` (0001–0016), document counts by status and structured_result shape.
- Compose env keys only (never values): `OCR_API_BASE_URL`, `OCR_WEB_TENANT_ID`, `OCR_PUBLIC_BASE_URL`, worker
  settings. `OCR_WEB_AUTO_AUTH` was deleted in Release 2 (`real-data/release2-deploy.md`).
- Gateway routing for the worker's health probe: `curl -s -o /dev/null -w '%{http_code}' <OCR_API_BASE_URL>/health`
  (404 is tolerated by the worker, 200 preferred).

Local AI VPS `187.53.143.23` (`/opt/innovera-ocr`):

- Backup `/opt/innovera-backups/full-document-20260921/ocr-before.tar.gz` exists and lists.
- `docker inspect innovera-ocr-api` (image, mounts, port, restart policy, env), Ollama service env
  (`OLLAMA_KEEP_ALIVE`, `OLLAMA_NUM_PARALLEL`), GPU/RAM headroom, `pypdfium2`/`numpy` inside the image.
- Baseline v2.2 latency: 3 warm `POST /v1/ocr` with `sample2.png` on `127.0.0.1:5000`.

## B. Local AI side-by-side test (live service untouched)

1. **[CHANGE]** Copy `local-ai/` to `/opt/innovera-ocr-v3/` with a *copy* of `verified_dataset/` (tests must not write
   the live memory) and an empty `uploads/`.
2. **[CHANGE]** Start `innovera-ocr-api-v3` from the same image as the live container on `127.0.0.1:5001`, same Ollama.
3. Compare v3 against v2.2 on `sample.png`/`sample2.png` and a few documents from `uploads/`: staff fields must match
   v2.2; read `evidence.customerCropRaw` / `staffCropRaw` to validate the customer prompt and parsing against the real
   model; record `timings` (sequential vs parallel section calls). Tune locally (tests stay green), recopy, repeat.
4. If `inferenceWallMs ≈ inferenceMs`, Ollama serialises: either accept ~2 model calls per document or set
   `OLLAMA_NUM_PARALLEL=2` (**[CHANGE]**, only if memory allows; restarts Ollama → one cold load).

## C. Local AI swap **[CHANGE]**

Back up `/opt/innovera-ocr/{api.py,master_data.json}` again, copy the tested v3 files into `/opt/innovera-ocr/`
(keeping the live `verified_dataset/` and `uploads/`), restart `innovera-ocr-api`, verify `GET /health`
(`version 3.0`, `status ok`) and one `POST /v1/ocr`. v3 keeps every v2.2 field, so the running v2.2 app keeps working.
Rollback: restore the backed-up files and restart (seconds). Remove `innovera-ocr-api-v3` and `/opt/innovera-ocr-v3`.

## D. Application deploy **[CHANGE]**

1. Fresh backup right before: `pg_dump -Fc` to `/opt/innovera-backups/full-document-<date>/database-pre-0017.dump`,
   tag current images `innovera-ocr-{web,worker}:pre-0017`.
2. Push the branch to GitHub; on the VPS keep the uncommitted hotfixes as a patch (already in `845a053`), then check out
   the branch (`git stash` → `git fetch origin` → `git checkout feature/full-document-batch`).
3. `docker compose --env-file /etc/innovera/ocr-compose.env -f deploy/docker-compose.yml build web worker`.
4. `up -d --no-deps web` — web applies 0017 as `ocr_migrator` at startup (additive: new table, nullable columns,
   FK on an all-NULL column, 3 indexes; brief lock on `documents`). Check logs, `/health/live` and `/health/ready` = 200.
   Run `deploy/sql/queue-definer.sql` as bootstrap only if inspection shows ownership drift (idempotent).
5. `up -d --no-deps worker` (`OCR_WORKER_CONCURRENCY` default 2). PostgreSQL, ClamAV and Prometheus containers and
   volumes are not recreated.
Rollback: `docker tag …:pre-0017` back to the compose image names and `up -d --no-deps web worker`; 0017 is additive,
so the previous code runs unchanged on the migrated schema. Database restore only if data is damaged.

## E. Production E2E (browser)

Open `https://ocr.innoveraappcenter.com`, upload batches of 1, 5 and 10 sample documents (batch label "E2E test"),
confirm rows, statuses, counters and needs-review highlighting, open the review drawer, edit + confirm one therapist,
verify outbox delivery (`deliveryStatus` DELIVERED), retry a deliberately failing file, and record per-document
inference/total time and batch throughput from `timings` and `GET /api/batches/:id`. Test documents remain in the
tenant (there is no delete endpoint); their batch label identifies them.

## F. Git

Merge `feature/full-document-batch` into `main` (fast-forward or merge commit) and push to `origin/main`.
Never commit `ssh.env`, `connect-*.command`, compose env files or fixtures.
