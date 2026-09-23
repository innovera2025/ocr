# Release 2 deploy runbook — Deploy A (login)

Source of truth: `release2-plan.md` §15. This file is the operator's copy of that section: what to run, in what order,
and what each step must print. Deploy B (export, the batch clock and the request timeout) is added to this file with
commit C11 and is **not** part of Deploy A.

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
- The worker is **not** touched. It still requires `0018_multipage_documents`.

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
   #   … SUMMARY PASS=18 FAIL=0
   ```
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
10. The worker is **not** touched in Deploy A (it still requires 0018).
11. **Freeze 0019.** Commit the `test/migration-checksums.test.ts` pin. From here on a schema fix takes 0020 and the
    batch clock slides to 0021.

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

## If a staff member cannot log in

- **Wrong password ten times:** the account locks for 15 minutes and answers exactly like a wrong password. An admin
  clears it from the user dialog, or from the host with `./deploy/ocr-users.sh unlock --username <name>`.
- **Every administrator is locked out:** `./deploy/ocr-users.sh reset-password --username <name>` on the host sets a
  password you type, clears the lock and revokes that user's sessions. The account must change the password at the
  next login (within 72 hours).
- **Nobody can log in at all** and the cause is unknown: check `auth_logins_total` in Prometheus and
  `$C logs --since 15m web | grep -c login_failed` before touching the database.
