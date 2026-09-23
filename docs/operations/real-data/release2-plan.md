# Release 2: user login first, then export (implementation plan)

Status: PLAN, not started. The user approved the scope and order on 2026-09-22: login first, then export, plus the
Release 1 carry-overs. Every production step below needs the user's approval, and so does each deploy.
Branch `feature/release2-login-export` (from main `78a92b8`). Inputs: `release2-requirements.md`,
`design-2026-09-22.md` §3, `release1-report-2026-09-22.md`, `../full-document-batch-spec.md` and
`../full-document-batch-deploy.md`. Code references are `path:line` on `78a92b8`.

Hard rules for everyone who implements this plan:
- RLS, the roles and the SECURITY DEFINER model stay as they are.
- Migrations are numbered and additive, and each has tests. Never edit 0001–0018: they are checksummed
  (`packages/db-runtime/src/index.ts:30-33`). **From the moment Deploy A applies 0019, 0019 is frozen too**: any edit
  makes the web crash-loop at startup with `MIGRATION_CHECKSUM_MISMATCH` before it listens
  (`apps/ocr-web/src/server.ts:439-440,453`). A schema fix needed between Deploy A and Deploy B takes the **next free
  number** (0020), and the batch clock then becomes 0021 (§3 A3).
- No signing secret reaches browser JavaScript, and no page or script ever asks for a Bearer token.
- No password, session token, cookie, CSRF token or temporary password is ever printed, logged, committed or placed in
  argv or env. This includes shell scripts: a secret header goes into a mode-600 file passed as `-H @file`, never as
  `-H "X-…: $var"`, which every other user on the shared host can read through `ps` and `/proc`.
- Nobody but the user types the first admin's password, in their own terminal.
- Never recreate the PostgreSQL volume or delete production data. Never touch nginx-proxy or the other apps on the
  shared host, except for the read-only check in §15.1, and only with the user's approval.
- Real customer data never goes into git. Tests use synthetic rows only.

## 0. Design selection

Three designs were scored from 1 (poor) to 5 (best):

| | Security | Hard constraints | Fit with code | Operability (5–50 staff) | Delivery risk (5 = low) |
|---|---|---|---|---|---|
| 1. Security-first (server sessions, setup links, step-up, synchronizer CSRF token) | 5 | 5 | 3 | 3 | 2 |
| 2. Minimal change (keep Bearer JWT, 5-min token plus refresh cookie, in-process denylist) | 3 | 4 (the clock starts at the retry click, not the first claim; no DB audit) | 5 | 4 | 4 |
| 3. Operator-first (server sessions, Origin CSRF, temporary passwords, audit table) | 4 | 5 | 4 | 5 | 3 |

**Base: design 3.** It has server-side revocable sessions, no credential readable by JavaScript, one auth path,
admin-managed accounts with a forced password change, and an append-only audit table.

**Taken from design 1:**
- a session-bound `X-CSRF-Token` derived from the session secret;
- a per-user `can_export` flag;
- a per-username throttle that also applies to unknown usernames, so the lock state never reveals which accounts exist;
- scrypt N=2^15, r=8, p=3 (32 MiB, about 250 ms measured locally), with NFKC normalization and a 12-character minimum;
- audit rows written in the same transaction as the action;
- a rollback that fails closed.

**Taken from design 2:**
- one shared WHERE builder for the list and the export;
- the per-IP limiter counts failures only;
- the startup check of the login tenant;
- bounds-checking of the hash parameters stored in the DB;
- the first generator step is awaited before `writeHead`;
- `23505` is mapped to `USERNAME_TAKEN`;
- the e2e script sends the password through stdin.

**Added by this plan:**
- `Sec-Fetch-Site` handling that also blocks *same-site* requests. The shared host serves other
  `*.innoveraappcenter.com` apps, and SameSite=Strict treats those as same-site.
- The per-IP limiter is off while `OCR_TRUSTED_PROXY_HOPS=0`, because every request would share the proxy's IP.
- `processing_started_at = COALESCE(…, now())`, and it is reset on retry, so the clock is "first claim since a person
  re-queued the row".
- Temporary passwords expire.

**Rejected:**
- design 2's JWT plus refresh-cookie model: two credentials, and revocation that only holds in memory;
- design 2's web-only clock;
- design 1's setup links, step-up re-authentication, client idle timer, `documents.uploaded_by` column, SecLists
  denylist and IP storage.

## 1. Goals and non-goals

**Goals**
1. Every staff member logs in with their own username and password. Reviews, legacy confirmations, batches, uploads,
   retries, exports and user administration are attributed to the logged-in user, both in the existing actor columns
   and in `audit_events`.
2. The public `GET /api/web-token` (`apps/ocr-web/src/server.ts:384-396`) and `mintWebJwt` (`server.ts:102-149`) are
   removed. The web API no longer accepts Bearer JWTs at all.
3. Export (CSV UTF-8 BOM and JSONL) ships only after login is live in production. It has one row per document or page,
   and its first columns are ชื่อไฟล์ต้นฉบับ, หน้า, จำนวนหน้า and อัปโหลดเมื่อ. It supports filters, a preview table,
   streaming, a formula guard and limits.
4. Carry-overs:
   - the batch clock starts at the first claim of the current processing round;
   - production `OCR_REQUEST_TIMEOUT` becomes 300.

**Non-goals (deferred)**
- Authentication extras: multi-tenant login, 2FA or TOTP, SSO, email or SMS password reset, self-registration, and
  step-up re-authentication.
- Integration features: an audit-log UI (the table is queryable), API keys for integrations, XLSX, and signed download
  URLs.
- Design items that move to Release 3: cancel and queue visibility (the design's `0019_cancel_queue_visibility` is
  renumbered to 0021), template and branch columns (renumbered to 0022), and the generic path.
- Schema changes: retyping the `reviewed_by`, `verified_by` or `created_by` columns, and a `documents.uploaded_by`
  column.
- Relaxing the `AUTH_JWT_*` production policy in `loadConfig` (`packages/config/src/index.ts:41`). It runs in the
  worker too (`services/ocr-worker/src/index.ts:415`), so it stays.

## 2. Decisions

| # | Decision | Why (evidence) | Rejected |
|---|---|---|---|
| D1 | **Opaque server-side sessions.** A 32-byte random token goes in the cookie `__Host-ocr_session` (HttpOnly, Secure, SameSite=Strict, Path=/, no Max-Age, so it is a browser-session cookie). Only its SHA-256 is stored in `auth_sessions`. Every API request resolves the session, the user, the role and the disabled state from the DB. | Revocation is immediate: logout, disable, password reset. JavaScript never holds the credential, and the existing ban on `document.cookie` and storage stays (`workbench.test.ts:35`). Needs no secret. | An in-memory JWT (re-login on every reload). A JWT plus refresh cookie (two credentials; revocation only in memory). A stateless signed cookie (no revocation, needs a new secret). |
| D2 | **The login tenant comes from config.** Reuse `OCR_WEB_TENANT_ID` (`deploy/docker-compose.yml:45`, already set on the host). Every users/sessions/audit query runs under `set_config('app.current_org', <config tenant>)` with the normal org policy. | Production has one tenant. FORCE RLS is unchanged. There is no new role, no function and no superuser step, so 0019 is grants-only like 0017 and 0018 (`test/batch-migration.test.ts:40-62`). | (B) a SELECT policy keyed on a login GUC. (C) a SECURITY DEFINER lookup owned by a new NOLOGIN BYPASSRLS role: a superuser step on deploy, a lock-out window, and a second function set migrations must never touch. (D) a definer function owned by the migrator. BYPASSRLS on `ocr_app`. A tenant-less users table. |
| D3 | **scrypt from `node:crypto`.** Parameters N=2^15, r=8, p=3, 16-byte salt, 32-byte key, maxmem 64 MiB. The stored format is self-describing: `scrypt$v1$N=32768,r=8,p=3$<salt b64url>$<key b64url>`. The hash is upgraded at login when the parameters change, unknown users are verified against a dummy hash, and at most 2 hashes run at once. | This is an OWASP scrypt setting. It uses 32 MiB and took about 250 ms locally (N=2^16 took 358 ms, N=2^17 418 ms). It needs no dependency: pnpm builds only esbuild (`pnpm-workspace.yaml`) and enforces a 7-day release age. | argon2 as a native npm module. `crypto.argon2` (experimental, and `@types/node` 24.0.10 has no types for it). bcrypt (native, 72-byte cap). pgcrypto `crypt()`, which puts the plaintext into SQL. |
| D4 | **Layered CSRF defence.** (a) SameSite=Strict. (b) On every `/api` request, a `Sec-Fetch-Site` other than `same-origin` or `none` gives 403. (c) Every non-GET/HEAD request must carry an `Origin` equal to `OCR_PUBLIC_BASE_URL`'s origin; without `Origin`, `Sec-Fetch-Site: same-origin` is required. (d) `X-CSRF-Token` must equal a token derived from the session secret. (e) JSON bodies require `application/json`, otherwise 415. | `readJson` ignores Content-Type (`server.ts:151-166`) and `/retry` has no body (`server.ts:338-346`), so a cookie session without these checks could be forged by any site. SameSite alone does not stop sibling `*.innoveraappcenter.com` apps, which count as same-site. A derived token needs no storage. | SameSite alone. A double-submit cookie (`document.cookie` is banned). A stored per-request token table. |
| D5 | **Throttling, and one answer for every unknown state.** (1) In memory, per client IP (only when `OCR_TRUSTED_PROXY_HOPS ≥ 1`): 30 failures per 15 min. (2) In memory, per normalized username, **whether or not the account exists**: 10 failures per 15 min. (3) In memory, a **global budget for failures on names that match no user**: 60 per 15 min; beyond it the answer is the normal 401 after a fixed 250 ms delay and **no hashing**. (4) In the DB, per account: 10 consecutive failures lock the account for 15 min; an admin can unlock it. **Only the in-memory windows (1) and (2) ever answer 429 `LOGIN_THROTTLED`, and they treat every name alike. A DB-locked account answers exactly like a wrong password: 401 `INVALID_CREDENTIALS`, no `Retry-After`, after the same hashing work.** The lock is visible only to admins, through `status:'locked'` in the users list. A global hash gate answers 429 `LOGIN_BUSY`. | ASVS L2 asks for fewer than 100 failed attempts per hour. The DB lock survives restarts. Nothing is enumerated **because the two counters never disagree in public**: the DB counter has no time decay while the username window is a 15-min sliding one, so 9 failures, a drained window and 1 more failure would otherwise return 429 + `Retry-After` for a real account and 401 for an unknown one. Budget (3) is what stops random-username floods from costing a CPU-bound hash each. With hops=0 every request carries the proxy's IP (`docker-compose.yml:36`; `trustedProxyHops` is parsed but unused, `config/src/index.ts:6,45`), so a per-IP limit would become a global DoS switch — which is why `OCR_TRUSTED_PROXY_HOPS=1` is a **precondition of Deploy A** (§15.1), not an optional extra. | A hard lock until an admin unlocks. 429 for a DB-locked account (an enumeration oracle). CAPTCHA (an external script, blocked by the CSP). Per-IP limits only. |
| D6 | **Staff onboarding.** The server generates a temporary password when an admin creates or resets a user. It is shown to the admin once, expires after 72 h, forces a password change at first login and is **consumed by that first successful login**: `recordLoginSuccess` sets `password_expires_at = now()` whenever `must_change_password` is true, so the only way forward is the change inside that one session. A lost session means the admin issues a new temporary password. The **first admin** comes from a TTY-only CLI that the user runs. | Needs no email or SMS infrastructure and is familiar at a front desk. Without the consume step a temporary password stays usable for 72 h even after the staff member abandons the forced-change dialog, so the admin, a colleague or anyone who saw the paper could act under that user's name — which defeats the per-user attribution this release exists for. The user's hard rule covers the first admin, and the CLI keeps that password out of logs, history, git and chat. | One-time setup links (a second token flow; the link travels over chat just like a password). Requiring `newPassword` inside the login exchange (a second shape for the login route). An admin-chosen password. A password in env or argv. |
| D7 | **Remove Bearer from the web API entirely, and rotate the signing key.** `deploy/e2e-production.sh` logs in with a hidden password prompt. `AUTH_JWT_*` stays in the env only for the shared production policy, and **Deploy A step 3 writes a freshly generated random `AUTH_JWT_SECRETS` straight into the host env file** (never printed). | One auth path. Every outstanding web-token, and any `JWT_TOKEN` without `exp` (those never expire, `packages/auth/src/index.ts:31`), stops working at deploy. Without the rotation a web-image rollback would silently re-enable every long-lived operator token, because the old image still verifies Bearer (`apps/ocr-web/src/server.ts:248`). The new web never verifies Bearer and the worker only needs the key to be present, so the rotation costs nothing. | Bearer kept behind a flag. Keeping the old secret (rollback reopens Bearer). Scoped API keys (deferred until an integration needs them). |
| D8 | **Roles `admin` and `staff`, plus a per-user `can_export` flag.** Both are read from the DB on every request. Guards: last active admin, no change to yourself, and no self reset/unlock. **`can_export` gates the export *file*, not access to the data.** Any staff session can already page `GET /api/documents` (limit 200, offset to 1,000,000 — `server.ts:187-189`) and open `GET /api/documents/:id/ocr`, which returns the full `structured_result` and `raw_response` including health conditions (`packages/ocr-persistence/src/index.ts:191-194`, `document-view.ts:241-243`). The flag is a least-privilege and audit control for one-click bulk download, not a confidentiality boundary; the compensating control is the read-volume metric and alert in §13. | Least privilege for bulk export of health data, with no stale privileges, and an honest statement of what it does not cover. | Every staff member can export. An env-wide export role list. A third role. Claiming the flag protects the data itself. |
| D9 | **Attribution.** The varchar actor columns keep their type and receive `users.id`. Names come from a join. An append-only `audit_events` table is written **in the same transaction** as each action. Historic rows show the label `บัญชีรวม (ก่อนมีระบบล็อกอิน)`. **Append-only holds for `ocr_app` only**: the web container also carries `DATABASE_URL_MIGRATOR`, the table owner (`docker-compose.yml:48`, `server.ts:439`), so a compromise of the web process can still rewrite the table. Every audit action is therefore **mirrored as a stdout log event**, which gives `docker logs` a second, independent trail. | No retyping or backfill, which is impossible under FORCE RLS anyway (`packages/ocr-persistence/src/index.ts:159`). The audit table fills today's gaps: `saveReview` overwrites `verified_by` on conflict (`index.ts:865-866`), and uploads and retries record no actor (`server.ts:255-269,338-346`). | Typed `*_user_id` columns. stdout logs as the only audit trail. Claiming tamper-proofness the grants do not give. Seeding fake legacy users. Moving migrations into a one-shot service (a compose-shape change; noted as a Release 3 option in §17). |
| D10 | **Export streaming.** A server-side cursor (`DECLARE … FETCH 500`) inside one REPEATABLE READ READ ONLY tenant transaction with SET LOCAL timeouts, on a client that carries its own `'error'` listener for as long as it is checked out. Count first. At most 2 exports per process and 1 per user. The browser downloads with fetch and a Blob. | A cursor avoids the keyset bug: pg returns millisecond `Date` values while the column stores microseconds. It also handles mixed sort directions. A socket cut mid-stream rejects the fetch, so a truncated file is never saved. The listener is mandatory: `idle_in_transaction_session_timeout` can terminate the backend while the stream waits for `'drain'`, node-postgres then emits `'error'` on the checked-out client, and **no pool or client in this repo has an error listener today** (`packages/db-runtime/src/index.ts:54-57`; the only `on("error")` are ClamAV sockets and the HTTP server), so the web process would crash and cut every in-flight upload. | A keyset built on JS `Date`. A bare pooled client. A plain link download (errors become files). |
| D11 | **Batch clock.** `ocr_batches.round_opened_at` is set by the web when a retry lands in an idle batch. `documents.processing_started_at` is set by the worker's `markProcessing` on the first claim since the row was (re)queued. The first round keeps `createdAt`. | Matches "the first claim of the current round" (release2-requirements.md). ocr_app cannot read the claim time (`extraction_jobs.locked_at` is not granted, 0016). Never-retried batches keep their current numbers, so existing tests stay valid (`index.test.ts:130`, `batch.db.test.ts:251,569-583`). | The retry click as the start. A column grant on `extraction_jobs` (`locked_at` is cleared on finish). A client-only fix: the server's `durationMs` wins (`workbench.ts:345`). |
| D12 | **Two deploys.** A = login (0019, web only). B = export, batch clock and timeout (0020, web then worker). | Export is never live before login and before staff accounts exist, and each blast radius is small. | One combined deploy (allowed as a user decision, §16). |
| D13 | `/metrics` answers 404 when the request carries `X-Forwarded-For`, `X-Forwarded-Host` or `X-Real-IP`, i.e. when it came through nginx-proxy. Prometheus scrapes `web:3100` directly (`deploy/prometheus-production.yml`). | Today metrics are public through the vhost (`server.ts:409-413`), against `deploy/README.md:23`. | A separate port. Changing nginx-proxy (the shared host must not be touched). |

## 3. Workstream A: migration `0019_user_auth`

A1. `prisma/migrations/0019_user_auth/migration.sql`. It runs as `ocr_migrator` inside the runner's transaction and
must contain no BEGIN/COMMIT, no FUNCTION, no role statement, no DROP TABLE/COLUMN and no CONCURRENTLY.
**It creates no SECURITY DEFINER function and touches none of the 7 queue/outbox functions owned by
`ocr_queue_definer`.**
```sql
-- 0019_user_auth: staff accounts, server-side browser sessions and an append-only audit log.
-- Runs as ocr_migrator inside the runner's single transaction. Defines no function: the queue and confirm-outbox
-- SECURITY DEFINER functions are owned by ocr_queue_definer and must never be created or replaced here.
-- Login runs under the deployment's configured tenant (OCR_WEB_TENANT_ID): the web sets app.current_org before every
-- query on these tables, so FORCE RLS applies unchanged and no cross-tenant lookup path exists.
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  username varchar(32) NOT NULL CHECK (username ~ '^[a-z0-9][a-z0-9._-]{2,31}$'),
  display_name varchar(100) NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 100),
  role varchar(16) NOT NULL CHECK (role IN ('admin','staff')),
  can_export boolean NOT NULL DEFAULT false,
  password_hash varchar(200) NOT NULL CHECK (password_hash LIKE 'scrypt$%'),
  must_change_password boolean NOT NULL DEFAULT false,
  password_expires_at timestamptz,                 -- only for temporary passwords
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  failed_logins integer NOT NULL DEFAULT 0 CHECK (failed_logins >= 0),
  locked_until timestamptz,
  disabled_at timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  UNIQUE (organization_id, username)              -- usernames are lower-case by CHECK
);
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_scope ON users;
CREATE POLICY user_scope ON users USING (organization_id::text = current_setting('app.current_org', true));

CREATE TABLE IF NOT EXISTS auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL,
  token_hash bytea NOT NULL CHECK (octet_length(token_hash) = 32),   -- sha256 of the cookie token; never the token
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason varchar(24) CHECK (revoked_reason IN ('logout','relogin','password_changed','admin_reset','disabled')),
  UNIQUE (organization_id, token_hash),
  FOREIGN KEY (user_id, organization_id) REFERENCES users(id, organization_id),
  CHECK (expires_at > created_at)
);
ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS auth_session_scope ON auth_sessions;
CREATE POLICY auth_session_scope ON auth_sessions USING (organization_id::text = current_setting('app.current_org', true));
CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions(organization_id, user_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid,                              -- NULL: CLI bootstrap
  session_id uuid,
  action varchar(48) NOT NULL CHECK (action ~ '^[a-z]+(\.[a-z_]+)+$'),
  outcome varchar(16) NOT NULL DEFAULT 'success' CHECK (outcome IN ('success','failure','denied')),
  target_type varchar(16) CHECK (target_type IN ('user','document','batch','export')),
  target_id uuid,
  request_id varchar(128),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 4096),
  FOREIGN KEY (actor_user_id, organization_id) REFERENCES users(id, organization_id)
);
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_scope ON audit_events;
CREATE POLICY audit_scope ON audit_events USING (organization_id::text = current_setting('app.current_org', true));
CREATE INDEX IF NOT EXISTS audit_events_org_time_idx ON audit_events(organization_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_target_idx ON audit_events(organization_id, target_type, target_id) WHERE target_id IS NOT NULL;

-- Web runtime only; ocr_worker and ocr_queue get nothing. No DELETE anywhere: users are disabled, sessions revoked,
-- audit rows are append-only. Column-level UPDATE: id, organization_id, username and created_at never change.
GRANT SELECT, INSERT ON users, auth_sessions, audit_events TO ocr_app;
GRANT UPDATE (display_name, role, can_export, password_hash, must_change_password, password_expires_at, password_changed_at,
  failed_logins, locked_until, disabled_at, last_login_at, updated_at) ON users TO ocr_app;
GRANT UPDATE (last_seen_at, revoked_at, revoked_reason) ON auth_sessions TO ocr_app;
GRANT REFERENCES ON users TO ocr_app;             -- 0013 convention: DML roles hold REFERENCES for FK checks
```
Notes on the SQL:
- The policy text is identical to the existing policies, e.g. 0017 `batch_scope`. There is no FOR clause and no WITH
  CHECK, so USING also guards INSERT and UPDATE, and an unset GUC matches nothing.
- The column UPDATE grants also let ocr_app run `SELECT … FOR UPDATE` on users, which the last-admin guard needs.
- Sessions are never deleted. They stay as login history: about 36k rows a year at 50 staff. `cleanup-retention.sh`
  deletes nothing under FORCE RLS (`deploy/cleanup-retention.sh:15-22`), so it is not extended.
- `REQUIRED_SCHEMA_VERSION` stays `0018_multipage_documents` in Deploy A: the worker never reads these tables.

A2. **Grant checks.** The checks below are written **once, with explicit role names** (not `current_user`), so the same
SQL can run from any connection. They are added to `deploy/verify-db-roles.sh` in the existing `check_sql` style
(`deploy/verify-db-roles.sh:10`) **and** collected in a new `deploy/sql/verify-release2-grants.sql` that the runbook
runs inside the existing container as `ocr_bootstrap`, which needs no role password, no host `psql` and no host-
reachable DSN (§15 Deploy A step 6). `verify-db-roles.sh` keeps its role-DSN checks for provisioning flows.

- ocr_app: `has_table_privilege('ocr_app','public.users','SELECT')` = 1
- `app:no-delete-users`, `app:no-delete-auth-sessions`, `app:no-delete-audit` = 0
- `app:no-update-users-org`: `has_column_privilege('ocr_app','public.users','organization_id','UPDATE')` = 0
- `app:no-update-users-username` = 0
- `app:no-update-audit`: `has_any_column_privilege('ocr_app','public.audit_events','UPDATE')` = 0
- **`app:no-update-session-identity`**: `has_column_privilege('ocr_app','public.auth_sessions',<col>,'UPDATE')` = 0 for
  `token_hash`, `user_id`, `expires_at` and `organization_id`. Without this the only granted-column list that protects
  session identity is unverified in production.
- `worker:no-select-users`, `worker:no-select-sessions`, `worker:no-select-audit` = 0
- `queue:no-select-users`, **`queue:no-select-sessions`, `queue:no-select-audit`** = 0
- **`definer:no-users`, `definer:no-sessions`, `definer:no-audit`**:
  `has_any_column_privilege('ocr_queue_definer','public.users','SELECT')` = 0 and the same for the other two tables.
  `ocr_queue_definer` is the one BYPASSRLS role (`deploy/sql/queue-definer.sql:11-21`); if a grant ever drifts onto it,
  password hashes and sessions become readable across tenants through a SECURITY DEFINER function, and nothing else in
  production would notice.
- **`force-rls:release2`**: `SELECT bool_and(relforcerowsecurity) FROM pg_class WHERE relname IN ('users',
  'auth_sessions','audit_events')` = `t`, so FORCE RLS on the 3 new tables is machine-checked, not eyeballed.

After 0020 (§9) it also gains:
- `app:update-batch-round`: `has_column_privilege('ocr_app','public.ocr_batches','round_opened_at','UPDATE')` = 1
- `app:no-update-batch-label` = 0

A3. Numbering. Release 2 takes `0019_user_auth` and `0020_batch_round_clock`. In the same PR, update
`design-2026-09-22.md` §4.3, §5 and §6: cancel/queue visibility becomes `0021_cancel_queue_visibility`, and the
template/branch columns become `0022`.
**Once Deploy A has applied 0019 in production, 0019 is frozen** (hard rules). If the C8–C11 review or Deploy A itself
turns up a schema fix, it becomes `0020_<fix>`, the batch clock slides to `0021_batch_round_clock`, cancel/queue to
`0022` and template/branch to `0023`; the worker's `REQUIRED_SCHEMA_VERSION` and every pin in §12 follow the new
number. A static test pins 0019's sha256 from Deploy A onward (§12).

## 4. Workstream B: auth core (packages)

B1. `packages/auth/src/password.ts` (new; `node:crypto` only):
- `hashPassword(pw)` and `verifyPassword(stored, pw)`.
  - Both use async `crypto.scrypt`.
  - `verifyPassword` parses the stored string and bounds-checks it: N a power of two in 2^14..2^17, r 8..16, p 1..4,
    salt 16 bytes, key 32 bytes. A malformed or out-of-bounds hash returns `false` quickly.
  - Keys are compared with `timingSafeEqual`.
- `needsRehash(stored)`.
- `DUMMY_HASH`, computed once at startup **with exactly the parameters every stored hash uses**. Because the login path
  rehashes on `needsRehash`, a parameter change must be rolled out as: new constant → every account rehashed at its
  next login → only then is the old parameter set removed from the accepted bounds. A test asserts that verifying
  `DUMMY_HASH` and verifying a freshly created hash do the same amount of work (same N, r, p), so an unknown username
  cannot be told from a known one by timing.
- `normalizePassword(pw)`: `pw.normalize('NFKC')`, so Thai ำ equals ํ+า.
- `checkPasswordPolicy(pw, username)`:
  - 12–128 code points after normalization, and at most 512 UTF-8 bytes;
  - it must not contain the username (case-insensitive) and must not be a single repeated character;
  - it must not appear on a small bundled denylist (`common-passwords.ts`, about 200 entries: the most common passwords
    plus the context words makkha, innovera, spa, massage, admin, password and ocr);
  - spaces and Thai are allowed, and there are no composition rules;
  - a violation throws `WEAK_PASSWORD`.
- `generateTemporaryPassword()`: 16 characters from `abcdefghjkmnpqrstuvwxyz23456789` (about 79 bits), formatted
  `xxxx-xxxx-xxxx-xxxx`.
- `HashGate`: at most 2 concurrent hashes and a queue of up to 16. Beyond that it throws `LOGIN_BUSY`. Hashing always
  runs outside any DB transaction.
  - **Two gates, not one.** `loginGate` (2 + 16) serves `POST /api/auth/login`; a separate `adminGate` (1 + 4) serves
    password changes, `create-user` and `reset-password`. A single gate is itself the global DoS switch this plan says
    it wants to avoid: with hops=0 the per-IP limiter is off, random usernames bypass the per-username window, and an
    unauthenticated client at ~8 req/s (≈18 in flight, 250 ms per hash) keeps one gate permanently full, so every real
    staff login **and every admin recovery action** would answer 429 `LOGIN_BUSY`.
  - The unknown-name budget (D5.3) sits **in front of** `loginGate`, so a flood of names that match no user stops
    costing a 32 MiB scrypt job once the budget is spent.
  - `auth_logins_total{result="busy"}` is alerted on (§13): a sustained non-zero rate means the gate is under pressure,
    not that staff are typing badly.

B2. `packages/auth/src/session.ts` (new):
- `newSessionToken()`: `randomBytes(32)` as base64url, 43 characters.
- `hashSessionToken(t)`: SHA-256 of the decoded bytes.
- `csrfTokenFor(t)`: base64url of `HMAC-SHA256(key = token bytes, "innovera-ocr/csrf/v1")`.
- `verifyCsrf(t, header)`: constant-time compare.
- `sessionCookieName(env)`: `__Host-ocr_session` in production, `ocr_session` otherwise.
- `serializeSessionCookie(env, token)` and `clearSessionCookie(env)` (the clearing cookie has `Max-Age=0`). Production
  adds `Secure`; there is never a `Domain` attribute.
- `readSessionCookie(header, env)`: exactly one occurrence of the name and a 43-character base64url value. Anything else
  means "no session".
- Export type `AuthContext = { userId; tenantId; sessionId; username; displayName; role: 'admin'|'staff'; canExport;
  mustChangePassword }`.
- `authenticateBearer` stays in the package with its tests, but the web no longer imports it.

B3. `packages/ocr-persistence/src/tenant.ts` (new):
- `withTenant(pool, tenantId, work, { readOnly?, isolation?, statementTimeoutMs?, idleInTransactionTimeoutMs? })`.
- It runs `BEGIN [ISOLATION LEVEL …] [READ ONLY]`, then `set_config('app.current_org', $1, true)`, then the optional
  timeouts through `set_config('statement_timeout', $1, true)`. Numbers are validated, never interpolated.
- `PostgresOcrDocumentStore.tenantTransaction` (`index.ts:345-355`) delegates to it.

B4. `packages/ocr-persistence/src/audit.ts` (new):
- `insertAudit(client, { tenantId, actorUserId, sessionId?, action, outcome?, targetType?, targetId?, requestId?,
  detail? })`.
- The detail must be a flat object of scalars, at most 4 KiB. It must never contain passwords, tokens or OCR field
  values.
- `AuditContext = { actorUserId: string | null; sessionId?: string | null; requestId?: string }`.
- **`requestId` is always server-generated.** `requestId(header)` (`packages/observability/src/index.ts:31-34`) echoes
  the client's `X-Request-Id` whenever it matches `[A-Za-z0-9._:-]{1,128}`, so a user could otherwise stamp their own
  audit rows with another request's id. The server therefore mints `traceId = randomUUID()` per request, writes **that**
  into `audit_events.request_id`, and logs both (`request_id` = the echoed value in the response header and logs,
  `trace_id` = the server value, present on every log event and every audit row). `insertAudit` rejects a `requestId`
  it did not receive from the request context.
- **`access.denied` is rate-limited.** A forbidden request writes at most 5 audit rows per session per minute; beyond
  that only `http_requests_total` and a `access_denied_suppressed_total` counter move, so a staff session cannot flood
  an append-only table that nothing is allowed to delete from.

B5. `packages/ocr-persistence/src/users.ts` (new): `PostgresUserStore(pool, tenantId)`. Every method runs inside
`withTenant(configTenant)`. The server declares a structural `UserStore` type so tests can pass fakes (like
`WorkbenchStore`, `server.ts:21-28`).
- `assertTenant()`: `SELECT 1 FROM organizations WHERE id=$1`. Missing gives `LOGIN_TENANT_NOT_FOUND`, and web startup
  fails.
- `findLoginUser(username)` returns id, hash, displayName, role, canExport, mustChangePassword, passwordExpiresAt,
  lockedUntil and disabledAt.
- `recordLoginFailure(userId, max=10, lockMinutes=15, audit)` updates atomically:
  `failed_logins = CASE WHEN failed_logins+1 >= $max THEN 0 ELSE failed_logins+1 END` and
  `locked_until = CASE WHEN failed_logins+1 >= $max THEN now()+make_interval(mins=>$lock) ELSE locked_until END`.
  It returns `{ locked }`.
- `recordLoginSuccess(userId, rehash?)`: resets `failed_logins` and `locked_until`, sets `last_login_at`, and stores
  the new hash when one is given. **It also consumes a temporary password**: in the same statement,
  `password_expires_at = CASE WHEN must_change_password THEN now() ELSE password_expires_at END`. A second login with
  the same temporary password then fails 401 `PASSWORD_EXPIRED` (C3 step 8), so the credential is single-use as D6 and
  the UI both claim. No new column is needed.
- `createSession(userId, tokenHash, absoluteHours, audit)`.
- `resolveSession(tokenHash, idleMinutes)` is the single query in §5.2.
- `touchSession(sessionId)`, `revokeSession(tokenHash, reason, audit)` and
  `revokeUserSessions(userId, reason, exceptSessionId?)`.
- `changeOwnPassword(userId, newHash, audit)`.
- User administration: `listUsers()`, `createUser()`, `updateUser()` and `resetPassword()`.
  - `createUser` maps a `23505` on `users_organization_id_username_key` to `USERNAME_TAKEN`, so the pg `detail`, which
    holds row values, never surfaces.
  - `updateUser` applies the last-admin guard inside the transaction:
    `SELECT id FROM users WHERE role='admin' AND disabled_at IS NULL FOR UPDATE`.
- `unlockUser()`, `countActiveAdmins()`, `recordAudit(event)`.

B6. `packages/config/src/index.ts` gains `loadWebConfig(env)`. Only the web and the CLI call it; `loadConfig` and the
worker are unchanged.

| Env | Rule | Default |
|---|---|---|
| `OCR_WEB_TENANT_ID` | UUID, required when `OCR_ENV=production` | none |
| `OCR_PUBLIC_BASE_URL` | https URL, required in production. Its origin is used for CSRF, and it builds the export `review_url` | none in code; compose supplies the vhost origin |
| `OCR_SESSION_IDLE_MINUTES` | 5–480 | 30 |
| `OCR_SESSION_ABSOLUTE_HOURS` | 1–24 | 12 |
| `OCR_EXPORT_MAX_ROWS` | 1–200000 | 50000 |

`trustedProxyHops` keeps coming from `loadConfig`. The throttle numbers, the 72 h temporary-password lifetime and an
export concurrency of 2 are code constants, covered by tests.

## 5. Workstream C: server (`apps/ocr-web/src/server.ts` + new `auth.ts`, `auth-routes.ts`)

C1. **Remove the public token route.** Delete `mintWebJwt` (`server.ts:102-149`), the `/api/web-token` block
(`server.ts:384-396`) and the `OCR_WEB_AUTO_TOKEN_ROUTE`/`INNOVERA_OCR_ROOT_UI` comments (`server.ts:384,407`). Remove
the `createHmac` import. Remove `/api/web-token` from `routeLabel` (`server.ts:76`). `GET /api/web-token` then falls
through to 404 `{status:'not_found'}`. Every new route sits **inside** the request-id, metrics and try/catch block
(`server.ts:398-434`).

C2. **Order of checks on every `/api/*` request:**
1. **`Sec-Fetch-Site` guard.** If the header is present and is not `same-origin` or `none`, answer 403 `CSRF_REJECTED`
   and increment `auth_csrf_rejected_total`.
2. **Origin guard (non-GET/HEAD).** `Origin` must equal `new URL(OCR_PUBLIC_BASE_URL).origin`. Outside production,
   `http://<Host>` is also accepted. If `Origin` is absent, `Sec-Fetch-Site: same-origin` is required. Otherwise 403
   `CSRF_REJECTED`. This applies to `/api/auth/login` and `/api/auth/logout` too, which blocks login CSRF.
3. **Content type.** `readJson` requires the content type to start with `application/json`, otherwise 415
   `UNSUPPORTED_MEDIA_TYPE`. This covers every JSON route. Auth and user bodies are limited to 4 KiB.
4. **Session.** Every route except `POST /api/auth/login` and `POST /api/auth/logout` requires a session:
   `authenticate(request)` returns an `AuthContext` or throws `AuthenticationError('UNAUTHENTICATED')`, which maps to
   401. `AppServerOptions.authenticate` (`server.ts:38`) becomes
   `(request) => AuthContext | Promise<AuthContext>`, which keeps the test seam. The production implementation is
   `sessionAuthenticator(userStore, webConfig)`. The synchronous `principalFor` (`server.ts:248`) becomes
   `await authenticate(request)` at every call site: 257, 272, 280, 287, 295, 306, 322, 330, 340 and 349. It still runs
   before any body is read.
5. **CSRF token (non-GET/HEAD, except login and logout).** `X-CSRF-Token` must pass `verifyCsrf(cookieToken, header)`,
   otherwise 403 `CSRF_REJECTED`.
6. **Forced password change.** If `ctx.mustChangePassword` is set, every route except `GET /api/auth/session`,
   `POST /api/auth/password` and `POST /api/auth/logout` answers 403 `PASSWORD_CHANGE_REQUIRED`.
7. **Permissions** (§5.4). A denied request gets 403 `FORBIDDEN` and an audit row with outcome `denied`.
8. **The handler.** The tenant is always `ctx.tenantId`, which is the config tenant. Tenant headers stay ignored, and
   the test at `server.test.ts:217-228` keeps passing.

C3. **Login: `POST /api/auth/login {username, password}`**
1. Validate the body: two strings, with the username ≤ 64 characters and the password ≤ 512 bytes. Otherwise 400
   `INVALID_LOGIN`.
2. Normalize the username: NFKC, trim, lower-case. There is no format error: a malformed name simply finds no user.
3. **Throttle pre-check.** Check the per-IP window (only when hops ≥ 1) and the per-username window. If either is over
   its limit, answer 429 `LOGIN_THROTTLED` with `Retry-After`. Nothing is hashed and nothing is written. **Both windows
   key on values that say nothing about which accounts exist**, so this is the only 429 a client can provoke by
   guessing. A `LOGIN_BUSY` answer and every pre-check rejection also count as a per-IP failure (C11), so a flood
   throttles itself.
4. Acquire `loginGate`. If it is full, answer 429 `LOGIN_BUSY`.
5. `findLoginUser`. **A DB-locked account is not revealed.** When the user is unknown *or* `locked_until > now()`,
   the request continues to step 6 against `DUMMY_HASH` (unknown) or the real hash (locked), and then **always** ends
   at step 7 with the ordinary 401 — a correct password on a locked account is verified and its result discarded, so
   step 9 is unreachable while the lock holds. There is no 429 and no `Retry-After` on this path: the DB counter has
   no time decay while the
   in-memory window slides, so a 429 here would tell an attacker that the name belongs to a real account
   (9 failures → wait out the window → 1 more failure → the lock trips → the next try answers differently for a real
   name than for a made-up one). The lock is surfaced only to admins, as `status:'locked'` in `GET /api/users`.
   A locked account's `login.failed {reason:'locked'}` audit row is still written, **after** the response is sent
   (step 7).
6. `verifyPassword(user?.password_hash ?? DUMMY_HASH, normalized)`, **outside any DB transaction**. The unknown-name
   budget (D5.3) is consulted first: once it is spent, this step is skipped and step 7 answers after a fixed 250 ms.
7. **Failure** gives 401 `INVALID_CREDENTIALS` with the same body in every case: unknown user, wrong password, locked
   account, or a disabled user (whose password is checked first, for equal timing).
   - **The 401 is written to the socket before any DB write is awaited.** `recordLoginFailure` and its audit insert run
     after `respond()`, on a floating promise whose rejection is logged. A known user would otherwise wait for a
     committed UPDATE plus an INSERT while an unknown user waited for nothing — a timing oracle that survives every
     equal-status, equal-body measure above. A test asserts the same status, body, headers **and** response-time band
     for a known and an unknown name.
   - The in-memory IP and username windows count every failure.
   - For a known user, `recordLoginFailure` runs and audit writes `login.failed {reason}`, plus `login.locked` when the
     lock trips.
   - **Failures for unknown usernames write no DB row.** They only increment metrics, so random usernames cannot flood
     the table.
8. The password is correct but `password_expires_at < now()` (set at issue time for a temporary password, or by the
   consume step in B5 after the first login): 401 `PASSWORD_EXPIRED`. It is revealed only after a correct password, and
   it does not count as a failure.
9. **Success:**
   - reset the username window;
   - `recordLoginSuccess` (rehash when `needsRehash`; it also consumes a temporary password, B5);
   - if a valid session cookie came with the request, revoke that session with reason `relogin`;
   - create a new session (token, SHA-256, `expires_at = now() + OCR_SESSION_ABSOLUTE_HOURS`), which rules out
     session fixation;
   - audit `login.succeeded`;
   - answer 200 with `Set-Cookie` and
     `{user:{id,username,displayName,role,canExport,mustChangePassword}, csrfToken, idleMinutes, expiresAt}`.

C4. **Per-request session resolution:** one query under the config tenant.
```sql
SELECT s.id AS session_id, s.last_seen_at, s.expires_at, u.id, u.username, u.display_name, u.role, u.can_export, u.must_change_password
FROM auth_sessions s JOIN users u ON u.id = s.user_id AND u.organization_id = s.organization_id
WHERE s.organization_id = $1 AND s.token_hash = $2 AND s.revoked_at IS NULL AND s.expires_at > now()
  AND s.last_seen_at > now() - make_interval(mins => $3) AND u.disabled_at IS NULL
```
- A missing, expired, idle, revoked or disabled session all give the same 401 `UNAUTHENTICATED`.
- The idle deadline moves only on user actions. Requests carrying `X-OCR-Background: 1` (the workbench's polling)
  authenticate but do not touch it.
- Any other request touches the session with
  `UPDATE auth_sessions SET last_seen_at=now() WHERE id=$1 AND last_seen_at < now() - interval '1 minute'`, so there is
  at most one write per minute.

C5. **Other auth routes:**
- `GET /api/auth/session` returns 200 with the same payload as login, or 401. It counts as a user action.
- `POST /api/auth/logout` is idempotent and needs no CSRF token:
  - when the session is valid, revoke it (`logout`) and write audit `session.logout` (every action name has the form `area.verb`, as the CHECK requires);
  - always answer 204 with the clearing cookie.
- `POST /api/auth/password {currentPassword?, newPassword}`:
  - a wrong current password gives 400 `PASSWORD_INCORRECT`, not 401, so the re-login overlay does not open. It counts
    toward the account lock.
  - **`currentPassword` may be omitted when the session has `mustChangePassword` and was created less than 5 minutes
    ago** (`auth_sessions.created_at`). The user typed the temporary password seconds earlier; asking for it again is
    friction with no security value, since the session itself proves possession and can do nothing else (C2.6). Outside
    that window, and for every voluntary change, `currentPassword` is required. Both paths are tested.
  - `checkPasswordPolicy` runs, and the new password must differ from the current one.
  - On success: new hash, `must_change_password=false`, `password_expires_at=NULL`, `password_changed_at=now()`, revoke
    **all** of the user's sessions (`password_changed`), create a new session, set the cookie, audit
    `password.changed`, and answer 200 `{user, csrfToken, …}`.

C6. **Roles and permissions** (server-enforced; the UI only hides what the server refuses):

| Action | staff | staff + `can_export` | admin |
|---|---|---|---|
| List/view documents, batches, originals, review drawer | ✓ | ✓ | ✓ |
| Upload, create batch, retry, review/confirm (`/ocr/review`, `/ocr/confirm`) | ✓ | ✓ | ✓ |
| Export preview and download | ✗ (403 `FORBIDDEN`) | ✓ | ✓ |
| Manage users (`/api/users*`) | ✗ | ✗ | ✓ |
| Own session, own password, logout | ✓ | ✓ | ✓ |

Guards: demoting or disabling the last active admin gives 409 `LAST_ADMIN`. Changing your own role or disabled state
gives 409 `CANNOT_CHANGE_SELF`. **`reset-password` and `unlock` on yourself also give 409 `CANNOT_CHANGE_SELF`**, and
the UI hides both actions on your own row: a self-reset revokes your own sessions (`admin_reset`), so the next call
returns 401 and the opaque login dialog opens on top of `users-dlg`, hiding the one-time `#temp-pass` you would now
need. Admins change their own password through `เปลี่ยนรหัสผ่าน`.

C7. **User administration API** (admin only; JSON ≤ 4 KiB; unknown keys give 400 `USER_INVALID`):
- `GET /api/users` returns
  `{users:[{id,username,displayName,role,canExport,status:'active'|'disabled'|'locked'|'must_change',lockedUntil,lastLoginAt,createdAt}]}`.
  It never returns a hash.
- `POST /api/users {username, displayName, role, canExport}` returns 201 `{user, temporaryPassword}`.
  - The server generates the temporary password. It sets `must_change_password=true` and
    `password_expires_at = now() + 72 h`, and writes audit `user.created`.
  - Errors: `USERNAME_TAKEN` (409), `INVALID_USERNAME`, `INVALID_DISPLAY_NAME`, `INVALID_ROLE`.
- `POST /api/users/:id {displayName?, role?, canExport?, disabled?}` changes a user.
  - Disabling sets `disabled_at` and revokes the user's sessions (`disabled`); enabling clears `disabled_at`.
  - Audit `user.updated` records the changed field names only.
  - Errors: `USER_NOT_FOUND` (404 on an admin-only route, which reveals nothing), `LAST_ADMIN`, `CANNOT_CHANGE_SELF`.
- `POST /api/users/:id/reset-password` returns `{temporaryPassword}`. It sets the same flags as creation, clears the
  lock and revokes the user's sessions (`admin_reset`). Audit `user.password_reset`.
- `POST /api/users/:id/unlock` returns 204. It resets `failed_logins` and `locked_until` in the DB and clears the
  in-memory username window. Audit `user.unlocked`.
- The temporary password appears only in that single `no-store` response body. It is never logged or audited.

C8. **Error mapping** (`server.ts:41-65`). No new code starts with `AUTH_` or `TOKEN_`, and none ends in `_NOT_FOUND`
on the login path.

| Codes | Status | How |
|---|---|---|
| `INVALID_CREDENTIALS`, `PASSWORD_EXPIRED` | 401 | added to `AUTH_ERRORS` |
| `CSRF_REJECTED`, `FORBIDDEN`, `PASSWORD_CHANGE_REQUIRED` | 403 | new set |
| `LOGIN_THROTTLED`, `LOGIN_BUSY`, `EXPORT_BUSY` | 429 | new set, and they set `Retry-After` |
| `USERNAME_TAKEN`, `LAST_ADMIN`, `CANNOT_CHANGE_SELF` | 409 | added to `CONFLICT_ERRORS` |
| `LOGIN_NOT_CONFIGURED` | 503 | the existing `_NOT_CONFIGURED` rule |
| `INVALID_LOGIN`, `PASSWORD_INCORRECT`, `WEAK_PASSWORD`, `USER_INVALID`, `INVALID_USERNAME`, `INVALID_DISPLAY_NAME`, `INVALID_ROLE`, `INVALID_EXPORT_FILTER`, `EXPORT_TOO_LARGE` | 400 | the default |

`respond()` gains an optional `extraHeaders` argument for `Set-Cookie` and `Retry-After`.

C9. **`routeLabel`** (`server.ts:75-81`):
- exact paths: `/api/auth/login`, `/api/auth/logout`, `/api/auth/session`, `/api/auth/password`, `/api/users`,
  `/api/exports/preview`, `/api/exports/documents.csv`, `/api/exports/documents.jsonl`;
- templates: `/api/users/:id`, `/api/users/:id/reset-password`, `/api/users/:id/unlock`;
- anything else stays `unmatched`.

C10. **`/metrics`** (`server.ts:409-413`): answer 404 `{status:'not_found'}` when the request carries
`x-forwarded-for`, `x-forwarded-host` or `x-real-ip`. `/health/*` is unchanged.

C11. **Client IP** (`apps/ocr-web/src/auth.ts:clientIp(request, hops)`):
- hops = 0 means the socket address, and the per-IP limiter is **disabled**. The server logs
  `login_ip_throttle_disabled` once at startup **at warning level**, because in that state the only defences left
  against a hash flood are the unknown-name budget and the two gates (D5, B1). `OCR_TRUSTED_PROXY_HOPS=1` is a
  precondition of Deploy A (§15.1); hops=0 is a fallback, not the intended steady state.
- The per-IP window counts **every** rejected login attempt, including 429 `LOGIN_BUSY` and the step-3 pre-check
  rejections, not only wrong passwords. Otherwise a client that only ever gets 429 is never throttled.
- hops = n ≥ 1 takes the n-th entry from the right of `X-Forwarded-For`, falling back to the socket address.
- IPs are used only as in-memory keys, which are LRU-capped at 10k. They are never logged or stored.

C12. **`createProductionAppServer`** (`server.ts:438-449`):
- it builds `loadWebConfig()`, `PostgresUserStore(pool, tenant)` and `await userStore.assertTenant()`, then passes
  `userStore` and the session authenticator to `createAppServer`;
- `createRuntimeIngest` gains an `actor` argument (§6).

## 6. Workstream D: attribution and audit

Each item below says what records the actor and which audit row is written in the same transaction:

| Action | Actor recorded | Audit (same transaction) |
|---|---|---|
| Upload | `createRuntimeIngest(pool, tenantId, key, batchId, actor)` → `createUploadedDocument({…, audit})` (`runtime.ts:17-52`, `index.ts:377`) | `document.uploaded` (target document) for new documents only (not idempotent reuse) |
| Batch create | `createdBy = ctx.userId` (`server.ts:282`, unchanged value path) | `batch.created` |
| Review | `saveReview(…, {reviewedBy: ctx.userId, audit})` (`server.ts:333`) | `document.reviewed {corrections, delivery}` |
| Legacy confirm | `verifiedBy = ctx.userId` (`server.ts:351`); `saveCorrection` PENDING without an explicit audit now throws `CORRECTION_AUDIT_REQUIRED` (removes the `verifiedBy = tenantId` default, `index.ts:656`) | `document.field_confirmed {field}`: the field name, never the value |
| Retry | `retryDocument(tenantId, id, audit)` (`index.ts:814`) | `document.retried` |
| Login/logout/password | §5 | `login.succeeded`, `login.failed`, `login.locked`, `session.logout`, `password.changed` |
| User administration | §5 C7 | `user.created`, `user.updated`, `user.password_reset`, `user.unlocked`, `user.bootstrap` (CLI, actor NULL, `{via:'cli'}`) |
| Export | §10 | `export.started` **committed before `writeHead`**, then `export.completed` / `export.failed` appended after the stream (own small transactions) |
| Export preview | §10 H1 | `export.previewed {filters incl. has_q, rows}` — the preview returns the same columns for any filter, 20 rows a call, so without it a `can_export` user could pull the whole dataset through narrow previews and leave no `export.*` row |
| Forbidden request | §5 C2.7 | `access.denied {route}` (outcome `denied`), rate-limited per session (B4) |

- **Store signature changes.** `WorkbenchStore` (`server.ts:21-28`; persistence `index.ts:113`) gains the `audit`
  parameters listed above. The test fakes change with it.
- **Names.**
  - `REVIEW_SELECT` (`index.ts:191-194`) gains
    `(SELECT u.display_name FROM users u WHERE u.organization_id = d.organization_id AND u.id::text = d.reviewed_by) AS reviewed_by_name`.
    The text comparison stays safe with legacy non-UUID values, and the users table is tiny.
  - `ReviewDocument` gains `reviewedByName: string | null`.
  - A row with `reviewed_by` set but no matching user shows the legacy label `บัญชีรวม (ก่อนมีระบบล็อกอิน)`. No fake
    user rows are created and no data is rewritten.
- **Logs.**
  - `user_id` and the server-generated `trace_id` (B4) are added to `upload_completed`, `review_saved` and
    `document_retry_queued` (`server.ts:266,334,343`). `request_id` keeps echoing the client header; only `trace_id`
    is trustworthy for joining logs to audit rows.
  - **Every audit row is mirrored as a stdout log event** with the same action, outcome, actor, target and `trace_id`
    (never the detail's free text). The web process holds the table owner's DSN, so `docker logs` is the second,
    independent trail that a rewritten `audit_events` cannot erase (D9).
  - New events: `login_succeeded {user_id, session_id}`, `login_failed {reason}`, `logout {user_id}`,
    `password_changed {user_id}`, `user_admin {action, actor_user_id, target_user_id}`,
    `export_completed {user_id, format, rows, complete, duration_ms, has_q}`.
  - No log event ever carries a username, password, cookie, token, IP or search text.
  - The `logEvent` key filter (`packages/observability/src/index.ts:40`) also drops `cookie|authorization|csrf`.
  - Actions go in the event **name**. A field named e.g. `password_reset` would be silently dropped by the filter.

## 7. Workstream E: first-admin bootstrap CLI and deploy scripts

E1. `apps/ocr-web/src/cli/users.ts` and `apps/ocr-web/src/cli/tty.ts` (new). They live under `apps/`, so they are in
the web image (`deploy/Dockerfile.web:3-7`). `apps/ocr-web/package.json` gets the script
`"users": "tsx src/cli/users.ts"`.

Subcommands:
- `create-admin`
- `reset-password` (break-glass)
- `unlock`
- `list` (usernames, names, roles and status only)

Rules:
- It refuses unless `process.stdin.isTTY && process.stdout.isTTY`, exiting with code 2 and `TTY_REQUIRED`
  (`ต้องรันใน terminal แบบ interactive`). There is no password flag, no password env var and no file input. Unknown
  flags are rejected.
- **Prompts.**
  - The username and display name are prompted with echo, or passed as `--username` and `--display-name`; neither is
    secret.
  - The password is read twice in raw mode with no echo. Backspace works, Ctrl-C aborts, and the TTY mode is restored
    in `finally` and on SIGINT.
  - The password goes through `normalizePassword` and `checkPasswordPolicy`.
- **Database access.** It hashes in-process and connects with `DATABASE_URL`, which is **ocr_app**, never a superuser.
  It uses `PostgresUserStore` under `OCR_WEB_TENANT_ID` (`assertTenant` first), so FORCE RLS applies.
- **`create-admin`:**
  - refuses with `ADMIN_EXISTS` when an active admin exists;
  - inserts `role='admin'` and `must_change_password=false`;
  - writes audit `user.bootstrap`;
  - prints only `สร้างผู้ดูแลระบบ <username> แล้ว`.
- **`reset-password`** sets the typed password, clears the lock and revokes the user's sessions (`admin_reset`).
  Audit `user.password_reset {via:'cli'}`.
- Output and errors never contain what was typed at the password prompt.

E2. `deploy/ocr-users.sh` (new wrapper):
```sh
#!/usr/bin/env bash
set -euo pipefail
[ -t 0 ] && [ -t 1 ] || { echo "run this in an interactive terminal" >&2; exit 2; }
cd "$(dirname "$0")/.."
exec docker compose --env-file "${OCR_COMPOSE_ENV:-/etc/innovera/ocr-compose.env}" -f deploy/docker-compose.yml \
  exec -it web pnpm --filter @innovera/ocr-web run users "$@"
```
The user runs `./deploy/ocr-users.sh create-admin` in **their own** SSH session. Claude only prepares the command and
never runs it or sees what is typed. The output of `docker compose exec` never reaches `docker logs`, and shell history
holds only the command.

E3. `deploy/e2e-production.sh` is rewritten; `JWT_TOKEN` is removed.
- It requires `APP_BASE_URL`, `SAMPLE_FILE` and `E2E_USERNAME`.
- It reads the password with `read -r -s -p … pw < /dev/tty`.
- It builds the login body with
  `printf '%s' "$pw" | python3 -c 'import json,sys; print(json.dumps({"username":sys.argv[1],"password":sys.stdin.read()}))' "$E2E_USERNAME" | curl --data-binary @- …`,
  then runs `unset pw`.
- The cookie jar comes from `mktemp` with mode 600, and `trap 'rm -f "$jar" "$hdr"' EXIT` deletes it.
- The CSRF token is parsed from the login JSON and written straight into a second `mktemp` file `$hdr` with mode 600,
  as the single line `X-CSRF-Token: <value>`. **It never reaches a shell variable that is expanded into argv.**
- Every request sends `Origin: ${APP_BASE_URL%/}`, and every POST sends the CSRF header as `-H @"$hdr"`
  (curl ≥ 7.55; `-K "$cfg"` is the fallback). `-H "X-CSRF-Token: $csrf"` would put the token in argv, readable by
  every other user on the shared host through `ps` and `/proc` for the life of the request — which is exactly what the
  hard rules forbid, and what today's script does with `JWT_TOKEN` (`deploy/e2e-production.sh:22,33,41`). A static test
  asserts the script contains no `-H "X-CSRF-Token: $` and no `Authorization: Bearer`.
- It logs out at the end, and it never prints the password, cookie or token.

E4. `deploy/auth-smoke.sh <base-url>` (new; no credentials). It prints PASS or FAIL per check:
- `GET /api/web-token` gives 404;
- `GET /api/documents` gives 401;
- `POST /api/batches` with JSON and no `Origin` gives 403;
- `POST /api/batches` with `Origin: https://example.invalid` gives 403;
- `POST /api/auth/login` as `text/plain`, with the correct `Origin`, gives 415;
- `GET /metrics` through the public URL gives 404;
- `GET /` gives 200 with a `content-security-policy` header;
- `GET /health/ready` gives 200.

E5. `deploy/docker-compose.yml`, web service:
- delete `OCR_WEB_AUTO_AUTH` and `OCR_WEB_SUBJECT_ID` (`:44,:46`);
- `OCR_WEB_TENANT_ID: ${OCR_WEB_TENANT_ID:?set OCR_WEB_TENANT_ID}`;
- add `OCR_PUBLIC_BASE_URL: ${OCR_PUBLIC_BASE_URL:-https://ocr.innoveraappcenter.com}` (the existing vhost origin;
  not secret);
- add `OCR_SESSION_IDLE_MINUTES: ${OCR_SESSION_IDLE_MINUTES:-30}`,
  `OCR_SESSION_ABSOLUTE_HOURS: ${OCR_SESSION_ABSOLUTE_HOURS:-12}` and
  `OCR_EXPORT_MAX_ROWS: ${OCR_EXPORT_MAX_ROWS:-50000}`;
- `OCR_TRUSTED_PROXY_HOPS: ${OCR_TRUSTED_PROXY_HOPS:-0}`. The compose default stays 0, but the **production host sets
  1** after the §15.1 check (D5, C11);
- add a CPU bound to the web service: `deploy: { resources: { limits: { cpus: "1.5" } } }`. Today the web container has
  no limit (`docker-compose.yml:25-59`) on a host shared with unrelated apps, and a login flood runs 32 MiB scrypt jobs
  on every free core. The limit is this project's own service only; nothing else on the host is touched.

`AUTH_JWT_*` stays for web and worker (`:41-43,:77-79`); its **value** is rotated in Deploy A step 3 (D7).

E5b. **A runnable local target.** After E5 the repo's own stack cannot exercise login as it stands: compose hard-codes
`OCR_ENV: production` (`docker-compose.yml:34`), so `loadWebConfig` demands an https `OCR_PUBLIC_BASE_URL` and the
Origin guard accepts only that origin, which rejects a login over `http://127.0.0.1:53100` with `CSRF_REJECTED`; and
`assertTenant` (B5) fails web startup on any database whose `organizations` row is missing, which no migration creates
(`prisma/migrations/0001_foundation/migration.sql:5`). Add:
- `deploy/docker-compose.dev.yml`, an override that sets `OCR_ENV: development`, `OCR_PUBLIC_BASE_URL:
  http://127.0.0.1:53100` and a dev tenant id. `deploy/README.md` documents
  `docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.dev.yml up`.
- `deploy/sql/seed-dev-tenant.sql`: a single idempotent `INSERT INTO organizations … ON CONFLICT DO NOTHING`, run as
  `ocr_bootstrap` inside the postgres container. It is a **dev/fresh-database step only**; production already has its
  row and must not be touched.
- §12's manual checks and the `auth-smoke.sh`/`e2e-production.sh` dry runs run against this stack before production.

E6. Docs:
- **`deploy/README.md`:**
  - login, the CLI and the smoke script;
  - `AUTH_JWT_*` is now reserved: required by the startup policy but not used for browser auth. This replaces the
    contradictory rotation text at `:19`.
  - the new env keys (names only);
  - `:41` for the new e2e inputs;
  - `:15` for the 0020 worker gate.
- **`production-preflight.sh`:**
  - add `OCR_WEB_TENANT_ID` and `OCR_PUBLIC_BASE_URL` to `required_values`;
  - warn when `OCR_REQUEST_TIMEOUT < 300`. `OCR_REQUEST_TIMEOUT` stays in `required_values` and `has_value` still
    requires it to be non-empty (`deploy/production-preflight.sh:10,12`), so the carry-over **sets the key to 300**
    rather than deleting it (G6);
  - warn when `OCR_WEB_AUTO_AUTH` is set.
- **`deploy/prometheus-production.yml`:** add `rule_files: ["/etc/prometheus/alerts.yml"]`, and mount
  `./prometheus-alerts.yml:/etc/prometheus/alerts.yml:ro` on the prometheus service in `docker-compose.yml`. Without
  both, the §13 alerts never load: the production config has no `rule_files` today and compose mounts only the one
  config file (`docker-compose.yml:97-98`), which is why `go-live-check.sh` reports "critical alerts loaded" as
  `NOT_RUN`. Deploy A gains an approved `$C up -d --no-deps prometheus` step; it touches only this project's own
  container.
  - Note: its `migrations:current` check applies pending migrations as the migrator (`:26`), so do not run it between
    checkout and the web start (§15).
- **`deploy/production.env.example`:** key names only, no values.
- **`../full-document-batch-spec.md:18,253,265,318`** and **`../full-document-batch-deploy.md:19`:** replace the
  web-token text.
- **`release2-deploy.md`:** new; the runbook from §15.

## 8. Workstream F: workbench (`apps/ocr-web/src/workbench.ts`)

F1. **Markup** (Thai, Vercel light: black pill primary action, pure gray ramp, 16px inputs):
- **`<dialog id="auth-dlg" class="modal auth">`** is opened with `showModal()`. Its `::backdrop` is the opaque canvas
  color, so it hides the page, and an open drawer, without closing either: the auth dialog is the top-most modal and
  everything under it is inert. Its `cancel` event (Escape) is prevented. `body[data-auth="out"]` also hides the
  header user menu.
- **The login card** is a centered 400px card: brand mark, `h1 เข้าสู่ระบบ`, then
  `<form id="login-form" method="post" action="/api/auth/login">`. `method=post` means a JavaScript failure can never
  put a password in a URL or in nginx logs; the server then answers 415.
- **Login fields:**
  - `#login-user`: `autocomplete="username" autocapitalize="none" spellcheck="false"`. On `input`, a non-ASCII
    character shows the hint `ชื่อผู้ใช้เป็นภาษาอังกฤษ — ตรวจสอบแป้นพิมพ์`. Usernames are ASCII by CHECK (§3 A1) and
    the login answer carries no format error, so a Thai keyboard layout would otherwise burn throttle attempts on a
    generic `INVALID_CREDENTIALS` with no clue why. The username format is public; this reveals no account;
  - `#login-pass`: `type="password" autocomplete="current-password"`, with a `แสดงรหัสผ่าน` toggle button that flips
    the field's `type` (no inline handler, so the CSP nonce rules are unchanged). A 12-character minimum that may mix
    Thai and spaces is otherwise typo-prone, and every typo costs a throttle attempt;
  - `#login-error` with `role="alert"`;
  - a full-width black pill `เข้าสู่ระบบ`;
  - the hint `ลืมรหัสผ่าน? ติดต่อผู้ดูแลระบบ`.
- **`body[data-auth="checking"]`** shows `กำลังตรวจสอบการเข้าสู่ระบบ…` until the session answer arrives.
- **Header user menu** next to `#conn` (`workbench.ts:221`):
  - `#me-name` with a role badge (`ผู้ดูแล` or `พนักงาน`);
  - `#users-open` `ผู้ใช้งาน` (admin only);
  - `#pw-open` `เปลี่ยนรหัสผ่าน`;
  - `#logout` `ออกจากระบบ`, a ghost pill.
  - **At ≤720px the four collapse into one pill** (`#me-open`, the display name) that opens a small
    `<dialog id="me-dlg" class="modal">` with the same actions. `.top` is a single non-wrapping 56px flex row
    (`workbench.ts:47`) whose `#conn` chip is `white-space:nowrap` (`:53`), and the ≤720px rules hide only the
    breadcrumbs (`:216`); a name, a badge and three more pills would push the header past 375px and give the whole page
    a horizontal scrollbar.
- **`<dialog id="pw-dlg" class="modal">`** contains `<form id="pw-form" method="post">` with current, new and confirm
  fields (`current-password`, `new-password`×2) and the policy hint
  `อย่างน้อย 12 ตัวอักษร ใช้ภาษาไทยหรือเว้นวรรคได้`. It cannot be dismissed while `mustChangePassword` is set, **but it
  always carries an `ออกจากระบบ` ghost button** and hides the current-password field when C5's 5-minute forced-change
  window applies. The dialog is modal, so the header logout behind it is inert; without its own button, someone who
  logged in with the wrong account or cannot choose a password now would have no way out but closing the tab, even
  though the server allows logout in this state (C2.6).
- **`<dialog id="users-dlg" class="modal">`:**
  - a users table with the columns ชื่อที่แสดง, ชื่อผู้ใช้, บทบาท, ส่งออกได้, สถานะ, เข้าใช้ล่าสุด and จัดการ;
  - an add-user `<form method="post">` with **no password input**;
  - row actions confirmed through the **new top-level `<dialog id="confirm-dlg" class="modal">`** (§8 F1a):
    รีเซ็ตรหัสผ่าน, ปลดล็อก, ปิด/เปิดใช้งาน, เปลี่ยนบทบาท, อนุญาตส่งออก. รีเซ็ตรหัสผ่าน and ปลดล็อก are **not rendered
    on your own row** (C6);
  - after a create or reset, the temporary password is shown once in `<code id="temp-pass">` with a `คัดลอก` button
    (`navigator.clipboard`), plus the note `ส่งให้ผู้ใช้โดยตรง ใช้ได้ครั้งเดียวภายใน 72 ชั่วโมง`. It is removed from
    the DOM when the dialog closes.
F1a. **A real confirmation dialog — do not reuse the drawer's `ask` overlay.** Today `<div id="ask">` lives *inside*
`<dialog id="drawer">`'s `.d-shell` (`workbench.ts:243`) and is `position:absolute;inset:0` within it
(`workbench.ts:209`); `ask()` only un-hides it, marks the drawer's parts inert and returns a promise resolved by
`answer()` (`workbench.ts:396-397`), whose only other exit is Escape **on the drawer** (`workbench.ts:496-497`).
Called from `users-dlg` or the header, it would focus an invisible button inside a closed dialog and return a promise
that never resolves, hanging every admin row action and logout; `state.askResolve` would stay set, so the next document
opened would show that stale question inside the drawer with the hard-coded labels `กลับไปแก้ไขต่อ / ทิ้งการแก้ไข`
and inert drawer parts. The dirty-draft logout case cannot even arise, because the drawer is modal and the header
logout is inert while a draft exists.

- Add `<dialog id="confirm-dlg" class="modal">`, opened with `showModal()`, with configurable title, text and yes/no
  labels, used by `users-dlg` row actions and by logout.
- The drawer's `ask` stays exactly as it is, for discarding a draft only.
- Logout confirms only when an upload is in flight or waiting (the draft case is unreachable, see above).

- **CSS:**
  - `.modal` and `::backdrop`;
  - 16px styles for `input[type=password|date|checkbox]`;
  - a scoped `.modal table` / `.x-scroll table` that overrides the global `table{min-width:1280px}` and the sticky
    first column (`workbench.ts:102-111`);
  - `body[data-auth]` visibility rules.
- Every new `$('id')` has matching markup (`workbench.test.ts:51-56`).

F2. **Script:**
- **State.** `state.token` and `tokenPromise` go. New: `state.user`, `state.csrf`, `state.authWait` (one shared
  promise).
- **`checkSession()`** calls `GET /api/auth/session`. On 200 it sets the user and the CSRF token; on 401 it returns null.
- **`requireLogin(reason)`:**
  - opens `auth-dlg` **over** the page and sets `data-auth="out"`.
  - **It first clears every rendered PHI surface**: the document rows, the drawer's rendered fields and head, the
    preview (`clearPreview()`, which also revokes the blob URL) and the batch strip. Only the in-memory `state.draft`
    object and `state.current.documentId` survive, so editing can resume. An opaque backdrop hides the page but leaves
    customer names, the open health form and the draft in the DOM, readable with devtools by anyone at a shared
    front-desk PC (§16.2) — which is the whole point of the 30-minute idle timeout. After a **same-user** login the
    rows and the drawer are re-rendered from a fresh load and the draft is reapplied.
  - it resolves after a successful `POST /api/auth/login`, sent as JSON with `preventDefault` and clearing the
    password field on send.
  - **If a *different* user logs in, `requireLogin` never resolves.** It rejects every waiter on the shared
    `state.authWait` with the coded error `USER_CHANGED`, which `api()` and `send()` treat as final (no retry, no
    resend). It then aborts in-flight XHRs, marks waiting uploads `ยกเลิก (เปลี่ยนผู้ใช้)`, clears `state.dirty` and
    sets `state.leaving = true` (which turns the `beforeunload` guard off), and only then calls
    `location.replace(location.pathname + location.search)`.
    Resolving and relying on the navigation is not enough: navigation is asynchronous, so the retried review save and
    the resent upload would go out first, carrying the **new** user's cookie and CSRF token; and the existing
    `beforeunload` handler fires on exactly this state — a dirty draft, an active upload or a waiting upload
    (`workbench.ts:501`) — so the new user can click "Stay" and keep working inside user A's draft while `pump()`
    starts A's queued uploads as B (`workbench.ts:370-371`). That would break the release's core promise that reviews
    and confirmations are attributed to the logged-in user.
- **`api()`** (`workbench.ts:284-287`):
  - no `Authorization` header;
  - adds `X-CSRF-Token` for non-GET requests and `X-OCR-Background: 1` for calls made by `tick()`;
  - on 401 from any non-auth route, `await requireLogin()` and retry once;
  - **on 403 `CSRF_REJECTED`, refresh the token once**: call `GET /api/auth/session`; if it returns the same
    `user.id`, replace `state.csrf` and retry the call once; if it returns 401 or a different user, go through
    `requireLogin()` / the different-user path. Every tab shares one `__Host-ocr_session` cookie, and both a second
    login (C3.9 revokes the cookie's session and issues a new one) and a password change (C5 rotates it) leave the
    other tabs holding a stale `csrfToken` on a valid cookie: their GETs keep succeeding, so they never see a 401,
    while every save, upload and retry fails 403 for good. Two tabs after an idle expiry is the ordinary case, and the
    only escape today would be a reload that loses the draft. The `X-OCR-Background` poll uses the same path, so an
    idle tab picks the new token up by itself;
  - on 403 `PASSWORD_CHANGE_REQUIRED`, open `pw-dlg`;
  - it never re-mints a token.
- **`send()`** (`workbench.ts:362-366`):
  - no `Authorization` header; adds `X-CSRF-Token`;
  - on 401, the upload is marked `รอเข้าสู่ระบบ` (not failed), then `await requireLogin()` and resend once. The
    existing `Idempotency-Key` makes the resend safe. A `USER_CHANGED` rejection cancels it instead;
  - on 403 `CSRF_REJECTED`, the same single refresh-and-resend as `api()`.
- **Polling.** `tick()` returns immediately while `state.authWait` is pending, **and `schedule()` re-arms once the wait
  settles** (`state.authWait.finally(schedule)` on the success path, nothing on `USER_CHANGED`). `tick()`'s `finally →
  schedule()` is the only thing that re-arms the 3/15 s chain (`workbench.ts:385-386`), so an already-armed timer that
  fires during a login would otherwise end it: after a 401 on a user action such as Save, the list, the batch strip and
  the drawer's pending refresh would never update again until a manual รีเฟรช, a filter change or a tab switch, with
  staff watching a frozen list wait for OCR results. The behaviour harness cannot catch this on its own
  (`workbench.behaviour.test.ts:103` stubs `setTimeout: () => 0`), so its test uses a controllable fake timer.
- **`init()`** (`workbench.ts:503-505`):
  1. `wire()`
  2. `checkSession()`, or else `requireLogin()`
  3. if `mustChangePassword`, the forced password change
  4. `applyUser()`: name, role, admin/export controls
  5. the existing loads, the `?document=` deep link and `schedule()`
  
  The script must still end with `init();\n})();\n` (`workbench.behaviour.test.ts:77,106`).
- **Logout** asks through `confirm-dlg` (F1a) when an upload is in flight or waiting. It then clears the timers, sets
  `state.leaving = true` so the `beforeunload` guard does not prompt, sends `POST /api/auth/logout` and runs
  `location.replace('/')`, which drops every timer, blob URL and piece of state.
- **ERRORS** (`workbench.ts:263`) gains Thai text for every new code and drops `WEB_AUTO_AUTH_UNAVAILABLE`. The
  `apiError` 401 text (`workbench.ts:280`) becomes `กรุณาเข้าสู่ระบบอีกครั้ง`.
- **Input guards.** The drop zone and the `/` shortcut (`workbench.ts:484,499`) are also ignored while `auth-dlg` or any
  other `.modal` is open.
- **Drawer.** `renderHead` (`workbench.ts:416`) shows `ยืนยันโดย <reviewedByName> · <เวลา>`, falling back to the legacy
  label when `reviewedBy` is set but no name was found.
- Everything is rendered with `textContent`. There are still no `innerHTML`-family sinks, no storage APIs and no
  `document.cookie`.

## 9. Workstream G: carry-overs

G1. **Migration `0020_batch_round_clock`** (Deploy B):
```sql
-- Batch clock by processing round (Release 1 carry-over). Additive; defines no function.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS processing_started_at timestamptz;  -- worker: first claim since the row was (re)queued
ALTER TABLE ocr_batches ADD COLUMN IF NOT EXISTS round_opened_at timestamptz;      -- web: a retry into an idle batch opens a new round
GRANT UPDATE (round_opened_at) ON ocr_batches TO ocr_app;
```
The worker already has table-level UPDATE on documents (`0009_role_grants/migration.sql:4`), and so does ocr_app
(`0009:3`). No other grant is needed.

G2. **Worker.**
- `markProcessing` (`index.ts:487-491`, called at `services/ocr-worker/src/index.ts:206`) also sets
  `processing_started_at = COALESCE(processing_started_at, now())`.
- Queue retries (`markRetrying`, `index.ts:514-520`) keep the first claim.
- `REQUIRED_SCHEMA_VERSION` becomes `0020_batch_round_clock` (`services/ocr-worker/src/index.ts:390`; its pin is at
  `index.test.ts:211`).

G3. **Web `retryDocument`** (`index.ts:814-831`), in the same transaction and before the document is reset:
```sql
UPDATE ocr_batches b SET round_opened_at = now()
WHERE b.organization_id = $1::uuid AND b.id = (SELECT batch_id FROM documents WHERE id = $2::uuid AND organization_id = $1::uuid)
  AND NOT EXISTS (SELECT 1 FROM documents x WHERE x.organization_id = b.organization_id AND x.batch_id = b.id AND x.id <> $2::uuid
                  AND x.deleted_at IS NULL AND x.status IN ('VALIDATING','SCANNING','CLEAN','PROCESSING'))
```
The document reset (`index.ts:826`) also sets `processing_started_at = NULL`. A retry into an idle batch opens a
round; a retry while the batch is busy joins the running round. `now()` is the transaction start, which is always
earlier than the next claim.

G4. **Summary.** `BATCH_SELECT` (`index.ts:200-218`) adds:
```sql
b.round_opened_at,
min(d.processing_started_at) FILTER (WHERE b.round_opened_at IS NOT NULL AND d.processing_started_at >= b.round_opened_at) AS round_started_at,
count(d.id) FILTER (WHERE b.round_opened_at IS NOT NULL AND d.status IN ('SUCCEEDED','NEEDS_REVIEW','FAILED','QUARANTINED')
  AND COALESCE(d.processed_at, d.updated_at) >= b.round_opened_at)::int AS round_completed
```
`toBatchSummary` (`index.ts:242-266`):
- `start = round_opened_at ? round_started_at : createdAt`. It is null while the reopened round waits for its first
  claim; `durationMs` is then null.
- The throughput counter is `round_opened_at ? round_completed : completed`.
- New fields: `roundOpenedAt`, `roundStartedAt`, `roundCompleted`.
- `BatchSummary` and its docs (`index.ts:91-100`) are updated to match.

G5. **Workbench** (`workbench.ts:345-349`):
- **While a reopened round is waiting for its first claim** (`roundOpenedAt` set, `roundStartedAt` null), `elapsed`
  and `rate` are both `null` and the strip shows `—` for เวลาที่ใช้ and หน้า/นาที. This is the whole point of the
  carry-over: today's fallback is
  `elapsed = typeof b.durationMs==='number' ? b.durationMs : (inFlight>0||pending) ? Date.now()-created : null`
  with `created = Date.parse(b.createdAt)` (`workbench.ts:345`), so a null `durationMs` plus a queued row would fall
  back to `createdAt` again and redisplay hours of elapsed time and a rate near 0 — the exact Release 1 symptom. The
  wait can be long: a retry carries the default priority 100 and may sit behind another batch's 95 pages, about 40
  minutes (`workbench.ts:257`);
- otherwise the fallback start is `roundStartedAt || createdAt`;
- **the fallback rate uses `roundCompleted` while a round is open**, not the all-time `completed`, to match G4's
  server-side throughput counter;
- the meta line shows `รอบอ่านใหม่ เริ่ม <เวลา>`, or `รอเริ่มอ่านรอบใหม่` before the first claim;
- `เอกสาร/นาที` becomes `หน้า/นาที`.

G6. **`OCR_REQUEST_TIMEOUT`.** In Deploy B, **set** `OCR_REQUEST_TIMEOUT=300` in the host env file that §15.1 found it
in — do not delete the line. Deleting it would make `production-preflight.sh` fail: the key is in `required_values`
and `has_value` requires it to be non-empty (`deploy/production-preflight.sh:10,12`), and E6's "warn when < 300" check
assumes it exists. 300 is also the compose default (`docker-compose.yml:39,69`), so the two agree. Web and worker are
recreated in B anyway, and Deploy B step 4 keeps the `printenv OCR_REQUEST_TIMEOUT` = 300 check.

## 10. Workstream H: export (implemented after login is merged; ships in Deploy B)

H1. **Routes.** All three are GET, require a session plus the `export` permission, and go through the
`Sec-Fetch-Site` guard. They are added to `routeLabel`.
- `GET /api/exports/preview?…` returns `{columns:[{key,label}], total, maxRows, rows}`. `rows` holds the first 20
  rows as arrays of display strings, **exactly the values the file would contain** (so the หน้า cell is `3`, next to a
  จำนวนหน้า cell of `95`; see H6). The preview uses no formula guard, because the UI renders with `textContent`.
  **It is audited** (`export.previewed`) and rate-limited to 60 calls per user per 15 minutes: it returns the full
  export column set for any filter, so an unaudited preview is a paging API over the same data as the download.
- `GET /api/exports/documents.csv?…` and `GET /api/exports/documents.jsonl?…` stream the file.

H2. **Filters** (`parseExportQuery`, strict like `parseDocumentListQuery`, `server.ts:187-203`; any bad value gives
400 `INVALID_EXPORT_FILTER`):
- `batchId` (UUID) and `parentId` (UUID, the PDF chip);
- `status`: a comma-separated list of `DOCUMENT_STATUS_CATEGORIES`, OR-ed together;
- `confirmedOnly=1`, the same as `CATEGORY_SQL.confirmed` / `REVIEWED_AT_SQL` (`index.ts:161-172`);
- `q`: ≤ 100 characters, with the same rules as the list;
- `from` and `to` as `YYYY-MM-DD` Bangkok dates, applied to the column named by `dateField`:
  `<col> >= ($from::date::timestamp AT TIME ZONE 'Asia/Bangkok') AND <col> < (($to::date + 1)::timestamp AT TIME ZONE 'Asia/Bangkok')`.
  `from` must not be after `to`.
- `dateField=created_at|reviewed_at` (default `created_at`). `reviewed_at` uses `REVIEWED_AT_SQL` (`index.ts:161-172`)
  on the same Bangkok bounds and implies the row is confirmed. The design lists it
  (`design-2026-09-22.md:337`) and it is the natural filter for a daily hand-off — "confirmed today" misses nothing,
  while filtering by upload date misses older uploads confirmed today. It is one SQL branch and one `<select>`, so it
  ships rather than being dropped silently (§16.17).
- `columns=compact|detailed` (default compact) and `headers=th|en` (default th).

`VISIBLE_SQL` always applies (`index.ts:186`), so SPLIT parents and deleted rows are excluded. The WHERE builder of
`listDocuments` (`index.ts:779-791`) is extracted into `documentFilterSql(query, params)`, and the list and the export
share it.

H3. **Columns** (`packages/ocr-persistence/src/export.ts`, pure: `EXPORT_COLUMNS {key, th, kind: text|number|bool|datetime}`,
`flattenExportRow(row, set, {publicBaseUrl})`, `flaggedPaths(view)`; Thai labels in `labels.ts`, and a test asserts they
equal the inline-script copies at `workbench.ts:254-260`).

**The required four come first, in this order:**

| # | th | en | Source |
|---|---|---|---|
| 1 | ชื่อไฟล์ต้นฉบับ | `original_file_name` | `COALESCE(p.filename, d.filename)` = `parentFilename ?? filename` (`index.ts:188-189`) |
| 2 | หน้า | `page` | `d.page_number`; empty for single images and top-level PDFs |
| 3 | จำนวนหน้า | `page_count` | `d.page_count` |
| 4 | อัปโหลดเมื่อ | `uploaded_at` | `to_char(d.created_at AT TIME ZONE 'Asia/Bangkok','YYYY-MM-DD HH24:MI:SS')`. Pages copy the parent's `created_at` (`index.ts:583-591`) |

**Then:**
- **Batch and review:**
  - `batch_label` (ชุดอัปโหลด), `status` (สถานะ, Thai category), `reviewed` (ยืนยันแล้ว, TRUE/FALSE);
  - `reviewed_at` (ยืนยันเมื่อ, `REVIEWED_AT_SQL`);
  - `reviewed_by` (ยืนยันโดย): the users join on `d.reviewed_by`, or else on the latest `ocr_corrections.verified_by`
    for legacy field confirmations. If the id matches no user, the legacy label is shown. The cell is empty when the
    row is not confirmed.
- **Form fields:** `form_number`, `form_date`, `form_time`, `branch`, `customer_name`, `gender`, `nationality`,
  `hotel_name`, `referral_sources`, `health_conditions`, `pressure`, `massage_oil_scrub`, `preferred_areas`,
  `avoid_areas`.
- **Treatments and staff:**
  - `treatments`: every item joined with "; ", e.g. "นวดไทย 90 นาที";
  - `treatment_1_name/_duration/_minutes` … `treatment_4_*`, and `treatments_more` for item 5 onward;
  - `total_minutes`, `therapist`, `room`.
- **Review metadata:** `needs_review`, `review_fields` (flagged paths joined with "; "), `min_confidence` (0–1),
  `delivery_status` (Thai), `error_message`, `template` (`raw_response #>> '{layout,detection,verdict}'`, never the
  whole jsonb), `processed_at`.
- **Links and ids:** `review_url` (`OCR_PUBLIC_BASE_URL + '/review/' + id`, never built from Host; the route is at
  `server.ts:418-424`), `document_id`, `batch_id`, `parent_document_id`, `status_code`.

**`columns=detailed`** appends `_raw`, `_confidence`, `_needs_review` and `_source` for each scalar field.

**Cell rules:**
- A compact cell shows `value`. When the value is null and `raw` exists, it shows `raw + " (?)"`. Items still flagged
  get `" (?)"`.
- Text over 32,000 characters is cut with `…[ตัดทอน]`.
- Numbers (`page`, `page_count`, `*_minutes`, `total_minutes`, `min_confidence`) are emitted bare. `room` stays text.
  Excel may still strip leading zeros when it opens a CSV; this is documented, and `="…"` is not used.

H4. **Store: `openExport(tenantId, filters, {maxRows})`** (`packages/ocr-persistence/src/index.ts`)
1. It owns one pooled client and runs
   `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; set_config('app.current_org', …, true); set_config('statement_timeout','60s',true); set_config('idle_in_transaction_session_timeout','120s',true)`.
   **It attaches `client.on('error', …)` for as long as the client is checked out, and removes it in `close()`**; and
   `createDatabasePool` (`packages/db-runtime/src/index.ts:54-57`) gains a `pool.on('error')`. If the stream stalls
   over 120 s between `FETCH`es while awaiting `'drain'`, PostgreSQL terminates that backend, node-postgres emits
   `'error'` on the client, and pg-pool has already removed its own idle listener at checkout — with no listener the
   unhandled event crashes the web process, cutting every in-flight upload and resetting the in-memory login throttles.
   A unit test emits `'error'` on a fake export client and asserts the process survives and the export rejects.
2. It runs `count(*)`. Above `maxRows` it throws `EXPORT_TOO_LARGE`, before anything is yielded.
3. It opens `DECLARE export_cur NO SCROLL CURSOR FOR <select> ORDER BY d.created_at, COALESCE(d.parent_document_id, d.id), d.page_number NULLS FIRST, d.id`,
   oldest first and all ascending, so the pages of one PDF stay together.
4. It yields rows in batches of `FETCH 500`.
5. `close()` runs `CLOSE`, `COMMIT` and releases the client in `finally`. It also runs from `generator.return()` when
   the HTTP client disconnects.

No new grant is needed: ocr_app has SELECT on documents, ocr_corrections, ocr_confirm_outbox and ocr_batches (0009:3,
0017:35), and on users (0019). `previewExport` runs count plus `LIMIT 20` in the same kind of transaction.

H5. **Web** (`apps/ocr-web/src/export.ts`):
- **Encoding:**
  - `csvCell` and `csvRow`: RFC 4180 quoting, CRLF, and the UTF-8 BOM exactly once.
  - The **formula guard**: a text cell starting with `= + - @ \t \r` gets a leading `'`. It applies to **every text
    cell, including `original_file_name`** (filenames may start with those, `packages/ingest/src/index.ts:15-22`) and
    the reviewer names.
- **Order of operations:**
  1. await the first generator step (the count) **before** `writeHead`, so `EXPORT_TOO_LARGE` stays a clean 400;
  2. **insert and commit the `export.started` audit row** (actor, session, format, columns, filters with `has_q`, the
     total count) — still before `writeHead`;
  3. write the BOM and header row at once, so nginx-proxy's read timeout is never reached;
  4. stream with `if (!res.write(buf)) await once(res, 'drain')`;
  5. append `export.completed` or `export.failed` in its own transaction afterwards.
  Only `export.started` is guaranteed: a crash, a redeploy, an OOM kill or a pool with no free client while the export
  pins one would otherwise let the data leave with no audit row at all, which contradicts §13's claim that the table
  answers who exported. Tests: a thrown stream and a killed generator each still leave an `export.started` row.
- **Response headers:**
  - `Content-Type: text/csv; charset=utf-8` or `application/x-ndjson; charset=utf-8`;
  - `Content-Disposition: attachment; filename="ocr-export-YYYYMMDD-HHmm.csv"` (Bangkok time, ASCII);
  - `Cache-Control: no-store`, `nosniff`, `X-Export-Rows: <total>`.
- **JSONL** (fully specified, because it is a required format and its rules are the opposite of the CSV ones):
  - one JSON object per line, `\n`-separated, snake_case keys, **no BOM**;
  - the required four come first and in the same order as the CSV: `original_file_name`, `page` (number or `null`),
    `page_count` (number or `null`), `uploaded_at`;
  - **`uploaded_at` is ISO 8601 with the Bangkok offset** (`2026-09-22T14:05:00+07:00`), because the requirement
    defines `อัปโหลดเมื่อ` / `uploaded_at` as upload time in Asia/Bangkok
    (`release2-requirements.md:13-19`); the UTC instant is available as `uploaded_at_utc`. Every other timestamp
    follows the same pair;
  - **no formula guard and no truncation**: JSONL is the lossless format, so a value starting with `=` is emitted
    unchanged and text is never cut with `…[ตัดทอน]`. Those two rules belong to the CSV writer only;
  - then the same column set as the CSV, plus the full canonical `structured_result`.
  - A client abort leaves a rejected `blob()` and no saved file, as for CSV.
- **`ExportGate`:** at most 2 exports per process and 1 per user (429 `EXPORT_BUSY`), with a wall-clock cap of 10 min.
- A stream error after the headers destroys the socket (`server.ts:432`). The browser's `blob()` then rejects, so a
  cut-off file is never saved.
- Audit and logs: `export.completed` or `export.failed` with `{format, columns, headers, filters (has_q, never the q
  text), rows, complete, duration_ms}`.

H6. **UI:**
- A secondary pill `ส่งออก` in the toolbar (`workbench.ts:230`), rendered only for admin or `canExport`, opens
  `<dialog id="export-dlg" class="modal">`.
- The dialog is pre-filled from `state.status`, `state.batchFilter`, `state.q` and `state.parentFilter`. Its fields:
  ชุดอัปโหลด, สถานะ (checkboxes), ช่วงวันที่ตาม (วันที่อัปโหลด / วันที่ยืนยัน — `dateField`, H2),
  ตั้งแต่วันที่ / ถึงวันที่ (`type=date`), เฉพาะที่ยืนยันแล้ว, รูปแบบ (Excel CSV / JSONL) and คอลัมน์ (สรุป / ละเอียด).
- **`q` and `parentFilter` are shown as removable chips** (`ค้นหา: … ✕`, `เฉพาะหน้าของ <ไฟล์> ✕`). They are inherited
  from the page's current filters but have no field of their own, so a search typed earlier — a customer name, say —
  or the "pages of one PDF" chip would otherwise narrow the file silently and leave staff unable to see why it has
  fewer rows than they expect.
- **Preview.** It reloads 300 ms after a filter change and aborts the previous request. It shows
  `พบ N แถว · แสดง 20 แถวแรก`. The table sits in `.x-scroll` and renders **exactly the file's columns and values**
  (design §3.4: "the preview of the first 20 rows in the real export columns"). The first column is
  **ชื่อไฟล์ต้นฉบับ**; **หน้า** shows the bare page number (`3`), empty for single images, with `จำนวนหน้า` (`95`)
  beside it and `หน้า 3/95` as the cell's `title`; **อัปโหลดเมื่อ** follows. `pageLabel` (`workbench.ts:300`) is **not**
  reused: it takes a document object, not a row of display strings, and returns the prefixed `หน้า 3/95`, which would
  make the preview's หน้า column differ from the downloaded file's while จำนวนหน้า repeated the same 95.
- **Download.** The black pill `ดาวน์โหลด`:
  - is disabled at 0 rows or above `maxRows` (`เกิน 50,000 แถว กรุณาเลือกช่วงวันที่ให้แคบลง`);
  - fetches through `api()` (cookie), turns the response into a Blob, clicks an `a[download]` and revokes the URL;
  - shows `กำลังเตรียมไฟล์…` while it works, and a Thai error if the fetch rejects.
- The CSP needs no change (`server.ts:83-85`).

## 11. File touchpoints

**New files**
- Migrations and static tests:
  - `prisma/migrations/0019_user_auth/migration.sql`, `prisma/migrations/0020_batch_round_clock/migration.sql`
  - `test/user-auth-migration.test.ts`, `test/batch-round-migration.test.ts`, `test/migration-checksums.test.ts`
- `packages/auth`: `password.ts`, `session.ts`, `common-passwords.ts`, and their tests.
- `packages/ocr-persistence`: `tenant.ts`, `audit.ts`, `users.ts`, `export.ts`, `labels.ts`, and their unit tests.
- `apps/ocr-web`:
  - `auth.ts` (cookie, CSRF, Origin and Sec-Fetch guards, `clientIp`, `LoginThrottle`, `sessionAuthenticator`);
  - `auth-routes.ts` (`/api/auth/*`, `/api/users*`);
  - `export.ts`;
  - `cli/users.ts`, `cli/tty.ts`;
  - tests: `auth.test.ts`, `export.test.ts`, `cli/users.test.ts`.
- Deploy and docs: `deploy/ocr-users.sh`, `deploy/auth-smoke.sh`, `deploy/sql/verify-release2-grants.sql` (A2),
  `deploy/docker-compose.dev.yml` and `deploy/sql/seed-dev-tenant.sql` (E5b),
  `docs/operations/real-data/release2-deploy.md`.

**Changed files**
- `apps/ocr-web/src/server.ts`:
  - delete the token route; async `authenticate` and its call sites;
  - the check order in C2, `errorStatus`, `routeLabel`, `respond` headers, `/metrics`;
  - log fields, audit parameters, export routes, production wiring.
- `apps/ocr-web/src/runtime.ts`: the actor argument.
- `apps/ocr-web/src/workbench.ts`, plus `workbench.test.ts`, `workbench.behaviour.test.ts`, `server.test.ts` and
  `runtime.test.ts`.
- `packages/ocr-persistence/src/index.ts`:
  - store changes: `tenantTransaction` delegates to `withTenant`; the audit and actor parameters; the `saveCorrection`
    default is removed;
  - `REVIEW_SELECT` name join, `BATCH_SELECT` round fields and `toBatchSummary`;
  - `markProcessing`, `retryDocument`, `documentFilterSql`, `openExport` and `previewExport`;
  - `index.test.ts` and `batch.db.test.ts`.
- `packages/auth/src/index.ts`: export `AuthContext`.
- `packages/config/src/index.ts`: `loadWebConfig`, plus a new `index.test.ts`.
- `packages/observability/src/index.ts`: the key filter.
- `services/ocr-worker/src/index.ts:390` and `index.test.ts:211` (Deploy B).
- `deploy/docker-compose.yml` (env keys, the web `cpus` limit, the prometheus rules mount), `verify-db-roles.sh`,
  `e2e-production.sh`, `production-preflight.sh`, `production.env.example` (names only), `prometheus-alerts.yml`,
  `prometheus-production.yml` (`rule_files`) and `README.md`.
- `packages/db-runtime/src/index.ts`: `pool.on('error')` in `createDatabasePool` (D10).
- `docs/operations/full-document-batch-spec.md`, `docs/operations/full-document-batch-deploy.md` and
  `docs/operations/real-data/design-2026-09-22.md` (renumbering), plus this plan's integration record.

## 12. Tests

Everything runs under Node 24.21 (`.nvmrc`; the dev shell defaults to 22). The gate is `pnpm typecheck`, `pnpm lint`
and `pnpm test`, plus the DB suite.

**Unit tests (packages)**
- `packages/auth/src/password.test.ts`:
  - hashing: the format round-trip; a wrong password; a malformed or out-of-bounds hash returns false in under 5 ms;
    `needsRehash`; a different salt every time; the NFKC equivalence ำ ≡ ํ+า;
  - policy: the length and byte limits, the username, the denylist and repeated characters;
  - the temporary-password alphabet and length, and the HashGate limit giving `LOGIN_BUSY`;
  - tests may pass small N for speed.
- `packages/auth/src/session.test.ts`:
  - token length and hash;
  - the CSRF token is deterministic per session and differs between sessions; `verifyCsrf` rejects wrong or missing
    values;
  - the cookie parser: duplicates, malformed and oversize values;
  - the exact `Set-Cookie` strings for production and dev.
- `packages/config/src/index.test.ts`: `loadWebConfig` rules. A production config without a tenant or base URL throws;
  a non-https base URL in production throws. `loadConfig` is unchanged.

**Server tests: `apps/ocr-web/src/auth.test.ts`** (new; a real session path with an in-memory `FakeUserStore`, no
`options.authenticate`)
- **The old token route:** `GET` and `POST /api/web-token` give 404; `Authorization: Bearer <valid HS256 JWT>` alone
  gives 401; a static check that server.ts contains no `createHmac(` or `mintWebJwt`.
- **Login:**
  - success gives a cookie with `__Host-`, HttpOnly, Secure, SameSite=Strict, Path=/ and no Max-Age (production env),
    plus the CSRF token; that cookie then works on `GET /api/documents`.
  - unknown user, wrong password and disabled user give byte-identical 401 bodies, and the dummy verify runs.
  - `PASSWORD_EXPIRED` appears only after a correct password.
- **Throttling and non-enumeration:**
  - after 10 consecutive failures the account is locked, and **even the correct password then gets 401
    `INVALID_CREDENTIALS` with no `Retry-After`**, byte-identical to a wrong password, until an admin unlocks it; the
    lock is visible only through `GET /api/users` as `status:'locked'`;
  - **the enumeration regression test**: 9 failures on a known name, then the in-memory window is drained (fake
    clock), then 1 more failure (the DB lock trips), then one attempt each on the known and on an unknown name —
    identical status, identical body and identical headers, and the elapsed times fall in the same band;
  - 10 attempts within the window on **any** name, known or not, give 429 `LOGIN_THROTTLED` with `Retry-After`;
  - a disabled account and a locked account answer like an unknown one;
  - a temporary password works once: the second login with it gives 401 `PASSWORD_EXPIRED`;
  - the unknown-name budget: past its limit the answer is 401 with no hashing (a spy on `verifyPassword`);
  - the per-IP limit applies with hops=1, counts `LOGIN_BUSY` and pre-check rejections, and a forged left-hand
    `X-Forwarded-For` is ignored; with hops=0 there is no per-IP limit;
  - `LOGIN_BUSY` when `loginGate` is full — **and an admin `reset-password` still succeeds in that state**, because it
    uses `adminGate`;
  - `verifyPassword(DUMMY_HASH, …)` and `verifyPassword(<fresh hash>, …)` use the same N, r and p.
- **CSRF:**
  - a cross-site `Origin`, a same-site sibling `Origin` (`https://ai.innoveraappcenter.com`) or `Sec-Fetch-Site:
    same-site` gives 403 on login, uploads, batches, review, confirm, retry and users;
  - a missing or wrong `X-CSRF-Token` gives 403 on each mutating route;
  - `text/plain` JSON gives 415;
  - GET works without the token.
- **Sessions:**
  - expired, idle, revoked and disabled sessions all give 401;
  - an `X-OCR-Background` request does not extend the idle deadline, while a user request does (at most one touch per
    minute);
  - logout revokes and clears the cookie, and the old cookie then gets 401;
  - a password change rotates the session and revokes the others;
  - `mustChangePassword` gives 403 except on the 3 allowed routes.
- **Permissions:**
  - staff get 403 on `/api/users` and `/api/exports/*`; `canExport` staff get 200 on the export routes;
  - `LAST_ADMIN` and `CANNOT_CHANGE_SELF`, including **`reset-password` and `unlock` on your own id** (409);
  - a forced-change session may `POST /api/auth/password` without `currentPassword` within 5 minutes of session
    creation, and must supply it after that and for every voluntary change;
  - `access.denied` audit rows stop at 5 per session per minute, and the suppression counter moves instead;
  - `USERNAME_TAKEN` without any pg detail in the body;
  - unknown keys on `POST /api/users/:id` give 400 `USER_INVALID`;
  - the temporary password is present once in the create and reset responses and absent from stdout.
- **Attribution and audit integrity:** upload, batch, review, confirm and retry pass `ctx.userId` and the audit
  context. A body `reviewedBy` is still ignored (keep `server.test.ts:306-308`). A request carrying
  `X-Request-Id: <forged>` gets that value back in the response header, but the audit row holds the server's
  `trace_id`, not the forged one.
- **Metrics and routes:** `/metrics` with `x-forwarded-for` gives 404 and without it 200; `routeLabel` covers the new
  routes; the `errorStatus` table.
- **The whole file:** captured stdout never contains the test password, a temporary password, a cookie value, a CSRF
  token or a username.

**Existing and CLI tests**
- `apps/ocr-web/src/server.test.ts`: the harness authenticates by a test cookie instead of `Bearer test-token`
  (`:36-39,141-148`), and a helper adds `Origin`, `X-CSRF-Token` and the content type. The existing cases keep their
  intent: tenant from the credential only (`:217-228`), 401 on every route without a session (`:200-215`), the
  workbench CSP (`:164-188`).
- `apps/ocr-web/src/cli/users.test.ts` (fake TTY streams and a fake store):
  - it refuses a non-TTY with no DB call;
  - no echo: every write is captured, and the password is never among them;
  - confirmation mismatch; policy errors; `ADMIN_EXISTS`;
  - the insert happens under the tenant, and the output is only the success line.

**Workbench tests**
- `workbench.test.ts`:
  - `:36` is replaced by three rules: (a) no `<input>` has `token` in any attribute; (b) every `<input>` with
    `password` in its attributes is `type="password"` with `autocomplete` set to `current-password` or `new-password`;
    (c) that input sits inside a `<form … method="post">`.
  - the login form has `action="/api/auth/login"`.
  - the script contains no `Authorization`, `Bearer`, `/api/web-token`, `HS256`, `createHmac`, `AUTH_JWT`,
    `jwtSecrets` or `subtle.sign`, and still no storage APIs or `document.cookie`.
  - the `:59` needles gain `'/api/auth/session'`, `'/api/auth/login'`, `'/api/auth/logout'`, `'/api/auth/password'`,
    `'/api/users'`, `'X-CSRF-Token'` and `'X-OCR-Background'`, and after H `'/api/exports/preview'` and
    `'/api/exports/documents.csv'`.
  - the 11-column contract is unchanged (`:44-49`).
- `workbench.behaviour.test.ts`:
  - **Harness changes first** — several planned cases cannot run on today's harness:
    - `EXPOSE` (`:72`) gains `init`, `checkSession`, `requireLogin`, `api`, `logout`, `renderHead` and the users/export
      entry points. It currently lists neither `init` nor anything auth-related, and `load()` strips the trailing
      `init();` (`:77,:106`), so no test can drive startup.
    - the fake `location` (`:100`) gains `replace`; the fakes gain `showModal`, `close` and `open`, `value` and
      `checked`, form submit, and `headers.get` in `json()`;
    - `setTimeout`/`clearTimeout` (`:103`) become a controllable fake clock that records armed timers, for the polling
      test.
  - the `token()` helper (`:110`) is replaced by a session fake. The sequences at `:131` and `:149` **assert the
    absence of any `/api/web-token` fetch** — not a leading `GET /api/auth/session`: under F2 `api()` fetches nothing
    before a call, and only `init()` calls `checkSession()`, which those cases do not run.
  - cases:
    - a 401 on the session shows login and fetches no data;
    - login then loads;
    - a 401 mid-session opens the overlay, the pending list load resumes after login, and the call is retried once;
    - **save → 401 → same-user login → exactly one retried `POST …/ocr/review`, carrying the new `X-CSRF-Token`, with
      `state.draft` unchanged** (this is "session expiry mid-review without losing a draft", the headline flow);
    - **a stale CSRF token**: a non-GET gets 403 `CSRF_REJECTED`, `GET /api/auth/session` returns the same user with a
      new token, and the call is retried once and succeeds; a 401 from that refresh goes to `requireLogin` instead;
    - a 401 upload waits and then resends once with the same `Idempotency-Key`;
    - **a different user**: with a dirty draft and one upload pending on 401, user B logs in — **no request is sent
      after B's login** (nothing carries B's CSRF token), the XHR is aborted, the waiting upload is cancelled, the
      `beforeunload` guard is disabled and `location.replace` is called;
    - **polling re-arms**: a user-action 401, a tick during the wait, then a same-user login — a timer is armed again;
    - **the expired overlay holds no PHI**: with rows rendered and the drawer open, a 401 opens `auth-dlg` and no
      customer name remains anywhere in the DOM, while `state.draft` survives and is restored after a same-user login;
    - logout with an upload in flight asks through `confirm-dlg`, then sends `POST /api/auth/logout` and calls
      `location.replace('/')`;
    - **an admin row action** (disable) asks through `confirm-dlg` and then sends `POST /api/users/:id`
      `{disabled:true}`; the promise resolves (the old drawer-scoped `ask` would hang);
    - staff see no `#users-open` or `ส่งออก`;
    - `mustChangePassword` opens a `pw-dlg` that cannot be dismissed **but does expose `ออกจากระบบ`**;
    - the temporary password is removed on close;
    - **the drawer head** renders `ยืนยันโดย <reviewedByName>`, and falls back to `บัญชีรวม (ก่อนมีระบบล็อกอิน)` when
      `reviewedBy` is set with no name;
    - the preview renders the original file name first, `3` in หน้า and `95` in จำนวนหน้า through `textContent`, with
      `หน้า 3/95` as the cell title;
    - the strip shows `รอเริ่มอ่านรอบใหม่`, `หน้า/นาที`, and **`—` for both เวลาที่ใช้ and หน้า/นาที** when
      `{roundOpenedAt set, roundStartedAt: null, durationMs: null, queued: 1, createdAt hours ago}`; a second case with
      `roundStartedAt` set and `durationMs` null computes from `roundStartedAt` and `roundCompleted`;
    - a non-ASCII `#login-user` shows the keyboard hint, and `แสดงรหัสผ่าน` flips the field type;
    - at ≤720px the header renders the single `#me-open` pill and no separate action pills.

**Persistence and export tests**
- `packages/ocr-persistence/src/index.test.ts`: `toBatchSummary` cases:
  - a never-retried batch is unchanged (`:130`);
  - a reopened round before its first claim gives a null duration;
  - a round with a claim counts time from the first claim;
  - only the round's completions count toward throughput.
- `packages/ocr-persistence/src/export.test.ts`:
  - a page row has `original_file_name` = the parent's name, page 2 and page_count 5, with a Bangkok time;
  - a single image has an empty page;
  - v3.1 and v2.2 rows;
  - more than 4 treatments go to `treatments_more`;
  - the `" (?)"` raw fallback and flagged items;
  - the legacy reviewer label;
  - the detailed columns;
  - the Thai labels equal the workbench copies.
- `apps/ocr-web/src/export.test.ts`:
  - CSV encoding: the BOM exactly once; quotes, CRLF and Thai; the formula guard on `=cmd.pdf`, on `-5` in a text
    column and on `@x`, while numeric columns stay numbers; the 32,000-character cut;
  - **JSONL** (none of this is covered by the CSV cases): every line `JSON.parse`s; the first four keys are
    `original_file_name`, `page`, `page_count`, `uploaded_at` in that order; a page row carries the parent's name, its
    page number, its page count and a `+07:00` `uploaded_at` with a matching `uploaded_at_utc`; a value starting with
    `=` is **unchanged** and long text is **not** truncated; there is **no BOM**; lines are `\n`-separated; the
    content type is `application/x-ndjson` and the filename ends `.jsonl`; an aborted stream leaves no complete file;
  - streaming: 10k fake rows into a slow writable with `drain` awaited and bounded buffering; a client abort runs the
    generator's `finally`; a fake export client that emits `'error'` mid-stream rejects the export without crashing;
  - audit: a stream that throws, and a generator killed by a client abort, each still leave an `export.started` row;
  - HTTP: the filter parser including `dateField`; `Content-Disposition`; 401, 403, 400 `EXPORT_TOO_LARGE` before
    headers, and 429 `EXPORT_BUSY`.

**DB integration** (extend `packages/ocr-persistence/src/batch.db.test.ts` inside its existing `describe`. A second
`*.db.test.ts` would race on the cluster-wide role passwords, `:96-100`.)
- **Pins:**
  - `:648` `applied.slice(-2)` becomes an order check that 0017 and 0018 were applied and that the last entry is the
    newest migration;
  - the 8-function list (`:661-663`) stays exact, with a message saying 0019 and 0020 created no function;
  - the 4 roles stay `rolbypassrls=false` (`:155-158`).
- **0019:**
  - `relforcerowsecurity` on the 3 tables and the exact privilege matrix;
  - ocr_worker and ocr_queue get 42501 on SELECT from users, auth_sessions and audit_events;
  - ocr_app gets 42501 on `UPDATE users SET organization_id|username`, on UPDATE or DELETE of audit_events and on
    DELETE of users and sessions;
  - with no GUC nothing is visible, and tenant B sees none of tenant A's users, sessions or audit rows;
  - inserting a user for tenant A while `app.current_org` is B fails RLS;
  - a cross-tenant session FK gives 23503;
  - the same username may exist in both tenants.
- **Store flows as ocr_app:**
  - create, login lookup, failures to lock, unlock, create/resolve/touch/revoke session, the password change revokes
    the others;
  - the last-admin guard under concurrency (two transactions);
  - a review and its audit row roll back together.
- **Names:** `REVIEW_SELECT`'s `reviewed_by_name` join with (a) a matching user, (b) a `reviewed_by` uuid with no
  user row, and (c) a legacy **non-UUID** `reviewed_by` value — the text comparison must not error and must yield
  null, so the drawer and the export fall back to `บัญชีรวม (ก่อนมีระบบล็อกอิน)`.
- **Export:**
  - tenant isolation; SPLIT and DELETED excluded; the `confirmedOnly` count equals the `confirmed` category count;
  - `dateField=reviewed_at` selects rows by Bangkok confirmation date and excludes unconfirmed rows;
  - page rows carry the parent's name and time;
  - 600 rows with one identical `created_at` produce no duplicate or missing row;
  - `EXPORT_TOO_LARGE` at maxRows=1;
  - an INSERT inside the export transaction fails with 25006.
- **0020:**
  - ocr_app can UPDATE `round_opened_at` but not `label`;
  - a retry into an idle batch sets the round, and a retry while another row is PROCESSING does not;
  - `markProcessing` as ocr_worker sets `processing_started_at` once, and a retry resets it;
  - the worker gate query for `0020_batch_round_clock`.
- **Where it runs:** a throwaway `postgres:17.6` container on a free loopback port, with its password generated into a
  shell variable and never printed. Never the compose DB (`127.0.0.1:55432`) and never another app's database.

**Static and ops tests**
- `test/user-auth-migration.test.ts` — **every forbidden-text assertion matches comment-stripped SQL**
  (`const statements = sql.replace(/--.*$/gm, "")`, as `test/batch-migration.test.ts:8` and
  `test/multipage-migration.test.ts:7` already do). 0019's own header comments contain the phrases
  "SECURITY DEFINER functions", "Defines no function" and "ocr_worker and ocr_queue get nothing" (§3 A1), so matching
  raw text would either fail the test or push the implementer to delete the explanation:
  - forbidden text: no `FUNCTION`, `SECURITY DEFINER`, `BYPASSRLS`, `ALTER ROLE`, `ocr_queue` or `ocr_worker`, no
    DROP TABLE/COLUMN, no BEGIN/COMMIT and no CONCURRENTLY;
  - the exact GRANT list (4 statements), with no DELETE, ALL or TRUNCATE;
  - FORCE RLS and the exact policy text for each of the 3 tables;
  - the verify-db-roles / `verify-release2-grants.sql` lines from A2, including the `ocr_queue_definer` checks.
- `test/batch-round-migration.test.ts`: exactly 2 `ADD COLUMN IF NOT EXISTS` and 1 column GRANT, with no function —
  also against comment-stripped SQL.
- **`test/migration-checksums.test.ts`** (added in the Deploy A closeout commit): the sha256 of
  `0019_user_auth/migration.sql` is pinned, next to the existing 0001–0018 expectations. An edit after Deploy A
  crash-loops production at startup, so the test must fail first.
- The existing `test/batch-migration.test.ts:57-62` (FORCE RLS on every table, matched against **raw** text) must pass
  unchanged.
- `deploy/e2e-production.sh`: a static test that it contains no `-H "X-CSRF-Token: $` and no `Authorization: Bearer`.
- **Manual** (all on the dev stack of E5b before production):
  - open a synthetic CSV in Excel on Windows and macOS and in LibreOffice: Thai text, `=` filenames, rooms;
  - open a synthetic JSONL and confirm no BOM and no leading `'`;
  - check the browser password manager on login and on password change;
  - check the login, the **header user menu** and the dialogs at phone width (375px), with no horizontal page scroll;
  - check keyboard focus and `:focus-visible`.

## 13. Observability

- **Counters** (bounded labels):
  - `auth_logins_total{result=success|invalid|throttled|busy|expired}`
  - `auth_csrf_rejected_total`
  - `auth_sessions_revoked_total{reason}`
  - `user_admin_total{action}`
  - `exports_total{format,result=ok|too_large|busy|forbidden|aborted|error}`
  - `export_rows_total{format}`
  - `access_denied_suppressed_total`
  - **`documents_read_total{kind=listed|opened}`** — rows returned by `GET /api/documents` and full documents opened
    through `GET /api/documents/:id/ocr`, per user id. This is the compensating control for D8: `can_export` gates the
    file, not the data, and those two routes are neither audited nor rate-limited today.
- **Alerts** added to `deploy/prometheus-alerts.yml` — **which production does not load today**: the production
  Prometheus config has no `rule_files` and compose mounts only that one config file, so E6 adds both and Deploy A
  restarts this project's own prometheus container. Without that step these alerts are decoration.
  - `OcrLoginFailuresHigh`: `increase(auth_logins_total{result="invalid"}[15m]) > 20`
  - `OcrLoginBusy`: `increase(auth_logins_total{result="busy"}[15m]) > 0` (warning — the hash gate is saturated, i.e.
    a flood, not bad typing)
  - `OcrCsrfRejected`: `increase(auth_csrf_rejected_total[15m]) > 0` (warning)
  - `OcrBulkRead`: `increase(documents_read_total[1h]) > 5000` (warning)
- **Audit queries for the operator** (as the bootstrap user, counts only): `SELECT action, outcome, count(*) FROM
  audit_events GROUP BY 1,2`. The audit table answers who uploaded, retried, reviewed, confirmed, exported, previewed
  an export or changed a user. It does **not** answer who read documents one page at a time; that is what
  `documents_read_total` is for.

## 14. Commit order (login strictly before export)

1. **C1:** 0019, its static test, the verify-db-roles lines and the `batch.db.test.ts` pins and 0019 cases.
2. **C2:** `packages/auth` password and session, `loadWebConfig`, tests.
3. **C3:** `withTenant`, `audit.ts`, `PostgresUserStore`, DB tests.
4. **C4:** the server auth flow, token-route removal, CSRF, throttles, error mapping, `routeLabel`, `/metrics`,
   logging, tests.
5. **C5:** attribution and audit plumbing in the stores, runtime and server, tests.
6. **C6:** workbench login, session, password and users UI, tests.
7. **C7:** CLI, `ocr-users.sh`, `auth-smoke.sh`, e2e, compose, preflight, README, spec and deploy docs, alerts.

An adversarial review of C1–C7 follows. **Deploy A**, then a small closeout commit pinning 0019's checksum
(§12, §15 Deploy A step 11) before any further schema work.

8. **C8:** 0020 and the batch clock (persistence, worker gate, UI), tests.
9. **C9:** export flattening, `documentFilterSql`, `openExport`/`previewExport`, tests.
10. **C10:** export routes, writer and gate, tests.
11. **C11:** export UI, tests, design-doc renumbering, `release2-deploy.md`.

An adversarial review of C8–C11 follows. **Deploy B.**

## 15. Deploy and rollback

Run on the app VPS in `/opt/innovera-ocr-app/ocr`, with
`C="docker compose --env-file /etc/innovera/ocr-compose.env -f deploy/docker-compose.yml"`. Steps marked
**[CHANGE]** need the user's approval first. Commands print keys, counts or status codes, never values.

15.1. **Read-only inspection (approved once):**
- the env keys present:
  `grep -oE '^[A-Z_]+=' /etc/innovera/ocr-compose.env | sort`. Expect `OCR_WEB_TENANT_ID=`,
  `OCR_WEB_AUTO_AUTH=` and `OCR_REQUEST_TIMEOUT=`.
- `git status --short` and `git log -1`;
- `$C ps`, and `$C images web worker` for the image names;
- `schema_migrations` ends at 0018:
  `$C exec -T postgres psql -U ocr_bootstrap -d innovera_ocr -AtX -c "SELECT max(version) FROM schema_migrations"`.
- **nginx-proxy appends the client IP — a precondition of Deploy A**, not an optional extra. It needs a separate
  approval, because it reads the shared proxy.
  - The command is `docker exec <nginx-proxy> nginx -T 2>/dev/null | grep -c 'X-Forwarded-For $proxy_add_x_forwarded_for'`.
  - It prints a count only and changes nothing. A count ≥ 1 allows `OCR_TRUSTED_PROXY_HOPS=1`, which is what Deploy A
    step 3 sets.
  - If the check is declined or the count is 0, hops stays 0 and **the per-IP limiter is off** (D5). Deploy A may still
    proceed, but then the unknown-name budget, the split gates and the web `cpus` limit are the only things standing
    between an unauthenticated flood of random usernames and a login outage for every staff member; `OcrLoginBusy`
    must be watched, and the residual risk is the one listed in §17.
- **Where the grant checks can run.** Confirm, keys only: does `/etc/innovera/ocr-production.env` exist on this host,
  does it hold host-reachable DSNs (the compose DSNs point at the in-network `postgres` host, which the host cannot
  resolve), and is `psql` installed on the host? `deploy/verify-db-roles.sh:3-7,10` needs all three, and the web image
  is `node:24.21.0-bookworm-slim` with no `psql` (`deploy/Dockerfile.web:1`). If any answer is no, Deploy A step 6 uses
  the in-container form (A2), which earlier releases already used (`full-document-batch-deploy.md:16-18`,
  `release1-report-2026-09-22.md:13`).

**Deploy A: login (0019, web only)**
1. **[CHANGE] Backup and tags.**
   - `install -d -m 700 /opt/innovera-backups/release2-<date>`
   - `$C exec -T postgres pg_dump -U ocr_bootstrap -d innovera_ocr -Fc > …/database-pre-0019.dump`
   - `$C exec -T postgres pg_restore --list < …/database-pre-0019.dump | head -3`
   - `docker tag <web image> <web repo>:pre-release2`, and the same for the worker.
2. **[CHANGE]** Check out the release commit on the host: `git fetch origin`, then `git checkout <release tag>`. Do
   not run `production-preflight.sh` or `go-live-check.sh` until step 4: their migration check would apply 0019 from
   the host.
3. **[CHANGE] Host env edit** (keys only in any output):
   - **delete** the `OCR_WEB_AUTO_AUTH` line, so a rollback fails closed (see Rollback A);
   - add `OCR_PUBLIC_BASE_URL`, the public https origin of the workbench;
   - set `OCR_TRUSTED_PROXY_HOPS=1` (15.1); leave it at 0 only if that check was declined or returned 0;
   - **rotate `AUTH_JWT_SECRETS` in place**, generated on the host straight into the file and never printed, e.g.
     `python3 -c "import secrets;print('AUTH_JWT_SECRETS='+secrets.token_urlsafe(48))" >> <file>` after removing the
     old line, then `grep -c '^AUTH_JWT_SECRETS=' <file>` = 1 as the only output. The new web never verifies Bearer and
     the worker only needs the key to be present, so this costs nothing — and without it a Rollback A would re-enable
     every outstanding web-token and every operator `JWT_TOKEN` without `exp`, which never expire
     (`packages/auth/src/index.ts:31`, `apps/ocr-web/src/server.ts:248`);
   - optionally add `OCR_SESSION_IDLE_MINUTES` and `OCR_SESSION_ABSOLUTE_HOURS`, only if the user chose values other
     than the defaults;
   - keep `OCR_WEB_TENANT_ID`, `AUTH_JWT_ISSUER` and `AUTH_JWT_AUDIENCE`;
   - `OCR_WEB_SUBJECT_ID` may stay until Release 2 is accepted; nothing reads it any more.
4. **[CHANGE] Start the new web.** Deploy outside spa hours: nobody can use the UI between this step and step 5.
   - `$C build web`, then `$C up -d --no-deps web`. The web applies 0019 at startup as ocr_migrator.
   - Checks:
     - `$C logs --since 5m web | grep -c request_failed` gives 0;
     - `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:53100/health/ready` gives 200;
     - `SELECT max(version) FROM schema_migrations` gives `0019_user_auth`;
     - `SELECT relname, relforcerowsecurity FROM pg_class WHERE relname IN ('users','auth_sessions','audit_events')`
       gives 3 × t;
     - `SELECT pg_get_userbyid(proowner), count(*) FROM pg_proc WHERE proname LIKE 'ocr%' GROUP BY 1` still gives
       7 × `ocr_queue_definer` and 1 × `ocr_migrator`.
5. **The user runs `./deploy/ocr-users.sh create-admin` in their own SSH TTY.** This comes **before** the grant check,
   so a check that cannot run on this host never extends the window in which nobody can log in.
6. **Grant check** (non-blocking for step 5, and it must still print `FAIL=0` before staff accounts are created):
   - `$C exec -T postgres psql -U ocr_bootstrap -d innovera_ocr -AtX -f -` fed with
     `deploy/sql/verify-release2-grants.sql` (A2). It names every role explicitly, so it needs no role password, no
     host `psql` and no host-reachable DSN.
   - `set -a; . /etc/innovera/ocr-production.env; set +a; ./deploy/verify-db-roles.sh` **only if** 15.1 confirmed that
     file, host `psql` and host-reachable DSNs all exist.
7. **[CHANGE]** Load the alert rules: `$C up -d --no-deps prometheus` (E6), then
   `curl -s 127.0.0.1:59090/api/v1/rules | grep -c OcrLoginFailuresHigh` ≥ 1. Only this project's prometheus container
   is touched.
8. `./deploy/auth-smoke.sh https://ocr.innoveraappcenter.com`: every check must PASS.
9. The user logs in in the browser, creates the staff accounts and hands over the temporary passwords in person. They
   review one existing document, and the drawer shows `ยืนยันโดย <name>`.
   - Check with counts only:
     `SELECT count(*) FROM documents d JOIN users u ON u.id::text = d.reviewed_by` ≥ 1, and
     `SELECT action, count(*) FROM audit_events GROUP BY 1`.
   - Optionally run `E2E_USERNAME=<own account> ./deploy/e2e-production.sh`; it prompts for the password.
10. The worker is **not** touched in Deploy A (it still requires 0018).
11. **Freeze 0019.** Commit the `test/migration-checksums.test.ts` pin (§12). From here on a schema fix takes 0020 and
    the batch clock slides to 0021 (§3 A3).

**Rollback A:**
- `docker tag <web repo>:pre-release2 <web image>`, then `$C up -d --no-deps web`.
- 0019 stays: it is additive, and the old runner iterates only the files it has (`db-runtime/src/index.ts:28-35`).
- The old web's `/api/web-token` answers 503, because `OCR_WEB_AUTO_AUTH` is absent and the compose default is 0.
  The UI stays unusable until a fix-forward, and **the public token hole does not reopen**. Reopening it needs the
  user's explicit approval.
- **Bearer stays closed too**, because step 3 rotated `AUTH_JWT_SECRETS`: the old image still verifies
  `Authorization: Bearer` (`apps/ocr-web/src/server.ts:248`) and accepts tokens without `exp`
  (`packages/auth/src/index.ts:31`), so every JWT minted before Deploy A now fails signature verification on the
  rolled-back image as well. Without the rotation this rollback would silently undo D7.
- Restore the dump only if data is damaged. The volume is never recreated.

**Deploy B: export, batch clock and timeout (0020, web then worker)**
1. **[CHANGE]** Take a backup (`database-pre-0020.dump`), tag the images `:pre-release2b` and check out the release
   commit.
2. **[CHANGE]** Set `OCR_REQUEST_TIMEOUT=300` in the host env file (G6 — set it, do not delete the line).
3. **[CHANGE] Stop the old worker first:** `$C build web worker`, then `$C stop worker`. This is the documented order
   (`deploy/README.md:9`) and it is load-bearing here: while the old worker runs against the new web, a retry (G3) can
   open a round and clear `processing_started_at`, but the old `markProcessing` sets no clock
   (`packages/ocr-persistence/src/index.ts:487-491`), so `round_started_at` would stay NULL and `durationMs` null for
   good and the finished batch would keep showing `รอเริ่มอ่านรอบใหม่`. Stopping first costs at most one in-flight
   lease, which the queue recovers. Waiting for `count(*) WHERE status='PROCESSING'` = 0 is **not** a substitute: it
   races with the next claim, and while a long PDF is being read it is almost never 0 (~52 s/page, 95 pages ≈ 82 min,
   `release1-report-2026-09-22.md:28`).
4. **[CHANGE] Web.** `$C up -d --no-deps web`, which applies 0020. Check health and
   `max(version)` = `0020_batch_round_clock`.
5. **[CHANGE] Worker.** `$C up -d --no-deps worker`, which passes the 0020 gate.
   - `$C exec -T worker printenv OCR_REQUEST_TIMEOUT` prints 300.
   - `$C logs --since 5m worker | grep -c worker_started` gives 1.
6. The grant check of Deploy A step 6 must print `FAIL=0`, including the 0020 lines.
7. **Checks by the user:**
   - a staff account without export rights sees no ส่งออก, and a direct URL gives 403;
   - the admin previews and downloads a CSV, then opens it in Excel on their own machine. Production exports never
     leave the user's browser and never reach git or chat.
   - `SELECT count(*) FROM audit_events WHERE action IN ('export.started','export.completed','export.previewed')
     GROUP BY action` shows a `started` for every `completed`;
   - retry one failed row in an idle batch and watch the strip show `รอเริ่มอ่านรอบใหม่` with `—` for เวลาที่ใช้ and
     หน้า/นาที, then a new round once the worker claims the row.

**Rollback B:**
- Retag web and worker to `:pre-release2b` (the Deploy A images), then `$C up -d --no-deps web worker`.
- The old worker requires only 0018. The added columns are ignored, and the timeout stays 300.

## 16. Open user decisions (each with the recommended default)

1. **Who may export:** admins, plus staff whose `can_export` flag an admin turned on (off by default). Alternatives:
   every logged-in staff member, or admins only.
2. **Session length:** 30 min idle (only user actions count; background polling does not) and 12 h absolute. The
   cookie disappears when the browser closes, and the in-place re-login keeps drafts and uploads. Alternative: 2 h
   idle for fewer re-logins on shared front-desk PCs.
3. **Password policy:** at least 12 characters (Thai and spaces allowed), a small common-password blocklist, never
   containing the username, and no forced periodic change. Alternative: 10 characters, which is below ASVS L2.
4. **Lockout:** 10 wrong passwords in a row lock the account for 15 min, and an admin can unlock it. There is also
   the per-name and per-IP window. Alternative: 5 failures.
5. **New staff passwords:** a server-generated temporary password, shown once to the admin, valid for 72 h, with a
   forced change at first login. Alternative: one-time setup links.
6. **Trusting nginx-proxy's `X-Forwarded-For`** (`OCR_TRUSTED_PROXY_HOPS=1`) for per-IP throttling: yes, after the
   read-only check in 15.1. Alternative: keep 0, which leaves the per-IP limiter off and makes the per-account limits
   carry the protection.
7. **Machine and script access:** no Bearer tokens. `e2e-production.sh` logs in as your own account with a hidden
   password prompt. Alternative: keep JWT Bearer tokens for scripts, with mandatory `exp` and a user check.
8. **Label for reviews made before login existed:** `บัญชีรวม (ก่อนมีระบบล็อกอิน)` in the drawer and the export, with
   no fake user rows. Alternative: leave the reviewer blank.
9. **Block `/metrics` for requests through the public proxy:** yes. Prometheus reads it internally and is unaffected.
10. **Deploy shape:** two approved deploys, A (login) and then B (export, batch clock and timeout). Alternative: one
    combined maintenance window.
11. **Rollback posture:** fail closed. `OCR_WEB_AUTO_AUTH` is removed from the host env, so the old UI shows an error
    instead of reopening the public token. Reopening needs your explicit approval.
12. **Audit data:** keep `audit_events` and session rows indefinitely, and store no IP addresses. Alternatives: store
    the IP on login events, or set a PDPA retention period, which would need a later cleanup job that runs per tenant.
13. **Batch clock for a batch's first round:** keep counting from the batch's creation, which includes upload and
    queue wait and matches today's tests. A retried round counts from its first claim. Alternative: start the first
    round at its first claim too.
14. **Export content and order:** the full column set of design §3.2 with ชื่อไฟล์ต้นฉบับ, หน้า, จำนวนหน้า and
    อัปโหลดเมื่อ first, oldest rows first, and 50,000 rows at most. Alternative: newest first, like the list.
15. **Two-factor authentication for admins:** deferred to Release 3. The schema leaves room for it.
16. **Migration numbering:** Release 2 uses 0019 and 0020. The design's cancel migration moves to 0021 and the
    template/branch migration to 0022. If a fix-forward schema change is needed between Deploy A and Deploy B, every
    later number slides by one.
17. **Export date filter:** offer both `วันที่อัปโหลด` (`created_at`, the default) and `วันที่ยืนยัน`
    (`reviewed_at`), as the design's `dateField` already describes. "Confirmed on date X" is the natural daily
    hand-off filter, and filtering only by upload date misses older uploads confirmed today. Alternative: upload date
    only, and `dateField` moves to Release 3.
18. **`OCR_TRUSTED_PROXY_HOPS=1` as a Deploy A precondition:** yes — read the shared nginx-proxy config once
    (read-only, §15.1) and turn the per-IP limiter on. Alternative: keep 0 and accept the residual flood risk in §17,
    with the unknown-name budget, the split hash gates, the web `cpus` limit and the `OcrLoginBusy` alert as the only
    defences.

## 17. Risks

- **Lock-out window.** Between Deploy A step 4 and step 5 nobody can log in, and old tabs get 404 from
  `/api/web-token`. Mitigation: deploy off-hours, run the CLI straight away, and tell staff to reload.
- **Break-glass.** If every admin loses their password, recovery needs host access to run `reset-password`. Keep two
  admins.
- **Targeted lockout.** Anyone who knows or guesses a username can lock that account for 15 minutes, and can keep it
  locked indefinitely by retrying 10 times every 15 minutes. A locked account now answers 401, exactly like a wrong
  password (D5), so a correct password also fails and the user sees only "wrong password". Mitigation: usernames are
  not public and admin usernames should not be guessable (no `admin`, `manager`, `makkha`); another admin can unlock;
  the per-IP window catches a single source. Break-glass if every admin is locked at once: the host CLI
  `./deploy/ocr-users.sh unlock`.
- **Login flood.** Hashing costs ~250 ms and 32 MiB. With hops=0 the per-IP limiter is off, so a flood of random
  usernames is bounded only by the unknown-name budget, the split gates and the web `cpus` limit. Mitigation:
  `OCR_TRUSTED_PROXY_HOPS=1` (§16.18), the `OcrLoginBusy` alert, and `adminGate` keeping admin recovery working while
  `loginGate` is saturated.
- **Bulk reads are not export.** `can_export` gates the file, not the data (D8): any staff session can page the list
  and open full documents including health conditions. Mitigation: `documents_read_total` plus the `OcrBulkRead`
  alert, plus the fact that every account is now named and revocable. A per-user read cap is a Release 3 option.
- **Audit tamper resistance is partial.** The table is append-only for `ocr_app`, but the web process also holds
  `DATABASE_URL_MIGRATOR` (D9). Mitigation: every audit row is mirrored to stdout. Moving migrations into a one-shot
  compose service, so the long-running web never holds the owner DSN, is a Release 3 option.
- **Throttle state after a restart.** The in-memory windows reset when the web restarts; the DB lock does not. A
  second web replica would need DB-backed windows.
- **`OCR_TRUSTED_PROXY_HOPS=1` depends on nginx-proxy staying the only hop.** Anyone with a shell on the host can hit
  `127.0.0.1:53100` with a forged header, but that affects throttling only.
- **`OCR_PUBLIC_BASE_URL` must equal the browser origin.** Otherwise every POST fails closed with `CSRF_REJECTED`. The
  preflight check and the smoke test cover this.
- **Browsers must send `Origin` or `Sec-Fetch-Site` on POST.** Very old browsers get 403. Check the front-desk PCs
  once.
- **Per-request cost.** One session query per API call (polling every 3–15 s per tab), shared with the 10-connection
  pool and up to 2 export connections. This is small at 50 staff; measure in the smoke test.
- **Export pins a connection.** It holds one inside a REPEATABLE READ transaction. `statement_timeout` (60 s),
  `idle_in_transaction_session_timeout` (120 s), the 2-export gate and the 10-minute cap bound it. A fetch-plus-Blob
  download holds the file in browser memory; at 50k rows that is up to about 100 MB.
- **Worker gate in Deploy B.** If the worker starts before the web has applied 0020, it restart-loops on
  `SCHEMA_NOT_READY`. That is safe and heals itself, but the order must be web first.
- **Test churn.** The pinned DB test values, the `/api/web-token` needles, the password-input ban and the synchronous
  auth harness all change in C1, C4 and C6.
- **The batch clock is approximate.** It counts round completions by `COALESCE(processed_at, updated_at)`, and a queue
  busy with another batch still inflates a round's elapsed time.
- **Admins know temporary passwords until first use.** The password is consumed by that first successful login (D6),
  and the 72 h expiry and the forced change bound the window before it.
- **Exported CSV files leave the system's control.** Mitigation: export permission, the audit log (`export.started` is
  committed before a single byte leaves) and user training.
- **Leftover unused config.** `AUTH_JWT_SECRETS` stays required but unused by the web. Its value is rotated in Deploy A
  step 3, so no pre-Release-2 token survives even a rollback; rotate it again before any future re-enablement of
  Bearer access.
- **0019 is checksummed from Deploy A onward.** Editing it crash-loops the web at startup. A fix takes the next free
  number (§3 A3), and `test/migration-checksums.test.ts` fails first.

## 18. Review record (adversarial review of this plan, 2026-09-23)

Three reviewers (security; deploy + database; requirements + UX + tests) raised 34 findings. Every one was checked
against this plan and against the code on `78a92b8`, and every one held up. None was rejected. Two pairs were the same
defect seen through two lenses (F6/F20, F4/F21) and were fixed once.

| # | Finding | Verdict | Where it landed |
|---|---|---|---|
| F1 | A DB-locked account answered 429 + `Retry-After` while an unknown name answered 401 — an enumeration oracle, plus a DB-write timing oracle and a `DUMMY_HASH` parameter mismatch | fixed | D5, C3 steps 5–7, B1 `DUMMY_HASH`, §12 enumeration regression test |
| F2 | One global `HashGate` was itself a DoS switch; an unauthenticated flood of random names could 429 every staff login and every admin recovery | fixed | D5 (unknown-name budget), B1 (`loginGate` / `adminGate`), E5 (`cpus` limit), C11, §15.1 precondition, §13 `OcrLoginBusy`, §17 |
| F3 | A temporary password was not single-use despite the plan and the UI saying so: usable for 72 h if the forced-change dialog was abandoned | fixed | D6, B5 `recordLoginSuccess`, C3 step 8, §12 |
| F4 | A different user's login could still have the first user's save and upload sent under their name (async `location.replace`, plus the `beforeunload` "Stay" path) | fixed | F2 `requireLogin` `USER_CHANGED` rejection + abort/cancel/`state.leaving`, §12 behaviour test |
| F5 | The export audit could be lost on a crash, and previews were never audited at all | fixed | §6 table, H1 (`export.previewed` + rate limit), H5 `export.started` before `writeHead`, §12, §15 Deploy B step 7 |
| F6 | Rollback A reopened Bearer: the old image still verifies JWTs, and tokens without `exp` never expire | fixed | D7, §15 Deploy A step 3 (in-place `AUTH_JWT_SECRETS` rotation), Rollback A, §17 |
| F7 | The rewritten e2e script put the CSRF token in curl's argv, breaking this plan's own hard rule | fixed | Hard rules, E3 (`-H @"$hdr"`, mode-600 mktemp), §12 static test |
| F8 | `can_export` was presented as protecting health data, but any staff session can page the list and open full documents | fixed | D8, §13 `documents_read_total` + `OcrBulkRead`, §17 |
| F9 | `audit_events.request_id` came from a client header; `access.denied` was unthrottled; the web holds the table owner's DSN | fixed | B4 (server `trace_id`, rate limit), D9, §6 Logs (stdout mirror), §12, §17 |
| F10 | `verify-db-roles.sh` checked nothing about `auth_sessions` identity columns, `ocr_queue`, or the BYPASSRLS `ocr_queue_definer`, and FORCE RLS was eyeballed | fixed | A2 (explicit role names, definer checks, `bool_and(relforcerowsecurity)`) |
| F11 | The re-login overlay only hid the page, leaving customer names and the open health form readable in the DOM | fixed | F2 `requireLogin` clears rendered PHI and the blob URL, keeps only the draft; §12 behaviour test |
| F12 | The only automated grant check may not be runnable on the production host, and it blocked the admin bootstrap during the lock-out window | fixed | A2 (`deploy/sql/verify-release2-grants.sql`, in-container), §15.1 preflight question, Deploy A steps 5–6 reordered |
| F13 | Deploy B started the new web while the old worker ran, so a retry could leave `round_started_at` NULL for good; the "no PROCESSING row" wait was a race | fixed | §15 Deploy B step 3 (`$C stop worker` first, with the reason) |
| F14 | The new Prometheus alerts would never load: no `rule_files`, no mount, no reload step | fixed | E6, §13, §15 Deploy A step 7 |
| F15 | Only 0001–0018 were frozen, so editing 0019 after Deploy A would crash-loop the web, and 0020 was already reserved | fixed | Hard rules, A3, §12 `migration-checksums.test.ts`, §14, §15 Deploy A step 11, §17 |
| F16 | `idle_in_transaction_session_timeout` on a pooled export client would emit an unhandled `'error'` and crash the web (no pg error listener exists anywhere) | fixed | D10, H4 step 1 (`client.on('error')` + `pool.on('error')`), §11, §12 |
| F17 | Deleting `OCR_REQUEST_TIMEOUT` contradicted the preflight, which requires the key to be non-empty | fixed | G6 (set 300, do not delete), E6, §15 Deploy B step 2 |
| F18 | The 0019 static-test spec contradicted 0019's own explanatory comments; existing tests strip comments, this one did not say so | fixed | §12 (comment-stripped matching, raw-text FORCE RLS check kept) |
| F19 | After E5 the repo's stack could not exercise login (`OCR_ENV: production`, https-only origin) and a fresh DB could not boot (`assertTenant`, no organizations seed) | fixed | E5b (`docker-compose.dev.yml`, `seed-dev-tenant.sql`), §11, §12 manual checks |
| F20 | Same defect as F6, seen from the deploy lens | fixed | see F6 |
| F21 | Same defect as F4, seen from the requirements lens | fixed | see F4 |
| F22 | A session-bound CSRF token went stale in other tabs after a re-login or password change, with no recovery but a draft-losing reload | fixed | F2 `api()` / `send()` handle 403 `CSRF_REJECTED` once via `GET /api/auth/session`; §12 behaviour test |
| F23 | The drawer-scoped `ask` overlay was reused for `users-dlg` rows and logout; it would hang and leave a stale question in the drawer | fixed | F1a (`confirm-dlg`), F1 users-dlg, F2 logout, §12 behaviour tests |
| F24 | The batch-clock fix reintroduced the Release 1 symptom while a reopened round waited for its first claim, and the fallback rate still used all-time completions | fixed | G5 (`—` for both cells, `roundCompleted` fallback), §12, §15 Deploy B step 7 |
| F25 | Polling could stop permanently after a re-login, freezing the list for staff waiting on OCR | fixed | F2 Polling (re-arm once `authWait` settles), §12 (fake clock in the harness) |
| F26 | JSONL is a required format but had no tests and no specification: content, field order, time zone, BOM and formula-guard rules were all undefined | fixed | H5 JSONL spec, §12 `export.test.ts` JSONL cases |
| F27 | The behaviour harness cannot run the planned auth cases (`EXPOSE`, no `location.replace`), two planned assertions were wrong, and the headline mid-review-expiry flow had no test | fixed | §12 harness changes, corrected `:131`/`:149` assertions, save→401→retry, `reviewed_by_name` DB cases |
| F28 | The preview spec contradicted itself: `N/M` in หน้า next to a จำนวนหน้า column, and `pageLabel` takes a document, not a string row | fixed | H1, H6 (bare page number, `จำนวนหน้า` beside it, `หน้า 3/95` as the title), §12 |
| F29 | The export dialog inherited `q` and `parentFilter` with nothing showing or clearing them, silently narrowing the file | fixed | H6 (removable chips) |
| F30 | The design's `dateField=reviewed_at` was dropped with no mention in the non-goals or the decisions | fixed | H2 (`dateField`), H6 select, §12 DB test, §16.17 |
| F31 | The forced first-login password change was inescapable (modal, header logout inert) and asked for the password just typed | fixed | F1 `pw-dlg` logout button, C5 (`currentPassword` optional within 5 min), §12 |
| F32 | An admin could reset or unlock themselves, revoking their own session and hiding the one-time password behind the login dialog | fixed | C6 (`CANNOT_CHANGE_SELF`), F1 (actions hidden on your own row), §12 |
| F33 | The new header user menu would overflow and cause horizontal scroll at phone width | fixed | F1 (single `#me-open` pill + `me-dlg` at ≤720px), §12 manual and behaviour checks |
| F34 | A Thai keyboard layout produced silent `INVALID_CREDENTIALS` against an ASCII-only username, and there was no way to reveal a 12+ character password | fixed | F1 login fields (keyboard hint, `แสดงรหัสผ่าน` toggle), §12 |

## Deviations at implementation

Recorded as each commit lands, per the implementation rule: follow the code, fix the smallest thing that works, and
write the deviation down instead of diverging silently.

**C1 (0019, its static test, the verify-db-roles additions and the batch.db.test.ts pins)**

- **The 8-function message in `batch.db.test.ts`.** §12 asks for a message saying "0019 and 0020 created no function".
  0020 does not exist yet at C1, so the message reads `0018 and 0019 created no function`; C8 extends it when 0020
  lands. The asserted list of 8 functions is unchanged, so the check itself is exactly what §12 specifies.
- **Which connection the new `verify-db-roles.sh` checks use.** A2 fixes the role names but not the DSN. The 0019
  lines run on `$DATABASE_URL_BOOTSTRAP`, which the script already requires (`verify-db-roles.sh:3`): one connection
  answers for every role, which is the point of naming them explicitly, and the role-DSN checks above are untouched.
- **`has_any_column_privilege` for the worker/queue read checks.** A2 names the function only for the `ocr_app` audit
  and `ocr_queue_definer` checks. `worker:no-select-*` and `queue:no-select-*` use it too: `has_table_privilege` is
  false when only a column grant exists, so the table-level form would miss exactly the drift that matters. This
  follows the 0018 convention (`worker:no-select-extraction-jobs`).
- **`deploy/sql/verify-release2-grants.sql` shape.** A2 says what it must check and §15 Deploy A step 6 says it must
  print `FAIL=0`. It is one read-only `WITH checks(...) VALUES` query that prints `PASS <name>` / `FAIL <name>` per
  check and a final `SUMMARY PASS=n FAIL=m`, so `psql -AtX -f -` needs no wrapper script inside the container.

**C2 (`packages/auth` password and session, `loadWebConfig`, unit tests)**

- **`maxmem` for an older in-bounds hash.** §2 D3 fixes `maxmem` at 64 MiB while §4 B1 accepts N up to 2^17 and r up
  to 16 on verify. Those two cannot both hold: scrypt needs `128·N·r` bytes, which is 256 MiB at the top of the
  accepted bounds, so a hash near it would make `crypto.scrypt` throw instead of verifying. `derive` therefore uses
  `max(64 MiB, 128·N·r·2)`. Hashing with `SCRYPT_PARAMS` gets exactly the 64 MiB the plan names (it needs 32 MiB), and
  only a stored hash we wrote ourselves with heavier parameters can ask for more. `verifyPassword` also treats a
  throw from the derivation as `false`, so no input can turn a bad hash into a 500.
- **`DUMMY_HASH` is built from random bytes, not derived from a placeholder password.** B1 asks for a constant
  computed once at start-up with exactly the parameters every stored hash uses, so that an unknown username costs the
  same as a known one. What makes the cost equal is the parameters the constant carries, not where its 32 key bytes
  came from: `verifyPassword` runs the identical derivation either way, and no password can match 32 random bytes.
  Formatting the constant instead of deriving it keeps `import` free, which matters because the CLI and every test
  process that touches the package would otherwise pay one full 250 ms hash at load.
- **`checkPasswordPolicy` throws a `PasswordPolicyError`.** B1 says a violation throws `WEAK_PASSWORD`; the error
  carries that exact message, so `errorCode`/`errorStatus` still map it to 400 with no change. It adds a `reason`
  field (`too_short`, `contains_username`, …) so the CLI (E1) and the workbench can say which rule failed without
  parsing prose. The denylist is matched for equality against the normalized, lower-cased password, which is what
  "must not appear on a denylist" means; the short context words in the list cannot match on their own under the
  12 code-point minimum, and they stay in it as documentation of what the list is for.
- **The 512-byte limit cannot bite.** B1 asks for at most 128 code points *and* at most 512 UTF-8 bytes. 128 code
  points are at most 512 bytes, so the byte check is a bound that the code-point check already implies. It is
  implemented and tested anyway, because it is the limit that has to move first if the code-point maximum ever rises.
- **`loadWebConfig` returns only the web settings.** B6 says `loadConfig` and the worker are unchanged and that
  `trustedProxyHops` keeps coming from `loadConfig`, so `loadWebConfig` is a second, independent loader returning
  `WebConfig` rather than an extended `AppConfig`; the web calls both. It also returns `publicOrigin` beside
  `publicBaseUrl`, since C2 step 2 compares the request `Origin` against the origin while the export `review_url`
  needs the full base URL. Error codes: `PRODUCTION_WEB_CONFIG_INVALID` for a production config missing the tenant or
  the https base URL, `INVALID_WEB_TENANT_ID` and `INVALID_PUBLIC_BASE_URL` for a malformed value in any environment.

**C3 (`withTenant`, `audit.ts`, `PostgresUserStore`, DB integration tests)**

- **Argument shapes that carry an audit context.** B5 lists `recordLoginFailure(userId, max=10, lockMinutes=15,
  audit)`, but a required argument cannot follow defaulted ones in TypeScript, and the audit row needs the failure's
  `reason` as well (§5 C3.7 writes `login.failed {reason}`). The store therefore takes
  `recordLoginFailure(userId, { reason, audit, max?, lockMinutes? })`, and the other multi-argument methods follow the
  same input-object shape. The defaults are unchanged and exported as `LOGIN_MAX_FAILURES` / `LOGIN_LOCK_MINUTES`.
- **Which method writes `login.succeeded`.** B5 gives `recordLoginSuccess(userId, rehash?)` no audit argument and
  `createSession(…, audit)` one, so `createSession` writes the row: it is the only one that knows the session id, and
  `audit_events.session_id` is the column that joins a login to everything that session later did.
  **`CreateSessionInput.auditLogin: false` opts out** (added after review): a password change also opens a session, and
  §5 C5 makes its outcome `password.changed` alone. Without the opt-out every change wrote a second `login.succeeded`
  row — and a `login_succeeded` stdout line — for a login that never happened, while
  `auth_logins_total{result="success"}` correctly did not move, so §13's audit query and the metric disagreed.
- **`resolveSession` also selects `s.created_at`.** §5 C5 lets a forced-change session omit `currentPassword` within
  5 minutes of `auth_sessions.created_at`, which the C4 query does not return. Adding the column keeps it one query
  per request instead of a second round trip on every password change.
- **`revokeSession` audits a logout only, and takes a `requestId` rather than a whole audit context.** The action
  list in §6 has `session.logout` and no other session verb, and the `relogin`, `password_changed`, `admin_reset` and
  `disabled` revocations already ride along with the action that caused them (`login.succeeded`, `password.changed`,
  `user.password_reset`, `user.updated`). The revoking UPDATE already returns `id, user_id`, so the actor of a logout
  is the session's own user and the method returns it; after review the route stopped calling `resolveSession` first
  (one transaction and one pool checkout instead of two on the only route that touches the database with no session,
  no CSRF token and no throttle).
- **`PostgresUserStore.run` applies B3's timeouts.** `tenant.ts` says the timeouts exist "for the export cursor … and
  for the auth queries, which must never hold a connection open behind a stalled client", but the store passed none.
  Every auth query now runs with `statement_timeout = 5 s` and `idle_in_transaction_session_timeout = 10 s`; each is
  one small indexed statement, and the only wait that queues is the last-admin guard's row lock, which queues behind
  another request rather than behind a human.
- **`CANNOT_CHANGE_SELF` is not enforced in the store.** B5 puts only the last-admin guard inside the transaction, and
  §5 C6 describes the self-guards in terms of the caller's own id, which the route holds; the store keeps
  `LAST_ADMIN`, `USER_NOT_FOUND` and `USERNAME_TAKEN`. The admins are locked with `ORDER BY id` so two concurrent
  demotions take the rows in the same order and queue instead of deadlocking (covered by a two-transaction test).
- **`insertAudit` requires a UUID `requestId`.** B4 says it "rejects a `requestId` it did not receive from the request
  context". The machine-checkable form of that is the shape of the server-minted `trace_id`: the echoed
  `X-Request-Id` matches `[A-Za-z0-9._:-]{1,128}` (`packages/observability/src/index.ts:31-34`), so anything that is
  not a UUID is refused with `AUDIT_REQUEST_ID_INVALID`. `auditDetailJson` also refuses a detail key containing
  `pass`, `token`, `cookie`, `secret`, `authorization`, `csrf` or `credential`, mirroring the `logEvent` key filter,
  so the "never a password or a token" rule is enforced and not merely documented.
- **The `access.denied` budget is a class, not a singleton.** B4 fixes it at 5 rows per session per minute;
  `audit.ts` exports `AuditRateLimiter` (with `ACCESS_DENIED_AUDIT_LIMIT` / `ACCESS_DENIED_AUDIT_WINDOW_MS` as its
  defaults) and C4 owns the one instance, next to the other per-process windows in `apps/ocr-web/src/auth.ts`.
- **`isUuid` moved to `tenant.ts`.** `audit.ts` and `users.ts` need it, and importing it from `index.ts` would make
  the barrel import its own re-exports. It is still exported from the barrel, so every existing import and
  `index.test.ts:72` are unchanged.

**C4 (the server auth flow: `auth.ts`, `auth-routes.ts`, `server.ts` and `auth.test.ts`)**

- **Where the unknown-name budget sits.** C3 numbers the steps "acquire `loginGate` (4) → `findLoginUser` (5) →
  `verifyPassword` (6)", but B1 requires the budget to sit **in front of** the gate, and whether a name is unknown is
  only knowable after the lookup. The order implemented is: throttle pre-check → `findLoginUser` → budget → one
  `loginGate.run` covering the verify **and** the optional rehash. The gate therefore never holds a database query,
  which B1 also asks for, and one acquisition serves a login that rehashes.
- **The windows are spent before the hash, not after the answer** (fixed after review). C3 step 7 counts the failure,
  which read as "count it when you answer" — and the answer is ~250 ms of scrypt later, so every attempt that arrived
  in that window read a zero counter: one name bought the gate's whole in-flight capacity (2 running + 16 queued)
  instead of D5.2's 10. `countUsername` now runs in the **same synchronous step as the `retryAfter` pre-check**, so the
  limit is exact, and `countUnknown` runs before the gate, so a `LOGIN_BUSY` on a made-up name counts against D5.3 too.
  The failure path no longer counts them a second time; step 9's `resetUsername` still clears the window, so a staff
  member who finally types the right password is unaffected.
- **`PASSWORD_EXPIRED` counts toward the in-memory windows** (fixed after review). C3 step 8 says it "does not count
  as a failure", which the database counter still honours — the account is never locked by it. But the branch is
  reached only **after** a correct password, and D6 deliberately leaves a consumed temporary password in the row: the
  credential that is read out loud, photographed or pasted into chat would otherwise buy an unlimited number of 32 MiB
  hashes. It is counted on the username window (spent on entry) and on the per-IP window.
- **The `access.denied` budget is keyed on the user, not the session.** B4 says "5 rows per session per minute", but
  nothing limits how many sessions one account may open, so a re-login handed out a fresh budget and B4's actual
  promise — that a staff account cannot flood a table nothing may delete from — did not hold. The session id is still
  written into the row; only the key changed. It also bounds `AuditRateLimiter`'s key set by the number of accounts
  rather than the number of logins.
- **`WebAuthContext` at the seam.** C5's five-minute forced-change window needs `auth_sessions.created_at` and
  `GET /api/auth/session` needs `expires_at`; C3's `resolveSession` already returns both. Rather than a second query
  per request, `apps/ocr-web/src/auth.ts` extends B2's `AuthContext` with two optional fields (`sessionCreatedAt`,
  `sessionExpiresAt`). `AppServerOptions.authenticate` accepts a plain `AuthContext`, so the test seam is unchanged.
- **`respond`, `respondNoContent` and `readJson` live in `auth.ts`.** §11 lists only the guards there, but
  `auth-routes.ts` and `server.ts` both need them and importing them from `server.ts` would make the two modules
  circular.
- **`PASSWORD_UNCHANGED` (400).** C5 requires the new password to differ from the current one but names no code; the
  C8 table's default rule makes any unlisted SCREAMING_SNAKE code a 400. The three password checks (current password,
  unchanged password, new hash) share **one** `adminGate.run`: three acquisitions would push two concurrent changes
  past the gate's queue of 4.
- **Route-level `LAST_ADMIN` is unreachable and is tested through `errorStatus` only.** With C6's
  `CANNOT_CHANGE_SELF` in force, an acting admin can only demote or disable *another* admin, and then at least two
  active admins exist by definition. The guard stays in the store, where a concurrent demotion and the E1 CLI meet it
  (covered by C3's two-transaction DB test); the server test asserts the 409 mapping.
- **`unlock` reads the user list to learn the username.** C7 says the route clears the in-memory username window, but
  `unlockUser(userId, audit)` returns nothing and that window is keyed by name. The route calls `listUsers()` (the
  users table is tiny, §6) to find the row first, which also produces the 404 for an unknown id.
- **`login_ip_throttle_disabled` is logged only when a user store is configured.** C11 says "once at startup";
  `createAppServer` also runs in every test, and the warning is about the login defence, so it is skipped when no
  login is possible.
- **`GET /api/web-token` answers 401 without a session.** C1 says it "falls through to 404"; that holds once the
  request authenticates, because C2.4 requires a session on every `/api` route except login and logout. §12's case is
  asserted with a session. **E4's credential-free check therefore expects 401, not the 404 the plan's bullet names**
  (fixed after review): the route is gone either way, and answering 404 to an anonymous probe would put back the
  route-existence oracle C2.4 removes. `test/deploy-scripts.test.ts` pins the 401.
- **A `canExport` staff user gets 404, not 200, on the export routes.** §12 wants 200 there; workstream H is Deploy B,
  so in Deploy A `/api/exports/*` exists only as the permission gate. The user passes the gate and falls through to
  `404 {status:'not_found'}`, which is what `auth.test.ts` asserts; C10 raises it to 200 when the handlers ship. This
  is the same deferral as the `ส่งออก` note under C6.
- **`AppServerOptions` gains `webConfig`, `loginThrottle` and `clock`.** C2 names only `authenticate`; the throttle
  cases need to drive the sliding windows with injected limits and the session cases need to move time, and production
  passes the same `webConfig` it built for `PostgresUserStore`. `createAppServer` builds the session authenticator
  itself when a `userStore` is present rather than receiving one (C12), since both need the same `env` and
  `sessionIdleMinutes`.
- **`documents_read_total` (§13) and the `logEvent` key filter (§6) landed here**, not in C5: each is one line at a
  call site C4 already rewrites.
- **`server.test.ts` proves same-origin with `Sec-Fetch-Site`, not `Origin`.** §12 asks the helper to add `Origin`,
  but the file's shared header objects are built before a port is known. `Sec-Fetch-Site: same-origin` is the branch
  C2.2 defines for a request with no `Origin`, and a browser cannot forge it; `auth.test.ts` covers the `Origin` form,
  including a sibling `*.innoveraappcenter.com` origin.

**C5 (attribution and audit plumbing in the stores, runtime and server)**

- **`audit` is optional on four of the five actions, required on the fifth.** §6 makes only `saveCorrection` throw
  (`CORRECTION_AUDIT_REQUIRED`), because only it had a default to remove. `createUploadedDocument`, `createBatch`,
  `saveReview` and `retryDocument` therefore take an optional `AuditContext` and write their row when they are given
  one. Requiring it would force an actor on every existing DB-test call site and on
  `scripts/runtime-hardening-check.ts`, and `audit_events`' composite FK means that actor must be a real user of the
  tenant. What guarantees the rows in production is the server: `server.test.ts` asserts that all five routes pass
  `ctx.userId`, `ctx.sessionId` and the request's own trace id.
- **`CorrectionAudit` carries the context.** §6 says "an explicit audit" without naming a shape. `CorrectionAudit`
  keeps `raw` and `verifiedBy` and gains `audit?: AuditContext`, which writes `document.field_confirmed {field}`.
  `CORRECTION_AUDIT_REQUIRED` is thrown for a PENDING call with no `CorrectionAudit` at all, before the pool is
  touched, so a caller that forgot the actor never opens a transaction.
- **`document.uploaded` only on the path that creates a document.** §6 says "for new documents only": both reuse
  paths (a replay into a full batch, and the idempotency-key conflict) return an existing document whose own upload
  was recorded when it was created, and write nothing.
- **Two new stdout events, `batch_created` and `document_field_confirmed`.** §6 requires every audit row to be
  mirrored to stdout, but its "New events" list names only the auth ones; upload, review and retry already log.
  The confirm event carries the field name, never the value, exactly like the audit row.
- **`labels.ts` ships in C5 with the reviewer label only.** §11 lists it among the export files; the drawer (F) needs
  `LEGACY_REVIEWER_LABEL` first, and C9 adds the export's Thai labels to it. The fallback itself stays with the
  readers: the store returns `reviewedByName: null`, so the API keeps saying "this actor matches no user" instead of
  baking a Thai string into its JSON, and `reviewerLabel()` is the one place that turns that into the label.
- **The attribution test lives in `server.test.ts`.** §12 lists it under `auth.test.ts`, but the five actions need the
  ingest, review-store and OCR-client fakes that only `workbenchHarness` has, and the same file already holds the
  `reviewedBy` spoofing case §12 says to keep. `auth.test.ts` proves the other half — that the user id and session id
  reaching the store come from a live session — next to C4's forged `X-Request-Id` case.

**C6 (the workbench: login dialog, session handling, password and users screens, tests)**

- **`X-OCR-Background` is a counter around the call, not a parameter.** F2 says `api()` adds the header "for calls made
  by `tick()`", but `loadDocuments`, `loadBatch` and `pollDrawer` are each called from both polling and user actions.
  `background(fn)` raises `state.bg` while `fn` starts its fetches — every one of them reaches `fetch` synchronously —
  so `tick()` marks exactly its own three calls and nothing threads a flag through five signatures. A call retried
  after a login is a user action and correctly loses the header.
- **The auth routes do not go through `api()`.** `GET /api/auth/session`, `POST /api/auth/login`, `/api/auth/password`
  and `/api/auth/logout` use one small `authCall` helper instead. F2 only says `api()` opens the overlay "on 401 from
  any non-auth route"; routing the auth routes through it as well would mean a wrong password reopens the login
  dialog on top of the login dialog, and the password dialog's `PASSWORD_INCORRECT` (a 400 by design, §5 C5) would be
  the only refusal it could report.
- **`restoreAfterLogin` skips the list when one is already in flight.** F2 wants the rows and the drawer "re-rendered
  from a fresh load" after a same-user login, and `api()` separately retries the call that hit the 401. When the 401
  came from `loadDocuments` itself, both would fetch the same list and the seq guard would discard one. The restore
  therefore reloads only when `state.listAbort` is null, which is precisely "no waiter is going to do it", and §12's
  "retried exactly once" is asserted as two list fetches in total.
- **A forced password change blocks startup, and `restoreAfterLogin` waits for it.** F2's `init()` puts the forced
  change at step 3, before the loads — and it has to, because with `mustChangePassword` set every other route answers
  403 `PASSWORD_CHANGE_REQUIRED` (§5 C2.6). `init()` awaits the dialog; a mid-session re-login that comes back with
  the flag opens it and defers the restore to the successful change instead of loading into a 403.
- **The 5-minute grace window is inferred, not computed.** F1 hides the current-password field "when C5's 5-minute
  forced-change window applies", but the session payload carries `expiresAt`, not `auth_sessions.created_at`, so the
  client cannot compute it. A forced change opens seconds after the login, so the field starts hidden; if the server
  answers 400 `PASSWORD_INCORRECT` (the window has passed while the dialog sat open), the field appears with
  `หน้านี้เปิดค้างไว้นานเกินไป กรุณากรอกรหัสผ่านปัจจุบันอีกครั้ง` instead of dead-ending.
- **Two new upload states, `authwait` and `cancelled`.** F2 asks for `รอเข้าสู่ระบบ` and `ยกเลิก (เปลี่ยนผู้ใช้)`, which
  the existing five-state vocabulary (`waiting`/`uploading`/`done`/`failed`/`rejected`) cannot express without lying
  to `pump()` (a `waiting` row would be picked up again) or to the retry button (a `failed` row offers one). Both are
  counted in the upload summary, and `beforeunload` and the logout confirmation treat `authwait` like `waiting`.
- **The collapsed pill's name sits in its own `.me-name` span, and `#conn-text` is visually hidden at ≤720px**
  (fixed after review). F1 collapses four controls into one pill, but the pill carried the display name as its own
  text and `.btn` is `white-space:nowrap`, so at 375px a normal Thai name pushed the 56px header past the viewport and
  gave the whole page a horizontal scrollbar — which is exactly what the collapse and §12's manual check exist to
  prevent. `text-overflow` does not apply to a flex container's anonymous text, so the name moved into
  `<span id="me-open-name" class="me-name">`, which the ≤720px block caps at `min(30vw,120px)`; the connection chip
  shrinks to its dot with `#conn-text` taken out of the flow (not `display:none`, so `role="status"` still announces
  the state, and the chip keeps its `title`).
- **`.m-card` gets `min-width:0`** (fixed after review). The users dialog is a grid item whose automatic minimum size
  is the min-content of the nowrap users table, so `width:min(1060px,100%)` never bound it: the card rendered about
  1025px wide at a 375px viewport and `.x-scroll` never became a scroll container, leaving the admin to pan the whole
  dialog sideways to reach the heading, the close button and every form field.
- **`restoreAfterLogin` repairs the drawer head itself** (fixed after review). F2 says the drawer is "re-rendered from
  a fresh load" after a same-user login, and `clearPhi()` blanks `#d-title` and `#d-draft` — but `loadReview()`, the
  only caller of `applyDocument()`, returns early while `state.dirty` is set, which is precisely the headline case.
  The restore therefore sets `#d-title` from `titleOf(state.current)`, re-runs `pageLink()` (it also reset
  `state.pdfView`) and re-renders the draft indicator before the load.
- **The `≤720px` header collapse is driven by `matchMedia`, not by CSS alone.** §12 asks for a test that at phone
  width the header renders one `#me-open` pill "and no separate action pills", which no CSS rule can prove in the
  fake DOM. `showMenu()` sets `hidden` on `#me` and `#me-open` from `window.matchMedia('(max-width: 720px)')` (and on
  `resize`), so the DOM states it; the `body[data-auth]` rules stay in CSS.
- **`ส่งออก` is not part of the staff-permissions case.** §12 wants "staff see no `#users-open` or `ส่งออก`", but
  workstream H is Deploy B and this commit adds no export control. The case asserts `#users-open` and `#me-users` are
  hidden for staff and visible for an admin; C11 extends it when the export button exists.
- **`LEGACY_REVIEWER` is a copy inside the inline script.** The script is a string that runs in the browser under a
  CSP nonce and cannot import a module, so it carries its own constant, as §12's "the Thai labels equal the workbench
  copies" already assumes. `workbench.test.ts` pins that copy to `LEGACY_REVIEWER_LABEL` from
  `@innovera/ocr-persistence`, so the two cannot drift.
- **`workbench.test.ts:36` became two rules, not three.** §12 asks for (a) no `token` in any `<input>` attribute,
  (b) every password input typed and autocompleted, (c) inside a `method="post"` form. (b) and (c) are asserted per
  input in one case (a password input outside a form is a property of that input), and the banned-text rule
  (`Authorization`, `Bearer`, `/api/web-token`, `HS256`, `createHmac`, `AUTH_JWT`, `jwtSecrets`, `subtle.sign`) moved
  into the case that already owned the storage and cookie bans.
- **Three cases were added after review**: the drawer head after a same-user login with a dirty draft (the head, the
  `หน้า 12/95` page label and the parent-PDF button, none of which §12's headline case looked at); one tick asserting
  that **every** call it makes carries `X-OCR-Background: 1` while the same function called by hand carries none (the
  only check was a static needle, and the whole mechanism rests on those three loads reaching `fetch` synchronously);
  and a static case pinning the phone-width rules above, since the fake DOM has no layout to measure.
- **`load()`'s fakes.** Beyond §12's list (`replace`, `showModal`/`close`/`open`, `value`/`checked`, form submit,
  `headers.get`, a controllable clock) the harness also records each fetch's headers and body, each XHR's headers and
  `abort()`, and can make one upload hang — without which "no request is sent after B's login", "the same
  `Idempotency-Key`", "the new `X-CSRF-Token`" and "the XHR is aborted" cannot be observed at all.

**C7 (the users CLI, `ocr-users.sh`, `auth-smoke.sh`, the e2e login, compose, preflight, alerts and the docs)**

- **`reset-password` gains an audit detail on the store, not a second audit row.** E1 wants
  `user.password_reset {via:'cli'}`, but C3's `resetPassword(userId, hash, audit)` writes that row itself with no
  detail. `PostgresUserStore.resetPassword` therefore takes an optional fourth argument, `detail?: AuditDetail`,
  which only the CLI passes. The alternative — letting the CLI append a second `user.password_reset` row — would
  double every reset in `SELECT action, count(*) FROM audit_events`, the query §13 gives the operator. `UserStore`
  (the server's interface) is unchanged, so no route is affected; the DB case in `batch.db.test.ts` now asserts the
  detail.
- **The CLI's break-glass password is still a must-change password.** E1 says `reset-password` "sets the typed
  password, clears the lock and revokes the user's sessions", and the store method that does all three also sets
  `must_change_password` and a 72-hour expiry (D6). The CLI reuses it as-is and prints the consequence in Thai,
  rather than growing a second reset path: a password read out over the phone during an emergency should not outlive
  the emergency. `create-admin` is the opposite case and passes `temporary: false`, exactly as E1 requires.
- **`create-admin` writes two audit rows.** `user.created` comes from the shared `createUser` (it is what every
  account creation records) and `user.bootstrap` is appended by the CLI, as E1 asks. Both carry
  `actor_user_id = NULL`, which `audit.ts` documents as the CLI's own case, and a live run against a throwaway
  database confirms the composite FK and the RLS policies accept it.
- **`--username` / `--display-name` are the only flags, and anything else is a usage error (exit 2).** E1 says
  "unknown flags are rejected" but names no code; 2 is what `TTY_REQUIRED` already uses, so a misuse and a
  non-terminal both exit 2 while a real failure exits 1. `deploy/ocr-users.sh` cannot preserve that: `pnpm run`
  collapses a non-zero child status to 1 (`ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL`). The message the operator reads is
  the CLI's own and is unaffected.
- **The e2e script keeps the login answer out of shell variables entirely.** E3 says the CSRF token is "parsed from
  the login JSON and written straight into" the header file. The login response is therefore piped
  `curl → python3 → $hdr`; it is never assigned, so no later `echo`, `set -x` or error path can print it. The script
  also refuses to run on curl < 7.55 instead of carrying the `-K "$cfg"` fallback E3 offers, because a fallback that
  is never exercised is the one that leaks the token.
- **`auth-smoke.sh` prints nine checks, not eight.** E4's list ends with "`GET /` gives 200 with a
  `content-security-policy` header", which is two different failures (a 500 page, and a page with no CSP), so it is
  two lines in the output. The set of requests is exactly E4's.
- **A3's design-doc renumbering is done in this branch** (after review). `design-2026-09-22.md` now names
  `0021_cancel_queue_visibility` (§4.3) and `0022_document_template` (§5/§6, and the phase summaries), so the repo
  does not contradict itself about which migration 0019 and 0020 are while 0019 is being frozen. §14 also lists
  "design-doc renumbering" under C11; nothing is left for C11 to renumber unless a schema fix shifts the numbers
  again (A3 says how).
- **The dev quickstart in `deploy/README.md` names a local env file.** E5b's stack cannot be started by the commands
  as they were written: every `${VAR:?}` in `deploy/docker-compose.yml` (`POSTGRES_BOOTSTRAP_PASSWORD`, the
  `DATABASE_URL_*` DSNs, `AUTH_JWT_*`, `OCR_WEB_TENANT_ID`) has to resolve before compose will read the file at all,
  and `ocr-users.sh` defaults to `--env-file /etc/innovera/ocr-compose.env`, which no developer machine has. The
  block now builds one `docker compose --env-file deploy/dev.env -f … -f …` prefix and calls the wrapper with
  `OCR_COMPOSE_ENV=deploy/dev.env`. `ocr-users.sh` itself is unchanged (it matches E2), and deploy/dev.env is git-ignored.
- **`deploy/README.md:15` still names 0018 as the worker gate.** E6 asks for ":15 for the 0020 worker gate", but
  `REQUIRED_SCHEMA_VERSION` only moves to `0020_batch_round_clock` in C8 (G2), and Deploy A leaves the worker alone.
  The sentence names 0018 as today's gate and says Deploy B raises it to 0020, so the README is true at every commit
  between here and C8.
- **`production-preflight.sh` grew a `WARN` count.** E6 asks for two warnings, and `check` can only pass or fail.
  `warn_if` prints `WARN <name>`, counts separately and never changes the exit code; the summary line is now
  `SUMMARY PASS=n FAIL=n WARN=n`. The two warnings are E6's, plus `web:public-https` as a real check (the session
  cookie is only as good as the origin it is bound to, and `loadWebConfig` refuses a non-https origin in production
  anyway — failing here explains it before the container does).
- **`release2-deploy.md` covers Deploy A only.** §14 lists the file under C11 as well; this commit writes the Deploy A
  runbook, the rollback and a short "a staff member cannot log in" section, and C11 appends Deploy B.
- **The env example lists the new keys with empty values.** E6 says "key names only, no values", so
  `OCR_PUBLIC_BASE_URL` is empty there even though compose carries the same origin as a default: an example file that
  is copied blindly should fail the preflight rather than point a session cookie at someone else's origin.
- **`test/deploy-scripts.test.ts` is a new file.** §12 asks for "a static test that `deploy/e2e-production.sh`
  contains no `-H "X-CSRF-Token: $` and no `Authorization: Bearer`" without saying where it lives. It sits next to
  the other static tests and also pins the rest of C7's deploy surface (the credential-free smoke script, the CLI's
  refusal of password flags and files, the compose keys, the preflight checks and the alert rules). Its
  forbidden-text assertions run against comment-stripped sources, exactly as `test/batch-migration.test.ts:8` does
  for SQL, because these files explain in prose why they take no password.

**C8 (0020, the batch clock in the store, the worker gate, the strip, and the `can_export` check)**

- **The reported `can_export` lock-out does not reproduce, so C8 pins the behaviour instead of changing it.** The
  report was that `create-admin` writes `can_export = false` (`cli/users.ts:205`) while the user-update guard refuses
  your own flags, leaving production's only admin unable to export. Neither half holds in the shipped code:
  `hasRight` is `right === "admin" ? ctx.role === "admin" : ctx.role === "admin" || ctx.canExport`
  (`apps/ocr-web/src/auth.ts:237-239`), which is exactly D8's table — the admin row is ✓ for export — and the route
  guard refuses only your own `role` and your own `disabled` (`auth-routes.ts:322`), never `canExport`. So the first
  admin of a fresh tenant reaches `/api/exports/*` on the role alone **and** may still turn the flag on for itself.
  The smallest correct fix is therefore no code change but a regression test: `auth.test.ts` now signs in the
  bootstrap admin (`can_export = false`, as the CLI writes it), asserts all three export routes answer 404 rather
  than 403 — past the gate, handlers still to come in C10 — and then grants the flag to itself through
  `POST /api/users/:id`. An `ocr-users grant-export` subcommand would have added a break-glass path for a lock-out
  that cannot happen, and "admin implies export" is already D8's wording. The CLI comment now names D8 and
  `hasRight` so the next reader does not re-derive this.
- **`BatchSummary` gains three fields, so the whole-object pin in `batch.db.test.ts` had to list them.** G4 adds
  `roundOpenedAt`, `roundStartedAt` and `roundCompleted`; the create/get/list case compares the entire summary with
  `deepEqual`, so it now spells out `null, null, 0` — which is the same statement §12 asks for elsewhere, that a
  never-retried batch is unchanged. `index.test.ts:130` is untouched.
- **`throughputPerMinute`'s own guard moved with the counter.** G4 says the throughput counter is `round_completed`
  while a round is open. The guard `completed > 0` became `counted > 0`, so a reopened round that has claimed a row
  but finished none shows `—` instead of a rate derived from the previous round's completions.
- **The worker-gate test changed every name in the case, not only the pinned constant.** §12 pins
  `index.test.ts:211`; the surrounding case also asserted the `SCHEMA_NOT_READY` message and the query parameter
  against 0018. All three now read `0020_batch_round_clock`, and the "older schema" branch passes
  `0018 + 0019` — what production runs between Deploy A and Deploy B, which is the state the gate exists for.
- **`deploy/README.md` is updated here, as C7's deviation promised.** E6 asked for ":15 for the 0020 worker gate";
  C7 left it naming 0018 because the gate only moves now. The gate sentence names `0020_batch_round_clock`; the
  deploy-order sentence above it **lost** its migration number instead of gaining a new one, because it describes the
  shape of a deploy ("the web migrates, then the worker"), not which migration is current.
- **Where the two new grant checks are asserted.** A2 adds `app:update-batch-round` and `app:no-update-batch-label`
  to the A2 list, so both names join the list in `test/user-auth-migration.test.ts` — that is what keeps
  `lines.length === checks.length` meaning "every check is a `check_sql` line". Their exact SQL is pinned in the new
  `test/batch-round-migration.test.ts`, next to the migration that grants them, and the DB suite proves the grant
  itself (`ocr_app` may write `round_opened_at`, may not write `label`, and `ocr_worker` may write neither).

**C9 (the export data layer: `export.ts`, `documentFilterSql`, `openExport`/`previewExport` and their tests)**

- **`flattenDocument` returns typed values, and the display rules sit beside it.** H3 names `flattenExportRow(row, set,
  …)`; the function is `flattenDocument` (design §3.4 and the C9 brief) and it returns one **typed** value per column —
  numbers stay numbers, a `datetime` stays the ISO UTC instant — because the same flattening has to serve three
  readers whose rules differ: the CSV renders Bangkok wall-clock and truncates at 32,000 characters, JSONL must keep
  the instant and must **not** truncate (H5), and the preview must show the CSV's strings exactly. `formatCell` and
  `exportCells` hold those display rules, so the file and the preview cannot drift, and the JSONL writer in C10 can
  emit `values` as they are. Truncation and the formula guard therefore never touch JSONL, which is the H5 rule.
- **`export.ts` takes an `ExportDocument`, not a pg row.** H3 puts the flattening in a pure module; the row mapper
  (`toExportDocument`) stays in `index.ts` next to `toListItem`, so `export.ts` imports no driver type and every cell
  rule — the `" (?)"` fallback, the joined lists, the five-and-up treatments, the detailed columns — is a unit test
  with no database. It also keeps the import direction one-way: `export.ts` never imports its own barrel.
- **`openExport` resolves to an `ExportCursor`, rather than a generator whose first step is the count.** H5 step 1
  says to await the count before `writeHead` and step 2 to audit the total before it. `await store.openExport(…)`
  does exactly that: it throws `EXPORT_TOO_LARGE` (a clean 400) before a byte, and hands back `{ total, rows(),
  close() }`, so `total` is a plain field for the `export.started` row and `X-Export-Rows`. `rows()` is the async
  generator H4 describes and its `finally` calls `close()`, which is what runs on `generator.return()` when the
  browser disconnects.
- **A refused export closes without a `CLOSE`.** H4 step 5 closes the cursor, commits and releases. When the row-count
  pre-check refuses the export no cursor was ever declared, so `CLOSE export_cur` would raise 34000, mark the client
  broken and destroy a healthy pooled connection on **every** `EXPORT_TOO_LARGE`. `close()` therefore only closes a
  cursor it declared; the transaction still ends and the client goes back to the pool.
- **The 2-exports-per-process cap lives in the store.** §3.3 and H5 both name it, and H5 puts `ExportGate` (per user,
  plus the 10-minute wall clock) in the web. The reason for the cap is that each open export pins a pooled
  connection, which only the store knows, so `MAX_CONCURRENT_EXPORTS` is enforced in `openExport` (`EXPORT_BUSY`) and
  C10's gate adds the per-user limit and the clock on top.
- **`documentFilterSql(tenantId, filter, params)` owns the tenant clause.** H2 extracts the list's WHERE builder; it
  takes the tenant as its first argument and pushes `$1` itself, so no caller can build a filter without the
  organization predicate, and `VISIBLE_SQL` is in every call. `ListDocumentsQuery` is now `DocumentFilter & {limit,
  offset}`: one filter shape for the list and the export. The list's existing error codes are unchanged
  (`INVALID_QUERY`, `BATCH_NOT_FOUND`, `DOCUMENT_NOT_FOUND`); a malformed or inverted date range and an unknown
  `dateField` raise `INVALID_EXPORT_FILTER` **in the store as well** as in C10's parser, because those values reach a
  `::date` cast and a pg error there would be a 500 quoting the input.
- **The shared Thai vocabulary moved into `labels.ts`, and its parity test into `workbench.test.ts`.**
  `DocumentStatusCategory`, `DeliveryStatus` and `DOCUMENT_STATUS_CATEGORIES` moved there from `index.ts` (the barrel
  still re-exports them, so no import anywhere changed) so the pure export module can read the category and delivery
  labels without importing the barrel. §12 puts "the Thai labels equal the workbench copies" in `export.test.ts`;
  the assertion is in `workbench.test.ts` instead, beside the identical `LEGACY_REVIEWER` pin and where the inline
  script is already parsed — it is the workbench's copies of `CATEGORY`, `DELIVERY` and `LABEL` that are being pinned.
- **`reviewed_by`, `total_minutes` and the `" (?)"` marker.** The reviewer falls back to the latest
  `ocr_corrections.verified_by` through a `LEFT JOIN LATERAL` (H3's "or else … for legacy field confirmations"), and
  the cell is empty unless the row is confirmed. `total_minutes` is v3.1's `staffOnly.totalMinutes` and nothing else:
  no sum is invented for older rows, which would be a number no one wrote. The `" (?)"` marker is applied to any
  still-flagged reading, not only to one with no value — H3's "items still flagged get `" (?)"`" read the other way
  would export an unreviewed guess as if it were confirmed. A confirmed row carries no flags (`markReviewed`).
- **Read-only proof of the download's own transaction.** §12 asks for "an INSERT inside the export transaction fails
  with 25006". `previewExport` runs through `withTenant(readOnly)`, which the DB suite already proves; the
  download's own `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` plus both `set_config` timeouts are asserted
  verbatim in the `index.test.ts` unit case, together with the cursor, the `FETCH` pages, `CLOSE`/`COMMIT`, the
  release of the client, and a client `'error'` event that rejects the export instead of ending the process.
- **`createDatabasePool` takes an optional `onError` (D10).** H4 asks for `pool.on('error')`; the handler is always
  attached — an unhandled `'error'` is fatal in Node — and the callback is optional so the worker and the CLI are
  unchanged. The web passes its logger when the export routes land in C10.
