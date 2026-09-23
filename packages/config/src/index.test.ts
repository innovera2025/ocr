import assert from "node:assert/strict";
import { test } from "node:test";
import { limits, loadConfig, loadWebConfig } from "./index.js";

const TENANT = "11111111-2222-3333-4444-555555555555";
const PRODUCTION = Object.freeze({
  OCR_ENV: "production",
  OCR_WEB_TENANT_ID: TENANT,
  OCR_PUBLIC_BASE_URL: "https://ocr.example.test/"
});

test("web config defaults the session and export limits", () => {
  const config = loadWebConfig({});
  assert.equal(config.tenantId, "");
  assert.equal(config.publicBaseUrl, "");
  assert.equal(config.publicOrigin, "");
  assert.equal(config.sessionIdleMinutes, 30);
  assert.equal(config.sessionAbsoluteHours, 12);
  assert.equal(config.exportMaxRows, 50_000);
});

test("web config keeps the base path but exposes only the origin for CSRF", () => {
  const config = loadWebConfig({ ...PRODUCTION, OCR_PUBLIC_BASE_URL: "https://ocr.example.test/ocr/" });
  assert.equal(config.tenantId, TENANT);
  assert.equal(config.publicBaseUrl, "https://ocr.example.test/ocr", "no trailing slash");
  assert.equal(config.publicOrigin, "https://ocr.example.test");
});

test("web config requires a tenant and an https base URL in production", () => {
  assert.throws(() => loadWebConfig({ ...PRODUCTION, OCR_WEB_TENANT_ID: "" }), /PRODUCTION_WEB_CONFIG_INVALID/);
  assert.throws(() => loadWebConfig({ ...PRODUCTION, OCR_PUBLIC_BASE_URL: "" }), /PRODUCTION_WEB_CONFIG_INVALID/);
  assert.throws(() => loadWebConfig({ ...PRODUCTION, OCR_PUBLIC_BASE_URL: "http://ocr.example.test" }), /PRODUCTION_WEB_CONFIG_INVALID/);
  // Outside production both may be absent, and http is fine for the dev server.
  assert.equal(loadWebConfig({ OCR_ENV: "development", OCR_PUBLIC_BASE_URL: "http://127.0.0.1:3100" }).publicOrigin, "http://127.0.0.1:3100");
});

test("web config rejects a malformed tenant or base URL in any environment", () => {
  assert.throws(() => loadWebConfig({ OCR_WEB_TENANT_ID: "not-a-uuid" }), /INVALID_WEB_TENANT_ID/);
  assert.throws(() => loadWebConfig({ OCR_PUBLIC_BASE_URL: "ocr.example.test" }), /INVALID_PUBLIC_BASE_URL/);
});

test("web config bounds the session and export numbers", () => {
  assert.equal(loadWebConfig({ OCR_SESSION_IDLE_MINUTES: "480", OCR_SESSION_ABSOLUTE_HOURS: "24", OCR_EXPORT_MAX_ROWS: "200000" }).sessionIdleMinutes, 480);
  assert.throws(() => loadWebConfig({ OCR_SESSION_IDLE_MINUTES: "4" }));
  assert.throws(() => loadWebConfig({ OCR_SESSION_IDLE_MINUTES: "481" }));
  assert.throws(() => loadWebConfig({ OCR_SESSION_ABSOLUTE_HOURS: "0" }));
  assert.throws(() => loadWebConfig({ OCR_SESSION_ABSOLUTE_HOURS: "25" }));
  assert.throws(() => loadWebConfig({ OCR_EXPORT_MAX_ROWS: "0" }));
  assert.throws(() => loadWebConfig({ OCR_EXPORT_MAX_ROWS: "200001" }));
});

test("app config is unchanged by the web settings", () => {
  const config = loadConfig({ OCR_WEB_TENANT_ID: TENANT, OCR_PUBLIC_BASE_URL: "https://ocr.example.test" });
  assert.equal(config.env, "development");
  assert.equal(config.port, 3100);
  assert.equal(config.trustedProxyHops, 0, "the per-IP throttle still reads this from loadConfig");
  assert.equal(config.limits, limits);
  assert.deepEqual(config.auth.jwtSecrets, []);
  assert.ok(!("tenantId" in config));
  assert.throws(() => loadConfig({ OCR_ENV: "production" }), /PRODUCTION_AUTH_POLICY_REQUIRED/);
});
