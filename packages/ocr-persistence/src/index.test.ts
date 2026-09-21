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
  assert.deepEqual(legacyFieldPath({ treatment: { raw: "ไทย" } }, "treatment"), ["treatment"], "flat v2.2 rows keep the top-level object");
  assert.deepEqual(legacyFieldPath(null, "roomNo"), ["roomNo"]);
  assert.deepEqual(legacyFieldPath({ staffOnly: [] }, "roomNo"), ["roomNo"]);
});

test("legacy confirm of treatment targets one canonical item, never an orphan top-level key", () => {
  const item = (nameRaw: string, needsReview: boolean) => ({ raw: `${nameRaw} 60 นาที`, nameRaw, value: null, needsReview });
  const sectioned = { schemaVersion: 3, staffOnly: { treatments: [item("ไทย", false), item("ฟุต", true), item("หน้า", true)] } };
  assert.deepEqual(legacyFieldPath(sectioned, "treatment", "ฟุต"), ["staffOnly", "treatments", "1"]);
  assert.deepEqual(legacyFieldPath(sectioned, "treatment", "หน้า 60 นาที"), ["staffOnly", "treatments", "2"]);
  assert.throws(() => legacyFieldPath(sectioned, "treatment", "ใทบ"), { message: "CONFIRMATION_TARGET_AMBIGUOUS" });
  assert.throws(() => legacyFieldPath({ staffOnly: {} }, "treatment", "ไทย"), { message: "CONFIRMATION_TARGET_AMBIGUOUS" });
  assert.throws(() => legacyFieldPath({ staffOnly: { treatments: [] } }, "treatment"), { message: "CONFIRMATION_TARGET_AMBIGUOUS" });
  assert.deepEqual(legacyFieldPath({ staffOnly: { treatments: [item("ไทย", true)] } }, "treatment"), ["staffOnly", "treatments", "0"]);
  assert.deepEqual(legacyFieldPath({ documentId: "x", staffOnly: { treatment: { raw: "ไทย" } } }, "treatment"), ["staffOnly", "treatment"], "whole v2.2 responses");
});

test("legacy confirm of one v2.2 treatment item writes that item, so its siblings survive (flat and whole v2.2 rows)", () => {
  const treatment = { raw: "ไทย 60 นาที ฟุต 30 นาที", durations: ["60 นาที", "30 นาที"], needsReview: true,
    items: [{ raw: "ไทย", value: "นวดไทย", duration: "60 นาที", needsReview: false }, { raw: "ฟุต", value: null, duration: "30 นาที", needsReview: true }] };
  assert.deepEqual(legacyFieldPath({ treatment }, "treatment", "ฟุต"), ["treatment", "items", "1"]);
  assert.deepEqual(legacyFieldPath({ documentId: "x", staffOnly: { treatment } }, "treatment", "ฟุต"), ["staffOnly", "treatment", "items", "1"]);
  assert.deepEqual(legacyFieldPath({ treatment }, "treatment", ""), ["treatment", "items", "1"], "no raw: the only flagged item");
  assert.deepEqual(legacyFieldPath({ treatment }, "treatment", " ไทย 60 นาที ฟุต 30 นาที "), ["treatment"], "the whole field's raw answers the whole field");
  const bothFlagged = { ...treatment, items: treatment.items.map((item) => ({ ...item, needsReview: true })) };
  assert.deepEqual(legacyFieldPath({ treatment: bothFlagged }, "treatment", "ใทบ"), ["treatment"], "no single item qualifies: whole field, as before");
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
