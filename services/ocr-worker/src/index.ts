import { limits } from "@innovera/ocr-config";
import { OcrClient } from "@innovera/ocr-client";
import { hasReviewFields, structuredStaffResult, type DocumentStore } from "@innovera/ocr-persistence";
import type { LocalStorage } from "@innovera/ocr-storage/local";
import { PostgresQueue } from "@innovera/ocr-queue/postgres";
import { PostgresConfirmOutbox } from "@innovera/ocr-queue/outbox";
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

export async function processOcrJob(
  payload: ExtractionPayloadV1,
  dependencies: Readonly<{ storage: LocalStorage; ocrClient: OcrClient; documentStore: DocumentStore }>
): Promise<OcrJobResult> {
  validatePayload(payload);
  const file = await dependencies.storage.get(payload.sourceKey);
  const startedAt = Date.now();
  let result: Awaited<ReturnType<OcrClient["processDocument"]>>;
  try {
    result = await dependencies.ocrClient.processDocument(file, payload.filename ?? payload.documentId, payload.mimeType ?? "application/octet-stream");
    metrics.increment("ocr_requests_total", { status: "success" });
  } catch (error) {
    metrics.increment("ocr_requests_total", { status: "error" });
    throw error;
  } finally {
    metrics.increment("ocr_latency_ms_sum", {}, Date.now() - startedAt);
  }
  const needsReview = hasReviewFields(result);
  const patch = {
    ocrDocumentId: result.documentId,
    rawResponse: result,
    structuredResult: structuredStaffResult(result),
    needsReview
  } as { ocrDocumentId: string; rawResponse: typeof result; structuredResult: Readonly<Record<string, unknown>>; needsReview: boolean; engine?: string; version?: string };
  if (result.engine !== undefined) patch.engine = result.engine;
  if (result.version !== undefined) patch.version = result.version;
  await dependencies.documentStore.saveOcrResult(payload.organizationId, payload.documentId, patch);
  return { status: needsReview ? "NEEDS_REVIEW" : "SUCCEEDED", ocrDocumentId: result.documentId };
}

export async function runWorkerOnce(dependencies: Readonly<{ queue: PostgresQueue; store: PostgresOcrDocumentStore; storage: LocalStorage; ocrClient: OcrClient }>): Promise<boolean> {
  const claimed = await dependencies.queue.claim();
  if (!claimed) return false;
  metrics.increment("jobs_processing");
  logEvent("job_claimed", { job_id: claimed.jobId, tenant_id: claimed.organizationId, status: "PROCESSING" });
  const document = await dependencies.store.getWorkerDocument(claimed.runId, claimed.organizationId);
  if (!document) {
    await dependencies.queue.finish(claimed.jobId, claimed.leaseToken, "FAILED", "DOCUMENT_NOT_FOUND");
    return true;
  }
  try {
    await dependencies.store.markProcessing(document.organizationId, document.documentId);
    await processOcrJob({ schemaVersion: 1, documentId: document.documentId, organizationId: document.organizationId, sourceKey: document.sourceKey, filename: document.filename, mimeType: document.mimeType }, { storage: dependencies.storage, ocrClient: dependencies.ocrClient, documentStore: dependencies.store });
    await dependencies.queue.finish(claimed.jobId, claimed.leaseToken, "SUCCEEDED");
    metrics.increment("jobs_completed");
    logEvent("job_completed", { job_id: claimed.jobId, tenant_id: document.organizationId, status: "SUCCEEDED" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "OCR_WORKER_FAILED";
    await dependencies.store.markFailure(document.organizationId, document.documentId, message).catch(() => undefined);
    await dependencies.queue.finish(claimed.jobId, claimed.leaseToken, "FAILED", message);
    metrics.increment("jobs_failed");
    logEvent("job_failed", { job_id: claimed.jobId, tenant_id: document.organizationId, status: "FAILED" });
  }
  return true;
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
  let stopped = false;
  const loop = async (): Promise<void> => {
    while (!stopped) {
      await queue.recoverExpired();
      await outbox.recoverExpired();
      await outbox.dispatchOnce(async (payload) => {
        await ocrClient.confirmResult({
          documentId: String(payload.documentId), field: String(payload.field), raw: String(payload.raw ?? ""), verifiedValue: String(payload.verifiedValue ?? "")
        });
      });
      const worked = await runWorkerOnce({ queue, store, storage, ocrClient });
      if (!worked) await new Promise((resolveSleep) => setTimeout(resolveSleep, 1000));
    }
  };
  void loop();
  return async () => { stopped = true; await store.close(); await queue.close(); await outbox.close(); };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startWorkerRuntime().catch((error: unknown) => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
}
