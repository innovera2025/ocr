# Export selection — production report (2026-10-05)

The `ส่งออก` dialog with per-row selection and export history (migration `0021_document_export_marks`) is live on the
web. Runbook: `export-selection-deploy.md`. PR https://github.com/innovera2025/ocr/pull/1 merged to `main` as a
fast-forward at `36a1810`; annotated tag `export-selection-1` (`b64642a`) on `36a1810`; production runs that tag.
W3a (`94d89a7`, review-save in `document-view.ts`) rode along and was disclosed before approval. The worker was not
rebuilt or recreated. Aggregates only; no customer values and no credentials here.

## Deploy (web only, 2026-10-05, 08:37 to 08:42 Asia/Bangkok)
| Step | Result |
|---|---|
| 0. Merge + tag | `origin/main` was `ac25e36` (fast-forwardable); `git push origin feature/export-selection:main` → `ac25e36..36a1810`; PR #1 `MERGED` at 01:37:17Z (merge commit = head `36a1810`); tag `export-selection-1` pushed; recovery bundle refreshed and verified (heads `main`, `feature/export-selection`, tag) |
| 41. Drift check (re-run) | `release2b` @ `ee0a769`, `git diff ee0a769` empty, only `?? sample2.png`, one pre-existing stash; images `f2f8020c90d2` (web) / `4c2eaf094643` (worker); `0020_batch_round_clock|20`; `ocr_migrator|1`, `ocr_queue_definer|7`; grant check `PASS=20 SKIP=0 FAIL=0`; 81 G free; 16 env keys; ready 200 |
| 42. Backup + tags | `/opt/innovera-backups/export-selection-20261005/` (mode 700): `head-pre-export-selection.txt` (`ee0a769…`), `database-pre-0021.dump` 416,737 bytes (custom format, gzip, PostgreSQL 17.6, 171 TOC entries; `documents`, `schema_migrations`, `audit_events`, `users` data present), sha256 `1582a583…`; image tags `innovera-ocr-web:pre-export-selection` `f2f8020c90d2`, `innovera-ocr-worker:pre-export-selection` `4c2eaf094643` |
| sample2.png | moved (not opened) out of the code checkout into the backup dir above, mode 600, size and hash identical before and after; `git status` in `/opt/innovera-ocr-app/ocr` now clean |
| 43. Checkout | `git fetch origin --tags`, `git checkout export-selection-1` → detached at `36a1810`, tree clean, `0021_document_export_marks` present |
| 44. Env | same 16 keys, no edit (`OCR_EXPORT_MAX_ROWS` stays at the compose default 50000) |
| 45. Quiet moment | 0 documents in `VALIDATING`/`SCANNING` |
| 46. Web | `build web` 34 s while the old web served (ready 200 during the build), new image `ccec0235b8d4`; `up -d --no-deps web` 11.4 s; **downtime about 4 s** (readiness probe every 0.5 s: last 200 at 01:40:49.8Z, first 200 again at 01:40:53.6Z; the old web kept answering during its stop); `0021_document_export_marks|21` (applied 01:40:53Z by the starting web); `document_export_marks` owner `ocr_migrator`, RLS `t`/forced `t`, policy `export_mark_scope`, `ocr_app` holds `INSERT, SELECT` only; function owners `ocr_migrator|1`, `ocr_queue_definer|7` unchanged; 0 marks; 0 `request_failed`; worker `StartedAt` 2026-09-23T08:37:21Z unchanged, 0 `worker_started`, image `4c2eaf094643` |
| 47. Grant check | `SUMMARY PASS=27 SKIP=0 FAIL=0` (the seven 0021 checks `app:select-export-marks` … `force-rls:export-marks` all PASS) |
| 48. Smoke | `auth-smoke.sh https://ocr.innoveraappcenter.com` `PASS=9 FAIL=0`; unauthenticated `GET /api/exports/candidates` 401; `POST /api/exports/marks` 403 without Origin, 401 same-origin; `POST /api/exports/documents.csv` 401; public login page 200 and serving the new dialog markup |

## State after the deploy
- 357 visible rows (`VISIBLE_SQL`), all "never exported": the dialog should read ยังไม่เคย Export (357) / Export แล้ว (0)
  / ทั้งหมด (357) (the planning-time figure was 96; the data grew with the full-document batches).
- Export audit before acceptance: `export.started 3 = export.completed 3`, `export.previewed 7` (Release 2 history).
- The export counters do not appear on `/metrics` until the first candidates call or mark (labelled counters).

## Rollback (not used)
`docker tag innovera-ocr-web:pre-export-selection deploy-web:latest && $C up -d --no-deps web`, then `git checkout
release2b`. `0021` stays applied (additive). Restore `database-pre-0021.dump` only on data damage, as its own approved
step.

## Acceptance and freeze
- User acceptance on production (runbook step 49): **passed** on 2026-10-06. The user tried the dialog on production
  in their own browser and confirmed that export works ("ลองแล้วสามารถ Export ได้จริงแล้ว"). No export file is part
  of this report or of git.
- Freeze (step 50, approved by the user on 2026-10-06): `APPLIED_IN_PRODUCTION = "0021_document_export_marks"` in
  `test/migration-checksums.test.ts`, committed on `main` together with this report. `0001` to `0021` are now frozen;
  a fix to the export history schema goes into a new migration `0022`. Production stays on tag `export-selection-1`
  (`36a1810`): the freeze commit changes only a test file and this report, so nothing is redeployed.

## Open items
1. The counts-only checks of step 49 (`document_export_marks` by kind/source, `export.%` audit actions, export counters
   on `/metrics`) were not run after the acceptance; run them read-only at the next approved production visit.
2. `sample2.png` (a real customer form) now lives only in the root-only backup dir; decide whether to keep or delete it.
