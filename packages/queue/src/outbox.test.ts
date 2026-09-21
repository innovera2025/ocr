import { test } from "node:test";
import assert from "node:assert/strict";
import { PostgresConfirmOutbox } from "./outbox.js";

test("outbox dispatcher claims, sends, and fences success", async () => {
  const calls: string[] = [];
  const db = { query: async (sql: string) => {
    calls.push(sql);
    if (sql.includes("ocr_claim_confirm")) return { rows: [{ outbox_id: "id-1", payload: { field: "therapist" } }] };
    return { rows: [{ ocr_finish_confirm_outbox_v1: true }] };
  } };
  const dispatcher = new PostgresConfirmOutbox(db, "worker-1");
  const result = await dispatcher.dispatchOnce(async (payload) => assert.equal(payload.field, "therapist"));
  assert.deepEqual(result, { claimed: true, delivered: true });
  assert.equal(calls.length, 2);
});

test("outbox dispatcher keeps retry state when sender fails", async () => {
  let finishSql = "";
  const db = { query: async (sql: string) => {
    if (sql.includes("ocr_claim_confirm")) return { rows: [{ outbox_id: "id-2", payload: {} }] };
    finishSql = sql;
    return { rows: [] };
  } };
  const dispatcher = new PostgresConfirmOutbox(db, "worker-2");
  const result = await dispatcher.dispatchOnce(async () => { throw new Error("HTTP_500"); });
  assert.deepEqual(result, { claimed: true, delivered: false });
  assert.match(finishSql, /false/);
});
