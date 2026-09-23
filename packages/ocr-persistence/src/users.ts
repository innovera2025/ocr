import type { Pool, PoolClient } from "pg";
import { insertAudit, type AuditContext, type AuditDetail, type AuditEvent } from "./audit.js";
import { isUuid, withTenant } from "./tenant.js";

export type UserRole = "admin" | "staff";
/** What `GET /api/users` shows: `locked` and `must_change` are derived, never stored. */
export type UserStatus = "active" | "disabled" | "locked" | "must_change";
export type SessionRevokeReason = "logout" | "relogin" | "password_changed" | "admin_reset" | "disabled";

/** Everything the login path needs in one row. It carries the hash, so it never leaves the server. */
export type LoginUser = Readonly<{ id: string; username: string; displayName: string; role: UserRole; canExport: boolean;
  passwordHash: string; mustChangePassword: boolean; passwordExpiresAt: string | null; lockedUntil: string | null; disabledAt: string | null }>;
export type UserListItem = Readonly<{ id: string; username: string; displayName: string; role: UserRole; canExport: boolean;
  status: UserStatus; lockedUntil: string | null; lastLoginAt: string | null; createdAt: string }>;
/** One resolved request: the session row joined to its user. `createdAt` decides the forced-change grace window (§5 C5). */
export type ResolvedSession = Readonly<{ sessionId: string; userId: string; username: string; displayName: string; role: UserRole;
  canExport: boolean; mustChangePassword: boolean; createdAt: string; lastSeenAt: string; expiresAt: string }>;

export type CreateUserInput = Readonly<{ username: string; displayName: string; role: UserRole; canExport?: boolean | undefined;
  passwordHash: string; /** false only for the bootstrap CLI, where the admin typed the password at a TTY. */ temporary?: boolean | undefined;
  audit: AuditContext }>;
export type UpdateUserChanges = Readonly<{ displayName?: string | undefined; role?: UserRole | undefined; canExport?: boolean | undefined; disabled?: boolean | undefined }>;
export type LoginFailureInput = Readonly<{ reason: string; audit: AuditContext; max?: number | undefined; lockMinutes?: number | undefined }>;
/**
 * `auditLogin: false` opens a session that is **not** a login: a password change rotates the session (§5 C5) and its
 * outcome is `password.changed` alone, so a `login.succeeded` row here too would make §13's operator query count
 * logins that never happened.
 */
export type CreateSessionInput = Readonly<{ userId: string; tokenHash: Buffer; absoluteHours: number; audit: AuditContext;
  auditLogin?: boolean | undefined }>;

/**
 * Every auth query is one small indexed statement, and `POST /api/auth/logout` runs without a session, a CSRF token or
 * a throttle, so none of them may hold a pooled connection open behind a stalled client or a lock (B3). The lock wait
 * of the last-admin guard is the only one that ever queues, and it queues behind another request, not behind a human.
 */
const AUTH_TIMEOUTS = { statementTimeoutMs: 5_000, idleInTransactionTimeoutMs: 10_000 } as const;

/** D5.4: ten consecutive failures lock an account for fifteen minutes. The lock is invisible to the client (§5 C3.5). */
export const LOGIN_MAX_FAILURES = 10;
export const LOGIN_LOCK_MINUTES = 15;
/** D6: a temporary password dies after 72 h, and the first successful login consumes it. */
export const TEMPORARY_PASSWORD_HOURS = 72;
/** The 0019 CHECK: lower case, 3–32 characters, starting with a letter or digit. */
const USERNAME = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const DISPLAY_NAME_MAX_LENGTH = 100;
const SESSION_TOKEN_HASH_BYTES = 32;
const ROLES: ReadonlySet<string> = new Set(["admin", "staff"]);
const REVOKE_REASONS: ReadonlySet<string> = new Set(["logout", "relogin", "password_changed", "admin_reset", "disabled"]);

const LIST_COLUMNS = `id, username, display_name, role, can_export, locked_until, last_login_at, created_at,
  CASE WHEN disabled_at IS NOT NULL THEN 'disabled' WHEN locked_until > now() THEN 'locked'
    WHEN must_change_password THEN 'must_change' ELSE 'active' END AS status`;

type Row = Record<string, unknown>;
function iso(value: unknown): string | null { return value instanceof Date ? value.toISOString() : typeof value === "string" ? new Date(value).toISOString() : null; }
function role(value: unknown): UserRole { return value === "admin" ? "admin" : "staff"; }
function pgCode(error: unknown): string | undefined { return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined; }

/** NFKC + trim + lower case, like the login form. A name that cannot exist under the CHECK simply finds no user. */
export function normalizeUsername(username: string): string { return username.normalize("NFKC").trim().toLowerCase(); }

function assertUsername(username: string): string {
  const normalized = normalizeUsername(username);
  if (!USERNAME.test(normalized)) throw new Error("INVALID_USERNAME");
  return normalized;
}
function assertDisplayName(displayName: string): string {
  const trimmed = displayName.normalize("NFKC").trim();
  if (trimmed.length < 1 || trimmed.length > DISPLAY_NAME_MAX_LENGTH) throw new Error("INVALID_DISPLAY_NAME");
  return trimmed;
}
function assertRole(value: string): UserRole {
  if (!ROLES.has(value)) throw new Error("INVALID_ROLE");
  return value as UserRole;
}
/** Only `packages/auth` produces these; the 0019 CHECK would answer a bad one with a 23514 the client cannot read. */
function assertPasswordHash(hash: string): string {
  if (!hash.startsWith("scrypt$") || hash.length > 200) throw new Error("PASSWORD_HASH_INVALID");
  return hash;
}
function assertUserId(userId: string): string {
  if (!isUuid(userId)) throw new Error("USER_NOT_FOUND");
  return userId;
}

function toListItem(row: Row): UserListItem {
  return { id: String(row.id), username: String(row.username), displayName: String(row.display_name), role: role(row.role),
    canExport: row.can_export === true, status: String(row.status) as UserStatus, lockedUntil: iso(row.locked_until),
    lastLoginAt: iso(row.last_login_at), createdAt: iso(row.created_at) ?? "" };
}

/**
 * Staff accounts, browser sessions and the audit log of ONE tenant (`OCR_WEB_TENANT_ID`, D2). Every method runs inside
 * `withTenant`, so FORCE RLS answers for tenant isolation instead of a WHERE clause the next reader could forget, and
 * each action commits together with the audit row that records it.
 */
export class PostgresUserStore {
  constructor(private readonly pool: Pool, readonly tenantId: string) {}

  private run<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    return withTenant(this.pool, this.tenantId, work, AUTH_TIMEOUTS);
  }

  private audit(client: PoolClient, audit: AuditContext, event: Omit<AuditEvent, "tenantId" | keyof AuditContext>): Promise<void> {
    return insertAudit(client, { ...audit, ...event, tenantId: this.tenantId });
  }

  /** Web startup fails loudly when the configured tenant does not exist, instead of every login answering "wrong password". */
  async assertTenant(): Promise<void> {
    if (!isUuid(this.tenantId)) throw new Error("LOGIN_TENANT_NOT_FOUND");
    const found = await this.run(async (client) => (await client.query("SELECT 1 FROM organizations WHERE id = $1::uuid", [this.tenantId])).rowCount);
    if (found !== 1) throw new Error("LOGIN_TENANT_NOT_FOUND");
  }

  async findLoginUser(username: string): Promise<LoginUser | null> {
    const normalized = normalizeUsername(username);
    if (!USERNAME.test(normalized)) return null;
    return this.run(async (client) => {
      const result = await client.query<Row>(
        `SELECT id, username, display_name, role, can_export, password_hash, must_change_password, password_expires_at, locked_until, disabled_at
         FROM users WHERE organization_id = $1::uuid AND username = $2`, [this.tenantId, normalized]);
      const row = result.rows[0];
      if (!row) return null;
      return { id: String(row.id), username: String(row.username), displayName: String(row.display_name), role: role(row.role),
        canExport: row.can_export === true, passwordHash: String(row.password_hash), mustChangePassword: row.must_change_password === true,
        passwordExpiresAt: iso(row.password_expires_at), lockedUntil: iso(row.locked_until), disabledAt: iso(row.disabled_at) };
    });
  }

  /**
   * One statement, so concurrent failures cannot lose a count: the counter is reset **as** the lock trips, which is what
   * keeps a locked account indistinguishable from a wrong password (D5). `locked` is true only for the failure that
   * tripped it, so `login.locked` is written once. Failures on a locked account keep counting and stay silent.
   */
  async recordLoginFailure(userId: string, input: LoginFailureInput): Promise<{ locked: boolean }> {
    assertUserId(userId);
    const max = input.max ?? LOGIN_MAX_FAILURES;
    const lockMinutes = input.lockMinutes ?? LOGIN_LOCK_MINUTES;
    if (!Number.isInteger(max) || max < 1 || !Number.isInteger(lockMinutes) || lockMinutes < 1) throw new Error("LOGIN_LIMIT_INVALID");
    return this.run(async (client) => {
      const result = await client.query<{ failed_logins: number; locked_now: boolean | null }>(
        `UPDATE users SET failed_logins = CASE WHEN failed_logins + 1 >= $3::int THEN 0 ELSE failed_logins + 1 END,
           locked_until = CASE WHEN failed_logins + 1 >= $3::int THEN now() + make_interval(mins => $4::int) ELSE locked_until END,
           updated_at = now()
         WHERE id = $1::uuid AND organization_id = $2::uuid
         RETURNING failed_logins, locked_until > now() AS locked_now`, [userId, this.tenantId, max, lockMinutes]);
      const row = result.rows[0];
      if (!row) throw new Error("USER_NOT_FOUND");
      const locked = row.failed_logins === 0 && row.locked_now === true;
      await this.audit(client, input.audit, { action: "login.failed", outcome: "failure", targetType: "user", targetId: userId, detail: { reason: input.reason } });
      if (locked) await this.audit(client, input.audit, { action: "login.locked", outcome: "failure", targetType: "user", targetId: userId, detail: { minutes: lockMinutes } });
      return { locked };
    });
  }

  /**
   * Clears the counter and the lock, stores a rehash when the scrypt parameters moved, and **consumes a temporary
   * password**: while `must_change_password` holds, the password expires now, so the only way forward is the change
   * inside this session (D6). `login.succeeded` is written by `createSession`, which knows the session id.
   */
  async recordLoginSuccess(userId: string, rehash?: string): Promise<void> {
    assertUserId(userId);
    const hash = rehash === undefined ? null : assertPasswordHash(rehash);
    const changed = await this.run(async (client) => (await client.query(
      `UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now(), updated_at = now(),
         password_hash = COALESCE($3, password_hash),
         password_expires_at = CASE WHEN must_change_password THEN now() ELSE password_expires_at END
       WHERE id = $1::uuid AND organization_id = $2::uuid`, [userId, this.tenantId, hash])).rowCount);
    if (changed !== 1) throw new Error("USER_NOT_FOUND");
  }

  /** A new session after every successful login (no fixation): only the SHA-256 of the cookie token is stored. */
  async createSession(input: CreateSessionInput): Promise<{ sessionId: string; createdAt: string; expiresAt: string }> {
    assertUserId(input.userId);
    if (!Buffer.isBuffer(input.tokenHash) || input.tokenHash.length !== SESSION_TOKEN_HASH_BYTES) throw new Error("SESSION_TOKEN_INVALID");
    if (!Number.isInteger(input.absoluteHours) || input.absoluteHours < 1 || input.absoluteHours > 24) throw new Error("SESSION_HOURS_INVALID");
    return this.run(async (client) => {
      const result = await client.query<Row>(
        `INSERT INTO auth_sessions(organization_id, user_id, token_hash, expires_at)
         VALUES ($1::uuid, $2::uuid, $3, now() + make_interval(hours => $4::int)) RETURNING id, created_at, expires_at`,
        [this.tenantId, input.userId, input.tokenHash, input.absoluteHours]);
      const row = result.rows[0]!;
      const sessionId = String(row.id);
      if (input.auditLogin !== false) {
        await this.audit(client, { ...input.audit, sessionId }, { action: "login.succeeded", targetType: "user", targetId: input.userId });
      }
      return { sessionId, createdAt: iso(row.created_at) ?? "", expiresAt: iso(row.expires_at) ?? "" };
    });
  }

  /**
   * §5 C4, one query per request: a missing, revoked, expired, idle or disabled session is the same `null`, so every
   * one of them answers 401 UNAUTHENTICATED and nothing is enumerable.
   */
  async resolveSession(tokenHash: Buffer, idleMinutes: number): Promise<ResolvedSession | null> {
    if (!Buffer.isBuffer(tokenHash) || tokenHash.length !== SESSION_TOKEN_HASH_BYTES) return null;
    if (!Number.isInteger(idleMinutes) || idleMinutes < 1 || idleMinutes > 1440) throw new Error("SESSION_IDLE_INVALID");
    return this.run(async (client) => {
      const result = await client.query<Row>(
        `SELECT s.id AS session_id, s.created_at, s.last_seen_at, s.expires_at, u.id AS user_id, u.username, u.display_name, u.role,
                u.can_export, u.must_change_password
         FROM auth_sessions s JOIN users u ON u.id = s.user_id AND u.organization_id = s.organization_id
         WHERE s.organization_id = $1::uuid AND s.token_hash = $2 AND s.revoked_at IS NULL AND s.expires_at > now()
           AND s.last_seen_at > now() - make_interval(mins => $3::int) AND u.disabled_at IS NULL`,
        [this.tenantId, tokenHash, idleMinutes]);
      const row = result.rows[0];
      if (!row) return null;
      return { sessionId: String(row.session_id), userId: String(row.user_id), username: String(row.username), displayName: String(row.display_name),
        role: role(row.role), canExport: row.can_export === true, mustChangePassword: row.must_change_password === true,
        createdAt: iso(row.created_at) ?? "", lastSeenAt: iso(row.last_seen_at) ?? "", expiresAt: iso(row.expires_at) ?? "" };
    });
  }

  /** The idle deadline moves on user actions only, and at most once a minute, so a busy tab is not a write per request. */
  async touchSession(sessionId: string): Promise<void> {
    if (!isUuid(sessionId)) return;
    await this.run((client) => client.query(
      `UPDATE auth_sessions SET last_seen_at = now()
       WHERE id = $1::uuid AND organization_id = $2::uuid AND revoked_at IS NULL AND last_seen_at < now() - interval '1 minute'`,
      [sessionId, this.tenantId]));
  }

  /**
   * Revocation is immediate: the next request resolves nothing. Only a logout is an action worth auditing on its own,
   * and the UPDATE already returns the session and its user, so the logout route needs no `resolveSession` first —
   * which halves what an unauthenticated `POST /api/auth/logout` costs the pool. `requestId` is the only thing the
   * caller can add: the actor of a logout is always the session's own user.
   */
  async revokeSession(tokenHash: Buffer, reason: SessionRevokeReason, requestId?: string): Promise<{ revoked: boolean; userId: string | null }> {
    if (!REVOKE_REASONS.has(reason)) throw new Error("SESSION_REASON_INVALID");
    if (!Buffer.isBuffer(tokenHash) || tokenHash.length !== SESSION_TOKEN_HASH_BYTES) return { revoked: false, userId: null };
    return this.run(async (client) => {
      const result = await client.query<Row>(
        `UPDATE auth_sessions SET revoked_at = now(), revoked_reason = $3
         WHERE organization_id = $1::uuid AND token_hash = $2 AND revoked_at IS NULL RETURNING id, user_id`,
        [this.tenantId, tokenHash, reason]);
      const row = result.rows[0];
      if (!row) return { revoked: false, userId: null };
      const userId = String(row.user_id);
      if (reason === "logout") {
        await this.audit(client, { actorUserId: userId, sessionId: String(row.id), requestId },
          { action: "session.logout", targetType: "user", targetId: userId });
      }
      return { revoked: true, userId };
    });
  }

  async revokeUserSessions(userId: string, reason: SessionRevokeReason, exceptSessionId?: string): Promise<number> {
    assertUserId(userId);
    if (!REVOKE_REASONS.has(reason)) throw new Error("SESSION_REASON_INVALID");
    return this.run((client) => revokeSessionsOn(client, this.tenantId, userId, reason, exceptSessionId));
  }

  /** §5 C5: the new hash, the flags cleared and **every** session of the user revoked; the route then opens a new one. */
  async changeOwnPassword(userId: string, newHash: string, audit: AuditContext): Promise<{ revoked: number }> {
    assertUserId(userId);
    const hash = assertPasswordHash(newHash);
    return this.run(async (client) => {
      const result = await client.query(
        `UPDATE users SET password_hash = $3, must_change_password = false, password_expires_at = NULL,
           password_changed_at = now(), updated_at = now() WHERE id = $1::uuid AND organization_id = $2::uuid`,
        [userId, this.tenantId, hash]);
      if (result.rowCount !== 1) throw new Error("USER_NOT_FOUND");
      const revoked = await revokeSessionsOn(client, this.tenantId, userId, "password_changed");
      await this.audit(client, audit, { action: "password.changed", targetType: "user", targetId: userId });
      return { revoked };
    });
  }

  /** Never a hash: the admin list shows identity, rights and state only. */
  async listUsers(): Promise<UserListItem[]> {
    return this.run(async (client) => {
      const result = await client.query<Row>(`SELECT ${LIST_COLUMNS} FROM users WHERE organization_id = $1::uuid ORDER BY username`, [this.tenantId]);
      return result.rows.map(toListItem);
    });
  }

  async createUser(input: CreateUserInput): Promise<UserListItem> {
    const username = assertUsername(input.username);
    const displayName = assertDisplayName(input.displayName);
    const userRole = assertRole(input.role);
    const hash = assertPasswordHash(input.passwordHash);
    const temporary = input.temporary ?? true;
    return this.run(async (client) => {
      const result = await client.query<Row>(
        `INSERT INTO users(organization_id, username, display_name, role, can_export, password_hash, must_change_password, password_expires_at)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, CASE WHEN $7 THEN now() + make_interval(hours => $8::int) END)
         RETURNING ${LIST_COLUMNS}`,
        [this.tenantId, username, displayName, userRole, input.canExport === true, hash, temporary, TEMPORARY_PASSWORD_HOURS])
        // The only unique key a client can collide with is (organization_id, username); pg's detail holds row values, so it never surfaces.
        .catch((error: unknown) => { throw pgCode(error) === "23505" ? new Error("USERNAME_TAKEN") : error; });
      const user = toListItem(result.rows[0]!);
      await this.audit(client, input.audit, { action: "user.created", targetType: "user", targetId: user.id, detail: { role: userRole, can_export: user.canExport } });
      return user;
    });
  }

  /**
   * The last-admin guard runs **inside** the transaction: the active admins are locked first, so two concurrent
   * demotions cannot both see a spare admin. Self-guards (`CANNOT_CHANGE_SELF`) belong to the route, which knows the
   * caller's own id; this store only refuses to leave the tenant without an admin.
   */
  async updateUser(userId: string, changes: UpdateUserChanges, audit: AuditContext): Promise<UserListItem> {
    assertUserId(userId);
    const displayName = changes.displayName === undefined ? null : assertDisplayName(changes.displayName);
    const newRole = changes.role === undefined ? null : assertRole(changes.role);
    const canExport = changes.canExport === undefined ? null : changes.canExport;
    const disabled = changes.disabled === undefined ? null : changes.disabled;
    const fields = Object.keys(changes).filter((key) => changes[key as keyof UpdateUserChanges] !== undefined).sort();
    if (fields.length === 0) throw new Error("USER_INVALID");
    return this.run(async (client) => {
      if (newRole !== null || disabled !== null) {
        const admins = await client.query<{ id: string }>(
          "SELECT id FROM users WHERE organization_id = $1::uuid AND role = 'admin' AND disabled_at IS NULL ORDER BY id FOR UPDATE", [this.tenantId]);
        const active = admins.rows.map((row) => row.id);
        const losesAdmin = newRole === "staff" || disabled === true;
        if (losesAdmin && active.includes(userId) && active.length <= 1) throw new Error("LAST_ADMIN");
      }
      const result = await client.query<Row>(
        `UPDATE users SET display_name = COALESCE($3, display_name), role = COALESCE($4, role), can_export = COALESCE($5, can_export),
           disabled_at = CASE WHEN $6::boolean IS NULL THEN disabled_at WHEN $6 THEN COALESCE(disabled_at, now()) ELSE NULL END,
           updated_at = now()
         WHERE id = $1::uuid AND organization_id = $2::uuid RETURNING ${LIST_COLUMNS}`,
        [userId, this.tenantId, displayName, newRole, canExport, disabled]);
      const row = result.rows[0];
      if (!row) throw new Error("USER_NOT_FOUND");
      if (disabled === true) await revokeSessionsOn(client, this.tenantId, userId, "disabled");
      await this.audit(client, audit, { action: "user.updated", targetType: "user", targetId: userId, detail: { fields: fields.join(",") } });
      return toListItem(row);
    });
  }

  /**
   * A new temporary password: the lock is cleared, every session of the user dies and the next login must change it.
   * `detail` is what tells the break-glass CLI reset (`{via:'cli'}`, §7 E1) from an admin's reset in the browser.
   */
  async resetPassword(userId: string, newHash: string, audit: AuditContext, detail?: AuditDetail): Promise<void> {
    assertUserId(userId);
    const hash = assertPasswordHash(newHash);
    await this.run(async (client) => {
      const result = await client.query(
        `UPDATE users SET password_hash = $3, must_change_password = true, password_expires_at = now() + make_interval(hours => $4::int),
           password_changed_at = now(), failed_logins = 0, locked_until = NULL, updated_at = now()
         WHERE id = $1::uuid AND organization_id = $2::uuid`, [userId, this.tenantId, hash, TEMPORARY_PASSWORD_HOURS]);
      if (result.rowCount !== 1) throw new Error("USER_NOT_FOUND");
      await revokeSessionsOn(client, this.tenantId, userId, "admin_reset");
      await this.audit(client, audit, { action: "user.password_reset", targetType: "user", targetId: userId, ...(detail ? { detail } : {}) });
    });
  }

  /** An admin clears the DB lock; the in-memory username window is the route's job (§5 C7). */
  async unlockUser(userId: string, audit: AuditContext): Promise<void> {
    assertUserId(userId);
    await this.run(async (client) => {
      const result = await client.query(
        "UPDATE users SET failed_logins = 0, locked_until = NULL, updated_at = now() WHERE id = $1::uuid AND organization_id = $2::uuid",
        [userId, this.tenantId]);
      if (result.rowCount !== 1) throw new Error("USER_NOT_FOUND");
      await this.audit(client, audit, { action: "user.unlocked", targetType: "user", targetId: userId });
    });
  }

  async countActiveAdmins(): Promise<number> {
    return this.run(async (client) => {
      const result = await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM users WHERE organization_id = $1::uuid AND role = 'admin' AND disabled_at IS NULL", [this.tenantId]);
      return result.rows[0]?.count ?? 0;
    });
  }

  /** An audit row with no action of its own to ride along with: `access.denied`, `export.*`, the CLI bootstrap. */
  async recordAudit(event: Omit<AuditEvent, "tenantId">): Promise<void> {
    await this.run((client) => insertAudit(client, { ...event, tenantId: this.tenantId }));
  }
}

/** Shared by the callers that revoke as part of a larger action (disable, reset, password change). */
async function revokeSessionsOn(client: PoolClient, tenantId: string, userId: string, reason: SessionRevokeReason, exceptSessionId?: string): Promise<number> {
  const except = exceptSessionId !== undefined && isUuid(exceptSessionId) ? exceptSessionId : null;
  const result = await client.query(
    `UPDATE auth_sessions SET revoked_at = now(), revoked_reason = $3
     WHERE organization_id = $1::uuid AND user_id = $2::uuid AND revoked_at IS NULL AND ($4::uuid IS NULL OR id <> $4::uuid)`,
    [tenantId, userId, reason, except]);
  return result.rowCount ?? 0;
}
