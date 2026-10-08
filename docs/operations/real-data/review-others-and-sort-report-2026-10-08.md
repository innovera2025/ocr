# Review "Others" free text + sortable document list — production report (2026-10-08)

Tag `review-others-sort-1` (annotated, on `f815f97`, branch `feature/review-others-and-sort`, based on `dd1500f`) is
live on the web. Changes: (1) the review drawer has an "อื่น ๆ (ระบุ)" input under "รู้จักร้านจาก" and under "ภาวะสุขภาพ"
(`customerInformation.referralOther` / `healthOther`, saved as human edits, exported as `referral_other` /
`health_other`); (2) the document list has ten sortable column headers (every column except "จัดการ"), sorted by the
server over the whole filtered set through `GET /api/documents?sort=K&dir=asc|desc`. No migration, no env change, no
worker or Local AI change. Deploy approved by the user on 2026-10-08 (backup + web-image-only deploy + verification).
**Not merged to GitHub `main`** and the branch is not pushed; the tag exists only in the local clone and on the host.
Procedure: the shape of `export-no-limit-report-2026-10-08.md`. Aggregates only; no customer values and no credentials
here.

## Code gates (before deploy, on `f815f97`)

`pnpm typecheck` 0, `pnpm lint` 0, `pnpm test` with the DB suite enabled (throwaway `postgres:17.6`, container
`ocr-it-pg-sort`, `127.0.0.1:55443`, since removed): **532 tests / 532 pass / 0 fail** (baseline on `dd1500f`: 446;
one suite-level skip: poppler). `test/migration-checksums.test.ts` green; `git diff dd1500f -- prisma services
local-ai deploy` empty. DB parity: all 10 sort keys x 2 directions equal the order of the displayed values, paging
complete, filters and tenant isolation kept, no-sort order identical to `dd1500f`. Inline SCRIPT parses via `new
Function`, 0 backticks / 0 `${`. Commits `a93e2bc`, `de26b71`, `3ceb9e3`, `f815f97`.

Timings (synthetic rows, median of 9 `listDocuments` calls, ms): 400 rows: none 10.4, text keys 11.9 to 15.1, duration
16.8, confidence 35.6. 2000 rows: none 17.1, text keys 14.8 to 24.1, duration 31.3, confidence 108.1. 20,000 rows: none
60.9, text keys 62.7 to 111.4, duration 207.1, confidence refused (`SORT_TOO_LARGE`, cap 2000). All within the plan's
acceptance limits. Production today: 751 visible rows.

## Deploy (web only, 2026-10-08, 07:47 to 07:54 UTC / 14:47 to 14:54 Asia/Bangkok)
| Step | Result |
|---|---|
| Pre-flight (read-only) | detached at tag `export-no-limit-1` @ `38725db`, tree clean, one pre-existing stash; `deploy-web-1` image `831c56dbf8ca` (container `fbc8ce8b30c9`, started 2026-10-08T06:20:44Z), `deploy-worker-1` image `4c2eaf094643` (container `f42abceefac3`, started 2026-09-23T08:37:21Z, 0 restarts); ready/live 200; `0021_document_export_marks|21`; 0 documents in `VALIDATING`/`SCANNING`; 78 G free; 16 env keys; shared containers (docketlaw, mysql-db, nginx-proxy, nginx-proxy-letsencrypt, portainer) not touched |
| **Collation gate** | `pg_collation` in `innovera_ocr` has `th-TH-x-icu` (count 1, provider ICU, `collversion` 153.128.46 = `pg_collation_actual_version` 153.128.46, so no version-mismatch warning); read-only smoke: `'เกด' < 'ขิม'` under the collation is true, and an `ORDER BY lower(filename) COLLATE "th-TH-x-icu"` over all 783 document rows runs. Database default collation `en_US.utf8` (libc) unchanged and irrelevant to the sort |
| Data counts (informs caveats) | visible rows 751 (well under the confidence cap 2000); treatment items with stored `durationMinutes`: 494 numeric, 500 JSON `null` (no minutes read); 266 of 751 visible rows have no duration key and sort last in both directions |
| Diff check | `git diff 38725db review-others-sort-1`: 17 files, all in the plan's touchpoints (`apps/ocr-web/src/{server,workbench}.ts` + tests, `packages/ocr-persistence/src/{document-sort(new),document-view,export,index,labels}.ts` + tests, the spec) plus the `dd1500f` export-no-limit report; nothing under `prisma/`, `services/`, `local-ai/`, `deploy/` |
| Backup + tags | `/opt/innovera-backups/review-others-sort-20261008/` (mode 700): `head-pre-review-others-sort.txt` (`38725db…`), `database-pre-review-others-sort.dump` 793,659 bytes (mode 600; custom format, gzip, PostgreSQL 17.6, 183 TOC entries; `audit_events`, `document_export_marks`, `documents`, `schema_migrations`, `users` data present), sha256 `d237890d16bfe850…` (full hash in `.sha256` beside it); image tags `deploy-web:pre-review-others-sort` `831c56dbf8ca`, `deploy-worker:pre-review-others-sort` `4c2eaf094643` (courtesy, worker not recreated) |
| Code to host | `git bundle` of `feature/review-others-and-sort` + tag `review-others-sort-1` (complete history, sha256 `b63164ffe8f973a1…`, same on both ends) copied by `scp` into the backup dir; `git fetch <bundle> refs/tags/review-others-sort-1`; `git checkout review-others-sort-1` → detached at `f815f97`, tree clean, stash untouched |
| Build | `build web` 24 s (07:49:00 to 07:49:24Z) while the old web served (12 readiness probes during the build, all 200); new image `deploy-web:latest` `b42a588baede` |
| Swap | `up -d --no-deps web` 07:49:46 to 07:49:57Z; readiness probe every 0.5 s: 3 non-200 probes (07:49:57.4 to 07:49:58.5Z), **downtime about 1.5 s**; new container `59a18c3dd48f`, started 07:49:57Z, 0 restarts |
| Worker | container `f42abceefac3`, image `4c2eaf094643`, `StartedAt` 2026-09-23T08:37:21.491Z, 0 restarts: identical before and after (string compare in the swap script); 0 `worker_started` since 07:49Z |
| Health | `/health/ready` and `/health/live` 200 locally and publicly; 3-minute soak 07:51:30 to 07:54:31Z, 36 probe pairs, 0 non-200; migrations still `0021_document_export_marks|21` |
| Markup (public `/` and local `127.0.0.1:53100/`, no session) | `id="sort-K"` exactly once for each of the ten keys (file, customer, gender, nationality, treatment, duration, therapist, room, status, confidence); 10 `class="th-sort"` buttons; `aria-sort` handling present (style + script); `const SORT_KEYS=` present; live region `id="sort-live"` once; `OTHER_LABEL=` present and "อื่น ๆ (ระบุ)" in the page |
| Smoke (no credentials) | `auth-smoke.sh https://ocr.innoveraappcenter.com` `PASS=9 FAIL=0`; `GET /api/documents?sort=customer&dir=asc` 401 and `GET /api/documents?sort=bogus` 401 (authentication is checked before the query, public and local); plain `GET /api/documents` 401 |
| Web logs (07:49:57 to 07:54:31Z) | 1 line (the `tsx src/server.ts` start banner); 0 `request_failed`, 0 error/warn, 0 uncaught |

No user was created, no password changed, no review saved, no export or mark was triggered against real data.

## Notes for staff and data consumers

- **Thai order (supersedes the plan's D10):** text columns sort with PostgreSQL's ICU collation `th-TH-x-icu`
  (dictionary order: leading vowels เ แ โ ใ ไ sort by the following consonant; Thai before Latin; English A to Z,
  case-insensitive). Empty values are last in both directions; ties keep the default order (newest upload first).
- **Status sort** ascending is attention first (รอตรวจสอบ, ไม่สำเร็จ, กำลังอ่าน, รอคิว, อ่านสำเร็จ, ยืนยันแล้ว);
  descending is the reverse. **Confidence** sorts by the displayed integer percent and is refused above 2000 filtered
  rows (`SORT_TOO_LARGE`; the page tells staff to narrow the filter and returns to the default order).
- **Duration** sorts by the sum of the numeric treatment minutes (what the ระยะเวลา column lists), else the form's
  total. Today 266 of 751 visible rows have none and sort last.
- **Export column shift:** the compact CSV has 54 columns (was 52): `referral_other` directly after `referral_sources`,
  `health_other` directly after `health_conditions`; the detailed set has 106 (was 96). Anyone reading the CSV by
  column position must re-map the columns after `referral_sources`; JSONL (keyed by name) is unaffected. Old documents
  export empty cells.
- **Ledger merge (unreleased `ocr-review-ledger`):** this branch ships first. When the ledger rebases, it must add
  `customerInformation.referralOther` and `customerInformation.healthOther` to `DECLARED_SLOTS` (kind `field`,
  required `present`; `healthOther` sensitive like `healthConditions`) and change its parity count 17 to 19. A dry-run
  `git merge-tree` showed textual conflicts only in `packages/ocr-persistence/src/index.ts` (re-export block: keep both),
  `batch.db.test.ts` and `document-view.test.ts` (both append tests: keep both).

## Rollback (not used)
On the host, in `/opt/innovera-ocr-app/ocr`, with `C="docker compose --env-file /etc/innovera/ocr-compose.env -f
deploy/docker-compose.yml"` (run as a piped script; the command line must not name the env file):

```sh
docker tag deploy-web:pre-review-others-sort deploy-web:latest   # 831c56dbf8ca
$C up -d --no-deps web
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:53100/health/ready   # 200
git checkout export-no-limit-1                                   # 38725db, the checkout matches the image again
```

Nothing in the database changed, so the dump is only a precaution; restore it only on data damage, as its own approved
step with the web stopped. If staff saved "อื่น ๆ (ระบุ)" text before a rollback, the old web keeps those stored keys
untouched (it simply has no input or export column for them); no cleanup is needed.

## Not verified / open items
1. **Logged-in browser check (user, plan step 5.9):** click each of the ten headers three times (ascending, descending,
   back to newest first) and check the arrow and order; use Tab/Enter on a header; open a document and see the
   "อื่น ๆ (ระบุ)" input under both groups (amber "ต้องตรวจสอบ" hint when "Others" is ticked and the box is empty; it
   never blocks saving); type, save, reopen; export one row and see `referral_other` / `health_other`. Exporting marks
   the row as exported. Not claimed verified until the user confirms. This also covers the plan's real-browser check
   3.7 (keyboard, focus ring on the sticky header, narrow viewport), which could not be run in the build session.
2. The authenticated sort paths and the Others save/export were not exercised on production: no session was used.
   They are covered by the DB integration suite on `postgres:17.6` with the same collation.
3. `f815f97`, this report commit and the tag are not on GitHub. Merging `feature/review-others-and-sort` (which
   contains `feature/export-no-limit`) into `main` and pushing the tags needs its own approval; until then the durable
   copies are the local clone and the bundle in the host backup dir.
4. AI reading of the "Others" handwriting is backlog (handwriting Phase B); these keys are its landing place.
5. Open items carried from earlier reports: step 49 counts-only checks, `sample2.png` keep-or-delete.
