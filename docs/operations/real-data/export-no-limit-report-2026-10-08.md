# Export page size up to 500 — production report (2026-10-08)

Commit `38725db` (branch `feature/export-no-limit`, based on `55075ce`) is live on the web. Change: `GET
/api/exports/candidates` accepts `limit` 1..500 (was 1..100; route and the persistence clamp `EXPORT_CANDIDATES_MAX`),
the `ส่งออก` dialog has a `แสดงต่อหน้า` select (50/100/200/500, default 100), and `เลือกทั้งหมด N` is shown whenever
the tab has rows. No SQL, no migration, no env change, safety caps unchanged (5,000 hand-ticked rows,
`OCR_EXPORT_MAX_ROWS` 50,000). The worker was not rebuilt or recreated. Deploy approved by the user on 2026-10-08
(backup + web-image-only deploy + verification). **Not merged to GitHub `main`** and the branch is not pushed; the
annotated tag `export-no-limit-1` (`4aae9a8`, on `38725db`) exists only in the local clone and on the host.
Procedure: the shape of `export-selection-deploy.md` (steps 41, 42, 43, 46, 48), minus the merge and migration
steps. Aggregates only; no customer values and no credentials here.

## Deploy (web only, 2026-10-08, 06:18 to 06:24 UTC / 13:18 to 13:24 Asia/Bangkok)
| Step | Result |
|---|---|
| Pre-flight (read-only) | detached at tag `export-selection-1` @ `36a1810`, tree clean, one pre-existing stash; `deploy-web-1` image `ccec0235b8d4` (container `e0c89176fc2b`, started 2026-10-05T01:40:50Z), `deploy-worker-1` image `4c2eaf094643` (container `f42abceefac3`, started 2026-09-23T08:37:21Z); ready 200; `0021_document_export_marks|21`; 0 documents in `VALIDATING`/`SCANNING`; 79 G free; 16 env keys; shared containers (docketlaw, mysql-db, nginx-proxy, nginx-proxy-letsencrypt, portainer) not touched |
| Diff check | `git diff 36a1810 38725db`: 5 app files under `apps/ocr-web/src` and `packages/ocr-persistence/src` (code + tests), plus the `55075ce` freeze (test + doc); no migration, SQL, Dockerfile, compose or worker file |
| Backup + tags | `/opt/innovera-backups/export-no-limit-20261008/` (mode 700): `head-pre-export-no-limit.txt` (`36a1810…`), `database-pre-export-no-limit.dump` 793,048 bytes (mode 600; custom format, gzip, PostgreSQL 17.6, 183 TOC entries; `audit_events`, `document_export_marks`, `documents`, `schema_migrations`, `users` data present), sha256 `6c576c9389b69548…`; image tags `deploy-web:pre-export-no-limit` `ccec0235b8d4`, `deploy-worker:pre-export-no-limit` `4c2eaf094643` (courtesy, worker not recreated) |
| Code to host | `git bundle` of `feature/export-no-limit` + tag `export-no-limit-1` (complete history, sha256 `98257f18a89f8213…`) copied by `scp` into the backup dir; `git fetch <bundle> refs/tags/export-no-limit-1`; `git checkout export-no-limit-1` → detached at `38725db`, tree clean |
| Build | `build web` 35 s (06:19:33 to 06:20:08Z) while the old web served (ready 200 during the build); new image `deploy-web:latest` `831c56dbf8ca` |
| Swap | `up -d --no-deps web` 06:20:34 to 06:20:45Z; readiness probe every 0.5 s: 3 non-200 probes (06:20:44.6 to 06:20:46.7Z), **downtime about 2 to 3 s**; new container `fbc8ce8b30c9`, started 06:20:44Z, 0 restarts |
| Worker | container `f42abceefac3`, image `4c2eaf094643`, `StartedAt` 2026-09-23T08:37:21Z: identical before and after; 0 `worker_started` since the deploy |
| Health | `/health/ready` 200, `/health/live` 200 (still 200 at 06:23:45Z); migrations still `0021_document_export_marks|21` |
| Markup (public `/`, no session) | 200; `id="ex-size"` 1; options 50/100/200/500 each 1, `100` `selected`; `const EX_SIZES=[50,100,200,500]` present, old `EX_PAGE=50` absent; always-visible select-all condition (`offer=!state.exAll&&total>0`) present; local `127.0.0.1:53100/` serves the same |
| Smoke (no credentials) | `auth-smoke.sh https://ocr.innoveraappcenter.com` `PASS=9 FAIL=0`; `GET /api/exports/candidates?limit=500` 401 (public and local), plain `GET /api/exports/candidates` 401; `POST /api/exports/marks` 403 without Origin, 401 same-origin; `POST /api/exports/documents.csv` 401 |
| Web logs (06:20:44 to 06:23:45Z) | 1 line (the `tsx src/server.ts` start banner); 0 `request_failed`, 0 error/warn, 0 uncaught |

No user was created, no password changed, no export or mark was triggered against real data.

## Rollback (not used)
On the host, in `/opt/innovera-ocr-app/ocr`, with `C="docker compose --env-file /etc/innovera/ocr-compose.env -f
deploy/docker-compose.yml"` (run as a piped script; the command line must not name the env file):

```sh
docker tag deploy-web:pre-export-no-limit deploy-web:latest      # ccec0235b8d4
$C up -d --no-deps web
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:53100/health/ready   # 200
git checkout export-selection-1                                  # 36a1810, the checkout matches the image again
```

Nothing in the database changed, so the dump is only a precaution; restore it only on data damage, as its own approved
step with the web stopped.

## Not verified / open items
1. **Logged-in browser check (user):** open `ส่งออก`; the list shows 100 rows by default and `แสดงต่อหน้า` offers
   50/100/200/500; choose 500 and confirm the page loads (no `INVALID_EXPORT_RANGE` / 400); confirm `เลือกทั้งหมด N
   แถวที่ตรงกับตัวกรอง` is visible without ticking the whole page. Downloading is optional (it marks rows as exported).
2. The authenticated `limit=500` path itself (rows returned, response time with 500 rows) was not exercised: no
   session was used.
3. `38725db` and the tag are not on GitHub. Merging `feature/export-no-limit` into `main` (and pushing the tag) needs
   its own approval; until then the durable copies are the local clone and the bundle in the host backup dir.
4. Open items carried from 2026-10-05: step 49 counts-only checks, `sample2.png` keep-or-delete.
