import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { gateDecision, PostgresQueueControl } from "./control.js";

test("gateDecision truth table: stopped wins, a cap closes at done + inflight, null cap is unlimited", () => {
  const cases: Array<[boolean, number | null, number, number, string]> = [
    [false, null, 0, 0, "open"], [false, null, 99_999, 7, "open"],
    [true, null, 0, 0, "stopped"], [true, 3, 3, 0, "stopped"],
    [false, 3, 0, 0, "open"], [false, 3, 2, 0, "open"], [false, 3, 3, 0, "round_full"], [false, 3, 5, 0, "round_full"],
    [false, 3, 2, 1, "round_full"], [false, 3, 1, 1, "open"], [false, 1, 0, 1, "round_full"],
    // After "Start next round" the counter is 0 but a page started in the old round still holds a slot (D7 carry-over).
    [false, 2, 0, 1, "open"], [false, 1, 0, 1, "round_full"]
  ];
  for (const [stopped, roundCap, roundDone, inflight, expected] of cases) {
    const decision = gateDecision({ stopped, roundCap, roundDone }, inflight);
    assert.equal(decision.open ? "open" : decision.reason, expected, JSON.stringify({ stopped, roundCap, roundDone, inflight }));
  }
});

/** A pool whose `query` serves a mutable control row and counts the `round_done + 1` writes. */
function fakeControl(row: { stopped_at: Date | null; round_cap: number | null; round_done: number } | null, options: { failCount?: boolean; delayMs?: number } = {}) {
  const writes: string[] = [];
  const logs: Array<[string, Readonly<Record<string, unknown>>]> = [];
  const pool = new Pool();
  Object.assign(pool, {
    query: async (sql: string) => {
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      if (sql.startsWith("SELECT")) return { rows: row ? [{ ...row }] : [] };
      writes.push(sql);
      if (options.failCount) throw new Error("connection lost");
      if (row) row.round_done += 1;
      return { rows: [], rowCount: 1 };
    }
  });
  const gate = new PostgresQueueControl(pool, { log: (event, fields) => { logs.push([event, fields]); } });
  return { gate, writes, logs, pool, row };
}

test("reserve/complete: a counted page writes round_done + 1 once; release and a second complete are no-ops", async () => {
  const { gate, writes, pool } = fakeControl({ stopped_at: null, round_cap: 5, round_done: 0 });
  const slot = await gate.reserve();
  assert.ok(slot);
  assert.equal(gate.inflight, 1);
  await slot.complete(true);
  await slot.complete(true);
  slot.release();
  assert.equal(gate.inflight, 0);
  assert.deepEqual(writes, ["UPDATE queue_control SET round_done = round_done + 1 WHERE id"]);
  const uncounted = await gate.reserve();
  uncounted!.release();
  await uncounted!.complete(true);
  assert.equal(writes.length, 1, "a released slot is never counted later");
  assert.equal(gate.inflight, 0);
  await pool.end();
});

test("with cap 3 the gate closes at 3 counted pages and reopens only for a new round or a higher cap", async () => {
  const { gate, row, pool } = fakeControl({ stopped_at: null, round_cap: 3, round_done: 0 });
  for (let page = 0; page < 3; page += 1) await (await gate.reserve())!.complete(true);
  assert.equal(row!.round_done, 3);
  assert.equal(await gate.reserve(), null);
  row!.round_cap = 4;
  const fourth = await gate.reserve();
  assert.ok(fourth, "raising N takes effect at the next reserve");
  assert.equal(await gate.reserve(), null, "done 3 + inflight 1 = cap 4");
  row!.round_done = 0; // "Start next round" while the fourth page is in flight
  const next = await gate.reserve();
  assert.ok(next);
  assert.equal(gate.inflight, 2, "the carried-over page still holds its slot");
  await fourth!.complete(true);
  assert.equal(row!.round_done, 1, "the carried-over page is counted in the round where it finishes");
  next!.release();
  await pool.end();
});

test("concurrent reserves never take more slots than the cap allows (the in-process turn serialises them)", async () => {
  const { gate, pool } = fakeControl({ stopped_at: null, round_cap: 2, round_done: 0 }, { delayMs: 5 });
  const slots = await Promise.all(Array.from({ length: 6 }, () => gate.reserve()));
  assert.equal(slots.filter(Boolean).length, 2);
  assert.equal(gate.inflight, 2);
  for (const slot of slots) slot?.release();
  await pool.end();
});

test("stopped: closed regardless of the cap; transitions are logged once each, without a user or a document", async () => {
  const { gate, row, logs, pool } = fakeControl({ stopped_at: new Date(), round_cap: null, round_done: 0 });
  assert.equal(await gate.reserve(), null);
  assert.equal(await gate.reserve(), null);
  row!.stopped_at = null;
  const slot = await gate.reserve();
  assert.ok(slot);
  slot.release();
  assert.ok(await gate.reserve().then((again) => { again?.release(); return again; }));
  assert.deepEqual(logs.map(([event, fields]) => [event, fields.reason]), [["queue_gate_closed", "stopped"], ["queue_gate_opened", undefined]]);
  for (const [, fields] of logs) for (const key of Object.keys(fields)) assert.ok(["inflight", "reason", "round_cap", "round_done"].includes(key), key);
  await pool.end();
});

test("fails closed: a missing row or a database error throws (nothing is claimed); a failed count still frees the slot", async () => {
  const missing = fakeControl(null);
  await assert.rejects(missing.gate.reserve(), { message: "QUEUE_CONTROL_MISSING" });
  assert.equal(missing.gate.inflight, 0);
  await assert.rejects(missing.gate.reserve(), { message: "QUEUE_CONTROL_MISSING" }, "the turn is released after a failure: the next reserve runs instead of hanging");
  await missing.pool.end();
  const broken = new Pool();
  Object.assign(broken, { query: async () => { throw new Error("ECONNREFUSED"); } });
  await assert.rejects(new PostgresQueueControl(broken).reserve(), /ECONNREFUSED/);
  await broken.end();
  const failing = fakeControl({ stopped_at: null, round_cap: null, round_done: 0 }, { failCount: true });
  const taken = await failing.gate.reserve();
  await assert.rejects(taken!.complete(true), /connection lost/);
  assert.equal(failing.gate.inflight, 0);
  await failing.pool.end();
});
