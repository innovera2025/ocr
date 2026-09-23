#!/usr/bin/env bash
# Authenticated production end-to-end check (release2-plan §7 E3). It logs in as a real staff account, uploads one
# sample file, waits for the result and logs out again.
#
# Secrets never reach argv: the password is typed at /dev/tty and piped into curl's body, and the CSRF token is
# written straight from the login answer into a mode-600 file that curl reads with `-H @file`. `-H "X-CSRF-Token:
# $csrf"` would put the token in the process arguments, where every other user of the host can read it through `ps`.
set -euo pipefail
umask 077

: "${APP_BASE_URL:?set APP_BASE_URL}"
: "${SAMPLE_FILE:?set SAMPLE_FILE}"
: "${E2E_USERNAME:?set E2E_USERNAME (the password is typed at the prompt, never passed in)}"

curl_version="$(curl --version | awk 'NR==1{print $2}')"
printf '%s\n%s\n' "7.55.0" "$curl_version" | sort -V -C \
  || { echo "FAIL curl >= 7.55 is required so the CSRF token can be read from a file instead of argv" >&2; exit 1; }

origin="${APP_BASE_URL%/}"
jar="$(mktemp)"
hdr="$(mktemp)"
chmod 600 "$jar" "$hdr"
trap 'rm -f "$jar" "$hdr"' EXIT

api() { curl --fail-with-body --silent --show-error --location -b "$jar" -c "$jar" -H "Origin: ${origin}" "$@"; }
post() { api -H @"$hdr" "$@"; }

read -r -s -p "password for ${E2E_USERNAME}: " pw < /dev/tty
printf '\n' >&2
# The password goes stdin -> JSON body -> curl, and the login answer goes straight into the header file. Neither is
# printed, and neither is ever an argument to a command.
printf '%s' "$pw" \
  | python3 -c 'import json,sys; print(json.dumps({"username":sys.argv[1],"password":sys.stdin.read()}))' "$E2E_USERNAME" \
  | curl --fail --silent --show-error -c "$jar" -H "Origin: ${origin}" -H 'content-type: application/json' \
      --data-binary @- "${origin}/api/auth/login" \
  | HDR="$hdr" python3 -c 'import json,os,sys; open(os.environ["HDR"],"w").write("X-CSRF-Token: "+json.load(sys.stdin)["csrfToken"]+"\n")'
unset pw
echo "login ok user=${E2E_USERNAME}"

key="ocr-e2e-$(date -u +%Y%m%dT%H%M%SZ)-$$"
started=$(date +%s)
filename="$(basename "${SAMPLE_FILE}")"
content_length="$(stat -c%s "${SAMPLE_FILE}")"

case "${SAMPLE_FILE,,}" in
  *.png)  mime_type="image/png" ;;
  *.jpg|*.jpeg) mime_type="image/jpeg" ;;
  *.webp) mime_type="image/webp" ;;
  *.pdf)  mime_type="application/pdf" ;;
  *) mime_type="${E2E_MIME_TYPE:-application/octet-stream}" ;;
esac

response=$(post --request POST "${origin}/api/documents" \
  -H "Idempotency-Key: ${key}" \
  -H "Content-Type: ${mime_type}" \
  -H "Content-Length: ${content_length}" \
  -H "X-Upload-Filename: ${filename}" \
  --data-binary "@${SAMPLE_FILE}")
printf '%s\n' "$response" | sed -E 's/(documentId|runId|jobId|id)"[[:space:]]*:[[:space:]]*"[^"]+"/\1":"<redacted>"/g'
document_id="$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("documentId", ""))' <<<"$response")"
[ -n "$document_id" ] || { echo "FAIL upload response has no documentId"; exit 1; }
review=''
for attempt in $(seq 1 "${E2E_POLL_ATTEMPTS:-120}"); do
  review=$(api "${origin}/api/documents/${document_id}/ocr") || true
  status="$(python3 -c 'import json,sys; d=json.load(sys.stdin).get("document",{}); print(d.get("status", ""))' <<<"$review" 2>/dev/null || true)"
  printf 'poll attempt=%s status=%s\n' "$attempt" "${status:-unavailable}"
  case "$status" in SUCCEEDED) break ;; NEEDS_REVIEW)
    : "${E2E_FIELD:?set E2E_FIELD when the OCR result requires review}"
    : "${E2E_VERIFIED_VALUE:?set E2E_VERIFIED_VALUE when the OCR result requires review}"
    post --request POST "${origin}/api/documents/${document_id}/ocr/confirm" \
      -H 'content-type: application/json' \
      --data "$(python3 -c 'import json,os; print(json.dumps({"field":os.environ["E2E_FIELD"],"raw":os.environ.get("E2E_RAW",""),"verifiedValue":os.environ["E2E_VERIFIED_VALUE"]}))')"
    break ;;
  esac
  sleep "${E2E_POLL_SECONDS:-2}"
done
elapsed=$(( $(date +%s) - started ))
post --request POST "${origin}/api/auth/logout" >/dev/null || echo "WARN logout failed; the session expires on its own"
printf 'E2E upload accepted elapsed_seconds=%s idempotency_key=%s\n' "$elapsed" "$key"
printf 'Verify final status and outbox SUCCEEDED using the review API/database before marking this run complete.\n'
