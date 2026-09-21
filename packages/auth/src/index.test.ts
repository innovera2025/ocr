import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { authenticateBearer, AuthenticationError } from "./index.js";

function token(claims: Record<string, unknown>, secret = "secret"): string {
  const head = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `Bearer ${head}.${body}.${signature}`;
}

const userId = "00000000-0000-0000-0000-000000000001";
const tenantId = "00000000-0000-0000-0000-000000000002";

test("auth derives principal from signed claims and ignores tenant headers", () => {
  const principal = authenticateBearer(token({ sub: userId, organization_id: tenantId }), "secret");
  assert.equal(principal.userId, userId);
  assert.equal(principal.tenantId, tenantId);
});

test("auth rejects missing, forged, and expired tokens", () => {
  assert.throws(() => authenticateBearer(undefined, "secret"), AuthenticationError);
  assert.throws(() => authenticateBearer(token({ sub: userId, organization_id: tenantId }, "wrong"), "secret"), AuthenticationError);
  assert.throws(() => authenticateBearer(token({ sub: userId, organization_id: tenantId, exp: 1 }), "secret"), AuthenticationError);
});

test("auth enforces issuer and audience and supports rotation keys", () => {
  const value = token({ sub: userId, organization_id: tenantId, iss: "https://issuer.example", aud: "ocr" }, "rotated");
  const principal = authenticateBearer(value, ["current", "rotated"], { issuer: "https://issuer.example", audience: "ocr" });
  assert.equal(principal.userId, userId);
  assert.throws(() => authenticateBearer(value, "rotated", { issuer: "other" }), /INVALID_ISSUER/);
  assert.throws(() => authenticateBearer(value, "rotated", { audience: "other" }), /INVALID_AUDIENCE/);
});
