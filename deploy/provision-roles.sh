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

COREPACK_HOME="${COREPACK_HOME:-/tmp/ocr-corepack}" pnpm exec tsx -e 'import {createDatabasePool,runMigrationsWithPool} from "./packages/db-runtime/src/index.ts"; const p=createDatabasePool(process.env.DATABASE_URL_MIGRATOR); runMigrationsWithPool(p,"./prisma/migrations").then(x=>{if(x.length) process.stdout.write(`applied=${x.join(",")}\n`); return p.end()}).catch(async e=>{process.stderr.write(`${String(e)}\n`); await p.end(); process.exit(1)})'
DATABASE_URL_BOOTSTRAP="${DATABASE_URL_BOOTSTRAP}" DATABASE_URL_MIGRATOR="${DATABASE_URL_MIGRATOR}" DATABASE_URL_APP="${DATABASE_URL_APP:-}" DATABASE_URL_WORKER="${DATABASE_URL_WORKER:-}" DATABASE_URL_QUEUE="${DATABASE_URL_QUEUE:-}" ./deploy/verify-db-roles.sh
