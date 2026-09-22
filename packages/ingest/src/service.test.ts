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

const upload = { filename: "a.pdf", bytes: new Uint8Array([1]), mimeType: "application/pdf" };

test("a replay resumes an upload whose request died before it was queued (stale, no job)", async () => {
  const calls: string[] = [];
  const deps = (status: string) => ({
    lookupUpload: async () => ({ tenantId: "tenant", documentId: "doc-1", runId: "run-1", status, storageKey: "org/tenant/original/ab/first", stale: true }),
    stage: async () => { calls.push("stage"); return "staged"; },
    scan: async (key: string) => { calls.push(`scan:${key}`); return "CLEAN" as const; },
    enqueue: async () => "never",
    updateStatus: async ({ status: next }: { status: string }) => { calls.push(`status:${next}`); },
    enqueuePersistent: async ({ runId }: { runId: string }) => { calls.push(`enqueue:${runId}`); return "job-1"; }
  });
  const resumed = await ingestDocument(upload, deps("SCANNING"));
  assert.deepEqual(calls, ["scan:org/tenant/original/ab/first", "status:CLEAN", "enqueue:run-1"]);
  assert.deepEqual([resumed.status, resumed.jobId, resumed.documentId], ["CLEAN", "job-1", "doc-1"]);
  calls.length = 0;
  const scannedOnly = await ingestDocument(upload, deps("CLEAN"));
  assert.deepEqual(calls, ["enqueue:run-1"], "already scanned clean: only the missing job is added");
  assert.equal(scannedOnly.jobId, "job-1");
});

test("a replay never duplicates an upload that may still be in flight, and never lies about a quarantine", async () => {
  let touched = false;
  const deps = (status: string, stale: boolean, jobId?: string) => ({
    lookupUpload: async () => ({ tenantId: "tenant", documentId: "doc-1", runId: "run-1", status, storageKey: "k", stale, ...(jobId ? { jobId } : {}) }),
    stage: async () => { touched = true; return "staged"; },
    scan: async () => { touched = true; return "CLEAN" as const; },
    enqueue: async () => { touched = true; return "never"; },
    enqueuePersistent: async () => { touched = true; return "never"; }
  });
  await assert.rejects(() => ingestDocument(upload, deps("SCANNING", false)), /UPLOAD_IN_PROGRESS/);
  assert.deepEqual(await ingestDocument(upload, deps("PROCESSING", true, "job-0")).then((r) => [r.status, r.jobId]), ["CLEAN", "job-0"]);
  assert.deepEqual(await ingestDocument(upload, deps("QUARANTINED", true)).then((r) => [r.status, r.jobId]), ["QUARANTINED", ""]);
  assert.equal(touched, false);
});

test("staged bytes that no document references are discarded", async () => {
  for (const failure of ["BATCH_FULL", "BATCH_NOT_FOUND", "IDEMPOTENCY_CONFLICT"]) {
    const discarded: string[] = [];
    await assert.rejects(() => ingestDocument(upload, {
      stage: async () => "org/t/original/ab/orphan", scan: async () => "CLEAN", enqueue: async () => "never",
      persistUpload: async () => { throw new Error(failure); },
      discard: async (key) => { discarded.push(key); }
    }), new RegExp(failure));
    assert.deepEqual(discarded, ["org/t/original/ab/orphan"], failure);
  }
  const discarded: string[] = [];
  await ingestDocument(upload, {
    stage: async () => "org/t/original/ab/loser", scan: async () => "CLEAN", enqueue: async () => "never",
    persistUpload: async () => ({ tenantId: "t", documentId: "winner", runId: "r", reused: true }),
    discard: async (key) => { discarded.push(key); throw new Error("disk gone"); }
  });
  assert.deepEqual(discarded, ["org/t/original/ab/loser"], "a failing discard never fails the upload");
});

test("concurrent replays of one stale upload resume it once: the replay that loses the claim is UPLOAD_IN_PROGRESS", async () => {
  const calls: string[] = [];
  let claimed = false;
  const deps = {
    lookupUpload: async () => ({ tenantId: "tenant", documentId: "doc-1", runId: "run-1", status: "SCANNING", storageKey: "org/tenant/original/ab/first", stale: true }),
    claimResume: async ({ documentId }: { documentId: string }) => { calls.push(`claim:${documentId}`); const won = !claimed; claimed = true; return won; },
    stage: async () => { calls.push("stage"); return "staged"; },
    scan: async (key: string) => { calls.push(`scan:${key}`); await new Promise((resolveScan) => setTimeout(resolveScan, 10)); return "CLEAN" as const; },
    enqueue: async () => "never",
    updateStatus: async ({ status }: { status: string }) => { calls.push(`status:${status}`); },
    enqueuePersistent: async ({ runId }: { runId: string }) => { calls.push(`enqueue:${runId}`); return "job-1"; }
  };
  const [first, second] = await Promise.allSettled([ingestDocument(upload, deps), ingestDocument(upload, deps)]);
  assert.equal(first.status === "fulfilled" && first.value.jobId, "job-1");
  assert.ok(second.status === "rejected" && /UPLOAD_IN_PROGRESS/.test(String(second.reason)));
  assert.deepEqual(calls.filter((call) => !call.startsWith("claim:")), ["scan:org/tenant/original/ab/first", "status:CLEAN", "enqueue:run-1"], "one scan, one job");
});

test("a persistence error of unknown outcome keeps the staged original (the row may have been committed)", async () => {
  const discarded: string[] = [];
  await assert.rejects(() => ingestDocument(upload, {
    stage: async () => "org/t/original/ab/maybe-committed", scan: async () => "CLEAN", enqueue: async () => "never",
    persistUpload: async () => { throw new Error("Connection terminated unexpectedly"); },
    discard: async (key) => { discarded.push(key); }
  }), /Connection terminated/);
  assert.deepEqual(discarded, []);
});

test("the queue priority chosen at persistence reaches enqueuePersistent and never leaks into the result", async () => {
  const enqueued: unknown[] = [];
  const result = await ingestDocument(upload, {
    stage: async () => "staged", scan: async () => "CLEAN" as const, enqueue: async () => "never",
    persistUpload: async () => ({ tenantId: "t", documentId: "d", runId: "r", priority: 103 }),
    updateStatus: async () => undefined,
    enqueuePersistent: async (input) => { enqueued.push(input); return "job-1"; }
  });
  assert.deepEqual(enqueued, [{ tenantId: "t", documentId: "d", runId: "r", stagedKey: "staged", priority: 103 }]);
  assert.equal("priority" in result, false);
  const plain: unknown[] = [];
  await ingestDocument(upload, { stage: async () => "staged", scan: async () => "CLEAN" as const, enqueue: async () => "never",
    persistUpload: async () => ({ tenantId: "t", documentId: "d", runId: "r" }), updateStatus: async () => undefined,
    enqueuePersistent: async (input) => { plain.push(input); return "job-2"; } });
  assert.deepEqual(plain, [{ tenantId: "t", documentId: "d", runId: "r", stagedKey: "staged" }], "no priority: the column default (100)");
});
