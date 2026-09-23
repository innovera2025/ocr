import type { IncomingMessage, ServerResponse } from "node:http";
import {
  AuthenticationError, adminGate, checkPasswordPolicy, clearSessionCookie, csrfTokenFor, DUMMY_HASH, generateTemporaryPassword,
  hashPassword, hashSessionToken, loginGate, needsRehash, newSessionToken, readSessionCookie, serializeSessionCookie,
  verifyPassword, type AppEnv
} from "@innovera/ocr-auth";
import type { WebConfig } from "@innovera/ocr-config";
import { logEvent, metrics } from "@innovera/ocr-observability";
import { normalizeUsername, type AuditContext, type UpdateUserChanges, type UserRole } from "@innovera/ocr-persistence";
import {
  AUTH_BODY_LIMIT, clientIp, headerValue, readJson, respond, respondNoContent, type LoginThrottle, type UserStore, type WebAuthContext
} from "./auth.js";

export type AuthRouteDeps = Readonly<{
  store: UserStore;
  webConfig: WebConfig;
  env: AppEnv;
  throttle: LoginThrottle;
  /** 0 disables the per-IP window (§5 C11); the login route keys on `null` then. */
  hops: number;
  now: () => number;
  /** The server-minted trace id (§4 B4), which is what every audit row and every log line carries. */
  traceId: string;
}>;

const USERNAME_MAX_LENGTH = 64;
const PASSWORD_MAX_BYTES = 512;
/** D5.3: past the unknown-name budget the answer costs a fixed wait instead of a 32 MiB scrypt job. */
const UNKNOWN_NAME_DELAY_MS = 250;
/** §5 C5: a forced-change session may skip the password the user typed seconds ago. */
const FORCED_CHANGE_GRACE_MS = 300_000;
export const LOGIN_BUSY_RETRY_SECONDS = 5;

type SessionUser = Readonly<{ id: string; username: string; displayName: string; role: UserRole; canExport: boolean; mustChangePassword: boolean }>;

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : ""; }
function delay(ms: number): Promise<void> { return new Promise((resolve) => { setTimeout(resolve, ms); }); }

/** The one shape `POST /api/auth/login`, `GET /api/auth/session` and `POST /api/auth/password` all answer with. */
function sessionPayload(user: SessionUser, token: string, deps: AuthRouteDeps, expiresAt: string): object {
  return { user, csrfToken: csrfTokenFor(token), idleMinutes: deps.webConfig.sessionIdleMinutes, expiresAt };
}

/**
 * Opens a session for an already-authenticated user (login and password change), so neither path can forget a step.
 * `login` is false for the password change: its outcome is `password.changed` alone (§5 C5), it moves no
 * `auth_logins_total{result="success"}`, and neither the audit row nor the stdout mirror (§6 D9) may claim a login
 * that never happened — the two trails have to agree for either to be worth reading.
 */
async function openSession(response: ServerResponse, user: SessionUser, deps: AuthRouteDeps, login: boolean): Promise<void> {
  const token = newSessionToken();
  const session = await deps.store.createSession({
    userId: user.id, tokenHash: hashSessionToken(token), absoluteHours: deps.webConfig.sessionAbsoluteHours,
    audit: { actorUserId: user.id, requestId: deps.traceId }, auditLogin: login
  });
  if (login) logEvent("login_succeeded", { trace_id: deps.traceId, user_id: user.id, session_id: session.sessionId });
  respond(response, 200, sessionPayload(user, token, deps, session.expiresAt), { "set-cookie": serializeSessionCookie(deps.env, token) });
}

async function revokeCookieSession(request: IncomingMessage, deps: AuthRouteDeps, reason: "relogin"): Promise<void> {
  const token = readSessionCookie(headerValue(request.headers.cookie), deps.env);
  if (!token) return;
  const { revoked } = await deps.store.revokeSession(hashSessionToken(token), reason);
  if (revoked) metrics.increment("auth_sessions_revoked_total", { reason });
}

/**
 * §5 C3. Every rejection is the same 401 with the same body and the same headers: an unknown name, a wrong password, a
 * locked account and a disabled account are indistinguishable, and the 401 is written to the socket **before** any
 * database write is awaited, so a known name does not take measurably longer than one that matches no row.
 */
async function login(request: IncomingMessage, response: ServerResponse, deps: AuthRouteDeps): Promise<void> {
  const { store, throttle } = deps;
  const body = await readJson(request, AUTH_BODY_LIMIT);
  const rawUsername = body.username;
  const password = body.password;
  if (typeof rawUsername !== "string" || typeof password !== "string" || rawUsername.length > USERNAME_MAX_LENGTH
    || Buffer.byteLength(password, "utf8") > PASSWORD_MAX_BYTES) throw new Error("INVALID_LOGIN");
  // There is no format error: a name that cannot exist simply finds no user (§5 C3.2).
  const username = normalizeUsername(rawUsername);
  const ip = deps.hops >= 1 ? clientIp(request, deps.hops) : null;
  const at = deps.now();

  const retryAfter = throttle.retryAfter(ip, username, at);
  if (retryAfter !== null) {
    throttle.countIp(ip, at);
    metrics.increment("auth_logins_total", { result: "throttled" });
    logEvent("login_failed", { trace_id: deps.traceId, reason: "throttled" });
    respond(response, 429, { error: "LOGIN_THROTTLED" }, { "retry-after": String(retryAfter) });
    return;
  }

  // D5.2, **before** the ~250 ms verify and before the gate: `retryAfter` above and this `record` are one synchronous
  // step, so concurrent attempts on one name cannot all read a zero counter while the first hash is still running.
  // A success clears the window again (step 9), so a staff member who finally types the right password is unaffected.
  throttle.countUsername(username, at);

  const user = await store.findLoginUser(username);
  let verified = false;
  let rehash: string | undefined;
  const budgetSpent = user === null && throttle.unknownBudgetSpent(at);
  // D5.3 is read before it is spent, so the budget still buys exactly `unknownLimit` hashes; counting it here rather
  // than on the failure path means a `LOGIN_BUSY` on a made-up name also counts against it.
  if (user === null) throttle.countUnknown(at);
  if (budgetSpent) {
    // The budget sits in front of `loginGate` (§4 B1), so a flood of made-up names stops costing a hash each.
    await delay(UNKNOWN_NAME_DELAY_MS);
  } else {
    const stored = user?.passwordHash ?? DUMMY_HASH;
    try {
      // One gate acquisition covers the verify and the optional rehash; hashing never holds a database transaction.
      const result = await loginGate.run(async () => {
        const ok = await verifyPassword(stored, password);
        return { ok, rehash: ok && user !== null && needsRehash(stored) ? await hashPassword(password) : undefined };
      });
      verified = result.ok;
      rehash = result.rehash;
    } catch (error) {
      if (errorMessage(error) !== "LOGIN_BUSY") throw error;
      throttle.countIp(ip, at);
      metrics.increment("auth_logins_total", { result: "busy" });
      respond(response, 429, { error: "LOGIN_BUSY" }, { "retry-after": String(LOGIN_BUSY_RETRY_SECONDS) });
      return;
    }
  }

  const locked = user !== null && user.lockedUntil !== null && Date.parse(user.lockedUntil) > at;
  const reason = user === null ? "unknown_user" : !verified ? "bad_password" : locked ? "locked" : user.disabledAt !== null ? "disabled" : null;
  if (user === null || reason !== null) {
    throttle.countIp(ip, at);
    metrics.increment("auth_logins_total", { result: "invalid" });
    respond(response, 401, { error: "INVALID_CREDENTIALS" });
    if (user === null) {
      // Failures for unknown usernames write no database row, so random names cannot flood the tables.
      logEvent("login_failed", { trace_id: deps.traceId, reason: "unknown_user" });
      return;
    }
    const failed = user;
    const failureReason = reason ?? "bad_password";
    void store.recordLoginFailure(failed.id, { reason: failureReason, audit: { actorUserId: failed.id, requestId: deps.traceId } })
      .then(({ locked: lockedNow }) => { logEvent("login_failed", { trace_id: deps.traceId, user_id: failed.id, reason: failureReason, locked: lockedNow }); })
      .catch((error: unknown) => { logEvent("audit_write_failed", { trace_id: deps.traceId, action: "login.failed", error: errorMessage(error).slice(0, 120) }); });
    return;
  }

  // Revealed only after a correct password, and it does not count as a failure (§5 C3.8) — but it is not a success
  // either: the username window keeps the attempt it counted above and the IP window counts it too, so a consumed
  // temporary password (D6 leaves it in the row on purpose) cannot buy an unlimited number of 32 MiB hashes.
  if (user.passwordExpiresAt !== null && Date.parse(user.passwordExpiresAt) <= at) {
    throttle.countIp(ip, at);
    metrics.increment("auth_logins_total", { result: "expired" });
    respond(response, 401, { error: "PASSWORD_EXPIRED" });
    return;
  }

  throttle.resetUsername(username);
  await store.recordLoginSuccess(user.id, rehash);
  await revokeCookieSession(request, deps, "relogin");
  metrics.increment("auth_logins_total", { result: "success" });
  await openSession(response, {
    id: user.id, username: user.username, displayName: user.displayName, role: user.role, canExport: user.canExport,
    mustChangePassword: user.mustChangePassword
  }, deps, true);
}

/**
 * §5 C5: idempotent, needs no CSRF token, and always answers 204 with the clearing cookie. It is the one route that
 * touches the database with no session, so it is **one** statement: the revoking UPDATE returns the session and its
 * user, which is everything the audit row and the log line need.
 */
async function logout(request: IncomingMessage, response: ServerResponse, deps: AuthRouteDeps): Promise<void> {
  const token = readSessionCookie(headerValue(request.headers.cookie), deps.env);
  if (token) {
    const { revoked, userId } = await deps.store.revokeSession(hashSessionToken(token), "logout", deps.traceId);
    if (revoked) {
      metrics.increment("auth_sessions_revoked_total", { reason: "logout" });
      logEvent("logout", { trace_id: deps.traceId, ...(userId ? { user_id: userId } : {}) });
    }
  }
  respondNoContent(response, { "set-cookie": clearSessionCookie(deps.env) });
}

function contextUser(ctx: WebAuthContext): SessionUser {
  return { id: ctx.userId, username: ctx.username, displayName: ctx.displayName, role: ctx.role, canExport: ctx.canExport, mustChangePassword: ctx.mustChangePassword };
}

function currentSession(request: IncomingMessage, response: ServerResponse, ctx: WebAuthContext, deps: AuthRouteDeps): void {
  const token = readSessionCookie(headerValue(request.headers.cookie), deps.env);
  if (!token) throw new AuthenticationError("UNAUTHENTICATED");
  respond(response, 200, sessionPayload(contextUser(ctx), token, deps, ctx.sessionExpiresAt ?? ""));
}

/**
 * §5 C5. A wrong current password is 400 `PASSWORD_INCORRECT`, not 401, so the re-login overlay does not open on top of
 * the dialog; it still counts toward the account lock. The change revokes every session of the user, including this
 * one, and the reply opens a fresh session.
 */
async function changePassword(request: IncomingMessage, response: ServerResponse, ctx: WebAuthContext, deps: AuthRouteDeps): Promise<void> {
  const body = await readJson(request, AUTH_BODY_LIMIT);
  const newPassword = body.newPassword;
  const currentPassword = body.currentPassword;
  if (typeof newPassword !== "string" || Buffer.byteLength(newPassword, "utf8") > PASSWORD_MAX_BYTES
    || (currentPassword !== undefined && typeof currentPassword !== "string")) throw new Error("INVALID_LOGIN");
  const user = await deps.store.findLoginUser(ctx.username);
  if (user === null) throw new AuthenticationError("UNAUTHENTICATED");

  const createdAt = Date.parse(ctx.sessionCreatedAt ?? "");
  const withinGrace = ctx.mustChangePassword && Number.isFinite(createdAt) && deps.now() < createdAt + FORCED_CHANGE_GRACE_MS;
  if (currentPassword === undefined && !withinGrace) throw new Error("PASSWORD_INCORRECT");
  checkPasswordPolicy(newPassword, user.username);

  // One `adminGate` slot for the whole check: three separate acquisitions would queue two concurrent changes out.
  const outcome = await adminGate.run(async (): Promise<{ error: string } | { hash: string }> => {
    if (currentPassword !== undefined && !await verifyPassword(user.passwordHash, currentPassword)) return { error: "PASSWORD_INCORRECT" };
    if (await verifyPassword(user.passwordHash, newPassword)) return { error: "PASSWORD_UNCHANGED" };
    return { hash: await hashPassword(newPassword) };
  });
  if ("error" in outcome) {
    if (outcome.error === "PASSWORD_INCORRECT") {
      await deps.store.recordLoginFailure(user.id, { reason: "password_change", audit: { actorUserId: user.id, sessionId: ctx.sessionId, requestId: deps.traceId } });
    }
    throw new Error(outcome.error);
  }

  const { revoked } = await deps.store.changeOwnPassword(user.id, outcome.hash, { actorUserId: user.id, sessionId: ctx.sessionId, requestId: deps.traceId });
  if (revoked > 0) metrics.increment("auth_sessions_revoked_total", { reason: "password_changed" }, revoked);
  logEvent("password_changed", { trace_id: deps.traceId, user_id: user.id, revoked });
  await openSession(response, { ...contextUser(ctx), displayName: user.displayName, role: user.role, canExport: user.canExport, mustChangePassword: false }, deps, false);
}

const CREATE_KEYS: ReadonlySet<string> = new Set(["username", "displayName", "role", "canExport"]);
const UPDATE_KEYS: ReadonlySet<string> = new Set(["displayName", "role", "canExport", "disabled"]);

/** Unknown keys are refused (§5 C7): a typo silently doing nothing is worse than a 400 on an admin screen. */
function assertKnownKeys(body: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(body)) if (!allowed.has(key)) throw new Error("USER_INVALID");
}

function parseUserUpdate(body: Record<string, unknown>): UpdateUserChanges {
  assertKnownKeys(body, UPDATE_KEYS);
  const changes: { displayName?: string; role?: UserRole; canExport?: boolean; disabled?: boolean } = {};
  if (body.displayName !== undefined) {
    if (typeof body.displayName !== "string") throw new Error("INVALID_DISPLAY_NAME");
    changes.displayName = body.displayName;
  }
  if (body.role !== undefined) {
    if (typeof body.role !== "string") throw new Error("INVALID_ROLE");
    changes.role = body.role as UserRole;
  }
  if (body.canExport !== undefined) {
    if (typeof body.canExport !== "boolean") throw new Error("USER_INVALID");
    changes.canExport = body.canExport;
  }
  if (body.disabled !== undefined) {
    if (typeof body.disabled !== "boolean") throw new Error("USER_INVALID");
    changes.disabled = body.disabled;
  }
  if (Object.keys(changes).length === 0) throw new Error("USER_INVALID");
  return changes;
}

function auditFor(ctx: WebAuthContext, deps: AuthRouteDeps): AuditContext {
  return { actorUserId: ctx.userId, sessionId: ctx.sessionId, requestId: deps.traceId };
}

function logUserAdmin(action: string, ctx: WebAuthContext, targetUserId: string, deps: AuthRouteDeps): void {
  metrics.increment("user_admin_total", { action });
  logEvent("user_admin", { trace_id: deps.traceId, action, actor_user_id: ctx.userId, target_user_id: targetUserId });
}

/** §5 C7, admin only (the permission gate ran before this). The temporary password lives in one `no-store` body. */
async function handleUsers(request: IncomingMessage, response: ServerResponse, pathname: string, method: string,
  ctx: WebAuthContext, deps: AuthRouteDeps): Promise<boolean> {
  const { store } = deps;
  if (pathname === "/api/users" && method === "GET") {
    respond(response, 200, { users: await store.listUsers() });
    return true;
  }
  if (pathname === "/api/users" && method === "POST") {
    const body = await readJson(request, AUTH_BODY_LIMIT);
    assertKnownKeys(body, CREATE_KEYS);
    if (typeof body.username !== "string") throw new Error("INVALID_USERNAME");
    if (typeof body.displayName !== "string") throw new Error("INVALID_DISPLAY_NAME");
    if (typeof body.role !== "string") throw new Error("INVALID_ROLE");
    if (body.canExport !== undefined && typeof body.canExport !== "boolean") throw new Error("USER_INVALID");
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await adminGate.run(() => hashPassword(temporaryPassword));
    const user = await store.createUser({
      username: body.username, displayName: body.displayName, role: body.role as UserRole,
      canExport: body.canExport === true, passwordHash, audit: auditFor(ctx, deps)
    });
    logUserAdmin("user.created", ctx, user.id, deps);
    respond(response, 201, { user, temporaryPassword });
    return true;
  }
  const match = /^\/api\/users\/([^/]+)(\/reset-password|\/unlock)?$/.exec(pathname);
  if (!match || method !== "POST") return false;
  const targetId = match[1]!.toLowerCase();
  const suffix = match[2] ?? "";
  // §5 C6: a self reset or unlock revokes your own session and hides the one-time password behind the login dialog.
  if (suffix !== "" && targetId === ctx.userId) throw new Error("CANNOT_CHANGE_SELF");
  if (suffix === "/reset-password") {
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await adminGate.run(() => hashPassword(temporaryPassword));
    await store.resetPassword(targetId, passwordHash, auditFor(ctx, deps));
    metrics.increment("auth_sessions_revoked_total", { reason: "admin_reset" });
    logUserAdmin("user.password_reset", ctx, targetId, deps);
    respond(response, 200, { temporaryPassword });
    return true;
  }
  if (suffix === "/unlock") {
    // The store clears the database lock; the in-memory username window is this route's job (§5 C7).
    const target = (await store.listUsers()).find((item) => item.id === targetId);
    if (!target) throw new Error("USER_NOT_FOUND");
    await store.unlockUser(targetId, auditFor(ctx, deps));
    deps.throttle.resetUsername(target.username);
    logUserAdmin("user.unlocked", ctx, targetId, deps);
    respondNoContent(response);
    return true;
  }
  const changes = parseUserUpdate(await readJson(request, AUTH_BODY_LIMIT));
  if (targetId === ctx.userId && (changes.role !== undefined || changes.disabled !== undefined)) throw new Error("CANNOT_CHANGE_SELF");
  const user = await store.updateUser(targetId, changes, auditFor(ctx, deps));
  if (changes.disabled === true) metrics.increment("auth_sessions_revoked_total", { reason: "disabled" });
  logUserAdmin("user.updated", ctx, targetId, deps);
  respond(response, 200, { user });
  return true;
}

/** Returns false when no auth or users route matched, so the caller falls through to the workbench routes. */
export async function handleAuthRoutes(request: IncomingMessage, response: ServerResponse, pathname: string, method: string,
  ctx: WebAuthContext | null, deps: AuthRouteDeps): Promise<boolean> {
  const action = `${method} ${pathname}`;
  if (action === "POST /api/auth/login") { await login(request, response, deps); return true; }
  if (action === "POST /api/auth/logout") { await logout(request, response, deps); return true; }
  if (ctx === null) return false;
  if (action === "GET /api/auth/session") { currentSession(request, response, ctx, deps); return true; }
  if (action === "POST /api/auth/password") { await changePassword(request, response, ctx, deps); return true; }
  if (pathname === "/api/users" || pathname.startsWith("/api/users/")) return handleUsers(request, response, pathname, method, ctx, deps);
  return false;
}
