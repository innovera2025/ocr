#!/usr/bin/env bash
# Post-deploy login smoke test (release2-plan §7 E4). It uses NO credentials: every check is an unauthenticated
# request whose expected answer is a refusal. Usage: ./deploy/auth-smoke.sh https://ocr.example.com
set -uo pipefail

base="${1:-${APP_BASE_URL:-}}"
[ -n "$base" ] || { echo "usage: auth-smoke.sh <base-url>" >&2; exit 2; }
base="${base%/}"

pass=0; fail=0
check() {
  local name="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then printf 'PASS %s\n' "$name"; pass=$((pass+1));
  else printf 'FAIL %s expected=%s actual=%s\n' "$name" "$expected" "$actual"; fail=$((fail+1)); fi
}
# Status code only: no body is printed, so a surprising answer cannot leak a page into the terminal.
status() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$@"; }
json='{"probe":"auth-smoke"}'

# The route is gone either way; without a session an /api path answers 401 before it can fall through to 404 (C2.4).
check "web-token:gone" 401 "$(status "${base}/api/web-token")"
check "documents:unauthenticated" 401 "$(status "${base}/api/documents")"
check "batches:no-origin" 403 "$(status -X POST -H 'content-type: application/json' --data "$json" "${base}/api/batches")"
check "batches:foreign-origin" 403 "$(status -X POST -H 'content-type: application/json' -H 'Origin: https://example.invalid' --data "$json" "${base}/api/batches")"
check "login:wrong-content-type" 415 "$(status -X POST -H 'content-type: text/plain' -H "Origin: ${base}" --data 'probe' "${base}/api/auth/login")"
check "metrics:not-public" 404 "$(status "${base}/metrics")"
check "workbench:served" 200 "$(status "${base}/")"
check "workbench:csp" yes "$(curl -s -o /dev/null -D - --max-time 20 "${base}/" | grep -qi '^content-security-policy:' && echo yes || echo no)"
check "ready:healthy" 200 "$(status "${base}/health/ready")"

printf 'SUMMARY PASS=%s FAIL=%s\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
