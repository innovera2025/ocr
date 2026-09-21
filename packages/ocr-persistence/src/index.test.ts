import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { hasReviewFields, isUuid, legacyFieldPath, PostgresOcrDocumentStore, statusCategoryOf, structuredStaffResult, structuredDocumentResult, toStructuredResult } from "./index.js";

test("needsReview mapping detects any staff field requiring review", () => {
  const response = { documentId: "d", staffOnly: { therapistName: { needsReview: false }, treatment: { needsReview: true } } };
  assert.equal(hasReviewFields(response), true);
  assert.deepEqual(structuredStaffResult(response), response.staffOnly);
});

test("needsReview mapping remains false when all fields are verified", () => {
  assert.equal(hasReviewFields({ documentId: "d", staffOnly: { roomNo: { needsReview: false } } }), false);
});

test("needsReview mapping scans full-document sections and treatment arrays", () => {
  assert.equal(hasReviewFields({ documentId: "d", customerInformation: { gender: { needsReview: true } } }), true);
  assert.equal(hasReviewFields({ documentId: "d", staffOnly: { treatments: [{ name: { needsReview: true } }] } }), true);
});

test("structuredDocumentResult preserves all OCR sections", () => {
  const response = { documentId: "d", customerInformation: { name: "Chun" }, recommendationCard: { pressure: "Standard" } };
  assert.deepEqual(structuredDocumentResult(response), response);
});

test("hasReviewFields applies to the canonical view", () => {
  const view = toStructuredResult({ documentId: "d", staffOnly: { treatment: { raw: "ฟุต", items: [{ raw: "ฟุต", value: null, needsReview: true }], needsReview: true } } });
  assert.equal(hasReviewFields(view), true);
  assert.equal(hasReviewFields(toStructuredResult({ documentId: "d", staffOnly: { roomNo: { raw: "1", value: "1", needsReview: false } }, evidence: { needsReview: true } })), false);
});

test("statusCategoryOf maps document statuses to UI buckets", () => {
  assert.deepEqual(["VALIDATING", "SCANNING", "CLEAN", "PROCESSING", "NEEDS_REVIEW", "FAILED", "QUARANTINED", "DELETED"].map((status) => statusCategoryOf(status, null)),
    ["queued", "queued", "queued", "processing", "review", "failed", "failed", null]);
  assert.equal(statusCategoryOf("SUCCEEDED", null), "succeeded");
  assert.equal(statusCategoryOf("SUCCEEDED", new Date()), "confirmed");
});

test("legacy confirm resolves therapistName/roomNo under staffOnly only for sectioned rows", () => {
  assert.deepEqual(legacyFieldPath({ schemaVersion: 3, staffOnly: {} }, "therapistName"), ["staffOnly", "therapistName"]);
  assert.deepEqual(legacyFieldPath({ documentId: "x", staffOnly: { roomNo: {} } }, "roomNo"), ["staffOnly", "roomNo"]);
  assert.deepEqual(legacyFieldPath({ therapistName: { raw: "a" } }, "therapistName"), ["therapistName"]);
  assert.deepEqual(legacyFieldPath({ staffOnly: {} }, "treatment"), ["treatment"]);
  assert.deepEqual(legacyFieldPath(null, "roomNo"), ["roomNo"]);
  assert.deepEqual(legacyFieldPath({ staffOnly: [] }, "roomNo"), ["roomNo"]);
});

test("isUuid guards ids before they reach SQL casts", () => {
  assert.equal(isUuid("0b7e9f5e-3b1c-4c0e-9d53-2a5f0c7c8f11"), true);
  for (const value of ["", "abc", "0b7e9f5e3b1c4c0e9d532a5f0c7c8f11", "0b7e9f5e-3b1c-4c0e-9d53-2a5f0c7c8f11'--", null, 5]) assert.equal(isUuid(value), false);
});

test("store methods reject malformed ids without touching the database", async () => {
  const pool = new Pool();
  const store = new PostgresOcrDocumentStore(pool);
  Object.assign(pool, { connect: async () => { throw new Error("database must not be used"); } });
  assert.equal(await store.getReviewDocument("t", "not-a-uuid"), null);
  assert.equal(await store.getBatch("t", "not-a-uuid"), null);
  assert.equal(await store.getOriginal("t", "../etc"), null);
  await assert.rejects(store.retryDocument("t", "x"), { message: "DOCUMENT_NOT_FOUND" });
  await assert.rejects(store.saveReview("t", "x", { structuredResult: {}, reviewedBy: "u" }), { message: "DOCUMENT_NOT_FOUND" });
  await assert.rejects(store.listDocuments("t", { batchId: "x" }), { message: "BATCH_NOT_FOUND" });
  await assert.rejects(store.listDocuments("t", { status: "bogus" as never }), { message: "INVALID_QUERY" });
  await assert.rejects(store.createUploadedDocument({ tenantId: "t", filename: "a.png", mimeType: "image/png", sizeBytes: 1, contentHash: "h", storageKey: "k", batchId: "nope" }), { message: "BATCH_NOT_FOUND" });
  await assert.rejects(store.createBatch("t", { createdBy: "u", expectedTotal: 0 }), { message: "BATCH_INVALID" });
  await assert.rejects(store.createBatch("t", { createdBy: "u", expectedTotal: 501 }), { message: "BATCH_INVALID" });
  await assert.rejects(store.createBatch("t", { createdBy: "u", expectedTotal: 1.5 }), { message: "BATCH_INVALID" });
  await assert.rejects(store.createBatch("t", { createdBy: "u", expectedTotal: 2, label: "x".repeat(201) }), { message: "BATCH_INVALID" });
  await assert.rejects(store.createBatch("t", { createdBy: " ", expectedTotal: 2 }), { message: "BATCH_INVALID" });
  await assert.rejects(store.saveReview("t", "0b7e9f5e-3b1c-4c0e-9d53-2a5f0c7c8f11", { structuredResult: {}, reviewedBy: "u", expectedUpdatedAt: "yesterday" }), { message: "REVIEW_INVALID" });
  await pool.end();
});
