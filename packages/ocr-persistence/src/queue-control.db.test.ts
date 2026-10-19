/**
 * Queue control (plan queue-control D2, D6, D7, D14, D16; Phase 2.6) against PostgreSQL as the real runtime roles:
 * the grants, the Stop/Resume/cap/next-round state machine and its audit rows, and the worker gate
 * (`packages/queue/src/control.ts` PostgresQueueControl, as ocr_worker) including the races D7 describes.
 * Bootstrap: `queue-db-harness.ts`.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { Pool } from "pg";
import type { QueueActor } from "./index.js";
import { openQueueDb, repo, skipWithoutDatabase, type QueueDb } from "./queue-db-harness.js";

type Slot = { complete(counted: boolean): Promise<void>; release(): void };
type Gate = { reserve(): Promise<Slot | null>; read(): Promise<{ stopped: boolean; roundCap: number | null; roundDone: number }>; readonly inflight: number; close(): Promise<void> };
type GateModule = { PostgresQueueControl: new (config: Pool | string, options?: { log?: (event: string, fields: Readonly<Record<string, unknown>>) => void }) => Gate };

const TENANT = randomUUID();
/** Obviously fake, in the stored format, matching no password. */
const FAKE_HASH = "scrypt$v1$N=32768,r=8,p=3$bm90LWEtcmVhbC1zYWx0$bm90LWEtcmVhbC1rZXk";

describe("queue control against PostgreSQL as the runtime roles", { skip: skipWithoutDatabase }, () => {
  let db: QueueDb;
  let gateModule: GateModule;
  let admin: QueueActor, staff: QueueActor;
  const gates: Gate[] = [];
  /** A worker-role gate on its own pool, like the worker's composition root builds it. */
  const newGate = (): Gate => { const gate = new gateModule.PostgresQueueControl(db.roleUrl("ocr_worker")); gates.push(gate); return gate; };
  const row = async () => (await db.superDb.query<{ stopped_at: Date | null; stopped_by: string | null; round_cap: number | null; round_no: number; round_done: number; updated_by: string | null }>(
    "SELECT stopped_at, stopped_by, round_cap, round_no, round_done, updated_by FROM queue_control")).rows[0]!;
  const audits = async () => (await db.superDb.query<{ action: string; target_type: string | null; actor_user_id: string; detail: Record<string, unknown> }>(
    "SELECT action, target_type, actor_user_id, detail FROM audit_events WHERE action LIKE 'queue.%' ORDER BY occurred_at, id")).rows;
  const reset = async () => { await db.superDb.query("UPDATE queue_control SET stopped_at = NULL, stopped_by = NULL, round_cap = NULL, round_done = 0"); };

  before(async () => {
    db = await openQueueDb();
    gateModule = await import(new URL("packages/queue/src/control.ts", repo).href) as GateModule;
    await db.superDb.query("INSERT INTO organizations(id, name) VALUES ($1, 'Tenant')", [TENANT]);
    const user = async (username: string, role: string) => (await db.asApp<{ id: string }>(TENANT,
      "INSERT INTO users(organization_id, username, display_name, role, password_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id", [TENANT, username, `Name ${username}`, role, FAKE_HASH]))[0]!.id;
    const adminId = await user("queue.admin", "admin"), staffId = await user("queue.staff", "staff");
    admin = { displayName: "ผู้ดูแล", audit: { actorUserId: adminId, sessionId: null, requestId: randomUUID() } };
    staff = { displayName: "พนักงาน", audit: { actorUserId: staffId, sessionId: null, requestId: randomUUID() } };
  });
  after(async () => { await Promise.allSettled(gates.map((gate) => gate.close())); await db?.close(); });

  test("grants are exactly D16: the web updates the listed columns, the worker only round_done, the queue role nothing", async () => {
    const can = async (role: string, column: string, privilege: string) =>
      (await db.superDb.query<{ ok: boolean }>("SELECT has_column_privilege($1, 'queue_control', $2, $3) AS ok", [role, column, privilege])).rows[0]!.ok;
    const updatable = ["stopped_at", "stopped_by", "round_cap", "round_no", "round_started_at", "round_done", "updated_at", "updated_by"];
    assert.deepEqual(await Promise.all(updatable.map((column) => can("ocr_app", column, "UPDATE"))), updatable.map(() => true));
    assert.equal(await can("ocr_app", "id", "UPDATE"), false);
    assert.deepEqual(await Promise.all(updatable.map((column) => can("ocr_worker", column, "UPDATE"))), updatable.map((column) => column === "round_done"));
    const tables = await db.superDb.query<{ role: string; privilege: string }>(
      `SELECT r AS role, p AS privilege FROM unnest(ARRAY['ocr_app','ocr_worker','ocr_queue']) r CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) p
       WHERE has_table_privilege(r, 'queue_control', p) ORDER BY r, p`);
    assert.deepEqual(tables.rows.map((entry) => `${entry.role}:${entry.privilege}`), ["ocr_app:SELECT", "ocr_worker:SELECT"]);
    await db.asWorker(null, "UPDATE queue_control SET round_done = round_done + 1");
    await assert.rejects(db.asWorker(null, "UPDATE queue_control SET stopped_at = now()"), { code: "42501" });
    await assert.rejects(db.asWorker(null, "UPDATE queue_control SET round_cap = 1"), { code: "42501" });
    await assert.rejects(db.queueRolePool.query("SELECT * FROM queue_control"), { code: "42501" });
    await assert.rejects(db.queueRolePool.query("UPDATE queue_control SET round_done = 0"), { code: "42501" });
    await assert.rejects(db.asApp(null, "INSERT INTO queue_control(id) VALUES (true)"), { code: "42501" });
    await assert.rejects(db.asApp(null, "DELETE FROM queue_control"), { code: "42501" });
    await assert.rejects(db.superDb.query("INSERT INTO queue_control(id) VALUES (false)"), { code: "23514" }, "one row only: id must be true");
    assert.equal((await db.superDb.query("SELECT count(*)::int AS n FROM queue_control")).rows[0].n, 1);
    // The worker reads the row without any tenant (no RLS on the control row).
    assert.equal((await db.asWorker(null, "SELECT round_done FROM queue_control")).length, 1);
    await reset();
  });

  test("stop/resume: one audit row per change, none for a repeat; stopped_by is the display name; resume keeps round_done", async () => {
    await db.superDb.query("UPDATE queue_control SET round_done = 2");
    const stopped = await db.app.stopQueue(TENANT, admin);
    assert.deepEqual([stopped.changed, stopped.control.stopped, stopped.control.stoppedBy, stopped.control.roundState], [true, true, "ผู้ดูแล", "stopped"]);
    assert.equal((await row()).updated_by, admin.audit.actorUserId);
    assert.equal((await db.app.stopQueue(TENANT, admin)).changed, false, "stop while stopped: no change");
    const resumed = await db.app.resumeQueue(TENANT, admin);
    assert.deepEqual([resumed.changed, resumed.control.stopped, resumed.control.stoppedBy, resumed.control.roundDone], [true, false, null, 2]);
    assert.equal((await db.app.resumeQueue(TENANT, admin)).changed, false);
    const rows = await audits();
    assert.deepEqual(rows.map((entry) => [entry.action, entry.target_type, entry.actor_user_id]), [["queue.stopped", null, admin.audit.actorUserId], ["queue.resumed", null, admin.audit.actorUserId]]);
    await reset();
  });

  test("cap: validated, audited with cap_old/cap_new, a repeat writes nothing; lowering below the count closes the gate at once", async () => {
    const before = (await audits()).length;
    await assert.rejects(db.app.setRoundCap(TENANT, 0, admin), { message: "ROUND_CAP_INVALID" });
    await assert.rejects(db.app.setRoundCap(TENANT, "5", admin), { message: "ROUND_CAP_INVALID" });
    assert.equal((await db.app.setRoundCap(TENANT, 5, admin)).control.roundCap, 5);
    assert.equal((await db.app.setRoundCap(TENANT, 5, admin)).changed, false);
    await db.superDb.query("UPDATE queue_control SET round_done = 4");
    const gate = newGate();
    const open = await gate.reserve();
    assert.ok(open, "4 of 5: one more page may start");
    open.release();
    const lowered = await db.app.setRoundCap(TENANT, 3, admin);
    assert.equal(lowered.control.roundState, "round_full");
    assert.equal(await gate.reserve(), null, "lowered below round_done: closed at the next reserve");
    assert.equal((await db.app.setRoundCap(TENANT, null, admin)).control.roundState, "reading", "unlimited");
    assert.ok(await gate.reserve().then((slot) => { slot?.release(); return slot; }));
    const rows = (await audits()).slice(before);
    assert.deepEqual(rows.map((entry) => [entry.action, entry.detail]), [["queue.cap_changed", { cap_old: null, cap_new: 5 }], ["queue.cap_changed", { cap_old: 5, cap_new: 3 }],
      ["queue.cap_changed", { cap_old: 3, cap_new: null }]]);
    await reset();
  });

  test("next round at any time: not full, full, and while stopped (the stop stays); stale roundNo → ROUND_ALREADY_STARTED with no audit row", async () => {
    await db.app.setRoundCap(TENANT, 3, admin);
    const before = (await audits()).length;
    let current = (await row()).round_no;
    await db.superDb.query("UPDATE queue_control SET round_done = 1");
    const notFull = await db.app.startNextRound(TENANT, current, staff);
    assert.deepEqual([notFull.control.roundNo, notFull.control.roundDone, notFull.control.roundCap], [current + 1, 0, 3], "the cap is unchanged");
    current += 1;
    await db.superDb.query("UPDATE queue_control SET round_done = 3");
    assert.equal((await db.app.getQueueControl()).roundState, "round_full");
    assert.equal((await db.app.startNextRound(TENANT, current, staff)).control.roundState, "reading");
    current += 1;
    await db.app.stopQueue(TENANT, admin);
    const stoppedRound = await db.app.startNextRound(TENANT, current, staff);
    assert.deepEqual([stoppedRound.control.stopped, stoppedRound.control.roundNo], [true, current + 1], "never clears a Stop");
    current += 1;
    const stale = await db.app.startNextRound(TENANT, current - 1, staff).catch((error: unknown) => error);
    assert.ok(stale instanceof Error && stale.message === "ROUND_ALREADY_STARTED");
    assert.equal((stale as unknown as { control: { roundNo: number } }).control.roundNo, current);
    await assert.rejects(db.app.startNextRound(TENANT, 0, staff), { message: "ROUND_INVALID" });
    const rows = (await audits()).slice(before).filter((entry) => entry.action === "queue.round_started");
    assert.deepEqual(rows.map((entry) => entry.detail), [
      { round_no: current - 2, previous_round_no: current - 3, previous_done: 1, previous_cap: 3, was_full: false },
      { round_no: current - 1, previous_round_no: current - 2, previous_done: 3, previous_cap: 3, was_full: true },
      { round_no: current, previous_round_no: current - 1, previous_done: 0, previous_cap: 3, was_full: false }]);
    assert.equal(rows[0]!.actor_user_id, staff.audit.actorUserId);
    await reset();
  });

  test("10 concurrent next-round presses with the same roundNo open exactly one round and write one audit row", async () => {
    const before = (await audits()).filter((entry) => entry.action === "queue.round_started").length;
    const start = (await row()).round_no;
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => db.app.startNextRound(TENANT, start, staff)));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.deepEqual(results.filter((result) => result.status === "rejected").map((result) => (result as PromiseRejectedResult).reason.message),
      Array.from({ length: 9 }, () => "ROUND_ALREADY_STARTED"));
    assert.equal((await row()).round_no, start + 1);
    assert.equal((await audits()).filter((entry) => entry.action === "queue.round_started").length, before + 1);
  });

  test("50 parallel worker counts land exactly once each", async () => {
    await reset();
    const gate = newGate();
    const slots: Slot[] = [];
    for (let index = 0; index < 50; index += 1) slots.push((await gate.reserve())!);
    assert.equal(gate.inflight, 50);
    await Promise.all(slots.map((slot) => slot.complete(true)));
    assert.equal((await row()).round_done, 50);
    assert.equal(gate.inflight, 0);
    await reset();
  });

  test("a count racing a reset lands in exactly one round: counted(old round) + counted(new round) = finishes", async (t) => {
    await reset();
    const gate = newGate();
    const slots: Slot[] = [];
    for (let index = 0; index < 40; index += 1) slots.push((await gate.reserve())!);
    const start = (await row()).round_no;
    const before = (await audits()).filter((entry) => entry.action === "queue.round_started").length;
    const finishes = slots.map((slot, index) => new Promise<void>((resolve, reject) => setTimeout(() => { slot.complete(true).then(resolve, reject); }, index % 10)));
    const reset2 = new Promise<void>((resolve, reject) => setTimeout(() => { db.app.startNextRound(TENANT, start, staff).then(() => resolve(), reject); }, 4));
    await Promise.all([...finishes, reset2]);
    const audit = (await audits()).filter((entry) => entry.action === "queue.round_started")[before]!;
    const oldRound = Number(audit.detail.previous_done), newRound = (await row()).round_done;
    assert.equal(oldRound + newRound, 40, `old ${oldRound} + new ${newRound}`);
    t.diagnostic(`race split: ${oldRound} counted in round ${start}, ${newRound} in round ${start + 1}`);
    await reset();
  });

  test("D7 carry-over: a page reserved before the reset holds a slot in the new round and is counted there", async () => {
    await reset();
    await db.app.setRoundCap(TENANT, 1, admin);
    const gate = newGate();
    const inFlight = await gate.reserve();
    assert.ok(inFlight);
    assert.equal(await gate.reserve(), null, "cap 1: one page in flight fills the round");
    await db.app.startNextRound(TENANT, (await row()).round_no, staff);
    assert.equal((await row()).round_done, 0);
    assert.equal(await gate.reserve(), null, "new round, done 0 + inflight 1 >= cap 1: nothing more starts");
    await inFlight.complete(true);
    assert.equal((await row()).round_done, 1, "counted in the round where it finished");
    assert.equal(await gate.reserve(), null, "and the new round is full");
    await reset();
  });

  test("end to end: cap 3, the gate closes after 3 counted pages; a closed gate changes no job row; Stop closes it too", async () => {
    await reset();
    await db.app.setRoundCap(TENANT, 3, admin);
    const gate = newGate();
    for (let page = 0; page < 3; page += 1) {
      const slot = await gate.reserve();
      assert.ok(slot, `page ${page + 1}`);
      await slot.complete(true);
    }
    assert.equal(await gate.reserve(), null);
    assert.deepEqual(await gate.read(), { stopped: false, roundCap: 3, roundDone: 3 });
    // An uncounted slot (a split, a failure) never moves the counter.
    await db.app.setRoundCap(TENANT, 10, admin);
    const split = await gate.reserve();
    split!.release();
    assert.equal((await row()).round_done, 3);
    await db.app.stopQueue(TENANT, admin);
    assert.equal(await gate.reserve(), null, "stopped");
    await db.app.resumeQueue(TENANT, admin);
    assert.ok(await gate.reserve().then((slot) => { slot?.release(); return slot; }), "resumed");
    // Fails closed: a worker role that cannot read the row throws instead of opening.
    const blind = new gateModule.PostgresQueueControl(db.roleUrl("ocr_queue"));
    gates.push(blind);
    await assert.rejects(blind.reserve(), { code: "42501" });
    await reset();
  });
});
