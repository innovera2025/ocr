/**
 * Queue control (plan queue-control D2, D6, D7, D14, D16; Phase 2.6) against PostgreSQL as the real runtime roles:
 * the grants, the Stop/Resume/cap/next-round state machine and its audit rows, and the worker gate
 * (`packages/queue/src/control.ts` PostgresQueueControl, as ocr_worker) including the races D7 describes.
 * Bootstrap: `queue-db-harness.ts`.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { loadavg } from "node:os";
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

  // ---- D11 progress read model (Phase 3.5) -----------------------------------------------------------------------

  const TENANT_O = randomUUID(), TENANT_P = randomUUID(), TENANT_T = randomUUID();
  let orgsReady = false;
  async function orgs() {
    if (orgsReady) return;
    await db.superDb.query("INSERT INTO organizations(id, name) VALUES ($1, 'Overview'), ($2, 'Other'), ($3, 'Timing')", [TENANT_O, TENANT_P, TENANT_T]);
    orgsReady = true;
  }
  /** A batch and its documents written directly (superuser): `files` are [status, pages?, pageStatuses?]. */
  async function seedBatch(tenantId: string, files: Array<{ status: string; pages?: string[] }>, createdAt = "2026-10-18T00:00:00Z"): Promise<string> {
    const batchId = (await db.superDb.query<{ id: string }>("INSERT INTO ocr_batches(organization_id, created_by, expected_total, created_at) VALUES ($1, 'seed', $2, $3) RETURNING id",
      [tenantId, files.length, createdAt])).rows[0]!.id;
    for (const file of files) {
      const isPdf = file.pages !== undefined;
      const parent = (await db.superDb.query<{ id: string }>(
        `INSERT INTO documents(id, organization_id, public_id, status, filename, mime_type, size_bytes, content_hash, batch_id, page_count, processed_at)
         VALUES (gen_random_uuid(), $1, md5(random()::text), $2::document_status, 'seed', $3, 1, 'h', $4, $5,
                 CASE WHEN $2::text IN ('SUCCEEDED','NEEDS_REVIEW','FAILED','SPLIT') THEN now() END) RETURNING id`,
        [tenantId, file.status, isPdf ? "application/pdf" : "image/png", batchId, isPdf ? file.pages!.length : null])).rows[0]!.id;
      for (const [index, status] of (file.pages ?? []).entries()) {
        await db.superDb.query(
          `INSERT INTO documents(id, organization_id, public_id, status, filename, mime_type, size_bytes, content_hash, batch_id, parent_document_id, page_number, page_count, processed_at)
           VALUES (gen_random_uuid(), $1, md5(random()::text), $2::document_status, 'seed', 'image/png', 1, 'h', $3, $4, $5, $6,
                   CASE WHEN $2::text IN ('SUCCEEDED','NEEDS_REVIEW','FAILED') THEN now() END)`,
          [tenantId, status, batchId, parent, index + 1, file.pages!.length]);
      }
    }
    return batchId;
  }

  test("open batches: finished and fully failed batches are out, one CLEAN row is enough; queue order; filesDone for split PDFs; totals = sum", async () => {
    await orgs();
    const finished = await seedBatch(TENANT_O, [{ status: "SUCCEEDED" }, { status: "SPLIT", pages: ["SUCCEEDED", "NEEDS_REVIEW"] }], "2026-10-18T01:00:00Z");
    const failed = await seedBatch(TENANT_O, [{ status: "FAILED" }, { status: "QUARANTINED" }], "2026-10-18T02:00:00Z");
    const oneClean = await seedBatch(TENANT_O, [{ status: "SUCCEEDED" }, { status: "CLEAN" }], "2026-10-18T03:00:00Z");
    // Two split PDFs: one fully read (a done file), one with a page still waiting; an image read; a PDF not split yet.
    const mixed = await seedBatch(TENANT_O, [{ status: "SPLIT", pages: ["SUCCEEDED", "FAILED", "NEEDS_REVIEW"] }, { status: "SPLIT", pages: ["SUCCEEDED", "CLEAN"] },
      { status: "SUCCEEDED" }, { status: "PROCESSING" }], "2026-10-18T00:30:00Z");
    // queue_seq decides, not created_at: the newest batch (oneClean) is renumbered to the front.
    await db.superDb.query("UPDATE ocr_batches SET queue_seq = 1000000 + (SELECT count(*) FROM ocr_batches) WHERE id = $1", [mixed]);
    await db.superDb.query("UPDATE ocr_batches SET queue_seq = 1 WHERE id = $1", [oneClean]).catch(async () => {
      await db.superDb.query("UPDATE ocr_batches SET queue_seq = (SELECT min(queue_seq) - 1 FROM ocr_batches) WHERE id = $1", [oneClean]);
    });
    const open = await db.app.listOpenBatches(TENANT_O);
    assert.deepEqual(open.map((batch) => batch.batchId), [oneClean, mixed], "finished and fully failed batches are not open; queue_seq order");
    assert.deepEqual(open.map((batch) => batch.queuePosition), [1, 2]);
    const m = open[1]!;
    assert.deepEqual([m.uploaded, m.filesDone, m.rows, m.completed, m.failed, m.queued, m.processing, m.rowsExpected], [4, 2, 7, 5, 1, 1, 1, 7],
      "files done: the fully read PDF and the image; the PDF with a waiting page and the unsplit PDF are not");
    const overview = await db.app.getQueueOverview(TENANT_O);
    assert.equal(overview.batchesTotal, 2);
    assert.deepEqual([overview.overview.pagesTotal, overview.overview.pagesRead, overview.overview.pagesWaiting, overview.overview.pagesReading, overview.overview.filesDone,
      overview.overview.filesUploaded, overview.overview.heldPages], [open.reduce((t, b) => t + b.rowsExpected, 0), open.reduce((t, b) => t + b.completed, 0),
      open.reduce((t, b) => t + b.queued, 0), open.reduce((t, b) => t + b.processing, 0), open.reduce((t, b) => t + b.filesDone, 0), open.reduce((t, b) => t + b.uploaded, 0), 0]);
    assert.equal(overview.holdsAvailable, false, "Release A: no holds");
    // The strip's own reads carry the same position; a closed batch has none.
    assert.equal((await db.app.getBatch(TENANT_O, mixed))!.queuePosition, 2);
    assert.equal((await db.app.getBatch(TENANT_O, finished))!.queuePosition, null);
    assert.deepEqual((await db.app.listBatches(TENANT_O)).filter((batch) => batch.batchId === failed).map((batch) => batch.queuePosition), [null]);
    // Tenant isolation: another organization sees none of these batches, and its totals are its own.
    await seedBatch(TENANT_P, [{ status: "CLEAN" }]);
    assert.deepEqual((await db.app.listOpenBatches(TENANT_P)).map((batch) => batch.uploaded), [1]);
    assert.equal((await db.app.getQueueOverview(TENANT_P)).overview.pagesTotal, 1);
    assert.ok((await db.app.listOpenBatches(TENANT_O)).every((batch) => batch.batchId !== undefined && batch.batchId !== null));
  });

  test("measured rate from processed_at: the last 21 reads of the last 24 h, a 20-minute stop ignored, null with fewer than 5 gaps", async () => {
    await orgs();
    const tenant = randomUUID();
    await db.superDb.query("INSERT INTO organizations(id, name) VALUES ($1, 'Rate')", [tenant]);
    const batchId = await seedBatch(tenant, [{ status: "CLEAN" }]);
    const read = async (secondsAgo: number, status = "SUCCEEDED") => db.superDb.query(
      `INSERT INTO documents(id, organization_id, public_id, status, filename, mime_type, size_bytes, content_hash, batch_id, processed_at)
       VALUES (gen_random_uuid(), $1, md5(random()::text), $2::document_status, 'seed', 'image/png', 1, 'h', $3, now() - $4 * interval '1 second')`, [tenant, status, batchId, secondsAgo]);
    assert.deepEqual(await db.app.measureRate(tenant), { secondsPerPage: null, sample: 0 });
    for (const ago of [4000, 3800, 3600]) await read(ago);
    assert.equal((await db.app.measureRate(tenant)).secondsPerPage, null, "2 gaps");
    // A 20-minute stop, then reads every 190 s; a FAILED read and a read older than 24 h never count.
    for (const ago of [2400, 2210, 2020, 1830, 1640]) await read(ago);
    await read(1500, "FAILED");
    await read(90_000);
    await read(1450, "NEEDS_REVIEW");
    const rate = await db.app.measureRate(tenant);
    assert.deepEqual(rate, { secondsPerPage: 190, sample: 7 }, "9 reads → 8 gaps: 200, 200, (1200 s stop dropped), 190 × 5");
    assert.equal((await db.app.getQueueOverview(tenant)).overview.secondsPerPage, 190);
  });

  // The bound is on the MEDIAN of 7 warm runs (recorded deviation DEV-2): on a shared, heavily loaded laptop the slowest
  // single run measures the scheduler, not the query. Every run is printed for the report.
  test("timing: getQueueOverview over 30,000 documents in 250 open batches stays under 300 ms (median of 7 warm runs)", { timeout: 900_000 }, async (t) => {
    await orgs();
    await db.superDb.query(`
      WITH batches AS (
        INSERT INTO ocr_batches(organization_id, created_by, expected_total, created_at)
        SELECT $1, 'seed', 20, now() - interval '2 days' + g * interval '1 minute' FROM generate_series(1, 250) g RETURNING id),
      parents AS (
        INSERT INTO documents(id, organization_id, public_id, status, filename, mime_type, size_bytes, content_hash, batch_id, page_count, processed_at)
        SELECT gen_random_uuid(), $1, md5(random()::text || g), 'SPLIT', 'seed.pdf', 'application/pdf', 1, 'h', b.id, 25, now() - interval '1 day'
        FROM batches b CROSS JOIN generate_series(1, 4) g RETURNING id, batch_id),
      pages AS (
        INSERT INTO documents(id, organization_id, public_id, status, filename, mime_type, size_bytes, content_hash, batch_id, parent_document_id, page_number, page_count, processed_at)
        SELECT gen_random_uuid(), $1, md5(random()::text || p.id::text || g), CASE WHEN g <= 6 THEN 'SUCCEEDED'::document_status ELSE 'CLEAN'::document_status END,
               'seed.pdf', 'image/png', 1, 'h', p.batch_id, p.id, g, 25, CASE WHEN g <= 6 THEN now() - (g * interval '190 seconds') END
        FROM parents p CROSS JOIN generate_series(1, 25) g RETURNING 1)
      INSERT INTO documents(id, organization_id, public_id, status, filename, mime_type, size_bytes, content_hash, batch_id)
      SELECT gen_random_uuid(), $1, md5(random()::text || b.id::text || g), 'CLEAN', 'seed.png', 'image/png', 1, 'h', b.id
      FROM batches b CROSS JOIN generate_series(1, 16) g`, [TENANT_T]);
    await db.superDb.query("ANALYZE documents; ANALYZE ocr_batches");
    const count = (await db.superDb.query<{ n: number }>("SELECT count(*)::int AS n FROM documents WHERE organization_id = $1", [TENANT_T])).rows[0]!.n;
    assert.equal(count, 30_000);
    await db.app.getQueueOverview(TENANT_T); // warm-up
    const runs: number[] = [];
    let overview = await db.app.getQueueOverview(TENANT_T);
    for (let run = 0; run < 7; run += 1) {
      const started = performance.now();
      overview = await db.app.getQueueOverview(TENANT_T);
      runs.push(Math.round(performance.now() - started));
    }
    const strip: number[] = [];
    for (let run = 0; run < 7; run += 1) {
      const started = performance.now();
      await db.app.listBatches(TENANT_T, 20);
      strip.push(Math.round(performance.now() - started));
    }
    const middle = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
    t.diagnostic(`getQueueOverview ms over 7 warm runs: ${runs.join(", ")} (median ${middle(runs)}); listBatches(20) ms: ${strip.join(", ")} (median ${middle(strip)}); host load ${loadavg().map((value) => value.toFixed(1)).join(" / ")}`);
    assert.deepEqual([overview.batchesTotal, overview.batches.length, overview.overview.pagesTotal, overview.overview.pagesRead, overview.overview.filesUploaded],
      [250, 50, 29_000, 6000, 5000], "29,000 page/image rows (the 1,000 SPLIT parents are no rows), 6,000 read, 5,000 files");
    assert.ok(middle(runs) < 300, `median ${middle(runs)} ms (runs ${runs.join(", ")})`);
  });
});
