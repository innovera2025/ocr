import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createLocalStorage } from "@innovera/ocr-storage/local";
import { processOcrJob } from "./index.js";

test("worker loads storage, calls OCR, and saves needsReview result", async () => {
  const root = await mkdtemp(join("/tmp", "ocr-worker-"));
  try {
    const storage = createLocalStorage(root);
    const organizationId = "00000000-0000-0000-0000-000000000001";
    const sourceKey = `org/${organizationId}/original/ab/abcdefghijklmnopqrstuvwx12345678`;
    await storage.put(sourceKey, new Uint8Array([137, 80, 78, 71]));
    let savedTenant = "";
    const result = await processOcrJob({ schemaVersion: 1, documentId: "00000000-0000-0000-0000-000000000002", organizationId, sourceKey }, {
      storage,
      ocrClient: { processDocument: async () => ({ documentId: "ocr-1", staffOnly: { therapistName: { needsReview: true } } }) } as never,
      documentStore: { saveOcrResult: async (tenant) => { savedTenant = tenant; }, saveCorrection: async () => undefined }
    });
    assert.equal(result.status, "NEEDS_REVIEW");
    assert.equal(savedTenant, organizationId);
  } finally { await rm(root, { recursive: true, force: true }); }
});
