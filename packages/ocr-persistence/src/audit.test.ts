import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import { auditDetailJson, AuditRateLimiter, insertAudit } from "./audit.js";

const TENANT = "11111111-2222-3333-4444-555555555555";
const ACTOR = "22222222-3333-4444-5555-666666666666";
const SESSION = "33333333-4444-5555-6666-777777777777";
const TRACE = "44444444-5555-6666-7777-888888888888";

function fakeClient(): { client: PoolClient; values: () => unknown[] } {
  const calls: unknown[][] = [];
  const client = { query: async (_sql: string, values: unknown[]) => { calls.push(values); return { rows: [], rowCount: 1 }; } };
  return { client: client as unknown as PoolClient, values: () => calls[0] ?? [] };
}

test("insertAudit writes the row the caller described, defaulting the outcome and the detail", async () => {
  const { client, values } = fakeClient();
  await insertAudit(client, { tenantId: TENANT, actorUserId: ACTOR, sessionId: SESSION, requestId: TRACE, action: "user.created",
    targetType: "user", targetId: ACTOR, detail: { role: "staff", can_export: false } });
  assert.deepEqual(values(), [TENANT, ACTOR, SESSION, "user.created", "success", "user", ACTOR, TRACE, '{"role":"staff","can_export":false}']);
});

test("insertAudit accepts the CLI bootstrap with no actor, no session and no trace id", async () => {
  const { client, values } = fakeClient();
  await insertAudit(client, { tenantId: TENANT, actorUserId: null, action: "user.bootstrap", detail: { via: "cli" } });
  assert.deepEqual(values(), [TENANT, null, null, "user.bootstrap", "success", null, null, null, '{"via":"cli"}']);
});

test("insertAudit rejects an action that is not area.verb, and ids that are not UUIDs", async () => {
  const { client } = fakeClient();
  const event = { tenantId: TENANT, actorUserId: ACTOR, action: "login.succeeded" } as const;
  for (const action of ["login", "Login.ok", "login.", "login.ok!", `a.${"b".repeat(48)}`]) {
    await assert.rejects(insertAudit(client, { ...event, action }), /AUDIT_ACTION_INVALID/, action);
  }
  await assert.rejects(insertAudit(client, { ...event, tenantId: "not-a-uuid" }), /AUDIT_EVENT_INVALID/);
  await assert.rejects(insertAudit(client, { ...event, actorUserId: "0" }), /AUDIT_EVENT_INVALID/);
  await assert.rejects(insertAudit(client, { ...event, sessionId: "0" }), /AUDIT_EVENT_INVALID/);
  await assert.rejects(insertAudit(client, { ...event, targetId: "0" }), /AUDIT_EVENT_INVALID/);
  await assert.rejects(insertAudit(client, { ...event, outcome: "ok" as "success" }), /AUDIT_EVENT_INVALID/);
  await assert.rejects(insertAudit(client, { ...event, targetType: "session" as "user" }), /AUDIT_EVENT_INVALID/);
});

test("insertAudit refuses a request id that is not the server's trace id", async () => {
  const { client } = fakeClient();
  // `requestId()` echoes the client's X-Request-Id when it matches [A-Za-z0-9._:-]{1,128}, so only a UUID is trusted here.
  for (const requestId of ["req-from-the-client", "", "44444444-5555-6666-7777-888888888888 "]) {
    await assert.rejects(insertAudit(client, { tenantId: TENANT, actorUserId: ACTOR, action: "login.succeeded", requestId }), /AUDIT_REQUEST_ID_INVALID/);
  }
});

test("an audit detail is a flat object of scalars, under 4 KiB, with no key that sounds like a credential", () => {
  assert.equal(auditDetailJson(undefined), "{}");
  assert.equal(auditDetailJson({ rows: 12, complete: true, reason: "locked", note: null }), '{"rows":12,"complete":true,"reason":"locked","note":null}');
  for (const detail of [{ nested: { a: 1 } as unknown as string }, { list: [1] as unknown as number }, { Upper: "x" }, { "": "x" }, { count: Number.NaN }]) {
    assert.throws(() => auditDetailJson(detail), /AUDIT_DETAIL_INVALID/, JSON.stringify(detail));
  }
  for (const key of ["password", "temp_password", "csrf_token", "cookie", "secret_key", "authorization"]) {
    assert.throws(() => auditDetailJson({ [key]: "x" }), /AUDIT_DETAIL_INVALID/, key);
  }
  assert.throws(() => auditDetailJson({ note: "x".repeat(4100) }), /AUDIT_DETAIL_TOO_LARGE/);
});

test("AuditRateLimiter spends a budget per key per window and cannot grow past its key cap", () => {
  const limiter = new AuditRateLimiter(5, 60_000, 3);
  const start = 1_000_000;
  for (let attempt = 0; attempt < 5; attempt += 1) assert.equal(limiter.allow("session-a", start + attempt), true, `attempt ${attempt}`);
  assert.equal(limiter.allow("session-a", start + 5), false, "the sixth denial in the window is suppressed");
  assert.equal(limiter.allow("session-b", start + 5), true, "another session keeps its own budget");
  assert.equal(limiter.allow("session-a", start + 60_001), true, "the window slides");
  for (const key of ["c", "d", "e"]) limiter.allow(key, start);
  assert.ok(limiter.size <= 3, `bounded keys: ${limiter.size}`);
});
