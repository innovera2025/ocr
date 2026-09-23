import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  clearSessionCookie, csrfTokenFor, hashSessionToken, newSessionToken, readSessionCookie, serializeSessionCookie,
  sessionCookieName, verifyCsrf
} from "./session.js";

test("session tokens are 32 random bytes stored only as their SHA-256", () => {
  const token = newSessionToken();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(token, "base64url").length, 32);
  assert.notEqual(newSessionToken(), token);
  const hash = hashSessionToken(token);
  assert.equal(hash.length, 32, "auth_sessions.token_hash is bytea with octet_length = 32");
  assert.deepEqual(hash, createHash("sha256").update(Buffer.from(token, "base64url")).digest());
  assert.deepEqual(hashSessionToken(token), hash, "deterministic");
  assert.notDeepEqual(hashSessionToken(newSessionToken()), hash);
  assert.notDeepEqual(hash, Buffer.from(token, "base64url"), "the stored value is the digest, not the token");
});

test("session CSRF token is derived from the session and compared in constant time", () => {
  const token = newSessionToken();
  const csrf = csrfTokenFor(token);
  assert.match(csrf, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(csrfTokenFor(token), csrf, "same session, same token");
  assert.notEqual(csrfTokenFor(newSessionToken()), csrf, "another session, another token");
  assert.notEqual(csrf, token);
  assert.equal(verifyCsrf(token, csrf), true);
  assert.equal(verifyCsrf(token, undefined), false);
  assert.equal(verifyCsrf(token, ""), false);
  assert.equal(verifyCsrf(token, csrf.slice(0, -1)), false);
  assert.equal(verifyCsrf(token, `${csrf}x`), false);
  assert.equal(verifyCsrf(token, csrfTokenFor(newSessionToken())), false);
  assert.equal(verifyCsrf(token, token), false);
});

test("session cookie is host-bound in production and plain http in development", () => {
  const token = newSessionToken();
  assert.equal(sessionCookieName("production"), "__Host-ocr_session");
  assert.equal(sessionCookieName("development"), "ocr_session");
  assert.equal(sessionCookieName("test"), "ocr_session");
  assert.equal(serializeSessionCookie("production", token), `__Host-ocr_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict`);
  assert.equal(serializeSessionCookie("development", token), `ocr_session=${token}; Path=/; HttpOnly; SameSite=Strict`);
  assert.equal(clearSessionCookie("production"), "__Host-ocr_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0");
  assert.equal(clearSessionCookie("development"), "ocr_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
  for (const value of [serializeSessionCookie("production", token), clearSessionCookie("production"), serializeSessionCookie("development", token)]) {
    assert.doesNotMatch(value, /Domain=/i, "a Domain would hand the cookie to every sibling host");
    assert.doesNotMatch(value, /Expires=/i);
  }
  assert.doesNotMatch(serializeSessionCookie("production", token), /Max-Age=/i, "it dies with the browser session");
});

test("session cookie reader accepts exactly one well-formed cookie", () => {
  const token = newSessionToken();
  assert.equal(readSessionCookie(`__Host-ocr_session=${token}`, "production"), token);
  assert.equal(readSessionCookie(` other=1; __Host-ocr_session=${token} ; last=2`, "production"), token);
  assert.equal(readSessionCookie(`ocr_session=${token}`, "development"), token);
  assert.equal(readSessionCookie(`ocr_session=nonsense; __Host-ocr_session=${token}`, "production"), token);
  assert.equal(readSessionCookie(undefined, "production"), undefined);
  assert.equal(readSessionCookie("", "production"), undefined);
  assert.equal(readSessionCookie("other=1", "production"), undefined);
  assert.equal(readSessionCookie(`ocr_session=${token}`, "production"), undefined, "the development name is not accepted in production");
  assert.equal(readSessionCookie(`x__Host-ocr_session=${token}`, "production"), undefined, "the name must match exactly");
});

test("session cookie reader rejects duplicates, malformed and oversize values", () => {
  const token = newSessionToken();
  assert.equal(readSessionCookie(`__Host-ocr_session=${token}; __Host-ocr_session=${token}`, "production"), undefined, "duplicates mean no session");
  assert.equal(readSessionCookie(`__Host-ocr_session=${token}; __Host-ocr_session=nonsense`, "production"), undefined);
  assert.equal(readSessionCookie("__Host-ocr_session=", "production"), undefined);
  assert.equal(readSessionCookie("__Host-ocr_session", "production"), undefined);
  assert.equal(readSessionCookie(`__Host-ocr_session=${token.slice(0, 42)}`, "production"), undefined, "too short");
  assert.equal(readSessionCookie(`__Host-ocr_session=${token}A`, "production"), undefined, "too long");
  assert.equal(readSessionCookie(`__Host-ocr_session=${"A".repeat(100_000)}`, "production"), undefined, "oversize");
  assert.equal(readSessionCookie(`__Host-ocr_session=${token.slice(0, 42)}+`, "production"), undefined, "base64url only");
  assert.equal(readSessionCookie(`__Host-ocr_session="${token}"`, "production"), undefined, "quoted values are not ours");
});
