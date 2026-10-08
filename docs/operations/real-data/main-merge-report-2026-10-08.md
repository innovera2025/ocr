# Merge of today's work into GitHub `main` and production deploy from `main` (2026-10-08)

The three releases shipped on 2026-10-08 (`export-no-limit-1`, `review-others-sort-1`, `export-full-confidence-1`) are
now on GitHub `innovera2025/ocr` `main`, and production web runs from branch `main`. Approved by the user on
2026-10-08 ("merge แล้ว Deploy เลย"): merge into `main` and deploy production from `main`, nothing else. No worker or
Local AI change, no migration, no env change; `feature/review-ledger` and the handwriting branch were not touched.
Aggregates only; no customer values and no credentials here.

## Merge (fast-forward, no merge commit)

| Item | Result |
|---|---|
| GitHub `main` before | `55075ce` (checked with `git ls-remote` right before the push) |
| Ancestry | `55075ce` is an ancestor of `1b425c3`; 12 commits, linear: `38725db`, `dd1500f` (export-no-limit) -> `a93e2bc`..`f815f97`, `c8ba60d` (review-others-and-sort) -> `6ea3db4`..`059efd3`, `1b425c3` (export-full-confidence) |
| Push | `git push github 1b425c3:refs/heads/main` -> `55075ce..1b425c3`, normal push, no force |
| Also pushed | branches `feature/export-no-limit` (`dd1500f`), `feature/review-others-and-sort` (`c8ba60d`), `feature/export-full-confidence` (`1b425c3`); annotated tags `export-no-limit-1` (-> `38725db`), `review-others-sort-1` (-> `f815f97`), `export-full-confidence-1` (-> `059efd3`) |
| GitHub `main` after | `1b425c3` (`git ls-remote`), before this report commit |

## Code gates (on `1b425c3`, the exact commit pushed)

`pnpm typecheck` exit 0; `pnpm lint` exit 0; `pnpm test` with the DB suite enabled (throwaway `postgres:17.6`,
container `ocr-it-pg-main`, `127.0.0.1:55445`, removed afterwards; no existing container used):
**556 tests / 556 pass / 0 fail / 0 skipped**, the DB suite "batch processing against PostgreSQL as the runtime
roles" ran; `test/migration-checksums.test.ts` 2/2 pass. Code difference from the running `059efd3`: one file,
`docs/operations/real-data/export-full-confidence-report-2026-10-08.md` (docs only).

## Deploy (web only, 09:49 to 09:56 UTC / 16:49 to 16:56 Asia/Bangkok)

| Step | Result |
|---|---|
| Pre-flight (read-only) | detached at tag `export-full-confidence-1` @ `059efd3`, tree clean, one pre-existing stash; host local `main` at `32e75e4` (an ancestor of `1b425c3`); `deploy-web-1` image `4f52bb186b81` (container `a847251aea36`, 0 restarts), `deploy-worker-1` image `4c2eaf094643` (container `f42abceefac3`, started 2026-09-23T08:37:21.491Z, 0 restarts); ready/live/public 200; 74 G free; the host reaches GitHub (`ls-remote` saw `main` = `1b425c3`); shared containers (docketlaw, mysql-db, nginx-proxy, nginx-proxy-letsencrypt, portainer) not touched |
| Backup | `/opt/innovera-backups/main-1b425c3-20261008/` (mode 700, files 600): `head-pre-main.txt` (`059efd3…`, local main `32e75e4…`), `stash-list-pre-main.txt`, `database-pre-main.dump` 1,065,180 bytes (custom format, 179 TOC entries; `audit_events`, `document_export_marks`, `documents`, `schema_migrations`, `users` data present), sha256 `7e3ec6e72ce79055…` (full hash in `.sha256` beside it), `toc.txt` |
| Image tag | `deploy-web:pre-main-1b425c3` = `4f52bb186b81` (the image that was running) |
| Code to host | `git fetch origin` from GitHub (no bundle needed); `origin/main` = `1b425c3`; `git checkout main` + `git merge --ff-only origin/main` -> branch `main` at `1b425c3`, tracking `origin/main`, tree clean, stash list byte-identical to before |
| Build | `build web` 09:50:20 to 09:50:43Z (23 s); new `deploy-web:latest` `85a45cd55b12` |
| Image content | a new image ID (rebuild), but the app is **byte-identical**: sha256 of every file under `/app` in both images, 4,536 files each, differs only in two pnpm install-state files (`node_modules/.modules.yaml`, `node_modules/.pnpm-workspace-state-v1.json`); docs are not in the image |
| Swap | `up -d --no-deps web` 09:51:24 to 09:51:35Z; readiness probe every 0.5 s: 31 probes, 2 non-200 (09:51:34.7 and 09:51:35.3Z), **downtime about 1 s**; new container `a4b28994ea18`, image `85a45cd55b12`, started 09:51:34.757Z, 0 restarts |
| Worker | `Id Image StartedAt RestartCount` string-compared before and after the swap: equal (`f42abceefac3…`, `4c2eaf094643…`, 2026-09-23T08:37:21.491183734Z, 0); still equal after the soak; 0 `worker_started` since 09:51:24Z |
| Health | 3-minute soak 09:52:04 to 09:55:06Z, 36 probe sets (local ready, local live, public ready), 0 non-200; public live 200; migrations `0021_document_export_marks|21` |
| Markup (public `/` and local `/`, no session, 185,311 bytes each, same size as after the last deploy) | "ทั้งหมด (รวม % ความมั่นใจ)" once; `<option value="detailed" selected>` once; `id="ocr-summary"` once; sort headers `data-sort` for file, customer, gender, nationality, room, therapist, treatment, duration, confidence, status; 6 `aria-sort` |
| Endpoints without a session | `GET /api/exports/documents.csv`, `.jsonl`, `/preview`, `/candidates` and `GET /api/documents?sort=customer&dir=asc`: 401, local and public. `POST /api/exports/documents.csv`, `.jsonl`, `/marks`: 403 without an `Origin` header (the cross-origin guard runs first, as recorded in the export-selection and export-no-limit reports), **401 with a same-origin `Origin`**, local and public |
| Smoke (no credentials) | `deploy/auth-smoke.sh https://ocr.innoveraappcenter.com` `PASS=9 FAIL=0` |
| Web logs since 09:51:24Z | 1 line (the `tsx src/server.ts` start banner); 0 `request_failed`, 0 error/warn |

No user was created, no password changed, no review saved, no export or mark triggered.

Process notes: (1) the first run of the backup script piped over ssh stopped after `pg_dump`, because
`docker compose exec -T` read the rest of the piped script as its stdin; only the backup dir, the head file, the stash
list and a dump had been written (no tag, no checkout). The script was re-run with `< /dev/null` on the exec, which
overwrote the dump with the one described above. (2) The availability probe during the build did not start (a race on
its start flag), so web availability during the 23 s build was not measured; the old container kept serving until the
swap and the swap probe above covers the switch.

## Rollback (not used)

On the host, in `/opt/innovera-ocr-app/ocr`, with `C="docker compose --env-file /etc/innovera/ocr-compose.env -f
deploy/docker-compose.yml"` (run as a piped script; the command line must not name the env file; give every
`$C exec -T` a `< /dev/null`):

```sh
docker tag deploy-web:pre-main-1b425c3 deploy-web:latest   # 4f52bb186b81
$C up -d --no-deps web
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:53100/health/ready   # 200
git checkout export-full-confidence-1                      # 059efd3, detached, as before
```

The app content is identical, so a rollback changes nothing functionally. The database did not change; the dump is a
precaution only, to restore only on data damage as its own approved step with the web stopped.

## State after

- GitHub `main` = this report commit on top of `1b425c3` (fast-forward). The host stays on branch `main` at
  `1b425c3`, the commit the running image was built from; it is one docs-only commit behind `origin/main`, which needs
  no rebuild (a later `git merge --ff-only origin/main` on the host is enough).
- Local backup bundle: `backups/ocr-main-2026-10-08.bundle` (all branches and tags of the clone, including `main`).

## Not verified / open items

1. **Logged-in check** (carried from `export-full-confidence-report-2026-10-08.md`, item 1): the authenticated export
   and drawer paths were not exercised on production; the user's logged-in check is still pending.
2. **`feature/review-ledger` must be rebased onto the new `main`** (clone `OCR-code/ocr-review-ledger`, forked from
   `55075ce`, tip `a59b64a`) before it can ship. Expected: the three known textual conflicts
   (`packages/ocr-persistence/src/index.ts`, `document-view.test.ts`, `batch.db.test.ts`; both sides append tests, keep
   both) and the slot count update 17 -> 19. Not done here; it needs its own approval.
3. Open items carried from earlier reports: step 49 counts-only checks, `sample2.png` keep-or-delete.
