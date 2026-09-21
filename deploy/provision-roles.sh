#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL_MIGRATOR:?set DATABASE_URL_MIGRATOR to the migrator DSN}"
: "${DATABASE_URL_BOOTSTRAP:?set DATABASE_URL_BOOTSTRAP to a one-time PostgreSQL administrator DSN}"
: "${OCR_MIGRATOR_PASSWORD:?set OCR_MIGRATOR_PASSWORD for the migrator role}"
: "${OCR_APP_PASSWORD:?set OCR_APP_PASSWORD}"
: "${OCR_WORKER_PASSWORD:?set OCR_WORKER_PASSWORD}"
: "${OCR_QUEUE_PASSWORD:?set OCR_QUEUE_PASSWORD}"
: "${DATABASE_URL_APP:?set DATABASE_URL_APP}"
: "${DATABASE_URL_WORKER:?set DATABASE_URL_WORKER}"
: "${DATABASE_URL_QUEUE:?set DATABASE_URL_QUEUE}"

# Run this once with a one-time bootstrap administrator. Passwords are supplied through psql variables,
# never committed to the repository or embedded in the image.
psql "${DATABASE_URL_BOOTSTRAP}" \
  -v migrator_password="${OCR_MIGRATOR_PASSWORD}" \
  -v app_password="${OCR_APP_PASSWORD}" \
  -v worker_password="${OCR_WORKER_PASSWORD}" \
  -v queue_password="${OCR_QUEUE_PASSWORD}" <<'SQL'
SELECT format('CREATE ROLE ocr_migrator LOGIN PASSWORD %L', :'migrator_password') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ocr_migrator') \gexec
SELECT format('CREATE ROLE ocr_app LOGIN PASSWORD %L', :'app_password') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ocr_app') \gexec
SELECT format('CREATE ROLE ocr_worker LOGIN PASSWORD %L', :'worker_password') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ocr_worker') \gexec
SELECT format('CREATE ROLE ocr_queue LOGIN PASSWORD %L', :'queue_password') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ocr_queue') \gexec
ALTER ROLE ocr_app LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
ALTER ROLE ocr_worker LOGIN PASSWORD :'worker_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
ALTER ROLE ocr_queue LOGIN PASSWORD :'queue_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
ALTER ROLE ocr_migrator LOGIN PASSWORD :'migrator_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SQL

# Historical migration 0002 runs CREATE ROLE inside an exception block that only tolerates duplicate_object.
# PostgreSQL checks CREATEROLE before existence, so on a database where 0002 has not run yet the NOCREATEROLE
# migrator needs CREATEROLE for this one migration run. Databases that already have 0002 are unaffected.
needs_createrole="$(psql "${DATABASE_URL_BOOTSTRAP}" -AtX -v ON_ERROR_STOP=1 -c "SELECT (to_regprocedure('public.ocr_claim_v1(timestamptz)') IS NULL)::int")"
if [ "${needs_createrole}" = "1" ]; then
  psql "${DATABASE_URL_BOOTSTRAP}" -qX -v ON_ERROR_STOP=1 -c "ALTER ROLE ocr_migrator CREATEROLE"
  trap 'psql "${DATABASE_URL_BOOTSTRAP}" -qX -v ON_ERROR_STOP=1 -c "ALTER ROLE ocr_migrator NOCREATEROLE"' EXIT
fi

COREPACK_HOME="${COREPACK_HOME:-/tmp/ocr-corepack}" pnpm exec tsx -e 'import {createDatabasePool,runMigrationsWithPool} from "./packages/db-runtime/src/index.ts"; const p=createDatabasePool(process.env.DATABASE_URL_MIGRATOR); runMigrationsWithPool(p,"./prisma/migrations").then(x=>{if(x.length) process.stdout.write(`applied=${x.join(",")}\n`); return p.end()}).catch(async e=>{process.stderr.write(`${String(e)}\n`); await p.end(); process.exit(1)})'
if [ "${needs_createrole}" = "1" ]; then
  psql "${DATABASE_URL_BOOTSTRAP}" -qX -v ON_ERROR_STOP=1 -c "ALTER ROLE ocr_migrator NOCREATEROLE"
  trap - EXIT
fi

# SECURITY DEFINER owner (ocr_queue_definer, NOLOGIN BYPASSRLS) for the queue AND confirm-outbox functions.
# Required because extraction_jobs and ocr_confirm_outbox use FORCE ROW LEVEL SECURITY. The SQL is shared with the
# DB integration test (packages/ocr-persistence/src/batch.db.test.ts). Idempotent; runs before verification so a
# failing check cannot leave the workers without a working queue.
psql "${DATABASE_URL_BOOTSTRAP}" -qX -v ON_ERROR_STOP=1 --single-transaction -f "$(dirname "${BASH_SOURCE[0]}")/sql/queue-definer.sql"

DATABASE_URL_BOOTSTRAP="${DATABASE_URL_BOOTSTRAP}" DATABASE_URL_MIGRATOR="${DATABASE_URL_MIGRATOR}" DATABASE_URL_APP="${DATABASE_URL_APP:-}" DATABASE_URL_WORKER="${DATABASE_URL_WORKER:-}" DATABASE_URL_QUEUE="${DATABASE_URL_QUEUE:-}" ./deploy/verify-db-roles.sh
