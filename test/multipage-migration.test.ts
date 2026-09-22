import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const sql = read("../prisma/migrations/0018_multipage_documents/migration.sql");
const statements = sql.replace(/--.*$/gm, "");

test("0018 defines no function and redefines no queue/outbox SECURITY DEFINER function", () => {
  assert.doesNotMatch(statements, /\bFUNCTION\b/i, "queue/outbox functions are owned by ocr_queue_definer in production");
  assert.doesNotMatch(statements, /SECURITY DEFINER/i);
  assert.doesNotMatch(statements, /\bocr_queue\b/, "the queue role gets nothing");
  assert.doesNotMatch(statements, /\bDROP\b/i);
  assert.doesNotMatch(statements, /^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im, "runs inside the runner's single transaction");
  assert.doesNotMatch(statements, /\bCONCURRENTLY\b/i);
});

test("0018 grants exactly the worker's INSERT rights (documents, runs, jobs) and no read right on jobs", () => {
  const grants = statements.match(/GRANT[^;]*;/g) ?? [];
  assert.deepEqual(grants, [
    "GRANT INSERT ON documents, document_runs TO ocr_worker;",
    "GRANT INSERT ON extraction_jobs TO ocr_worker;"
  ]);
  assert.doesNotMatch(statements, /GRANT\s+SELECT/i, "the worker's job INSERT has no RETURNING / ON CONFLICT: it needs no SELECT on extraction_jobs");
  assert.doesNotMatch(statements, /GRANT\s+(ALL|UPDATE|DELETE|TRUNCATE)/i);
  assert.doesNotMatch(statements, /\b(BYPASSRLS|SUPERUSER|DISABLE ROW LEVEL SECURITY|NO FORCE ROW LEVEL SECURITY)\b/i);
  assert.doesNotMatch(statements, /\bALTER\s+(ROLE|DEFAULT PRIVILEGES)\b/i);
  assert.doesNotMatch(statements, /\bREVOKE\b/i);
});

test("SPLIT appears only in the ADD VALUE line (a new enum value is unusable inside the adding transaction)", () => {
  const lines = statements.split("\n").filter((line) => line.includes("SPLIT"));
  assert.deepEqual(lines.map((line) => line.trim()), ["ALTER TYPE document_status ADD VALUE IF NOT EXISTS 'SPLIT';"]);
});

test("0018 adds the parent/page columns, a same-tenant composite FK, the page shape CHECK and the partial unique index", () => {
  for (const column of ["parent_document_id uuid", "page_number integer", "page_count integer"]) {
    assert.match(statements, new RegExp(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS ${column};`));
  }
  assert.match(statements, /ADD CONSTRAINT documents_parent_fk\s+FOREIGN KEY \(parent_document_id, organization_id\) REFERENCES documents\(id, organization_id\)/);
  assert.match(statements, /\(parent_document_id IS NULL\) = \(page_number IS NULL\)/);
  assert.match(statements, /page_number IS NULL OR page_number BETWEEN 1 AND 1000/);
  assert.match(statements, /page_count\s+IS NULL OR page_count\s+BETWEEN 1 AND 1000/);
  assert.match(statements, /CREATE UNIQUE INDEX IF NOT EXISTS documents_parent_page_uidx\s+ON documents\(organization_id, parent_document_id, page_number\) WHERE parent_document_id IS NOT NULL;/);
  // Idempotent: constraints are guarded, columns and the index use IF NOT EXISTS.
  assert.equal((statements.match(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint/g) ?? []).length, 2);
});

test("verify-db-roles.sh checks the new worker rights and what the worker still must not do", () => {
  const script = read("../deploy/verify-db-roles.sh");
  for (const [name, table, privilege, expected] of [
    ["worker:insert-documents", "documents", "INSERT", 1], ["worker:insert-extraction-jobs", "extraction_jobs", "INSERT", 1],
    ["worker:no-update-extraction-jobs", "extraction_jobs", "UPDATE", 0], ["worker:no-delete-documents", "documents", "DELETE", 0]
  ] as const) {
    assert.match(script, new RegExp(`check_sql "${name}" "\\$DATABASE_URL_WORKER" "SELECT has_table_privilege\\(current_user,'public\\.${table}','${privilege}'\\)::int" ${expected}`), name);
  }
  assert.match(script, /check_sql "queue:no-table-select" "\$DATABASE_URL_QUEUE"/);
  // has_table_privilege is false when only column grants exist: the column-level check is has_any_column_privilege.
  assert.match(script, /check_sql "worker:no-select-extraction-jobs" "\$DATABASE_URL_WORKER" "SELECT has_any_column_privilege\(current_user,'public\.extraction_jobs','SELECT'\)::int" 0/);
});
