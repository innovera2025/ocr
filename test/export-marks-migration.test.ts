import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const sql = read("../prisma/migrations/0021_document_export_marks/migration.sql");
// Forbidden-text assertions run against comment-stripped SQL: the header explains, in prose, which roles get nothing
// and that the queue/outbox functions are owned by ocr_queue_definer.
const statements = sql.replace(/--.*$/gm, "");
const flat = statements.replace(/\s+/g, " ").trim();
const CHECKS = ["app:select-export-marks", "app:no-update-export-marks", "app:no-delete-export-marks", "worker:no-select-export-marks",
  "queue:no-select-export-marks", "definer:no-export-marks", "force-rls:export-marks"];

test("0021 creates the append-only export history table with exactly the planned columns and CHECKs", () => {
  const body = /CREATE TABLE IF NOT EXISTS document_export_marks \(([\s\S]*?)\n\);/.exec(statements)?.[1];
  assert.ok(body, "one CREATE TABLE IF NOT EXISTS document_export_marks");
  const lines = body.split("\n").map((line) => line.trim().replace(/,$/, "")).filter(Boolean);
  assert.deepEqual(lines, [
    "seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY",
    "organization_id uuid NOT NULL REFERENCES organizations(id)",
    "document_id uuid NOT NULL",
    "kind varchar(8) NOT NULL CHECK (kind IN ('exported','marked','unmarked'))",
    "source varchar(8) NOT NULL CHECK (source IN ('csv','jsonl','manual'))",
    "document_updated_at timestamptz NOT NULL",
    "occurred_at timestamptz NOT NULL DEFAULT now()",
    "actor_user_id uuid NOT NULL",
    "request_id uuid NOT NULL",
    // Same-tenant guarantees, as 0017/0019 do: an event never points at another tenant's document or actor.
    "FOREIGN KEY (document_id, organization_id) REFERENCES documents(id, organization_id)",
    "FOREIGN KEY (actor_user_id, organization_id) REFERENCES users(id, organization_id)",
    // A download is a file format, a manual flip is manual: the two columns can never disagree.
    "CHECK ((kind = 'exported') = (source IN ('csv','jsonl')))"
  ]);
  assert.match(flat, /CREATE INDEX IF NOT EXISTS document_export_marks_doc_idx ON document_export_marks\(organization_id, document_id, seq DESC\);/,
    "the latest-event lookup is one index probe");
});

test("0021 enables and forces row-level security with the existing tenant policy text", () => {
  assert.match(statements, /ALTER TABLE document_export_marks ENABLE ROW LEVEL SECURITY;/);
  assert.match(statements, /ALTER TABLE document_export_marks FORCE ROW LEVEL SECURITY;/);
  assert.match(statements, /DROP POLICY IF EXISTS export_mark_scope ON document_export_marks;/);
  // Identical to batch_scope / audit_scope: no FOR clause and no WITH CHECK, so USING also guards INSERT, and an
  // unset app.current_org matches nothing.
  assert.match(statements, /CREATE POLICY export_mark_scope ON document_export_marks USING \(organization_id::text = current_setting\('app\.current_org', true\)\);/);
  assert.equal((statements.match(/CREATE POLICY/g) ?? []).length, 1);
  assert.doesNotMatch(statements, /\bWITH CHECK\b/i);
  assert.doesNotMatch(statements, /CREATE POLICY[^;]*\bFOR\b/i);
});

test("0021 grants exactly one statement: read and append for the web runtime, nothing updatable or deletable", () => {
  const grants = (statements.match(/GRANT[^;]*;/g) ?? []).map((grant) => grant.replace(/\s+/g, " ").trim());
  assert.deepEqual(grants, ["GRANT SELECT, INSERT ON document_export_marks TO ocr_app;"]);
  assert.doesNotMatch(statements, /GRANT\s+[^;]*\b(ALL|UPDATE|DELETE|TRUNCATE|REFERENCES|USAGE)\b/i);
  assert.doesNotMatch(statements, /\bREVOKE\b/i);
});

test("0021 is idempotent: every statement can run twice", () => {
  const each = flat.split(";").map((statement) => statement.trim()).filter(Boolean);
  for (const statement of each) {
    if (statement.startsWith("CREATE TABLE") || statement.startsWith("CREATE INDEX")) assert.match(statement, /^CREATE (TABLE|INDEX) IF NOT EXISTS /, statement);
    else if (statement.startsWith("CREATE POLICY")) assert.ok(each.indexOf(statement) > each.indexOf("DROP POLICY IF EXISTS export_mark_scope ON document_export_marks"), "the policy is dropped first");
    else assert.match(statement, /^(ALTER TABLE document_export_marks (ENABLE|FORCE) ROW LEVEL SECURITY|DROP POLICY IF EXISTS |GRANT )/, statement);
  }
  assert.equal(each.length, 7, "table, ENABLE, FORCE, drop policy, create policy, index, grant");
});

test("0021 defines no function, changes no role, backfills nothing and stays inside the runner's single transaction", () => {
  assert.doesNotMatch(statements, /\bFUNCTION\b/i, "the queue/outbox functions are owned by ocr_queue_definer in production");
  assert.doesNotMatch(statements, /SECURITY DEFINER/i);
  assert.doesNotMatch(statements, /\bBYPASSRLS\b/i);
  assert.doesNotMatch(statements, /\bALTER\s+(ROLE|DEFAULT PRIVILEGES)\b/i);
  assert.doesNotMatch(statements, /\b(SUPERUSER|DISABLE ROW LEVEL SECURITY|NO FORCE ROW LEVEL SECURITY)\b/i);
  assert.doesNotMatch(statements, /\bDROP\s+(TABLE|COLUMN)\b/i);
  assert.doesNotMatch(statements, /\bUPDATE\s+documents\b/i, "no backfill: FORCE RLS hides every row from the migrator anyway");
  assert.doesNotMatch(statements, /\bINSERT\s+INTO\b/i, "existing documents start as never exported");
  assert.doesNotMatch(statements, /^\s*(BEGIN|COMMIT|ROLLBACK|END)\s*;/im);
  assert.doesNotMatch(statements, /\bCONCURRENTLY\b/i);
  assert.doesNotMatch(statements, /\bocr_worker\b/, "the worker role gets nothing");
  assert.doesNotMatch(statements, /\bocr_queue\w*/, "the queue roles get nothing");
});

test("the seven 0021 grant checks exist in verify-db-roles.sh and in verify-release2-grants.sql, and skip until 0021 is applied", () => {
  const script = read("../deploy/verify-db-roles.sh");
  const verify = read("../deploy/sql/verify-release2-grants.sql");
  const guard = "to_regclass('public.document_export_marks') IS NOT NULL";
  assert.ok(script.includes(`export_marks="${guard}"`), "verify-db-roles.sh declares the guard");
  const lines = script.split("\n").filter((line) => line.startsWith("check_sql ") && line.includes("document_export_marks"));
  assert.deepEqual(lines.map((line) => /^check_sql "([^"]+)"/.exec(line)![1]), CHECKS, "one check_sql line per check, in order");
  for (const line of lines) {
    assert.ok(line.endsWith(' "$export_marks"'), `guarded: ${line}`);
    assert.doesNotMatch(line, /current_user/, "explicit role names: one bootstrap connection answers for every role");
  }
  assert.match(script, /check_sql "app:no-update-export-marks" "\$DATABASE_URL_BOOTSTRAP" "SELECT has_any_column_privilege\('ocr_app','public\.document_export_marks','UPDATE'\)::int" 0 "\$export_marks"/);
  assert.match(script, /check_sql "force-rls:export-marks" "\$DATABASE_URL_BOOTSTRAP" "SELECT relforcerowsecurity FROM pg_class WHERE oid = to_regclass\('public\.document_export_marks'\)" t "\$export_marks"/);
  assert.ok(script.indexOf('check_sql "force-rls:export-marks"') < script.indexOf("printf 'SUMMARY"), "the checks run before the summary");
  assert.ok(verify.includes(`         ${guard}\n), checks`), "the SQL file computes the guard from the catalogue, in the applied CTE");
  assert.match(verify, /WITH applied\(round_clock, export_marks\) AS/);
  CHECKS.forEach((name, index) => {
    assert.match(verify, new RegExp(`SELECT ${21 + index}, '${name}',\\s*\\n\\s*CASE WHEN export_marks THEN `), `verify-release2-grants.sql: ${name} is guarded`);
  });
  for (const role of ["ocr_worker", "ocr_queue", "ocr_queue_definer"]) {
    assert.ok(verify.includes(`NOT has_any_column_privilege('${role}','public.document_export_marks','SELECT')`), role);
    assert.ok(script.includes(`has_any_column_privilege('${role}','public.document_export_marks','SELECT')::int" 0`), role);
  }
});
