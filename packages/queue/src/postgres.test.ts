import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { jobPriority, PostgresQueue } from "./postgres.js";

function fakeQueue(rows: Array<Record<string, unknown>>) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const pool = new Pool();
  Object.assign(pool, { query: async (sql: string, values: unknown[]) => { calls.push({ sql, values }); return { rows }; } });
  return { queue: new PostgresQueue(pool), calls, pool };
}

test("finishDetailed reports the retry policy's final status from ocr_finish_retry_v1", async () => {
  const { queue, calls, pool } = fakeQueue([{ accepted: true, final_status: "PENDING" }]);
  assert.deepEqual(await queue.finishDetailed("job-1", "token", "FAILED", "HTTP 503"), { accepted: true, finalStatus: "PENDING" });
  assert.match(calls[0]!.sql, /SELECT accepted, final_status::text AS final_status FROM ocr_finish_retry_v1\(\$1::uuid, \$2::text, \$3::job_status, \$4::text, now\(\)\)/);
  assert.deepEqual(calls[0]!.values, ["job-1", "token", "FAILED", "HTTP 503"]);
  await pool.end();
});

test("finishDetailed maps DEAD/SUCCEEDED and treats a lost lease as not accepted", async () => {
  for (const status of ["DEAD", "SUCCEEDED", "FAILED"] as const) {
    const { queue, pool } = fakeQueue([{ accepted: true, final_status: status }]);
    assert.deepEqual(await queue.finishDetailed("job", "token", status === "SUCCEEDED" ? "SUCCEEDED" : "FAILED"), { accepted: true, finalStatus: status });
    await pool.end();
  }
  const lost = fakeQueue([]);
  assert.deepEqual(await lost.queue.finishDetailed("job", "stale", "SUCCEEDED"), { accepted: false, finalStatus: null });
  assert.equal(lost.calls[0]!.values[3], null);
  await lost.pool.end();
  const unknown = fakeQueue([{ accepted: true, final_status: "RUNNING" }]);
  assert.deepEqual(await unknown.queue.finishDetailed("job", "token", "DEAD"), { accepted: true, finalStatus: null });
  await unknown.pool.end();
});

test("finish keeps its boolean contract on top of finishDetailed", async () => {
  const accepted = fakeQueue([{ accepted: true, final_status: "SUCCEEDED" }]);
  assert.equal(await accepted.queue.finish("job", "token", "SUCCEEDED"), true);
  await accepted.pool.end();
  const lost = fakeQueue([{ accepted: false, final_status: null }]);
  assert.equal(await lost.queue.finish("job", "token", "FAILED", "x"), false);
  await lost.pool.end();
});

test("enqueue sets the job priority at insert time (default 100, clamped to 0..10000)", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const pool = new Pool();
  const client = { query: async (sql: string, values: unknown[] = []) => { calls.push({ sql, values }); return { rows: [{ id: "job-1" }] }; }, release: () => undefined };
  Object.assign(pool, { connect: async () => client });
  const queue = new PostgresQueue(pool);
  assert.equal(await queue.enqueue({ organizationId: "t", runId: "r", priority: 103 }), "job-1");
  await queue.enqueue({ organizationId: "t", runId: "r" });
  const inserts = calls.filter((call) => call.sql.includes("INSERT INTO extraction_jobs"));
  assert.match(inserts[0]!.sql, /priority\)\s+VALUES \(gen_random_uuid\(\), \$1::uuid, \$2::uuid, \$3, 'PENDING', COALESCE\(\$4, now\(\)\), \$5\)/);
  assert.deepEqual(inserts.map((call) => call.values[4]), [103, 100]);
  assert.deepEqual([jobPriority(undefined), jobPriority(Number.NaN), jobPriority(-5), jobPriority(99.7), jobPriority(1e9)], [100, 100, 0, 99, 10_000]);
  await pool.end();
});
