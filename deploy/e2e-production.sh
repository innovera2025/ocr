#!/usr/bin/env bash
set -euo pipefail

: "${APP_BASE_URL:?set APP_BASE_URL}"
: "${JWT_TOKEN:?set JWT_TOKEN (never echo it)}"
: "${SAMPLE_FILE:?set SAMPLE_FILE}"

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

response=$(curl --fail-with-body --silent --show-error --location --request POST "${APP_BASE_URL%/}/api/documents" \
  -H "Authorization: Bearer ${JWT_TOKEN}" \
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
  review=$(curl --fail --silent --show-error "${APP_BASE_URL%/}/api/documents/${document_id}/ocr" -H "Authorization: Bearer ${JWT_TOKEN}") || true
  status="$(python3 -c 'import json,sys; d=json.load(sys.stdin).get("document",{}); print(d.get("status", ""))' <<<"$review" 2>/dev/null || true)"
  printf 'poll attempt=%s status=%s\n' "$attempt" "${status:-unavailable}"
  case "$status" in SUCCEEDED) break ;; NEEDS_REVIEW)
    : "${E2E_FIELD:?set E2E_FIELD when the OCR result requires review}"
    : "${E2E_VERIFIED_VALUE:?set E2E_VERIFIED_VALUE when the OCR result requires review}"
    raw="${E2E_RAW:-}"
    curl --fail --silent --show-error --request POST "${APP_BASE_URL%/}/api/documents/${document_id}/ocr/confirm" \
      -H "Authorization: Bearer ${JWT_TOKEN}" -H 'content-type: application/json' \
      --data "$(python3 -c 'import json,os; print(json.dumps({"field":os.environ["E2E_FIELD"],"raw":os.environ.get("E2E_RAW",""),"verifiedValue":os.environ["E2E_VERIFIED_VALUE"]}))')"
    break ;;
  esac
  sleep "${E2E_POLL_SECONDS:-2}"
done
elapsed=$(( $(date +%s) - started ))
printf 'E2E upload accepted elapsed_seconds=%s idempotency_key=%s\n' "$elapsed" "$key"
printf 'Verify final status and outbox SUCCEEDED using the review API/database before marking this run complete.\n'
