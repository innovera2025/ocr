import type { IncomingMessage, ServerResponse } from "node:http";
import { AuthenticationError, hashSessionToken, readSessionCookie, verifyCsrf, type AppEnv, type AuthContext } from "@innovera/ocr-auth";
import { metrics } from "@innovera/ocr-observability";
import type {
  AuditContext, AuditEvent, CreateSessionInput, CreateUserInput, LoginFailureInput, LoginUser, ResolvedSession,
  SessionRevokeReason, UpdateUserChanges, UserListItem
} from "@innovera/ocr-persistence";

/** Everything a route knows about the caller, plus the two session timestamps §5 C5 and `GET /api/auth/session` need. */
export type WebAuthContext = AuthContext & Readonly<{ sessionCreatedAt?: string | undefined; sessionExpiresAt?: string | undefined }>;

/**
 * The structural subset of `PostgresUserStore` the web uses, so tests can pass an in-memory fake (like `WorkbenchStore`).
 * Every method is tenant-scoped by the store itself; the server never chooses a tenant.
 */
export type UserStore = Readonly<{
  readonly tenantId: string;
  findLoginUser(username: string): Promise<LoginUser | null>;
  recordLoginFailure(userId: string, input: LoginFailureInput): Promise<{ locked: boolean }>;
  recordLoginSuccess(userId: string, rehash?: string): Promise<void>;
  createSession(input: CreateSessionInput): Promise<{ sessionId: string; createdAt: string; expiresAt: string }>;
  resolveSession(tokenHash: Buffer, idleMinutes: number): Promise<ResolvedSession | null>;
  touchSession(sessionId: string): Promise<void>;
  revokeSession(tokenHash: Buffer, reason: SessionRevokeReason, requestId?: string): Promise<{ revoked: boolean; userId: string | null }>;
  changeOwnPassword(userId: string, newHash: string, audit: AuditContext): Promise<{ revoked: number }>;
  listUsers(): Promise<UserListItem[]>;
  createUser(input: CreateUserInput): Promise<UserListItem>;
  updateUser(userId: string, changes: UpdateUserChanges, audit: AuditContext): Promise<UserListItem>;
  resetPassword(userId: string, newHash: string, audit: AuditContext): Promise<void>;
  unlockUser(userId: string, audit: AuditContext): Promise<void>;
  recordAudit(event: Omit<AuditEvent, "tenantId">): Promise<void>;
}>;

const JSON_BODY_LIMIT = 1_048_576;
/** §5 C7: auth and user bodies are small; a 1 MiB login body is an attack, not a mistake. */
export const AUTH_BODY_LIMIT = 4096;
const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);
/** §5 C2.4: the only two routes that answer without a session. */
export const PUBLIC_API_ROUTES: ReadonlySet<string> = new Set(["POST /api/auth/login", "POST /api/auth/logout"]);
/** §5 C2.6: what a session with `mustChangePassword` may still reach. */
export const PASSWORD_CHANGE_ROUTES: ReadonlySet<string> = new Set(["/api/auth/session", "/api/auth/password", "/api/auth/logout"]);

export function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** `extraHeaders` carries `Set-Cookie` and `Retry-After` (§5 C8); every answer stays `no-store` and `nosniff`. */
export function respond(response: ServerResponse, status: number, body: object, extraHeaders: Readonly<Record<string, string>> = {}): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...extraHeaders });
  response.end(JSON.stringify(body));
}

export function respondNoContent(response: ServerResponse, extraHeaders: Readonly<Record<string, string>> = {}): void {
  response.writeHead(204, { "cache-control": "no-store", "x-content-type-options": "nosniff", ...extraHeaders });
  response.end();
}

/**
 * §5 C2.3: a JSON route accepts a JSON content type only. Without this a cross-site form post (which can only send
 * `text/plain`, `multipart/form-data` or `application/x-www-form-urlencoded`) would still reach every handler.
 */
export async function readJson(request: IncomingMessage, limit = JSON_BODY_LIMIT): Promise<Record<string, unknown>> {
  const contentType = (headerValue(request.headers["content-type"]) ?? "").trim().toLowerCase();
  if (!contentType.startsWith("application/json")) throw new Error("UNSUPPORTED_MEDIA_TYPE");
  // A declared oversize body is refused before reading, so the client still receives the 413.
  if (Number(request.headers["content-length"] ?? 0) > limit) throw new Error("PAYLOAD_TOO_LARGE");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > limit) throw new Error("PAYLOAD_TOO_LARGE");
    chunks.push(buffer);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("INVALID_JSON"); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("INVALID_JSON");
  return parsed as Record<string, unknown>;
}

function rejectCsrf(): never {
  metrics.increment("auth_csrf_rejected_total");
  throw new Error("CSRF_REJECTED");
}

/**
 * §5 C2.1. `Sec-Fetch-Site` is set by the browser and cannot be forged by page script. `none` is a typed URL or a
 * bookmark; anything but that or `same-origin` (including `same-site`, i.e. a sibling `*.innoveraappcenter.com` app,
 * which `SameSite=Strict` does not stop) is refused. A missing header is an old client or curl, which the Origin and
 * CSRF-token layers below still have to satisfy.
 */
export function assertSecFetchSite(request: IncomingMessage): void {
  const site = headerValue(request.headers["sec-fetch-site"]);
  if (site !== undefined && site !== "same-origin" && site !== "none") rejectCsrf();
}

/**
 * §5 C2.2: every non-GET/HEAD request must name this deployment's own origin. Outside production `http://<Host>` is
 * accepted too, because dev and the tests have no https origin to configure. A request with no `Origin` at all must
 * carry `Sec-Fetch-Site: same-origin`, which only a browser on this origin can produce.
 */
export function assertOrigin(request: IncomingMessage, method: string, env: AppEnv, publicOrigin: string): void {
  if (SAFE_METHODS.has(method)) return;
  const origin = headerValue(request.headers.origin);
  if (origin === undefined || origin === "null") {
    if (headerValue(request.headers["sec-fetch-site"]) !== "same-origin") rejectCsrf();
    return;
  }
  if (publicOrigin && origin === publicOrigin) return;
  const host = headerValue(request.headers.host);
  if (env !== "production" && host && origin === `http://${host}`) return;
  rejectCsrf();
}

/** §5 C2.5: `X-CSRF-Token` must be the token derived from this session's cookie, which only same-origin script can read back. */
export function assertCsrfToken(request: IncomingMessage, method: string, env: AppEnv): void {
  if (SAFE_METHODS.has(method)) return;
  const token = readSessionCookie(headerValue(request.headers.cookie), env);
  if (!token || !verifyCsrf(token, headerValue(request.headers["x-csrf-token"]))) rejectCsrf();
}

/**
 * §5 C11. hops = 0 is the socket address, and the caller must then disable the per-IP limiter: every request carries
 * the proxy's address, so the limit would be a global switch. hops = n takes the n-th entry from the right of
 * `X-Forwarded-For`, so a forged left-hand entry is ignored. IPs are in-memory keys only; they are never logged.
 */
export function clientIp(request: IncomingMessage, hops: number): string {
  const socket = request.socket.remoteAddress ?? "unknown";
  if (hops < 1) return socket;
  const chain = (headerValue(request.headers["x-forwarded-for"]) ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  return chain.length >= hops ? chain[chain.length - hops]! : socket;
}

/** A sliding failure budget per key. Keys are bounded (oldest first), so neither IPs nor usernames can grow the process. */
export class SlidingWindow {
  readonly #windows = new Map<string, { count: number; resetAt: number }>();

  constructor(readonly limit: number, readonly windowMs: number, readonly maxKeys = 10_000) {}

  get size(): number { return this.#windows.size; }

  #current(key: string, now: number): { count: number; resetAt: number } | undefined {
    const window = this.#windows.get(key);
    return window && window.resetAt > now ? window : undefined;
  }

  blocked(key: string, now: number): boolean {
    const window = this.#current(key, now);
    return window !== undefined && window.count >= this.limit;
  }

  retryAfterSeconds(key: string, now: number): number {
    const window = this.#current(key, now);
    return window === undefined ? 1 : Math.max(1, Math.ceil((window.resetAt - now) / 1000));
  }

  record(key: string, now: number): void {
    const window = this.#current(key, now);
    if (window) { window.count += 1; return; }
    this.#windows.delete(key);
    this.#windows.set(key, { count: 1, resetAt: now + this.windowMs });
    while (this.#windows.size > this.maxKeys) this.#windows.delete(this.#windows.keys().next().value!);
  }

  reset(key: string): void { this.#windows.delete(key); }
}

export const LOGIN_WINDOW_MS = 900_000;
export const LOGIN_IP_LIMIT = 30;
export const LOGIN_USERNAME_LIMIT = 10;
export const LOGIN_UNKNOWN_LIMIT = 60;
const UNKNOWN_KEY = "*";

export type LoginThrottleOptions = Readonly<{ ipLimit?: number; usernameLimit?: number; unknownLimit?: number; windowMs?: number }>;

/**
 * D5.1–D5.3, in memory. The per-IP and per-username windows are the **only** source of a 429 a client can provoke by
 * guessing, and both key on values that say nothing about which accounts exist — which is why a database lock (D5.4)
 * answers 401 like any wrong password instead. The third window is one global budget for failures on names that match
 * no user: past it a flood stops costing a 32 MiB scrypt job each.
 */
export class LoginThrottle {
  readonly ip: SlidingWindow;
  readonly username: SlidingWindow;
  readonly unknown: SlidingWindow;

  constructor(options: LoginThrottleOptions = {}) {
    const windowMs = options.windowMs ?? LOGIN_WINDOW_MS;
    this.ip = new SlidingWindow(options.ipLimit ?? LOGIN_IP_LIMIT, windowMs);
    this.username = new SlidingWindow(options.usernameLimit ?? LOGIN_USERNAME_LIMIT, windowMs);
    this.unknown = new SlidingWindow(options.unknownLimit ?? LOGIN_UNKNOWN_LIMIT, windowMs, 1);
  }

  /** `null` when the attempt may proceed, otherwise the `Retry-After` seconds of whichever window is spent. */
  retryAfter(ip: string | null, username: string, now: number): number | null {
    const ipBlocked = ip !== null && this.ip.blocked(ip, now);
    const nameBlocked = this.username.blocked(username, now);
    if (!ipBlocked && !nameBlocked) return null;
    return Math.max(ipBlocked && ip !== null ? this.ip.retryAfterSeconds(ip, now) : 0, nameBlocked ? this.username.retryAfterSeconds(username, now) : 0);
  }

  /** C11: **every** rejected attempt counts, including `LOGIN_BUSY` and the pre-check rejection itself. */
  countIp(ip: string | null, now: number): void { if (ip !== null) this.ip.record(ip, now); }
  countUsername(username: string, now: number): void { this.username.record(username, now); }
  countUnknown(now: number): void { this.unknown.record(UNKNOWN_KEY, now); }
  unknownBudgetSpent(now: number): boolean { return this.unknown.blocked(UNKNOWN_KEY, now); }
  resetUsername(username: string): void { this.username.reset(username); }
}

/**
 * §5 C4. A missing, malformed, expired, idle, revoked or disabled session is the same `UNAUTHENTICATED`, so nothing is
 * enumerable. The idle deadline moves on user actions only: the workbench's polling sends `X-OCR-Background: 1`, which
 * authenticates without keeping an abandoned browser logged in.
 */
export function sessionAuthenticator(store: UserStore, config: Readonly<{ env: AppEnv; idleMinutes: number }>): (request: IncomingMessage) => Promise<WebAuthContext> {
  return async (request) => {
    const token = readSessionCookie(headerValue(request.headers.cookie), config.env);
    if (!token) throw new AuthenticationError("UNAUTHENTICATED");
    const session = await store.resolveSession(hashSessionToken(token), config.idleMinutes);
    if (!session) throw new AuthenticationError("UNAUTHENTICATED");
    if (headerValue(request.headers["x-ocr-background"]) !== "1") await store.touchSession(session.sessionId);
    return {
      userId: session.userId, tenantId: store.tenantId, sessionId: session.sessionId, username: session.username,
      displayName: session.displayName, role: session.role, canExport: session.canExport,
      mustChangePassword: session.mustChangePassword, sessionCreatedAt: session.createdAt, sessionExpiresAt: session.expiresAt
    };
  };
}

/** §5 C6, server-enforced. `can_export` gates the export file, not the data (D8). */
export function requiredRight(pathname: string): "admin" | "export" | null {
  if (pathname === "/api/users" || pathname.startsWith("/api/users/")) return "admin";
  if (pathname.startsWith("/api/exports/")) return "export";
  return null;
}

export function hasRight(ctx: WebAuthContext, right: "admin" | "export"): boolean {
  return right === "admin" ? ctx.role === "admin" : ctx.role === "admin" || ctx.canExport;
}
