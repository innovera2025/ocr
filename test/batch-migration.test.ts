import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const migrations = new URL("../prisma/migrations/", import.meta.url);
const read = (path: string | URL) => readFileSync(path, "utf8");
const sql = read(new URL("0017_batch_processing/migration.sql", migrations));
const statements = sql.replace(/--.*$/gm, "");
const versions = readdirSync(migrations, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();

test("0017 creates ocr_batches with forced tenant RLS and a bounded expected_total", () => {
  assert.match(statements, /CREATE TABLE IF NOT EXISTS ocr_batches \(/);
  assert.match(statements, /organization_id uuid NOT NULL REFERENCES organizations\(id\)/);
  assert.match(statements, /expected_total integer NOT NULL CHECK \(expected_total BETWEEN 1 AND 500\)/);
  assert.match(statements, /UNIQUE \(id, organization_id\)/);
  assert.match(statements, /ALTER TABLE ocr_batches ENABLE ROW LEVEL SECURITY;/);
  assert.match(statements, /ALTER TABLE ocr_batches FORCE ROW LEVEL SECURITY;/);
  assert.match(statements, /CREATE POLICY batch_scope ON ocr_batches USING \(organization_id::text = current_setting\('app\.current_org', true\)\);/);
});

test("0017 links documents to batches within the same tenant and adds review metadata", () => {
  for (const column of ["batch_id uuid", "reviewed_at timestamptz", "reviewed_by varchar\\(255\\)"]) {
    assert.match(statements, new RegExp(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS ${column};`));
  }
  assert.match(statements, /ADD CONSTRAINT documents_batch_fk FOREIGN KEY \(batch_id, organization_id\) REFERENCES ocr_batches\(id, organization_id\)/);
  for (const index of ["documents_org_batch_idx", "documents_org_created_idx", "documents_org_status_idx"]) assert.match(statements, new RegExp(`CREATE INDEX IF NOT EXISTS ${index}`));
});

test("0017 grants are least-privilege: ocr_app may only read and insert batches, the queue role nothing", () => {
  assert.match(statements, /GRANT SELECT, INSERT ON ocr_batches TO ocr_app;/);
  assert.match(statements, /GRANT REFERENCES ON ocr_batches TO ocr_app, ocr_worker;/);
  const grants = statements.match(/GRANT[^;]*;/g) ?? [];
  assert.equal(grants.length, 2);
  assert.doesNotMatch(statements, /\bocr_queue\b/);
  assert.doesNotMatch(statements, /GRANT\s+(ALL|UPDATE|DELETE|TRUNCATE)/i);
  assert.doesNotMatch(statements, /\b(BYPASSRLS|SUPERUSER|DISABLE ROW LEVEL SECURITY|NO FORCE ROW LEVEL SECURITY)\b/i);
  assert.doesNotMatch(statements, /\bALTER\s+(ROLE|DEFAULT PRIVILEGES)\b/i);
});

test("0017 redefines no function and stays inside the runner's single transaction", () => {
  assert.doesNotMatch(statements, /\bFUNCTION\b/i, "queue/outbox functions are owned by ocr_queue_definer in production");
  assert.doesNotMatch(statements, /SECURITY DEFINER/i);
  assert.doesNotMatch(statements, /^\s*(BEGIN|COMMIT|ROLLBACK|END)\s*;/im);
  assert.doesNotMatch(statements, /\bCONCURRENTLY\b/i);
  assert.doesNotMatch(statements, /\bDROP\s+(TABLE|COLUMN|INDEX|FUNCTION)\b/i);
});

test("no migration after 0016 touches a queue or confirm-outbox SECURITY DEFINER function", () => {
  const later = versions.filter((version) => version > "0016");
  assert.ok(later.includes("0017_batch_processing"));
  for (const version of later) {
    const body = read(new URL(`${version}/migration.sql`, migrations)).replace(/--.*$/gm, "");
    assert.doesNotMatch(body, /FUNCTION\s+ocr_(claim|heartbeat|finish|recover)/i, version);
  }
});

test("every table any migration creates has forced row-level security", () => {
  const all = versions.map((version) => read(new URL(`${version}/migration.sql`, migrations))).join("\n");
  const tables = [...all.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)/g)].map((match) => match[1]!);
  assert.ok(tables.includes("ocr_batches"));
  for (const table of tables) assert.match(all, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`), table);
});

test("provisioning moves queue and confirm-outbox functions to ocr_queue_definer", () => {
  const definer = read(new URL("../deploy/sql/queue-definer.sql", import.meta.url));
  const script = read(new URL("../deploy/provision-roles.sh", import.meta.url));
  assert.match(script, /-f "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)\/sql\/queue-definer\.sql"/);
  assert.match(definer, /CREATE ROLE ocr_queue_definer NOLOGIN BYPASSRLS/);
  assert.match(definer, /GRANT SELECT, UPDATE ON extraction_jobs TO ocr_queue_definer;/);
  assert.match(definer, /GRANT SELECT, UPDATE ON ocr_confirm_outbox TO ocr_queue_definer;/);
  const functions = { "ocr_claim_v1(timestamptz)": "ocr_queue", "ocr_heartbeat_v1(uuid,text,timestamptz)": "ocr_worker",
    "ocr_finish_retry_v1(uuid,text,job_status,text,timestamptz)": "ocr_worker", "ocr_recover_expired_v1(timestamptz)": "ocr_worker",
    "ocr_claim_confirm_outbox_v1(text,timestamptz)": "ocr_worker", "ocr_finish_confirm_outbox_v1(uuid,text,boolean,text,timestamptz)": "ocr_worker",
    "ocr_recover_confirm_outbox_v1(timestamptz)": "ocr_worker" };
  for (const [signature, grantee] of Object.entries(functions)) {
    const escaped = signature.replace(/[()]/g, "\\$&");
    assert.match(definer, new RegExp(`ALTER FUNCTION ${escaped} OWNER TO ocr_queue_definer;`));
    assert.match(definer, new RegExp(`REVOKE ALL ON FUNCTION ${escaped} FROM PUBLIC;`));
    assert.match(definer, new RegExp(`GRANT EXECUTE ON FUNCTION ${escaped} TO ${grantee};`));
  }
});
