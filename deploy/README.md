# Local Docker stack

This stack starts PostgreSQL 17, ClamAV, the authenticated web service, and the OCR worker. The worker contacts the configured OCR gateway; use non-production credentials for local validation.

```sh
docker compose -f deploy/docker-compose.yml up --build
```

The base compose file is the production shape: `OCR_ENV=production`, an https `OCR_PUBLIC_BASE_URL` and a required
`OCR_WEB_TENANT_ID`. Every `${VAR:?}` in it must resolve before compose will read the file at all, so a dev machine
needs a local env file first: copy `deploy/production.env.example` to `deploy/dev.env` (git-ignored), add
`POSTGRES_BOOTSTRAP_PASSWORD` (the example does not list it) and fill in local values for the `DATABASE_URL_*` DSNs,
`AUTH_JWT_*` (reserved, any non-empty value) and `OCR_WEB_TENANT_ID=00000000-0000-4000-8000-000000000001` — the id
`deploy/sql/seed-dev-tenant.sql` inserts. Then add the dev override and seed the tenant row once on a fresh database
(never on production, which already has its row):

```sh
D="docker compose --env-file deploy/dev.env -f deploy/docker-compose.yml -f deploy/docker-compose.dev.yml"
$D up --build
$D exec -T postgres psql -U ocr_bootstrap -d innovera_ocr -v ON_ERROR_STOP=1 -f - < deploy/sql/seed-dev-tenant.sql
# ocr-users.sh loads the base compose file and /etc/innovera/ocr-compose.env unless OCR_COMPOSE_ENV says otherwise;
# `exec` runs inside the container the override already started, so the dev settings still apply.
OCR_COMPOSE_ENV=deploy/dev.env ./deploy/ocr-users.sh create-admin   # then open http://127.0.0.1:53100 and log in
```

The web health endpoint is available at `http://127.0.0.1:53100/health/live`. PostgreSQL is bound to `127.0.0.1:55432`; ClamAV is internal-only. OCR integration reads `OCR_API_BASE_URL` (default `https://ai.innoveraappcenter.com/ocr`), `OCR_REQUEST_TIMEOUT` (seconds, default `300`) and `OCR_MAX_RETRIES` (default `3`). The worker image includes poppler-utils: a PDF upload is split into one page image and one row per page (`OCR_MAX_PDF_PAGES`, default `300`, at most `1000`; `OCR_PAGE_FORMAT` `png` (default; the only format validated against the real scans) or `jpeg`), rendered in `${OCR_STORAGE_ROOT}/tmp` and stored next to the originals (a scanned page keeps its own pixels: about 1.4 MB per PNG page for the 1400 px real scans; at most 1610 px). Deploy order: stop the old worker, deploy the web (it applies the migrations at startup), then the worker — the new worker refuses to start (`SCHEMA_NOT_READY`) until the migration it needs is applied. Stop and remove local containers with:

```sh
docker compose -f deploy/docker-compose.yml down
```

The web entrypoint runs the idempotent, checksum-verified migrations in `prisma/migrations`; the worker verifies database readiness and that the newest migration it needs (`0020_batch_round_clock`, raised from `0018_multipage_documents` by Deploy B of Release 2) is recorded in `schema_migrations` before accepting work; otherwise it exits and Docker restarts it. The compose file does not run destructive migrations outside that runner; the migration role must have permission to apply them.

Runtime credentials are injected, never stored in compose: `POSTGRES_MIGRATOR_PASSWORD`, `DATABASE_URL_MIGRATOR`, `DATABASE_URL_APP`, `DATABASE_URL_WORKER`, `DATABASE_URL_QUEUE`, `AUTH_JWT_SECRETS`, `AUTH_JWT_ISSUER`, and `AUTH_JWT_AUDIENCE`. Provision the four login roles (`ocr_migrator`, `ocr_app`, `ocr_worker`, `ocr_queue`) separately before starting the application.

Production also requires `AUTH_JWT_SECRETS`, `AUTH_JWT_ISSUER`, and `AUTH_JWT_AUDIENCE`, and startup fails if they are missing. **Since Release 2 they are reserved, not used for browser authentication:** the workbench authenticates with a `__Host-` session cookie and no route verifies `Authorization: Bearer` any more. Rotating `AUTH_JWT_SECRETS` therefore costs nothing and closes every token minted before the release — replace the line in the host env file in one step (see `../docs/operations/real-data/release2-deploy.md`) rather than running the old two-key overlap. Never print the values or put them in compose files.

Release 2 web keys, names only (values live in the host env file): `OCR_WEB_TENANT_ID` (required), `OCR_PUBLIC_BASE_URL` (the public https origin the session cookie and the CSRF guard are bound to), `OCR_TRUSTED_PROXY_HOPS` (1 only once nginx-proxy is confirmed to append the client IP; 0 turns the per-IP login limiter off), `OCR_SESSION_IDLE_MINUTES`, `OCR_SESSION_ABSOLUTE_HOURS` and `OCR_EXPORT_MAX_ROWS`. `OCR_WEB_AUTO_AUTH` and `OCR_WEB_SUBJECT_ID` are gone: `GET /api/web-token` no longer exists.

Accounts are managed in the workbench by an administrator. The **first** administrator of a tenant is created at an interactive terminal on the host:

```sh
./deploy/ocr-users.sh create-admin      # also: reset-password (break-glass), unlock, list
```

It prompts for the password twice with no echo, refuses to run outside a TTY, and accepts no password flag, file or environment variable. It connects as `ocr_app` under `OCR_WEB_TENANT_ID`, so RLS and the least-privilege grants apply exactly as they do to the web service. `docker compose exec` output never reaches `docker logs`.

After a deploy, run the credential-free smoke test — every check is an unauthenticated request whose expected answer is a refusal:

```sh
./deploy/auth-smoke.sh https://ocr.innoveraappcenter.com   # expects SUMMARY FAIL=0
```

For a local or fresh database, provision runtime logins with `DATABASE_URL_BOOTSTRAP`, `DATABASE_URL_MIGRATOR`, `DATABASE_URL_APP`, `DATABASE_URL_WORKER`, `DATABASE_URL_QUEUE`, `OCR_MIGRATOR_PASSWORD`, `OCR_APP_PASSWORD`, `OCR_WORKER_PASSWORD`, and `OCR_QUEUE_PASSWORD` exported in the shell, then run `./deploy/provision-roles.sh`. The one-time bootstrap administrator demotes `ocr_migrator` to a non-superuser database owner; the migrator remains the only DDL role and queue access is limited to security-definer queue functions. A PostgreSQL cluster's bootstrap superuser cannot demote itself, so production must use a distinct bootstrap administrator.

Prometheus can scrape `/metrics` using `deploy/prometheus.yml`. In production, `deploy/prometheus-production.yml` loads `deploy/prometheus-alerts.yml` through `rule_files` (compose mounts it at `/etc/prometheus/alerts.yml`), which is what makes the login alerts — `OcrLoginFailuresHigh`, `OcrLoginBusy`, `OcrCsrfRejected`, `OcrBulkRead` — actually evaluate. Alert on elevated `http_requests_total`, `ocr_requests_total{status="error"}`, queue/outbox backlog, retry/dead counts, database readiness failures, and ClamAV readiness failures. Metrics must remain behind the internal network or an authenticated reverse proxy.

Run `deploy/cleanup-retention.sh` from a restricted systemd timer or cron job. It removes expired idempotency rows and temporary files only; original files and audit corrections require a reviewed retention/legal-hold workflow.

The supplied `innovera-ocr-cleanup.service` and `.timer` provide the systemd wiring. Install them under `/etc/systemd/system`, create `/etc/innovera/ocr-cleanup.env` with mode `0600`, run a dry run first, then enable the timer. The lock directory prevents overlapping executions.

Production operator sequence:

```sh
set -a; . /etc/innovera/ocr-production.env; set +a
./deploy/production-preflight.sh
./deploy/provision-roles.sh
./deploy/verify-db-roles.sh
./deploy/install-cleanup-timer.sh install
./deploy/security-check.sh
./deploy/go-live-check.sh
```

Run `./deploy/e2e-production.sh` only from a protected operator shell, with `APP_BASE_URL`, `SAMPLE_FILE` and `E2E_USERNAME` set. It prompts for that account's password at the terminal: there is no `JWT_TOKEN` and no password variable. The password goes straight into the request body and the CSRF token straight into a mode-600 temporary file that curl reads with `-H @file`, so neither is ever visible in `ps`. It logs out at the end and prints no password, cookie or token.
