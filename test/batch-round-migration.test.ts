import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const sql = read("../prisma/migrations/0020_batch_round_clock/migration.sql");
// Forbidden-text assertions run against comment-stripped SQL: the header explains, in prose, that the queue/outbox
// functions are owned by ocr_queue_definer and which role already holds the UPDATE the worker needs.
const statements = sql.replace(/--.*$/gm, "");

test("0020 adds exactly the two round-clock columns, both additive and both nullable", () => {
  const columns = statements.match(/ALTER TABLE \w+ ADD COLUMN IF NOT EXISTS [^;]*;/g) ?? [];
  assert.deepEqual(columns.map((line) => line.replace(/\s+/g, " ").trim()), [
    "ALTER TABLE documents ADD COLUMN IF NOT EXISTS processing_started_at timestamptz;",
    "ALTER TABLE ocr_batches ADD COLUMN IF NOT EXISTS round_opened_at timestamptz;"
  ]);
  // No NOT NULL and no DEFAULT: an existing row keeps a null round, which is what "the first round keeps createdAt" means.
  assert.doesNotMatch(statements, /\bNOT NULL\b/i);
  assert.doesNotMatch(statements, /\bDEFAULT\b/i);
  assert.doesNotMatch(statements, /\bUPDATE\s+(documents|ocr_batches)\b/i, "no backfill: FORCE RLS hides every row from the migrator anyway");
});

test("0020 grants one column-level UPDATE and nothing else: the label and the capacity stay immutable", () => {
  const grants = (statements.match(/GRANT[^;]*;/g) ?? []).map((grant) => grant.replace(/\s+/g, " ").trim());
  assert.deepEqual(grants, ["GRANT UPDATE (round_opened_at) ON ocr_batches TO ocr_app;"]);
  assert.doesNotMatch(statements, /GRANT\s+(ALL|DELETE|TRUNCATE|SELECT|INSERT)/i);
  assert.doesNotMatch(statements, /\bREVOKE\b/i);
  for (const column of ["label", "expected_total", "organization_id", "created_at"]) {
    assert.doesNotMatch(grants[0]!, new RegExp(`[(,]\\s*${column}\\s*[,)]`), `${column} must stay immutable for ocr_app`);
  }
});

test("0020 defines no function, changes no role and stays inside the runner's single transaction", () => {
  assert.doesNotMatch(statements, /\bFUNCTION\b/i, "the queue/outbox functions are owned by ocr_queue_definer in production");
  assert.doesNotMatch(statements, /SECURITY DEFINER/i);
  assert.doesNotMatch(statements, /\bBYPASSRLS\b/i);
  assert.doesNotMatch(statements, /\bALTER\s+(ROLE|DEFAULT PRIVILEGES)\b/i);
  assert.doesNotMatch(statements, /\b(SUPERUSER|DISABLE ROW LEVEL SECURITY|NO FORCE ROW LEVEL SECURITY)\b/i);
  assert.doesNotMatch(statements, /\bocr_queue\b/, "the queue role gets nothing");
  assert.doesNotMatch(statements, /\bocr_worker\b/, "the worker already has table-level UPDATE on documents (0009)");
  assert.doesNotMatch(statements, /\bDROP\s+(TABLE|COLUMN)\b/i);
  assert.doesNotMatch(statements, /^\s*(BEGIN|COMMIT|ROLLBACK|END)\s*;/im);
  assert.doesNotMatch(statements, /\bCONCURRENTLY\b/i);
});

test("the two 0020 grant checks exist in verify-db-roles.sh and in verify-release2-grants.sql", () => {
  const script = read("../deploy/verify-db-roles.sh");
  const verify = read("../deploy/sql/verify-release2-grants.sql");
  assert.match(script, /check_sql "app:update-batch-round" "\$DATABASE_URL_BOOTSTRAP" "SELECT has_column_privilege\('ocr_app','public\.ocr_batches','round_opened_at','UPDATE'\)::int" 1/);
  assert.match(script, /check_sql "app:no-update-batch-label" "\$DATABASE_URL_BOOTSTRAP" "SELECT has_column_privilege\('ocr_app','public\.ocr_batches','label','UPDATE'\)::int" 0/);
  assert.ok(verify.includes("has_column_privilege('ocr_app','public.ocr_batches','round_opened_at','UPDATE')"), "verify-release2-grants.sql checks the granted column");
  assert.ok(verify.includes("has_column_privilege('ocr_app','public.ocr_batches','label','UPDATE')"), "verify-release2-grants.sql checks the column that stays immutable");
});
