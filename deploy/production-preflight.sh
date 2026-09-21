#!/usr/bin/env bash
set -u

pass=0; fail=0
check() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then printf 'PASS %s\n' "$name"; pass=$((pass+1)); else printf 'FAIL %s\n' "$name"; fail=$((fail+1)); fi; }
has_value() { [ -n "${!1:-}" ]; }
required_secret() { local value="${!1:-}"; [ -n "$value" ] && [[ "$value" != *REDACTED* ]] && [[ "$value" != *local-development-only* ]] && [[ "$value" != *-local-test* ]]; }

required_secrets=(DATABASE_URL_BOOTSTRAP DATABASE_URL_MIGRATOR DATABASE_URL_APP DATABASE_URL_WORKER DATABASE_URL_QUEUE AUTH_JWT_SECRETS)
required_values=(AUTH_JWT_ISSUER AUTH_JWT_AUDIENCE OCR_API_BASE_URL OCR_REQUEST_TIMEOUT OCR_MAX_RETRIES OCR_CLAMAV_HOST OCR_CLAMAV_PORT OCR_STORAGE_ROOT)
for name in "${required_secrets[@]}"; do check "env:${name}" required_secret "$name"; done
for name in "${required_values[@]}"; do check "env:${name}" has_value "$name"; done
check "jwt:issuer" test -n "${AUTH_JWT_ISSUER:-}"
check "jwt:audience" test -n "${AUTH_JWT_AUDIENCE:-}"
check "ocr:https" curl --fail --silent --show-error --head --location "${OCR_API_BASE_URL:-https://invalid.invalid}"
check "postgres:reachable" pg_isready -d "${DATABASE_URL_APP:-invalid}"
check "clamav:reachable" bash -c 'command -v nc >/dev/null && nc -z "${OCR_CLAMAV_HOST:-invalid}" "${OCR_CLAMAV_PORT:-0}"'
check "storage:writable" test -w "${OCR_STORAGE_ROOT:-/var/lib/ocr}"
check "storage:free-space" bash -c 'test "$(df -Pk "${OCR_STORAGE_ROOT:-/var/lib/ocr}" | awk "NR==2 {print \$4}")" -ge 1048576'
check "docker:available" docker version
check "compose:valid" docker compose -f deploy/docker-compose.yml config
check "scripts:syntax" bash -n deploy/*.sh
check "secret-scan" bash -c '! rg -n --hidden --glob "!node_modules/**" --glob "!**/dist/**" --glob "!deploy/*.sh" "local-development-only|app-local-test|worker-local-test|queue-local-test" .'

if [ -n "${DATABASE_URL_MIGRATOR:-}" ]; then
  check "migrations:current" bash -c 'COREPACK_HOME="${COREPACK_HOME:-/tmp/ocr-corepack}" pnpm exec tsx -e "import {createDatabasePool,runMigrationsWithPool} from \"./packages/db-runtime/src/index.ts\"; const p=createDatabasePool(process.env.DATABASE_URL_MIGRATOR); runMigrationsWithPool(p,\"./prisma/migrations\").then(x=>{if(x.length) process.exit(2); return p.end()}).catch(async()=>{await p.end();process.exit(1)})"'
fi

printf 'SUMMARY PASS=%s FAIL=%s\n' "$pass" "$fail"
if [ "$fail" -gt 0 ]; then exit 1; fi
