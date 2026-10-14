# Export "(?)" marker removal: merge into GitHub `main` and production web deploy (2026-10-14)

Approved by the user on 2026-10-14 ("อนุมัติ deploy"): fast-forward GitHub `main` to tag `export-no-question-mark-1`
(`7d49e90`), push the branch and the tag, and deploy production web only from `main`, with a backup, verification and
rollback on failure. Nothing else: no migration, no worker or Local AI change, no env change; no other branch touched;
the shared host containers (docketlaw, mysql-db, portainer, nginx-proxy, nginx-proxy-letsencrypt) were not touched.
Aggregates only; no customer values, no file names and no credentials here.

## What shipped

`fieldCell` in `packages/ocr-persistence/src/export.ts` now returns the clean `value` only. Before, it appended
` (?)` to every still-flagged value and, when a field had no value, exported the OCR `raw` text plus ` (?)`. The same
helper fills the scalar cells, the joined lists, `treatment_N_name` and the joined treatments, so the marker appeared in
almost every column of a not-yet-reviewed row. Now a value cell is clean, or empty when there is no value. Review state
stays in `needs_review` and `review_fields` (both sets) and `<field>_needs_review` (full set); the OCR text stays in the
full set's `<field>_raw`. Column counts are unchanged (compact 57, full 180). The unused `UNVERIFIED_SUFFIX` constant
is removed. The compact (สรุป) file no longer carries raw-only readings; that is documented in
`export-columns-guide.md`, design section 3.2 and `release2-plan.md`.

## Merge (fast-forward, no merge commit)

| Item | Result |
|---|---|
| GitHub `main` before | `0632388` (`git ls-remote`, checked before the gate and again right before the push) |
| Ancestry | `0632388` -> `7d49e90` (1 commit, linear) |
| Push | `git push github 7d49e90:refs/heads/main` -> `0632388..7d49e90`, normal push, no force |
| Also pushed | branch `fix/export-no-question-mark` (`7d49e90`); tag `export-no-question-mark-1`, made annotated before its first push (tag object `10d2ceb`, still -> `7d49e90`; it had never been published as a lightweight tag) |
| GitHub `main` after | `7d49e90` (`git ls-remote`), before this report commit |

## Code gates (on `7d49e90`)

| Gate | Result |
|---|---|
| `pnpm typecheck` | exit 0 |
| `pnpm lint` | exit 0 |
| `test/migration-checksums.test.ts` | 2/2 pass (`APPLIED_IN_PRODUCTION = "0021_document_export_marks"`; newest migration on disk `0021`) |
| Inline workbench script | 119,017 characters, parses with `new Function`, no backtick, no `${` (in-suite test also passes); `apps/` unchanged since `810cc16` |
| `pnpm test`, DB suite enabled | **589 / 590 pass, 1 fail** (skipped 0; poppler renderer suite SKIP at suite level as before). The one failure is timing test 12, **waived by the user for this run** (below) |

DB suite: throwaway `postgres:17.6` container `ocr-it-pg-noqmark` on `127.0.0.1:55447` (`datcollate`/`datctype`
`en_US.utf8`), removed afterwards; no existing container used (`deploy-postgres-1` and `ocr-it-pg-export` StartedAt
unchanged). The known flaky queue test (`queue: expired leases are recovered ...`) passed in every run.

### Waiver: timing test 12

The test "batch processing against PostgreSQL as the runtime roles" > "upload filename rule" > "12. timing at 20,000
top-level documents: a miss, a hit and a 100-name pre-check" failed in every full-suite run on the gate machine
(bounds: miss and hit under 500 ms, 100-name check under 1 s). Under the gate rule a consistent failure blocks, so the
deploy stopped and the decision went back to the user. On 2026-10-14 the user waived **this test, for this run only**,
and approved the deploy; every other gate had to be green, and was.

Evidence that the failure is machine contention and not this change:

- The gate Mac (8 cores) ran at a load average of 145 to 836 throughout, from unrelated work (another project's jest
  workers, a VM, other database containers).
- The timed code did not change: `git diff 810cc16 7d49e90` is empty for `filename-key.ts`, `index.ts`,
  `batch.db.test.ts`, `packages/ingest` and `prisma/`. That code has run in production since 2026-10-12.
- The parent commit `0632388` (production code plus docs) fails the same test the same way under the same load.
- The DB suite file run alone at `7d49e90` passes 73 / 73 even at a load average of about 800.

| Run | Commit | Result | Timing test 12: miss / hit / 100-name check (ms) |
|---|---|---|---|
| Full suite, run 1 | `7d49e90` | 589 / 590 | 1382.5 / 184.5 / 2224.3 |
| Full suite, run 2 | `7d49e90` | 589 / 590 | 2301.9 / 23.7 / 2189.7 |
| Full suite, run 3 | `7d49e90` | 589 / 590 | 1244.8 / 145.2 / 1539.5 |
| Full suite, run 4 (started at load 145, rose to about 500) | `7d49e90` | 589 / 590 | 645.7 / 36.9 / 460.1 |
| Full suite, `--test-concurrency=1` | `7d49e90` | 589 / 590 | 2026.5 / 62.6 / 1962.4 |
| Full suite (comparison) | `0632388` | 589 / 590 | 573.2 / 26.1 / 580.9 |
| DB suite file alone | `7d49e90` | **73 / 73 pass** | 464.0 / 25.8 / 703.4 |

For reference, the 2026-10-12 gate measured 317.0 / 14.4 / 444.7 ms on a quieter machine.

### Diff from the running `810cc16`

`git diff 810cc16 7d49e90 --stat`: 6 files, +193 / -23: `packages/ocr-persistence/src/{export.ts, export.test.ts}`,
`docs/operations/real-data/{design-2026-09-22.md, export-columns-guide.md, release2-plan.md}` and the 2026-10-12 report
`upload-duplicate-filename-report-2026-10-12.md`. Nothing under `prisma/`, `services/`, `local-ai/`, `deploy/` or
`apps/`; no Dockerfile or compose change; no new migration.

## Pre-flight (read-only; 11:58Z, repeated at 12:25Z with identical results)

| Check | Result |
|---|---|
| Host checkout | `/opt/innovera-ocr-app/ocr` branch `main` at `810cc16`, tree clean, one pre-existing stash; `origin` = GitHub |
| Containers | `deploy-web-1` `8628946a89f4`, image `a0266415c4e6`, started 2026-10-12T02:32:09.591Z, 0 restarts; `deploy-worker-1` `f42abceefac3`, image `4c2eaf094643`, started 2026-09-23T08:37:21.491183734Z, 0 restarts |
| Health | local ready/live 200, public ready/live 200 |
| Migrations | `0021_document_export_marks`, 21 rows |
| In-flight | 0 documents in `VALIDATING`/`SCANNING` |
| Disk | 51 G free of 96 G (48 % used) |

## Deploy (web only, 12:25 to 12:30 UTC / 19:25 to 19:30 Asia/Bangkok)

| Step | Result |
|---|---|
| Backup | `/opt/innovera-backups/export-no-question-mark-20261014/` (mode 700): `head-pre-export-no-question-mark.txt` (HEAD and `main` `810cc16…`, branch `main`), `stash-list-pre-export-no-question-mark.txt` (1 line), `database-pre-export-no-question-mark.dump` 8,969,300 bytes (custom format, 179 TOC entries; `audit_events`, `document_export_marks`, `documents`, `schema_migrations`, `users` data present), sha256 `15c8e293659276173a5ae69f2f4c730033040f1b3836b023dab86a0c426a0a95` (also in `.sha256` beside it), `toc.txt`; files mode 600. `pg_dump` ran with `< /dev/null` on the `exec -T` |
| Image tag | `deploy-web:pre-export-no-question-mark` = `a0266415c4e6` (the running web image). Worker not rebuilt, recreated or tagged |
| Code to host | `git fetch origin` from GitHub (`810cc16..7d49e90`, new branch and tag); `git merge --ff-only 7d49e90` on branch `main`; tree clean; stash list byte-identical to before |
| Build | `build web` 12:25:40 to 12:26:15Z (35 s); 63 readiness probes during the build, 0 non-200 (the old container served throughout); new `deploy-web:latest` `dedc7111ef10` |
| Swap | `up -d --no-deps web` from 12:26:15Z; readiness probe every 0.5 s: 98 probes in total, 5 non-200 (12:26:26.5 to 12:26:28.7Z), **downtime about 2 s**; new container `2283ee466fa2`, image `dedc7111ef10`, started 2026-10-14T12:26:26.591Z, 0 restarts |
| Worker | `Id Image StartedAt RestartCount` string-compared before the code step, right after the swap, and after the soak: equal each time (`f42abceefac3…`, `4c2eaf094643…`, 2026-09-23T08:37:21.491183734Z, 0); 0 `worker_started` since the swap |
| Code inside the web container | `/app/packages/ocr-persistence/src/export.ts` (the container runs the source through `tsx`; there is no separate build output): 0 `UNVERIFIED_SUFFIX`, 0 `(?)`; `fieldCell` is the one-line clean-value version; sha256 prefix `15b78e90a4dcb47b` = `7d49e90`'s file (the previous file was `d8ed6d9fad19dc5a`); 0 files under `packages/` or `apps/` (outside `node_modules`) mention `UNVERIFIED_SUFFIX` |
| Markup (public `/` and local `/`, no session) | 191,158 bytes each before and after; 0 `(?)` before and after (the export runs on the server, so the page itself has no change) |
| Export endpoints without a session (public and local) | `documents.csv`, `documents.jsonl`, `candidates`, `preview`, `marks` under `/api/exports/`: GET 401; POST without `Origin` 403 (the cross-origin guard runs first); POST with a same-origin `Origin` 401 |
| Smoke (no credentials) | `deploy/auth-smoke.sh https://ocr.innoveraappcenter.com` `PASS=9 FAIL=0` |
| Health | 3-minute soak 12:26:44 to 12:29:46Z, 36 probe sets (local ready, local live, public ready, public live), 0 non-200; migrations still `0021_document_export_marks|21` |
| Web logs since 12:26:15Z | 1 line (the `tsx src/server.ts` start banner); 0 `request_failed`, 0 error/warn |
| Host after | branch `main` at `7d49e90`, tree clean, stash count 1; shared containers still up, untouched; temporary probe/build logs under `/root` removed |

No export or mark was run, no file was uploaded, no user created, no password changed, no review saved.

## Rollback (not used)

On the host, in `/opt/innovera-ocr-app/ocr`, with `C="docker compose --env-file /etc/innovera/ocr-compose.env -f
deploy/docker-compose.yml"` (run as a piped script; the command line must not name the env file; give every
`$C exec -T` a `< /dev/null`):

```sh
docker tag deploy-web:pre-export-no-question-mark deploy-web:latest   # a0266415c4e6
$C up -d --no-deps web
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:53100/health/ready   # 200
git reset --hard 810cc16                                                 # host branch main back to the recorded head
```

The change writes no rows, so there is no data change to undo; the dump is a precaution only, to restore only on data
damage as its own approved step with the web stopped. GitHub `main` can be reverted with a new revert commit (never a
force-push) if the user asks.

## State after

- GitHub `main` = this report commit on top of `7d49e90` (fast-forward). The host stays on branch `main` at `7d49e90`,
  the commit the running image was built from; it is one docs-only commit behind `origin/main`, which needs no rebuild.
- Local backup bundle: `backups/ocr-main-2026-10-14.bundle` (all branches and tags of the clone, including `main`).

## Not verified / open items

1. **Logged-in re-export (the user runs it):** export a not-yet-reviewed document again, open the CSV in Excel, and
   confirm no cell ends in `(?)`; a field with no value is empty; the full file still shows the OCR text in `_raw` and
   the flag in `_needs_review`. No authenticated export was run on production.
2. Files exported before 2026-10-14 still contain the marker; re-export to get clean files.
3. **Backlog (its own plan):** timing test 12 ("upload filename rule" > "timing at 20,000 top-level documents") and the
   queue-lease test (`queue: expired leases are recovered ...`) are both contention-sensitive. Under a busy gate
   machine timing test 12 fails consistently, which blocked this gate until the user waived it. Both need looser
   bounds, a relative measure, or isolation from the parallel suite, so the gate stays meaningful without waivers.
