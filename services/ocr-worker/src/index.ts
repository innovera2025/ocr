import { limits } from "@innovera/ocr-config";
import { OcrClient, OcrClientError, readOcrTimings, type OcrResponse } from "@innovera/ocr-client";
import { hasReviewFields, toStructuredResult, type DocumentStore, type WorkerDocument } from "@innovera/ocr-persistence";
import type { LocalStorage } from "@innovera/ocr-storage/local";
import { PostgresQueue, type ClaimedJob, type FinishOutcome, type FinishResult } from "@innovera/ocr-queue/postgres";
import { PostgresConfirmOutbox, type ConfirmSender, type OutboxDispatchResult } from "@innovera/ocr-queue/outbox";
import { assertDatabaseReady, createDatabasePool } from "@innovera/ocr-db-runtime";
import { PostgresOcrDocumentStore } from "@innovera/ocr-persistence";
import { createLocalStorage } from "@innovera/ocr-storage/local";
import { logEvent, metrics } from "@innovera/ocr-observability";

export type ExtractionPayloadV1 = Readonly<{
  schemaVersion: 1;
  documentId: string;
  organizationId: string;
  sourceKey: string;
  filename?: string;
  mimeType?: string;
}>;

export type WorkerResult = Readonly<{ status: "disabled"; reason: "ocr-runtime-not-installed" }>;

export type OcrJobResult = Readonly<{ status: "SUCCEEDED" | "NEEDS_REVIEW"; ocrDocumentId: string }>;

export type { FinishOutcome, FinishResult };
/** Structural view of PostgresQueue used by the job loops (fakes in tests). */
export type WorkerQueue = Readonly<{
  claim(): Promise<ClaimedJob | null>;
  heartbeat(jobId: string, leaseToken: string): Promise<boolean>;
  finishDetailed(jobId: string, leaseToken: string, outcome: FinishOutcome, error?: string): Promise<FinishResult>;
}>;
/** Structural view of PostgresOcrDocumentStore used by the job loops. */
export type WorkerStore = DocumentStore & Readonly<{
  getWorkerDocument(runId: string, tenantId: string): Promise<WorkerDocument | null>;
  markProcessing(tenantId: string, documentId: string): Promise<void>;
  markFailure(tenantId: string, documentId: string, message: string): Promise<void>;
  markRetrying(tenantId: string, documentId: string, message: string): Promise<void>;
}>;
export type WorkerOutbox = Readonly<{ recoverExpired(): Promise<number>; dispatchOnce(sender: ConfirmSender): Promise<OutboxDispatchResult> }>;
export type WorkerDependencies = Readonly<{ queue: WorkerQueue; store: WorkerStore; storage: LocalStorage; ocrClient: Pick<OcrClient, "processDocument">; heartbeatMs?: number }>;
export type MaintenanceDependencies = Readonly<{ queue: Readonly<{ recoverExpired(): Promise<number> }>; outbox: WorkerOutbox; sendConfirmation: ConfirmSender }>;
export type WorkerLoopOptions = Readonly<{ concurrency?: number; idleMs?: number; maintenanceMs?: number; maxBackoffMs?: number; outboxBatch?: number }>;
export type WorkerLoops = Readonly<{ concurrency: number; done: Promise<void>; stop(): Promise<void> }>;

const HEARTBEAT_MS = 30_000;
const STOP_TIMEOUT_MS = 8_000; // below Docker's default 10 s stop grace, so pools close before SIGKILL

export function validatePayload(payload: ExtractionPayloadV1): void {
  if (payload.schemaVersion !== 1 || !payload.documentId || !payload.organizationId || !payload.sourceKey) {
    throw new Error("INVALID_EXTRACTION_PAYLOAD");
  }
  // C1 identity-addressed grammar: org/{organizationId}/original/{shard}/{publicId}.
  const prefix = `org/${payload.organizationId}/original/`;
  if (!payload.sourceKey.startsWith(prefix)) {
    throw new Error("INVALID_TENANT_STORAGE_KEY");
  }
}

export function runDeterministicOcr(_payload: ExtractionPayloadV1): WorkerResult {
  // M1 keeps provider/model installation out of the scaffold; callers must not mistake this for OCR.
  void limits.pageOcrTimeoutSeconds;
  return { status: "disabled", reason: "ocr-runtime-not-installed" };
}

/** OCR_WORKER_CONCURRENCY: integer job loops, clamped to 1..8; anything else → 2. */
export function workerConcurrency(value: string | undefined = process.env.OCR_WORKER_CONCURRENCY): number {
  const parsed = value === undefined || value.trim() === "" ? Number.NaN : Number(value);
  return Number.isInteger(parsed) ? Math.min(8, Math.max(1, parsed)) : 2;
}

function errorText(error: unknown, fallback: string): string {
  return (error instanceof Error && error.message ? error.message : fallback).slice(0, 1000);
}

export async function processOcrJob(
  payload: ExtractionPayloadV1,
  dependencies: Readonly<{ storage: LocalStorage; ocrClient: Pick<OcrClient, "processDocument">; documentStore: DocumentStore }>
): Promise<OcrJobResult> {
  validatePayload(payload);
  const file = await dependencies.storage.get(payload.sourceKey);
  const startedAt = Date.now();
  let result: OcrResponse;
  try {
    result = await dependencies.ocrClient.processDocument(file, payload.filename ?? payload.documentId, payload.mimeType ?? "application/octet-stream");
    metrics.increment("ocr_requests_total", { status: "success" });
  } catch (error) {
    metrics.increment("ocr_requests_total", { status: "error" });
    throw error;
  } finally {
    metrics.increment("ocr_latency_ms_sum", {}, Date.now() - startedAt);
  }
  const ocrMs = Date.now() - startedAt;
  // Canonical view only (no evidence/timings); the full response, incl. timings, stays in raw_response.
  const structuredResult = toStructuredResult(result);
  // The Local AI's top-level flag also covers document-level doubts (e.g. layout warnings) that no single field carries.
  const needsReview = hasReviewFields(structuredResult) || result.needsReview === true;
  await dependencies.documentStore.saveOcrResult(payload.organizationId, payload.documentId, {
    ocrDocumentId: result.documentId, rawResponse: result, structuredResult, needsReview,
    ...(typeof result.engine === "string" ? { engine: result.engine } : {}),
    ...(typeof result.version === "string" ? { version: result.version } : {})
  });
  const status = needsReview ? "NEEDS_REVIEW" : "SUCCEEDED";
  const timings = readOcrTimings(result);
  if (timings.inferenceMs !== undefined) metrics.increment("ocr_inference_ms_sum", {}, timings.inferenceMs);
  logEvent("ocr_completed", { document_id: payload.documentId, tenant_id: payload.organizationId, status, ocr_ms: ocrMs, inference_ms: timings.inferenceMs, inference_wall_ms: timings.inferenceWallMs, engine_total_ms: timings.totalMs });
  return { status, ocrDocumentId: result.documentId };
}

async function failJob(dependencies: WorkerDependencies, claimed: ClaimedJob, document: WorkerDocument | null, error: unknown, startedAt: number, forceDead = false): Promise<void> {
  const message = errorText(error, "OCR_WORKER_FAILED");
  // A non-retryable 4xx from the OCR API (bad input) will not heal on retry. "malformed" stays retryable:
  // a body cut off mid-stream surfaces the same way.
  const outcome: FinishOutcome = forceDead || (error instanceof OcrClientError && error.code === "http" && !error.retryable) ? "DEAD" : "FAILED";
  metrics.increment("jobs_failed");
  const finished = await dependencies.queue.finishDetailed(claimed.jobId, claimed.leaseToken, outcome, message);
  const fields = { job_id: claimed.jobId, tenant_id: claimed.organizationId, document_id: document?.documentId, error: message.slice(0, 200) };
  if (!finished.accepted) {
    // Another worker owns the job now (lease expired and recovered); leave the document to it.
    metrics.increment("jobs_lease_lost");
    logEvent("job_lease_lost", { ...fields, status: outcome });
    return;
  }
  const retrying = finished.finalStatus === "PENDING";
  if (document) {
    try {
      if (retrying) await dependencies.store.markRetrying(document.organizationId, document.documentId, message);
      else await dependencies.store.markFailure(document.organizationId, document.documentId, message);
    } catch (storeError) {
      metrics.increment("worker_store_errors_total");
      logEvent("document_status_update_failed", { ...fields, store_error: errorText(storeError, "STORE_FAILED").slice(0, 200) });
    }
  }
  const durationMs = Date.now() - startedAt;
  metrics.increment("document_processing_ms_sum", {}, durationMs);
  metrics.increment("documents_processed_total", { status: retrying ? "RETRYING" : "FAILED" });
  logEvent(retrying ? "job_retrying" : "job_failed", { ...fields, status: finished.finalStatus ?? outcome, duration_ms: durationMs });
}

export async function runWorkerOnce(dependencies: WorkerDependencies): Promise<boolean> {
  const { queue, store } = dependencies;
  const claimed = await queue.claim();
  if (!claimed) return false;
  const startedAt = Date.now();
  metrics.increment("jobs_processing");
  logEvent("job_claimed", { job_id: claimed.jobId, tenant_id: claimed.organizationId, status: "PROCESSING" });
  let document: WorkerDocument | null;
  try {
    document = await store.getWorkerDocument(claimed.runId, claimed.organizationId);
  } catch (error) {
    await failJob(dependencies, claimed, null, error, startedAt);
    return true;
  }
  if (!document) {
    await failJob(dependencies, claimed, null, new Error("DOCUMENT_NOT_FOUND"), startedAt, true);
    return true;
  }
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let result: OcrJobResult;
  try {
    await store.markProcessing(document.organizationId, document.documentId);
    heartbeatTimer = setInterval(() => {
      void queue.heartbeat(claimed.jobId, claimed.leaseToken).catch(() => undefined);
    }, dependencies.heartbeatMs ?? HEARTBEAT_MS);
    result = await processOcrJob(
      { schemaVersion: 1, documentId: document.documentId, organizationId: document.organizationId, sourceKey: document.sourceKey, filename: document.filename, mimeType: document.mimeType },
      { storage: dependencies.storage, ocrClient: dependencies.ocrClient, documentStore: store }
    );
  } catch (error) {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    await failJob(dependencies, claimed, document, error, startedAt);
    return true;
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }
  // Outside the catch: a failing SUCCEEDED finish must not turn a saved result into FAILED/RETRYING.
  const finished = await queue.finishDetailed(claimed.jobId, claimed.leaseToken, "SUCCEEDED");
  const durationMs = Date.now() - startedAt;
  metrics.increment("document_processing_ms_sum", {}, durationMs);
  metrics.increment("documents_processed_total", { status: result.status });
  const fields = { job_id: claimed.jobId, tenant_id: document.organizationId, document_id: document.documentId, status: result.status, duration_ms: durationMs };
  if (!finished.accepted) {
    metrics.increment("jobs_lease_lost");
    logEvent("job_lease_lost", fields);
    return true;
  }
  metrics.increment("jobs_completed");
  logEvent("job_completed", fields);
  return true;
}

/** Keeps the therapistName → therapist provider mapping for legacy outbox rows. */
export function confirmSender(ocrClient: Pick<OcrClient, "confirmResult">): ConfirmSender {
  return async (payload) => {
    const field = String(payload.field);
    await ocrClient.confirmResult({
      documentId: String(payload.documentId), field: field === "therapistName" ? "therapist" : field, raw: String(payload.raw ?? ""), verifiedValue: String(payload.verifiedValue ?? "")
    });
  };
}

/** One maintenance tick: every step runs even if an earlier one fails; the first error is rethrown for backoff. */
export async function runMaintenanceOnce(dependencies: MaintenanceDependencies, outboxBatch = 10): Promise<void> {
  const errors: unknown[] = [];
  const attempt = async (step: () => Promise<void>) => { try { await step(); } catch (error) { errors.push(error); } };
  await attempt(async () => {
    const recovered = await dependencies.queue.recoverExpired();
    if (recovered > 0) { metrics.increment("jobs_recovered_total", {}, recovered); logEvent("jobs_recovered", { count: recovered }); }
  });
  await attempt(async () => { await dependencies.outbox.recoverExpired(); });
  await attempt(async () => {
    for (let sent = 0; sent < outboxBatch; sent += 1) {
      const dispatched = await dependencies.outbox.dispatchOnce(dependencies.sendConfirmation);
      if (!dispatched.claimed) break;
      metrics.increment("outbox_dispatch_total", { status: dispatched.delivered ? "delivered" : "failed" });
    }
  });
  if (errors.length > 0) throw errors[0];
}

type LoopControl = { stopped: boolean; sleep(ms: number): Promise<void>; stop(): void };

function createLoopControl(): LoopControl {
  const sleepers = new Set<() => void>();
  const control: LoopControl = {
    stopped: false,
    sleep: (ms) => new Promise<void>((resolveSleep) => {
      if (control.stopped) return resolveSleep();
      const wake = () => { clearTimeout(timer); sleepers.delete(wake); resolveSleep(); };
      const timer = setTimeout(wake, ms);
      sleepers.add(wake);
    }),
    stop: () => { control.stopped = true; for (const wake of [...sleepers]) wake(); }
  };
  return control;
}

/** Never lets an exception escape: errors are logged and the loop backs off exponentially (idleMs · 2^n, capped). */
async function runLoop(name: string, tick: () => Promise<boolean>, control: LoopControl, idleMs: number, maxBackoffMs: number): Promise<void> {
  let failures = 0;
  while (!control.stopped) {
    let delay: number;
    try {
      delay = (await tick()) ? 0 : idleMs;
      failures = 0;
    } catch (error) {
      failures += 1;
      delay = Math.min(maxBackoffMs, idleMs * 2 ** Math.min(failures - 1, 10));
      metrics.increment("worker_loop_errors_total", { loop: name });
      logEvent("worker_loop_error", { loop: name, failures, backoff_ms: delay, error: errorText(error, "WORKER_LOOP_FAILED").slice(0, 200) });
    }
    if (delay > 0) await control.sleep(delay);
    else await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  }
}

/** `concurrency` independent job loops plus one maintenance loop (queue/outbox recovery + outbox drain). */
export function startWorkerLoops(dependencies: WorkerDependencies & MaintenanceDependencies, options: WorkerLoopOptions = {}): WorkerLoops {
  const concurrency = Math.min(8, Math.max(1, Math.trunc(options.concurrency ?? 2)));
  const idleMs = options.idleMs ?? 1000;
  const maxBackoffMs = options.maxBackoffMs ?? 30_000;
  const control = createLoopControl();
  const loops = Array.from({ length: concurrency }, (_, index) => runLoop(`job-${index + 1}`, () => runWorkerOnce(dependencies), control, idleMs, maxBackoffMs));
  loops.push(runLoop("maintenance", () => runMaintenanceOnce(dependencies, options.outboxBatch ?? 10).then(() => false), control, options.maintenanceMs ?? 1000, maxBackoffMs));
  const done = Promise.all(loops).then(() => undefined);
  return { concurrency, done, stop: async () => { control.stop(); await done; } };
}

export async function startWorkerRuntime(): Promise<() => Promise<void>> {
  const pool = createDatabasePool(process.env.DATABASE_URL_WORKER || process.env.DATABASE_URL);
  const queuePool = createDatabasePool(process.env.DATABASE_URL_QUEUE || process.env.DATABASE_URL_WORKER || process.env.DATABASE_URL);
  await assertDatabaseReady(pool);
  await pool.query("SELECT 1 FROM schema_migrations LIMIT 1");
  const queue = new PostgresQueue(queuePool, pool);
  const outbox = new PostgresConfirmOutbox(pool, process.env.OCR_WORKER_ID ?? undefined);
  const store = new PostgresOcrDocumentStore(pool);
  const storage = createLocalStorage(process.env.OCR_STORAGE_ROOT ?? "/var/lib/ocr");
  const ocrClient = OcrClient.fromConfig();
  const loops = startWorkerLoops({ queue, store, storage, ocrClient, outbox, sendConfirmation: confirmSender(ocrClient) }, { concurrency: workerConcurrency() });
  logEvent("worker_started", { concurrency: loops.concurrency });
  let stopping: Promise<void> | undefined;
  return () => stopping ??= (async () => {
    // Let in-flight jobs finish briefly; an unfinished lease expires and is recovered by another worker.
    await Promise.race([loops.stop(), new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, STOP_TIMEOUT_MS).unref())]);
    await Promise.allSettled([pool.end(), queuePool.end()]);
    logEvent("worker_stopped", {});
  })();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startWorkerRuntime().then((stop) => {
    const shutdown = (signal: string) => { logEvent("worker_stopping", { signal }); void stop().finally(() => process.exit()); };
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.once("SIGINT", () => shutdown("SIGINT"));
  }).catch((error: unknown) => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
}
