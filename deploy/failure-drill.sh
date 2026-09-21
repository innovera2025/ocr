#!/usr/bin/env bash
set -euo pipefail

case "${1:-help}" in
  help)
    cat <<'EOF'
Controlled drills (run only on an isolated production-like stack):
  ALLOW_DESTRUCTIVE_DRILL=true ./deploy/failure-drill.sh worker-kill
  ALLOW_DESTRUCTIVE_DRILL=true ./deploy/failure-drill.sh postgres-restart
  ALLOW_DESTRUCTIVE_DRILL=true ./deploy/failure-drill.sh clamav-restart
  ./deploy/failure-drill.sh ocr-outage-check
  ./deploy/failure-drill.sh confirm-outage-check
EOF
    ;;
  worker-kill|postgres-restart|clamav-restart)
    [ "${ALLOW_DESTRUCTIVE_DRILL:-false}" = true ] || { echo "FAIL destructive drill requires ALLOW_DESTRUCTIVE_DRILL=true"; exit 2; }
    case "$1" in
      worker-kill) docker compose -f deploy/docker-compose.yml kill worker; docker compose -f deploy/docker-compose.yml up -d worker ;;
      postgres-restart) docker restart deploy-postgres-1 ;;
      clamav-restart) docker restart deploy-clamav-1 ;;
    esac
    ;;
  ocr-outage-check|confirm-outage-check)
    echo "Use deploy/e2e-production.sh with an operator-controlled unreachable endpoint and verify retry/last_error/outbox state. No production traffic is changed by this command."
    ;;
  *) echo "unknown drill: $1" >&2; exit 2 ;;
esac
