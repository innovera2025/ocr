#!/usr/bin/env bash
set -u
pass=0; fail=0; not_run=0
pass_item() { printf 'PASS %s\n' "$1"; pass=$((pass+1)); }
fail_item() { printf 'FAIL %s\n' "$1"; fail=$((fail+1)); }
skip_item() { printf 'NOT_RUN %s\n' "$1"; not_run=$((not_run+1)); }

if command -v ss >/dev/null 2>&1; then
  while read -r address; do
    case "$address" in
      127.0.0.1:*|\[::1\]:*) pass_item "loopback:${address}" ;;
      0.0.0.0:22|\[::\]:22) pass_item "ssh:${address}" ;;
      *) fail_item "unexpected-listener:${address}" ;;
    esac
  done < <(ss -ltnH | awk '{print $4}')
else
  fail_item "ss-command-missing"
fi

if command -v docker >/dev/null 2>&1; then
  if docker ps --format '{{.Names}} {{.Ports}} {{.Names}}' | grep -E '0\.0\.0\.0:|\[::\]:' >/dev/null; then fail_item "docker-public-port"; else pass_item "docker-published-ports"; fi
  if docker ps --format '{{.Names}}' | xargs -r docker inspect --format '{{.Name}} privileged={{.HostConfig.Privileged}}' | grep 'privileged=true' >/dev/null; then fail_item "privileged-container"; else pass_item "no-privileged-container"; fi
else fail_item "docker-command-missing"; fi

if command -v ufw >/dev/null 2>&1; then ufw status | grep -q active && pass_item "firewall-active" || fail_item "firewall-inactive"; elif command -v firewall-cmd >/dev/null 2>&1; then firewall-cmd --state | grep -q running && pass_item "firewall-active" || fail_item "firewall-inactive"; else fail_item "firewall-tool-missing"; fi

if command -v systemctl >/dev/null 2>&1; then
  systemctl is-active --quiet nginx 2>/dev/null && pass_item "reverse-proxy-active" || fail_item "reverse-proxy-not-active"
  systemctl list-timers --all 2>/dev/null | grep -E 'certbot|certbot-renew' >/dev/null && pass_item "certificate-renewal-timer" || fail_item "certificate-renewal-timer-not-found"
else fail_item "systemctl-missing"; fi

if [ -n "${SECURITY_CHECK_DOMAIN:-}" ] && command -v openssl >/dev/null 2>&1 && command -v timeout >/dev/null 2>&1; then
  if timeout 10 openssl s_client -connect "${SECURITY_CHECK_DOMAIN}:443" -servername "${SECURITY_CHECK_DOMAIN}" </dev/null 2>/dev/null | openssl x509 -checkend 2592000 -noout >/dev/null 2>&1; then pass_item "tls-valid-30-days"; else fail_item "tls-expiry-or-chain"; fi
else skip_item "tls-expiry-check (set SECURITY_CHECK_DOMAIN)"; fi

printf 'SUMMARY PASS=%s FAIL=%s NOT_RUN=%s\n' "$pass" "$fail" "$not_run"
[ "$fail" -eq 0 ]
