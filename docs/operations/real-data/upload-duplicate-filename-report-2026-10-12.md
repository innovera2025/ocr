# Duplicate file-name upload rule: merge into GitHub `main` and production web deploy (2026-10-12)

Plan: `upload-duplicate-filename_PLAN_10-10-26.md`, Phase 5. Approved by the user on 2026-10-12 ("อนุมัติ"): fast-forward
GitHub `main` to tag `upload-duplicate-filename-2` (`810cc16`), push the tags and the branch, and deploy production web
only from `main`, with a backup, verification and rollback on failure. Nothing else: no migration, no worker or Local AI
change, no env change; `feature/review-ledger` and the handwriting branch were not touched; the shared host containers
(docketlaw, mysql-db, portainer, nginx-proxy, nginx-proxy-letsencrypt) were not touched. Aggregates only; no customer
values, no file names and no credentials here.

## What shipped

A new upload whose canonical file name (NFC, control/bidi characters stripped, whitespace runs collapsed to one space,
edge spaces trimmed, lowercased; the extension is part of the name) equals that of an existing top-level, non-deleted
document of the same organization is refused with `409 DUPLICATE_FILENAME` and the five fields of the oldest existing
match (`documentId`, `filename`, `uploadedAt`, `statusCategory`, `retryable`). The check runs inside the upload
transaction under a per-name advisory lock taken after the batch lock. A new `POST /api/documents/name-check` lets the
browser mark duplicates at selection time (of the system, of the same selection, or of the upload queue) and keep them
out of the batch total; if the pre-check fails, the upload proceeds and the server rule decides. An idempotent retry
(same `Idempotency-Key`) still answers the original upload. Legacy duplicates already in the database are untouched.

## Merge (fast-forward, no merge commit)

| Item | Result |
|---|---|
| GitHub `main` before | `bd33d31` (`git ls-remote`, checked before the gate and again right before the push) |
| Ancestry | `bd33d31` -> `7fcc7e7`, `52350dd`, `cb51ebb`, `cb7b163`, `810cc16` (5 commits, linear) |
| Push | `git push github main` -> `bd33d31..810cc16`, normal push, no force |
| Also pushed | branch `feature/upload-duplicate-filename` (`810cc16`); annotated tags `upload-duplicate-filename-1` (-> `cb7b163`) and `upload-duplicate-filename-2` (-> `810cc16`) |
| GitHub `main` after | `810cc16` (`git ls-remote`), before this report commit |

## Code gates (on `810cc16`, the exact commit pushed)

`pnpm typecheck` exit 0; `pnpm lint` exit 0; `pnpm test` with the DB suite enabled (throwaway `postgres:17.6`,
container `ocr-it-pg-dupmain`, `127.0.0.1:55446`, `datcollate`/`datctype` `en_US.utf8`; removed afterwards; no existing
container used, `deploy-postgres-1` and `ocr-it-pg-export` StartedAt unchanged): **590 tests / 590 pass / 0 fail**
(runner summary `skipped 0`; the poppler renderer suite is marked SKIP at suite level because poppler-utils is not
installed on the gate machine, as in earlier runs). The DB suite "batch processing against PostgreSQL as the runtime
roles" ran with 62 top-level tests, including all 12 "upload filename rule" tests (rule, variants, 8-way concurrency,
split PDF, status sweep, deleted rows, tenancy, idempotency, batch accounting, pre-check alignment, JS/SQL parity,
20,000-row timing). The known flaky queue test (`queue: expired leases are recovered ...`) passed on the first run; no
re-run was needed. `test/migration-checksums.test.ts` 2/2 pass (`APPLIED_IN_PRODUCTION = "0021_document_export_marks"`).
Inline workbench script: 119,017 characters, parses with `new Function`, no backtick, no `${`.

Timing at 20,000 top-level documents (container, inside the full parallel `pnpm test` run): miss 317.0 ms, hit 14.4 ms,
100-name pre-check 444.7 ms (bounds 500 ms / 1 s). Standalone DB-suite runs on 2026-10-10 measured miss 60-71 ms, hit
7-11 ms, 100-name check 65-80 ms; today's higher numbers are contention from the parallel run. Production has 7,318
top-level rows (below the 20,000 measured).

Diff from the running `1b425c3` (`git diff 1b425c3 upload-duplicate-filename-2 --stat`): 14 files, +955/-31: the 13
planned Touchpoints files (`packages/ocr-persistence/src/{filename-key.ts, filename-key.vectors.ts, filename-key.test.ts,
index.ts, batch.db.test.ts}`, `packages/ingest/src/{index.ts, service.test.ts, http.test.ts}`,
`apps/ocr-web/src/{server.ts, server.test.ts, workbench.ts, workbench.test.ts, workbench.behaviour.test.ts}`) plus the
docs report `main-merge-report-2026-10-08.md`. Nothing under `prisma/`, `services/`, `local-ai/`, `deploy/`, no
Dockerfile or compose change, no new migration.

## Pre-flight (read-only, 02:29Z)

| Check | Result |
|---|---|
| Host checkout | `/opt/innovera-ocr-app/ocr` branch `main` at `1b425c3`, tree clean, one pre-existing stash; `origin` = GitHub, `ls-remote` saw `main` = `810cc16` |
| Containers | `deploy-web-1` `a4b28994ea18`, image `85a45cd55b12`, started 2026-10-08T09:51:34.757Z, 0 restarts; `deploy-worker-1` `f42abceefac3`, image `4c2eaf094643`, started 2026-09-23T08:37:21.491183734Z, 0 restarts |
| Health | local ready/live 200, public ready/live 200 |
| Migrations | `0021_document_export_marks`, 21 rows |
| In-flight | 0 documents in `VALIDATING`/`SCANNING` |
| Disk | 54 G free of 96 G (45 % used) |
| Collation (D4) | `innovera_ocr`: `datcollate` `en_US.utf8`, `datctype` `en_US.utf8`, provider libc, UTF8. `documents.filename`: `information_schema` `collation_name` NULL (database default), `pg_attribute` collation `default`. **Not `C`/`POSIX`**: SQL `lower()` is Unicode-aware (`lower('É') = 'é'` checked on production); the only known differences from JavaScript are the documented JS-only vectors (`İ`, word-final capital sigma) |
| Key pattern | the D3 whitespace pattern written as a `U&` literal on the host hashes (md5 of its UTF-8 bytes) to the same value as `FILENAME_KEY_SQL_WS_PATTERN` in the code (`5ba99985…`) |

### Legacy duplicates (counts only, D3 key, per organization; read-only transaction)

| Measure | Value |
|---|---|
| Top-level, non-deleted rows | 7,318 |
| Distinct canonical keys | 7,185 |
| Keys with more than one row | 132 |
| Rows in those groups | 265 |
| Largest group | 3 |

All in one organization. These stay as they are; the rule applies to new uploads only. A new upload with any of those
132 names is refused and the oldest row of the group is reported.

## Deploy (web only, 02:30 to 02:36 UTC / 09:30 to 09:36 Asia/Bangkok)

| Step | Result |
|---|---|
| Backup | `/opt/innovera-backups/upload-duplicate-filename-20261012/` (mode 700): `head-pre-upload-duplicate-filename.txt` (HEAD and `main` `1b425c3…`, branch `main`), `stash-list-pre-upload-duplicate-filename.txt` (1 line), `database-pre-upload-duplicate-filename.dump` 7,010,756 bytes (custom format, 179 TOC entries; `audit_events`, `document_export_marks`, `documents`, `schema_migrations`, `users` data present), sha256 `770fe09e618fadaa…` (full hash in `.sha256` beside it), `toc.txt`; dump files mode 600. `pg_dump` ran with `< /dev/null` on the `exec -T` |
| Image tags | `deploy-web:pre-upload-duplicate-filename` = `85a45cd55b12` (the running web image); courtesy `deploy-worker:pre-upload-duplicate-filename` = `4c2eaf094643` (worker not rebuilt or recreated) |
| Code to host | `git fetch origin` from GitHub (`1b425c3..810cc16`, new branch and both tags); `git merge --ff-only origin/main` on branch `main` -> `810cc16`, tree clean, stash list byte-identical to before |
| Build | `build web` 02:31:29 to 02:31:58Z (29 s); 27 readiness probes during the build, 0 non-200 (the old container served throughout); new `deploy-web:latest` `a0266415c4e6` |
| Swap | `up -d --no-deps web` from 02:31:58Z; readiness probe every 0.5 s: 36 probes, 6 non-200 (02:32:09.077 to 02:32:12.057Z), **downtime about 3 s**; new container `8628946a89f4`, image `a0266415c4e6`, started 02:32:09.591Z, 0 restarts |
| Worker | `Id Image StartedAt RestartCount` string-compared before the code step, right after the swap, and after the soak: equal each time (`f42abceefac3…`, `4c2eaf094643…`, 2026-09-23T08:37:21.491183734Z, 0); 0 `worker_started` since the swap |
| Health | 3-minute soak 02:32:56 to 02:35:58Z, 36 probe sets (local ready, local live, public ready, public live), 0 non-200; migrations still `0021_document_export_marks|21` |
| Markup (public `/` and local `/`, no session, 191,158 bytes each) | `dupText` 4, "ลองอ่านอีกครั้ง" 3, "ไฟล์ชื่อนี้มีในระบบแล้ว" 2, "ซ้ำกันในรายการที่เลือก" 1, "มีไฟล์ชื่อนี้อยู่ในคิวอัปโหลดแล้ว" 1, `/api/documents/name-check` 2, `DUPLICATE_FILENAME` 4, "ดูเอกสารเดิม" 2, the dropzone help sentence 1 |
| Endpoints without a session (public and local) | `POST /api/documents/name-check` and `POST /api/documents`: 403 without an `Origin` header (the cross-origin guard runs first), **401 with a same-origin `Origin`**; `GET /api/documents` 401 |
| Smoke (no credentials) | `deploy/auth-smoke.sh https://ocr.innoveraappcenter.com` `PASS=9 FAIL=0` |
| Web logs since 02:31:58Z | 1 line (the `tsx src/server.ts` start banner); 0 `request_failed`, 0 error/warn |
| Host after | branch `main` at `810cc16`, tree clean, stash count 1; shared containers still up, untouched |

No file was uploaded, no user created, no password changed, no review saved, no export or mark triggered.

## Rollback (not used)

On the host, in `/opt/innovera-ocr-app/ocr`, with `C="docker compose --env-file /etc/innovera/ocr-compose.env -f
deploy/docker-compose.yml"` (run as a piped script; the command line must not name the env file; give every
`$C exec -T` a `< /dev/null`):

```sh
docker tag deploy-web:pre-upload-duplicate-filename deploy-web:latest   # 85a45cd55b12
$C up -d --no-deps web
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:53100/health/ready   # 200
git reset --hard 1b425c3                                                 # host branch main back to the recorded head
```

The rule writes no rows, so there is no data change to undo; the dump is a precaution only, to restore only on data
damage as its own approved step with the web stopped. GitHub `main` can be reverted with a new revert commit (never a
force-push) if the user asks.

## Ledger branch note

`feature/review-ledger` (tip `a59b64a`, forked from `55075ce`) was not touched. The read-only `git merge-tree` from
2026-10-10: on top of the conflicts `main` already has with the ledger (`ocr-persistence/src/index.ts`,
`batch.db.test.ts`, `document-view.test.ts`), this work adds keep-both hunks in `server.ts` (one optional
`WorkbenchStore.findFilenameDuplicates` member next to the ledger's `saveReview` change), `server.test.ts` (3) and
`index.ts` (the `filename-key.js` import). The ledger's `createUploadedDocument` is unchanged, so nothing needs porting.

## State after

- GitHub `main` = this report commit on top of `810cc16` (fast-forward). The host stays on branch `main` at `810cc16`,
  the commit the running image was built from; it is one docs-only commit behind `origin/main`, which needs no rebuild.
- Local backup bundle: `backups/ocr-main-2026-10-12.bundle` (all branches and tags of the clone, including `main`).

## Not verified / open items

1. **Logged-in check (plan step 5.11, the user runs it):** select a file whose name already exists -> an immediate
   "ไฟล์ชื่อนี้มีในระบบแล้ว" row and nothing uploaded; the same file renamed uploads; `X.pdf` and `x.PDF` selected
   together -> one uploads; a failed existing document -> the message mentions "ลองอ่านอีกครั้ง". The authenticated
   name-check and the 409 path were not exercised on production.
2. The 132 legacy duplicate groups stay; a later cleanup would be its own plan.
3. If top-level rows grow past about 100,000, add an expression index for the key through a future migration
   (backlog; not needed at 7,318).
4. The flaky queue test (ms vs microsecond clock) remains a backlog item; it passed today.
5. `feature/review-ledger` still needs its rebase onto `main` before it can ship (now including this work); its own
   approval.
