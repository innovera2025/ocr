import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const path = new URL("../prisma/migrations/0022_queue_control/migration.sql", import.meta.url);
const sql = existsSync(path) ? readFileSync(path, "utf8") : "";
// Forbidden-text checks run on the whole file (comments included) AND on the statements: a migration that merely talks
// about the queue routines in prose is still a smell here.
const statements = sql.replace(/--.*$/gm, "");
const flat = statements.replace(/\s+/g, " ").trim();

test("0022 exists and is additive: no routine, no DROP, nothing about the claim routine", () => {
  assert.ok(existsSync(path), "prisma/migrations/0022_queue_control/migration.sql");
  assert.doesNotMatch(sql, /FUNCTION/i);
  assert.doesNotMatch(sql, /\bDROP\b/i);
  assert.doesNotMatch(sql, /ocr_claim/i);
  assert.doesNotMatch(statements, /\bREVOKE\b|\bTRUNCATE\b|\bDELETE\b/i);
});

test("0022 grants exactly D16", () => {
  const grants = (statements.match(/GRANT[^;]*;/g) ?? []).map((grant) => grant.replace(/\s+/g, " ").trim());
  assert.deepEqual(grants, [
    "GRANT SELECT ON queue_control TO ocr_app, ocr_worker;",
    "GRANT UPDATE (stopped_at, stopped_by, round_cap, round_no, round_started_at, round_done, updated_at, updated_by) ON queue_control TO ocr_app;",
    "GRANT UPDATE (round_done) ON queue_control TO ocr_worker;",
    "GRANT USAGE ON SEQUENCE ocr_batch_queue_seq TO ocr_app;",
    "GRANT SELECT (id, organization_id, queue_seq) ON ocr_batches TO ocr_worker;"
  ]);
  assert.doesNotMatch(flat, /\bocr_queue\b(?!_)/, "the queue role gets nothing");
});

test("0022 creates the sequence, the batch column (nullable, defaulted), the unique index and the single control row", () => {
  assert.match(flat, /CREATE SEQUENCE IF NOT EXISTS ocr_batch_queue_seq;/);
  assert.match(flat, /ALTER TABLE ocr_batches ADD COLUMN IF NOT EXISTS queue_seq integer;/);
  assert.match(flat, /ALTER TABLE ocr_batches ALTER COLUMN queue_seq SET DEFAULT nextval\('ocr_batch_queue_seq'\);/);
  assert.doesNotMatch(flat, /queue_seq integer NOT NULL/, "the column stays nullable");
  assert.match(flat, /CREATE UNIQUE INDEX IF NOT EXISTS ocr_batches_queue_seq_idx ON ocr_batches\(queue_seq\);/);
  assert.match(flat, /CREATE TABLE IF NOT EXISTS queue_control \( id boolean PRIMARY KEY DEFAULT true CHECK \(id\),/);
  assert.match(flat, /round_cap integer CHECK \(round_cap IS NULL OR round_cap BETWEEN 1 AND 100000\)/);
  assert.match(flat, /round_done integer NOT NULL DEFAULT 0 CHECK \(round_done >= 0\)/);
  assert.match(flat, /INSERT INTO queue_control\(id\) VALUES \(true\) ON CONFLICT DO NOTHING;/);
  assert.doesNotMatch(flat, /queue_control (ENABLE|FORCE) ROW LEVEL SECURITY/, "D2: no RLS on the control row");
});

test("0022 lifts FORCE on ocr_batches only around the backfill and restores it in the same file", () => {
  const off = flat.indexOf("ALTER TABLE ocr_batches NO FORCE ROW LEVEL SECURITY;");
  const update = flat.indexOf("UPDATE ocr_batches b SET queue_seq");
  const on = flat.indexOf("ALTER TABLE ocr_batches FORCE ROW LEVEL SECURITY;");
  assert.ok(off >= 0 && update > off && on > update, "NO FORCE → UPDATE → FORCE");
  assert.equal((flat.match(/NO FORCE ROW LEVEL SECURITY/g) ?? []).length, 1);
  assert.match(flat, /WHERE x\.queue_seq IS NULL/, "a re-run touches nothing already numbered");
  assert.match(flat, /ORDER BY x\.created_at, x\.id/, "oldest first by (created_at, id)");
});
