import test from "node:test";
import assert from "node:assert/strict";
import { limits } from "@innovera/ocr-config";
import { validatePayload } from "@innovera/ocr-worker";

test("M1 limits remain aligned with the canonical upload and OCR budgets", () => {
  assert.equal(limits.maxUploadBytes, 209_715_200);
  assert.equal(limits.jobProcessingBudgetMs, 1_800_000);
  assert.equal(limits.maxOcrPagesPerDocument, 50);
});

test("worker rejects storage keys outside the payload organisation prefix", () => {
  assert.throws(() => validatePayload({
    schemaVersion: 1,
    documentId: "doc_01",
    organizationId: "org_01",
    sourceKey: "org/org_02/documents/doc_01/original"
  }), /INVALID_TENANT_STORAGE_KEY/);
});
