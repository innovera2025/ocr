import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool, type PoolClient, type PoolConfig } from "pg";

export type MigrationQuery = <T = unknown>(text: string, values?: readonly unknown[]) => Promise<{ rows: T[]; rowCount: number | null }>;
export type MigrationClient = Readonly<{ query: MigrationQuery }>;

export type MigrationRunnerOptions = Readonly<{
  directory: string;
  db: MigrationClient;
}>;

export async function migrationVersions(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory() && /^\d+_[a-z0-9_]+$/.test(entry.name)).map((entry) => entry.name).sort();
}

export async function runMigrations(options: MigrationRunnerOptions): Promise<string[]> {
  await options.db.query("SELECT pg_advisory_lock(hashtext('innovera_ocr:migrations'))");
  try {
    await options.db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version varchar(120) PRIMARY KEY,
      checksum varchar(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied: string[] = [];
    for (const version of await migrationVersions(options.directory)) {
      const sql = await readFile(join(options.directory, version, "migration.sql"), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = await options.db.query<{ checksum: string }>("SELECT checksum FROM schema_migrations WHERE version = $1", [version]);
      if (existing.rows.length > 0) {
        if (existing.rows[0]!.checksum !== checksum) throw new Error(`MIGRATION_CHECKSUM_MISMATCH:${version}`);
        continue;
      }
      const transactional = options.db as MigrationClient & { query: MigrationQuery };
      await transactional.query("BEGIN");
      try {
        await transactional.query(sql);
        await transactional.query("INSERT INTO schema_migrations(version, checksum) VALUES ($1, $2)", [version, checksum]);
        await transactional.query("COMMIT");
        applied.push(version);
      } catch (error) {
        await transactional.query("ROLLBACK").catch(() => undefined);
        throw new Error(`MIGRATION_FAILED:${version}`, { cause: error });
      }
    }
    return applied;
  } finally {
    await options.db.query("SELECT pg_advisory_unlock(hashtext('innovera_ocr:migrations'))").catch(() => undefined);
  }
}

/**
 * A pool that cannot take the process down (plan §10 H4, D10). When the backend behind an IDLE pooled client dies —
 * a restart, an admin `pg_terminate_backend`, or `idle_in_transaction_session_timeout` firing on a stalled export —
 * node-postgres emits `'error'` on the pool, and an unhandled `'error'` event is a fatal exception in Node: the web
 * would exit mid-upload and reset every in-memory login throttle. pg discards the broken client itself, so `onError`
 * only gets to record it — and when no caller supplies one the default still writes a structured line, because a pool
 * error that is swallowed silently leaves the operator with nothing in `docker logs` while requests fail.
 */
export function createDatabasePool(config: PoolConfig | string = process.env.DATABASE_URL ?? "", onError?: (error: Error) => void): Pool {
  if (!config || (typeof config === "string" && config.length === 0)) throw new Error("DATABASE_URL_REQUIRED");
  const pool = new Pool(typeof config === "string" ? { connectionString: config } : config);
  const report = onError ?? ((error: Error) => {
    // No DSN, no credentials: the message pg produces here names the failure, never the connection string.
    process.stderr.write(`${JSON.stringify({ event: "db_pool_error", error: error.message.slice(0, 200) })}\n`);
  });
  pool.on("error", (error: unknown) => { report(error instanceof Error ? error : new Error(String(error))); });
  return pool;
}

export async function assertDatabaseReady(pool: Pool): Promise<void> {
  await pool.query("SELECT 1");
}

export async function runMigrationsWithPool(pool: Pool, directory: string): Promise<string[]> {
  const client: PoolClient = await pool.connect();
  try { return await runMigrations({ directory, db: client }); }
  finally { client.release(); }
}
