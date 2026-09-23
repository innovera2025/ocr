import type { PoolClient } from "pg";
import { isUuid } from "./tenant.js";

export type AuditOutcome = "success" | "failure" | "denied";
export type AuditTargetType = "user" | "document" | "batch" | "export";
/** Flat scalars only: an audit row records WHAT happened, never a password, a token or an OCR field value. */
export type AuditDetailValue = string | number | boolean | null;
export type AuditDetail = Readonly<Record<string, AuditDetailValue>>;

/**
 * What a request knows about its caller. `actorUserId` is NULL only for the bootstrap CLI (`user.bootstrap`).
 * `requestId` is the server-minted trace id (a UUID), **never** the echoed `X-Request-Id` header: `requestId()`
 * (`packages/observability`) gives the client's value back, so a user could otherwise stamp their own audit rows with
 * another request's id. `insertAudit` therefore refuses anything that is not a UUID.
 */
export type AuditContext = Readonly<{ actorUserId: string | null; sessionId?: string | null | undefined; requestId?: string | undefined }>;
export type AuditEvent = AuditContext & Readonly<{ tenantId: string; action: string; outcome?: AuditOutcome | undefined;
  targetType?: AuditTargetType | undefined; targetId?: string | null | undefined; detail?: AuditDetail | undefined }>;

/** `area.verb`, as the 0019 CHECK requires; the action carries the meaning, so no detail key has to. */
const ACTION = /^[a-z]+(\.[a-z_]+)+$/;
const ACTION_MAX_LENGTH = 48;
const DETAIL_KEY = /^[a-z][a-z0-9_]{0,39}$/;
/** Mirrors the `logEvent` key filter: a detail key that sounds like a credential is a bug, not something to store. */
const DETAIL_KEY_FORBIDDEN = /pass|token|cookie|secret|authorization|csrf|credential/;
/** The 0019 CHECK caps `detail::text` at 4096 bytes; rejecting here gives a named error instead of a 23514. */
const DETAIL_MAX_BYTES = 4096;
const OUTCOMES: ReadonlySet<string> = new Set(["success", "failure", "denied"]);
const TARGET_TYPES: ReadonlySet<string> = new Set(["user", "document", "batch", "export"]);

/** The `detail` column as JSON text. Exported so callers can validate a detail before they open a transaction. */
export function auditDetailJson(detail: AuditDetail | undefined): string {
  if (detail === undefined) return "{}";
  for (const [key, value] of Object.entries(detail)) {
    if (!DETAIL_KEY.test(key) || DETAIL_KEY_FORBIDDEN.test(key)) throw new Error("AUDIT_DETAIL_INVALID");
    const type = typeof value;
    if (value !== null && type !== "string" && type !== "boolean" && !(type === "number" && Number.isFinite(value))) throw new Error("AUDIT_DETAIL_INVALID");
  }
  const json = JSON.stringify(detail);
  if (Buffer.byteLength(json, "utf8") > DETAIL_MAX_BYTES) throw new Error("AUDIT_DETAIL_TOO_LARGE");
  return json;
}

/**
 * Appends one row to the append-only `audit_events` **on the caller's client**, so the row commits (or rolls back) with
 * the action it describes. `ocr_app` holds SELECT and INSERT only (0019), so nothing can edit or remove it afterwards.
 */
export async function insertAudit(client: PoolClient, event: AuditEvent): Promise<void> {
  const { tenantId, action, actorUserId, sessionId, requestId, targetId } = event;
  if (!isUuid(tenantId)) throw new Error("AUDIT_EVENT_INVALID");
  if (action.length > ACTION_MAX_LENGTH || !ACTION.test(action)) throw new Error("AUDIT_ACTION_INVALID");
  if (actorUserId !== null && !isUuid(actorUserId)) throw new Error("AUDIT_EVENT_INVALID");
  if (sessionId !== undefined && sessionId !== null && !isUuid(sessionId)) throw new Error("AUDIT_EVENT_INVALID");
  if (targetId !== undefined && targetId !== null && !isUuid(targetId)) throw new Error("AUDIT_EVENT_INVALID");
  if (requestId !== undefined && !isUuid(requestId)) throw new Error("AUDIT_REQUEST_ID_INVALID");
  const outcome = event.outcome ?? "success";
  if (!OUTCOMES.has(outcome)) throw new Error("AUDIT_EVENT_INVALID");
  if (event.targetType !== undefined && !TARGET_TYPES.has(event.targetType)) throw new Error("AUDIT_EVENT_INVALID");
  await client.query(
    `INSERT INTO audit_events(organization_id, actor_user_id, session_id, action, outcome, target_type, target_id, request_id, detail)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::uuid, $8, $9::jsonb)`,
    [tenantId, actorUserId, sessionId ?? null, action, outcome, event.targetType ?? null, targetId ?? null, requestId ?? null,
      auditDetailJson(event.detail)]);
}

/** `access.denied`: at most 5 rows a minute for the key the caller chooses — the user, since sessions are free (§4 B4). */
export const ACCESS_DENIED_AUDIT_LIMIT = 5;
export const ACCESS_DENIED_AUDIT_WINDOW_MS = 60_000;

/**
 * A per-key sliding budget for audit rows a client can provoke. Nothing may delete from `audit_events`, so a staff
 * account that keeps hitting an admin route must not be able to fill the table: past the budget the caller increments
 * `access_denied_suppressed_total` instead of writing. Keys are bounded (oldest first) so they cannot grow the
 * process, which is why the caller keys on the user (finite) rather than the session (one per login).
 */
export class AuditRateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(readonly limit = ACCESS_DENIED_AUDIT_LIMIT, readonly windowMs = ACCESS_DENIED_AUDIT_WINDOW_MS, readonly maxKeys = 10_000) {}

  get size(): number { return this.windows.size; }

  /** True when this event may be written; false once `limit` is spent for `key` in the current window. */
  allow(key: string, now: number = Date.now()): boolean {
    const window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      this.windows.delete(key);
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      while (this.windows.size > this.maxKeys) this.windows.delete(this.windows.keys().next().value!);
      return true;
    }
    if (window.count >= this.limit) return false;
    window.count += 1;
    return true;
  }
}
