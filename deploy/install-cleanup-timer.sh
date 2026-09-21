#!/usr/bin/env bash
set -euo pipefail

action="${1:-install}"
unit_dir="/etc/systemd/system"
project_dir="${OCR_PROJECT_DIR:-/opt/innovera-ocr-app/ocr}"

case "$action" in
  install)
    install -D -m 0644 "${project_dir}/deploy/innovera-ocr-cleanup.service" "${unit_dir}/innovera-ocr-cleanup.service"
    install -D -m 0644 "${project_dir}/deploy/innovera-ocr-cleanup.timer" "${unit_dir}/innovera-ocr-cleanup.timer"
    systemctl daemon-reload
    systemctl enable --now innovera-ocr-cleanup.timer
    systemctl status --no-pager innovera-ocr-cleanup.timer
    systemctl list-timers --all innovera-ocr-cleanup.timer
    ;;
  uninstall)
    systemctl disable --now innovera-ocr-cleanup.timer || true
    rm -f "${unit_dir}/innovera-ocr-cleanup.service" "${unit_dir}/innovera-ocr-cleanup.timer"
    systemctl daemon-reload
    ;;
  *) echo "usage: $0 [install|uninstall]" >&2; exit 2 ;;
esac
