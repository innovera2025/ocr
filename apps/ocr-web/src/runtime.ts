import { createHash, randomBytes } from "node:crypto";
import { createClamAvStorageScanner } from "@innovera/ocr-ingest/clamav";
import type { IngestDependencies } from "@innovera/ocr-ingest";
import { mintOriginalKey } from "@innovera/ocr-storage";
import { createLocalStorage } from "@innovera/ocr-storage/local";
import { PostgresQueue } from "@innovera/ocr-queue/postgres";
import { PostgresOcrDocumentStore } from "@innovera/ocr-persistence";
import type { Pool } from "pg";

export function createRuntimeIngest(pool: Pool, tenantId: string, idempotencyKey?: string, batchId?: string): IngestDependencies {
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
    stage: async ({ bytes }) => {
      const publicId = randomBytes(16).toString("hex");
      const key = mintOriginalKey(tenantId, publicId);
      await storage.put(key, bytes);
      return key;
    },
    scan: scanner,
    enqueue: async () => { throw new Error("PERSISTENT_QUEUE_REQUIRED"); },
    persistUpload: async ({ filename, mimeType, bytes, stagedKey }) => store.createUploadedDocument({
      tenantId, filename, mimeType, sizeBytes: bytes.byteLength,
      contentHash: createHash("sha256").update(bytes).digest("hex"), storageKey: stagedKey,
      ...idempotency, ...(batchId ? { batchId } : {}), requestFingerprint: fingerprint(filename, mimeType, bytes)
    }),
    updateStatus: async ({ documentId, status, errorMessage }) => store.updateScanStatus(tenantId, documentId, status, errorMessage),
    enqueuePersistent: async ({ runId }) => queue.enqueue({ organizationId: tenantId, runId }),
    discard: async (stagedKey) => storage.remove(stagedKey)
  };
}
