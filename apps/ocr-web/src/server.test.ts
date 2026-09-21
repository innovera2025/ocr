import assert from "node:assert/strict";
import { test } from "node:test";
import { createAppServer } from "./server.js";
import type { Principal } from "@innovera/ocr-auth";

const tenant = "00000000-0000-0000-0000-000000000001";
const documentId = "00000000-0000-0000-0000-000000000002";

function deps(confirmFails = false) {
  const calls: string[] = [];
  const store = {
    saveOcrResult: async () => undefined,
    getReviewDocument: async (tenantId: string, id: string) => tenantId === tenant && id === documentId ? {
      documentId, tenantId, filename: "sample.png", mimeType: "image/png", status: "NEEDS_REVIEW", ocrDocumentId: "ocr-1",
      ocrEngine: "typhoon-crop-only", ocrVersion: "2.2", rawResponse: {}, structuredResult: { therapistName: { raw: "พิพิ", value: "พิพิ", needsReview: true } }, needsReview: true, confirmStatus: null
    } : null,
    saveCorrection: async (_tenantId: string, _id: string, _field: string, _value: string, status: string) => { calls.push(status); }
  };
  const app = createAppServer({
    ingest: { stage: async () => "key", scan: async () => "CLEAN", enqueue: async () => "job" },
    reviewStore: store,
    ocrClient: { confirmResult: async () => { if (confirmFails) throw new Error("network"); return { accepted: true }; } } as never
  }, { authenticate: (request): Principal => {
    if (request.headers.authorization !== "Bearer test-token") throw new Error("UNAUTHENTICATED");
    return { userId, tenantId: tenant, claims: {} };
  } });
  return { app, calls };
}

const userId = "00000000-0000-0000-0000-000000000009";

test("review endpoint enforces tenant and confirm persists before external call", async () => {
  const { app, calls } = deps();
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  const address = app.address();
  assert.equal(typeof address, "object");
  const base = `http://127.0.0.1:${(address as { port: number }).port}`;
  const unauthorized = await fetch(`${base}/api/documents/${documentId}/ocr`);
  assert.equal(unauthorized.status, 401);
  const confirmed = await fetch(`${base}/api/documents/${documentId}/ocr/confirm`, {
    method: "POST", headers: { authorization: "Bearer test-token", "x-tenant-id": "00000000-0000-0000-0000-000000000099", "content-type": "application/json" },
    body: JSON.stringify({ field: "therapistName", raw: "พิพิ", verifiedValue: "พีพี" })
  });
  assert.equal(confirmed.status, 200);
  assert.deepEqual(calls, ["PENDING", "SUCCEEDED"]);
  await new Promise<void>((resolve, reject) => app.close((error) => error ? reject(error) : resolve()));
});

test("confirm keeps correction when OCR confirm is unavailable", async () => {
  const { app, calls } = deps(true);
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  const address = app.address() as { port: number };
  const response = await fetch(`http://127.0.0.1:${address.port}/api/documents/${documentId}/ocr/confirm`, {
    method: "POST", headers: { authorization: "Bearer test-token", "x-tenant-id": tenant, "content-type": "application/json" },
    body: JSON.stringify({ field: "therapistName", raw: "พิพิ", verifiedValue: "พีพี" })
  });
  assert.equal(response.status, 202);
  assert.deepEqual(calls, ["PENDING", "RETRY"]);
  await new Promise<void>((resolve, reject) => app.close((error) => error ? reject(error) : resolve()));
});
