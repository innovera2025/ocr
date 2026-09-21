import test from "node:test";
import assert from "node:assert/strict";
import { ingestDocument } from "./index.js";

test("ingest stages and enqueues only after a clean scan", async () => {
  const calls: string[] = [];
  const deps = {
    stage: async () => { calls.push("stage"); return "org/o/original/a/doc"; },
    scan: async () => { calls.push("scan"); return "CLEAN" as const; },
    enqueue: async () => { calls.push("enqueue"); return "job-1"; }
  };
  const result = await ingestDocument({ filename: "a.pdf", bytes: new Uint8Array([1]), mimeType: "application/pdf" }, deps);
  assert.deepEqual(calls, ["stage", "scan", "enqueue"]);
  assert.equal(result.jobId, "job-1");
});

test("quarantined uploads never enqueue", async () => {
  let enqueued = false;
  const result = await ingestDocument({ filename: "a.pdf", bytes: new Uint8Array([1]), mimeType: "application/pdf" }, {
    stage: async () => "staged",
    scan: async () => "QUARANTINED",
    enqueue: async () => { enqueued = true; return "never"; }
  });
  assert.equal(result.status, "QUARANTINED");
  assert.equal(enqueued, false);
});

test("scan transport failure marks persisted document failed", async () => {
  const statuses: string[] = [];
  await assert.rejects(() => ingestDocument({ filename: "a.pdf", bytes: new Uint8Array([1]), mimeType: "application/pdf" }, {
    stage: async () => "staged",
    scan: async () => { throw new Error("clamd unavailable"); },
    enqueue: async () => "never",
    persistUpload: async () => ({ tenantId: "tenant", documentId: "document", runId: "run" }),
    updateStatus: async ({ status }) => { statuses.push(status); }
  }));
  assert.deepEqual(statuses, ["FAILED"]);
});

test("idempotency reuse does not scan or enqueue a second job", async () => {
  const calls: string[] = [];
  const result = await ingestDocument({ filename: "a.pdf", bytes: new Uint8Array([1]), mimeType: "application/pdf" }, {
    lookupUpload: async () => null,
    stage: async () => { calls.push("stage"); return "staged"; },
    persistUpload: async () => ({ tenantId: "tenant", documentId: "doc-1", runId: "run-1", reused: true }),
    scan: async () => { calls.push("scan"); return "CLEAN" as const; },
    enqueue: async () => { calls.push("enqueue"); return "job"; }
  });
  assert.equal("documentId" in result ? result.documentId : undefined, "doc-1");
  assert.deepEqual(calls, ["stage"]);
});
