#!/usr/bin/env bash
set -u

pass=0; fail=0; not_run=0
item() { local status="$1" name="$2"; printf '%-8s %s\n' "$status" "$name"; case "$status" in PASS) pass=$((pass+1));; FAIL) fail=$((fail+1));; NOT_RUN) not_run=$((not_run+1));; esac; }
run_check() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then item PASS "$name"; else item FAIL "$name"; fi; }

if [ -n "${DATABASE_URL_BOOTSTRAP:-}" ]; then item PASS "production DB credentials supplied"; else item NOT_RUN "production DB credentials supplied"; fi
if [ -n "${DATABASE_URL_MIGRATOR:-}" ] && [ -n "${DATABASE_URL_APP:-}" ] && [ -n "${DATABASE_URL_WORKER:-}" ] && [ -n "${DATABASE_URL_QUEUE:-}" ]; then run_check "DB roles least privilege" ./deploy/verify-db-roles.sh; else item NOT_RUN "DB roles least privilege"; fi
if [ -n "${DATABASE_URL_MIGRATOR:-}" ]; then run_check "migrations current" bash -c 'COREPACK_HOME="${COREPACK_HOME:-/tmp/ocr-corepack}" pnpm exec tsx -e "import {createDatabasePool,runMigrationsWithPool} from \\"./packages/db-runtime/src/index.ts\\"; const p=createDatabasePool(process.env.DATABASE_URL_MIGRATOR); runMigrationsWithPool(p,\\"./prisma/migrations\\").then(x=>{if(x.length)process.exit(2);return p.end()}).catch(async()=>{await p.end();process.exit(1)})"'; else item NOT_RUN "migrations current"; fi
if [ -n "${AUTH_JWT_SECRETS:-}" ] && [ -n "${AUTH_JWT_ISSUER:-}" ] && [ -n "${AUTH_JWT_AUDIENCE:-}" ]; then item PASS "production JWT policy"; else item NOT_RUN "production JWT policy"; fi
if [ -n "${OCR_API_BASE_URL:-}" ]; then run_check "OCR TLS/reachability" curl --fail --silent --head --location "$OCR_API_BASE_URL"; else item NOT_RUN "OCR TLS/reachability"; fi
if command -v docker >/dev/null 2>&1; then run_check "ClamAV healthy" bash -c 'docker ps --format "{{.Names}} {{.Status}}" | grep -E "clamav.*healthy"'; run_check "web/worker images" bash -c 'docker image inspect innovera-ocr-web:local innovera-ocr-worker:local'; else item NOT_RUN "container health"; fi
if command -v systemctl >/dev/null 2>&1; then run_check "cleanup timer active" systemctl is-active --quiet innovera-ocr-cleanup.timer; else item NOT_RUN "cleanup timer active"; fi
if [ -f deploy/prometheus-alerts.yml ]; then item PASS "alert rules present"; else item FAIL "alert rules present"; fi
item NOT_RUN "Prometheus scraping web and worker"
item NOT_RUN "critical alerts loaded"
if [ -f /tmp/ocr-rpo-final.dump ]; then item PASS "backup evidence present"; else item NOT_RUN "backup evidence present"; fi
item NOT_RUN "restore evidence attached"
if [ -f docs/operations/failure-drill.md ]; then item PASS "failure drill procedure"; else item FAIL "failure drill procedure"; fi
item NOT_RUN "worker-kill drill evidence"
item NOT_RUN "OCR outage drill evidence"
item NOT_RUN "Confirm outage drill evidence"
item NOT_RUN "PostgreSQL restart drill evidence"
item NOT_RUN "ClamAV outage drill evidence"
item NOT_RUN "disk failure drill evidence"
item NOT_RUN "authenticated production E2E evidence"
item NOT_RUN "firewall reviewed"
item NOT_RUN "public ports reviewed"
item NOT_RUN "TLS renewal verified"
run_check "secret scan clean" bash -c '! rg -n --hidden --glob "!node_modules/**" --glob "!**/dist/**" --glob "!deploy/*.sh" "local-development-only|app-local-test|worker-local-test|queue-local-test" .'

printf 'SUMMARY PASS=%s FAIL=%s NOT_RUN=%s\n' "$pass" "$fail" "$not_run"
if [ "$fail" -gt 0 ] || [ "$not_run" -gt 0 ]; then echo 'FINAL NO-GO'; exit 1; fi
echo 'FINAL GO'
