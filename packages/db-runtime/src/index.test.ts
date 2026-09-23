import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createDatabasePool, runMigrations } from "./index.js";

test("migration runner applies in order and is idempotent", async () => {
  const root = await mkdtemp(join("/tmp", "ocr-migrations-"));
  await mkdir(join(root, "0001_first"));
  await mkdir(join(root, "0002_second"));
  await writeFile(join(root, "0001_first", "migration.sql"), "SELECT 1;");
  await writeFile(join(root, "0002_second", "migration.sql"), "SELECT 2;");
  const applied = new Map<string, string>();
  const calls: string[] = [];
  const db = { query: async <T = unknown>(sql: string, values: readonly unknown[] = []) => {
    calls.push(sql.trim().split("\n", 1)[0]!);
    if (sql.includes("SELECT checksum")) return { rows: (applied.has(String(values[0])) ? [{ checksum: applied.get(String(values[0]))! }] : []) as T[], rowCount: 0 };
    if (sql.startsWith("INSERT INTO schema_migrations")) { applied.set(String(values[0]), String(values[1])); return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  } };
  try {
    assert.equal((await runMigrations({ directory: root, db })).length, 2);
    assert.equal((await runMigrations({ directory: root, db })).length, 0);
    assert.ok(calls.includes("BEGIN"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a pool 'error' is recorded instead of taking the process down", async () => {
  const seen: Error[] = [];
  const pool = createDatabasePool("postgres://user@127.0.0.1:1/none", (error) => { seen.push(error); });
  pool.emit("error", new Error("terminating connection due to administrator command"));
  assert.deepEqual(seen.map((error) => error.message), ["terminating connection due to administrator command"]);
  await pool.end();

  // No callback: the default still writes one structured line, so a restarted backend is not swallowed in silence.
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => { lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")); return true; }) as typeof process.stderr.write;
  const quiet = createDatabasePool("postgres://user@127.0.0.1:1/none");
  try { quiet.emit("error", new Error("connection terminated unexpectedly")); } finally { process.stderr.write = write; }
  await quiet.end();
  assert.deepEqual(lines.map((line) => JSON.parse(line)), [{ event: "db_pool_error", error: "connection terminated unexpectedly" }]);
});
