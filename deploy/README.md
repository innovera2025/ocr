# Local Docker stack

This stack starts PostgreSQL 17, ClamAV, the authenticated web service, and the OCR worker. The worker contacts the configured OCR gateway; use non-production credentials for local validation.

```sh
docker compose -f deploy/docker-compose.yml up --build
```

The web health endpoint is available at `http://127.0.0.1:53100/health/live`. PostgreSQL is bound to `127.0.0.1:55432`; ClamAV is internal-only. OCR integration reads `OCR_API_BASE_URL` (default `https://ai.innoveraappcenter.com/ocr`), `OCR_REQUEST_TIMEOUT` (seconds, default `300`) and `OCR_MAX_RETRIES` (default `3`). The worker image includes poppler-utils: a PDF upload is split into one page image and one row per page (`OCR_MAX_PDF_PAGES`, default `300`, at most `1000`; `OCR_PAGE_FORMAT` `png` (default) or `jpeg`), rendered in `${OCR_STORAGE_ROOT}/tmp` and stored next to the originals (about 1–3 MB per PNG page). Deploy the web (it runs migration 0018) before the worker. Stop and remove local containers with:

```sh
docker compose -f deploy/docker-compose.yml down
```

The web entrypoint runs the idempotent, checksum-verified migrations in `prisma/migrations`; the worker verifies database readiness and the presence of `schema_migrations` before accepting work. The compose file does not run destructive migrations outside that runner; the migration role must have permission to apply them.

Runtime credentials are injected, never stored in compose: `POSTGRES_MIGRATOR_PASSWORD`, `DATABASE_URL_MIGRATOR`, `DATABASE_URL_APP`, `DATABASE_URL_WORKER`, `DATABASE_URL_QUEUE`, `AUTH_JWT_SECRETS`, `AUTH_JWT_ISSUER`, and `AUTH_JWT_AUDIENCE`. Provision the four login roles (`ocr_migrator`, `ocr_app`, `ocr_worker`, `ocr_queue`) separately before starting the application.

Production also requires `AUTH_JWT_SECRETS` (comma-separated current and previous rotation keys), `AUTH_JWT_ISSUER`, and `AUTH_JWT_AUDIENCE`. Production startup fails if these are missing. Rotate by adding the new key after the old key, deploying, waiting for token TTL expiry, then removing the old key. Never print the values or put them in compose files.

For a local or fresh database, provision runtime logins with `DATABASE_URL_BOOTSTRAP`, `DATABASE_URL_MIGRATOR`, `DATABASE_URL_APP`, `DATABASE_URL_WORKER`, `DATABASE_URL_QUEUE`, `OCR_MIGRATOR_PASSWORD`, `OCR_APP_PASSWORD`, `OCR_WORKER_PASSWORD`, and `OCR_QUEUE_PASSWORD` exported in the shell, then run `./deploy/provision-roles.sh`. The one-time bootstrap administrator demotes `ocr_migrator` to a non-superuser database owner; the migrator remains the only DDL role and queue access is limited to security-definer queue functions. A PostgreSQL cluster's bootstrap superuser cannot demote itself, so production must use a distinct bootstrap administrator.

Prometheus can scrape `/metrics` using `deploy/prometheus.yml`. Alert on elevated `http_requests_total`, `ocr_requests_total{status="error"}`, queue/outbox backlog, retry/dead counts, database readiness failures, and ClamAV readiness failures. Metrics must remain behind the internal network or an authenticated reverse proxy.

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

Run `./deploy/e2e-production.sh` only after `APP_BASE_URL`, `JWT_TOKEN`, and `SAMPLE_FILE` are supplied through a protected operator shell. The script never prints the token.
