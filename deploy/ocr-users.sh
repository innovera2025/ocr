#!/usr/bin/env bash
# First-admin bootstrap and break-glass account commands (release2-plan §7 E1/E2).
# Run it in YOUR OWN interactive SSH session: the password is typed at this terminal, and `docker compose exec`
# output never reaches `docker logs`. Subcommands: create-admin | reset-password | unlock | list.
set -euo pipefail
[ -t 0 ] && [ -t 1 ] || { echo "run this in an interactive terminal" >&2; exit 2; }
cd "$(dirname "$0")/.."
exec docker compose --env-file "${OCR_COMPOSE_ENV:-/etc/innovera/ocr-compose.env}" -f deploy/docker-compose.yml \
  exec -it web pnpm --filter @innovera/ocr-web run users "$@"
