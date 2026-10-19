/**
 * The one-off reorder script `deploy/sql/queue-reorder-once.sql` (plan queue-control D4, Phase 5.1), run with psql as
 * the superuser against a database seeded like production before AP-3: jobs queued with the old fair-share priorities
 * (100 + position / page), some batches without a queue number, a RUNNING and a SUCCEEDED job.
 *
 * psql: `OCR_TEST_PSQL` is a command prefix that runs psql as the superuser of the disposable server and reads the script
 * from stdin, e.g. `docker exec -i ocr-it-pg-queue psql -U postgres`; without it a local `psql` is used with the
 * bootstrap DSN. Neither → skipped (named, never silent). Bootstrap: `queue-db-harness.ts`.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { bootstrapUrl, openQueueDb, repo, skipWithoutDatabase, type QueueDb } from "./queue-db-harness.js";

const script = readFileSync(new URL("deploy/sql/queue-reorder-once.sql", repo), "utf8");
function localPsql(): boolean { try { execFileSync("psql", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } }
const psqlPrefix = process.env.OCR_TEST_PSQL?.trim().split(/\s+/).filter(Boolean) ?? null;
const skip: false | string = skipWithoutDatabase || (psqlPrefix || localPsql() ? false : "set OCR_TEST_PSQL (e.g. 'docker exec -i <container> psql -U postgres') or install psql");

type Run = { status: number; out: Record<string, string>; stdout: string; stderr: string };
const TENANT = randomUUID();

describe("queue-reorder-once.sql against PostgreSQL", { skip }, () => {
  let db: QueueDb;
  const ids: Record<string, string> = {};
  let before0: Map<string, string>;

  /** Runs the script with `-v apply=<n>` (and optional variables) as the superuser; returns the key|value lines. */
  function psql(database: string, vars: Record<string, string>): Run {
    const flags = ["-X", "-q", "-v", "ON_ERROR_STOP=1", ...Object.entries(vars).flatMap(([key, value]) => ["-v", `${key}=${value}`])];
    let command: string, args: string[];
    if (psqlPrefix) { command = psqlPrefix[0]!; args = [...psqlPrefix.slice(1), ...flags, "-d", database, "-f", "-"]; }
    else { const url = new URL(bootstrapUrl!); url.pathname = `/${database}`; command = "psql"; args = [...flags, "-d", url.toString(), "-f", "-"]; }
    const result = spawnSync(command, args, { input: script, encoding: "utf8", timeout: 120_000 });
    const out = Object.fromEntries(String(result.stdout).split("\n").filter((line) => line.includes("|")).map((line) => line.split("|", 2) as [string, string]));
    return { status: result.status ?? -1, out, stdout: String(result.stdout), stderr: String(result.stderr) };
  }
  /** Every job's (status, priority, available_at µs) by id, as text, for exact before/after comparisons. */
  async function snapshot(): Promise<Map<string, string>> {
    const rows = await db.superDb.query<{ id: string; v: string }>(
      "SELECT id, status::text || '|' || priority || '|' || to_char(available_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS v FROM extraction_jobs");
    return new Map(rows.rows.map((row) => [row.id, row.v]));
  }
  /** Claim order of the real ocr_claim_v1, inside a transaction that is rolled back (nothing changes). */
  async function claimOrder(): Promise<string[]> {
    const client = await db.superDb.connect();
    const names = new Map(Object.entries(ids).map(([name, id]) => [id, name]));
    try {
      await client.query("BEGIN");
      const order: string[] = [];
      for (;;) {
        const claimed = await client.query<{ job_id: string }>("SELECT job_id FROM ocr_claim_v1(now() + interval '1 hour')");
        if (!claimed.rows[0]) break;
        order.push(names.get(claimed.rows[0].job_id) ?? "?");
      }
      return order;
    } finally { await client.query("ROLLBACK"); client.release(); }
  }

  before(async () => {
    db = await openQueueDb();
    await db.superDb.query("INSERT INTO organizations(id, name) VALUES ($1, 'Reorder')", [TENANT]);
    // Production-like history: batch 1 (older) and batch 2 (newer); batch 3 lost its number (NULL).
    // Numbered by the column default (the sequence), like every batch after 0022; batch 3's number is then removed.
    const batch = async (createdAt: string) => (await db.superDb.query<{ id: string }>(
      "INSERT INTO ocr_batches(organization_id, created_by, expected_total, created_at) VALUES ($1, 'seed', 5, $2) RETURNING id", [TENANT, createdAt])).rows[0]!.id;
    const b1 = await batch("2026-10-01T01:00:00Z"), b2 = await batch("2026-10-02T01:00:00Z"), b3 = await batch("2026-10-03T01:00:00Z");
    await db.superDb.query("UPDATE ocr_batches SET queue_seq = NULL WHERE id = $1", [b3]);
    const doc = async (batchId: string | null, mime: string, status: string, createdAt: string, parent?: { id: string; page: number }) => (await db.superDb.query<{ id: string }>(
      `INSERT INTO documents(id, organization_id, public_id, status, filename, mime_type, size_bytes, content_hash, batch_id, created_at, parent_document_id, page_number, page_count)
       VALUES (gen_random_uuid(), $1, $2, $3::document_status, 'seed', $4, 1, 'h', $5, $6, $7, $8, $9) RETURNING id`,
      [TENANT, randomBytes(16).toString("hex"), status, mime, batchId, createdAt, parent?.id ?? null, parent?.page ?? null, parent ? 3 : null])).rows[0]!.id;
    const job = async (name: string, documentId: string, status: string, priority: number, availableAt: string) => {
      const run = (await db.superDb.query<{ id: string }>("INSERT INTO document_runs(id, organization_id, document_id, outcome) VALUES (gen_random_uuid(), $1, $2, 'RUNNING') RETURNING id", [TENANT, documentId])).rows[0]!.id;
      ids[name] = (await db.superDb.query<{ id: string }>(
        `INSERT INTO extraction_jobs(id, organization_id, run_id, kind, status, priority, available_at, attempts) VALUES (gen_random_uuid(), $1, $2, 'OCR', $3::job_status, $4, $5, $6) RETURNING id`,
        [TENANT, run, status, priority, availableAt, status === "PENDING" ? 0 : 1])).rows[0]!.id;
    };
    // Batch 1: a 3-page PDF split long ago (pages 100/101/102, available when split) and an image (101).
    const pdf = await doc(b1, "application/pdf", "SPLIT", "2026-10-01T01:05:00.000001Z");
    for (const page of [1, 2, 3]) await job(`b1p${page}`, await doc(b1, "image/png", "CLEAN", "2026-10-01T01:05:00.000001Z", { id: pdf, page }), "PENDING", 99 + page, "2026-10-05T10:00:00Z");
    await job("b1img", await doc(b1, "image/png", "CLEAN", "2026-10-01T01:06:00Z"), "PENDING", 101, "2026-10-01T01:06:00Z");
    // Batch 2: two images queued earlier than batch 1's pages became available (the old interleave).
    await job("b2a", await doc(b2, "image/png", "CLEAN", "2026-10-02T01:01:00Z"), "PENDING", 101, "2026-10-02T01:01:00Z");
    await job("b2b", await doc(b2, "image/png", "CLEAN", "2026-10-02T01:02:00Z"), "PENDING", 102, "2026-10-02T01:02:00Z");
    // Batch 3 (no number yet) and an upload without a batch; a PDF of batch 2 that is still to be split.
    await job("b3a", await doc(b3, "image/png", "CLEAN", "2026-10-03T01:01:00Z"), "PENDING", 101, "2026-10-03T01:01:00Z");
    await job("single", await doc(null, "image/png", "CLEAN", "2026-10-04T01:01:00Z"), "PENDING", 100, "2026-10-04T01:01:00Z");
    await job("b2pdf", await doc(b2, "application/pdf", "CLEAN", "2026-10-02T01:03:00Z"), "PENDING", 103, "2026-10-02T01:03:00Z");
    // Never touched: one in flight, one done.
    await job("running", await doc(b2, "image/png", "PROCESSING", "2026-10-02T01:04:00Z"), "RUNNING", 104, "2026-10-02T01:04:00Z");
    await job("done", await doc(b1, "image/png", "SUCCEEDED", "2026-10-01T01:07:00Z"), "SUCCEEDED", 102, "2026-10-01T01:07:00Z");
    before0 = await snapshot();
  });
  after(async () => { await db?.close(); });

  test("the old order interleaves batches (the reason for this script)", async () => {
    assert.deepEqual(await claimOrder(), ["single", "b1p1", "b1img", "b2a", "b3a", "b1p2", "b2b", "b1p3", "b2pdf"]);
  });

  test("dry run: counts only, nothing changes, no backup table", async () => {
    const run = psql(db.database, { apply: "0" });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual([run.out.mode, run.out.pending_total, run.out.running_total, run.out.pending_page, run.out.pending_file, run.out.pending_split_parent, run.out.pending_no_batch,
      run.out.batches_without_queue_seq, run.out.backup_exists], ["dry_run", "9", "1", "3", "5", "1", "1", "1", "f"]);
    assert.ok(Number(run.out.pending_would_change) >= 8, run.out.pending_would_change);
    assert.doesNotMatch(run.stdout, /seed|[0-9a-f]{8}-[0-9a-f]{4}-/, "no file name and no id in the output");
    assert.deepEqual(await snapshot(), before0);
    assert.equal((await db.superDb.query("SELECT to_regclass($1) AS t", [run.out.backup_table])).rows[0].t, null);
    assert.equal((await db.superDb.query<{ n: number }>("SELECT count(*)::int AS n FROM ocr_batches WHERE queue_seq IS NULL")).rows[0]!.n, 1);
  });

  test("apply: PENDING jobs only; the backup holds exactly the changed rows; the claim order is batch-first; RUNNING and SUCCEEDED untouched", async () => {
    const run = psql(db.database, { apply: "1" });
    assert.equal(run.status, 0, run.stderr);
    const afterApply = await snapshot();
    const changed = [...afterApply].filter(([id, value]) => before0.get(id) !== value).map(([id]) => id);
    assert.deepEqual([run.out.batches_numbered, run.out.jobs_reordered, run.out.backup_rows, run.out.pending_total], ["1", String(changed.length), String(changed.length), "9"]);
    assert.equal(afterApply.get(ids.running!), before0.get(ids.running!));
    assert.equal(afterApply.get(ids.done!), before0.get(ids.done!));
    for (const id of changed) assert.match(afterApply.get(id)!, /^PENDING\|/);
    const backup = await db.superDb.query<{ job_id: string }>(`SELECT job_id FROM ${run.out.backup_table}`);
    assert.deepEqual(backup.rows.map((row) => row.job_id).sort(), [...changed].sort(), "backup rows = changed rows");
    assert.equal((await db.superDb.query<{ n: number }>("SELECT count(*)::int AS n FROM ocr_batches WHERE queue_seq IS NULL")).rows[0]!.n, 0);
    // Pages land at parent created_at + page µs, in page order, ahead of the image uploaded after the PDF.
    assert.deepEqual(await claimOrder(), ["single", "b1p1", "b1p2", "b1p3", "b1img", "b2a", "b2b", "b2pdf", "b3a"]);
  });

  test("a second apply refuses (the backup exists) and changes nothing", async () => {
    const snap = await snapshot();
    const run = psql(db.database, { apply: "1" });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /backup table already exists/);
    assert.deepEqual(await snapshot(), snap);
  });

  test("revert restores the exact old priority and available_at of the jobs still PENDING", async () => {
    const run = psql(db.database, { apply: "2" });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(await snapshot(), before0, "microsecond-exact");
    assert.equal(Number(run.out.jobs_restored), Number(run.out.backup_rows));
    assert.deepEqual(await claimOrder(), ["single", "b1p1", "b1img", "b2a", "b3a", "b1p2", "b2b", "b1p3", "b2pdf"]);
    const bad = psql(db.database, { apply: "2", backup_date: "19990101" });
    assert.notEqual(bad.status, 0, "revert without a backup table refuses");
    assert.notEqual(psql(db.database, { apply: "7" }).status, 0, "apply must be 0, 1 or 2");
    assert.notEqual(psql(db.database, {}).status, 0, "apply is required");
  });

  test("runtime: 30,000 PENDING jobs reorder in under 10 s", { timeout: 900_000 }, async (t) => {
    // Separate statements: one statement with chained data-modifying CTEs took minutes here (RI checks), these take seconds.
    const seed = randomUUID();
    await db.superDb.query("INSERT INTO organizations(id, name) VALUES ($1, 'Reorder timing')", [seed]);
    await db.superDb.query("INSERT INTO ocr_batches(organization_id, created_by, expected_total, created_at) SELECT $1, 'seed', 120, now() - interval '3 days' + g * interval '1 minute' FROM generate_series(1, 250) g", [seed]);
    await db.superDb.query(`INSERT INTO documents(id, organization_id, public_id, status, filename, mime_type, size_bytes, content_hash, batch_id, page_count)
      SELECT gen_random_uuid(), b.organization_id, md5(random()::text || b.id::text || g), 'SPLIT', 'seed.pdf', 'application/pdf', 1, 'h', b.id, 30
      FROM ocr_batches b CROSS JOIN generate_series(1, 4) g WHERE b.organization_id = $1`, [seed]);
    await db.superDb.query(`INSERT INTO documents(id, organization_id, public_id, status, filename, mime_type, size_bytes, content_hash, batch_id, parent_document_id, page_number, page_count)
      SELECT gen_random_uuid(), p.organization_id, md5(random()::text || p.id::text || g), 'CLEAN', 'seed.pdf', 'image/png', 1, 'h', p.batch_id, p.id, g, 30
      FROM documents p CROSS JOIN generate_series(1, 30) g WHERE p.organization_id = $1 AND p.parent_document_id IS NULL`, [seed]);
    await db.superDb.query(`INSERT INTO document_runs(id, organization_id, document_id, outcome)
      SELECT gen_random_uuid(), organization_id, id, 'RUNNING' FROM documents WHERE organization_id = $1 AND parent_document_id IS NOT NULL`, [seed]);
    await db.superDb.query(`INSERT INTO extraction_jobs(id, organization_id, run_id, kind, status, priority, available_at)
      SELECT gen_random_uuid(), organization_id, id, 'OCR', 'PENDING', 100 + (random() * 30)::int, now() - random() * interval '2 days'
      FROM document_runs WHERE organization_id = $1`, [seed]);
    await db.superDb.query("ANALYZE");
    const started = performance.now();
    const run = psql(db.database, { apply: "1", backup_date: "20990101" });
    const elapsed = Math.round(performance.now() - started);
    assert.equal(run.status, 0, run.stderr);
    t.diagnostic(`reorder of ${run.out.pending_total} PENDING jobs (${run.out.jobs_reordered} changed): ${elapsed} ms (psql round trip included)`);
    assert.ok(Number(run.out.jobs_reordered) >= 30_000);
    assert.ok(elapsed < 10_000, `${elapsed} ms`);
  });
});
