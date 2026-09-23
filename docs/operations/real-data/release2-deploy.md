# Release 2 deploy runbook — Deploy A (login) and Deploy B (export)

Source of truth: `release2-plan.md` §15. This file is the operator's copy of that section: what to run, in what order,
and what each step must print. **Deploy A ships first and on its own**; Deploy B (the export, the batch clock and the
request timeout) is at the end of this file and runs only after Deploy A is accepted.

Everything runs on the app VPS in `/opt/innovera-ocr-app/ocr`. Set the compose alias once per shell:

```sh
C="docker compose --env-file /etc/innovera/ocr-compose.env -f deploy/docker-compose.yml"
```

Steps marked **[CHANGE]** need the user's approval first. Every command below prints keys, counts or status codes —
never a value. Deploy outside spa hours: between step 4 and step 5 nobody can use the workbench.

## What Deploy A changes

- Migration `0019_user_auth` (additive: `users`, `auth_sessions`, `audit_events`, all FORCE RLS).
- The web image: `GET /api/web-token` is gone, every `/api` route needs a session cookie, and the workbench gets a
  login dialog, a password screen and a user administration dialog.
- The host env file: `OCR_WEB_AUTO_AUTH` is deleted, `OCR_PUBLIC_BASE_URL` is added, `OCR_TRUSTED_PROXY_HOPS` is set
  and `AUTH_JWT_SECRETS` is rotated.
- The worker is **not** touched. The image Deploy A shipped (commit `52ba15f`) still requires
  `0018_multipage_documents`. **Deploy A is done** — it is recorded here as it ran, and it must be replayed only
  from its own tag, never from a later one: at HEAD the worker requires `0020_batch_round_clock`, so a rebuild off
  the current tag with only 0019 applied crash-loops with `SCHEMA_NOT_READY`.

## 0. Read-only inspection (approved once)

```sh
grep -oE '^[A-Z_]+=' /etc/innovera/ocr-compose.env | sort     # expect OCR_WEB_TENANT_ID=, OCR_WEB_AUTO_AUTH=, OCR_REQUEST_TIMEOUT=
git status --short && git log -1
$C ps
$C images web worker
$C exec -T postgres psql -U ocr_bootstrap -d innovera_ocr -AtX -c "SELECT max(version) FROM schema_migrations"   # 0018_…
```

**The proxy check is a precondition, not an extra**, and needs its own approval because it reads the shared proxy:

```sh
docker exec <nginx-proxy> nginx -T 2>/dev/null | grep -c 'X-Forwarded-For $proxy_add_x_forwarded_for'
```

It prints a count and changes nothing. A count ≥ 1 allows `OCR_TRUSTED_PROXY_HOPS=1` in step 3. If the check is
declined or the count is 0, hops stays **0** and the per-IP login limiter is off; the unknown-name budget, the hash
gates and the web CPU limit are then the only things between a flood of random usernames and a login outage, so watch
`OcrLoginBusy`.

**Where the grant check can run.** Confirm (keys only): does `/etc/innovera/ocr-production.env` exist on this host,
does it hold host-reachable DSNs, and is `psql` installed on the host? If any answer is no, step 6 uses the
in-container form, which earlier releases already used.

## Deploy A

1. **[CHANGE] Backup and tags.**
   ```sh
   install -d -m 700 /opt/innovera-backups/release2-<date>
   $C exec -T postgres pg_dump -U ocr_bootstrap -d innovera_ocr -Fc > /opt/innovera-backups/release2-<date>/database-pre-0019.dump
   $C exec -T postgres pg_restore --list < /opt/innovera-backups/release2-<date>/database-pre-0019.dump | head -3
   docker tag <web image> <web repo>:pre-release2
   docker tag <worker image> <worker repo>:pre-release2
   ```
2. **[CHANGE] Check out the release commit:** `git fetch origin`, then `git checkout <release tag>`.
   Do **not** run `production-preflight.sh` or `go-live-check.sh` before step 4: their `migrations:current` check
   applies pending migrations from the host, as the migrator.
3. **[CHANGE] Host env edit** (`/etc/innovera/ocr-compose.env`; keys only in any output):
   - **delete** the `OCR_WEB_AUTO_AUTH` line, so a rollback fails closed;
   - add `OCR_PUBLIC_BASE_URL=https://ocr.innoveraappcenter.com` (the public origin of the workbench);
   - set `OCR_TRUSTED_PROXY_HOPS=1`; leave it at 0 only if the proxy check was declined or returned 0;
   - **rotate `AUTH_JWT_SECRETS` in place**, generated on the host straight into the file and never printed, e.g.
     ```sh
     sed -i '/^AUTH_JWT_SECRETS=/d' /etc/innovera/ocr-compose.env
     python3 -c "import secrets;print('AUTH_JWT_SECRETS='+secrets.token_urlsafe(48))" >> /etc/innovera/ocr-compose.env
     grep -c '^AUTH_JWT_SECRETS=' /etc/innovera/ocr-compose.env      # the only output: 1
     ```
     The new web never verifies `Authorization: Bearer` and the worker only needs the key to exist, so this costs
     nothing — and without it a rollback would re-enable every web token and operator JWT minted before the release,
     none of which carries an `exp`;
   - add `OCR_SESSION_IDLE_MINUTES` / `OCR_SESSION_ABSOLUTE_HOURS` only if you want values other than 30 and 12;
   - keep `OCR_WEB_TENANT_ID`, `AUTH_JWT_ISSUER` and `AUTH_JWT_AUDIENCE`. `OCR_WEB_SUBJECT_ID` may stay until
     Release 2 is accepted; nothing reads it any more.
4. **[CHANGE] Start the new web.** `$C build web`, then `$C up -d --no-deps web`. The web applies 0019 at startup as
   `ocr_migrator`. Checks:
   ```sh
   $C logs --since 5m web | grep -c request_failed                            # 0
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:53100/health/ready   # 200
   $C exec -T postgres psql -U ocr_bootstrap -d innovera_ocr -AtX -c "SELECT max(version) FROM schema_migrations"
   #   0019_user_auth
   $C exec -T postgres psql -U ocr_bootstrap -d innovera_ocr -AtX -c \
     "SELECT relname, relforcerowsecurity FROM pg_class WHERE relname IN ('users','auth_sessions','audit_events')"
   #   3 rows, all t
   $C exec -T postgres psql -U ocr_bootstrap -d innovera_ocr -AtX -c \
     "SELECT pg_get_userbyid(proowner), count(*) FROM pg_proc WHERE proname LIKE 'ocr%' GROUP BY 1"
   #   ocr_queue_definer|7 and ocr_migrator|1, unchanged
   ```
5. **The first administrator.** The user runs this in **their own** SSH session, so the password is typed at their
   terminal and Claude never sees it:
   ```sh
   ./deploy/ocr-users.sh create-admin
   ```
   It prompts for a username, a display name and the password twice (no echo), and prints one line:
   `สร้างผู้ดูแลระบบ <username> แล้ว`. This step comes **before** the grant check, so a check that cannot run on this
   host never extends the window in which nobody can log in.
6. **Grant check** (must print `FAIL=0` before staff accounts are created):
   ```sh
   $C exec -T postgres psql -U ocr_bootstrap -d innovera_ocr -AtX -f - < deploy/sql/verify-release2-grants.sql
   #   … SUMMARY PASS=18 SKIP=2 FAIL=0      before Deploy B (the two 0020 checks cannot be asked yet)
   #   … SUMMARY PASS=20 SKIP=0 FAIL=0      after Deploy B
   ```
   `FAIL=0` is the gate. A `SKIP` line names a check whose migration is not applied to this database yet — before
   Deploy B that is `app:update-batch-round` and `app:no-update-batch-label`, and nothing else may ever be skipped.
   Only if the host has `/etc/innovera/ocr-production.env`, host `psql` and host-reachable DSNs:
   ```sh
   set -a; . /etc/innovera/ocr-production.env; set +a; ./deploy/verify-db-roles.sh
   ```
7. **[CHANGE] Load the alert rules** (only this project's prometheus container is touched):
   ```sh
   $C up -d --no-deps prometheus
   curl -s 127.0.0.1:59090/api/v1/rules | grep -c OcrLoginFailuresHigh     # ≥ 1
   ```
8. **Smoke test** (no credentials):
   ```sh
   ./deploy/auth-smoke.sh https://ocr.innoveraappcenter.com                # every check PASS, SUMMARY FAIL=0
   ```
9. **The user's own checks.** Log in in the browser, create the staff accounts and hand over the temporary passwords
   in person; review one existing document and confirm the drawer shows `ยืนยันโดย <name>`. Counts only:
   ```sh
   $C exec -T postgres psql -U ocr_bootstrap -d innovera_ocr -AtX -c \
     "SELECT count(*) FROM documents d JOIN users u ON u.id::text = d.reviewed_by"        # ≥ 1
   $C exec -T postgres psql -U ocr_bootstrap -d innovera_ocr -AtX -c \
     "SELECT action, count(*) FROM audit_events GROUP BY 1"
   ```
   Optionally `APP_BASE_URL=https://ocr.innoveraappcenter.com SAMPLE_FILE=<file> E2E_USERNAME=<own account>
   ./deploy/e2e-production.sh`; it prompts for the password.
10. The worker is **not** touched in Deploy A (the image it shipped requires 0018).
11. **Freeze 0019.** Commit the `test/migration-checksums.test.ts` pin (`APPLIED_IN_PRODUCTION = "0019_user_auth"`).
    From here on a fix to 0001–0019 takes a new migration. `0020_batch_round_clock` — the batch clock — is that new
    migration and ships in Deploy B; it is applied nowhere yet, so it may still be edited, with its pin regenerated
    in the same commit. A schema fix on top of it takes 0021.

## Rollback A

```sh
docker tag <web repo>:pre-release2 <web image>
$C up -d --no-deps web
```

- 0019 stays: it is additive, and the old migration runner iterates only the files its own image carries.
- The old web's `/api/web-token` answers 503, because `OCR_WEB_AUTO_AUTH` is absent and the compose default is 0. The
  UI stays unusable until a fix-forward, and **the public token hole does not reopen**. Reopening it needs the user's
  explicit approval.
- **Bearer stays closed too**, because step 3 rotated `AUTH_JWT_SECRETS`: every JWT minted before Deploy A now fails
  signature verification on the rolled-back image as well.
- Restore the dump only if data is damaged. The volume is never recreated.

## Deploy B: export, batch clock and request timeout (0020, web then worker)

Runs only after Deploy A is accepted. It adds migration `0020_batch_round_clock` (two nullable columns and one
column-scoped GRANT — no function, nothing rewritten), the three `/api/exports/*` routes with the `ส่งออก` dialog, and
`OCR_REQUEST_TIMEOUT=300`. **Migrations 0001–0019 are frozen**: they are applied in production and their sha256 is
pinned by `test/migration-checksums.test.ts`, so a fix to any of them takes a new migration, never an edit. `0020` is
that new migration and is applied nowhere yet, so it may still be edited up to this deploy — with its pin regenerated
in the same commit. (`OCR_REQUEST_TIMEOUT` is the **worker's** HTTP timeout to the OCR API, `packages/config` →
`ocr.requestTimeoutSeconds`; it is unrelated to the export's own budgets.)

0. **The proxy's read timeout** (read-only, and it needs its own approval because it reads the shared proxy, exactly
   like Deploy A step 0):
   ```sh
   docker exec <nginx-proxy> nginx -T 2>/dev/null | grep -E 'proxy_read_timeout|proxy_send_timeout'
   ```
   Record what the vhost carries. An export streams one chunk per `FETCH 500`, and the only thing bounding the gap
   between two writes is the export's own `statement_timeout` of **60 s** — exactly nginx's default
   `proxy_read_timeout`. The BOM and header row go out at once, so the proxy never waits with no data at all, but a
   slow page mid-stream can still be cut. If the vhost is at the 60 s default, expect a large export to end as a 504
   in the browser (`audit_events` records `export.failed`, and the browser saves nothing), and raise
   `proxy_read_timeout` before raising `OCR_EXPORT_MAX_ROWS`. Changing the shared proxy is its own approved step.

1. **[CHANGE] Backup and tags.**
   ```sh
   install -d -m 700 /opt/innovera-backups/release2b-<date>
   $C exec -T postgres pg_dump -U ocr_bootstrap -d innovera_ocr -Fc > /opt/innovera-backups/release2b-<date>/database-pre-0020.dump
   $C exec -T postgres pg_restore --list < /opt/innovera-backups/release2b-<date>/database-pre-0020.dump | head -3
   docker tag <web image> <web repo>:pre-release2b
   docker tag <worker image> <worker repo>:pre-release2b
   ```
   Then `git fetch origin` and `git checkout <release tag>`.
2. **[CHANGE] Host env edit** (keys only in any output):
   - **set** `OCR_REQUEST_TIMEOUT=300` — set it, do **not** delete the line. The key is in `production-preflight.sh`'s
     `required_values` and `has_value` needs it non-empty, so deleting the line fails the preflight.
   - `OCR_EXPORT_MAX_ROWS` may stay absent; the compose default is 50000. A value outside 1–200000 fails startup
     rather than widening the cap, and a missing one can no longer disable it.
   - `grep -oE '^[A-Z_]+=' <the host env file> | sort` to confirm the key set; values are never printed.
3. **[CHANGE] Stop the old worker FIRST.**
   ```sh
   $C build web worker
   $C stop worker
   ```
   This order is load-bearing: while the old worker runs against the new web, a retry can open a new round and clear
   `processing_started_at`, but the old `markProcessing` sets no clock — `round_started_at` would stay NULL for good
   and the finished batch would keep showing `รอเริ่มอ่านรอบใหม่`. Stopping first costs at most one in-flight lease,
   which the queue recovers. Waiting for `count(*) WHERE status='PROCESSING'` = 0 is **not** a substitute: it races
   with the next claim, and while a long PDF is being read it is almost never 0 (~52 s/page, 95 pages ≈ 82 min).
4. **[CHANGE] Web.** `$C up -d --no-deps web`, which applies 0020.
   ```sh
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:53100/health/ready          # 200
   $C exec -T postgres psql -U ocr_bootstrap -d innovera_ocr -AtX -c "SELECT max(version) FROM schema_migrations"   # 0020_batch_round_clock
   $C logs --since 5m web | grep -c request_failed                                        # 0
   $C exec -T postgres psql -U ocr_bootstrap -d innovera_ocr -AtX -c "SELECT pg_get_userbyid(proowner), count(*) FROM pg_proc WHERE proname LIKE 'ocr%' GROUP BY 1"
   ```
   The last one must still print 7 × `ocr_queue_definer` and 1 × `ocr_migrator`: 0020 defines no function.
5. **[CHANGE] Worker.** `$C up -d --no-deps worker`, which passes the 0020 gate.
   ```sh
   $C exec -T worker printenv OCR_REQUEST_TIMEOUT      # 300
   $C logs --since 5m worker | grep -c worker_started  # 1
   ```
6. **Grant check.** Re-run Deploy A step 6. It must now print `SUMMARY PASS=20 SKIP=0 FAIL=0`: the two 0020 checks
   (`app:update-batch-round`, `app:no-update-batch-label`) answer instead of skipping, which is itself the proof that
   0020 reached this database.
7. **Checks by the user** (production exports never leave the user's browser and never reach git or chat):
   - a staff account **without** export rights sees no `ส่งออก` pill, and opening `/api/exports/documents.csv`
     directly answers 403;
   - the admin opens `ส่งออก`, reads `พบ N แถว · แสดง 20 แถวแรก`, checks that the first column is the **original**
     uploaded file name with หน้า / จำนวนหน้า / อัปโหลดเมื่อ beside it, then downloads the CSV and opens it on their
     own machine;
   - **opening the CSV in Excel:** use **Data ▸ From Text/CSV** and set the ห้อง and เลขที่ฟอร์ม columns to **Text**.
     A double-click works too — Thai reads correctly because of the UTF-8 BOM — but Excel then turns a room number
     like `007` into `7`. The dialog says the same thing in Thai above the download button. The file itself never
     uses `="…"`, so no cell can be a formula; a name that starts with `=`, `+`, `-` or `@` gets a leading `'`
     instead, which Excel does not display.
   - the audit table has a `started` for every `completed`:
     ```sh
     $C exec -T postgres psql -U ocr_bootstrap -d innovera_ocr -AtX -c "SELECT action, count(*) FROM audit_events WHERE action LIKE 'export.%' GROUP BY 1"
     ```
   - `curl -s 127.0.0.1:53100/metrics | grep -E 'exports_total|export_rows_total'` (from inside the app network, not
     through the proxy — a request carrying `X-Forwarded-For` gets 404 by design);
   - retry one failed row in an idle batch: the strip shows `รอเริ่มอ่านรอบใหม่` with `—` for เวลาที่ใช้ and
     หน้า/นาที, then a new round once the worker claims the row.

## Rollback B

```sh
docker tag <web repo>:pre-release2b <web image>
docker tag <worker repo>:pre-release2b <worker image>
$C up -d --no-deps web worker
```

- The Deploy A images require only 0018 (worker) and 0019 (web). 0020's two columns are additive and simply ignored,
  and `OCR_REQUEST_TIMEOUT` stays 300.
- The export disappears with the web image; nothing has to be undone in the database.

## If an export does not work

- **A staff member sees no `ส่งออก` pill:** an admin turns on ส่งออกได้ for that account in ผู้ใช้งาน. An admin row
  reads `ใช่ (ผู้ดูแล)` and has no button there, because the admin role carries the right by itself (D8).
- **`เกิน 50000 แถว`:** narrow the date range in the dialog, or raise `OCR_EXPORT_MAX_ROWS` (maximum 200000) and
  recreate the web. The cap exists so one request cannot stream the whole tenant.
- **`EXPORT_BUSY` (429):** one download per user and two per process are open at a time, and an export is given ten
  minutes — after which the web ends that download (it closes the cursor **and** the socket) and the slot comes back.
  Wait, or ask whoever is downloading to finish.
- **The download stops part-way:** the browser saves nothing (the file is fetched as a Blob, and a rejected Blob is
  never written), and the attempt is in `audit_events` as `export.failed`. `export.started` is always there, so the
  table still answers who exported what.

## If a staff member cannot log in

- **Wrong password ten times:** the account locks for 15 minutes and answers exactly like a wrong password. An admin
  clears it from the user dialog, or from the host with `./deploy/ocr-users.sh unlock --username <name>`.
- **Every administrator is locked out:** `./deploy/ocr-users.sh reset-password --username <name>` on the host sets a
  password you type, clears the lock and revokes that user's sessions. The account must change the password at the
  next login (within 72 hours).
- **Nobody can log in at all** and the cause is unknown: check `auth_logins_total` in Prometheus and
  `$C logs --since 15m web | grep -c login_failed` before touching the database.
