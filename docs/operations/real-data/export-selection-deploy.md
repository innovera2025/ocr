# Export selection deploy runbook (migration 0021, web only)

Source of truth: the harness plan `export-selection_PLAN_02-10-26.md`, Phase 5 (steps 41 to 51). This file is the
operator's copy: what to run, in what order, and what each step must print. Structure and conventions follow
`release2-deploy.md`.

Everything on the app VPS runs in `/opt/innovera-ocr-app/ocr`. Set the aliases once per shell:

```sh
C="docker compose --env-file /etc/innovera/ocr-compose.env -f deploy/docker-compose.yml"
RO="-e PGOPTIONS=-cdefault_transaction_read_only=on"     # read-only sessions for every check query
q() { $C exec -T $RO postgres psql -U ocr_bootstrap -d innovera_ocr -AtX -c "$1" </dev/null; }
D=/opt/innovera-backups/export-selection-<YYYYMMDD>
```

`</dev/null` matters when these lines are piped into `ssh … bash -s`: without it `exec -T` swallows the rest of the
script from stdin. Steps marked **[CHANGE]** need the user's approval first, one approval per step. Every command
prints keys, counts, hashes or status codes, never a value. Deploy outside spa hours.

## What this deploy changes

- Migration `0021_document_export_marks` (additive: one append-only table, FORCE RLS, one index, `GRANT SELECT,
  INSERT` to `ocr_app` only; no function, no backfill, no existing table altered). Applied by the web at startup as
  `ocr_migrator`.
- The **web** image: `GET /api/exports/candidates`, `POST /api/exports/documents.{csv,jsonl}` (marks the streamed rows
  after a complete download), `POST /api/exports/marks` (manual mark/unmark), and the `ส่งออก` dialog as a selectable,
  paged list with the ยังไม่เคย Export / Export แล้ว / ทั้งหมด tabs. The CSV/JSONL columns do not change, and
  `GET /api/exports/documents.{csv,jsonl}` keeps working and marks nothing.
- **W3a rides along** (tell the user before approval): `main` carries `94d89a7` after `ee0a769`; the only app-side
  file that differs is `packages/ocr-persistence/src/document-view.ts`. A flagged field a reviewer only accepts (not
  edits) no longer writes an `ocr_corrections` or `ocr_confirm_outbox` row; an edited field still does. Nothing
  visible changes for staff.
- **The worker is not rebuilt or recreated** (it requires `0020_batch_round_clock` and ignores the new table).
  No env change: no new variable, `OCR_EXPORT_MAX_ROWS` stays at the compose default of 50000.

## 0. Merge and tag (GitHub, before anything on the VPS) [CHANGE]

From the working clone, only after the user approves the merge. Fast-forward only, never `--force`:

```sh
cd /tmp/ocr-export-selection
git fetch origin
git rev-parse origin/main                                   # must still print ac25e36ca9f808f39bc0d178438fad01738a8da8
git merge-base --is-ancestor origin/main feature/export-selection && echo ff-ok
git push origin feature/export-selection:main               # fast-forward; GitHub closes the PR as merged
git tag -a export-selection-1 -m "Export selection and export history (migration 0021)" feature/export-selection
git push origin export-selection-1
git bundle create /Users/innovera/Documents/OCR/backups/ocr-export-selection.bundle main feature/export-selection export-selection-1
```

If `origin/main` moved, stop: rebase and re-run the gates on a new head instead of merging blind.

## 41. Read-only drift check (recorded 2026-10-05, re-run on the deploy day)

```sh
git status --short; git log -1 --format=%H; git branch; git diff ee0a769 --stat; git stash list
$C ps; $C images web worker
q "SELECT max(version), count(*) FROM schema_migrations"
q "SELECT pg_get_userbyid(proowner), count(*) FROM pg_proc WHERE proname LIKE 'ocr%' GROUP BY 1 ORDER BY 1"
$C exec -T $RO postgres psql -U ocr_bootstrap -d innovera_ocr -AtX -f - < deploy/sql/verify-release2-grants.sql
df -h /; grep -oE '^[A-Z_]+=' /etc/innovera/ocr-compose.env | sort
```

Expected (as recorded on 2026-10-05): HEAD `ee0a7698dd8814c2597d2102c3a33ae1a34671f8` on `release2b`; `git diff
ee0a769 --stat` empty; `git status --short` shows only `?? sample2.png` (untracked, outside every `COPY` of
`Dockerfile.web`, untouched by a checkout); one stash `stash@{0}` (production hotfixes before the full-document
deploy, content `845a053`, pre-existing); `deploy-web-1` image `deploy-web:latest` `f2f8020c90d2` built
2026-09-23T08:36:27Z, `deploy-worker-1` image `deploy-worker:latest` `4c2eaf094643` built 2026-09-23T08:35:53Z (both
after the `ee0a769` commit at 08:22:51Z); `0020_batch_round_clock|20`; `ocr_migrator|1`, `ocr_queue_definer|7`;
grant check `SUMMARY PASS=20 SKIP=0 FAIL=0` (the copy at `ee0a769` has no 0021 checks); 81 GB free; 16 env keys.
**Any different HEAD, a non-empty diff, a new stash or a different migration: stop and re-plan.**

## 42. Backup and tags [CHANGE]

```sh
install -d -m 700 "$D"
git rev-parse HEAD > "$D/head-pre-export-selection.txt"
$C exec -T postgres pg_dump -U ocr_bootstrap -d innovera_ocr -Fc > "$D/database-pre-0021.dump"
$C exec -T postgres pg_restore --list < "$D/database-pre-0021.dump" | head -3       # the archive header
ls -la "$D/database-pre-0021.dump" | awk '{print $5}'                                # > 0 (the 0020 dump was ~160 KB)
docker tag deploy-web:latest innovera-ocr-web:pre-export-selection                   # f2f8020c90d2
docker tag deploy-worker:latest innovera-ocr-worker:pre-export-selection             # 4c2eaf094643 (courtesy)
docker images --format '{{.Repository}}:{{.Tag}} {{.ID}}' | grep pre-export-selection
```

## 43. Check out the release [CHANGE]

```sh
git fetch origin --tags
git checkout export-selection-1
git log -1 --format=%H          # the tag's commit
git status --short              # still only ?? sample2.png
```

Do **not** run `production-preflight.sh` or `go-live-check.sh` before step 46: their migration check applies pending
migrations from the host.

## 44. Env (read-only)

`grep -oE '^[A-Z_]+=' /etc/innovera/ocr-compose.env | sort` must print the same 16 keys as in step 41. No edit.

## 45. Quiet moment (read-only)

```sh
q "SELECT count(*) FROM documents WHERE status IN ('VALIDATING','SCANNING')"     # 0, otherwise wait
```

## 46. Web only [CHANGE]

```sh
$C build web                     # the old web keeps serving while this runs
$C up -d --no-deps web           # downtime starts here; 0021 is applied at startup as ocr_migrator
```

Checks:

```sh
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:53100/health/ready              # 200 (retry for ~60 s)
q "SELECT max(version), count(*) FROM schema_migrations"                                  # 0021_document_export_marks|21
q "SELECT relname, pg_get_userbyid(relowner), relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'document_export_marks'"
#   document_export_marks|ocr_migrator|t|t
q "SELECT pg_get_userbyid(proowner), count(*) FROM pg_proc WHERE proname LIKE 'ocr%' GROUP BY 1 ORDER BY 1"
#   ocr_migrator|1 and ocr_queue_definer|7, unchanged
q "SELECT count(*) FROM document_export_marks"                                            # 0 (every row starts as never exported)
$C logs --since 5m web | grep -c request_failed                                           # 0
docker inspect deploy-worker-1 --format '{{.State.StartedAt}}'                            # 2026-09-23T08:37:21…, unchanged
$C logs --since 5m worker | grep -c worker_started                                        # 0 (not restarted)
```

**Do not build or recreate the worker.**

## 47. Grant check (read-only)

```sh
$C exec -T $RO postgres psql -U ocr_bootstrap -d innovera_ocr -AtX -f - < deploy/sql/verify-release2-grants.sql
#   SUMMARY PASS=27 SKIP=0 FAIL=0
```

The seven 0021 checks (`app:select-insert-export-marks` … `force-rls:export-marks`) now answer instead of skipping.
Record the real line in the deploy report.

## 48. Smoke (no credentials)

```sh
./deploy/auth-smoke.sh https://ocr.innoveraappcenter.com                                       # every check PASS, FAIL=0
curl -s -o /dev/null -w '%{http_code}\n' https://ocr.innoveraappcenter.com/api/exports/candidates   # 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'content-type: application/json' --data '{}' \
  https://ocr.innoveraappcenter.com/api/exports/marks                                          # 401 or 403, never 200
```

## 49. User acceptance on production

The user, in their own browser (exports never leave it, never reach git or chat): open `ส่งออก`; read "ยังไม่เคย
Export (96)" and "Export แล้ว (0)" (subject to the data on the day); tick 2 rows and download, open the CSV locally;
the 2 rows move to Export แล้ว; select all remaining → `ทำเครื่องหมายว่า Export แล้ว`; un-mark one to confirm the loop.
Counts only:

```sh
q "SELECT kind, source, count(*) FROM document_export_marks GROUP BY 1,2 ORDER BY 1,2"
q "SELECT action, count(*) FROM audit_events WHERE action LIKE 'export.%' GROUP BY 1 ORDER BY 1"   # completed/failed for every started
curl -s 127.0.0.1:53100/metrics | grep -E 'export_marks_total|export_marked_rows_total|exports_total'
```

## 50. Freeze (after the user confirms) [CHANGE: push]

Small commit on `main`: `APPLIED_IN_PRODUCTION = "0021_document_export_marks"` in `test/migration-checksums.test.ts`
(and the comment on the 0021 pin), plus `docs/operations/real-data/export-selection-report-<date>.md`; `pnpm test`
green; push with approval. From then on a fix to 0021 takes migration 0022.

## Rollback (web only; the table stays)

```sh
docker tag innovera-ocr-web:pre-export-selection deploy-web:latest
$C up -d --no-deps web
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:53100/health/ready              # 200
git checkout release2b                                                                     # the checkout matches the image again
```

- `0021` stays applied: it is additive, and the old web's migration runner iterates only the files its own image
  carries. The history rows remain and come back with the new web. The worker never changed.
- The dialog reverts to Release 2 (export all matching, 20-row preview); W3a reverts with the old image.
- **Restore `database-pre-0021.dump` only if data was damaged** (an additive migration damages nothing), and only
  as its own approved step with the web stopped; never recreate the postgres volume.
- If the migration fails at startup: the runner's transaction rolled back and the new web did not become ready.
  Retag and recreate from `innovera-ocr-web:pre-export-selection` as above, fix `0021` (still unfrozen), regenerate its
  pin, and redo from step 42.

## Downtime

Only the web is down, from `up -d --no-deps web` until `/health/ready` answers 200: the old container's stop (up to the
10 s grace), the new container's start and the one-table migration. Expect about 15 to 60 seconds. The build runs
before that with the old web still serving. Uploads in flight at that moment fail and are retried by staff; the
worker keeps running throughout.
