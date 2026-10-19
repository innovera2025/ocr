import { createHash, randomBytes } from "node:crypto";
import { createClamAvStorageScanner } from "@innovera/ocr-ingest/clamav";
import type { IngestDependencies } from "@innovera/ocr-ingest";
import { mintOriginalKey } from "@innovera/ocr-storage";
import { createLocalStorage } from "@innovera/ocr-storage/local";
import { jobPriority, PostgresQueue } from "@innovera/ocr-queue/postgres";
import { PostgresOcrDocumentStore, type AuditContext } from "@innovera/ocr-persistence";
import type { Pool } from "pg";

/**
 * Batch-first queue priority (plan queue-control D3): every job of a batch gets the batch's `queue_seq`, so
 * `ocr_claim_v1` (priority ASC, available_at ASC) reads one batch completely, in upload order, before the next; an upload
 * without a batch gets 0 and goes ahead of every batch (FIFO among themselves), without touching the queue functions.
 */
export function queueJobPriority(queueSeq?: number): number { return queueSeq === undefined ? 0 : jobPriority(queueSeq); }

/** `actor` is who is uploading (§6 D9): `createUploadedDocument` writes its `document.uploaded` row in the same transaction. */
export function createRuntimeIngest(pool: Pool, tenantId: string, idempotencyKey?: string, batchId?: string, actor?: AuditContext): IngestDependencies {
  const storage = createLocalStorage(process.env.OCR_STORAGE_ROOT ?? "/var/lib/ocr");
  const queue = new PostgresQueue(pool);
  const store = new PostgresOcrDocumentStore(pool);
  // The batch is part of the request identity: replaying a key into another batch is an IDEMPOTENCY_CONFLICT.
  // Without a batch the digest is byte-identical to the pre-batch fingerprint, so in-flight keys stay valid.
  const fingerprint = (filename: string, mimeType: string, bytes: Uint8Array) => createHash("sha256").update(bytes).update(filename).update(mimeType).update(batchId ?? "").digest("hex");
  const scanner = createClamAvStorageScanner(storage, {
    host: process.env.OCR_CLAMAV_HOST ?? "clamav",
    port: Number(process.env.OCR_CLAMAV_PORT ?? 3310)
  });
  const idempotency = idempotencyKey ? { idempotencyKey } : {};
  return {
    lookupUpload: async ({ filename, mimeType, bytes }) => store.findIdempotentUpload({ tenantId, ...idempotency, requestFingerprint: fingerprint(filename, mimeType, bytes) }),
    claimResume: async ({ documentId }) => store.claimStaleUpload(tenantId, documentId),
    stage: async ({ bytes }) => {
      const publicId = randomBytes(16).toString("hex");
      const key = mintOriginalKey(tenantId, publicId);
      await storage.put(key, bytes);
      return key;
    },
    scan: scanner,
    enqueue: async () => { throw new Error("PERSISTENT_QUEUE_REQUIRED"); },
    persistUpload: async ({ filename, mimeType, bytes, stagedKey }) => {
      const { batchPosition: _position, queueSeq, ...uploaded } = await store.createUploadedDocument({
        tenantId, filename, mimeType, sizeBytes: bytes.byteLength,
        contentHash: createHash("sha256").update(bytes).digest("hex"), storageKey: stagedKey,
        ...idempotency, ...(batchId ? { batchId } : {}), ...(actor ? { audit: actor } : {}), requestFingerprint: fingerprint(filename, mimeType, bytes)
      });
      return { ...uploaded, priority: queueJobPriority(queueSeq) };
    },
    updateStatus: async ({ documentId, status, errorMessage }) => store.updateScanStatus(tenantId, documentId, status, errorMessage),
    // A resumed upload (claimResume) reaches here without the priority persistUpload returned: look it up (one SELECT),
    // so it keeps its batch's place instead of the column default 100.
    enqueuePersistent: async ({ documentId, runId, priority }) => queue.enqueue({ organizationId: tenantId, runId,
      priority: priority ?? await store.queuePriorityOf(tenantId, documentId) }),
    discard: async (stagedKey) => storage.remove(stagedKey)
  };
}
