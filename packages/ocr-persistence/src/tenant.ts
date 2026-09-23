import type { Pool, PoolClient } from "pg";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Ids are checked here, before they reach a `::uuid` cast: a bad cast is a 500 whose pg message echoes the value. */
export function isUuid(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }

export type TenantIsolation = "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE";
/** `statementTimeoutMs` / `idleInTransactionTimeoutMs` are transaction-local (`SET LOCAL`), so a pooled connection keeps nothing. */
export type TenantTransactionOptions = Readonly<{ readOnly?: boolean | undefined; isolation?: TenantIsolation | undefined;
  statementTimeoutMs?: number | undefined; idleInTransactionTimeoutMs?: number | undefined }>;

const ISOLATION: ReadonlySet<string> = new Set(["READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE"]);
/** An hour is longer than any request this process serves; beyond it a caller passed seconds, a float or a string. */
const MAX_TIMEOUT_MS = 3_600_000;

/** Timeouts are `set_config` parameters, never interpolated, and only after they are proven to be plain integer milliseconds. */
function timeoutValue(value: number | undefined): string | null {
  if (value === undefined) return null;
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) throw new Error("TENANT_TIMEOUT_INVALID");
  return String(value);
}

/**
 * Runs `work` in ONE transaction scoped to `tenantId` through `app.current_org`, which is what every RLS policy in this
 * schema reads (`0001_foundation` `organization_scope`, `0019_user_auth` `user_scope`). The GUC is set transaction-local,
 * so a connection returned to the pool carries no tenant, and a rollback is always attempted before the client is released.
 * `isolation` and the timeouts exist for the export cursor (a long REPEATABLE READ READ ONLY transaction) and for the
 * auth queries, which must never hold a connection open behind a stalled client.
 */
export async function withTenant<T>(pool: Pool, tenantId: string, work: (client: PoolClient) => Promise<T>,
  options: TenantTransactionOptions = {}): Promise<T> {
  const { isolation, readOnly } = options;
  if (isolation !== undefined && !ISOLATION.has(isolation)) throw new Error("TENANT_ISOLATION_INVALID");
  const statementTimeout = timeoutValue(options.statementTimeoutMs);
  const idleTimeout = timeoutValue(options.idleInTransactionTimeoutMs);
  const begin = `BEGIN${isolation ? ` ISOLATION LEVEL ${isolation}` : ""}${readOnly ? " READ ONLY" : ""}`;
  const client = await pool.connect();
  // pg-pool emits 'error' on the POOL only for clients sitting idle in it; a checked-out client has no listener at all
  // (it removes its own at checkout and re-attaches it inside release). An unhandled 'error' is fatal in Node, so a
  // database restart or a `pg_terminate_backend` behind any transaction here — including the preview, which asks
  // PostgreSQL itself to terminate the backend after `idleInTransactionTimeoutMs` — would take the whole process down.
  let broken: Error | null = null;
  const onError = (error: Error): void => { broken = error; };
  client.on("error", onError);
  try {
    await client.query(begin);
    await client.query("SELECT set_config('app.current_org', $1, true)", [tenantId]);
    if (statementTimeout) await client.query("SELECT set_config('statement_timeout', $1, true)", [statementTimeout]);
    if (idleTimeout) await client.query("SELECT set_config('idle_in_transaction_session_timeout', $1, true)", [idleTimeout]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(broken !== null); client.removeListener("error", onError); }
}
