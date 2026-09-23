import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { hasReviewFields, isUuid, legacyFieldPath, pageJobPriority, PostgresOcrDocumentStore, statusCategoryOf, structuredStaffResult, structuredDocumentResult, toBatchSummary, toStructuredResult } from "./index.js";

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
  assert.equal(statusCategoryOf("SPLIT", null), "split", "a PDF split into page rows");
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
  await assert.rejects(store.listDocuments("t", { parentId: "../x" }), { message: "DOCUMENT_NOT_FOUND" });
  const page = { pageNumber: 1, publicId: "a".repeat(32), storageKey: "org/t/original/aa/" + "a".repeat(32), mimeType: "image/png", sizeBytes: 10, contentHash: "h" };
  await assert.rejects(store.createPageDocuments("t", "x", 1, [page]), { message: "DOCUMENT_NOT_FOUND" });
  const parent = "0b7e9f5e-3b1c-4c0e-9d53-2a5f0c7c8f11";
  for (const pageCount of [0, 1001, 2.5]) await assert.rejects(store.createPageDocuments("t", parent, pageCount, [page]), { message: "PAGE_COUNT_INVALID" });
  for (const bad of [{ ...page, pageNumber: 2 }, { ...page, pageNumber: 0 }, { ...page, publicId: "../../x" }, { ...page, sizeBytes: 0 }, { ...page, contentHash: null }]) {
    await assert.rejects(store.createPageDocuments("t", parent, 1, [bad]), { message: "PAGE_INVALID" });
  }
  await assert.rejects(store.setPageCount("t", parent, 1001), { message: "PAGE_COUNT_INVALID" });
  await assert.rejects(store.createUploadedDocument({ tenantId: "t", filename: "a.png", mimeType: "image/png", sizeBytes: 1, contentHash: "h", storageKey: "k", batchId: "nope" }), { message: "BATCH_NOT_FOUND" });
  await assert.rejects(store.createBatch("t", { createdBy: "u", expectedTotal: 0 }), { message: "BATCH_INVALID" });
  await assert.rejects(store.createBatch("t", { createdBy: "u", expectedTotal: 501 }), { message: "BATCH_INVALID" });
  await assert.rejects(store.createBatch("t", { createdBy: "u", expectedTotal: 1.5 }), { message: "BATCH_INVALID" });
  await assert.rejects(store.createBatch("t", { createdBy: "u", expectedTotal: 2, label: "x".repeat(201) }), { message: "BATCH_INVALID" });
  await assert.rejects(store.createBatch("t", { createdBy: " ", expectedTotal: 2 }), { message: "BATCH_INVALID" });
  await assert.rejects(store.saveReview("t", "0b7e9f5e-3b1c-4c0e-9d53-2a5f0c7c8f11", { structuredResult: {}, reviewedBy: "u", expectedUpdatedAt: "yesterday" }), { message: "REVIEW_INVALID" });
  // §6 D9: a PENDING confirmation must name its actor; the removed default wrote the tenant id into verified_by.
  await assert.rejects(store.saveCorrection("t", "0b7e9f5e-3b1c-4c0e-9d53-2a5f0c7c8f11", "roomNo", "7", "PENDING"), { message: "CORRECTION_AUDIT_REQUIRED" });
  await pool.end();
});

test("page jobs are queued in page order at the single-upload priority and above (fair against other uploads)", () => {
  assert.deepEqual([1, 2, 12, 95, 1000].map(pageJobPriority), [100, 101, 111, 194, 1099]);
});

/** A BATCH_SELECT row: files (uploaded/expected) vs rows (status counters). */
const batchRow = (counts: Partial<Record<string, number | Date | null>>) => ({ id: "b", label: null, created_at: new Date("2026-09-22T01:00:00Z"), expected_total: 1,
  db_now: new Date("2026-09-22T01:30:00Z"), uploaded: 1, rows: 1, pages: 0, pages_expected: 0, splitting: 0, splitting_counted: 0, queued: 0, processing: 0, succeeded: 0, needs_review: 0,
  failed: 0, confirmed: 0, last_completed_at: null, last_created_at: new Date("2026-09-22T01:00:05Z"), ...counts });

test("batch summary: a 1-file batch whose PDF became 95 rows is not finished until the last page is read", () => {
  const firstPage = new Date("2026-09-22T01:01:00Z");
  // The PDF is being split (one processing row) and page 1 is already read.
  let summary = toBatchSummary(batchRow({ rows: 11, pages: 10, pages_expected: 95, splitting: 1, splitting_counted: 1, processing: 1, queued: 9, succeeded: 1, last_completed_at: firstPage }));
  assert.deepEqual([summary.uploaded, summary.rows, summary.pages, summary.pagesExpected, summary.splitting, summary.completed, summary.finished, summary.finishedAt],
    [1, 11, 10, 95, 1, 1, false, null], "the old rule (completed >= expectedTotal) called this finished");
  assert.equal(summary.rowsExpected, 95, "95 page rows to come, not 96: the splitting parent (a row now) is not counted on top of its pages");
  assert.equal(toBatchSummary(batchRow({ rows: 1, pages: 0, pages_expected: 0, splitting: 1, processing: 1 })).rowsExpected, 1, "page count not known yet: the PDF is one row");
  assert.equal(toBatchSummary(batchRow({ expected_total: 3, rows: 11, pages: 10, pages_expected: 95, splitting: 1, splitting_counted: 1 })).rowsExpected, 97, "+2 files still to come");
  // Split done (parent SPLIT, not a row); 94 pages read, 1 page still processing.
  summary = toBatchSummary(batchRow({ rows: 95, pages: 95, pages_expected: 95, processing: 1, succeeded: 60, needs_review: 34, last_completed_at: firstPage }));
  assert.equal(summary.finished, false);
  const last = new Date("2026-09-22T01:40:00Z");
  summary = toBatchSummary(batchRow({ rows: 95, pages: 95, pages_expected: 95, succeeded: 60, needs_review: 34, failed: 1, last_completed_at: last, db_now: new Date("2026-09-22T01:41:00Z") }));
  assert.deepEqual([summary.finished, summary.finishedAt, summary.completed, summary.durationMs], [true, last.toISOString(), 95, 40 * 60_000]);
});

test("batch summary: files still arriving keep a batch open; a failed split is a finished (failed) row", () => {
  const done = new Date("2026-09-22T01:02:00Z");
  const arriving = toBatchSummary(batchRow({ expected_total: 3, uploaded: 2, rows: 2, succeeded: 2, last_completed_at: done, db_now: new Date("2026-09-22T01:03:00Z") }));
  assert.deepEqual([arriving.finished, arriving.finishedAt], [false, null]);
  assert.ok(arriving.durationMs! > 2 * 60_000, "the clock keeps running while files may still upload");
  const failedSplit = toBatchSummary(batchRow({ rows: 1, failed: 1, last_completed_at: done }));
  assert.deepEqual([failedSplit.finished, failedSplit.failed, failedSplit.splitting, failedSplit.rows], [true, 1, 0, 1]);
  const empty = toBatchSummary(batchRow({ uploaded: 0, rows: 0, last_created_at: null }));
  assert.deepEqual([empty.finished, empty.durationMs, empty.throughputPerMinute], [false, null, null]);
});
