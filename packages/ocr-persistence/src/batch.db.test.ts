/**
 * PostgreSQL integration test for batches, review, retry, queue and confirm outbox — run as the real runtime roles.
 *
 * Runs only when OCR_TEST_DATABASE_URL_BOOTSTRAP is a superuser DSN of a DISPOSABLE server (roles are cluster-wide;
 * this test (re)sets the passwords of ocr_migrator/ocr_app/ocr_worker/ocr_queue to random values and refuses to run
 * when those roles own a non-test database). Per run it creates database ocr_it_<random> owned by ocr_migrator,
 * provisions roles like deploy/provision-roles.sh, applies every migration as ocr_migrator, applies
 * deploy/sql/queue-definer.sql as superuser, exercises the app/worker/queue roles and drops the database.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { Pool } from "pg";
import { hasReviewFields, PostgresOcrDocumentStore, PostgresUserStore, toStructuredResult, withTenant,
  type AuditContext, type DocumentView, type PageDocumentInput, type SessionRevokeReason, type UserRole } from "./index.js";

type Claimed = { jobId: string; organizationId: string; runId: string; kind: string; leaseToken: string };
type Queue = {
  enqueue(input: { organizationId: string; runId: string; priority?: number }): Promise<string>;
  claim(now?: Date): Promise<Claimed | null>;
  heartbeat(jobId: string, leaseToken: string, now?: Date): Promise<boolean>;
  finishDetailed(jobId: string, leaseToken: string, outcome: "SUCCEEDED" | "FAILED" | "DEAD", error?: string): Promise<{ accepted: boolean; finalStatus: string | null }>;
  recoverExpired(now?: Date): Promise<number>;
  close(): Promise<void>;
};
type Outbox = { dispatchOnce(sender: (payload: Readonly<Record<string, unknown>>) => Promise<void>): Promise<{ claimed: boolean; delivered: boolean }>; recoverExpired(): Promise<number> };

const bootstrapUrl = process.env.OCR_TEST_DATABASE_URL_BOOTSTRAP;
const repo = new URL("../../../", import.meta.url);
/** The last migration directory on disk: the runner must end there, whatever number the newest release carries. */
const NEWEST_MIGRATION = readdirSync(new URL("prisma/migrations/", repo), { withFileTypes: true })
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().at(-1)!;
const ROLES = ["ocr_migrator", "ocr_app", "ocr_worker", "ocr_queue"] as const;
type Role = typeof ROLES[number];
const TENANT_A = randomUUID();
const TENANT_B = randomUUID();

const field = (raw: string | null, value: string | null, confidence: number, needsReview = false, source = "ocr") => ({ raw, value, confidence, source, needsReview });
const treatment = (raw: string, nameRaw: string, value: string | null, duration: string, confidence: number, needsReview = false) =>
  ({ ...field(raw, value, confidence, needsReview, value ? "master-fuzzy" : "none"), nameRaw, duration, durationMinutes: Number.parseInt(duration, 10) });
const cleanResponse = { documentId: `local-${randomUUID()}`, engine: "typhoon-sections", version: "3.0", schemaVersion: 3,
  customerInformation: { name: field("Somchai", "Somchai", 0.92), gender: field("Male", "Male", 0.97, false, "checkbox"), nationality: field("Thai", "Thai", 0.9) },
  recommendationCard: { pressure: field("Strong", "Strong", 0.9, false, "checkbox") },
  staffOnly: { treatments: [treatment("ไทย 90 นาที", "ไทย", "นวดไทย", "90 นาที", 0.95)], therapistName: field("อันนา", "Anna", 1, false, "verified-memory"), roomNo: field("3", "3", 0.95) },
  evidence: { staffCropRaw: "..." }, timings: { inferenceMs: 1200 } };
const reviewResponse = { documentId: `local-${randomUUID()}`, engine: "typhoon-sections", version: "3.0", schemaVersion: 3,
  customerInformation: { name: field("Chun Li", "Chun Li", 0.88), gender: field("Female", "Female", 0.96, false, "checkbox"), healthConditions: [{ ...field("Menstruation", "Menstruation", 0.9, false, "checkbox"), checked: true }] },
  recommendationCard: { pressure: field("Standard", "Standard", 0.91, false, "checkbox") },
  staffOnly: { treatments: [treatment("ไทย 90 นาที", "ไทย", "นวดไทย", "90 นาที", 0.95), treatment("ฟุต 60 นาที", "ฟุต", null, "60 นาที", 0.41, true)],
    therapistName: field("พิพิ", null, 0.5, true, "master-fuzzy"), roomNo: field("12", "12", 0.95) },
  evidence: { staffCropRaw: "..." } };
const legacyFlat = { treatment: { raw: "ไทย 60 นาที", durations: ["60 นาที"], items: [{ raw: "ไทย", value: "นวดไทย", duration: "60 นาที", confidence: 0.95, source: "rule", needsReview: false }], needsReview: false },
  therapistName: field("Legacyname", "Legacyname", 1, false, "verified-memory"), roomNo: field("7", null, 0, true) };

function roleUrl(role: Role, password: string, database: string): string {
  const url = new URL(bootstrapUrl!);
  url.username = role; url.password = password; url.pathname = `/${database}`;
  return url.toString();
}

describe("batch processing against PostgreSQL as the runtime roles", { skip: bootstrapUrl ? false : "set OCR_TEST_DATABASE_URL_BOOTSTRAP to a disposable superuser DSN" }, () => {
  const database = `ocr_it_${randomBytes(6).toString("hex")}`;
  const passwords = Object.fromEntries(ROLES.map((role) => [role, randomBytes(24).toString("hex")])) as Record<Role, string>;
  let admin: Pool, superDb: Pool, appPool: Pool, workerPool: Pool, queueRolePool: Pool;
  let app: PostgresOcrDocumentStore, worker: PostgresOcrDocumentStore, appQueue: Queue, queue: Queue, outbox: Outbox;
  let databaseCreated = false;
  let applied: string[] = [];
  let batchA = "", batchB = "";
  const docs: Record<string, { documentId: string; runId: string }> = {};

  async function upload(store: PostgresOcrDocumentStore, tenantId: string, filename: string, extra: { batchId?: string; idempotencyKey?: string; requestFingerprint?: string } = {}) {
    return store.createUploadedDocument({ tenantId, filename, mimeType: "image/png", sizeBytes: 10, contentHash: "0".repeat(64), storageKey: `org/${tenantId}/original/ab/${randomBytes(16).toString("hex")}`, ...extra });
  }
  async function asApp<T>(tenantId: string | null, sql: string, values: unknown[] = []): Promise<T[]> {
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      if (tenantId) await client.query("SELECT set_config('app.current_org', $1, true)", [tenantId]);
      const result = await client.query(sql, values);
      await client.query("COMMIT");
      return result.rows as T[];
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async function saveResult(tenantId: string, documentId: string, response: Record<string, unknown> & { documentId: string }, structured?: Record<string, unknown>) {
    const structuredResult = structured ?? toStructuredResult(response);
    await worker.saveOcrResult(tenantId, documentId, { ocrDocumentId: response.documentId, engine: "typhoon-sections", version: "3.0", rawResponse: response, structuredResult, needsReview: hasReviewFields(structuredResult) });
  }
  async function jobStatus(jobId: string): Promise<{ status: string; attempts: number }> {
    return (await superDb.query<{ status: string; attempts: number }>("SELECT status::text AS status, attempts FROM extraction_jobs WHERE id=$1", [jobId])).rows[0]!;
  }

  before(async () => {
    admin = new Pool({ connectionString: bootstrapUrl, max: 1 });
    const foreign = await admin.query<{ datname: string }>(
      "SELECT d.datname FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba WHERE r.rolname = ANY($1::text[]) AND d.datname NOT LIKE 'ocr\\_it\\_%'", [ROLES]);
    if (foreign.rows.length > 0) throw new Error(`refusing to reset OCR role passwords: server hosts ${foreign.rows.map((row) => row.datname).join(", ")}; use a disposable server`);
    // deploy/provision-roles.sh: LOGIN roles, NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT, random passwords.
    for (const role of ROLES) {
      await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} LOGIN; END IF; END $$`);
      const statement = await admin.query<{ sql: string }>("SELECT format('ALTER ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT', $1::text, $2::text) AS sql", [role, passwords[role]]);
      await admin.query(statement.rows[0]!.sql);
    }
    await admin.query(`CREATE DATABASE ${database} OWNER ocr_migrator`);
    databaseCreated = true;
    const superUrl = new URL(bootstrapUrl!);
    superUrl.pathname = `/${database}`;
    superDb = new Pool({ connectionString: superUrl.toString(), max: 2 });
    await superDb.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    // Fresh database: migration 0002 needs CREATEROLE once (see provision-roles.sh), revoked right after.
    await admin.query("ALTER ROLE ocr_migrator CREATEROLE");
    const migrator = new Pool({ connectionString: roleUrl("ocr_migrator", passwords.ocr_migrator, database), max: 1 });
    try {
      const runtime = await import(new URL("packages/db-runtime/src/index.ts", repo).href) as { runMigrationsWithPool(pool: Pool, directory: string): Promise<string[]> };
      applied = await runtime.runMigrationsWithPool(migrator, fileURLToPath(new URL("prisma/migrations", repo)));
    } finally { await migrator.end(); await admin.query("ALTER ROLE ocr_migrator NOCREATEROLE"); }
    await superDb.query(readFileSync(new URL("deploy/sql/queue-definer.sql", repo), "utf8"));
    await superDb.query("INSERT INTO organizations(id, name) VALUES ($1, 'Tenant A'), ($2, 'Tenant B')", [TENANT_A, TENANT_B]);
    appPool = new Pool({ connectionString: roleUrl("ocr_app", passwords.ocr_app, database), max: 10 });
    workerPool = new Pool({ connectionString: roleUrl("ocr_worker", passwords.ocr_worker, database), max: 4 });
    queueRolePool = new Pool({ connectionString: roleUrl("ocr_queue", passwords.ocr_queue, database), max: 2 });
    app = new PostgresOcrDocumentStore(appPool);
    worker = new PostgresOcrDocumentStore(workerPool);
    const queueModule = await import(new URL("packages/queue/src/postgres.ts", repo).href) as { PostgresQueue: new (config: string, workerConfig?: string) => Queue };
    const outboxModule = await import(new URL("packages/queue/src/outbox.ts", repo).href) as { PostgresConfirmOutbox: new (db: Pool, workerId?: string) => Outbox };
    appQueue = new queueModule.PostgresQueue(roleUrl("ocr_app", passwords.ocr_app, database));
    queue = new queueModule.PostgresQueue(roleUrl("ocr_queue", passwords.ocr_queue, database), roleUrl("ocr_worker", passwords.ocr_worker, database));
    outbox = new outboxModule.PostgresConfirmOutbox(workerPool, "it-worker");
  });

  after(async () => {
    await Promise.allSettled([appQueue?.close(), queue?.close(), appPool?.end(), workerPool?.end(), queueRolePool?.end(), superDb?.end()]);
    if (databaseCreated) {
      // pg-pool's end() resolves before client sockets close; FORCE-terminating them would surface as uncaught client errors.
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const open = await admin.query<{ count: number }>("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = $1", [database]);
        if (open.rows[0]?.count === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    }
    await admin?.end();
  });

  test("all migrations apply as ocr_migrator; grants, forced RLS and definer ownership match production", async () => {
    assert.ok(applied.includes("0017_batch_processing"), applied.join(","));
    const table = await superDb.query("SELECT relrowsecurity, relforcerowsecurity, pg_get_userbyid(relowner) AS owner FROM pg_class WHERE relname = 'ocr_batches'");
    assert.deepEqual(table.rows[0], { relrowsecurity: true, relforcerowsecurity: true, owner: "ocr_migrator" });
    const privileges = await superDb.query<{ role: string; privilege: string; granted: boolean }>(
      `SELECT r AS role, p AS privilege, has_table_privilege(r, 'ocr_batches', p) AS granted
       FROM unnest(ARRAY['ocr_app','ocr_worker','ocr_queue']) r CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p ORDER BY r, p`);
    const granted = privileges.rows.filter((row) => row.granted).map((row) => `${row.role}:${row.privilege}`);
    assert.deepEqual(granted, ["ocr_app:INSERT", "ocr_app:SELECT"]);
    const owners = await superDb.query<{ proname: string; owner: string }>(
      "SELECT proname, pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE proname IN ('ocr_claim_v1','ocr_heartbeat_v1','ocr_finish_retry_v1','ocr_recover_expired_v1','ocr_claim_confirm_outbox_v1','ocr_finish_confirm_outbox_v1','ocr_recover_confirm_outbox_v1') ORDER BY proname");
    assert.equal(owners.rows.length, 7);
    for (const row of owners.rows) assert.equal(row.owner, "ocr_queue_definer", row.proname);
    const roles = await superDb.query<{ rolname: string; rolsuper: boolean; rolcreaterole: boolean; rolinherit: boolean; rolbypassrls: boolean }>(
      "SELECT rolname, rolsuper, rolcreaterole, rolinherit, rolbypassrls FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname", [ROLES]);
    assert.equal(roles.rows.length, 4);
    for (const role of roles.rows) assert.deepEqual([role.rolsuper, role.rolcreaterole, role.rolinherit, role.rolbypassrls], [false, false, false, false], role.rolname);
    await assert.rejects(queueRolePool.query("SELECT count(*) FROM extraction_jobs"), { code: "42501" });
    await assert.rejects(queueRolePool.query("SELECT count(*) FROM ocr_batches"), { code: "42501" });
    await assert.rejects(asApp(TENANT_A, "CREATE TABLE ocr_probe(id int)"), { code: "42501" });
  });

  test("batches: create/get/list with derived counters, scoped to the tenant", async () => {
    const created = await app.createBatch(TENANT_A, { createdBy: "user-a", expectedTotal: 3, label: " Morning intake " });
    batchA = created.batchId;
    const { batchId: _id, createdAt: _created, ...counters } = created;
    assert.deepEqual(counters, { label: "Morning intake", expectedTotal: 3, uploaded: 0, rows: 0, pages: 0, pagesExpected: 0, splitting: 0, rowsExpected: 3, queued: 0, processing: 0,
      succeeded: 0, needsReview: 0, failed: 0, confirmed: 0, completed: 0, finished: false, finishedAt: null, durationMs: null, throughputPerMinute: null });
    assert.ok(Date.parse(created.createdAt) > 0);
    batchB = (await app.createBatch(TENANT_B, { createdBy: "user-b", expectedTotal: 1 })).batchId;
    assert.deepEqual(await app.getBatch(TENANT_A, batchA), created);
    assert.deepEqual((await app.listBatches(TENANT_A)).map((batch) => batch.batchId), [batchA]);
    assert.deepEqual((await app.listBatches(TENANT_B)).map((batch) => batch.batchId), [batchB]);
    assert.equal(await app.getBatch(TENANT_B, batchA), null);
    assert.equal(await app.getBatch(TENANT_A, randomUUID()), null);
    assert.deepEqual(await asApp(null, "SELECT id FROM ocr_batches"), []);
  });

  test("uploads into a batch: BATCH_FULL at expected_total, BATCH_NOT_FOUND across tenants, idempotent retry of a full batch", async () => {
    docs.d1 = await upload(app, TENANT_A, "scan_100%.png", { batchId: batchA, idempotencyKey: "key-1", requestFingerprint: "fp-1" });
    docs.d2 = await upload(app, TENANT_A, "chun.png", { batchId: batchA });
    docs.d3 = await upload(app, TENANT_A, "broken.png", { batchId: batchA });
    assert.equal((docs.d1 as { batchId?: string }).batchId, batchA);
    await assert.rejects(upload(app, TENANT_A, "fourth.png", { batchId: batchA }), { message: "BATCH_FULL" });
    const again = await upload(app, TENANT_A, "scan_100%.png", { batchId: batchA, idempotencyKey: "key-1", requestFingerprint: "fp-1" });
    assert.deepEqual({ documentId: again.documentId, reused: again.reused }, { documentId: docs.d1.documentId, reused: true });
    await assert.rejects(upload(app, TENANT_A, "x.png", { batchId: batchA, idempotencyKey: "key-1", requestFingerprint: "other" }), { message: "IDEMPOTENCY_CONFLICT" });
    await assert.rejects(upload(app, TENANT_A, "x.png", { batchId: randomUUID() }), { message: "BATCH_NOT_FOUND" });
    await assert.rejects(upload(app, TENANT_B, "x.png", { batchId: batchA }), { message: "BATCH_NOT_FOUND" });
    await assert.rejects(upload(app, TENANT_A, "x.png", { batchId: batchB }), { message: "BATCH_NOT_FOUND" });
    const summary = await app.getBatch(TENANT_A, batchA);
    assert.deepEqual([summary?.uploaded, summary?.queued, summary?.completed, summary?.finishedAt], [3, 3, 0, null]);
    assert.equal(typeof summary?.durationMs, "number");
    const burst = await app.createBatch(TENANT_A, { createdBy: "user-a", expectedTotal: 5 });
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => upload(app, TENANT_A, `burst-${index}.png`, { batchId: burst.batchId })));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 5);
    assert.deepEqual(results.filter((result) => result.status === "rejected").map((result) => (result as PromiseRejectedResult).reason.message), ["BATCH_FULL", "BATCH_FULL", "BATCH_FULL"]);
    assert.equal((await app.getBatch(TENANT_A, burst.batchId))?.uploaded, 5);
  });

  test("pipeline with a partial failure: retries go PENDING then DEAD, siblings are unaffected", async () => {
    const jobs = new Map<string, string>();
    for (const [name, doc] of Object.entries(docs)) {
      await app.updateScanStatus(TENANT_A, doc.documentId, "CLEAN");
      jobs.set(doc.runId, name);
      await appQueue.enqueue({ organizationId: TENANT_A, runId: doc.runId });
    }
    const claimed = new Map<string, Claimed>();
    for (let index = 0; index < 3; index += 1) {
      const job = await queue.claim();
      assert.ok(job, "job claimable by ocr_queue");
      claimed.set(jobs.get(job.runId)!, job);
    }
    assert.equal(await queue.claim(), null);
    for (const [name, job] of claimed) {
      const document = await worker.getWorkerDocument(job.runId, job.organizationId);
      assert.equal(document?.documentId, docs[name]!.documentId);
      await worker.markProcessing(TENANT_A, docs[name]!.documentId);
      assert.equal(await queue.heartbeat(job.jobId, job.leaseToken), true);
      assert.equal(await queue.heartbeat(job.jobId, "not-the-token"), false);
    }
    assert.equal((await app.getBatch(TENANT_A, batchA))?.processing, 3);
    await saveResult(TENANT_A, docs.d1!.documentId, cleanResponse);
    assert.deepEqual(await queue.finishDetailed(claimed.get("d1")!.jobId, claimed.get("d1")!.leaseToken, "SUCCEEDED"), { accepted: true, finalStatus: "SUCCEEDED" });
    await saveResult(TENANT_A, docs.d2!.documentId, reviewResponse);
    assert.deepEqual(await queue.finishDetailed(claimed.get("d2")!.jobId, claimed.get("d2")!.leaseToken, "SUCCEEDED"), { accepted: true, finalStatus: "SUCCEEDED" });
    let job3 = claimed.get("d3")!;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const finished = await queue.finishDetailed(job3.jobId, job3.leaseToken, "FAILED", `HTTP 503 attempt ${attempt}`);
      assert.deepEqual(finished, { accepted: true, finalStatus: attempt < 3 ? "PENDING" : "DEAD" });
      if (finished.finalStatus === "PENDING") {
        await worker.markRetrying(TENANT_A, docs.d3!.documentId, "HTTP 503");
        const review = await app.getReviewDocument(TENANT_A, docs.d3!.documentId);
        assert.deepEqual([review?.status, review?.errorMessage], ["CLEAN", "RETRYING: HTTP 503"]);
        assert.equal((await app.getBatch(TENANT_A, batchA))?.queued, 1);
        const next = await queue.claim(new Date(Date.now() + 30_000));
        assert.equal(next?.jobId, job3.jobId);
        job3 = next!;
        await worker.markProcessing(TENANT_A, docs.d3!.documentId);
      } else await worker.markFailure(TENANT_A, docs.d3!.documentId, "HTTP 503");
    }
    assert.deepEqual(await jobStatus(job3.jobId), { status: "DEAD", attempts: 3 });
    assert.deepEqual(await queue.finishDetailed(job3.jobId, job3.leaseToken, "SUCCEEDED"), { accepted: false, finalStatus: null });
    const statuses = await Promise.all(["d1", "d2", "d3"].map(async (name) => (await app.getReviewDocument(TENANT_A, docs[name]!.documentId))?.status));
    assert.deepEqual(statuses, ["SUCCEEDED", "NEEDS_REVIEW", "FAILED"]);
    const summary = (await app.getBatch(TENANT_A, batchA))!;
    assert.deepEqual([summary.uploaded, summary.queued, summary.processing, summary.succeeded, summary.needsReview, summary.failed, summary.confirmed, summary.completed], [3, 0, 0, 1, 1, 1, 0, 3]);
    assert.ok(summary.finishedAt && Date.parse(summary.finishedAt) >= Date.parse(summary.createdAt));
    assert.ok(summary.durationMs !== null && summary.durationMs >= 0);
    assert.equal(summary.durationMs, Date.parse(summary.finishedAt) - Date.parse(summary.createdAt));
  });

  test("listDocuments: server-side filters, escaped search, summaries and tenant scope", async () => {
    const all = await app.listDocuments(TENANT_A, { batchId: batchA });
    assert.equal(all.total, 3);
    assert.deepEqual(all.documents.map((item) => item.statusCategory).sort(), ["failed", "review", "succeeded"]);
    const review = await app.listDocuments(TENANT_A, { status: "review" });
    assert.deepEqual(review.documents.map((item) => item.documentId), [docs.d2!.documentId]);
    assert.deepEqual(review.documents[0]!.summary, { customerName: "Chun Li", gender: "Female", nationality: null,
      treatments: [{ name: "นวดไทย", duration: "90 นาที" }, { name: null, duration: "60 นาที" }], therapist: null, room: "12", formNumber: null, branch: null, minConfidence: 0.41, reviewFieldCount: 2 });
    assert.deepEqual([review.documents[0]!.batchId, review.documents[0]!.needsReview, review.documents[0]!.deliveryStatus, review.documents[0]!.mimeType], [batchA, true, "NONE", "image/png"]);
    assert.deepEqual((await app.listDocuments(TENANT_A, { q: "chun LI" })).documents.map((item) => item.documentId), [docs.d2!.documentId]);
    assert.deepEqual((await app.listDocuments(TENANT_A, { q: "anna" })).documents.map((item) => item.documentId), [docs.d1!.documentId]);
    assert.deepEqual((await app.listDocuments(TENANT_A, { q: "100%" })).documents.map((item) => item.documentId), [docs.d1!.documentId]);
    assert.equal((await app.listDocuments(TENANT_A, { q: "chu_" })).total, 0, "_ is not a wildcard");
    assert.equal((await app.listDocuments(TENANT_A, { q: "%" })).total, 1);
    assert.equal((await app.listDocuments(TENANT_A, { status: "failed", batchId: batchA })).documents[0]?.errorMessage, "HTTP 503");
    const page = await app.listDocuments(TENANT_A, { limit: 2, offset: 0 });
    assert.equal(page.documents.length, 2);
    assert.equal(page.total, 8);
    assert.equal((await app.listDocuments(TENANT_A, { limit: 1000, offset: -5 })).documents.length, 8);
    assert.equal((await app.listDocuments(TENANT_A, { batchId: randomUUID() })).total, 0);
    assert.deepEqual(await app.listDocuments(TENANT_B, { batchId: batchA }), { total: 0, documents: [] });
    assert.equal((await app.listDocuments(TENANT_B)).total, 0);
  });

  test("tenant isolation: tenant B can neither see nor change tenant A's batch or documents", async () => {
    assert.equal(await app.getReviewDocument(TENANT_B, docs.d2!.documentId), null);
    assert.equal(await app.getOriginal(TENANT_B, docs.d1!.documentId), null);
    await assert.rejects(app.retryDocument(TENANT_B, docs.d3!.documentId), { message: "DOCUMENT_NOT_FOUND" });
    await assert.rejects(app.saveReview(TENANT_B, docs.d2!.documentId, { structuredResult: {}, reviewedBy: "user-b" }), { message: "DOCUMENT_NOT_FOUND" });
    assert.deepEqual(await asApp(TENANT_B, "SELECT id FROM ocr_batches WHERE id = $1", [batchA]), []);
    await assert.rejects(asApp(TENANT_B, "INSERT INTO ocr_batches(organization_id, created_by, expected_total) VALUES ($1, 'x', 1)", [TENANT_A]), /row-level security/);
    await assert.rejects(asApp(TENANT_B, "UPDATE ocr_batches SET label = 'x' WHERE id = $1", [batchB]), { code: "42501" });
    await assert.rejects(asApp(TENANT_B, "DELETE FROM ocr_batches WHERE id = $1", [batchB]), { code: "42501" });
    await assert.rejects(asApp(TENANT_B, `INSERT INTO documents(id, organization_id, public_id, status, filename, mime_type, size_bytes, content_hash, batch_id)
      VALUES (gen_random_uuid(), $1, 'p', 'SCANNING', 'x.png', 'image/png', 1, 'h', $2)`, [TENANT_B, batchA]), { code: "23503" });
    const unchanged = await app.getReviewDocument(TENANT_A, docs.d2!.documentId);
    assert.deepEqual([unchanged?.status, unchanged?.reviewedAt], ["NEEDS_REVIEW", null]);
  });

  test("retryDocument re-queues FAILED documents only, on the same run, and ocr_queue can claim the new job", async () => {
    await assert.rejects(app.retryDocument(TENANT_A, docs.d1!.documentId), { message: "DOCUMENT_NOT_RETRYABLE" });
    await assert.rejects(app.retryDocument(TENANT_A, randomUUID()), { message: "DOCUMENT_NOT_FOUND" });
    const scanFailed = await upload(app, TENANT_A, "clamav-down.png");
    await app.updateScanStatus(TENANT_A, scanFailed.documentId, "FAILED", "SCAN_FAILED");
    await assert.rejects(app.retryDocument(TENANT_A, scanFailed.documentId), { message: "DOCUMENT_NOT_RETRYABLE" });
    const { jobId } = await app.retryDocument(TENANT_A, docs.d3!.documentId);
    await assert.rejects(app.retryDocument(TENANT_A, docs.d3!.documentId), { message: "DOCUMENT_NOT_RETRYABLE" });
    const review = await app.getReviewDocument(TENANT_A, docs.d3!.documentId);
    assert.deepEqual([review?.status, review?.errorMessage], ["CLEAN", null]);
    const runs = await superDb.query<{ outcome: string; count: number }>("SELECT outcome::text AS outcome, count(*)::int AS count FROM document_runs WHERE document_id = $1 GROUP BY outcome", [docs.d3!.documentId]);
    assert.deepEqual(runs.rows, [{ outcome: "RUNNING", count: 1 }]);
    const claimed = await queue.claim();
    assert.deepEqual([claimed?.jobId, claimed?.runId, claimed?.organizationId], [jobId, docs.d3!.runId, TENANT_A]);
    await worker.markProcessing(TENANT_A, docs.d3!.documentId);
    await saveResult(TENANT_A, docs.d3!.documentId, { ...cleanResponse, documentId: `local-${randomUUID()}` });
    assert.deepEqual(await queue.finishDetailed(claimed!.jobId, claimed!.leaseToken, "SUCCEEDED"), { accepted: true, finalStatus: "SUCCEEDED" });
    const summary = await app.getBatch(TENANT_A, batchA);
    assert.deepEqual([summary?.succeeded, summary?.needsReview, summary?.failed, summary?.completed], [2, 1, 0, 3]);
  });

  test("saveReview writes the edited view, corrections and outbox rows; conflicts and invalid states are rejected", async () => {
    const id = docs.d2!.documentId;
    const before = (await app.getReviewDocument(TENANT_A, id))!;
    assert.deepEqual([before.batchId, before.reviewedAt, before.reviewedBy, before.errorMessage, before.deliveryStatus, before.structuredResult.schemaVersion], [batchA, null, null, null, "NONE", 3]);
    assert.ok(before.processedAt && before.createdAt && before.updatedAt);
    assert.equal("evidence" in before.structuredResult, false);
    const edited = structuredClone(before.structuredResult) as DocumentView;
    (edited.customerInformation.name as Record<string, unknown>).value = "Chun-Li";
    ((edited.staffOnly.treatments as Array<Record<string, unknown>>)[1]!).value = "นวดเท้า";
    (edited.staffOnly.therapistName as Record<string, unknown>).value = "พิมพ์";
    await assert.rejects(app.saveReview(TENANT_A, id, { structuredResult: edited, reviewedBy: "user-a", expectedUpdatedAt: new Date(Date.parse(before.updatedAt) - 1000).toISOString() }), { message: "REVIEW_CONFLICT" });
    await assert.rejects(app.saveReview(TENANT_A, id, { structuredResult: { customerInformation: { name: { value: "x".repeat(501) } } }, reviewedBy: "user-a" }), { message: "REVIEW_INVALID" });
    const queued = await upload(app, TENANT_A, "queued.png");
    await assert.rejects(app.saveReview(TENANT_A, queued.documentId, { structuredResult: {}, reviewedBy: "user-a" }), { message: "DOCUMENT_NOT_REVIEWABLE" });
    const saved = await app.saveReview(TENANT_A, id, { structuredResult: edited, reviewedBy: "user-a", expectedUpdatedAt: before.updatedAt });
    assert.deepEqual([saved.corrections, saved.delivery, saved.document.status, saved.document.needsReview, saved.document.reviewedBy, saved.document.deliveryStatus, saved.document.confirmStatus],
      [3, "PENDING", "SUCCEEDED", false, "user-a", "PENDING", "PENDING"]);
    assert.ok(saved.document.reviewedAt);
    assert.equal(hasReviewFields(saved.document.structuredResult), false);
    assert.deepEqual(saved.document.structuredResult.staffOnly.therapistName, { raw: "พิพิ", value: "พิมพ์", confidence: 0.5, source: "human", needsReview: false });
    const corrections = await superDb.query("SELECT field, old_raw, normalized_value, verified_value, verified_by, confirm_status FROM ocr_corrections WHERE document_id = $1 ORDER BY field", [id]);
    assert.deepEqual(corrections.rows, [
      { field: "customerInformation.name", old_raw: "Chun Li", normalized_value: "Chun Li", verified_value: "Chun-Li", verified_by: "user-a", confirm_status: "NOT_REQUIRED" },
      { field: "staffOnly.therapistName", old_raw: "พิพิ", normalized_value: null, verified_value: "พิมพ์", verified_by: "user-a", confirm_status: "PENDING" },
      { field: "staffOnly.treatments[1]", old_raw: "ฟุต 60 นาที", normalized_value: null, verified_value: "นวดเท้า", verified_by: "user-a", confirm_status: "PENDING" }
    ]);
    const outboxRows = await superDb.query("SELECT o.organization_id, o.payload, o.status FROM ocr_confirm_outbox o JOIN ocr_corrections c ON c.id = o.correction_id WHERE c.document_id = $1 ORDER BY o.payload->>'field'", [id]);
    assert.deepEqual(outboxRows.rows, [
      { organization_id: TENANT_A, status: "PENDING", payload: { documentId: reviewResponse.documentId, field: "therapist", raw: "พิพิ", verifiedValue: "พิมพ์" } },
      { organization_id: TENANT_A, status: "PENDING", payload: { documentId: reviewResponse.documentId, field: "treatment", raw: "ฟุต", verifiedValue: "นวดเท้า" } }
    ]);
    const summary = await app.getBatch(TENANT_A, batchA);
    assert.deepEqual([summary?.succeeded, summary?.needsReview, summary?.confirmed], [3, 0, 1]);
    assert.equal((await app.listDocuments(TENANT_A, { status: "confirmed" })).documents[0]?.documentId, id);
    await assert.rejects(app.saveReview(TENANT_A, id, { structuredResult: edited, reviewedBy: "user-a", expectedUpdatedAt: before.updatedAt }), { message: "REVIEW_CONFLICT" });
    const resaved = await app.saveReview(TENANT_A, id, { structuredResult: saved.document.structuredResult, reviewedBy: "user-a", expectedUpdatedAt: saved.document.updatedAt });
    assert.deepEqual([resaved.corrections, resaved.delivery, resaved.document.confirmStatus, resaved.document.deliveryStatus], [0, "NOT_REQUIRED", null, "PENDING"]);
  });

  test("confirm outbox: ocr_worker claims across tenants via the definer function and delivery status follows", async () => {
    const id = docs.d2!.documentId;
    const sent: Array<Readonly<Record<string, unknown>>> = [];
    for (;;) {
      const result = await outbox.dispatchOnce(async (payload) => { sent.push(payload); });
      if (!result.claimed) break;
      assert.equal(result.delivered, true);
    }
    assert.deepEqual(sent.map((payload) => payload.field).sort(), ["therapist", "treatment"]);
    assert.equal((await app.getReviewDocument(TENANT_A, id))?.deliveryStatus, "DELIVERED");
    const current = (await app.getReviewDocument(TENANT_A, id))!;
    const edited = structuredClone(current.structuredResult);
    (edited.staffOnly.therapistName as Record<string, unknown>).value = "พิมพ์ใจ";
    await app.saveReview(TENANT_A, id, { structuredResult: edited, reviewedBy: "user-a" });
    const failed = await outbox.dispatchOnce(async () => { throw new Error("HTTP 502"); });
    assert.deepEqual(failed, { claimed: true, delivered: false });
    assert.equal((await app.getReviewDocument(TENANT_A, id))?.deliveryStatus, "RETRYING");
    assert.equal((await app.listDocuments(TENANT_A, { status: "confirmed", q: "chun" })).documents[0]?.deliveryStatus, "RETRYING");
    assert.equal(typeof await outbox.recoverExpired(), "number");
    await assert.rejects(workerPool.query("SELECT count(*) FROM ocr_confirm_outbox"), { code: "42501" });
  });

  test("legacy single-field confirm is path-aware for sectioned and flat rows", async () => {
    const canonical = docs.d1!.documentId;
    await app.saveCorrection(TENANT_A, canonical, "therapistName", "Anne", "PENDING", undefined, undefined, { raw: "อันนา", verifiedBy: "user-a" });
    await app.saveCorrection(TENANT_A, canonical, "therapistName", "Anne", "SUCCEEDED", undefined, false);
    const stored = (await superDb.query<{ structured_result: Record<string, Record<string, unknown>> }>("SELECT structured_result FROM documents WHERE id = $1", [canonical])).rows[0]!.structured_result;
    assert.equal("therapistName" in stored, false);
    assert.deepEqual(stored.staffOnly!.therapistName, { raw: "อันนา", value: "Anne", confidence: 1, source: "verified-memory", needsReview: false });
    const audit = await superDb.query("SELECT old_raw, normalized_value, verified_value, confirm_status FROM ocr_corrections WHERE document_id = $1 AND field = 'therapistName'", [canonical]);
    assert.deepEqual(audit.rows, [{ old_raw: "อันนา", normalized_value: "Anna", verified_value: "Anne", confirm_status: "SUCCEEDED" }]);
    const legacy = await upload(app, TENANT_A, "legacy.png");
    await saveResult(TENANT_A, legacy.documentId, { documentId: `local-${randomUUID()}` }, legacyFlat);
    await app.saveCorrection(TENANT_A, legacy.documentId, "roomNo", "7", "PENDING", undefined, undefined, { raw: "7", verifiedBy: "user-a" });
    await app.saveCorrection(TENANT_A, legacy.documentId, "roomNo", "7", "SUCCEEDED", undefined, false);
    const flat = (await superDb.query<{ structured_result: Record<string, unknown>; status: string }>("SELECT structured_result, status::text AS status FROM documents WHERE id = $1", [legacy.documentId])).rows[0]!;
    assert.equal(flat.status, "SUCCEEDED");
    assert.equal("staffOnly" in flat.structured_result, false);
    assert.deepEqual(flat.structured_result.roomNo, { raw: "7", value: "7", confidence: 0, source: "ocr", needsReview: false });
    const view = (await app.getReviewDocument(TENANT_A, legacy.documentId))!.structuredResult;
    assert.deepEqual(view.staffOnly.roomNo, flat.structured_result.roomNo);
    assert.equal((view.staffOnly.treatments as unknown[]).length, 1);
    assert.deepEqual((await app.listDocuments(TENANT_A, { q: "legacyname" })).documents.map((item) => item.documentId), [legacy.documentId]);
  });

  test("queue: expired leases are recovered by ocr_worker and fenced tokens are rejected", async () => {
    const doc = await upload(app, TENANT_B, "late.png", { batchId: batchB });
    await app.updateScanStatus(TENANT_B, doc.documentId, "CLEAN");
    const jobId = await appQueue.enqueue({ organizationId: TENANT_B, runId: doc.runId });
    const first = await queue.claim();
    assert.equal(first?.jobId, jobId);
    assert.equal(await queue.recoverExpired(), 0);
    const later = new Date(Date.now() + 200_000);
    assert.ok(await queue.recoverExpired(later) >= 1);
    assert.deepEqual(await jobStatus(jobId), { status: "PENDING", attempts: 1 });
    assert.equal(await queue.heartbeat(jobId, first!.leaseToken), false);
    assert.equal(await queue.claim(), null, "recovered jobs become available at the recovery time");
    const second = await queue.claim(later);
    assert.equal(second?.jobId, jobId);
    assert.deepEqual(await queue.finishDetailed(jobId, first!.leaseToken, "SUCCEEDED"), { accepted: false, finalStatus: null });
    assert.deepEqual(await queue.finishDetailed(jobId, second!.leaseToken, "DEAD", "unsupported"), { accepted: true, finalStatus: "DEAD" });
    assert.equal(await queue.claim(), null);
    assert.equal((await app.getBatch(TENANT_A, batchA))?.uploaded, 3, "tenant B activity never changes tenant A counters");
  });

  /** Production v2.2 (845a053) saveCorrection, verbatim: `jsonb_set(…, ARRAY[field,'value'], …)` and never clears needsReview. */
  async function v22Confirm(documentId: string, field: string, value: string, confirmStatus: "PENDING" | "SUCCEEDED", remainingNeedsReview: boolean | null) {
    await asApp(TENANT_A, `UPDATE documents
         SET structured_result = jsonb_set(COALESCE(structured_result, '{}'::jsonb), ARRAY[$1, 'value'], to_jsonb($2::text), true),
             needs_review = CASE WHEN $3 = 'SUCCEEDED' AND $7::boolean IS NOT NULL THEN $7::boolean WHEN $3 = 'SUCCEEDED' THEN false ELSE needs_review END,
             status = CASE WHEN $3 = 'SUCCEEDED' AND COALESCE($7::boolean, false) = false THEN 'SUCCEEDED'::document_status ELSE status END,
             confirm_status = $3, confirm_error = $4, confirmed_at = CASE WHEN $3 = 'SUCCEEDED' THEN now() ELSE confirmed_at END,
             updated_at = now()
         WHERE id = $5::uuid AND organization_id = $6::uuid AND deleted_at IS NULL`, [field, value, confirmStatus, null, documentId, TENANT_A, remainingNeedsReview]);
  }
  async function storedResult(documentId: string): Promise<Record<string, unknown>> {
    return (await superDb.query<{ structured_result: Record<string, unknown> }>("SELECT structured_result FROM documents WHERE id = $1", [documentId])).rows[0]!.structured_result;
  }
  async function processed(filename: string, response: Record<string, unknown> & { documentId: string }, structured?: Record<string, unknown>, batchId?: string) {
    const doc = await upload(app, TENANT_A, filename, batchId ? { batchId } : {});
    await app.updateScanStatus(TENANT_A, doc.documentId, "CLEAN");
    await worker.markProcessing(TENANT_A, doc.documentId);
    await saveResult(TENANT_A, doc.documentId, response, structured);
    return doc;
  }

  test("v2.2 confirmations: the confirmed treatment is shown and survives a review save; confirmed rows count as confirmed", async () => {
    const flat = { treatment: { raw: "ฟุต 60 นาที", durations: ["60 นาที"], items: [{ raw: "ฟุต", value: null, duration: "60 นาที", confidence: 0.41, source: "master-fuzzy", needsReview: true }], needsReview: true },
      therapistName: field("พิพิ", null, 0.5, true, "master-fuzzy"), roomNo: field("12", "12", 0.95) };
    const doc = await processed("v22-confirmed.png", { documentId: `local-${randomUUID()}` }, flat);
    await v22Confirm(doc.documentId, "treatment", "นวดเท้า", "PENDING", null);
    await v22Confirm(doc.documentId, "treatment", "นวดเท้า", "SUCCEEDED", true);
    await v22Confirm(doc.documentId, "therapistName", "พีพี", "PENDING", null);
    await v22Confirm(doc.documentId, "therapistName", "พีพี", "SUCCEEDED", false);
    const listed = (await app.listDocuments(TENANT_A, { q: "v22-confirmed" })).documents[0]!;
    assert.equal(listed.statusCategory, "confirmed");
    assert.ok(listed.reviewedAt);
    assert.deepEqual([listed.summary.treatments, listed.summary.therapist, listed.summary.reviewFieldCount], [[{ name: "นวดเท้า", duration: "60 นาที" }], "พีพี", 0]);
    assert.ok((await app.listDocuments(TENANT_A, { status: "confirmed" })).documents.some((item) => item.documentId === doc.documentId));
    assert.equal((await app.listDocuments(TENANT_A, { status: "succeeded" })).documents.some((item) => item.documentId === doc.documentId), false);
    const review = (await app.getReviewDocument(TENANT_A, doc.documentId))!;
    assert.equal(hasReviewFields(review.structuredResult), false);
    const edited = structuredClone(review.structuredResult);
    (edited.staffOnly.roomNo as Record<string, unknown>).value = "14";
    const saved = await app.saveReview(TENANT_A, doc.documentId, { structuredResult: edited, reviewedBy: "user-a", expectedUpdatedAt: review.updatedAt });
    assert.deepEqual([saved.corrections, saved.delivery], [1, "NOT_REQUIRED"], "fields confirmed in v2.2 are not re-sent to verified memory");
    const stored = await storedResult(doc.documentId);
    assert.deepEqual(((stored.staffOnly as Record<string, unknown>).treatments as Array<Record<string, unknown>>).map((item) => [item.value, item.source, item.needsReview]), [["นวดเท้า", "human", false]]);
    assert.equal((await superDb.query("SELECT 1 FROM ocr_confirm_outbox o JOIN ocr_corrections c ON c.id = o.correction_id WHERE c.document_id = $1", [doc.documentId])).rowCount, 0);
  });

  test("legacy confirm of a treatment on a v3 row writes that item only, keeps other flags, and refuses to guess", async () => {
    const response = { ...reviewResponse, documentId: `local-${randomUUID()}`, staffOnly: { ...reviewResponse.staffOnly, therapistName: field("พีพี", "พีพี", 1),
      treatments: [treatment("ไทย 90 นาที", "ไทย", "นวดไทย", "90 นาที", 0.95), treatment("ฟุต 60 นาที", "ฟุต", null, "60 นาที", 0.41, true), treatment("หน้า 30 นาที", "หน้า", null, "30 นาที", 0.5, true)] } };
    const doc = await processed("v3-legacy-confirm.png", response);
    const before = await storedResult(doc.documentId);
    await assert.rejects(app.saveCorrection(TENANT_A, doc.documentId, "treatment", "นวดเท้า", "PENDING", undefined, undefined, { raw: "ใทบ", verifiedBy: "user-a" }), { message: "CONFIRMATION_TARGET_AMBIGUOUS" });
    assert.deepEqual(await storedResult(doc.documentId), before);
    await app.saveCorrection(TENANT_A, doc.documentId, "treatment", "นวดเท้า", "PENDING", undefined, undefined, { raw: "ฟุต", verifiedBy: "user-a" });
    await app.saveCorrection(TENANT_A, doc.documentId, "treatment", "นวดเท้า", "SUCCEEDED", undefined, true);
    const stored = await storedResult(doc.documentId);
    assert.equal("treatment" in stored, false, "no orphan top-level key");
    const items = (stored.staffOnly as Record<string, unknown>).treatments as Array<Record<string, unknown>>;
    assert.deepEqual(items.map((item) => [item.value, item.needsReview]), [["นวดไทย", false], ["นวดเท้า", false], [null, true]]);
    const review = (await app.getReviewDocument(TENANT_A, doc.documentId))!;
    assert.deepEqual([review.status, review.needsReview, review.confirmStatus], ["NEEDS_REVIEW", true, "SUCCEEDED"]);
    const outbox = await superDb.query("SELECT o.payload FROM ocr_confirm_outbox o JOIN ocr_corrections c ON c.id = o.correction_id WHERE c.document_id = $1", [doc.documentId]);
    assert.deepEqual(outbox.rows, [{ payload: { documentId: response.documentId, field: "treatment", raw: "ฟุต", verifiedValue: "นวดเท้า" } }]);
  });

  test("a whole v2.2 response 'confirmed' by v2.2 from one field stays unconfirmed with its flags until every field is resolved", async () => {
    const whole = { documentId: `local-${randomUUID()}`, version: "2.2",
      staffOnly: { treatment: { raw: "ฟุต 60 นาที", durations: ["60 นาที"], items: [{ raw: "ฟุต", value: null, duration: "60 นาที", confidence: 0.41, source: "master-fuzzy", needsReview: true }], needsReview: true },
        therapistName: field("พิพิ", null, 0.5, true, "master-fuzzy"), roomNo: field("12", "12", 0.95) } };
    const doc = await processed("whole-v22-confirm.png", { documentId: whole.documentId }, whole);
    // v2.2 only looked at top-level keys (none flagged) and wrote a top-level therapistName that the row does not have.
    await v22Confirm(doc.documentId, "therapistName", "พีพี", "PENDING", null);
    await v22Confirm(doc.documentId, "therapistName", "พีพี", "SUCCEEDED", false);
    const listed = async () => (await app.listDocuments(TENANT_A, { q: "whole-v22-confirm" })).documents[0]!;
    let item = await listed();
    assert.deepEqual([item.status, item.statusCategory, item.reviewedAt, item.summary.reviewFieldCount], ["SUCCEEDED", "succeeded", null, 2]);
    assert.equal(hasReviewFields((await app.getReviewDocument(TENANT_A, doc.documentId))!.structuredResult), true, "unresolved fields stay flagged");
    // After deploy the path-aware endpoint resolves each field where it is stored; with none left the row is confirmed.
    await app.saveCorrection(TENANT_A, doc.documentId, "therapistName", "พีพี", "PENDING", undefined, undefined, { raw: "พิพิ", verifiedBy: "user-a" });
    await app.saveCorrection(TENANT_A, doc.documentId, "therapistName", "พีพี", "SUCCEEDED", undefined, true);
    assert.equal((await listed()).statusCategory, "succeeded");
    await app.saveCorrection(TENANT_A, doc.documentId, "treatment", "นวดเท้า", "PENDING", undefined, undefined, { raw: "ฟุต", verifiedBy: "user-a" });
    await app.saveCorrection(TENANT_A, doc.documentId, "treatment", "นวดเท้า", "SUCCEEDED", undefined, false);
    item = await listed();
    assert.deepEqual([item.statusCategory, item.summary.reviewFieldCount, item.summary.therapist, item.summary.treatments], ["confirmed", 0, "พีพี", [{ name: "นวดเท้า", duration: "60 นาที" }]]);
  });

  test("legacy confirm of one v2.2 treatment item keeps its correctly read siblings (flat and whole v2.2 rows)", async () => {
    const treatmentObject = { raw: "ไทย 60 นาที ฟุต 30 นาที", durations: ["60 นาที", "30 นาที"], needsReview: true, items: [
      { raw: "ไทย", value: "นวดไทย", duration: "60 นาที", confidence: 0.95, source: "rule", needsReview: false },
      { raw: "ฟุต", value: null, duration: "30 นาที", confidence: 0.4, source: "none", needsReview: true }] };
    const staff = { therapistName: field("พีพี", "พีพี", 1), roomNo: field("3", "3", 0.95) };
    for (const [filename, structured] of [["v22-items-flat.png", { treatment: treatmentObject, ...staff }], ["v22-items-whole.png", { documentId: "x", staffOnly: { treatment: treatmentObject, ...staff } }]] as const) {
      const doc = await processed(filename, { documentId: `local-${randomUUID()}` }, structured);
      await app.saveCorrection(TENANT_A, doc.documentId, "treatment", "นวดเท้า", "PENDING", undefined, undefined, { raw: "ฟุต", verifiedBy: "user-a" });
      await app.saveCorrection(TENANT_A, doc.documentId, "treatment", "นวดเท้า", "SUCCEEDED", undefined, false);
      const review = (await app.getReviewDocument(TENANT_A, doc.documentId))!;
      assert.deepEqual((review.structuredResult.staffOnly.treatments as Array<Record<string, unknown>>).map((entry) => [entry.raw, entry.value, entry.duration, entry.needsReview]),
        [["ไทย", "นวดไทย", "60 นาที", false], ["ฟุต", "นวดเท้า", "30 นาที", false]], filename);
      assert.deepEqual([review.status, (await app.listDocuments(TENANT_A, { q: filename })).documents[0]?.statusCategory], ["SUCCEEDED", "confirmed"], filename);
      const audit = await superDb.query("SELECT old_raw, verified_value FROM ocr_corrections WHERE document_id = $1", [doc.documentId]);
      assert.deepEqual(audit.rows, [{ old_raw: "ฟุต", verified_value: "นวดเท้า" }], filename);
    }
  });

  test("a later legacy confirmation that is pending or ends in RETRY never un-confirms a confirmed row", async () => {
    const flat = { treatment: { raw: "ไทย 60 นาที", durations: ["60 นาที"], items: [{ raw: "ไทย", value: "นวดไทย", duration: "60 นาที", confidence: 0.95, source: "rule", needsReview: false }], needsReview: false },
      therapistName: field("พิพิ", null, 0.5, true, "master-fuzzy"), roomNo: field("12", "12", 0.95) };
    const batch = await app.createBatch(TENANT_A, { createdBy: "user-a", expectedTotal: 1 });
    const doc = await processed("sticky-confirm.png", { documentId: `local-${randomUUID()}` }, flat, batch.batchId);
    await v22Confirm(doc.documentId, "therapistName", "พีพี", "PENDING", null);
    await v22Confirm(doc.documentId, "therapistName", "พีพี", "SUCCEEDED", false);
    const state = async () => {
      const item = (await app.listDocuments(TENANT_A, { q: "sticky-confirm" })).documents[0]!;
      return [item.statusCategory, item.summary.reviewFieldCount, (await app.getBatch(TENANT_A, batch.batchId))!.confirmed];
    };
    assert.deepEqual(await state(), ["confirmed", 0, 1]);
    await app.saveCorrection(TENANT_A, doc.documentId, "roomNo", "12", "PENDING", undefined, undefined, { raw: "12", verifiedBy: "user-a" });
    assert.deepEqual(await state(), ["confirmed", 0, 1], "while the provider call is in flight");
    await app.saveCorrection(TENANT_A, doc.documentId, "roomNo", "12", "RETRY", "OCR API returned HTTP 400");
    assert.deepEqual(await state(), ["confirmed", 0, 1], "after RETRY");
    const review = (await app.getReviewDocument(TENANT_A, doc.documentId))!;
    const saved = await app.saveReview(TENANT_A, doc.documentId, { structuredResult: review.structuredResult, reviewedBy: "user-a", expectedUpdatedAt: review.updatedAt });
    assert.deepEqual([saved.corrections, saved.delivery], [0, "NOT_REQUIRED"], "the therapist v2.2 already confirmed is not re-sent to verified memory");
  });

  test("delivery status is not hidden when one review deletes an item and edits the item that moves into its place", async () => {
    const response = { ...reviewResponse, documentId: `local-${randomUUID()}`, staffOnly: { ...reviewResponse.staffOnly, therapistName: field("พีพี", "พีพี", 1),
      treatments: [treatment("ไทย 90 นาที", "ไทย", null, "90 นาที", 0.4, true), treatment("ฟุต 60 นาที", "ฟุต", "นวดเท้า", "60 นาที", 0.95)] } };
    const doc = await processed("delete-and-edit.png", response);
    const view = (await app.getReviewDocument(TENANT_A, doc.documentId))!.structuredResult;
    const edited = structuredClone(view);
    const foot = (edited.staffOnly.treatments as Array<Record<string, unknown>>)[1]!;
    edited.staffOnly.treatments = [{ ...foot, value: "นวดเท้าสมุนไพร" }];
    const saved = await app.saveReview(TENANT_A, doc.documentId, { structuredResult: edited, reviewedBy: "user-a" });
    assert.deepEqual([saved.delivery, saved.document.deliveryStatus], ["PENDING", "PENDING"]);
    const fields = await superDb.query<{ field: string }>("SELECT field FROM ocr_corrections WHERE document_id = $1 ORDER BY field", [doc.documentId]);
    assert.deepEqual(fields.rows.map((row) => row.field), ["staffOnly.treatments[0]", "staffOnly.treatments[0].removed"]);
    await superDb.query("UPDATE ocr_confirm_outbox o SET status = 'DEAD' FROM ocr_corrections c WHERE c.id = o.correction_id AND c.document_id = $1", [doc.documentId]);
    assert.equal((await app.getReviewDocument(TENANT_A, doc.documentId))?.deliveryStatus, "FAILED");
    assert.equal((await app.listDocuments(TENANT_A, { q: "delete-and-edit" })).documents[0]?.deliveryStatus, "FAILED");
  });

  test("a batch that received fewer files than expected stops its clock at the last completion", async () => {
    const batch = await app.createBatch(TENANT_A, { createdBy: "user-a", expectedTotal: 3 });
    const first = await processed("short-1.png", { ...cleanResponse, documentId: `local-${randomUUID()}` }, undefined, batch.batchId);
    const second = await processed("short-2.png", { ...reviewResponse, documentId: `local-${randomUUID()}` }, undefined, batch.batchId);
    await superDb.query("UPDATE ocr_batches SET created_at = now() - interval '62 minutes' WHERE id = $1", [batch.batchId]);
    await superDb.query("UPDATE documents SET created_at = now() - interval '61 minutes', processed_at = now() - interval '60 minutes' WHERE id = ANY($1::uuid[])", [[first.documentId, second.documentId]]);
    const summary = (await app.getBatch(TENANT_A, batch.batchId))!;
    assert.deepEqual([summary.uploaded, summary.completed, summary.queued, summary.processing, summary.finishedAt], [2, 2, 0, 0, null]);
    assert.ok(Math.abs(summary.durationMs! - 120_000) < 1000, `duration ends at the last completion (got ${summary.durationMs} ms)`);
    assert.equal(summary.throughputPerMinute, 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal((await app.getBatch(TENANT_A, batch.batchId))!.durationMs, summary.durationMs, "the clock does not keep running");
  });

  test("the batch clock keeps running while OCR is ahead of files that are still uploading", async () => {
    const batch = await app.createBatch(TENANT_A, { createdBy: "user-a", expectedTotal: 3 });
    await processed("ahead-1.png", { ...cleanResponse, documentId: `local-${randomUUID()}` }, undefined, batch.batchId);
    const first = (await app.getBatch(TENANT_A, batch.batchId))!;
    assert.deepEqual([first.uploaded, first.completed, first.queued, first.processing], [1, 1, 0, 0]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const later = (await app.getBatch(TENANT_A, batch.batchId))!;
    assert.ok(later.durationMs! >= first.durationMs! + 100, `elapsed keeps growing (${first.durationMs} → ${later.durationMs} ms)`);
    assert.ok(later.throughputPerMinute! < first.throughputPerMinute!, "docs/min is not frozen at the first completion");
  });

  test("originals carry their status; replays see what a resume needs; DEAD runs fail their document; NUL is REVIEW_INVALID", async () => {
    assert.equal((await app.getOriginal(TENANT_A, docs.d1!.documentId))?.status, "SUCCEEDED");
    const pending = await upload(app, TENANT_A, "interrupted.png", { idempotencyKey: "key-interrupted", requestFingerprint: "fp-interrupted" });
    const replay = await app.findIdempotentUpload({ tenantId: TENANT_A, idempotencyKey: "key-interrupted", requestFingerprint: "fp-interrupted" });
    assert.deepEqual([replay?.documentId, replay?.jobId, replay?.status, replay?.stale, replay?.storageKey?.startsWith(`org/${TENANT_A}/original/`)], [pending.documentId, undefined, "SCANNING", false, true]);
    await superDb.query("UPDATE documents SET updated_at = now() - interval '5 minutes' WHERE id = $1", [pending.documentId]);
    assert.equal((await app.findIdempotentUpload({ tenantId: TENANT_A, idempotencyKey: "key-interrupted", requestFingerprint: "fp-interrupted" }))?.stale, true);
    assert.equal(await app.claimStaleUpload(TENANT_B, pending.documentId), false, "resume claim is tenant scoped");
    const claims = await Promise.all([app.claimStaleUpload(TENANT_A, pending.documentId), app.claimStaleUpload(TENANT_A, pending.documentId)]);
    assert.deepEqual(claims.sort(), [false, true], "concurrent replays of a stale upload: exactly one resumes it");
    assert.equal((await app.findIdempotentUpload({ tenantId: TENANT_A, idempotencyKey: "key-interrupted", requestFingerprint: "fp-interrupted" }))?.stale, false);
    const queued = await upload(app, TENANT_A, "queued-stale.png");
    await app.updateScanStatus(TENANT_A, queued.documentId, "CLEAN");
    await appQueue.enqueue({ organizationId: TENANT_A, runId: queued.runId });
    await superDb.query("UPDATE documents SET updated_at = now() - interval '5 minutes' WHERE id = $1", [queued.documentId]);
    assert.equal(await app.claimStaleUpload(TENANT_A, queued.documentId), false, "an upload that already has a job is never resumed");
    await app.updateScanStatus(TENANT_A, pending.documentId, "CLEAN");
    assert.equal(await worker.markRunFailure(TENANT_B, pending.runId, "DOCUMENT_NOT_FOUND"), false, "tenant scoped");
    assert.equal(await worker.markRunFailure(TENANT_A, pending.runId, "DOCUMENT_NOT_FOUND"), true);
    assert.deepEqual(await app.getReviewDocument(TENANT_A, pending.documentId).then((review) => [review?.status, review?.errorMessage]), ["FAILED", "DOCUMENT_NOT_FOUND"]);
    assert.equal(await worker.markRunFailure(TENANT_A, pending.runId, "again"), false, "only queued/processing rows change");
    for (const value of ["Som\u0000chai", "Som\ud800chai"]) {
      await assert.rejects(app.saveReview(TENANT_A, docs.d2!.documentId, { structuredResult: { customerInformation: { name: { value } } }, reviewedBy: "user-a" }), { message: "REVIEW_INVALID" });
    }
  });
  // ---- multi-page PDFs (migration 0018, release 1 B1–B4) ------------------------------------------------------------

  const pageKey = (tenantId: string, publicId: string) => `org/${tenantId}/original/${publicId.slice(0, 2)}/${publicId}`;
  const publicIdOf = (parentId: string, page: number) => createHash("sha256").update(`page:${parentId}:${page}`).digest("hex").slice(0, 32);
  /** Inputs of pages `numbers` of `parentId`; pages in `failed` did not render (no object). */
  const pageInputs = (tenantId: string, parentId: string, numbers: number[], failed: number[] = []): PageDocumentInput[] => numbers.map((pageNumber) => {
    const publicId = publicIdOf(parentId, pageNumber);
    return failed.includes(pageNumber) ? { pageNumber, publicId, storageKey: null, mimeType: "image/png", sizeBytes: null, contentHash: null }
      : { pageNumber, publicId, storageKey: pageKey(tenantId, publicId), mimeType: "image/png", sizeBytes: 1000 + pageNumber, contentHash: "c".repeat(64) };
  });
  async function uploadFile(tenantId: string, filename: string, mimeType: string, batchId?: string) {
    const doc = await app.createUploadedDocument({ tenantId, filename, mimeType, sizeBytes: 4242, contentHash: "p".repeat(64), storageKey: `org/${tenantId}/original/cd/${randomBytes(16).toString("hex")}`, ...(batchId ? { batchId } : {}) });
    await app.updateScanStatus(tenantId, doc.documentId, "CLEAN");
    return doc;
  }
  async function asWorker<T>(tenantId: string, sql: string, values: unknown[] = []): Promise<T[]> {
    const client = await workerPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_org', $1, true)", [tenantId]);
      const result = await client.query(sql, values);
      await client.query("COMMIT");
      return result.rows as T[];
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async function pagesOf(parentId: string) {
    return (await superDb.query<{ page_number: number; status: string; storage_key: string | null; filename: string; batch_id: string | null; created_at: Date; page_count: number;
      size_bytes: string; content_hash: string; error_message: string | null; runs: number; jobs: number; priorities: number[] | null }>(
      `SELECT d.page_number, d.status::text AS status, d.storage_key, d.filename, d.batch_id, d.created_at, d.page_count, d.size_bytes, d.content_hash, d.error_message,
              (SELECT count(*)::int FROM document_runs r WHERE r.document_id = d.id) AS runs,
              (SELECT count(*)::int FROM extraction_jobs j JOIN document_runs r ON r.id = j.run_id WHERE r.document_id = d.id) AS jobs,
              (SELECT array_agg(j.priority ORDER BY j.created_at) FROM extraction_jobs j JOIN document_runs r ON r.id = j.run_id WHERE r.document_id = d.id) AS priorities
       FROM documents d WHERE d.parent_document_id = $1 ORDER BY d.page_number`, [parentId])).rows;
  }
  const split: Record<string, { documentId: string; runId: string }> = {};

  test("0018 applies after 0017: SPLIT status, page columns, same-tenant FK, shape CHECK, and exactly the new worker rights", async () => {
    // Order, not position: later releases add migrations after 0018, and the runner must still end at the newest one.
    assert.ok(applied.indexOf("0017_batch_processing") >= 0, applied.join(","));
    assert.ok(applied.indexOf("0018_multipage_documents") > applied.indexOf("0017_batch_processing"), applied.join(","));
    assert.equal(applied.at(-1), NEWEST_MIGRATION, applied.join(","));
    // The worker's startup gate (services/ocr-worker assertSchemaReady) runs exactly this query as ocr_worker.
    assert.equal((await workerPool.query("SELECT 1 FROM schema_migrations WHERE version = $1", ["0018_multipage_documents"])).rowCount, 1);
    assert.equal((await superDb.query("SELECT 'SPLIT'::document_status AS s")).rows[0].s, "SPLIT");
    const table = async (role: string, name: string, privilege: string) => (await superDb.query<{ ok: boolean }>("SELECT has_table_privilege($1, $2, $3) AS ok", [role, name, privilege])).rows[0]!.ok;
    const column = async (role: string, name: string, col: string) => (await superDb.query<{ ok: boolean }>("SELECT has_column_privilege($1, $2, $3, 'SELECT') AS ok", [role, name, col])).rows[0]!.ok;
    assert.deepEqual(await Promise.all([table("ocr_worker", "documents", "INSERT"), table("ocr_worker", "document_runs", "INSERT"), table("ocr_worker", "extraction_jobs", "INSERT")]), [true, true, true]);
    assert.deepEqual(await Promise.all([table("ocr_worker", "extraction_jobs", "UPDATE"), table("ocr_worker", "extraction_jobs", "DELETE"), table("ocr_worker", "extraction_jobs", "SELECT"),
      table("ocr_worker", "documents", "DELETE"), table("ocr_app", "extraction_jobs", "UPDATE"), table("ocr_queue", "extraction_jobs", "SELECT"), table("ocr_queue", "documents", "INSERT")]),
      [false, false, false, false, false, false, false]);
    // No column of extraction_jobs is readable by the worker (its job INSERT has no RETURNING / ON CONFLICT).
    assert.deepEqual(await Promise.all(["id", "organization_id", "run_id", "status", "priority", "lease_token_hash"].map((col) => column("ocr_worker", "extraction_jobs", col))), [false, false, false, false, false, false]);
    assert.equal((await superDb.query<{ ok: boolean }>("SELECT has_any_column_privilege('ocr_worker', 'extraction_jobs', 'SELECT') AS ok")).rows[0]!.ok, false);
    const functions = await superDb.query<{ proname: string }>("SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prokind = 'f' AND proname LIKE 'ocr%' ORDER BY proname");
    assert.deepEqual(functions.rows.map((row) => row.proname), ["ocr_claim_confirm_outbox_v1", "ocr_claim_v1", "ocr_finish_confirm_outbox_v1", "ocr_finish_retry_v1", "ocr_finish_v1",
      "ocr_heartbeat_v1", "ocr_recover_confirm_outbox_v1", "ocr_recover_expired_v1"], "0018 and 0019 created no function");
    // CHECK: a page number needs a parent and vice versa; bounds 1..1000.
    const parent = await uploadFile(TENANT_A, "shape.pdf", "application/pdf");
    for (const [parentId, page, count] of [[null, 1, null], [parent.documentId, null, 3], [parent.documentId, 0, 3], [parent.documentId, 1, 1001]] as const) {
      await assert.rejects(superDb.query(`INSERT INTO documents(id, organization_id, public_id, status, filename, mime_type, size_bytes, content_hash, parent_document_id, page_number, page_count)
        VALUES (gen_random_uuid(), $1, $2, 'CLEAN', 'x.png', 'image/png', 1, 'h', $3, $4, $5)`, [TENANT_A, randomBytes(16).toString("hex"), parentId, page, count]), { code: "23514" });
    }
  });

  test("the worker creates pages, runs and jobs for tenant A; tenant B is refused (parent lookup, RLS, composite FK); nothing else is writable", async () => {
    const batch = await app.createBatch(TENANT_A, { createdBy: "user-a", expectedTotal: 2 });
    const parent = await uploadFile(TENANT_A, "intake-12.pdf", "application/pdf", batch.batchId);
    split.parent = parent;
    await worker.markProcessing(TENANT_A, parent.documentId);
    await worker.setPageCount(TENANT_A, parent.documentId, 5);
    assert.deepEqual(await worker.createPageDocuments(TENANT_A, parent.documentId, 5, pageInputs(TENANT_A, parent.documentId, [1, 2, 3])), { created: [1, 2, 3], existing: [] });
    const parentRow = (await superDb.query("SELECT created_at, batch_id FROM documents WHERE id = $1", [parent.documentId])).rows[0];
    const pages = await pagesOf(parent.documentId);
    assert.deepEqual(pages.map((page) => [page.page_number, page.status, page.filename, page.batch_id, page.page_count, page.runs, page.jobs, page.priorities]),
      [[1, "CLEAN", "intake-12.pdf", batch.batchId, 5, 1, 1, [100]], [2, "CLEAN", "intake-12.pdf", batch.batchId, 5, 1, 1, [101]], [3, "CLEAN", "intake-12.pdf", batch.batchId, 5, 1, 1, [102]]]);
    assert.ok(pages.every((page) => page.created_at.getTime() === parentRow.created_at.getTime()), "pages carry the parent's created_at (they list where the upload was)");
    assert.equal(pages[1]!.storage_key, pageKey(TENANT_A, publicIdOf(parent.documentId, 2)));
    await assert.rejects(worker.createPageDocuments(TENANT_B, parent.documentId, 5, pageInputs(TENANT_B, parent.documentId, [4])), { message: "DOCUMENT_NOT_FOUND" });
    const insert = (org: string, parentId: string | null) => `INSERT INTO documents(id, organization_id, public_id, status, filename, mime_type, size_bytes, content_hash, parent_document_id, page_number, page_count)
      VALUES (gen_random_uuid(), '${org}', '${randomBytes(16).toString("hex")}', 'CLEAN', 'x.png', 'image/png', 1, 'h', ${parentId ? `'${parentId}'` : "NULL"}, ${parentId ? 4 : "NULL"}, ${parentId ? 5 : "NULL"})`;
    await assert.rejects(asWorker(TENANT_B, insert(TENANT_A, parent.documentId)), /row-level security/, "RLS: a row for another tenant is rejected");
    await assert.rejects(asWorker(TENANT_B, insert(TENANT_B, parent.documentId)), { code: "23503" }, "composite FK: a page never points at another tenant's parent");
    const runId = (await asWorker<{ id: string }>(TENANT_A, "SELECT id FROM document_runs WHERE document_id = $1", [parent.documentId]))[0]!.id;
    await assert.rejects(asWorker(TENANT_B, "INSERT INTO extraction_jobs(id, organization_id, run_id, kind, status) VALUES (gen_random_uuid(), $1, $2, 'OCR', 'PENDING')", [TENANT_A, runId]), /row-level security/);
    await assert.rejects(asWorker(TENANT_A, "UPDATE extraction_jobs SET priority = 1"), { code: "42501" });
    await assert.rejects(asWorker(TENANT_A, "SELECT status FROM extraction_jobs"), { code: "42501" });
    await assert.rejects(asWorker(TENANT_A, "DELETE FROM documents WHERE id = $1", [parent.documentId]), { code: "42501" });
    assert.equal((await asWorker(TENANT_B, "SELECT id FROM documents WHERE parent_document_id = $1", [parent.documentId])).length, 0);
  });

  test("a repeated or concurrent split creates no duplicate page, run or job; a page that did not render gets a FAILED row without a job", async () => {
    const parentId = split.parent!.documentId;
    assert.deepEqual(await worker.createPageDocuments(TENANT_A, parentId, 5, pageInputs(TENANT_A, parentId, [2, 3, 4, 5], [4])), { created: [4, 5], existing: [2, 3] });
    const pages = await pagesOf(parentId);
    assert.deepEqual(pages.map((page) => [page.page_number, page.status, page.runs, page.jobs]), [[1, "CLEAN", 1, 1], [2, "CLEAN", 1, 1], [3, "CLEAN", 1, 1], [4, "FAILED", 1, 0], [5, "CLEAN", 1, 1]]);
    assert.deepEqual([pages[3]!.storage_key, pages[3]!.error_message, pages[3]!.size_bytes, pages[3]!.content_hash], [null, "PAGE_RENDER_FAILED", "4242", "p".repeat(64)], "a failed page carries its source's size and hash");
    assert.deepEqual(await worker.existingPages(TENANT_A, parentId), [1, 2, 3, 4, 5]);
    const other = await uploadFile(TENANT_A, "race.pdf", "application/pdf");
    const results = await Promise.all([1, 2, 3].map(() => worker.createPageDocuments(TENANT_A, other.documentId, 4, pageInputs(TENANT_A, other.documentId, [1, 2, 3, 4]))));
    assert.deepEqual(results.map((result) => result.created.length).sort(), [0, 0, 4], "the advisory lock + unique index let exactly one run create the pages");
    assert.deepEqual((await pagesOf(other.documentId)).map((page) => [page.runs, page.jobs]), [[1, 1], [1, 1], [1, 1], [1, 1]]);
    await assert.rejects(worker.markSplit(TENANT_A, parentId, 6), { message: "SPLIT_INCOMPLETE" });
  });

  test("batch counters: 1 file → N rows, capacity counts files, finished only after the last page; pages list in order; SPLIT hidden but served", async () => {
    const parent = split.parent!;
    const batchId = (await app.getReviewDocument(TENANT_A, parent.documentId))!.batchId!;
    let summary = (await app.getBatch(TENANT_A, batchId))!;
    assert.deepEqual([summary.uploaded, summary.rows, summary.pages, summary.pagesExpected, summary.splitting, summary.processing, summary.queued, summary.failed, summary.finished],
      [1, 6, 5, 5, 1, 1, 4, 1, false], "the splitting parent is one processing row; 4 queued pages; the failed page is a finished row");
    assert.equal(summary.rowsExpected, 6, "5 pages + 1 promised file: the splitting parent (page count known) is not counted on top of its pages");
    const image = await uploadFile(TENANT_A, "late-image.png", "image/png", batchId);
    await assert.rejects(uploadFile(TENANT_A, "third.png", "image/png", batchId), { message: "BATCH_FULL" }, "2 files promised: pages never fill the batch");
    await worker.markSplit(TENANT_A, parent.documentId, 5);
    summary = (await app.getBatch(TENANT_A, batchId))!;
    assert.deepEqual([summary.uploaded, summary.rows, summary.pages, summary.splitting, summary.queued, summary.processing, summary.finished], [2, 6, 5, 0, 5, 0, false]);
    assert.equal(summary.rowsExpected, 6);
    const listed = await app.listDocuments(TENANT_A, { batchId });
    assert.deepEqual(listed.documents.map((item) => [item.filename, item.pageNumber, item.pageCount]),
      [["late-image.png", null, null], ["intake-12.pdf", 1, 5], ["intake-12.pdf", 2, 5], ["intake-12.pdf", 3, 5], ["intake-12.pdf", 4, 5], ["intake-12.pdf", 5, 5]],
      "the SPLIT parent is not a row; its pages sit together in page order where the upload was");
    assert.equal(listed.total, 6);
    assert.deepEqual([listed.documents[2]!.parentDocumentId, listed.documents[2]!.parentFilename, listed.documents[4]!.statusCategory, listed.documents[4]!.errorMessage], [parent.documentId, "intake-12.pdf", "failed", "PAGE_RENDER_FAILED"]);
    const pagesOnly = await app.listDocuments(TENANT_A, { parentId: parent.documentId, limit: 2, offset: 2 });
    assert.deepEqual([pagesOnly.total, pagesOnly.documents.map((item) => item.pageNumber)], [5, [3, 4]], "parentId filter + pagination");
    assert.equal((await app.listDocuments(TENANT_B, { parentId: parent.documentId })).total, 0);
    const parentView = (await app.getReviewDocument(TENANT_A, parent.documentId))!;
    assert.deepEqual([parentView.status, parentView.pageCount, parentView.parentDocumentId], ["SPLIT", 5, null]);
    assert.deepEqual(await app.getOriginal(TENANT_A, parent.documentId).then((original) => original && [original.status, original.mimeType, original.storageKey?.startsWith(`org/${TENANT_A}/original/`)]),
      ["SPLIT", "application/pdf", true], "hidden from the list, still served (the original-PDF-page link)");
    const page2Id = listed.documents[2]!.documentId;
    const page2 = (await app.getReviewDocument(TENANT_A, page2Id))!;
    assert.deepEqual([page2.parentDocumentId, page2.pageNumber, page2.pageCount, page2.parentFilename], [parent.documentId, 2, 5, "intake-12.pdf"]);
    const page2Run = (await superDb.query<{ id: string }>("SELECT id FROM document_runs WHERE document_id = $1", [page2Id])).rows[0]!.id;
    const workerView = (await worker.getWorkerDocument(page2Run, TENANT_A))!;
    assert.deepEqual([workerView.status, workerView.mimeType, workerView.parentDocumentId, workerView.pageNumber, workerView.pageCount, workerView.batchId, workerView.sourceKey?.endsWith(publicIdOf(parent.documentId, 2))],
      ["CLEAN", "image/png", parent.documentId, 2, 5, batchId, true]);
    assert.equal(workerView.parentSourceKey, (await app.getOriginal(TENANT_A, parent.documentId))!.storageKey);
    const failedRun = (await superDb.query<{ id: string }>("SELECT r.id FROM document_runs r JOIN documents d ON d.id = r.document_id WHERE d.parent_document_id = $1 AND d.page_number = 4", [parent.documentId])).rows[0]!.id;
    assert.equal((await worker.getWorkerDocument(failedRun, TENANT_A))?.sourceKey, null, "a page without an object is still loadable (its job re-renders it)");
    // Read every row (pages + image): only then is the batch finished.
    const rows = listed.documents.filter((item) => item.status === "CLEAN");
    for (const [index, item] of rows.entries()) {
      await worker.markProcessing(TENANT_A, item.documentId);
      await saveResult(TENANT_A, item.documentId, { ...cleanResponse, documentId: `local-${randomUUID()}` });
      summary = (await app.getBatch(TENANT_A, batchId))!;
      assert.equal(summary.finished, index === rows.length - 1, `finished after row ${index + 1} of ${rows.length}`);
    }
    assert.deepEqual([summary.completed, summary.succeeded, summary.failed, summary.rows], [6, 5, 1, 6]);
    assert.ok(summary.finishedAt);
    void image;
  });

  test("retry: a page whose render failed gets a job (re-rendered by it); a FAILED PDF parent re-splits; the new jobs have priority 100", async () => {
    const parentId = split.parent!.documentId;
    const failedPage = (await superDb.query<{ id: string }>("SELECT id FROM documents WHERE parent_document_id = $1 AND page_number = 4", [parentId])).rows[0]!.id;
    const { jobId } = await app.retryDocument(TENANT_A, failedPage);
    assert.deepEqual((await pagesOf(parentId))[3]!.priorities, [100]);
    assert.deepEqual(await app.getReviewDocument(TENANT_A, failedPage).then((doc) => [doc?.status, doc?.errorMessage]), ["CLEAN", null]);
    assert.ok(jobId);
    await assert.rejects(app.retryDocument(TENANT_A, failedPage), { message: "DOCUMENT_NOT_RETRYABLE" });
    await worker.setPageObject(TENANT_A, failedPage, pageKey(TENANT_A, publicIdOf(parentId, 4)), 777, "d".repeat(64));
    assert.deepEqual(await superDb.query("SELECT storage_key, size_bytes::int AS size FROM documents WHERE id = $1", [failedPage]).then((result) => result.rows[0]), { storage_key: pageKey(TENANT_A, publicIdOf(parentId, 4)), size: 777 });
    // A PDF whose split failed (job ended, parent FAILED) is retried like any failed document: its new job splits it again.
    const pdf = await uploadFile(TENANT_A, "retry-me.pdf", "application/pdf");
    await appQueue.enqueue({ organizationId: TENANT_A, runId: pdf.runId });
    await worker.markFailure(TENANT_A, pdf.documentId, "PDF_RENDER_FAILED: pages 1-10 timed out");
    await app.retryDocument(TENANT_A, pdf.documentId);
    const view = (await worker.getWorkerDocument(pdf.runId, TENANT_A))!;
    assert.deepEqual([view.status, view.mimeType, view.parentDocumentId, view.pageCount], ["CLEAN", "application/pdf", null, null], "a split target for the worker");
    const scanFailed = await app.createUploadedDocument({ tenantId: TENANT_A, filename: "unscanned.pdf", mimeType: "application/pdf", sizeBytes: 1, contentHash: "h", storageKey: `org/${TENANT_A}/original/ef/${randomBytes(16).toString("hex")}` });
    await app.updateScanStatus(TENANT_A, scanFailed.documentId, "FAILED", "SCAN_FAILED");
    await assert.rejects(app.retryDocument(TENANT_A, scanFailed.documentId), { message: "DOCUMENT_NOT_RETRYABLE" }, "an unscanned upload is still never retried");
  });

  test("fair priority: ocr_claim_v1 claims pages in page order and a single upload ahead of the remaining pages", async () => {
    const pdf = await uploadFile(TENANT_B, "priority.pdf", "application/pdf");
    await worker.createPageDocuments(TENANT_B, pdf.documentId, 3, pageInputs(TENANT_B, pdf.documentId, [1, 2, 3]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const single = await uploadFile(TENANT_B, "urgent.png", "image/png");
    const singleJob = await appQueue.enqueue({ organizationId: TENANT_B, runId: single.runId });
    const batched = await uploadFile(TENANT_B, "batch-file-1.png", "image/png");
    const batchedJob = await appQueue.enqueue({ organizationId: TENANT_B, runId: batched.runId, priority: 101 });
    const names = new Map<string, string>([[singleJob, "single"], [batchedJob, "batch#1"]]);
    for (const row of (await superDb.query<{ id: string; page_number: number }>("SELECT j.id, d.page_number FROM extraction_jobs j JOIN document_runs r ON r.id = j.run_id JOIN documents d ON d.id = r.document_id WHERE d.parent_document_id = $1", [pdf.documentId])).rows) {
      names.set(row.id, `page${row.page_number}`);
    }
    const order: string[] = [];
    for (let claimed = await queue.claim(new Date(Date.now() + 60_000)); claimed; claimed = await queue.claim(new Date(Date.now() + 60_000))) {
      if (names.has(claimed.jobId)) order.push(names.get(claimed.jobId)!);
    }
    assert.deepEqual(order, ["page1", "single", "page2", "batch#1", "page3"]);
  });

  // ---- 0019_user_auth: staff accounts, server-side sessions and the append-only audit log. ----
  const AUTH_TABLES = ["audit_events", "auth_sessions", "users"] as const;   // alphabetical: query results are ordered
  /** Obviously fake: a self-describing placeholder in the stored format, matching no password. */
  const FAKE_HASH = "scrypt$v1$N=32768,r=8,p=3$bm90LWEtcmVhbC1zYWx0$bm90LWEtcmVhbC1rZXk";
  const tokenHash = (seed: string) => createHash("sha256").update(seed).digest();
  async function createUser(tenantId: string, username: string, role: "admin" | "staff" = "staff"): Promise<string> {
    const rows = await asApp<{ id: string }>(tenantId,
      "INSERT INTO users(organization_id, username, display_name, role, password_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [tenantId, username, `Staff ${username}`, role, FAKE_HASH]);
    return rows[0]!.id;
  }

  test("0019 forces tenant RLS on the auth tables and grants exactly the web runtime's rights", async () => {
    assert.ok(applied.includes("0019_user_auth"), applied.join(","));
    const tables = await superDb.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; owner: string }>(
      "SELECT relname, relrowsecurity, relforcerowsecurity, pg_get_userbyid(relowner) AS owner FROM pg_class WHERE relname = ANY($1::text[]) ORDER BY relname", [[...AUTH_TABLES]]);
    assert.deepEqual(tables.rows, AUTH_TABLES.map((relname) => ({ relname, relrowsecurity: true, relforcerowsecurity: true, owner: "ocr_migrator" })));
    // Table-level matrix: the web runtime reads and appends, nothing more. has_table_privilege is false where only columns are granted.
    const privileges = await superDb.query<{ role: string; relname: string; privilege: string; granted: boolean }>(
      `SELECT r AS role, t AS relname, p AS privilege, has_table_privilege(r, t, p) AS granted
       FROM unnest(ARRAY['ocr_app','ocr_worker','ocr_queue']) r CROSS JOIN unnest($1::text[]) t CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p
       ORDER BY r, t, p`, [[...AUTH_TABLES]]);
    assert.deepEqual(privileges.rows.filter((row) => row.granted).map((row) => `${row.role}:${row.relname}:${row.privilege}`),
      ["ocr_app:audit_events:INSERT", "ocr_app:audit_events:SELECT", "ocr_app:auth_sessions:INSERT", "ocr_app:auth_sessions:SELECT",
        "ocr_app:users:INSERT", "ocr_app:users:SELECT"]);
    // Column-level UPDATE: identity, tenant and creation time are immutable, and audit rows are append-only.
    const updatable = async (relname: string) => (await superDb.query<{ column_name: string }>(
      `SELECT a.attname AS column_name FROM pg_attribute a WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
         AND has_column_privilege('ocr_app', a.attrelid, a.attnum, 'UPDATE') ORDER BY a.attname`, [relname])).rows.map((row) => row.column_name);
    assert.deepEqual(await updatable("users"), ["can_export", "disabled_at", "display_name", "failed_logins", "last_login_at", "locked_until",
      "must_change_password", "password_changed_at", "password_expires_at", "password_hash", "role", "updated_at"]);
    assert.deepEqual(await updatable("auth_sessions"), ["last_seen_at", "revoked_at", "revoked_reason"]);
    assert.deepEqual(await updatable("audit_events"), []);
    // ocr_queue_definer is the one BYPASSRLS role: a grant drifting onto it would expose hashes and sessions across tenants.
    const definer = await superDb.query<{ readable: boolean }>(
      "SELECT bool_or(has_any_column_privilege('ocr_queue_definer', t, 'SELECT')) AS readable FROM unnest($1::text[]) t", [[...AUTH_TABLES]]);
    assert.equal(definer.rows[0]!.readable, false, "the BYPASSRLS definer role must never read users, sessions or audit rows");
  });

  test("ocr_worker and ocr_queue are refused the auth tables; ocr_app can neither delete rows nor rewrite identity or audit rows", async () => {
    for (const relname of AUTH_TABLES) {
      await assert.rejects(asWorker(TENANT_A, `SELECT count(*) FROM ${relname}`), { code: "42501" }, `worker:${relname}`);
      await assert.rejects(queueRolePool.query(`SELECT count(*) FROM ${relname}`), { code: "42501" }, `queue:${relname}`);
    }
    await assert.rejects(asApp(TENANT_A, "UPDATE users SET organization_id = organization_id"), { code: "42501" });
    await assert.rejects(asApp(TENANT_A, "UPDATE users SET username = username"), { code: "42501" });
    await assert.rejects(asApp(TENANT_A, "UPDATE audit_events SET outcome = 'failure'"), { code: "42501" });
    await assert.rejects(asApp(TENANT_A, "DELETE FROM audit_events"), { code: "42501" });
    await assert.rejects(asApp(TENANT_A, "DELETE FROM users"), { code: "42501" });
    await assert.rejects(asApp(TENANT_A, "DELETE FROM auth_sessions"), { code: "42501" });
  });

  test("0019 tenant scope: no GUC hides every row, tenant B sees none of tenant A's, cross-tenant writes are refused, usernames are per tenant", async () => {
    const userA = await createUser(TENANT_A, "somchai");
    await asApp(TENANT_A, "INSERT INTO auth_sessions(organization_id, user_id, token_hash, expires_at) VALUES ($1,$2,$3, now() + interval '8 hours')",
      [TENANT_A, userA, tokenHash("session-a")]);
    await asApp(TENANT_A, "INSERT INTO audit_events(organization_id, actor_user_id, action, target_type, target_id) VALUES ($1,$2,'auth.login','user',$2)", [TENANT_A, userA]);
    for (const relname of AUTH_TABLES) {
      const count = async (tenantId: string | null) => (await asApp<{ count: number }>(tenantId, `SELECT count(*)::int AS count FROM ${relname}`))[0]!.count;
      assert.equal(await count(null), 0, `no GUC:${relname}`);
      assert.equal(await count(TENANT_B), 0, `tenant B:${relname}`);
      assert.equal(await count(TENANT_A), 1, `tenant A:${relname}`);
    }
    await assert.rejects(asApp(TENANT_B, "INSERT INTO users(organization_id, username, display_name, role, password_hash) VALUES ($1,'intruder','Intruder','staff',$2)",
      [TENANT_A, FAKE_HASH]), /row-level security/, "a row for another tenant is rejected by the policy");
    await assert.rejects(asApp(TENANT_B, "INSERT INTO auth_sessions(organization_id, user_id, token_hash, expires_at) VALUES ($1,$2,$3, now() + interval '1 hour')",
      [TENANT_B, userA, tokenHash("cross-tenant")]), { code: "23503" }, "composite FK: a session never points at another tenant's user");
    assert.notEqual(await createUser(TENANT_B, "somchai"), userA, "the same username may exist in both tenants");
    await assert.rejects(createUser(TENANT_A, "somchai"), { code: "23505" }, "it is unique within one tenant");
  });

  // ---- PostgresUserStore, the session store and the audit log, exercised as ocr_app under FORCE RLS. ----
  /** A second obviously fake hash, in the stored format, so a rehash is visible without hashing anything. */
  const FAKE_REHASH = "scrypt$v1$N=65536,r=8,p=3$cmVoYXNoZWQtbm90LXJlYWw$cmVoYXNoZWQtbm90LWEtcmVhbC1rZXk";
  const storeFor = (tenantId: string) => new PostgresUserStore(appPool, tenantId);
  /** What a route passes: the server-minted trace id, never the client's echoed X-Request-Id. */
  const auditAs = (actorUserId: string | null): AuditContext => ({ actorUserId, requestId: randomUUID() });
  const auditActions = async (tenantId: string, targetId: string): Promise<string[]> =>
    (await asApp<{ action: string }>(tenantId, "SELECT action FROM audit_events WHERE target_id=$1::uuid ORDER BY occurred_at, action", [targetId])).map((row) => row.action);
  const auditCount = async (tenantId: string): Promise<number> =>
    (await asApp<{ count: number }>(tenantId, "SELECT count(*)::int AS count FROM audit_events"))[0]!.count;

  test("the user store creates and lists users under the tenant, refuses bad input and maps a duplicate username to USERNAME_TAKEN", async () => {
    const store = storeFor(TENANT_A);
    await store.assertTenant();
    await assert.rejects(storeFor(randomUUID()).assertTenant(), /LOGIN_TENANT_NOT_FOUND/, "an unknown tenant must fail web startup, not every login");
    const admin = await store.createUser({ username: "admin.one", displayName: "แอดมิน หนึ่ง", role: "admin", passwordHash: FAKE_HASH, temporary: false, audit: auditAs(null) });
    assert.deepEqual([admin.role, admin.status, admin.canExport], ["admin", "active", false]);
    const audit = auditAs(admin.id);
    const staff = await store.createUser({ username: "nok.staff", displayName: "Nok", role: "staff", canExport: true, passwordHash: FAKE_HASH, audit });
    assert.equal(staff.status, "must_change", "a new account starts on a temporary password");
    const temporary = await asApp<{ within_72h: boolean }>(TENANT_A,
      "SELECT password_expires_at BETWEEN now() + interval '71 hours' AND now() + interval '72 hours' AS within_72h FROM users WHERE id=$1::uuid", [staff.id]);
    assert.equal(temporary[0]!.within_72h, true, "D6: the temporary password dies after 72 h");
    const before = await auditCount(TENANT_A);
    await assert.rejects(store.createUser({ username: "nok.staff", displayName: "Nok Again", role: "staff", passwordHash: FAKE_HASH, audit }), /USERNAME_TAKEN/);
    assert.equal(await auditCount(TENANT_A), before, "the refused insert and its audit row roll back together");
    for (const username of ["no", ".nok", "nok staff", "n".repeat(40)]) {
      await assert.rejects(store.createUser({ username, displayName: "X", role: "staff", passwordHash: FAKE_HASH, audit }), /INVALID_USERNAME/, username);
    }
    await assert.rejects(store.createUser({ username: "ok.name", displayName: "   ", role: "staff", passwordHash: FAKE_HASH, audit }), /INVALID_DISPLAY_NAME/);
    await assert.rejects(store.createUser({ username: "ok.name", displayName: "X", role: "owner" as UserRole, passwordHash: FAKE_HASH, audit }), /INVALID_ROLE/);
    await assert.rejects(store.createUser({ username: "ok.name", displayName: "X", role: "staff", passwordHash: "not-a-scrypt-hash", audit }), /PASSWORD_HASH_INVALID/);
    const listed = await store.listUsers();
    assert.deepEqual(listed.map((user) => user.username), ["admin.one", "nok.staff", "somchai"], "one tenant's users, in username order");
    assert.ok(!JSON.stringify(listed).includes("scrypt$"), "the admin list never carries a hash");
    const updated = await store.updateUser(staff.id, { displayName: "Nok N.", canExport: false }, audit);
    assert.deepEqual([updated.displayName, updated.canExport], ["Nok N.", false]);
    await assert.rejects(store.updateUser(randomUUID(), { displayName: "Ghost" }, audit), /USER_NOT_FOUND/);
    await assert.rejects(store.updateUser(staff.id, {}, audit), /USER_INVALID/);
    assert.deepEqual(await auditActions(TENANT_A, staff.id), ["user.created", "user.updated"]);
    const detail = await asApp<{ detail: Record<string, unknown> }>(TENANT_A, "SELECT detail FROM audit_events WHERE target_id=$1::uuid AND action='user.updated'", [staff.id]);
    assert.deepEqual(detail[0]!.detail, { fields: "canExport,displayName" }, "the changed field names only, never their values");
  });

  test("ten login failures lock the account, unlock clears the counters and a success consumes the temporary password", async () => {
    const store = storeFor(TENANT_A);
    const admin = (await store.findLoginUser("admin.one"))!;
    const audit = auditAs(admin.id);
    const user = await store.createUser({ username: "lock.me", displayName: "Lock Me", role: "staff", passwordHash: FAKE_HASH, audit });
    const login = (await store.findLoginUser("  LOCK.ME  "))!;
    assert.deepEqual([login.id, login.mustChangePassword, login.lockedUntil, login.disabledAt], [user.id, true, null, null], "NFKC, trim and lower case, like the login form");
    assert.equal(await store.findLoginUser("does.not.exist"), null);
    assert.equal(await store.findLoginUser("Not A Username!"), null, "a name that cannot exist simply finds no user");
    const counters = async () => (await asApp<{ failed_logins: number; locked: boolean | null }>(TENANT_A,
      "SELECT failed_logins, locked_until > now() AS locked FROM users WHERE id=$1::uuid", [user.id]))[0]!;
    for (let attempt = 1; attempt < 10; attempt += 1) {
      assert.equal((await store.recordLoginFailure(user.id, { reason: "bad_password", audit })).locked, false, `attempt ${attempt}`);
    }
    assert.deepEqual(await counters(), { failed_logins: 9, locked: null });
    assert.equal((await store.recordLoginFailure(user.id, { reason: "bad_password", audit })).locked, true, "the tenth trips the lock");
    assert.deepEqual(await counters(), { failed_logins: 0, locked: true }, "the counter resets as the lock trips");
    assert.equal((await store.recordLoginFailure(user.id, { reason: "locked", audit })).locked, false, "a failure against a locked account does not trip it again");
    const actions = await auditActions(TENANT_A, user.id);
    assert.equal(actions.filter((action) => action === "login.failed").length, 11);
    assert.equal(actions.filter((action) => action === "login.locked").length, 1, "the lock is audited once");
    assert.equal((await store.listUsers()).find((row) => row.username === "lock.me")!.status, "locked", "the lock is visible to admins only");
    await store.unlockUser(user.id, audit);
    assert.deepEqual(await counters(), { failed_logins: 0, locked: null });
    await assert.rejects(store.unlockUser(randomUUID(), audit), /USER_NOT_FOUND/);
    await store.recordLoginSuccess(user.id, FAKE_REHASH);
    const after = (await asApp<{ hash: string; consumed: boolean; last_login: boolean }>(TENANT_A,
      "SELECT password_hash AS hash, password_expires_at <= now() AS consumed, last_login_at IS NOT NULL AS last_login FROM users WHERE id=$1::uuid", [user.id]))[0]!;
    assert.deepEqual(after, { hash: FAKE_REHASH, consumed: true, last_login: true }, "the rehash is stored and the temporary password is single-use");
    await store.recordLoginSuccess(user.id);
    assert.equal((await store.findLoginUser("lock.me"))!.passwordHash, FAKE_REHASH, "a login without a rehash keeps the stored hash");
    await store.resetPassword(user.id, FAKE_HASH, audit);
    const reset = (await asApp<{ status: string; failed_logins: number }>(TENANT_A,
      `SELECT ${"CASE WHEN locked_until > now() THEN 'locked' WHEN must_change_password THEN 'must_change' ELSE 'active' END AS status"}, failed_logins FROM users WHERE id=$1::uuid`, [user.id]))[0]!;
    assert.deepEqual(reset, { status: "must_change", failed_logins: 0 }, "a reset clears the lock and asks for a new password");
    assert.ok((await auditActions(TENANT_A, user.id)).includes("user.password_reset"));
  });

  test("sessions: create, resolve, touch at most once a minute, idle and absolute expiry, revoke, and a disabled user", async () => {
    const store = storeFor(TENANT_A);
    const admin = (await store.findLoginUser("admin.one"))!;
    const audit = auditAs(admin.id);
    const user = await store.createUser({ username: "sess.user", displayName: "Session User", role: "staff", passwordHash: FAKE_HASH, audit });
    const session = await store.createSession({ userId: user.id, tokenHash: tokenHash("sess-live"), absoluteHours: 8, audit: auditAs(user.id) });
    const resolved = (await store.resolveSession(tokenHash("sess-live"), 30))!;
    assert.deepEqual([resolved.sessionId, resolved.userId, resolved.username, resolved.role, resolved.canExport, resolved.mustChangePassword],
      [session.sessionId, user.id, "sess.user", "staff", false, true]);
    assert.equal(resolved.createdAt, session.createdAt, "the forced-change grace window reads created_at");
    const loginRow = await asApp<{ session_id: string }>(TENANT_A, "SELECT session_id FROM audit_events WHERE action='login.succeeded' AND target_id=$1::uuid", [user.id]);
    assert.equal(loginRow[0]!.session_id, session.sessionId, "login.succeeded carries the session it opened");
    assert.equal(await store.resolveSession(tokenHash("never-issued"), 30), null);
    assert.equal(await store.resolveSession(Buffer.alloc(16), 30), null, "a token hash of the wrong size is simply no session");
    await assert.rejects(store.createSession({ userId: user.id, tokenHash: Buffer.alloc(16), absoluteHours: 8, audit }), /SESSION_TOKEN_INVALID/);
    await assert.rejects(store.createSession({ userId: user.id, tokenHash: tokenHash("bad-hours"), absoluteHours: 0, audit }), /SESSION_HOURS_INVALID/);
    const idleSeconds = async () => (await asApp<{ age: number }>(TENANT_A,
      "SELECT extract(epoch FROM now() - last_seen_at)::int AS age FROM auth_sessions WHERE id=$1::uuid", [session.sessionId]))[0]!.age;
    await superDb.query("UPDATE auth_sessions SET last_seen_at = now() - interval '30 seconds' WHERE id=$1", [session.sessionId]);
    await store.touchSession(session.sessionId);
    assert.ok(await idleSeconds() >= 30, "a session seen half a minute ago is not written again");
    await superDb.query("UPDATE auth_sessions SET last_seen_at = now() - interval '2 minutes' WHERE id=$1", [session.sessionId]);
    await store.touchSession(session.sessionId);
    assert.ok(await idleSeconds() < 5, "a user action past the minute moves the deadline");
    await superDb.query("UPDATE auth_sessions SET last_seen_at = now() - interval '31 minutes' WHERE id=$1", [session.sessionId]);
    assert.equal(await store.resolveSession(tokenHash("sess-live"), 30), null, "idle past the deadline resolves to nothing");
    assert.ok(await store.resolveSession(tokenHash("sess-live"), 60), "the same session inside a longer window still resolves");
    await superDb.query("UPDATE auth_sessions SET last_seen_at = now() WHERE id=$1", [session.sessionId]);
    const expiring = await store.createSession({ userId: user.id, tokenHash: tokenHash("sess-expired"), absoluteHours: 1, audit: auditAs(user.id) });
    // The CHECK keeps expires_at after created_at, so an aged-out session is backdated as a whole.
    await superDb.query("UPDATE auth_sessions SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 second' WHERE id=$1", [expiring.sessionId]);
    assert.equal(await store.resolveSession(tokenHash("sess-expired"), 30), null, "past the absolute deadline too");
    assert.deepEqual(await store.revokeSession(tokenHash("sess-live"), "logout", audit), { revoked: true });
    assert.equal(await store.resolveSession(tokenHash("sess-live"), 30), null, "revocation is immediate");
    assert.deepEqual(await store.revokeSession(tokenHash("sess-live"), "logout", audit), { revoked: false }, "logout is idempotent");
    assert.ok((await auditActions(TENANT_A, user.id)).includes("session.logout"));
    await assert.rejects(store.revokeSession(tokenHash("sess-live"), "expired" as SessionRevokeReason, audit), /SESSION_REASON_INVALID/);
    await store.createSession({ userId: user.id, tokenHash: tokenHash("sess-disabled"), absoluteHours: 8, audit: auditAs(user.id) });
    await store.updateUser(user.id, { disabled: true }, audit);
    assert.equal(await store.resolveSession(tokenHash("sess-disabled"), 30), null, "disabling a user ends their sessions");
    const revoked = await asApp<{ revoked_reason: string }>(TENANT_A, "SELECT revoked_reason FROM auth_sessions WHERE token_hash=$1", [tokenHash("sess-disabled")]);
    assert.equal(revoked[0]!.revoked_reason, "disabled");
  });

  test("a password change revokes every session of that user and no one else's", async () => {
    const store = storeFor(TENANT_A);
    const admin = (await store.findLoginUser("admin.one"))!;
    const user = await store.createUser({ username: "change.me", displayName: "Change Me", role: "staff", passwordHash: FAKE_HASH, audit: auditAs(admin.id) });
    const other = await store.createUser({ username: "keep.me", displayName: "Keep Me", role: "staff", passwordHash: FAKE_HASH, audit: auditAs(admin.id) });
    const audit = auditAs(user.id);
    await store.createSession({ userId: user.id, tokenHash: tokenHash("change-1"), absoluteHours: 8, audit });
    await store.createSession({ userId: user.id, tokenHash: tokenHash("change-2"), absoluteHours: 8, audit });
    await store.createSession({ userId: other.id, tokenHash: tokenHash("keep-1"), absoluteHours: 8, audit: auditAs(other.id) });
    assert.deepEqual(await store.changeOwnPassword(user.id, FAKE_REHASH, audit), { revoked: 2 });
    assert.equal(await store.resolveSession(tokenHash("change-1"), 30), null);
    assert.equal(await store.resolveSession(tokenHash("change-2"), 30), null);
    assert.ok(await store.resolveSession(tokenHash("keep-1"), 30), "another user's session is untouched");
    const row = (await asApp<{ must_change_password: boolean; cleared: boolean; password_hash: string }>(TENANT_A,
      "SELECT must_change_password, password_expires_at IS NULL AS cleared, password_hash FROM users WHERE id=$1::uuid", [user.id]))[0]!;
    assert.deepEqual(row, { must_change_password: false, cleared: true, password_hash: FAKE_REHASH });
    assert.deepEqual((await auditActions(TENANT_A, user.id)).filter((action) => action === "password.changed"), ["password.changed"]);
    const reasons = await asApp<{ revoked_reason: string }>(TENANT_A, "SELECT DISTINCT revoked_reason FROM auth_sessions WHERE user_id=$1::uuid", [user.id]);
    assert.deepEqual(reasons, [{ revoked_reason: "password_changed" }]);
  });

  test("the last-admin guard holds when two transactions demote the last two admins at once", async () => {
    const store = storeFor(TENANT_B);
    const first = await store.createUser({ username: "admin.alpha", displayName: "Alpha", role: "admin", passwordHash: FAKE_HASH, temporary: false, audit: auditAs(null) });
    const second = await store.createUser({ username: "admin.beta", displayName: "Beta", role: "admin", passwordHash: FAKE_HASH, temporary: false, audit: auditAs(first.id) });
    assert.equal(await store.countActiveAdmins(), 2);
    const audit = auditAs(first.id);
    const results = await Promise.allSettled([store.updateUser(first.id, { role: "staff" }, audit), store.updateUser(second.id, { disabled: true }, audit)]);
    const refused = results.filter((result) => result.status === "rejected");
    assert.equal(refused.length, 1, `exactly one change may win: ${results.map((result) => result.status).join(",")}`);
    assert.match(String((refused[0] as PromiseRejectedResult).reason), /LAST_ADMIN/);
    assert.equal(await store.countActiveAdmins(), 1, "the tenant is never left without an admin");
    const remaining = (await store.listUsers()).find((user) => user.role === "admin" && user.status !== "disabled")!;
    await assert.rejects(store.updateUser(remaining.id, { disabled: true }, audit), /LAST_ADMIN/, "nor by disabling the survivor");
    await assert.rejects(store.updateUser(remaining.id, { role: "staff" }, audit), /LAST_ADMIN/);
    assert.deepEqual(await store.updateUser(remaining.id, { canExport: true }, audit), { ...remaining, canExport: true }, "an unrelated change is still allowed");
  });

  test("the store sees one tenant only, and an audit row can never point at another tenant's actor", async () => {
    const [a, b] = [storeFor(TENANT_A), storeFor(TENANT_B)];
    const admin = (await a.findLoginUser("admin.one"))!;
    assert.equal(await b.findLoginUser("admin.one"), null, "tenant B does not know tenant A's admin");
    assert.equal(await b.resolveSession(tokenHash("keep-1"), 30), null, "nor its sessions");
    assert.ok(await a.resolveSession(tokenHash("keep-1"), 30));
    assert.ok(!(await b.listUsers()).some((user) => user.username === "admin.one"));
    await a.recordAudit({ actorUserId: admin.id, action: "access.denied", outcome: "denied", detail: { route: "/api/users" } });
    const denied = async (tenantId: string) => (await asApp<{ count: number }>(tenantId, "SELECT count(*)::int AS count FROM audit_events WHERE action='access.denied'"))[0]!.count;
    assert.deepEqual([await denied(TENANT_A), await denied(TENANT_B)], [1, 0]);
    await assert.rejects(b.recordAudit({ actorUserId: admin.id, action: "access.denied", outcome: "denied" }), { code: "23503" }, "the composite FK keeps an actor inside its tenant");
    await assert.rejects(a.recordAudit({ actorUserId: admin.id, action: "AccessDenied" }), /AUDIT_ACTION_INVALID/);
    await assert.rejects(a.recordAudit({ actorUserId: admin.id, action: "access.denied", requestId: "forged-by-the-client" }), /AUDIT_REQUEST_ID_INVALID/);
  });

  test("withTenant opens a read-only transaction that refuses every write", async () => {
    await assert.rejects(withTenant(appPool, TENANT_A,
      (client) => client.query("INSERT INTO audit_events(organization_id, action) VALUES ($1::uuid, 'test.write')", [TENANT_A]),
      { readOnly: true, isolation: "REPEATABLE READ" }), { code: "25006" });
    const rows = await withTenant(appPool, TENANT_A, async (client) => (await client.query<{ count: number }>("SELECT count(*)::int AS count FROM users")).rows,
      { readOnly: true, statementTimeoutMs: 5_000, idleInTransactionTimeoutMs: 5_000 });
    assert.ok(rows[0]!.count > 0, "reading under the tenant still works");
  });
});
