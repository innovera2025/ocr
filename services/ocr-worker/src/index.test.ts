import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { OcrClient, OcrClientError, type OcrResponse } from "@innovera/ocr-client";
import { metrics } from "@innovera/ocr-observability";
import type { OcrResultPatch } from "@innovera/ocr-persistence";
import { createLocalStorage } from "@innovera/ocr-storage/local";
import { confirmSender, isOcrUnavailable, processOcrJob, runMaintenanceOnce, runWorkerOnce, startWorkerLoops, workerConcurrency, type FinishOutcome, type FinishResult } from "./index.js";

const organizationId = "00000000-0000-0000-0000-000000000001";
const documentId = "00000000-0000-0000-0000-000000000002";
const sourceKey = `org/${organizationId}/original/ab/abcdefghijklmnopqrstuvwx12345678`;
const field = (value: string | null, needsReview = false) => ({ raw: value, value, confidence: needsReview ? 0.4 : 0.97, source: "ocr", needsReview });
const fullDocument = (needsReview: boolean): OcrResponse => ({
  documentId: "ocr-v3", sourceFile: "a.png", engine: "typhoon-sections", version: "3.0", schemaVersion: 3,
  layout: { template: "makkha-intake-v1", imageWidth: 805, imageHeight: 569, warnings: [] },
  customerInformation: { name: field("Anna"), gender: field("Female"), nationality: field("Thai"), hotelName: field(null), referralSources: [], healthConditions: [{ ...field("Menstruation"), checked: true }] },
  recommendationCard: { pressure: field("Standard"), massageOilScrub: [], preferredAreas: [], avoidAreas: [] },
  staffOnly: {
    treatments: [{ ...field("ไทย 90 นาที", needsReview), value: "นวดไทย", nameRaw: "ไทย", duration: "90 นาที", durationMinutes: 90 }],
    treatment: { raw: "ไทย 90 นาที", durations: ["90 นาที"], items: [], needsReview: false },
    therapistName: field("พีพี"), roomNo: field("12")
  },
  evidence: { staffCropRaw: "ไทย 90 นาที พีพี 12", checkboxScores: { "gender.female": 0.31 } },
  timings: { preprocessMs: 12, inferenceMs: 2900, inferenceWallMs: 1600, totalMs: 1650, sections: [{ name: "staffOnly", ms: 1500 }] },
  needsReview
});

type Harness = ReturnType<typeof harness>;
function harness(options: { process?: () => Promise<OcrResponse>; finalStatus?: FinishResult["finalStatus"]; accepted?: boolean; heartbeatMs?: number; documentMissing?: boolean; documentError?: Error; jobs?: number } = {}) {
  const calls: string[] = [];
  const saved: OcrResultPatch[] = [];
  let heartbeats = 0;
  let remaining = options.jobs ?? 1;
  const queue = {
    claim: async () => {
      if (remaining <= 0) return null;
      remaining -= 1;
      return { jobId: `job-${remaining}`, organizationId, runId: "00000000-0000-0000-0000-000000000003", kind: "OCR", leaseToken: "lease" };
    },
    heartbeat: async () => { heartbeats += 1; return true; },
    finishDetailed: async (_jobId: string, _lease: string, outcome: FinishOutcome, error?: string): Promise<FinishResult> => {
      calls.push(`finish:${outcome}${error ? `:${error}` : ""}`);
      return { accepted: options.accepted ?? true, finalStatus: outcome === "FAILED" ? options.finalStatus ?? "PENDING" : outcome };
    }
  };
  const store = {
    getWorkerDocument: async () => {
      if (options.documentError) throw options.documentError;
      return options.documentMissing ? null : { documentId, organizationId, sourceKey, filename: "a.png", mimeType: "image/png" };
    },
    markProcessing: async () => { calls.push("markProcessing"); },
    markFailure: async (_tenant: string, _id: string, message: string) => { calls.push(`markFailure:${message}`); },
    markRetrying: async (_tenant: string, _id: string, message: string) => { calls.push(`markRetrying:${message}`); },
    markRunFailure: async (_tenant: string, runId: string, message: string) => { calls.push(`markRunFailure:${runId}:${message}`); return true; },
    saveOcrResult: async (tenant: string, _id: string, patch: OcrResultPatch) => { assert.equal(tenant, organizationId); saved.push(patch); calls.push("saveOcrResult"); },
    saveCorrection: async () => undefined
  };
  const dependencies = {
    queue, store,
    storage: { get: async () => new Uint8Array([137, 80, 78, 71]), put: async () => undefined },
    ocrClient: { processDocument: options.process ?? (async () => fullDocument(true)) },
    ...(options.heartbeatMs ? { heartbeatMs: options.heartbeatMs } : {})
  };
  return { calls, saved, dependencies, heartbeats: () => heartbeats };
}
const run = (h: Harness) => runWorkerOnce(h.dependencies);
const delay = (ms: number) => new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms));

test("worker loads storage, calls OCR, and saves needsReview result", async () => {
  const root = await mkdtemp(join("/tmp", "ocr-worker-"));
  try {
    const storage = createLocalStorage(root);
    await storage.put(sourceKey, new Uint8Array([137, 80, 78, 71]));
    let savedTenant = "";
    const result = await processOcrJob({ schemaVersion: 1, documentId, organizationId, sourceKey }, {
      storage,
      ocrClient: { processDocument: async () => ({ documentId: "ocr-1", staffOnly: { therapistName: { needsReview: true } } }) },
      documentStore: { saveOcrResult: async (tenant) => { savedTenant = tenant; }, saveCorrection: async () => undefined }
    });
    assert.equal(result.status, "NEEDS_REVIEW");
    assert.equal(savedTenant, organizationId);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("full-document result is stored canonically and marked NEEDS_REVIEW", async () => {
  const h = harness();
  assert.equal(await run(h), true);
  assert.deepEqual(h.calls, ["markProcessing", "saveOcrResult", "finish:SUCCEEDED"]);
  const patch = h.saved[0]!;
  assert.equal(patch.needsReview, true);
  assert.equal(patch.ocrDocumentId, "ocr-v3");
  assert.equal(patch.engine, "typhoon-sections");
  assert.equal(patch.version, "3.0");
  const view = patch.structuredResult as Record<string, Record<string, unknown>>;
  assert.equal(view.schemaVersion, 3);
  assert.equal("evidence" in view, false);
  assert.equal("timings" in view, false);
  assert.equal(Array.isArray(view.staffOnly?.treatments), true);
  assert.equal((view.customerInformation?.name as { value?: string }).value, "Anna");
  assert.deepEqual((patch.rawResponse as { timings?: { inferenceMs?: number } }).timings?.inferenceMs, 2900);
  assert.match(metrics.snapshot(), /ocr_inference_ms_sum \d+/);
  assert.match(metrics.snapshot(), /document_processing_ms_sum \d+/);
  assert.match(metrics.snapshot(), /documents_processed_total\{status="NEEDS_REVIEW"\} \d+/);
});

test("review flags are judged on the canonical view, not on evidence", async () => {
  const response = fullDocument(false);
  const h = harness({ process: async () => ({ ...response, evidence: { note: { needsReview: true } } }) });
  await run(h);
  assert.equal(h.saved[0]!.needsReview, false);
  assert.deepEqual(h.calls.at(-1), "finish:SUCCEEDED");
});

test("a top-level Local AI needsReview (layout warning) is never downgraded to SUCCEEDED", async () => {
  const response = fullDocument(false);
  const h = harness({ process: async () => ({ ...response, layout: { ...response.layout, warnings: ["aspect mismatch"] }, needsReview: true }) });
  await run(h);
  assert.equal(h.saved[0]!.needsReview, true);
});

test("non-retryable OCR client error finishes the job DEAD and marks the document failed", async () => {
  const h = harness({ process: async () => { throw new OcrClientError("http", "OCR API returned HTTP 422", { status: 422, retryable: false }); } });
  await run(h);
  assert.deepEqual(h.calls, ["markProcessing", "finish:DEAD:OCR API returned HTTP 422", "markFailure:OCR API returned HTTP 422"]);
});

test("malformed OCR response is retried, not DEAD", async () => {
  const h = harness({ process: async () => { throw new OcrClientError("malformed", "OCR API returned invalid JSON"); } });
  await run(h);
  assert.deepEqual(h.calls, ["markProcessing", "finish:FAILED:OCR API returned invalid JSON", "markRetrying:OCR API returned invalid JSON"]);
});

test("retryable failure with attempts left marks the document retrying", async () => {
  const h = harness({ finalStatus: "PENDING", process: async () => { throw new OcrClientError("http", "OCR API returned HTTP 503", { status: 503, retryable: true }); } });
  await run(h);
  assert.deepEqual(h.calls, ["markProcessing", "finish:FAILED:OCR API returned HTTP 503", "markRetrying:OCR API returned HTTP 503"]);
});

test("final failed attempt marks the document failed", async () => {
  const h = harness({ finalStatus: "DEAD", process: async () => { throw new Error("socket hang up"); } });
  await run(h);
  assert.deepEqual(h.calls, ["markProcessing", "finish:FAILED:socket hang up", "markFailure:socket hang up"]);
});

test("lost lease leaves the document untouched", async () => {
  const h = harness({ accepted: false, process: async () => { throw new Error("socket hang up"); } });
  await run(h);
  assert.deepEqual(h.calls, ["markProcessing", "finish:FAILED:socket hang up"]);
});

test("missing document finishes the job DEAD; its run's row (if any) is marked failed instead of staying queued", async () => {
  const h = harness({ documentMissing: true });
  await run(h);
  assert.deepEqual(h.calls, ["finish:DEAD:DOCUMENT_NOT_FOUND", "markRunFailure:00000000-0000-0000-0000-000000000003:DOCUMENT_NOT_FOUND"]);
});

test("a document that cannot be loaded on the last attempt is marked failed by run, never left CLEAN", async () => {
  const retrying = harness({ documentError: new Error("connection reset"), finalStatus: "PENDING" });
  await run(retrying);
  assert.deepEqual(retrying.calls, ["finish:FAILED:connection reset"], "attempts left: the queue retries, the row stays queued");
  const dead = harness({ documentError: new Error("connection reset"), finalStatus: "DEAD" });
  await run(dead);
  assert.deepEqual(dead.calls, ["finish:FAILED:connection reset", "markRunFailure:00000000-0000-0000-0000-000000000003:connection reset"]);
});

test("empty queue reports idle", async () => {
  assert.equal(await run(harness({ jobs: 0 })), false);
});

test("heartbeat runs during OCR and its timer is cleared on success and on failure", async () => {
  for (const fails of [false, true]) {
    const h = harness({ heartbeatMs: 5, process: async () => { await delay(40); if (fails) throw new Error("boom"); return fullDocument(false); } });
    await run(h);
    const afterRun = h.heartbeats();
    assert.ok(afterRun >= 1, `heartbeat should fire while OCR runs (fails=${String(fails)})`);
    await delay(40);
    assert.equal(h.heartbeats(), afterRun, `heartbeat interval must be cleared (fails=${String(fails)})`);
  }
});

test("OCR_WORKER_CONCURRENCY is clamped to 1..8 with default 2", () => {
  assert.equal(workerConcurrency(undefined), 2);
  assert.equal(workerConcurrency(""), 2);
  assert.equal(workerConcurrency("abc"), 2);
  assert.equal(workerConcurrency("2.5"), 2);
  assert.equal(workerConcurrency("0"), 1);
  assert.equal(workerConcurrency("-4"), 1);
  assert.equal(workerConcurrency("3"), 3);
  assert.equal(workerConcurrency("64"), 8);
});

test("outbox sender maps therapistName to the provider's therapist field", async () => {
  const sent: unknown[] = [];
  const send = confirmSender({ confirmResult: async (payload) => { sent.push(payload); return {}; } });
  await send({ documentId: "ocr-1", field: "therapistName", raw: "พิพิ", verifiedValue: "พีพี" });
  await send({ documentId: "ocr-1", field: "treatment", raw: "ไทย", verifiedValue: "นวดไทย" });
  assert.deepEqual(sent, [
    { documentId: "ocr-1", field: "therapist", raw: "พิพิ", verifiedValue: "พีพี" },
    { documentId: "ocr-1", field: "treatment", raw: "ไทย", verifiedValue: "นวดไทย" }
  ]);
});

test("maintenance drains at most 10 outbox items and still runs after a recovery error", async () => {
  let dispatched = 0;
  let outboxRecovered = false;
  const dependencies = {
    queue: { recoverExpired: async (): Promise<number> => { throw new Error("recover failed"); } },
    outbox: { recoverExpired: async () => { outboxRecovered = true; return 0; }, dispatchOnce: async () => { dispatched += 1; return { claimed: true, delivered: true }; } },
    sendConfirmation: async () => undefined
  };
  await assert.rejects(() => runMaintenanceOnce(dependencies), /recover failed/);
  assert.equal(outboxRecovered, true);
  assert.equal(dispatched, 10);
});

test("job loops run concurrently, survive thrown errors, and stop gracefully", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  let claimFailures = 0;
  let maintenanceTicks = 0;
  const h = harness({ jobs: 4, process: async () => { inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight); await delay(20); inFlight -= 1; return fullDocument(false); } });
  const claim = h.dependencies.queue.claim;
  const loops = startWorkerLoops({
    ...h.dependencies,
    queue: { ...h.dependencies.queue, claim: async () => { if (claimFailures < 2) { claimFailures += 1; throw new Error("db unavailable"); } return claim(); }, recoverExpired: async () => { maintenanceTicks += 1; if (maintenanceTicks === 1) throw new Error("recover failed"); return 0; } },
    outbox: { recoverExpired: async () => 0, dispatchOnce: async () => ({ claimed: false, delivered: false }) },
    sendConfirmation: async () => undefined
  }, { concurrency: 2, idleMs: 5, maintenanceMs: 5, maxBackoffMs: 10 });
  assert.equal(loops.concurrency, 2);
  const deadline = Date.now() + 2000;
  while ((h.saved.length < 4 || maintenanceTicks < 3) && Date.now() < deadline) await delay(5);
  await loops.stop();
  assert.equal(claimFailures, 2);
  assert.equal(h.saved.length, 4);
  assert.equal(maxInFlight, 2);
  assert.ok(maintenanceTicks >= 3, "maintenance loop keeps running after an error");
  assert.match(metrics.snapshot(), /worker_loop_errors_total\{loop="maintenance"\} \d+/);
});

test("transport failures are the ones that pause claiming", () => {
  assert.equal(isOcrUnavailable(new OcrClientError("network", "down", { retryable: true })), true);
  assert.equal(isOcrUnavailable(new OcrClientError("timeout", "slow", { retryable: true })), true);
  assert.equal(isOcrUnavailable(new OcrClientError("http", "HTTP 503", { status: 503, retryable: true })), true);
  assert.equal(isOcrUnavailable(new OcrClientError("http", "HTTP 422", { status: 422, retryable: false })), false);
  assert.equal(isOcrUnavailable(new OcrClientError("malformed", "bad json")), false);
  assert.equal(isOcrUnavailable(new Error("DOCUMENT_NOT_FOUND")), false);
});

/** In-memory queue with the SQL semantics of ocr_claim_v1 / ocr_finish_retry_v1: attempts+1 per claim, FAILED → PENDING after
 * `retryDelayMs` while attempts < 3, then DEAD. */
function attemptQueue(jobs: number, retryDelayMs: number) {
  const rows = Array.from({ length: jobs }, (_, index) => ({ jobId: `job-${index}`, status: "PENDING", attempts: 0, availableAt: 0 }));
  return {
    rows,
    claim: async () => {
      const row = rows.find((candidate) => candidate.status === "PENDING" && candidate.availableAt <= Date.now());
      if (!row) return null;
      row.status = "RUNNING"; row.attempts += 1;
      return { jobId: row.jobId, organizationId, runId: "00000000-0000-0000-0000-000000000003", kind: "OCR", leaseToken: "lease" };
    },
    heartbeat: async () => true,
    finishDetailed: async (jobId: string, _lease: string, outcome: FinishOutcome): Promise<FinishResult> => {
      const row = rows.find((candidate) => candidate.jobId === jobId)!;
      if (outcome === "FAILED" && row.attempts < 3) { row.status = "PENDING"; row.availableAt = Date.now() + retryDelayMs; return { accepted: true, finalStatus: "PENDING" }; }
      row.status = outcome === "FAILED" ? "DEAD" : outcome;
      return { accepted: true, finalStatus: row.status as FinishResult["finalStatus"] };
    },
    recoverExpired: async () => 0
  };
}

test("an OCR API outage pauses every job loop instead of burning the batch's attempts, and work resumes afterwards", async () => {
  let up = false;
  let ocrCalls = 0;
  let probes = 0;
  const queue = attemptQueue(40, 5);
  const h = harness();
  const loops = startWorkerLoops({
    ...h.dependencies, queue,
    ocrClient: {
      processDocument: async () => { ocrCalls += 1; if (!up) throw new OcrClientError("network", "OCR API request failed", { retryable: true }); return fullDocument(false); },
      healthCheck: async () => { probes += 1; return up; }
    },
    outbox: { recoverExpired: async () => 0, dispatchOnce: async () => ({ claimed: false, delivered: false }) },
    sendConfirmation: async () => undefined
  }, { concurrency: 2, idleMs: 5, maintenanceMs: 5, maxBackoffMs: 40 });
  try {
    await delay(400); // ~80 idle periods of outage
    assert.equal(queue.rows.filter((row) => row.status === "DEAD").length, 0, "no job may die while the OCR API is down");
    assert.ok(ocrCalls <= 2, `only the jobs in flight when the outage began hit the API (got ${ocrCalls})`);
    assert.ok(queue.rows.reduce((sum, row) => sum + row.attempts, 0) <= 2);
    assert.ok(probes >= 3, "the loops keep probing GET /health");
    assert.match(metrics.snapshot(), /ocr_health_probe_failed_total \d+/, "failed probes are counted, never silent");
    up = true;
    const deadline = Date.now() + 3000;
    while (queue.rows.some((row) => row.status !== "SUCCEEDED") && Date.now() < deadline) await delay(5);
    assert.deepEqual(new Set(queue.rows.map((row) => row.status)), new Set(["SUCCEEDED"]));
  } finally { await loops.stop(); }
});

test("an OCR API that answers /health but fails every request loses at most one attempt per backoff window", async () => {
  const queue = attemptQueue(20, 1);
  const h = harness();
  const loops = startWorkerLoops({
    ...h.dependencies, queue,
    ocrClient: { processDocument: async () => { throw new OcrClientError("http", "OCR API returned HTTP 500", { status: 500, retryable: true }); }, healthCheck: async () => true },
    outbox: { recoverExpired: async () => 0, dispatchOnce: async () => ({ claimed: false, delivered: false }) },
    sendConfirmation: async () => undefined
  }, { concurrency: 2, idleMs: 10, maintenanceMs: 5, maxBackoffMs: 80 });
  try {
    await delay(500);
    const attempts = queue.rows.reduce((sum, row) => sum + row.attempts, 0);
    assert.ok(attempts <= 12, `backoff 10·2^n ms (≤ 80) allows only a handful of trials in 500 ms (got ${attempts})`);
    assert.equal(queue.rows.filter((row) => row.status === "DEAD").length <= 4, true);
  } finally { await loops.stop(); }
});

test("stale master data (/health degraded, OCR still answering) never stalls the job loops after a transient failure", async () => {
  let ocrFetches = 0;
  let healthFetches = 0;
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const ocrClient = new OcrClient({ baseUrl: "https://ocr.example/ocr", timeoutMs: 1000, maxRetries: 3, fetchImpl: async (input) => {
    if (String(input).endsWith("/health")) { healthFetches += 1; return json({ status: "degraded", masterData: "stale: Expecting ',' delimiter" }); }
    ocrFetches += 1;
    if (ocrFetches <= 8) throw new TypeError("fetch failed"); // both in-flight jobs exhaust their 4 attempts
    return json(fullDocument(false));
  } });
  const queue = attemptQueue(10, 1);
  const h = harness();
  const loops = startWorkerLoops({
    ...h.dependencies, queue, ocrClient,
    outbox: { recoverExpired: async () => 0, dispatchOnce: async () => ({ claimed: false, delivered: false }) },
    sendConfirmation: async () => undefined
  }, { concurrency: 2, idleMs: 5, maintenanceMs: 5, maxBackoffMs: 40 });
  try {
    const deadline = Date.now() + 3000;
    while (queue.rows.some((row) => row.status !== "SUCCEEDED") && Date.now() < deadline) await delay(5);
    assert.deepEqual(new Set(queue.rows.map((row) => row.status)), new Set(["SUCCEEDED"]));
    assert.ok(healthFetches >= 1, "the half-open trial probed /health");
  } finally { await loops.stop(); }
});
