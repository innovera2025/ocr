import assert from "node:assert/strict";
import test from "node:test";
import type { Pool, PoolClient } from "pg";
import { withTenant } from "./tenant.js";

type Call = { sql: string; values: readonly unknown[] | undefined };

/** A pool that records what a transaction sends, so the statement order and the GUC can be asserted without a server. */
function fakePool(): { pool: Pool; calls: Call[]; released: () => (boolean | undefined)[]; connects: () => number; emitError: (error: Error) => void } {
  const calls: Call[] = [];
  const released: (boolean | undefined)[] = [];
  let connects = 0;
  const listeners = new Set<(error: Error) => void>();
  const client = {
    query: async (sql: string, values?: readonly unknown[]) => { calls.push({ sql, values }); return { rows: [], rowCount: 0 }; },
    release: (destroy?: boolean) => { released.push(destroy); },
    on: (event: string, listener: (error: Error) => void) => { if (event === "error") listeners.add(listener); return client; },
    removeListener: (_event: string, listener: (error: Error) => void) => { listeners.delete(listener); return client; }
  };
  const pool = { connect: async () => { connects += 1; return client as unknown as PoolClient; } } as unknown as Pool;
  return { pool, calls, released: () => released, connects: () => connects,
    // What node-postgres does when the backend dies: with no listener at all this event ends the process.
    emitError: (error) => { if (listeners.size === 0) throw new Error("no 'error' listener: this event would have crashed the process"); for (const listener of listeners) listener(error); } };
}

test("withTenant opens one transaction, sets the tenant GUC transaction-locally and commits", async () => {
  const { pool, calls, released } = fakePool();
  const result = await withTenant(pool, "11111111-2222-3333-4444-555555555555", async () => "done");
  assert.equal(result, "done");
  assert.deepEqual(calls.map((call) => call.sql), ["BEGIN", "SELECT set_config('app.current_org', $1, true)", "COMMIT"]);
  assert.deepEqual(calls[1]!.values, ["11111111-2222-3333-4444-555555555555"]);
  assert.deepEqual(released(), [false]);
});

test("withTenant builds the BEGIN from the whitelisted isolation level and sets the timeouts as parameters", async () => {
  const { pool, calls } = fakePool();
  await withTenant(pool, "11111111-2222-3333-4444-555555555555", async () => undefined,
    { isolation: "REPEATABLE READ", readOnly: true, statementTimeoutMs: 30_000, idleInTransactionTimeoutMs: 60_000 });
  assert.equal(calls[0]!.sql, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.deepEqual(calls.slice(2, 4).map((call) => call.sql), ["SELECT set_config('statement_timeout', $1, true)", "SELECT set_config('idle_in_transaction_session_timeout', $1, true)"]);
  assert.deepEqual(calls[2]!.values, ["30000"], "the number is a parameter, never interpolated into the SQL");
});

test("withTenant refuses an unknown isolation level or a timeout that is not plain integer milliseconds, before it takes a connection", async () => {
  const { pool, connects } = fakePool();
  const tenant = "11111111-2222-3333-4444-555555555555";
  const work = async () => undefined;
  await assert.rejects(withTenant(pool, tenant, work, { isolation: "READ UNCOMMITTED" as "SERIALIZABLE" }), /TENANT_ISOLATION_INVALID/);
  for (const statementTimeoutMs of [0, -1, 1.5, Number.NaN, 3_600_001]) {
    await assert.rejects(withTenant(pool, tenant, work, { statementTimeoutMs }), /TENANT_TIMEOUT_INVALID/, String(statementTimeoutMs));
  }
  await assert.rejects(withTenant(pool, tenant, work, { idleInTransactionTimeoutMs: 0 }), /TENANT_TIMEOUT_INVALID/);
  assert.equal(connects(), 0);
});

test("withTenant rolls back and releases the client when the work throws", async () => {
  const { pool, calls, released } = fakePool();
  await assert.rejects(withTenant(pool, "11111111-2222-3333-4444-555555555555", async () => { throw new Error("BOOM"); }), /BOOM/);
  assert.equal(calls.at(-1)!.sql, "ROLLBACK");
  assert.ok(!calls.some((call) => call.sql === "COMMIT"));
  assert.deepEqual(released(), [false]);
});

test("a checked-out client keeps an 'error' listener for as long as it is out of the pool", async () => {
  const { pool, released, emitError } = fakePool();
  const dead = new Error("terminating connection due to idle-in-transaction timeout");
  // pg-pool's own listener is removed at checkout and only re-attached inside release(); without this one the event
  // is unhandled, which is fatal in Node. `idleInTransactionTimeoutMs` exists to make PostgreSQL do exactly this.
  await withTenant(pool, "11111111-2222-3333-4444-555555555555", async () => { emitError(dead); },
    { readOnly: true, idleInTransactionTimeoutMs: 60_000 });
  assert.deepEqual(released(), [true], "a client whose backend died is destroyed, not returned to the pool");
  assert.throws(() => emitError(dead), /would have crashed/, "and the listener is removed once it is back in the pool");
});
