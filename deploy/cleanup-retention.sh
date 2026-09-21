#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL_MIGRATOR:?set DATABASE_URL_MIGRATOR}"
storage_root="${OCR_STORAGE_ROOT:-/var/lib/ocr}"
lock_dir="${OCR_CLEANUP_LOCK_DIR:-/var/run/innovera-ocr-cleanup.lock}"
log_file="${OCR_CLEANUP_LOG:-/var/log/innovera-ocr-cleanup.log}"
dry_run="${OCR_CLEANUP_DRY_RUN:-0}"

log() { printf '%s cleanup %s\n' "$(date -u +%FT%H:%M:%SZ)" "$*" | tee -a "${log_file}"; }
if ! mkdir "${lock_dir}" 2>/dev/null; then log "already_running"; exit 0; fi
trap 'rmdir "${lock_dir}" 2>/dev/null || true' EXIT
log "started dry_run=${dry_run}"

# Idempotency keys are disposable; audit/correction rows are deliberately untouched.
if [ "${dry_run}" = "1" ]; then
  psql "${DATABASE_URL_MIGRATOR}" -v ON_ERROR_STOP=1 -Atc \
    "SELECT 'expired_idempotency=' || count(*) FROM upload_idempotency_keys WHERE expires_at <= now();"
else
  psql "${DATABASE_URL_MIGRATOR}" -v ON_ERROR_STOP=1 -c \
    "DELETE FROM upload_idempotency_keys WHERE expires_at <= now();"
fi

# Only temporary artifacts are removed automatically. Originals require a reviewed
# tenant/legal-hold decision and are handled by a separate operator workflow.
if [ -d "${storage_root}/tmp" ]; then
  if [ "${dry_run}" = "1" ]; then find "${storage_root}/tmp" -type f -mtime +1 -print; else find "${storage_root}/tmp" -type f -mtime +1 -delete; fi
fi
log "completed"
