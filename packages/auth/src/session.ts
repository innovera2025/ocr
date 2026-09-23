import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type AppEnv = "development" | "test" | "production";

/** Everything a route is allowed to know about the caller. It comes from the session row, never from a header. */
export type AuthContext = Readonly<{
  userId: string;
  tenantId: string;
  sessionId: string;
  username: string;
  displayName: string;
  role: "admin" | "staff";
  canExport: boolean;
  mustChangePassword: boolean;
}>;

const TOKEN_BYTES = 32;
/** 32 bytes as unpadded base64url. */
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;
/** Domain separator, so the CSRF token can never be confused with anything else derived from the session token. */
const CSRF_LABEL = "innovera-ocr/csrf/v1";

/** The cookie value. Only its SHA-256 is stored, so a database reader cannot mint a session. */
export function newSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** SHA-256 of the decoded token bytes, matching `auth_sessions.token_hash` (bytea, 32 bytes). */
export function hashSessionToken(token: string): Buffer {
  return createHash("sha256").update(Buffer.from(token, "base64url")).digest();
}

/** Derived from the session token, so it needs no storage and dies with the session. */
export function csrfTokenFor(token: string): string {
  return createHmac("sha256", Buffer.from(token, "base64url")).update(CSRF_LABEL).digest("base64url");
}

export function verifyCsrf(token: string, header: string | undefined): boolean {
  if (!header) return false;
  const expected = Buffer.from(csrfTokenFor(token), "utf8");
  const actual = Buffer.from(header, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** `__Host-` binds the cookie to this exact origin and forbids a Domain; it needs Secure, which dev http cannot give. */
export function sessionCookieName(env: AppEnv): string {
  return env === "production" ? "__Host-ocr_session" : "ocr_session";
}

function cookieAttributes(env: AppEnv): string {
  return env === "production" ? "Path=/; HttpOnly; Secure; SameSite=Strict" : "Path=/; HttpOnly; SameSite=Strict";
}

/** No Max-Age and no Expires: the cookie dies with the browser session. There is never a Domain attribute. */
export function serializeSessionCookie(env: AppEnv, token: string): string {
  return `${sessionCookieName(env)}=${token}; ${cookieAttributes(env)}`;
}

export function clearSessionCookie(env: AppEnv): string {
  return `${sessionCookieName(env)}=; ${cookieAttributes(env)}; Max-Age=0`;
}

/**
 * Exactly one occurrence of the name, carrying a well-formed token. A duplicate, a malformed value or an oversize one
 * all mean "no session", so a cookie planted on a sibling host cannot shadow the real one.
 */
export function readSessionCookie(header: string | undefined, env: AppEnv): string | undefined {
  if (!header) return undefined;
  const name = sessionCookieName(env);
  let found: string | undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    if (found !== undefined) return undefined;
    found = part.slice(separator + 1).trim();
  }
  return found !== undefined && TOKEN_FORMAT.test(found) ? found : undefined;
}
