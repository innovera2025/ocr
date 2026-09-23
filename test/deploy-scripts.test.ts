import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";

/**
 * Static guards for the release 2 deploy surface (plan §7 and §12). These files are read by an operator on a shared
 * host, so what they must NOT contain is as much a requirement as what they do: a secret in `argv` is readable by
 * every other user of that host through `ps` and `/proc` for the life of the request.
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const mode = (path: string) => statSync(new URL(path, import.meta.url)).mode;
/**
 * Forbidden-text assertions run against comment-stripped sources, as `test/batch-migration.test.ts:8` already does
 * for SQL: these files explain in prose why they take no password, and that explanation must not fail the test that
 * enforces it.
 */
const withoutShellComments = (source: string) => source.replace(/^\s*#.*$/gm, "");
const withoutTsComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const e2e = read("../deploy/e2e-production.sh");
const smoke = read("../deploy/auth-smoke.sh");
const users = read("../deploy/ocr-users.sh");
const cli = read("../apps/ocr-web/src/cli/users.ts");
const tty = read("../apps/ocr-web/src/cli/tty.ts");
const compose = read("../deploy/docker-compose.yml");
const preflight = read("../deploy/production-preflight.sh");
const alerts = read("../deploy/prometheus-alerts.yml");
const prometheus = read("../deploy/prometheus-production.yml");

test("e2e-production.sh carries no bearer token and never puts the CSRF token in argv", () => {
  assert.doesNotMatch(e2e, /Authorization: Bearer/);
  assert.doesNotMatch(e2e, /JWT_TOKEN/);
  assert.doesNotMatch(e2e, /-H "X-CSRF-Token: \$/);
  // The one permitted form: curl reads the header out of a mode-600 file.
  assert.match(e2e, /-H @"\$hdr"/);
  assert.match(e2e, /chmod 600 "\$jar" "\$hdr"/);
  assert.match(e2e, /trap 'rm -f "\$jar" "\$hdr"' EXIT/);
});

test("e2e-production.sh reads the password from the terminal and forgets it", () => {
  assert.match(e2e, /read -r -s -p .* < \/dev\/tty/);
  assert.match(e2e, /^unset pw$/m);
  // No password flag, no password environment variable, and the password is never an argument.
  assert.doesNotMatch(e2e, /E2E_PASSWORD|--password/);
  assert.doesNotMatch(e2e, /echo .*\$pw|printf .*\$pw\\n/);
  assert.match(e2e, /: "\$\{E2E_USERNAME:\?/);
  assert.match(e2e, /\/api\/auth\/login/);
  assert.match(e2e, /\/api\/auth\/logout/);
  // Every request carries the origin the session cookie is bound to.
  assert.match(e2e, /-H "Origin: \$\{origin\}"/);
});

test("auth-smoke.sh needs no credentials at all", () => {
  for (const forbidden of [/Authorization/, /Bearer/, /--user\b/, /-u /, /password/i, /X-CSRF-Token/]) {
    assert.doesNotMatch(smoke, forbidden, String(forbidden));
  }
  // The eight checks of §7 E4, plus the readiness probe.
  for (const needle of ["/api/web-token", "/api/documents", "/api/batches", "/api/auth/login", "/metrics",
    "content-security-policy", "/health/ready", "https://example.invalid"]) {
    assert.ok(smoke.includes(needle), needle);
  }
  // The route is gone, but C2.4 refuses an /api path with no session long before it could fall through to 404, so the
  // credential-free probe must expect 401 — otherwise Deploy A step 8 can never report FAIL=0.
  assert.match(smoke, /check "web-token:gone" 401 /);
  assert.match(smoke, /SUMMARY PASS=%s FAIL=%s/);
});

test("the deploy scripts are executable and run under bash", () => {
  for (const [name, source] of [["e2e-production.sh", e2e], ["auth-smoke.sh", smoke], ["ocr-users.sh", users]] as const) {
    assert.ok(source.startsWith("#!/usr/bin/env bash"), name);
    assert.equal(mode(`../deploy/${name}`) & 0o111, 0o111, name);
  }
});

test("ocr-users.sh insists on a real terminal and passes no credential through", () => {
  assert.match(users, /\[ -t 0 \] && \[ -t 1 \]/);
  assert.match(users, /exec -it web pnpm --filter @innovera\/ocr-web run users "\$@"/);
  assert.doesNotMatch(withoutShellComments(users), /password/i);
});

test("the users CLI takes no password from a flag, an environment variable or a file", () => {
  const source = withoutTsComments(cli);
  assert.doesNotMatch(source, /--password|PASSWORD=|process\.env\.[A-Z_]*PASSWORD/);
  assert.doesNotMatch(source, /readFile|createReadStream/);
  // The only environment it reads is the database URL; everything else comes from loadWebConfig.
  assert.deepEqual([...source.matchAll(/process\.env\.([A-Z_]+)/g)].map((match) => match[1]), ["DATABASE_URL"]);
  assert.match(cli, /isInteractive/);
  assert.match(cli, /TTY_REQUIRED/);
  // A secret prompt must never echo: the reader owns the raw mode and restores it.
  assert.match(tty, /setRawMode\?\.\(true\)/);
  assert.match(tty, /setRawMode\?\.\(false\)/);
});

test("compose drops the auto-auth keys and carries the release 2 web settings", () => {
  assert.doesNotMatch(compose, /OCR_WEB_AUTO_AUTH|OCR_WEB_SUBJECT_ID/);
  assert.match(compose, /OCR_WEB_TENANT_ID: \$\{OCR_WEB_TENANT_ID:\?/);
  assert.match(compose, /OCR_PUBLIC_BASE_URL: \$\{OCR_PUBLIC_BASE_URL:-https:\/\//);
  assert.match(compose, /OCR_SESSION_IDLE_MINUTES: \$\{OCR_SESSION_IDLE_MINUTES:-30\}/);
  assert.match(compose, /OCR_SESSION_ABSOLUTE_HOURS: \$\{OCR_SESSION_ABSOLUTE_HOURS:-12\}/);
  assert.match(compose, /OCR_EXPORT_MAX_ROWS: \$\{OCR_EXPORT_MAX_ROWS:-50000\}/);
  assert.match(compose, /OCR_TRUSTED_PROXY_HOPS: \$\{OCR_TRUSTED_PROXY_HOPS:-0\}/);
  assert.match(compose, /limits: \{ cpus: "1\.5" \}/);
  assert.match(compose, /\.\/prometheus-alerts\.yml:\/etc\/prometheus\/alerts\.yml:ro/);
});

test("the preflight checks the new keys and warns instead of failing on operator decisions", () => {
  assert.match(preflight, /required_values=\(.*OCR_WEB_TENANT_ID OCR_PUBLIC_BASE_URL\)/);
  assert.match(preflight, /check "web:public-https"/);
  assert.match(preflight, /warn_if "timeout:below-300"/);
  assert.match(preflight, /warn_if "auth:auto-auth-leftover"/);
  assert.match(preflight, /SUMMARY PASS=%s FAIL=%s WARN=%s/);
});

test("the login alerts exist and prometheus loads the rules file", () => {
  for (const alert of ["OcrLoginFailuresHigh", "OcrLoginBusy", "OcrCsrfRejected", "OcrBulkRead"]) {
    assert.ok(alerts.includes(`alert: ${alert}`), alert);
  }
  assert.match(alerts, /increase\(auth_logins_total\{result="invalid"\}\[15m\]\) > 20/);
  assert.match(alerts, /increase\(documents_read_total\[1h\]\) > 5000/);
  assert.match(prometheus, /rule_files:\n {2}- \/etc\/prometheus\/alerts\.yml/);
});
