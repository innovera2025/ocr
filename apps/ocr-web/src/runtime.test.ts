import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { MAX_JOB_PRIORITY } from "@innovera/ocr-queue/postgres";
import { createRuntimeIngest, queueJobPriority } from "./runtime.js";

const tenant = "00000000-0000-0000-0000-000000000001";
const batchId = "10000000-0000-4000-8000-000000000001";
const documentId = "20000000-0000-4000-8000-000000000002";

test("batch-first priority (D3): a batch's jobs take its queue_seq, no batch is 0, nothing is clamped below int4", () => {
  assert.equal(queueJobPriority(undefined), 0);
  assert.deepEqual([1, 2, 222, 20_000].map((seq) => queueJobPriority(seq)), [1, 2, 222, 20_000]);
  assert.equal(queueJobPriority(3e9), MAX_JOB_PRIORITY);
});

test("claim order (priority ASC, available_at ASC like ocr_claim_v1): one batch completely, in upload order, before the next; no batch first", () => {
  type Job = { name: string; priority: number; at: number };
  // Batch 1 (queue_seq 1): file A, a 3-page PDF split later (pages at A.created_at + page µs), then image B uploaded after A.
  const batch1: Job[] = [{ name: "A1", priority: 1, at: 10.001 }, { name: "A2", priority: 1, at: 10.002 }, { name: "A3", priority: 1, at: 10.003 },
    { name: "B", priority: 1, at: 12 }];
  const batch2: Job[] = [{ name: "C", priority: 2, at: 5 }, { name: "D", priority: 2, at: 6 }];
  const single: Job = { name: "single", priority: queueJobPriority(undefined), at: 50 };
  const order = [...batch2, single, ...batch1].sort((a, b) => a.priority - b.priority || a.at - b.at).map((job) => job.name);
  assert.deepEqual(order, ["single", "A1", "A2", "A3", "B", "C", "D"]);
});

/** A pg Pool whose clients answer the statements `createUploadedDocument` and `PostgresQueue.enqueue` send. */
function fakePool(options: { queueSeq: number | null; lookupPriority?: number }) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const answer = (sql: string): Record<string, unknown>[] => {
    if (sql.includes("SELECT b.expected_total")) return [{ expected_total: 10, uploaded: 2, queue_seq: options.queueSeq }];
    if (sql.includes("INSERT INTO documents")) return [{ id: documentId, public_id: "p".repeat(32) }];
    if (sql.includes("INSERT INTO document_runs")) return [{ id: "30000000-0000-4000-8000-000000000003" }];
    if (sql.includes("INSERT INTO extraction_jobs")) return [{ id: "job-1" }];
    if (sql.includes("COALESCE(b.queue_seq, 0)::int AS priority")) return [{ priority: options.lookupPriority ?? 0 }];
    return [];
  };
  const client = {
    query: async (sql: string, values: unknown[] = []) => { statements.push({ sql, values }); const rows = answer(sql); return { rows, rowCount: rows.length }; },
    release: () => undefined, on: () => client, removeListener: () => client
  };
  const pool = new Pool();
  Object.assign(pool, { connect: async () => client, query: client.query });
  const jobPriorities = () => statements.filter((statement) => statement.sql.includes("INSERT INTO extraction_jobs")).map((statement) => statement.values[4]);
  return { pool, statements, jobPriorities };
}

test("persistUpload hands the batch's queue_seq to enqueue as the job priority; an upload without a batch gets 0", async () => {
  const batched = fakePool({ queueSeq: 7 });
  const ingest = createRuntimeIngest(batched.pool, tenant, undefined, batchId);
  const persisted = await ingest.persistUpload!({ filename: "a.png", mimeType: "image/png", bytes: new Uint8Array([1]), stagedKey: "k" });
  assert.equal(persisted.priority, 7);
  assert.equal("queueSeq" in persisted, false, "the queue number stays internal");
  assert.equal("batchPosition" in persisted, false);
  await ingest.enqueuePersistent!({ tenantId: tenant, documentId, runId: "r", stagedKey: "k", priority: persisted.priority! });
  assert.deepEqual(batched.jobPriorities(), [7]);
  await batched.pool.end();

  const single = fakePool({ queueSeq: null });
  const plain = createRuntimeIngest(single.pool, tenant);
  const unbatched = await plain.persistUpload!({ filename: "b.png", mimeType: "image/png", bytes: new Uint8Array([1]), stagedKey: "k" });
  assert.equal(unbatched.priority, 0);
  await single.pool.end();
});

test("a resumed upload (no priority from persistUpload) looks its batch's priority up instead of taking the column default 100", async () => {
  const resumed = fakePool({ queueSeq: 9, lookupPriority: 9 });
  const ingest = createRuntimeIngest(resumed.pool, tenant, "key", batchId);
  await ingest.enqueuePersistent!({ tenantId: tenant, documentId, runId: "r", stagedKey: "k" });
  assert.deepEqual(resumed.jobPriorities(), [9]);
  const lookup = resumed.statements.filter((statement) => statement.sql.includes("COALESCE(b.queue_seq, 0)::int AS priority"));
  assert.equal(lookup.length, 1, "one SELECT");
  assert.deepEqual(lookup[0]!.values, [documentId, tenant]);
  await resumed.pool.end();

  const noBatch = fakePool({ queueSeq: null, lookupPriority: 0 });
  await createRuntimeIngest(noBatch.pool, tenant, "key").enqueuePersistent!({ tenantId: tenant, documentId, runId: "r", stagedKey: "k" });
  assert.deepEqual(noBatch.jobPriorities(), [0]);
  await noBatch.pool.end();
});

test("a batch that the backfill missed is refused rather than jumping the queue as priority 0", async () => {
  const missing = fakePool({ queueSeq: null });
  const ingest = createRuntimeIngest(missing.pool, tenant, undefined, batchId);
  await assert.rejects(ingest.persistUpload!({ filename: "c.png", mimeType: "image/png", bytes: new Uint8Array([1]), stagedKey: "k" }), { message: "BATCH_QUEUE_SEQ_MISSING" });
  await missing.pool.end();
});
