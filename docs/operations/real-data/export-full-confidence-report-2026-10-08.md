# Export "full" format with confidence %, OCR original and edited flags — production report (2026-10-08)

Tag `export-full-confidence-1` (annotated, on `059efd3`, branch `feature/export-full-confidence`, based on `c8ba60d`)
is live on the web. Changes: (1) the export's full column set ("ทั้งหมด (รวม % ความมั่นใจ)", API `columns=detailed`,
106 -> **180** columns) carries, for every scalar field, checkbox list and treatment slot 1-4, the OCR text, the
effective confidence % (a field staff changed or added is 100), the original OCR %, the review flag, the source code
and an edited flag; (2) it is the default of the dialog and of the API; (3) every confidence in the file, including
`min_confidence`, is an integer percent rounded like the drawer; (4) three OCR-only summary columns
(`handwriting_confidence`, `handwriting_read` as "N จาก M", `checkbox_confidence`) are appended to both sets (compact
54 -> **57**); (5) the review drawer shows an edited field as "ความมั่นใจ 100% · แก้ไขโดยพนักงาน · OCR เดิม NN%" and one
OCR summary line under its head. No migration, no env change, no worker or Local AI change. Deploy approved by the user
on 2026-10-08 ("ใช่แล้วเสร็จแล้ว Deploy ได้เลย", conditional on all tests passing). **Not merged to GitHub `main`**, the
branch is not pushed; the tag exists only in the local clone and on the host. Procedure: the shape of
`review-others-and-sort-report-2026-10-08.md`. Aggregates only; no customer values and no credentials here.

Plan: `process/general-plans/active/export-full-confidence_PLAN_08-10-26.md` (harness). Staff-facing column guide:
`export-columns-guide.md` in this folder.

## Code gates (before deploy, on `059efd3`)

`pnpm typecheck` 0, `pnpm lint` 0, `pnpm test` with the DB suite enabled (throwaway `postgres:17.6`, container
`ocr-it-pg-fullconf`, `127.0.0.1:55444`, since removed): **556 tests / 556 pass / 0 fail / 0 skipped** (baseline on
`c8ba60d`: 472 without the DB suite + 60 DB = 532). `test/migration-checksums.test.ts` green; `git diff c8ba60d --
prisma services local-ai deploy packages/ocr-persistence/src/index.ts packages/ocr-persistence/src/document-view.ts
apps/ocr-web/src/server.ts` empty. Inline SCRIPT parses via `new Function`, 0 backticks / 0 `${`. Commits `6ea3db4`
(persistence column contract), `0cf313c` (server default), `1f64f78` (dialog and drawer), `059efd3` (guide and spec).

New tests: column counts/order pinned (compact 57 with the first 54 keys of `c8ba60d`, full 180 = 57 + 78 + 25 + 20,
unique keys and Thai headers); the per-field semantics matrix (OCR, changed, accepted-unchanged, added, filled where the
OCR read nothing, unread, % rounding 0.894 -> 89 / 0.895 -> 90); lists; treatments incl. item 5+; `min_confidence` =
`displayedConfidencePercent(summarizeDocument(...).minConfidence)` on six fixture shapes; every key present for empty,
null-section, legacy and malformed results (CSV empty cell, JSONL `null`); the OCR summary semantics; a real
`applyReviewEdits` round trip leaving the summary unchanged; Excel (`007`/`0123` kept, "7 จาก 9" has no `/`, CSV BOM
bytes EF BB BF once, JSONL none); the guide's 180-row table equals `EXPORT_COLUMNS_DETAILED`; the drawer's
`ocrSummary` equals `ocrReadSummary` on a fixture set covering every slot; DB: a real review exported in the full set
(changed name 100 / OCR 88 / edited, changed duration 100 / 95, accepted therapist 50 / 50 / not edited, added list item,
tenant B refused).

**Performance** (synthetic rows only). In memory, 50,000 documents flattened and CSV-serialised: compact 2.8 s
(0.057 ms/row, 734 B/row), full 5.0 s (0.101 ms/row, 1,300 B/row), 1.78x compact (budget: under 25 s and under 3x);
max RSS 79-95 MB both. Streamed through the real route handler and `PostgresOcrDocumentStore` from the throwaway
database, 20,000 rows: compact 3.8-4.5 s, 13.6 MB (682 B/row), max RSS 177-187 MB; full 5.4-6.0 s, 24.8 MB
(1,242 B/row), max RSS 190-200 MB (+2 to +13 %, budget +25 %); every run 20,000 rows, `export.completed` complete, no
cursor error.

**Ledger merge (unreleased `ocr-review-ledger`, `feature/review-ledger` @ `a59b64a`):** a dry-run `git merge-tree`
shows the same three textual conflicts as from the base `c8ba60d` (`packages/ocr-persistence/src/index.ts`,
`document-view.test.ts`, `batch.db.test.ts`; both sides append tests: keep both). This branch adds no new conflict hunk;
its DB test and its `ocrReadSummary` import sit inside the two pre-existing `batch.db.test.ts` hunks. `export.ts` and
`workbench.ts` merge cleanly.

## Deploy (web only, 2026-10-08, 08:58 to 09:04 UTC / 15:58 to 16:04 Asia/Bangkok)
| Step | Result |
|---|---|
| Pre-flight (read-only) | detached at tag `review-others-sort-1` @ `f815f97`, tree clean, one pre-existing stash; `deploy-web-1` image `b42a588baede` (container `59a18c3dd48f`, started 2026-10-08T07:49:57Z, 0 restarts), `deploy-worker-1` image `4c2eaf094643` (container `f42abceefac3`, started 2026-09-23T08:37:21.491Z, 0 restarts); ready/live 200; `0021_document_export_marks|21`; 0 documents in `VALIDATING`/`SCANNING`; 78 G free; shared containers (docketlaw, mysql-db, nginx-proxy, nginx-proxy-letsencrypt, portainer) not touched |
| Data counts | visible rows 751; 63 of them carry at least one staff-edited leaf (92 `source:"human"` leaves): these rows now export 100 % for the edited fields with the OCR % beside them |
| Diff check | `git diff f815f97 export-full-confidence-1`: 12 files, all in the plan's touchpoints (`apps/ocr-web/src/{export,workbench}.ts` + tests, `packages/ocr-persistence/src/export.ts` + tests, `batch.db.test.ts`, the spec, the design pointer, the new guide) plus the `c8ba60d` report; nothing under `prisma/`, `services/`, `local-ai/`, `deploy/`, no Dockerfile or compose change |
| Backup + tags | `/opt/innovera-backups/export-full-confidence-20261008/` (mode 700): `head-pre-export-full-confidence.txt` (`f815f97…`), `database-pre-export-full-confidence.dump` 793,831 bytes (mode 600; custom format; 179 TOC entries; `audit_events`, `document_export_marks`, `documents`, `schema_migrations`, `users` data present), sha256 `3e55cec7c376733f…` (full hash in `.sha256` beside it); image tags `deploy-web:pre-export-full-confidence` `b42a588baede`, `deploy-worker:pre-export-full-confidence` `4c2eaf094643` (courtesy, worker not recreated) |
| Code to host | `git bundle` of `feature/export-full-confidence` + tag `export-full-confidence-1` (complete history, sha256 `d94c0337c4a734ba…`, same on both ends) copied by `scp` into the backup dir; `git fetch <bundle> refs/tags/export-full-confidence-1`; `git checkout export-full-confidence-1` -> detached at `059efd3`, tree clean, stash untouched |
| Build | `build web` 23 s (08:59:42 to 09:00:05Z) while the old web served (12 readiness probes during the build, all 200); new image `deploy-web:latest` `4f52bb186b81` |
| Swap | `up -d --no-deps web` 09:00:28 to 09:00:39Z; readiness probe every 0.5 s: 3 non-200 probes (09:00:39.3 to 09:00:40.4Z), **downtime about 1.5 s**; new container `a847251aea36`, started 09:00:39Z, 0 restarts |
| Worker | container `f42abceefac3`, image `4c2eaf094643`, `StartedAt` 2026-09-23T08:37:21.491Z, 0 restarts: identical before and after (string compare in the swap script); 0 `worker_started` since 09:00:28Z |
| Health | `/health/ready` and `/health/live` 200 locally and publicly; 3-minute soak ending 09:04:16Z (from about 09:01Z), 36 probe sets (local ready, local live, public ready), 0 non-200; migrations still `0021_document_export_marks|21` |
| Markup (public `/` and local `127.0.0.1:53100/`, no session, identical 185,311 bytes) | `<select id="ex-columns"><option value="detailed" selected>ทั้งหมด (รวม % ความมั่นใจ)</option><option value="compact">สรุป</option></select>` once; the label once; the old "ละเอียด" option gone; drawer summary markup `<p id="ocr-summary" class="f-meta ocr-sum" aria-label="สรุปผลการอ่านของ OCR" hidden>` once; `function ocrSummary(view)`, `renderOcrSummary();`, `'OCR เดิม '`, `'ความมั่นใจ 100%'` and the `'detailed'` reset present |
| Export endpoints without a session | `GET /api/exports/documents.csv`, `.jsonl`, `/preview`, `/candidates` and `POST /api/exports/documents.csv`, `.jsonl`, `/marks`: all **401**, local and public |
| Smoke (no credentials) | `auth-smoke.sh https://ocr.innoveraappcenter.com` `PASS=9 FAIL=0` (09:04:20Z) |
| Web logs (09:00:28 to 09:04:16Z) | 1 line (the `tsx src/server.ts` start banner); 0 `request_failed`, 0 error/warn, 0 uncaught |

No user was created, no password changed, no review saved, no export or mark was triggered against real data.

## Notes for staff and data consumers

- **Column shift (tell anyone who reads the CSV by position):** สรุป (compact) 54 -> 57: columns 1-54 unchanged in
  key, header and position, three OCR summary columns appended at 55-57. ทั้งหมด (full, was "ละเอียด") 106 -> 180:
  layout replaced after column 57. Every confidence, including `min_confidence` (header now "ความมั่นใจต่ำสุด (%)"),
  changed from a 0-1 fraction to an integer percent: a filter `< 0.8` is now `< 80`. A download without a choice is
  now the full set. JSONL consumers (keyed by name) see added keys and the unit change.
- **What 100 means:** a person set the value, not that the OCR was right; `_ocr_confidence` keeps the machine's own %,
  `_edited` says which fields staff changed. A field the reviewer only accepted keeps its OCR % (decision A).
- **Excel:** double-click works (BOM, Thai headers) but drops leading zeros of `room` / `form_number`; the guide has
  the Data > From Text/CSV recipe. `handwriting_read` is words ("7 จาก 9") because Excel turns 7/9 into a date.
- **OCR summary limits** (also in the guide): a field staff typed where the OCR had no text is left out; a save or a
  confirmation clears every review flag, so after it a field whose ink the OCR could not read (`none`, flagged) no
  longer counts as writing and the read share can rise at save time; an edited field the OCR had text for but no value
  counts as read.

## Plan decisions applied and deviations (all small; see the plan's execution log)

1. Orchestrator decision 1: `handwriting_read` is "N จาก M" in CSV/JSONL; the drawer shows "N/M". As planned.
2. Orchestrator decision 2 (count edited fields from their preserved OCR state where it is recoverable): an edited
   leaf with OCR text counts with its kept confidence (handwriting and checkbox). For an **edited checkbox** leaf
   without OCR text (e.g. gender where nothing was marked), a stored confidence strictly between 0 and 100 % identifies
   the earlier checkbox reading, so it now counts (added to D18). For an **edited handwritten** leaf without OCR text
   the earlier state is not recoverable: the save clears `needsReview` and overwrites `source`, and the kept confidence
   is 0 for an unreadable ink box, a box with nothing found and an empty room alike (0.6 / 0.9-0.99 would be the ink
   check, i.e. no writing; 1 is a staff addition). Those stay excluded, as the plan had it. No edit to
   `document-view.ts` or `index.ts`.
3. D3 reading: for a leaf nobody edited, `_ocr_confidence` equals `_confidence` (D3's last sentence and acceptance 2),
   also when the leaf has no OCR text (e.g. an ink-checked empty date: 95 / 95). The "has OCR text" condition applies
   to edited leaves only.
4. D18 gaps filled: a leaf with writing but no stored confidence contributes 0 to the mean; a written-but-unread leaf
   contributes 0 whatever its stored confidence. A legacy v2.2 row with readings is counted like any other (the plan's
   T9(k) expected all null; an empty legacy row is null).
5. The drawer summary `<p id="ocr-summary">` sits between the alert and the drawer body (outside the editor, which is
   rebuilt on every render), spanning both columns.
6. The batch spec had no export-columns paragraph; a new §10 was added instead of editing one.

## Rollback (not used)
On the host, in `/opt/innovera-ocr-app/ocr`, with `C="docker compose --env-file /etc/innovera/ocr-compose.env -f
deploy/docker-compose.yml"` (run as a piped script; the command line must not name the env file):

```sh
docker tag deploy-web:pre-export-full-confidence deploy-web:latest   # b42a588baede
$C up -d --no-deps web
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:53100/health/ready   # 200
git checkout review-others-sort-1                                    # f815f97, the checkout matches the image again
```

Nothing in the database changed, so the dump is only a precaution; restore it only on data damage, as its own approved
step with the web stopped. Files exported with the new format keep their new layout after a rollback.

## Not verified / open items
1. **Logged-in check (user, plan step 5.9; also covers the plan's real-browser check 3.6, not run in the build
   session):** open ส่งออก and see the default "ทั้งหมด (รวม % ความมั่นใจ)"; export one row you already reviewed as CSV
   and confirm 180 columns, the edited field at 100 with "ความมั่นใจ OCR เดิม %" beside it, an untouched field at its
   OCR %, empty cells for missing fields, and the three summary columns at 55-57; open it in Excel once (From Text/CSV
   recipe); open that row in the drawer and see "ความมั่นใจ 100%", "แก้ไขโดยพนักงาน", "OCR เดิม NN%" and the summary
   line under the head. Exporting marks the row as exported (choose "ย้ายกลับเป็นยังไม่ Export" if that was only a
   test). Not claimed verified until the user confirms.
2. The authenticated export and drawer paths were not exercised on production (no session was used); they are covered
   by the unit, behaviour and DB integration suites.
3. `059efd3`, this report commit and the tag are not on GitHub. Merging and pushing need their own approval; until then
   the durable copies are the local clone, `backups/ocr-export-full-confidence.bundle` and the bundle in the host
   backup dir.
4. The OCR summary's save-time limit (item in the notes above) could be removed only by storing the OCR's own state
   separately from the reviewed value (a plan of its own).
5. Open items carried from earlier reports: step 49 counts-only checks, `sample2.png` keep-or-delete.
