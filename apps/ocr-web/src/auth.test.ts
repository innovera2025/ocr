import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { Server } from "node:http";
import { csrfTokenFor, DUMMY_HASH, hashPassword, loginGate, SCRYPT_PARAMS, type ScryptParams } from "@innovera/ocr-auth";
import type { WebConfig } from "@innovera/ocr-config";
import type { AuditEvent, CreateSessionInput, CreateUserInput, LoginFailureInput, LoginUser, ResolvedSession, SessionRevokeReason, UpdateUserChanges, UserListItem, UserRole } from "@innovera/ocr-persistence";
import { clientIp, LoginThrottle, SlidingWindow, type UserStore } from "./auth.js";
import type { ExportStore } from "./export.js";
import { createAppServer, errorStatus, routeLabel, type WorkbenchStore } from "./server.js";

// ---- stdout capture (the whole file: no secret may ever reach a log line) ----------------------

const captured: string[] = [];
const writeThrough = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
  captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
  return (writeThrough as (...args: unknown[]) => boolean)(chunk, ...rest);
}) as typeof process.stdout.write;

// ---- fixtures ---------------------------------------------------------------------------------

const tenant = "00000000-0000-0000-0000-000000000001";
const ownerId = "00000000-0000-4000-8000-000000000001";
const clerkId = "00000000-0000-4000-8000-000000000002";
const exporterId = "00000000-0000-4000-8000-000000000003";
const secondOwnerId = "00000000-0000-4000-8000-000000000004";
const unknownUserId = "00000000-0000-4000-8000-0000000000ff";
/** Obviously fake, and never a real password: these strings exist only inside this test process. */
const OWNER_PASSWORD = "fake-owner-pass-01";
const CLERK_PASSWORD = "fake-clerk-pass-02";
const NEW_PASSWORD = "fake-brand-new-pass-03";
/** The cheapest parameters `verifyPassword` accepts, so a test that is not about timing costs ~40 ms a hash. */
const FAST: ScryptParams = { N: 16_384, r: 8, p: 1 };

const fastOwnerHash = await hashPassword(OWNER_PASSWORD, FAST);
const fastClerkHash = await hashPassword(CLERK_PASSWORD, FAST);
const realClerkHash = await hashPassword(CLERK_PASSWORD, SCRYPT_PARAMS);

/** Every one-time password this file is handed, so the closing test can prove none of them reached stdout. */
const issuedTemporary: string[] = [];
const START = Date.parse("2026-09-23T08:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

// ---- an in-memory user store ------------------------------------------------------------------

type FakeUser = {
  id: string; username: string; displayName: string; role: UserRole; canExport: boolean; passwordHash: string;
  mustChangePassword: boolean; passwordExpiresAt: number | null; failedLogins: number; lockedUntil: number | null;
  disabledAt: number | null; lastLoginAt: number | null; createdAt: number;
};
type FakeSession = { id: string; userId: string; createdAt: number; lastSeenAt: number; expiresAt: number; revokedAt: number | null; reason: string | null };

/** Mirrors `PostgresUserStore` closely enough for the route logic: the lock arithmetic and the revocations are the point. */
class FakeUserStore implements UserStore {
  readonly users: FakeUser[] = [];
  readonly sessions = new Map<string, FakeSession>();
  readonly audits: Omit<AuditEvent, "tenantId">[] = [];
  #sessions = 0;

  constructor(readonly tenantId: string, private readonly clock: { now: number }) {}

  add(user: Partial<FakeUser> & Pick<FakeUser, "id" | "username" | "passwordHash">): FakeUser {
    const row: FakeUser = {
      displayName: user.username, role: "staff", canExport: false, mustChangePassword: false, passwordExpiresAt: null,
      failedLogins: 0, lockedUntil: null, disabledAt: null, lastLoginAt: null, createdAt: this.clock.now, ...user
    };
    this.users.push(row);
    return row;
  }

  find(userId: string): FakeUser {
    const user = this.users.find((row) => row.id === userId);
    if (!user) throw new Error("USER_NOT_FOUND");
    return user;
  }

  #record(event: Omit<AuditEvent, "tenantId">): void { this.audits.push(event); }

  actions(): string[] { return this.audits.map((event) => event.action); }

  async findLoginUser(username: string): Promise<LoginUser | null> {
    const user = this.users.find((row) => row.username === username.normalize("NFKC").trim().toLowerCase());
    if (!user) return null;
    return {
      id: user.id, username: user.username, displayName: user.displayName, role: user.role, canExport: user.canExport,
      passwordHash: user.passwordHash, mustChangePassword: user.mustChangePassword,
      passwordExpiresAt: user.passwordExpiresAt === null ? null : iso(user.passwordExpiresAt),
      lockedUntil: user.lockedUntil === null ? null : iso(user.lockedUntil),
      disabledAt: user.disabledAt === null ? null : iso(user.disabledAt)
    };
  }

  async recordLoginFailure(userId: string, input: LoginFailureInput): Promise<{ locked: boolean }> {
    const user = this.find(userId);
    const max = input.max ?? 10;
    const minutes = input.lockMinutes ?? 15;
    const next = user.failedLogins + 1;
    const trips = next >= max;
    user.failedLogins = trips ? 0 : next;
    if (trips) user.lockedUntil = this.clock.now + minutes * 60_000;
    const locked = trips && user.lockedUntil !== null && user.lockedUntil > this.clock.now;
    this.#record({ ...input.audit, action: "login.failed", outcome: "failure", targetType: "user", targetId: userId, detail: { reason: input.reason } });
    if (locked) this.#record({ ...input.audit, action: "login.locked", outcome: "failure", targetType: "user", targetId: userId });
    return { locked };
  }

  async recordLoginSuccess(userId: string, rehash?: string): Promise<void> {
    const user = this.find(userId);
    user.failedLogins = 0;
    user.lockedUntil = null;
    user.lastLoginAt = this.clock.now;
    if (rehash !== undefined) user.passwordHash = rehash;
    if (user.mustChangePassword) user.passwordExpiresAt = this.clock.now;
  }

  async createSession(input: CreateSessionInput): Promise<{ sessionId: string; createdAt: string; expiresAt: string }> {
    this.#sessions += 1;
    const id = `00000000-0000-4000-9000-${String(this.#sessions).padStart(12, "0")}`;
    const session: FakeSession = {
      id, userId: input.userId, createdAt: this.clock.now, lastSeenAt: this.clock.now,
      expiresAt: this.clock.now + input.absoluteHours * 3_600_000, revokedAt: null, reason: null
    };
    this.sessions.set(input.tokenHash.toString("hex"), session);
    if (input.auditLogin !== false) this.#record({ ...input.audit, sessionId: id, action: "login.succeeded", targetType: "user", targetId: input.userId });
    return { sessionId: id, createdAt: iso(session.createdAt), expiresAt: iso(session.expiresAt) };
  }

  async resolveSession(tokenHash: Buffer, idleMinutes: number): Promise<ResolvedSession | null> {
    const session = this.sessions.get(tokenHash.toString("hex"));
    if (!session || session.revokedAt !== null || session.expiresAt <= this.clock.now) return null;
    if (session.lastSeenAt <= this.clock.now - idleMinutes * 60_000) return null;
    const user = this.users.find((row) => row.id === session.userId);
    if (!user || user.disabledAt !== null) return null;
    return {
      sessionId: session.id, userId: user.id, username: user.username, displayName: user.displayName, role: user.role,
      canExport: user.canExport, mustChangePassword: user.mustChangePassword, createdAt: iso(session.createdAt),
      lastSeenAt: iso(session.lastSeenAt), expiresAt: iso(session.expiresAt)
    };
  }

  async touchSession(sessionId: string): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.id === sessionId && session.revokedAt === null && session.lastSeenAt < this.clock.now - 60_000) session.lastSeenAt = this.clock.now;
    }
  }

  async revokeSession(tokenHash: Buffer, reason: SessionRevokeReason, requestId?: string): Promise<{ revoked: boolean; userId: string | null }> {
    const session = this.sessions.get(tokenHash.toString("hex"));
    if (!session || session.revokedAt !== null) return { revoked: false, userId: null };
    session.revokedAt = this.clock.now;
    session.reason = reason;
    if (reason === "logout") {
      this.#record({ actorUserId: session.userId, sessionId: session.id, requestId, action: "session.logout", targetType: "user", targetId: session.userId });
    }
    return { revoked: true, userId: session.userId };
  }

  #revokeAll(userId: string, reason: SessionRevokeReason): number {
    let revoked = 0;
    for (const session of this.sessions.values()) {
      if (session.userId === userId && session.revokedAt === null) { session.revokedAt = this.clock.now; session.reason = reason; revoked += 1; }
    }
    return revoked;
  }

  async changeOwnPassword(userId: string, newHash: string, audit: { actorUserId: string | null }): Promise<{ revoked: number }> {
    const user = this.find(userId);
    user.passwordHash = newHash;
    user.mustChangePassword = false;
    user.passwordExpiresAt = null;
    const revoked = this.#revokeAll(userId, "password_changed");
    this.#record({ ...audit, action: "password.changed", targetType: "user", targetId: userId });
    return { revoked };
  }

  #item(user: FakeUser): UserListItem {
    const status = user.disabledAt !== null ? "disabled" : user.lockedUntil !== null && user.lockedUntil > this.clock.now ? "locked"
      : user.mustChangePassword ? "must_change" : "active";
    return {
      id: user.id, username: user.username, displayName: user.displayName, role: user.role, canExport: user.canExport,
      status, lockedUntil: user.lockedUntil === null ? null : iso(user.lockedUntil),
      lastLoginAt: user.lastLoginAt === null ? null : iso(user.lastLoginAt), createdAt: iso(user.createdAt)
    };
  }

  async listUsers(): Promise<UserListItem[]> { return this.users.map((user) => this.#item(user)); }

  async createUser(input: CreateUserInput): Promise<UserListItem> {
    const username = input.username.normalize("NFKC").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) throw new Error("INVALID_USERNAME");
    if (this.users.some((row) => row.username === username)) throw new Error("USERNAME_TAKEN");
    if (input.role !== "admin" && input.role !== "staff") throw new Error("INVALID_ROLE");
    const user = this.add({
      id: `00000000-0000-4000-8000-${String(this.users.length + 100).padStart(12, "0")}`, username,
      displayName: input.displayName, role: input.role, canExport: input.canExport === true,
      passwordHash: input.passwordHash, mustChangePassword: input.temporary !== false,
      passwordExpiresAt: input.temporary === false ? null : this.clock.now + 72 * 3_600_000
    });
    this.#record({ ...input.audit, action: "user.created", targetType: "user", targetId: user.id });
    return this.#item(user);
  }

  async updateUser(userId: string, changes: UpdateUserChanges, audit: { actorUserId: string | null }): Promise<UserListItem> {
    const user = this.find(userId);
    const admins = this.users.filter((row) => row.role === "admin" && row.disabledAt === null).map((row) => row.id);
    if ((changes.role === "staff" || changes.disabled === true) && admins.includes(userId) && admins.length <= 1) throw new Error("LAST_ADMIN");
    if (changes.displayName !== undefined) user.displayName = changes.displayName;
    if (changes.role !== undefined) user.role = changes.role;
    if (changes.canExport !== undefined) user.canExport = changes.canExport;
    if (changes.disabled !== undefined) user.disabledAt = changes.disabled ? user.disabledAt ?? this.clock.now : null;
    if (changes.disabled === true) this.#revokeAll(userId, "disabled");
    this.#record({ ...audit, action: "user.updated", targetType: "user", targetId: userId });
    return this.#item(user);
  }

  async resetPassword(userId: string, newHash: string, audit: { actorUserId: string | null }): Promise<void> {
    const user = this.find(userId);
    user.passwordHash = newHash;
    user.mustChangePassword = true;
    user.passwordExpiresAt = this.clock.now + 72 * 3_600_000;
    user.failedLogins = 0;
    user.lockedUntil = null;
    this.#revokeAll(userId, "admin_reset");
    this.#record({ ...audit, action: "user.password_reset", targetType: "user", targetId: userId });
  }

  async unlockUser(userId: string, audit: { actorUserId: string | null }): Promise<void> {
    const user = this.find(userId);
    user.failedLogins = 0;
    user.lockedUntil = null;
    this.#record({ ...audit, action: "user.unlocked", targetType: "user", targetId: userId });
  }

  async recordAudit(event: Omit<AuditEvent, "tenantId">): Promise<void> { this.#record(event); }
}

// ---- harness ----------------------------------------------------------------------------------

const workbenchStore: WorkbenchStore = {
  createBatch: async () => ({ batchId: "10000000-0000-4000-8000-000000000001" }),
  getBatch: async () => null,
  listBatches: async () => [],
  listDocuments: async () => ({ total: 0, documents: [] }),
  retryDocument: async () => ({ jobId: "40000000-0000-4000-8000-000000000004" }),
  saveReview: async () => ({ corrections: 0, delivery: "NOT_REQUIRED", document: {} })
};

/** Records what a workbench route passes the store, so the attribution case can read the audit context back (§6 D9). */
function recordingWorkbenchStore(): WorkbenchStore & { readonly batches: unknown[] } {
  const batches: unknown[] = [];
  return { ...workbenchStore, batches, createBatch: async (_tenantId, input) => { batches.push(input); return { batchId: "10000000-0000-4000-8000-000000000001" }; } };
}

/** An empty tenant: enough for the permission cases, which are about who reaches the routes, not what comes back. */
const emptyExportStore: ExportStore = {
  previewExport: async () => ({ total: 0, documents: [] }),
  openExport: async () => ({ total: 0, rows: async function* () { /* no rows */ }, close: async () => undefined })
};

const baseWebConfig: WebConfig = { tenantId: tenant, publicBaseUrl: "", publicOrigin: "", sessionIdleMinutes: 30, sessionAbsoluteHours: 12, exportMaxRows: 50_000 };

type HarnessOptions = Readonly<{
  webConfig?: Partial<WebConfig>;
  hops?: number;
  throttle?: LoginThrottle;
  production?: boolean;
  seed?: (store: FakeUserStore) => void;
  clerkHash?: string;
  workbenchStore?: WorkbenchStore;
  exportStore?: ExportStore;
}>;

type Harness = Readonly<{ app: Server; store: FakeUserStore; clock: { now: number }; throttle: LoginThrottle }>;

function harness(options: HarnessOptions = {}): Harness {
  const clock = { now: START };
  const store = new FakeUserStore(tenant, clock);
  store.add({ id: ownerId, username: "owner1", displayName: "เจ้าของ", role: "admin", passwordHash: fastOwnerHash });
  store.add({ id: clerkId, username: "clerk1", displayName: "พนักงาน", role: "staff", passwordHash: options.clerkHash ?? fastClerkHash });
  store.add({ id: exporterId, username: "clerk2", displayName: "พนักงานส่งออก", role: "staff", canExport: true, passwordHash: fastClerkHash });
  options.seed?.(store);
  const throttle = options.throttle ?? new LoginThrottle();
  const previous = { ...process.env };
  process.env.OCR_TRUSTED_PROXY_HOPS = String(options.hops ?? 0);
  if (options.production) {
    process.env.OCR_ENV = "production";
    process.env.AUTH_JWT_SECRETS = "fake-jwt-policy-value";
    process.env.AUTH_JWT_ISSUER = "https://issuer.test";
    process.env.AUTH_JWT_AUDIENCE = "ocr-test";
  }
  try {
    const app = createAppServer(
      { ingest: { stage: async () => "key", scan: async () => "CLEAN", enqueue: async () => "job" }, workbenchStore: options.workbenchStore ?? workbenchStore, userStore: store, exportStore: options.exportStore ?? emptyExportStore },
      {
        webConfig: { ...baseWebConfig, ...(options.production ? { publicBaseUrl: "https://ocr.test", publicOrigin: "https://ocr.test" } : {}), ...options.webConfig },
        loginThrottle: throttle, clock: () => clock.now
      }
    );
    return { app, store, clock, throttle };
  } finally {
    for (const key of ["OCR_TRUSTED_PROXY_HOPS", "OCR_ENV", "AUTH_JWT_SECRETS", "AUTH_JWT_ISSUER", "AUTH_JWT_AUDIENCE"]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

async function withServer(h: Harness, run: (base: string) => Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => { h.app.listen(0, "127.0.0.1", resolve); });
  try { await run(`http://127.0.0.1:${(h.app.address() as { port: number }).port}`); }
  finally { await new Promise<void>((resolve, reject) => { h.app.close((error) => error ? reject(error) : resolve()); }); }
}

const sameOrigin = { "sec-fetch-site": "same-origin" } as const;
const jsonHeaders = { ...sameOrigin, "content-type": "application/json" } as const;

function login(base: string, username: string, password: string, extra: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/api/auth/login`, { method: "POST", headers: { ...jsonHeaders, ...extra }, body: JSON.stringify({ username, password }) });
}

function sessionCookie(response: Response): string {
  const header = response.headers.getSetCookie().find((value) => value.startsWith("ocr_session=") || value.startsWith("__Host-ocr_session="));
  assert.ok(header, "a session cookie was set");
  return header.slice(header.indexOf("=") + 1).split(";")[0]!;
}

function authHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { cookie: `ocr_session=${token}`, ...sameOrigin, "x-csrf-token": csrfTokenFor(token), ...extra };
}

const body = async (response: Response): Promise<Record<string, unknown>> => await response.json() as Record<string, unknown>;

async function expectError(response: Response, status: number, error: string): Promise<void> {
  assert.equal(response.status, status, `expected ${status} ${error}`);
  assert.deepEqual(await body(response), { error });
}

/** Everything a client can observe apart from the two values that are unique per request. */
const fingerprint = (response: Response, text: string) =>
  `${response.status}\n${[...response.headers].filter(([key]) => key !== "x-request-id" && key !== "date").map(([key, value]) => `${key}: ${value}`).sort().join("\n")}\n${text}`;

async function signedIn(base: string, username: string, password: string): Promise<string> {
  const response = await login(base, username, password);
  assert.equal(response.status, 200, `login for ${username} succeeds`);
  return sessionCookie(response);
}

const tick = () => new Promise((resolve) => { setTimeout(resolve, 20); });

// ---- the removed token route --------------------------------------------------------------------

test("the public token route and every Bearer path are gone", async () => {
  const source = readFileSync(fileURLToPath(new URL("./server.ts", import.meta.url)), "utf8");
  assert.doesNotMatch(source, /createHmac\(/, "server.ts mints no JWT");
  assert.doesNotMatch(source, /mintWebJwt/, "the token minter is deleted");
  assert.doesNotMatch(source, /authenticateBearer/, "the web never verifies a Bearer token");
  const h = harness();
  await withServer(h, async (base) => {
    const token = await signedIn(base, "clerk1", CLERK_PASSWORD);
    for (const method of ["GET", "POST"]) {
      const response = await fetch(`${base}/api/web-token`, { method, headers: { ...authHeaders(token), "content-type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) });
      assert.equal(response.status, 404, `${method} /api/web-token`);
      assert.deepEqual(await body(response), { status: "not_found" });
    }
    // A structurally valid HS256 token is not a credential any more.
    const claims = Buffer.from(JSON.stringify({ sub: clerkId, organization_id: tenant, exp: Math.floor(Date.now() / 1000) + 900 })).toString("base64url");
    const head = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const jwt = `${head}.${claims}.${createHmac("sha256", "fake-jwt-policy-value").update(`${head}.${claims}`).digest("base64url")}`;
    await expectError(await fetch(`${base}/api/documents`, { headers: { authorization: `Bearer ${jwt}` } }), 401, "UNAUTHENTICATED");
  });
});

// ---- login ---------------------------------------------------------------------------------------

test("login sets a __Host- session cookie with no Max-Age and the cookie then works", async () => {
  const h = harness({ production: true });
  await withServer(h, async (base) => {
    const response = await login(base, "clerk1", CLERK_PASSWORD, { origin: "https://ocr.test" });
    assert.equal(response.status, 200);
    const cookie = response.headers.getSetCookie()[0] ?? "";
    assert.match(cookie, /^__Host-ocr_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Strict$/);
    assert.doesNotMatch(cookie, /Max-Age|Expires|Domain/);
    const payload = await body(response);
    assert.deepEqual(payload.user, { id: clerkId, username: "clerk1", displayName: "พนักงาน", role: "staff", canExport: false, mustChangePassword: false });
    assert.equal(payload.idleMinutes, 30);
    const token = cookie.slice(cookie.indexOf("=") + 1).split(";")[0]!;
    assert.equal(payload.csrfToken, csrfTokenFor(token));
    const listed = await fetch(`${base}/api/documents`, { headers: { cookie: `__Host-ocr_session=${token}` } });
    assert.equal(listed.status, 200);
    assert.deepEqual(h.store.actions(), ["login.succeeded"]);
  });
});

test("an unknown name, a wrong password, a disabled account and a locked account answer identically", async () => {
  const h = harness({ seed: (store) => { store.add({ id: secondOwnerId, username: "gone1", passwordHash: fastClerkHash, disabledAt: START - 1000 }); } });
  await withServer(h, async (base) => {
    const answers: string[] = [];
    for (const [username, password] of [["clerk1", "wrong-pass-entirely"], ["nobody9", CLERK_PASSWORD], ["gone1", CLERK_PASSWORD]] as const) {
      const response = await login(base, username, password);
      answers.push(fingerprint(response, await response.text()));
    }
    assert.equal(new Set(answers).size, 1, "every rejection is byte-identical, headers included");
    assert.match(answers[0]!, /401\n/);
    assert.match(answers[0]!, /\{"error":"INVALID_CREDENTIALS"\}$/);
    assert.doesNotMatch(answers[0]!, /retry-after/);
    await tick();
    // Only the known names write a row; a made-up name never touches the database.
    assert.deepEqual(h.store.actions(), ["login.failed", "login.failed"]);
    assert.deepEqual(h.store.audits.map((event) => event.targetId), [clerkId, secondOwnerId]);
  });
});

test("a temporary password is single-use and PASSWORD_EXPIRED only follows a correct password", async () => {
  const h = harness({ seed: (store) => { store.find(clerkId).mustChangePassword = true; store.find(clerkId).passwordExpiresAt = START + 72 * 3_600_000; } });
  await withServer(h, async (base) => {
    const first = await login(base, "clerk1", CLERK_PASSWORD);
    assert.equal(first.status, 200);
    assert.equal(((await body(first)).user as { mustChangePassword: boolean }).mustChangePassword, true);
    // `recordLoginSuccess` consumed it: the same password is now expired.
    await expectError(await login(base, "clerk1", CLERK_PASSWORD), 401, "PASSWORD_EXPIRED");
    // A wrong password on the same account still answers INVALID_CREDENTIALS, so nothing is revealed.
    await expectError(await login(base, "clerk1", "wrong-pass-entirely"), 401, "INVALID_CREDENTIALS");
  });
});

test("ten failures lock the account, and the correct password then answers like a wrong one", async () => {
  // A high username limit isolates D5.4 (the database lock) from D5.2 (the in-memory window).
  const h = harness({ throttle: new LoginThrottle({ usernameLimit: 50 }) });
  await withServer(h, async (base) => {
    for (let attempt = 0; attempt < 9; attempt += 1) await login(base, "clerk1", "wrong-pass-entirely");
    await tick();
    assert.equal(h.store.find(clerkId).failedLogins, 9);
    await expectError(await login(base, "clerk1", "wrong-pass-entirely"), 401, "INVALID_CREDENTIALS");
    await tick();
    assert.ok(h.store.find(clerkId).lockedUntil, "the tenth failure trips the lock");
    assert.ok(h.store.actions().includes("login.locked"));
    const locked = await login(base, "clerk1", CLERK_PASSWORD);
    await expectError(locked, 401, "INVALID_CREDENTIALS");
    assert.equal(locked.headers.get("retry-after"), null, "a locked account never gets a Retry-After");
    // The lock is visible to an admin only.
    const owner = await signedIn(base, "owner1", OWNER_PASSWORD);
    const users = await fetch(`${base}/api/users`, { headers: authHeaders(owner) });
    const listed = (await body(users)).users as UserListItem[];
    assert.equal(listed.find((user) => user.id === clerkId)?.status, "locked");
    // An admin unlock clears both the database lock and the in-memory window.
    assert.equal((await fetch(`${base}/api/users/${clerkId}/unlock`, { method: "POST", headers: authHeaders(owner) })).status, 204);
    assert.equal(h.store.find(clerkId).lockedUntil, null);
    assert.equal((await login(base, "clerk1", CLERK_PASSWORD)).status, 200);
  });
});

test("the enumeration regression: a locked account and an unknown name are indistinguishable", async () => {
  const h = harness({ clerkHash: realClerkHash });
  await withServer(h, async (base) => {
    for (let attempt = 0; attempt < 9; attempt += 1) await login(base, "clerk1", "wrong-pass-entirely");
    await tick();
    // The sliding window drains while the database counter does not: this is where the two used to disagree.
    h.clock.now += 16 * 60_000;
    assert.equal((await login(base, "clerk1", "wrong-pass-entirely")).status, 401);
    await tick();
    assert.ok(h.store.find(clerkId).lockedUntil, "the lock is on");

    const measure = async (username: string, password: string) => {
      const startedAt = process.hrtime.bigint();
      const response = await login(base, username, password);
      const text = await response.text();
      return { elapsed: Number(process.hrtime.bigint() - startedAt) / 1e6, print: fingerprint(response, text) };
    };
    const known = await measure("clerk1", CLERK_PASSWORD);
    const unknown = await measure("nobody9", CLERK_PASSWORD);
    assert.equal(known.print, unknown.print, "identical status, body and headers");
    const ratio = Math.max(known.elapsed, unknown.elapsed) / Math.max(1, Math.min(known.elapsed, unknown.elapsed));
    assert.ok(ratio < 3, `the elapsed times fall in the same band (${known.elapsed.toFixed(0)} ms vs ${unknown.elapsed.toFixed(0)} ms)`);
  });
});

test("DUMMY_HASH carries exactly the parameters a fresh hash does", async () => {
  const fresh = await hashPassword("fake-parameter-probe-01");
  assert.equal(DUMMY_HASH.split("$")[2], fresh.split("$")[2]);
  assert.equal(DUMMY_HASH.split("$")[2], `N=${SCRYPT_PARAMS.N},r=${SCRYPT_PARAMS.r},p=${SCRYPT_PARAMS.p}`);
});

// ---- throttling ------------------------------------------------------------------------------

test("the username window throttles any name alike and a success clears it", async () => {
  const h = harness({ throttle: new LoginThrottle({ usernameLimit: 3 }) });
  await withServer(h, async (base) => {
    for (const username of ["clerk1", "nobody9"]) {
      for (let attempt = 0; attempt < 3; attempt += 1) assert.equal((await login(base, username, "wrong-pass-entirely")).status, 401);
      const throttled = await login(base, username, "wrong-pass-entirely");
      await expectError(throttled, 429, "LOGIN_THROTTLED");
      assert.equal(throttled.headers.get("retry-after"), "900", `${username}: the window, not the account`);
    }
    h.clock.now += 16 * 60_000;
    assert.equal((await login(base, "clerk1", "wrong-pass-entirely")).status, 401, "the window drains with time");
    assert.equal((await login(base, "clerk1", CLERK_PASSWORD)).status, 200);
    for (let attempt = 0; attempt < 3; attempt += 1) assert.equal((await login(base, "clerk1", "wrong-pass-entirely")).status, 401, "the success reset the window");
  });
});

test("the username window is spent before the hash, so concurrent guesses cannot all slip past it", async () => {
  // Every one of these reads the counter before the first ~40 ms verify returns. Counting the attempt only after the
  // answer was written let the gate's in-flight capacity (2 running + 16 queued) over-run D5.2 by ~8x.
  const h = harness({ throttle: new LoginThrottle({ usernameLimit: 3 }) });
  await withServer(h, async (base) => {
    const answers = await Promise.all(Array.from({ length: 8 }, () => login(base, "clerk1", "wrong-pass-entirely")));
    const statuses = await Promise.all(answers.map(async (response) => { await response.text(); return response.status; }));
    assert.equal(statuses.filter((status) => status === 401).length, 3, "exactly the budget is hashed");
    assert.equal(statuses.filter((status) => status === 429).length, 5);
  });
});

test("a consumed temporary password is counted like any other attempt", async () => {
  // D6 leaves the expired credential in the row on purpose, and it is the one that gets read out loud or photographed.
  // C3.8 keeps it out of the database failure counter, but it must not buy an unlimited number of 32 MiB hashes.
  const h = harness({
    throttle: new LoginThrottle({ usernameLimit: 3 }),
    seed: (store) => { store.find(clerkId).mustChangePassword = true; store.find(clerkId).passwordExpiresAt = START + 72 * 3_600_000; }
  });
  await withServer(h, async (base) => {
    assert.equal((await login(base, "clerk1", CLERK_PASSWORD)).status, 200, "the first login consumes it and clears the window");
    for (let attempt = 0; attempt < 3; attempt += 1) await expectError(await login(base, "clerk1", CLERK_PASSWORD), 401, "PASSWORD_EXPIRED");
    const throttled = await login(base, "clerk1", CLERK_PASSWORD);
    await expectError(throttled, 429, "LOGIN_THROTTLED");
    assert.equal(throttled.headers.get("retry-after"), "900");
    assert.equal(h.store.find(clerkId).failedLogins, 0, "and still not a failure: the account is not locked by it");
  });
});

test("the per-IP window needs a trusted hop, ignores a forged left-hand entry and counts LOGIN_BUSY", async () => {
  const request = { socket: { remoteAddress: "10.0.0.9" }, headers: { "x-forwarded-for": "9.9.9.9, 203.0.113.7" } } as never;
  assert.equal(clientIp(request, 0), "10.0.0.9");
  assert.equal(clientIp(request, 1), "203.0.113.7", "the right-hand entry is the one nginx-proxy added");
  assert.equal(clientIp(request, 3), "10.0.0.9", "a chain shorter than the hop count falls back to the socket");

  const forged = { "x-forwarded-for": "198.51.100.5, 203.0.113.7" };
  const h = harness({ hops: 1, throttle: new LoginThrottle({ ipLimit: 2, usernameLimit: 50 }) });
  await withServer(h, async (base) => {
    const release = await fillLoginGate();
    try {
      // Nothing is hashed here: the gate is full, so these are the cheap rejections C11 says must still count.
      for (let attempt = 0; attempt < 2; attempt += 1) await expectError(await login(base, "clerk1", CLERK_PASSWORD, forged), 429, "LOGIN_BUSY");
      const throttled = await login(base, "nobody9", CLERK_PASSWORD, forged);
      await expectError(throttled, 429, "LOGIN_THROTTLED");
      assert.equal(throttled.headers.get("retry-after"), "900");
    } finally { await release(); }
  });

  const open = harness({ hops: 0, throttle: new LoginThrottle({ ipLimit: 2, usernameLimit: 50 }) });
  await withServer(open, async (base) => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      assert.equal((await login(base, "clerk1", "wrong-pass-entirely", forged)).status, 401, "hops = 0 disables the per-IP window");
    }
  });
});

/** Fills `loginGate` so that the next hash attempt throws `LOGIN_BUSY`, without hashing anything. */
async function fillLoginGate(): Promise<() => Promise<void>> {
  let unblock!: () => void;
  const blocker = new Promise<void>((resolve) => { unblock = resolve; });
  const held: Promise<void>[] = [];
  for (let slot = 0; slot < loginGate.limit + loginGate.queueLimit; slot += 1) held.push(loginGate.run(() => blocker));
  await tick();
  return async () => { unblock(); await Promise.all(held); };
}

test("past the unknown-name budget the answer costs no hash at all", async () => {
  const h = harness({ throttle: new LoginThrottle({ unknownLimit: 2, usernameLimit: 50 }) });
  await withServer(h, async (base) => {
    for (let attempt = 0; attempt < 2; attempt += 1) assert.equal((await login(base, `nobody${attempt}`, CLERK_PASSWORD)).status, 401);
    const release = await fillLoginGate();
    try {
      // A known name still needs the gate, so it answers LOGIN_BUSY...
      await expectError(await login(base, "clerk1", CLERK_PASSWORD), 429, "LOGIN_BUSY");
      // ...while an unknown one is past the budget and never reaches the gate.
      await expectError(await login(base, "nobody7", CLERK_PASSWORD), 401, "INVALID_CREDENTIALS");
    } finally { await release(); }
  });
});

test("an admin reset still works while the login gate is saturated", async () => {
  const h = harness();
  await withServer(h, async (base) => {
    const owner = await signedIn(base, "owner1", OWNER_PASSWORD);
    const release = await fillLoginGate();
    try {
      await expectError(await login(base, "clerk1", CLERK_PASSWORD), 429, "LOGIN_BUSY");
      const reset = await fetch(`${base}/api/users/${clerkId}/reset-password`, { method: "POST", headers: authHeaders(owner) });
      assert.equal(reset.status, 200, "adminGate is a separate gate");
      const issued = String((await body(reset)).temporaryPassword);
      issuedTemporary.push(issued);
      assert.match(issued, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
    } finally { await release(); }
  });
});

// ---- CSRF ------------------------------------------------------------------------------------

test("CSRF: a foreign or sibling origin, a same-site fetch and a missing token are all refused", async () => {
  const h = harness({ production: true });
  await withServer(h, async (base) => {
    const token = await signedIn(base, "clerk1", CLERK_PASSWORD);
    const mutating: Array<[string, string]> = [["POST", "/api/auth/login"], ["POST", "/api/batches"], ["POST", `/api/documents/${unknownUserId}/retry`], ["POST", "/api/users"]];
    for (const [method, path] of mutating) {
      for (const headers of [
        { origin: "https://evil.test" },
        { origin: "https://ai.innoveraappcenter.com" },
        { "sec-fetch-site": "same-site", origin: "https://ocr.test" },
        { "sec-fetch-site": "cross-site", origin: "https://ocr.test" },
        {}
      ]) {
        const response = await fetch(`${base}${path}`, {
          method, headers: { cookie: `__Host-ocr_session=${token}`, "x-csrf-token": csrfTokenFor(token), "content-type": "application/json", ...headers }, body: "{}"
        });
        await expectError(response, 403, "CSRF_REJECTED");
      }
    }
    const withoutToken = { cookie: `__Host-ocr_session=${token}`, origin: "https://ocr.test", "content-type": "application/json" };
    await expectError(await fetch(`${base}/api/batches`, { method: "POST", headers: withoutToken, body: JSON.stringify({ total: 1 }) }), 403, "CSRF_REJECTED");
    await expectError(await fetch(`${base}/api/batches`, { method: "POST", headers: { ...withoutToken, "x-csrf-token": csrfTokenFor("Zq4TmW8yRv2LbXc7NfKj1GdHs6PuA9eYiVoM3rDkQxB") }, body: JSON.stringify({ total: 1 }) }), 403, "CSRF_REJECTED");
    // A JSON body sent as text/plain is what a cross-site form can produce.
    await expectError(await fetch(`${base}/api/batches`, { method: "POST", headers: { ...withoutToken, "x-csrf-token": csrfTokenFor(token), "content-type": "text/plain" }, body: JSON.stringify({ total: 1 }) }), 415, "UNSUPPORTED_MEDIA_TYPE");
    // The happy path, and a GET that needs no token at all.
    assert.equal((await fetch(`${base}/api/batches`, { method: "POST", headers: { ...withoutToken, "x-csrf-token": csrfTokenFor(token) }, body: JSON.stringify({ total: 1 }) })).status, 201);
    assert.equal((await fetch(`${base}/api/documents`, { headers: { cookie: `__Host-ocr_session=${token}` } })).status, 200);
  });
});

// ---- sessions --------------------------------------------------------------------------------

test("a revoked, disabled, idle or expired session is the same 401", async () => {
  const idle = harness();
  await withServer(idle, async (base) => {
    const token = await signedIn(base, "clerk1", CLERK_PASSWORD);
    assert.equal((await fetch(`${base}/api/documents`, { headers: authHeaders(token) })).status, 200);
    // Polling authenticates but does not keep an abandoned browser logged in.
    idle.clock.now += 20 * 60_000;
    assert.equal((await fetch(`${base}/api/documents`, { headers: { ...authHeaders(token), "x-ocr-background": "1" } })).status, 200);
    idle.clock.now += 20 * 60_000;
    await expectError(await fetch(`${base}/api/documents`, { headers: authHeaders(token) }), 401, "UNAUTHENTICATED");
  });

  const active = harness();
  await withServer(active, async (base) => {
    const token = await signedIn(base, "clerk1", CLERK_PASSWORD);
    active.clock.now += 20 * 60_000;
    assert.equal((await fetch(`${base}/api/documents`, { headers: authHeaders(token) })).status, 200, "a user action moves the deadline");
    active.clock.now += 20 * 60_000;
    assert.equal((await fetch(`${base}/api/documents`, { headers: authHeaders(token) })).status, 200);
  });

  const expired = harness({ webConfig: { sessionAbsoluteHours: 1, sessionIdleMinutes: 480 } });
  await withServer(expired, async (base) => {
    const token = await signedIn(base, "clerk1", CLERK_PASSWORD);
    expired.clock.now += 61 * 60_000;
    await expectError(await fetch(`${base}/api/documents`, { headers: authHeaders(token) }), 401, "UNAUTHENTICATED");
  });

  const disabled = harness();
  await withServer(disabled, async (base) => {
    const token = await signedIn(base, "clerk1", CLERK_PASSWORD);
    const owner = await signedIn(base, "owner1", OWNER_PASSWORD);
    const response = await fetch(`${base}/api/users/${clerkId}`, { method: "POST", headers: { ...authHeaders(owner), "content-type": "application/json" }, body: JSON.stringify({ disabled: true }) });
    assert.equal(response.status, 200);
    await expectError(await fetch(`${base}/api/documents`, { headers: authHeaders(token) }), 401, "UNAUTHENTICATED");
  });
});

test("logout revokes the session, clears the cookie and is idempotent", async () => {
  const h = harness();
  await withServer(h, async (base) => {
    const token = await signedIn(base, "clerk1", CLERK_PASSWORD);
    // No CSRF token: logout must always be reachable.
    const out = await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { cookie: `ocr_session=${token}`, ...sameOrigin } });
    assert.equal(out.status, 204);
    assert.equal(out.headers.getSetCookie()[0], "ocr_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
    // One statement does it: the revoking UPDATE returns the session and its user, so the row is attributed without a
    // second query on a route that runs with no session, no CSRF token and no throttle.
    const logoutRows = h.store.audits.filter((event) => event.action === "session.logout");
    assert.equal(logoutRows.length, 1);
    assert.equal(logoutRows[0]?.actorUserId, clerkId);
    assert.equal(logoutRows[0]?.targetId, clerkId);
    assert.ok(logoutRows[0]?.sessionId, "the closed session is named in the row");
    await expectError(await fetch(`${base}/api/documents`, { headers: authHeaders(token) }), 401, "UNAUTHENTICATED");
    assert.equal((await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { cookie: `ocr_session=${token}`, ...sameOrigin } })).status, 204);
    assert.equal((await fetch(`${base}/api/auth/logout`, { method: "POST", headers: sameOrigin })).status, 204);
  });
});

test("a re-login revokes the cookie it was sent with, and GET /api/auth/session answers like login", async () => {
  const h = harness();
  await withServer(h, async (base) => {
    const first = await signedIn(base, "clerk1", CLERK_PASSWORD);
    const again = await login(base, "clerk1", CLERK_PASSWORD, { cookie: `ocr_session=${first}` });
    assert.equal(again.status, 200);
    const second = sessionCookie(again);
    assert.notEqual(first, second);
    await expectError(await fetch(`${base}/api/documents`, { headers: authHeaders(first) }), 401, "UNAUTHENTICATED");
    const session = await fetch(`${base}/api/auth/session`, { headers: authHeaders(second) });
    assert.equal(session.status, 200);
    const payload = await body(session);
    assert.equal(payload.csrfToken, csrfTokenFor(second));
    assert.deepEqual((payload.user as { id: string }).id, clerkId);
    await expectError(await fetch(`${base}/api/auth/session`), 401, "UNAUTHENTICATED");
  });
});

test("a password change rotates this session and revokes every other one", async () => {
  const h = harness();
  await withServer(h, async (base) => {
    const first = await signedIn(base, "clerk1", CLERK_PASSWORD);
    const second = await signedIn(base, "clerk1", CLERK_PASSWORD);
    const logsBefore = captured.length;
    const changed = await fetch(`${base}/api/auth/password`, {
      method: "POST", headers: { ...authHeaders(second), "content-type": "application/json" },
      body: JSON.stringify({ currentPassword: CLERK_PASSWORD, newPassword: NEW_PASSWORD })
    });
    assert.equal(changed.status, 200);
    const rotated = sessionCookie(changed);
    assert.notEqual(rotated, second);
    for (const dead of [first, second]) await expectError(await fetch(`${base}/api/documents`, { headers: authHeaders(dead) }), 401, "UNAUTHENTICATED");
    assert.equal((await fetch(`${base}/api/documents`, { headers: authHeaders(rotated) })).status, 200);
    // §5 C5's outcome is `password.changed` alone. The rotated session is not a login: no `login.succeeded` row (which
    // would make §13's `SELECT action, count(*)` over-count logins) and no `login_succeeded` line in the stdout mirror,
    // which §6 D9 keeps as the second trail precisely so the two can be compared.
    const actions = h.store.actions();
    assert.equal(actions.filter((action) => action === "password.changed").length, 1);
    assert.equal(actions.filter((action) => action === "login.succeeded").length, 2, "the two logins above, and none for the rotation");
    assert.equal(captured.slice(logsBefore).join("").includes("login_succeeded"), false);
    // The old password is gone and the new one works.
    await expectError(await login(base, "clerk1", CLERK_PASSWORD), 401, "INVALID_CREDENTIALS");
    assert.equal((await login(base, "clerk1", NEW_PASSWORD)).status, 200);
  });
});

test("a wrong current password is 400 and a weak or unchanged new password is refused", async () => {
  const h = harness();
  await withServer(h, async (base) => {
    const token = await signedIn(base, "clerk1", CLERK_PASSWORD);
    const change = (payload: object) => fetch(`${base}/api/auth/password`, { method: "POST", headers: { ...authHeaders(token), "content-type": "application/json" }, body: JSON.stringify(payload) });
    await expectError(await change({ currentPassword: "wrong-pass-entirely", newPassword: NEW_PASSWORD }), 400, "PASSWORD_INCORRECT");
    await tick();
    assert.equal(h.store.find(clerkId).failedLogins, 1, "it counts toward the account lock");
    await expectError(await change({ currentPassword: CLERK_PASSWORD, newPassword: "short" }), 400, "WEAK_PASSWORD");
    await expectError(await change({ currentPassword: CLERK_PASSWORD, newPassword: CLERK_PASSWORD }), 400, "PASSWORD_UNCHANGED");
    await expectError(await change({ newPassword: NEW_PASSWORD }), 400, "PASSWORD_INCORRECT");
  });
});

test("a forced-change session reaches only three routes and may skip the current password for five minutes", async () => {
  const seed = (store: FakeUserStore) => { const user = store.find(clerkId); user.mustChangePassword = true; user.passwordExpiresAt = START + 3_600_000; };
  const h = harness({ seed });
  await withServer(h, async (base) => {
    const token = await signedIn(base, "clerk1", CLERK_PASSWORD);
    await expectError(await fetch(`${base}/api/documents`, { headers: authHeaders(token) }), 403, "PASSWORD_CHANGE_REQUIRED");
    assert.equal((await fetch(`${base}/api/auth/session`, { headers: authHeaders(token) })).status, 200);
    const changed = await fetch(`${base}/api/auth/password`, { method: "POST", headers: { ...authHeaders(token), "content-type": "application/json" }, body: JSON.stringify({ newPassword: NEW_PASSWORD }) });
    assert.equal(changed.status, 200, "within five minutes the temporary password need not be typed again");
    assert.equal(((await body(changed)).user as { mustChangePassword: boolean }).mustChangePassword, false);
    assert.equal((await fetch(`${base}/api/documents`, { headers: authHeaders(sessionCookie(changed)) })).status, 200);
  });

  const late = harness({ seed });
  await withServer(late, async (base) => {
    const token = await signedIn(base, "clerk1", CLERK_PASSWORD);
    late.clock.now += 6 * 60_000;
    const response = await fetch(`${base}/api/auth/password`, { method: "POST", headers: { ...authHeaders(token), "content-type": "application/json" }, body: JSON.stringify({ newPassword: NEW_PASSWORD }) });
    await expectError(response, 400, "PASSWORD_INCORRECT");
  });
});

// ---- permissions and user administration -------------------------------------------------------

test("staff are refused the admin and export routes, and the denial is audited at most five times a minute", async () => {
  const h = harness();
  await withServer(h, async (base) => {
    const clerk = await signedIn(base, "clerk1", CLERK_PASSWORD);
    for (const path of ["/api/users", "/api/exports/preview", "/api/exports/documents.csv"]) {
      await expectError(await fetch(`${base}${path}`, { headers: authHeaders(clerk) }), 403, "FORBIDDEN");
    }
    const exporter = await signedIn(base, "clerk2", CLERK_PASSWORD);
    // `can_export` lets a staff member past the permission gate and through to the handler.
    const preview = await fetch(`${base}/api/exports/preview`, { headers: authHeaders(exporter) });
    assert.equal(preview.status, 200);
    assert.equal((await body(preview)).total, 0);
    await expectError(await fetch(`${base}/api/users`, { headers: authHeaders(exporter) }), 403, "FORBIDDEN");
    await tick();
    for (let attempt = 0; attempt < 5; attempt += 1) await fetch(`${base}/api/users`, { headers: authHeaders(clerk) });
    await tick();
    const denied = h.store.audits.filter((event) => event.action === "access.denied" && event.actorUserId === clerkId);
    assert.equal(denied.length, 5, "the budget is five rows a minute");
    // A new session is not a new budget: nothing limits how many sessions one account may open, so keying the budget
    // on the session would let a staff account fill a table nothing is allowed to delete from, five rows per login.
    const again = await signedIn(base, "clerk1", CLERK_PASSWORD);
    await expectError(await fetch(`${base}/api/users`, { headers: authHeaders(again) }), 403, "FORBIDDEN");
    await tick();
    assert.equal(h.store.audits.filter((event) => event.action === "access.denied" && event.actorUserId === clerkId).length, 5);
    assert.deepEqual(denied[0]?.outcome, "denied");
    assert.deepEqual(denied[0]?.detail, { route: "/api/users" });
    assert.match((await (await fetch(`${base}/metrics`)).text()), /access_denied_suppressed_total/);
  });
});

test("the admin role carries export by itself, and can_export is not one of the self guards", async () => {
  const h = harness();
  await withServer(h, async (base) => {
    // What `ocr-users create-admin` writes: the bootstrap admin owns the tenant but carries can_export = false.
    assert.equal(h.store.users.find((user) => user.id === ownerId)!.canExport, false);
    const owner = await signedIn(base, "owner1", OWNER_PASSWORD);
    // D8: the flag gates the export file for STAFF. An admin passes the gate on the role alone, so the only admin of a
    // fresh tenant is never locked out of the export — with can_export still false, all three routes answer.
    for (const path of ["/api/exports/preview", "/api/exports/documents.csv", "/api/exports/documents.jsonl"]) {
      const response = await fetch(`${base}${path}`, { headers: authHeaders(owner) });
      assert.equal(response.status, 200, path);
      await response.arrayBuffer();
    }
    // §5 C6 guards your own role and your own disabled state — not your own flags — so an admin can still turn it on.
    const granted = await fetch(`${base}/api/users/${ownerId}`, { method: "POST", headers: { ...authHeaders(owner), "content-type": "application/json" }, body: JSON.stringify({ canExport: true }) });
    assert.equal(granted.status, 200);
    assert.equal(((await body(granted)).user as UserListItem).canExport, true);
    assert.equal(h.store.users.find((user) => user.id === ownerId)!.canExport, true);
  });
});

test("an admin creates and updates users, with the self guards and the one-time password", async () => {
  const h = harness();
  await withServer(h, async (base) => {
    const owner = await signedIn(base, "owner1", OWNER_PASSWORD);
    const admin = (path: string, payload?: object) => fetch(`${base}${path}`, {
      method: "POST", headers: { ...authHeaders(owner), "content-type": "application/json" }, ...(payload ? { body: JSON.stringify(payload) } : {})
    });
    const created = await admin("/api/users", { username: "clerk3", displayName: "พนักงานใหม่", role: "staff", canExport: true });
    assert.equal(created.status, 201);
    const payload = await body(created);
    const temporaryPassword = String(payload.temporaryPassword);
    issuedTemporary.push(temporaryPassword);
    assert.match(temporaryPassword, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
    assert.equal((payload.user as UserListItem).status, "must_change");
    assert.equal((payload.user as UserListItem).canExport, true);
    const newId = (payload.user as UserListItem).id;
    // The one-time password works, and only once.
    assert.equal((await login(base, "clerk3", temporaryPassword)).status, 200);
    await expectError(await login(base, "clerk3", temporaryPassword), 401, "PASSWORD_EXPIRED");

    await expectError(await admin("/api/users", { username: "clerk3", displayName: "ซ้ำ", role: "staff" }), 409, "USERNAME_TAKEN");
    await expectError(await admin("/api/users", { username: "clerk4", displayName: "x", role: "boss" }), 400, "INVALID_ROLE");
    await expectError(await admin(`/api/users/${newId}`, { displayName: "ใหม่", nickname: "x" }), 400, "USER_INVALID");
    await expectError(await admin(`/api/users/${newId}`, {}), 400, "USER_INVALID");
    await expectError(await admin(`/api/users/${unknownUserId}`, { displayName: "x" }), 404, "USER_NOT_FOUND");

    await expectError(await admin(`/api/users/${ownerId}`, { role: "staff" }), 409, "CANNOT_CHANGE_SELF");
    await expectError(await admin(`/api/users/${ownerId}`, { disabled: true }), 409, "CANNOT_CHANGE_SELF");
    await expectError(await admin(`/api/users/${ownerId}/reset-password`), 409, "CANNOT_CHANGE_SELF");
    await expectError(await admin(`/api/users/${ownerId}/unlock`), 409, "CANNOT_CHANGE_SELF");

    // Promoting and demoting a second admin is allowed while another active admin remains.
    assert.equal((await admin(`/api/users/${newId}`, { role: "admin" })).status, 200);
    assert.equal((await admin(`/api/users/${newId}`, { role: "staff" })).status, 200);
    assert.equal(h.store.find(newId).role, "staff");
    // Every audit row of this test carries the acting admin.
    assert.deepEqual(new Set(h.store.audits.filter((event) => event.action.startsWith("user.")).map((event) => event.actorUserId)), new Set([ownerId]));
  });
});

// ---- attribution, metrics and routing ----------------------------------------------------------

test("a forged X-Request-Id is echoed but never stored: the audit row holds the server's trace id", async () => {
  const h = harness();
  await withServer(h, async (base) => {
    const clerk = await signedIn(base, "clerk1", CLERK_PASSWORD);
    const response = await fetch(`${base}/api/users`, { headers: { ...authHeaders(clerk), "x-request-id": "forged-request-id" } });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("x-request-id"), "forged-request-id");
    await tick();
    const denied = h.store.audits.find((event) => event.action === "access.denied");
    assert.notEqual(denied?.requestId, "forged-request-id");
    assert.match(String(denied?.requestId), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(denied?.actorUserId, clerkId);
  });
});

test("a workbench write is attributed to the live session's user and session id", async () => {
  const workbench = recordingWorkbenchStore();
  const h = harness({ workbenchStore: workbench });
  await withServer(h, async (base) => {
    const clerk = await signedIn(base, "clerk1", CLERK_PASSWORD);
    const sessionId = h.store.audits.find((event) => event.action === "login.succeeded")?.sessionId;
    assert.ok(sessionId, "the login opened a session");
    const created = await fetch(`${base}/api/batches`, { method: "POST", headers: { ...authHeaders(clerk), "content-type": "application/json" }, body: JSON.stringify({ total: 2 }) });
    assert.equal(created.status, 201);
    const input = workbench.batches[0] as { createdBy: string; expectedTotal: number; audit: { actorUserId: string; sessionId: string; requestId: string } };
    // `createdBy` is users.id, not a name, and the audit row rides along on the same session (§6 D9).
    assert.deepEqual([input.createdBy, input.expectedTotal], [clerkId, 2]);
    assert.deepEqual([input.audit.actorUserId, input.audit.sessionId], [clerkId, sessionId]);
    assert.match(input.audit.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

test("/metrics answers 404 through the proxy and 200 on the container port", async () => {
  const h = harness();
  await withServer(h, async (base) => {
    for (const header of ["x-forwarded-for", "x-forwarded-host", "x-real-ip"]) {
      const response = await fetch(`${base}/metrics`, { headers: { [header]: "203.0.113.7" } });
      assert.equal(response.status, 404, header);
      assert.deepEqual(await body(response), { status: "not_found" });
    }
    const direct = await fetch(`${base}/metrics`);
    assert.equal(direct.status, 200);
    assert.match(await direct.text(), /auth_logins_total/);
    assert.equal((await fetch(`${base}/health/live`)).status, 200);
  });
});

test("routeLabel covers the new routes and errorStatus maps the new codes", () => {
  for (const path of ["/api/auth/login", "/api/auth/logout", "/api/auth/session", "/api/auth/password", "/api/users",
    "/api/exports/preview", "/api/exports/documents.csv", "/api/exports/documents.jsonl"]) assert.equal(routeLabel(path), path);
  assert.equal(routeLabel(`/api/users/${clerkId}`), "/api/users/:id");
  assert.equal(routeLabel(`/api/users/${clerkId}/reset-password`), "/api/users/:id/reset-password");
  assert.equal(routeLabel(`/api/users/${clerkId}/unlock`), "/api/users/:id/unlock");
  assert.equal(routeLabel("/api/users/a/b/c"), "unmatched");
  assert.equal(routeLabel("/api/web-token"), "unmatched");
  for (const code of ["INVALID_CREDENTIALS", "PASSWORD_EXPIRED"]) assert.equal(errorStatus(code), 401);
  for (const code of ["CSRF_REJECTED", "FORBIDDEN", "PASSWORD_CHANGE_REQUIRED"]) assert.equal(errorStatus(code), 403);
  for (const code of ["LOGIN_THROTTLED", "LOGIN_BUSY", "EXPORT_BUSY"]) assert.equal(errorStatus(code), 429);
  for (const code of ["USERNAME_TAKEN", "LAST_ADMIN", "CANNOT_CHANGE_SELF"]) assert.equal(errorStatus(code), 409);
  assert.equal(errorStatus("LOGIN_NOT_CONFIGURED"), 503);
  for (const code of ["INVALID_LOGIN", "PASSWORD_INCORRECT", "WEAK_PASSWORD", "USER_INVALID", "INVALID_USERNAME",
    "INVALID_DISPLAY_NAME", "INVALID_ROLE", "INVALID_EXPORT_FILTER", "EXPORT_TOO_LARGE"]) assert.equal(errorStatus(code), 400);
  assert.equal(errorStatus("USER_NOT_FOUND"), 404);
});

test("the sliding window counts, blocks and drains per key", () => {
  const window = new SlidingWindow(2, 1000, 2);
  assert.equal(window.blocked("a", 0), false);
  window.record("a", 0);
  window.record("a", 0);
  assert.equal(window.blocked("a", 0), true);
  assert.equal(window.retryAfterSeconds("a", 0), 1);
  assert.equal(window.blocked("b", 0), false);
  assert.equal(window.blocked("a", 1001), false, "the window drains");
  window.record("a", 0);
  window.record("b", 0);
  window.record("c", 0);
  assert.ok(window.size <= 2, "keys are capped");
  window.record("d", 0);
  window.reset("d");
  assert.equal(window.blocked("d", 0), false);
});

test("the login routes answer 503 when no user store is configured", async () => {
  const app = createAppServer({ ingest: { stage: async () => "key", scan: async () => "CLEAN", enqueue: async () => "job" } });
  await new Promise<void>((resolve) => { app.listen(0, "127.0.0.1", resolve); });
  try {
    const base = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
    await expectError(await fetch(`${base}/api/auth/login`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ username: "clerk1", password: CLERK_PASSWORD }) }), 503, "LOGIN_NOT_CONFIGURED");
    await expectError(await fetch(`${base}/api/documents`), 503, "LOGIN_NOT_CONFIGURED");
  } finally { await new Promise<void>((resolve, reject) => { app.close((error) => error ? reject(error) : resolve()); }); }
});

// ---- the whole file ----------------------------------------------------------------------------

test("nothing secret ever reached stdout", () => {
  const output = captured.join("");
  for (const secret of [OWNER_PASSWORD, CLERK_PASSWORD, NEW_PASSWORD, "owner1", "clerk1", "clerk2"]) {
    assert.equal(output.includes(secret), false, "no password and no username is ever logged");
  }
  assert.doesNotMatch(output, /ocr_session=/);
  assert.doesNotMatch(output, /"csrf/i);
  assert.ok(issuedTemporary.length >= 2, "the run issued temporary passwords to check for");
  for (const temporary of issuedTemporary) assert.equal(output.includes(temporary), false, "no temporary password is ever logged");
  assert.match(output, /"event":"login_succeeded"/);
  assert.match(output, /"event":"login_failed"/);
});
