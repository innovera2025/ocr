/**
 * Batch-first order (plan queue-control D3, Phase 1.7) against PostgreSQL as the real runtime roles: the 0022 backfill
 * run by ocr_migrator under FORCE RLS, the priority every insert site writes, and the order the REAL `ocr_claim_v1`
 * (owned by ocr_queue_definer, called as ocr_queue) hands jobs out in. Bootstrap: `queue-db-harness.ts`.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { Pool } from "pg";
import type { PageDocumentInput } from "./index.js";
import { fakeKey, openQueueDb, skipWithoutDatabase, type QueueDb } from "./queue-db-harness.js";

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const LATER = () => new Date(Date.now() + 60_000);

describe("batch-first order against PostgreSQL as the runtime roles", { skip: skipWithoutDatabase }, () => {
  let db: QueueDb;
  /** Batches seeded BEFORE 0022, in this (created_at, id) order: the backfill must number them 1, 2, 3. */
  const seeded: string[] = [];

  before(async () => {
    db = await openQueueDb({ stopBefore: "0022_queue_control" });
    await db.superDb.query("INSERT INTO organizations(id, name, created_at) VALUES ($1, 'Tenant A', now() - interval '2 days'), ($2, 'Tenant B', now() - interval '3 days')", [TENANT_A, TENANT_B]);
    // Two batches share one created_at (the id breaks the tie); the organizations are interleaved by age.
    const ids = [randomUUID(), randomUUID()].sort();
    const rows: Array<[string, string, string]> = [
      [ids[1]!, TENANT_A, "2026-10-01T08:00:00Z"], [randomUUID(), TENANT_B, "2026-10-01T09:00:00Z"], [ids[0]!, TENANT_B, "2026-10-01T08:00:00Z"]];
    for (const [id, org, at] of rows) {
      await db.superDb.query("INSERT INTO ocr_batches(id, organization_id, created_by, expected_total, created_at) VALUES ($1, $2, 'seed', 10, $3)", [id, org, at]);
    }
    seeded.push(ids[0]!, ids[1]!, rows[1]![0]);
  });
  after(async () => { await db?.close(); });

  const queueSeq = async (batchId: string) => (await db.superDb.query<{ q: number | null }>("SELECT queue_seq AS q FROM ocr_batches WHERE id = $1", [batchId])).rows[0]!.q;
  const jobOf = async (runId: string) => (await db.superDb.query<{ id: string; priority: number; available_at: Date }>(
    "SELECT id, priority, available_at FROM extraction_jobs WHERE run_id = $1 ORDER BY created_at DESC LIMIT 1", [runId])).rows[0]!;
  async function upload(tenantId: string, filename: string, mimeType = "image/png", batchId?: string) {
    const doc = await db.app.createUploadedDocument({ tenantId, filename: `${filename}-${randomBytes(3).toString("hex")}`, mimeType, sizeBytes: 4242,
      contentHash: "p".repeat(64), storageKey: fakeKey(tenantId), ...(batchId ? { batchId } : {}) });
    await db.app.updateScanStatus(tenantId, doc.documentId, "CLEAN");
    return doc;
  }
  /** What `runtime.ts` does: enqueue the upload job with priority = queueSeq (0 without a batch). */
  async function uploadAndEnqueue(tenantId: string, filename: string, batchId?: string) {
    const doc = await upload(tenantId, filename, "image/png", batchId);
    const jobId = await db.appQueue.enqueue({ organizationId: tenantId, runId: doc.runId, priority: doc.queueSeq ?? 0 });
    return { ...doc, jobId };
  }
  const pageInputs = (tenantId: string, parentId: string, numbers: number[]): PageDocumentInput[] => numbers.map((pageNumber) => {
    const publicId = createHash("sha256").update(`page:${parentId}:${pageNumber}`).digest("hex").slice(0, 32);
    return { pageNumber, publicId, storageKey: `org/${tenantId}/original/${publicId.slice(0, 2)}/${publicId}`, mimeType: "image/png", sizeBytes: 1000 + pageNumber, contentHash: "c".repeat(64) };
  });
  async function pageJobs(parentId: string) {
    return (await db.superDb.query<{ id: string; page_number: number; priority: number; exact: boolean }>(
      `SELECT j.id, d.page_number, j.priority, j.available_at = p.created_at + d.page_number * interval '1 microsecond' AS exact
       FROM extraction_jobs j JOIN document_runs r ON r.id = j.run_id JOIN documents d ON d.id = r.document_id JOIN documents p ON p.id = d.parent_document_id
       WHERE d.parent_document_id = $1 ORDER BY d.page_number`, [parentId])).rows;
  }
  /** Claims with the real ocr_claim_v1 until the queue is empty; returns the names of the jobs in `names`, in claim order. */
  async function drain(names: Map<string, string>): Promise<string[]> {
    const order: string[] = [];
    for (let claimed = await db.queue.claim(LATER()); claimed; claimed = await db.queue.claim(LATER())) {
      const name = names.get(claimed.jobId);
      if (name) order.push(name);
      await db.queue.finishDetailed(claimed.jobId, claimed.leaseToken, "SUCCEEDED");
    }
    return order;
  }

  test("(a) 0022 as ocr_migrator under FORCE RLS numbers every existing batch by (created_at, id); the sequence continues above the maximum", async () => {
    const before = await db.superDb.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'ocr_batches' AND column_name = 'queue_seq'");
    assert.equal(before.rowCount, 0, "seeded on the 0021 schema");
    const now = await db.migrateRest();
    assert.deepEqual(now, ["0022_queue_control"]);
    assert.deepEqual(await Promise.all(seeded.map(queueSeq)), [1, 2, 3], "oldest first, the id breaks a created_at tie, across organizations");
    const nulls = await db.superDb.query<{ n: number }>("SELECT count(*)::int AS n FROM ocr_batches WHERE queue_seq IS NULL");
    assert.equal(nulls.rows[0]!.n, 0, "the backfill affected every row (0 rows would mean RLS hid them from the migrator)");
    const force = await db.superDb.query<{ f: boolean }>("SELECT relforcerowsecurity AS f FROM pg_class WHERE relname = 'ocr_batches'");
    assert.equal(force.rows[0]!.f, true, "FORCE RLS is back on after the backfill");
    const created = await db.app.createBatch(TENANT_A, { createdBy: "user-a", expectedTotal: 3 });
    assert.equal(await queueSeq(created.batchId), 4, "a new batch takes the next number from the column default (ocr_app holds USAGE on the sequence)");
    const control = await db.superDb.query("SELECT id, stopped_at, round_cap, round_no, round_done FROM queue_control");
    assert.deepEqual(control.rows, [{ id: true, stopped_at: null, round_cap: null, round_no: 1, round_done: 0 }]);
    // The file runs again as the migrator inside one transaction without raising and without renumbering anything.
    const migrator = new Pool({ connectionString: db.roleUrl("ocr_migrator"), max: 1 });
    try {
      const client = await migrator.connect();
      try {
        await client.query("BEGIN");
        await client.query(readFileSync(new URL("../../../prisma/migrations/0022_queue_control/migration.sql", import.meta.url), "utf8"));
        await client.query("ROLLBACK");
      } finally { client.release(); }
    } finally { await migrator.end(); }
    assert.deepEqual(await Promise.all(seeded.map(queueSeq)), [1, 2, 3]);
    // No routine was created and the queue routines keep their definer owner.
    const owners = await db.superDb.query<{ proname: string; owner: string }>(
      "SELECT proname, pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE proname IN ('ocr_claim_v1','ocr_heartbeat_v1','ocr_finish_retry_v1','ocr_recover_expired_v1') ORDER BY proname");
    assert.deepEqual(owners.rows.map((row) => row.owner), ["ocr_queue_definer", "ocr_queue_definer", "ocr_queue_definer", "ocr_queue_definer"]);
  });

  test("(b) an upload into a batch carries queueSeq and its job priority = queue_seq; without a batch 0; queuePriorityOf agrees", async () => {
    const batch = await db.app.createBatch(TENANT_A, { createdBy: "user-a", expectedTotal: 2 });
    const seq = await queueSeq(batch.batchId);
    const inBatch = await uploadAndEnqueue(TENANT_A, "in-batch.png", batch.batchId);
    assert.equal(inBatch.queueSeq, seq);
    assert.equal((await jobOf(inBatch.runId)).priority, seq);
    const single = await uploadAndEnqueue(TENANT_A, "single.png");
    assert.equal(single.queueSeq, undefined);
    assert.equal((await jobOf(single.runId)).priority, 0);
    assert.equal(await db.app.queuePriorityOf(TENANT_A, inBatch.documentId), seq);
    assert.equal(await db.app.queuePriorityOf(TENANT_A, single.documentId), 0);
    await assert.rejects(db.app.queuePriorityOf(TENANT_B, inBatch.documentId), { message: "DOCUMENT_NOT_FOUND" }, "tenant scoped");
    // An idempotent replay of a batch upload still reports the batch's number.
    const keyed = await db.app.createUploadedDocument({ tenantId: TENANT_A, filename: `keyed-${randomBytes(3).toString("hex")}.png`, mimeType: "image/png", sizeBytes: 1,
      contentHash: "h", storageKey: fakeKey(TENANT_A), batchId: batch.batchId, idempotencyKey: "k-1", requestFingerprint: "fp-1" });
    const replay = await db.app.createUploadedDocument({ tenantId: TENANT_A, filename: "whatever.png", mimeType: "image/png", sizeBytes: 1,
      contentHash: "h", storageKey: fakeKey(TENANT_A), batchId: batch.batchId, idempotencyKey: "k-1", requestFingerprint: "fp-1" });
    assert.deepEqual([replay.reused, replay.documentId, replay.queueSeq], [true, keyed.documentId, seq]);
    await drain(new Map());
  });

  test("(c) pages carry their batch's priority and created_at + page µs; the real ocr_claim_v1 returns file 1 p1..p3, file 2 p1..p3, then batch 2", async () => {
    const batch1 = await db.app.createBatch(TENANT_A, { createdBy: "user-a", expectedTotal: 2 });
    const batch2 = await db.app.createBatch(TENANT_A, { createdBy: "user-a", expectedTotal: 1 });
    const pdf1 = await upload(TENANT_A, "file1.pdf", "application/pdf", batch1.batchId);
    const pdf2 = await upload(TENANT_A, "file2.pdf", "application/pdf", batch1.batchId);
    const image = await uploadAndEnqueue(TENANT_A, "batch2.png", batch2.batchId);
    // The worker splits the newer PDF first: the order still follows the upload.
    for (const pdf of [pdf2, pdf1]) {
      await db.worker.markProcessing(TENANT_A, pdf.documentId);
      await db.worker.createPageDocuments(TENANT_A, pdf.documentId, 3, pageInputs(TENANT_A, pdf.documentId, [3, 1, 2]));
    }
    const seq1 = await queueSeq(batch1.batchId);
    const names = new Map<string, string>([[image.jobId, "batch2"]]);
    for (const [label, pdf] of [["file1", pdf1], ["file2", pdf2]] as const) {
      const jobs = await pageJobs(pdf.documentId);
      assert.deepEqual(jobs.map((job) => [job.page_number, job.priority, job.exact]), [[1, seq1, true], [2, seq1, true], [3, seq1, true]]);
      for (const job of jobs) names.set(job.id, `${label}p${job.page_number}`);
    }
    assert.deepEqual(await drain(names), ["file1p1", "file1p2", "file1p3", "file2p1", "file2p2", "file2p3", "batch2"]);
  });

  test("(d) a retried page goes to the back of its batch: after the rest of batch 1, before batch 2", async () => {
    const batch1 = await db.app.createBatch(TENANT_A, { createdBy: "user-a", expectedTotal: 1 });
    const batch2 = await db.app.createBatch(TENANT_A, { createdBy: "user-a", expectedTotal: 1 });
    const pdf = await upload(TENANT_A, "retry.pdf", "application/pdf", batch1.batchId);
    await db.worker.markProcessing(TENANT_A, pdf.documentId);
    await db.worker.createPageDocuments(TENANT_A, pdf.documentId, 4, pageInputs(TENANT_A, pdf.documentId, [1, 2, 3, 4]));
    const jobs = await pageJobs(pdf.documentId);
    // Page 1 is read and fails for good; the other pages are still waiting when it is retried.
    const first = await db.queue.claim(LATER());
    assert.equal(first?.jobId, jobs[0]!.id);
    assert.deepEqual(await db.queue.finishDetailed(first!.jobId, first!.leaseToken, "DEAD", "bad page"), { accepted: true, finalStatus: "DEAD" });
    const page1 = (await db.superDb.query<{ id: string }>("SELECT id FROM documents WHERE parent_document_id = $1 AND page_number = 1", [pdf.documentId])).rows[0]!.id;
    await db.worker.markFailure(TENANT_A, page1, "bad page");
    const other = await uploadAndEnqueue(TENANT_A, "batch2.png", batch2.batchId);
    const { jobId: retried } = await db.app.retryDocument(TENANT_A, page1);
    const retriedJob = (await db.superDb.query<{ priority: number }>("SELECT priority FROM extraction_jobs WHERE id = $1", [retried])).rows[0]!;
    assert.equal(retriedJob.priority, await queueSeq(batch1.batchId));
    const names = new Map<string, string>([[retried, "retried-p1"], [other.jobId, "batch2"], [jobs[1]!.id, "p2"], [jobs[2]!.id, "p3"], [jobs[3]!.id, "p4"]]);
    assert.deepEqual(await drain(names), ["p2", "p3", "p4", "retried-p1", "batch2"]);
    // A retry without a batch gets priority 0.
    const loose = await upload(TENANT_A, "loose.png");
    await db.appQueue.enqueue({ organizationId: TENANT_A, runId: loose.runId, priority: 0 });
    await db.worker.markFailure(TENANT_A, loose.documentId, "x");
    const { jobId: looseRetry } = await db.app.retryDocument(TENANT_A, loose.documentId);
    assert.equal((await db.superDb.query<{ priority: number }>("SELECT priority FROM extraction_jobs WHERE id = $1", [looseRetry])).rows[0]!.priority, 0);
    await drain(new Map());
  });

  test("(e) an upload without a batch is claimed before every batch job (FIFO among themselves)", async () => {
    const batch = await db.app.createBatch(TENANT_A, { createdBy: "user-a", expectedTotal: 2 });
    const b1 = await uploadAndEnqueue(TENANT_A, "b1.png", batch.batchId);
    const b2 = await uploadAndEnqueue(TENANT_A, "b2.png", batch.batchId);
    const s1 = await uploadAndEnqueue(TENANT_A, "s1.png");
    const s2 = await uploadAndEnqueue(TENANT_B, "s2.png");
    const names = new Map([[b1.jobId, "b1"], [b2.jobId, "b2"], [s1.jobId, "s1"], [s2.jobId, "s2"]]);
    assert.deepEqual(await drain(names), ["s1", "s2", "b1", "b2"]);
  });

  test("(f) a priority above the old 10,000 ceiling survives the queue API (queue_seq 20,000)", async () => {
    const batch = await db.app.createBatch(TENANT_B, { createdBy: "user-b", expectedTotal: 1 });
    await db.superDb.query("UPDATE ocr_batches SET queue_seq = 20000 WHERE id = $1", [batch.batchId]);
    const doc = await uploadAndEnqueue(TENANT_B, "big.png", batch.batchId);
    assert.equal(doc.queueSeq, 20_000);
    assert.equal((await jobOf(doc.runId)).priority, 20_000);
    const pdf = await upload(TENANT_B, "big.pdf", "application/pdf", batch.batchId).catch(() => null);
    assert.equal(pdf, null, "expected_total 1: the batch is full (pages never fill it, files do)");
    await drain(new Map());
  });

  test("grants: the worker reads only id, organization_id and queue_seq of ocr_batches, under the tenant's RLS", async () => {
    const batch = await db.app.createBatch(TENANT_A, { createdBy: "user-a", expectedTotal: 1 });
    const seen = await db.asWorker<{ queue_seq: number }>(TENANT_A, "SELECT queue_seq FROM ocr_batches WHERE id = $1", [batch.batchId]);
    assert.equal(seen.length, 1);
    assert.equal((await db.asWorker(TENANT_B, "SELECT queue_seq FROM ocr_batches WHERE id = $1", [batch.batchId])).length, 0, "RLS: another tenant sees nothing");
    await assert.rejects(db.asWorker(TENANT_A, "SELECT label FROM ocr_batches"), { code: "42501" });
    await assert.rejects(db.asWorker(TENANT_A, "UPDATE ocr_batches SET queue_seq = 1"), { code: "42501" });
    await assert.rejects(db.queueRolePool.query("SELECT queue_seq FROM ocr_batches"), { code: "42501" });
    await assert.rejects(db.asApp(TENANT_A, "UPDATE ocr_batches SET queue_seq = 1"), { code: "42501" }, "nobody renumbers a batch at runtime");
  });
});
