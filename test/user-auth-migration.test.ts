import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const sql = read("../prisma/migrations/0019_user_auth/migration.sql");
// Forbidden-text assertions run against comment-stripped SQL: the header deliberately explains, in prose, that this
// migration defines no SECURITY DEFINER function and that ocr_worker and ocr_queue get nothing.
const statements = sql.replace(/--.*$/gm, "");
const grants = (statements.match(/GRANT[^;]*;/g) ?? []).map((grant) => grant.replace(/\s+/g, " ").trim());
const TABLES = [["users", "user_scope"], ["auth_sessions", "auth_session_scope"], ["audit_events", "audit_scope"]] as const;

test("0019 creates the three auth tables, each tenant-scoped by organization_id and a same-tenant FK", () => {
  for (const [table] of TABLES) {
    assert.match(statements, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`), table);
    assert.match(statements, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?organization_id uuid NOT NULL REFERENCES organizations\\(id\\)`), table);
  }
  assert.match(statements, /UNIQUE \(id, organization_id\)/);
  assert.match(statements, /UNIQUE \(organization_id, username\)/);
  assert.match(statements, /FOREIGN KEY \(user_id, organization_id\) REFERENCES users\(id, organization_id\)/);
  assert.match(statements, /FOREIGN KEY \(actor_user_id, organization_id\) REFERENCES users\(id, organization_id\)/);
  assert.match(statements, /UNIQUE \(organization_id, token_hash\)/);
  // Only the sha256 of the cookie token is stored, and only a self-describing scrypt hash is accepted.
  assert.match(statements, /token_hash bytea NOT NULL CHECK \(octet_length\(token_hash\) = 32\)/);
  assert.match(statements, /password_hash varchar\(200\) NOT NULL CHECK \(password_hash LIKE 'scrypt\$%'\)/);
  assert.match(statements, /username varchar\(32\) NOT NULL CHECK \(username ~ '\^\[a-z0-9\]\[a-z0-9\._-\]\{2,31\}\$'\)/);
  assert.match(statements, /role varchar\(16\) NOT NULL CHECK \(role IN \('admin','staff'\)\)/);
  assert.match(statements, /CHECK \(expires_at > created_at\)/);
});

test("0019 enables and forces row-level security on all three tables with the existing tenant policy text", () => {
  for (const [table, policy] of TABLES) {
    assert.match(statements, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`), table);
    assert.match(statements, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`), table);
    // Identical to 0017's batch_scope: no FOR clause and no WITH CHECK, so USING also guards INSERT and UPDATE,
    // and an unset app.current_org matches nothing.
    assert.match(statements, new RegExp(`DROP POLICY IF EXISTS ${policy} ON ${table};`), policy);
    assert.match(statements, new RegExp(`CREATE POLICY ${policy} ON ${table} USING \\(organization_id::text = current_setting\\('app\\.current_org', true\\)\\);`), policy);
  }
});

test("0019 defines no function, changes no role and stays inside the runner's single transaction", () => {
  assert.doesNotMatch(statements, /\bFUNCTION\b/i, "the queue/outbox functions are owned by ocr_queue_definer in production");
  assert.doesNotMatch(statements, /SECURITY DEFINER/i);
  assert.doesNotMatch(statements, /\bBYPASSRLS\b/i);
  assert.doesNotMatch(statements, /\bALTER\s+(ROLE|DEFAULT PRIVILEGES)\b/i);
  assert.doesNotMatch(statements, /\b(SUPERUSER|DISABLE ROW LEVEL SECURITY|NO FORCE ROW LEVEL SECURITY)\b/i);
  assert.doesNotMatch(statements, /\bocr_queue\b/, "the queue role gets nothing");
  assert.doesNotMatch(statements, /\bocr_worker\b/, "the worker role gets nothing");
  assert.doesNotMatch(statements, /\bDROP\s+(TABLE|COLUMN)\b/i);
  assert.doesNotMatch(statements, /^\s*(BEGIN|COMMIT|ROLLBACK|END)\s*;/im);
  assert.doesNotMatch(statements, /\bCONCURRENTLY\b/i);
});

test("0019 grants exactly four statements: read and append for the web runtime, column-level UPDATE, never DELETE", () => {
  assert.deepEqual(grants, [
    "GRANT SELECT, INSERT ON users, auth_sessions, audit_events TO ocr_app;",
    "GRANT UPDATE (display_name, role, can_export, password_hash, must_change_password, password_expires_at, password_changed_at, failed_logins, locked_until, disabled_at, last_login_at, updated_at) ON users TO ocr_app;",
    "GRANT UPDATE (last_seen_at, revoked_at, revoked_reason) ON auth_sessions TO ocr_app;",
    "GRANT REFERENCES ON users TO ocr_app;"
  ]);
  assert.doesNotMatch(statements, /GRANT\s+(ALL|DELETE|TRUNCATE)/i, "users are disabled, sessions revoked, audit rows append-only");
  assert.doesNotMatch(statements, /\bREVOKE\b/i);
  // Identity, tenant and creation time never change, and audit_events gets no UPDATE grant at all.
  const updates = grants.filter((grant) => grant.startsWith("GRANT UPDATE"));
  assert.equal(updates.length, 2);
  assert.ok(updates.every((grant) => !grant.includes("audit_events")), "audit rows are append-only for ocr_app");
  for (const column of ["id", "organization_id", "username", "created_at", "token_hash", "user_id", "expires_at"]) {
    for (const grant of updates) assert.doesNotMatch(grant, new RegExp(`[(,]\\s*${column}\\s*[,)]`), `${column} must stay immutable: ${grant}`);
  }
});

test("the grant checks of plan A2 exist in verify-db-roles.sh and in verify-release2-grants.sql, naming every role explicitly", () => {
  const script = read("../deploy/verify-db-roles.sh");
  const verify = read("../deploy/sql/verify-release2-grants.sql");
  const checks = ["app:select-users", "app:no-delete-users", "app:no-delete-auth-sessions", "app:no-delete-audit",
    "app:no-update-users-org", "app:no-update-users-username", "app:no-update-audit", "app:no-update-session-identity",
    "worker:no-select-users", "worker:no-select-sessions", "worker:no-select-audit",
    "queue:no-select-users", "queue:no-select-sessions", "queue:no-select-audit",
    "definer:no-users", "definer:no-sessions", "definer:no-audit", "force-rls:release2",
    // 0020 (§9 G1) rides in the same two lists: the batch clock's one column-level UPDATE, and the column beside it
    // that must stay immutable. test/batch-round-migration.test.ts pins the exact SQL of both.
    "app:update-batch-round", "app:no-update-batch-label"];
  const lines = script.split("\n").filter((line) => checks.some((name) => line.startsWith(`check_sql "${name}"`)));
  assert.equal(lines.length, checks.length, "every A2 check is a check_sql line");
  for (const name of checks) assert.ok(verify.includes(`'${name}'`), `verify-release2-grants.sql is missing ${name}`);
  // Explicit role names, not current_user: the same questions run from a bootstrap connection inside the container.
  for (const line of lines) assert.doesNotMatch(line, /current_user/, line);
  assert.match(script, /check_sql "app:no-update-users-org" "\$DATABASE_URL_BOOTSTRAP" "SELECT has_column_privilege\('ocr_app','public\.users','organization_id','UPDATE'\)::int" 0/);
  assert.match(script, /check_sql "app:no-update-audit" "\$DATABASE_URL_BOOTSTRAP" "SELECT has_any_column_privilege\('ocr_app','public\.audit_events','UPDATE'\)::int" 0/);
  // Session identity: the four columns whose UPDATE would let a compromised web process move or extend a session.
  const identity = lines.find((line) => line.startsWith('check_sql "app:no-update-session-identity"'))!;
  for (const column of ["token_hash", "user_id", "expires_at", "organization_id"]) {
    assert.ok(identity.includes(`'${column}'`), `verify-db-roles.sh: session identity column ${column}`);
    assert.ok(verify.includes(`'${column}'`), `verify-release2-grants.sql: session identity column ${column}`);
  }
  // ocr_queue_definer is the one BYPASSRLS role; a grant drifting onto it would expose hashes across tenants.
  for (const [table] of TABLES) {
    assert.match(script, new RegExp(`has_any_column_privilege\\('ocr_queue_definer','public\\.${table}','SELECT'\\)`), table);
    assert.ok(verify.includes(`has_any_column_privilege('ocr_queue_definer','public.${table}','SELECT')`), table);
  }
  const forceRls = "bool_and(relforcerowsecurity) FROM pg_class WHERE relname IN ('users','auth_sessions','audit_events')";
  assert.ok(script.includes(forceRls) && verify.includes(forceRls), "FORCE RLS is machine-checked, not eyeballed");
  assert.match(verify, /'SUMMARY PASS=' \|\| count\(\*\) FILTER \(WHERE ok\)\s*\|\| ' SKIP=' \|\| count\(\*\) FILTER \(WHERE ok IS NULL\)\s*\|\| ' FAIL=' \|\| count\(\*\) FILTER \(WHERE ok IS FALSE\)/);
  assert.match(script, /printf 'SUMMARY PASS=%s SKIP=%s FAIL=%s\\n'/);
});

test("a check whose migration is not applied here skips, so the gate never reads a missing column as a failure", () => {
  // Deploy A is in production at 0019; 0020 ships in Deploy B. has_column_privilege() raises 42703 for a column that
  // does not exist, which aborts the WHOLE SQL statement (no PASS lines, no SUMMARY) and, in the shell, discards to
  // an empty result that check_sql reads as FAIL — taking deploy/go-live-check.sh's exit code with it.
  const script = read("../deploy/verify-db-roles.sh");
  const verify = read("../deploy/sql/verify-release2-grants.sql");
  const guard = "EXISTS (SELECT 1 FROM pg_attribute\n                 WHERE attrelid = to_regclass('public.ocr_batches') AND attname = 'round_opened_at' AND NOT attisdropped)";
  assert.ok(verify.includes(guard), "the SQL file computes the 0020 guard from the catalogue, not from a bare privilege call");
  assert.match(verify, /SELECT 19, 'app:update-batch-round',\s*\n\s*CASE WHEN round_clock THEN has_column_privilege\('ocr_app','public\.ocr_batches','round_opened_at','UPDATE'\) END/);
  assert.match(verify, /SELECT 20, 'app:no-update-batch-label',\s*\n\s*CASE WHEN round_clock THEN NOT has_column_privilege\('ocr_app','public\.ocr_batches','label','UPDATE'\) END/);
  assert.match(verify, /WHEN ok IS NULL THEN 'SKIP '/);
  // The shell passes the same guard as check_sql's fifth argument for exactly the two 0020 checks, and no others.
  assert.ok(script.includes(`round_clock="${guard.replace(/\s+/g, " ")}"`), "verify-db-roles.sh declares the same guard on one line");
  const guarded = script.split("\n").filter((line) => line.startsWith("check_sql ") && line.includes('"$round_clock"'));
  assert.deepEqual(guarded.map((line) => /^check_sql "([^"]+)"/.exec(line)![1]), ["app:update-batch-round", "app:no-update-batch-label"]);
});
