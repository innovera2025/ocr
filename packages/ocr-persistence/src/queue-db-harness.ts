/**
 * Shared bootstrap of the queue-control PostgreSQL integration tests (`queue-order`, `queue-control`, `queue-reorder`
 * `.db.test.ts`). The same steps as `batch.db.test.ts` (which is left as it is): it runs only against a DISPOSABLE
 * server named by OCR_TEST_DATABASE_URL_BOOTSTRAP, refuses to run when the OCR roles own a non-test database, (re)sets
 * the role passwords to random values (roles are cluster-wide), creates `ocr_it_<random>` owned by ocr_migrator, applies
 * the migrations as ocr_migrator (optionally stopping before one, so a test can seed data the next migration must
 * backfill), applies deploy/sql/queue-definer.sql as superuser and opens one pool per runtime role.
 *
 * Roles are cluster-wide and every DB test file resets their passwords: run DB test files one at a time
 * (`--test-concurrency=1`). Not a test file itself; nothing here runs without the environment variable.
 */
import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { PostgresOcrDocumentStore } from "./index.js";

export const bootstrapUrl = process.env.OCR_TEST_DATABASE_URL_BOOTSTRAP;
export const skipWithoutDatabase: false | string = bootstrapUrl ? false : "set OCR_TEST_DATABASE_URL_BOOTSTRAP to a disposable superuser DSN";
export const repo = new URL("../../../", import.meta.url);
export const ROLES = ["ocr_migrator", "ocr_app", "ocr_worker", "ocr_queue"] as const;
export type Role = typeof ROLES[number];

export type Claimed = { jobId: string; organizationId: string; runId: string; kind: string; leaseToken: string };
/** Structural view of `packages/queue` PostgresQueue (imported by URL: ocr-persistence does not depend on that package). */
export type Queue = {
  enqueue(input: { organizationId: string; runId: string; priority?: number; availableAt?: Date }): Promise<string>;
  claim(now?: Date): Promise<Claimed | null>;
  heartbeat(jobId: string, leaseToken: string, now?: Date): Promise<boolean>;
  finishDetailed(jobId: string, leaseToken: string, outcome: "SUCCEEDED" | "FAILED" | "DEAD", error?: string): Promise<{ accepted: boolean; finalStatus: string | null }>;
  recoverExpired(now?: Date): Promise<number>;
  close(): Promise<void>;
};

export type QueueDb = {
  database: string;
  superDb: Pool; appPool: Pool; workerPool: Pool; queueRolePool: Pool;
  app: PostgresOcrDocumentStore; worker: PostgresOcrDocumentStore;
  /** PostgresQueue as ocr_app (enqueue) and as ocr_queue + ocr_worker (claim / heartbeat / finish / recover). */
  appQueue: Queue; queue: Queue;
  applied: string[];
  roleUrl(role: Role): string;
  /** Applies every migration not applied yet (after a `stopBefore` open), as ocr_migrator. Returns the versions applied now. */
  migrateRest(): Promise<string[]>;
  asApp<T>(tenantId: string | null, sql: string, values?: unknown[]): Promise<T[]>;
  asWorker<T>(tenantId: string | null, sql: string, values?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
};

async function inTransaction<T>(pool: Pool, tenantId: string | null, sql: string, values: unknown[]): Promise<T[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (tenantId) await client.query("SELECT set_config('app.current_org', $1, true)", [tenantId]);
    const result = await client.query(sql, values);
    await client.query("COMMIT");
    return result.rows as T[];
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

/** `stopBefore`: apply the migrations strictly before this version only; `migrateRest()` applies the others later. */
export async function openQueueDb(options: { stopBefore?: string } = {}): Promise<QueueDb> {
  if (!bootstrapUrl) throw new Error("OCR_TEST_DATABASE_URL_BOOTSTRAP is not set");
  const database = `ocr_it_${randomBytes(6).toString("hex")}`;
  const passwords = Object.fromEntries(ROLES.map((role) => [role, randomBytes(24).toString("hex")])) as Record<Role, string>;
  const roleUrl = (role: Role): string => {
    const url = new URL(bootstrapUrl);
    url.username = role; url.password = passwords[role]; url.pathname = `/${database}`;
    return url.toString();
  };
  const admin = new Pool({ connectionString: bootstrapUrl, max: 1 });
  const foreign = await admin.query<{ datname: string }>(
    "SELECT d.datname FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba WHERE r.rolname = ANY($1::text[]) AND d.datname NOT LIKE 'ocr\\_it\\_%'", [ROLES]);
  if (foreign.rows.length > 0) {
    await admin.end();
    throw new Error(`refusing to reset OCR role passwords: server hosts ${foreign.rows.map((row) => row.datname).join(", ")}; use a disposable server`);
  }
  for (const role of ROLES) {
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} LOGIN; END IF; END $$`);
    const statement = await admin.query<{ sql: string }>("SELECT format('ALTER ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT', $1::text, $2::text) AS sql", [role, passwords[role]]);
    await admin.query(statement.rows[0]!.sql);
  }
  await admin.query(`CREATE DATABASE ${database} OWNER ocr_migrator`);
  try { return await provision(); }
  catch (error) {
    // A half-built database is dropped at once rather than left on the disposable server.
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => undefined);
    await admin.end().catch(() => undefined);
    throw error;
  }

  async function provision(): Promise<QueueDb> {
    if (!bootstrapUrl) throw new Error("OCR_TEST_DATABASE_URL_BOOTSTRAP is not set");
    const superUrl = new URL(bootstrapUrl);
    superUrl.pathname = `/${database}`;
    const superDb = new Pool({ connectionString: superUrl.toString(), max: 4 });
    await superDb.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    const migrations = fileURLToPath(new URL("prisma/migrations", repo));
    const runtime = await import(new URL("packages/db-runtime/src/index.ts", repo).href) as { runMigrationsWithPool(pool: Pool, directory: string): Promise<string[]> };
    const migrate = async (directory: string): Promise<string[]> => {
      const migrator = new Pool({ connectionString: roleUrl("ocr_migrator"), max: 1 });
      try { return await runtime.runMigrationsWithPool(migrator, directory); } finally { await migrator.end(); }
    };
    // Fresh database: migration 0002 needs CREATEROLE once (see provision-roles.sh), revoked right after.
    await admin.query("ALTER ROLE ocr_migrator CREATEROLE");
    let applied: string[];
    try {
      if (options.stopBefore) {
        // The runner applies every directory it finds, so a copy holding only the earlier ones stops it there; the files
        // are byte-identical, so their checksums match when migrateRest() reads the real directory.
        const partial = mkdtempSync(join(tmpdir(), "ocr-it-migrations-"));
        try {
          for (const entry of readdirSync(migrations, { withFileTypes: true })) {
            if (entry.isDirectory() && entry.name < options.stopBefore) cpSync(join(migrations, entry.name), join(partial, entry.name), { recursive: true });
          }
          applied = await migrate(partial);
        } finally { rmSync(partial, { recursive: true, force: true }); }
      } else applied = await migrate(migrations);
    } finally { await admin.query("ALTER ROLE ocr_migrator NOCREATEROLE"); }
    await superDb.query(readFileSync(new URL("deploy/sql/queue-definer.sql", repo), "utf8"));
    const appPool = new Pool({ connectionString: roleUrl("ocr_app"), max: 12 });
    const workerPool = new Pool({ connectionString: roleUrl("ocr_worker"), max: 12 });
    const queueRolePool = new Pool({ connectionString: roleUrl("ocr_queue"), max: 2 });
    const queueModule = await import(new URL("packages/queue/src/postgres.ts", repo).href) as { PostgresQueue: new (config: string, workerConfig?: string) => Queue };
    const appQueue = new queueModule.PostgresQueue(roleUrl("ocr_app"));
    const queue = new queueModule.PostgresQueue(roleUrl("ocr_queue"), roleUrl("ocr_worker"));
    const db: QueueDb = {
      database, superDb, appPool, workerPool, queueRolePool, appQueue, queue, applied, roleUrl,
      app: new PostgresOcrDocumentStore(appPool), worker: new PostgresOcrDocumentStore(workerPool),
      migrateRest: async () => { const now = await migrate(migrations); db.applied = [...db.applied, ...now]; return now; },
      asApp: (tenantId, sql, values = []) => inTransaction(appPool, tenantId, sql, values),
      asWorker: (tenantId, sql, values = []) => inTransaction(workerPool, tenantId, sql, values),
      close: async () => {
        await Promise.allSettled([appQueue.close(), queue.close(), appPool.end(), workerPool.end(), queueRolePool.end(), superDb.end()]);
        // pg-pool's end() resolves before client sockets close; FORCE-terminating them would surface as uncaught client errors.
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const open = await admin.query<{ count: number }>("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = $1", [database]);
          if (open.rows[0]?.count === 0) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
        await admin.end();
      }
    };
    return db;
  }
}

/** A storage key in the tenant's original grammar (`org/{tenant}/original/{shard}/{publicId}`); content never exists. */
export function fakeKey(tenantId: string): string { return `org/${tenantId}/original/ab/${randomBytes(16).toString("hex")}`; }

/**
 * A production-shaped tenant (pre-flight 2026-10-19 counts, rounded): 252 batches, of which the oldest 30 are finished and
 * 222 open; 418 split PDFs x 30 pages (12,540 page rows) and 47 images per batch (11,844), so 24,802 documents; every
 * row has a run and a job: 17,608 PENDING, 7,194 SUCCEEDED (incl. the 418 split jobs). Finished history carries
 * processed_at in the last day, reviews and confirmations. Fake values only. Separate statements (fast RI checks).
 */
export async function seedProductionShape(db: QueueDb, tenantId: string): Promise<void> {
  const q = (sql: string) => db.superDb.query(sql, [tenantId]);
  await q("INSERT INTO organizations(id, name) VALUES ($1, 'Production shape')");
  await q(`INSERT INTO ocr_batches(organization_id, created_by, expected_total, created_at)
    SELECT $1, 'seed', 49, now() - interval '20 days' + g * interval '1 hour' FROM generate_series(1, 252) g`);
  // Rank the batches by age: 1..30 finished, 31..252 open; ranks 1..166 carry two PDFs, the rest one.
  await q(`INSERT INTO documents(id, organization_id, public_id, status, filename, mime_type, size_bytes, content_hash, batch_id, page_count, processed_at, created_at)
    SELECT gen_random_uuid(), $1, md5(random()::text || s.id::text || g), 'SPLIT', 'seed.pdf', 'application/pdf', 1, 'h', s.id, 30, now() - interval '1 day', now() - interval '3 days'
    FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS r FROM ocr_batches WHERE organization_id = $1) s CROSS JOIN generate_series(1, 2) g WHERE g = 1 OR s.r <= 166`);
  await q(`INSERT INTO documents(id, organization_id, public_id, status, filename, mime_type, size_bytes, content_hash, batch_id, parent_document_id, page_number, page_count,
                                 processed_at, needs_review, created_at)
    SELECT gen_random_uuid(), $1, md5(random()::text || p.id::text || g),
           CASE WHEN s.r <= 30 OR g <= 5 THEN (CASE WHEN g % 4 = 0 THEN 'NEEDS_REVIEW' ELSE 'SUCCEEDED' END)::document_status ELSE 'CLEAN'::document_status END,
           'seed.pdf', 'image/png', 1, 'h', p.batch_id, p.id, g, 30,
           CASE WHEN s.r <= 30 OR g <= 5 THEN now() - (random() * interval '20 hours') END, g % 4 = 0 AND (s.r <= 30 OR g <= 5), p.created_at
    FROM documents p JOIN (SELECT id, row_number() OVER (ORDER BY created_at, id) AS r FROM ocr_batches WHERE organization_id = $1) s ON s.id = p.batch_id CROSS JOIN generate_series(1, 30) g WHERE p.organization_id = $1 AND p.parent_document_id IS NULL`);
  await q(`INSERT INTO documents(id, organization_id, public_id, status, filename, mime_type, size_bytes, content_hash, batch_id, processed_at, reviewed_at, created_at)
    SELECT gen_random_uuid(), $1, md5(random()::text || s.id::text || 'i' || g),
           CASE WHEN s.r <= 30 OR g <= 8 THEN 'SUCCEEDED'::document_status ELSE 'CLEAN'::document_status END, 'seed.png', 'image/png', 1, 'h', s.id,
           CASE WHEN s.r <= 30 OR g <= 8 THEN now() - (random() * interval '20 hours') END,
           CASE WHEN s.r <= 30 AND g % 3 = 0 THEN now() - interval '1 hour' END, now() - interval '3 days'
    FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS r FROM ocr_batches WHERE organization_id = $1) s CROSS JOIN generate_series(1, 47) g`);
  await q(`INSERT INTO document_runs(id, organization_id, document_id, outcome) SELECT gen_random_uuid(), organization_id, id, 'RUNNING' FROM documents WHERE organization_id = $1`);
  await q(`INSERT INTO extraction_jobs(id, organization_id, run_id, kind, status, priority, available_at, attempts)
    SELECT gen_random_uuid(), r.organization_id, r.id, 'OCR', CASE WHEN d.status = 'CLEAN' THEN 'PENDING'::job_status ELSE 'SUCCEEDED'::job_status END,
           100 + (random() * 100)::int, now() - random() * interval '3 days', CASE WHEN d.status = 'CLEAN' THEN 0 ELSE 1 END
    FROM document_runs r JOIN documents d ON d.id = r.document_id WHERE r.organization_id = $1`);
  await db.superDb.query("ANALYZE");
}
