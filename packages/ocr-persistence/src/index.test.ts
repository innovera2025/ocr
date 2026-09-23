import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { documentFilterSql, hasReviewFields, isUuid, legacyFieldPath, pageJobPriority, PostgresOcrDocumentStore, statusCategoryOf, structuredStaffResult, structuredDocumentResult, toBatchSummary, toStructuredResult } from "./index.js";

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

test("batch clock (D11): a retried batch counts from the round's first claim, not from an upload hours earlier", () => {
  // A never-retried batch is untouched: createdAt → the last completion, and every all-time completion counts.
  const plain = toBatchSummary(batchRow({ rows: 2, succeeded: 2, last_completed_at: new Date("2026-09-22T01:20:00Z") }));
  assert.deepEqual([plain.roundOpenedAt, plain.roundStartedAt, plain.roundCompleted], [null, null, 0]);
  assert.deepEqual([plain.durationMs, plain.throughputPerMinute], [20 * 60_000, 0.1]);
  // A retry reopened the round two hours after the upload and the worker has not claimed the row yet.
  const waiting = toBatchSummary(batchRow({ rows: 2, queued: 1, succeeded: 1, round_opened_at: new Date("2026-09-22T03:00:00Z"),
    round_started_at: null, round_completed: 0, last_completed_at: new Date("2026-09-22T01:20:00Z"), db_now: new Date("2026-09-22T03:05:00Z") }));
  assert.deepEqual([waiting.roundOpenedAt, waiting.roundStartedAt], ["2026-09-22T03:00:00.000Z", null]);
  assert.deepEqual([waiting.durationMs, waiting.throughputPerMinute], [null, null],
    "no first claim yet: a duration from createdAt would show the two idle hours this carry-over exists to remove");
  // Claimed at 03:01 and finished at 03:03: two minutes of work, not the two hours since the upload.
  const running = toBatchSummary(batchRow({ rows: 2, succeeded: 2, round_opened_at: new Date("2026-09-22T03:00:00Z"),
    round_started_at: new Date("2026-09-22T03:01:00Z"), round_completed: 1, last_completed_at: new Date("2026-09-22T03:03:00Z"),
    db_now: new Date("2026-09-22T03:03:30Z") }));
  assert.deepEqual([running.finished, running.durationMs], [true, 2 * 60_000]);
  assert.equal(running.throughputPerMinute, 0.5, "only the round's completions count: the all-time 2 would read as 1/min");
  assert.deepEqual([running.completed, running.roundCompleted], [2, 1], "the all-time counter is still reported beside it");
});

// ---- the export store (§10 H4): one snapshot, one cursor, one connection --------------------------------------

type FakeQuery = { text: string; values: readonly unknown[] };
/** A pooled client that answers the export's statements from a script, and records what was asked and how it ended. */
class FakeExportClient {
  readonly queries: FakeQuery[] = [];
  readonly released: (boolean | Error | undefined)[] = [];
  private readonly listeners = new Set<(error: Error) => void>();
  constructor(private readonly pages: Row[][], private readonly total: number, private readonly fetchFails?: Error) {}
  async query(text: string, values: readonly unknown[] = []): Promise<{ rows: unknown[] }> {
    this.queries.push({ text, values });
    if (text.startsWith("FETCH")) {
      if (this.fetchFails) throw this.fetchFails;
      return { rows: this.pages.shift() ?? [] };
    }
    return { rows: text.includes("count(*)") ? [{ total: this.total }] : [] };
  }
  on(event: string, listener: (error: Error) => void): this { if (event === "error") this.listeners.add(listener); return this; }
  removeListener(_event: string, listener: (error: Error) => void): this { this.listeners.delete(listener); return this; }
  release(error?: boolean | Error): void { this.released.push(error); }
  /** What node-postgres does when the backend dies: with no listener this event takes the whole process down. */
  emitError(error: Error): void {
    if (this.listeners.size === 0) throw new Error("no 'error' listener: this event would have crashed the web process");
    for (const listener of this.listeners) listener(error);
  }
  get texts(): string[] { return this.queries.map((query) => query.text.replace(/\s+/g, " ").trim()); }
}
type Row = Record<string, unknown>;

function exportStore(clients: FakeExportClient[]): { store: PostgresOcrDocumentStore; pool: Pool } {
  const pool = new Pool();
  const queue = [...clients];
  Object.assign(pool, { connect: async () => (queue.shift() ?? clients.at(-1)) as never });
  return { store: new PostgresOcrDocumentStore(pool), pool };
}
const documentRow = (id: string): Row => ({ id, batch_id: null, batch_label: null, filename: `${id}.png`, status: "SUCCEEDED", needs_review: false,
  error_message: null, created_at: new Date("2026-09-22T01:00:00Z"), processed_at: null, reviewed_at: null, reviewed_by: null, reviewed_by_name: null,
  structured_result: {}, delivery_status: "NONE", template: null, parent_document_id: null, page_number: null, page_count: null, parent_filename: null });

test("openExport streams one REPEATABLE READ READ ONLY snapshot through a cursor and always releases the client", async () => {
  const client = new FakeExportClient([[documentRow("a"), documentRow("b")], [documentRow("c")]], 3);
  const { store, pool } = exportStore([client]);
  const cursor = await store.openExport("11111111-1111-4111-8111-111111111111", { status: "confirmed" }, { maxRows: 10, batchSize: 2 });
  assert.equal(cursor.total, 3, "the count is known before a single row is yielded, so EXPORT_TOO_LARGE stays a clean 400");
  const seen: string[] = [];
  for await (const page of cursor.rows()) seen.push(...page.map((document) => document.documentId));
  assert.deepEqual(seen, ["a", "b", "c"]);
  assert.deepEqual(client.texts.slice(0, 4), ["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    "SELECT set_config('app.current_org', $1, true)", "SELECT set_config('statement_timeout', $1, true)",
    "SELECT set_config('idle_in_transaction_session_timeout', $1, true)"]);
  assert.deepEqual(client.queries[1]!.values, ["11111111-1111-4111-8111-111111111111"]);
  assert.deepEqual(client.queries.slice(2, 4).map((query) => query.values), [["60000"], ["120000"]]);
  const declare = client.texts.find((text) => text.startsWith("DECLARE"))!;
  assert.match(declare, /^DECLARE export_cur NO SCROLL CURSOR FOR SELECT /);
  assert.match(declare, /ORDER BY d\.created_at, COALESCE\(d\.parent_document_id, d\.id\), d\.page_number ASC NULLS FIRST, d\.id$/);
  assert.deepEqual(client.texts.filter((text) => text.startsWith("FETCH")), ["FETCH 2 FROM export_cur", "FETCH 2 FROM export_cur"],
    "a short page ends the stream: no wasted round trip");
  assert.deepEqual(client.texts.slice(-2), ["CLOSE export_cur", "COMMIT"]);
  assert.deepEqual(client.released, [false], "the connection goes back to the pool intact");
  await cursor.close();
  assert.deepEqual(client.released, [false], "close() is idempotent");
  await pool.end();
});

test("openExport refuses a too-large export before it reads anything, and never declares a cursor", async () => {
  const client = new FakeExportClient([], 50_001);
  const { store, pool } = exportStore([client]);
  await assert.rejects(store.openExport("t", {}, { maxRows: 50_000 }), { message: "EXPORT_TOO_LARGE" });
  assert.ok(!client.texts.some((text) => text.startsWith("DECLARE")));
  assert.deepEqual(client.texts.slice(-1), ["COMMIT"], "no cursor was declared, so none is closed; the transaction still ends");
  assert.deepEqual(client.released, [false], "a refused export costs no pooled connection");
  const second = new FakeExportClient([], 50_000);
  const ok = await exportStore([second]).store.openExport("t", {}, { maxRows: 50_000 });
  assert.equal(ok.total, 50_000, "exactly at the limit still runs");
  await ok.close();
  await pool.end();
});

test("at most two exports hold a connection at once; an abandoned download frees its slot", async () => {
  const clients = [new FakeExportClient([], 0), new FakeExportClient([], 0), new FakeExportClient([], 0)];
  const { store, pool } = exportStore(clients);
  const first = await store.openExport("t", {}, { maxRows: 10 });
  const second = await store.openExport("t", {}, { maxRows: 10 });
  await assert.rejects(store.openExport("t", {}, { maxRows: 10 }), { message: "EXPORT_BUSY" });
  await first.close();
  const third = await store.openExport("t", {}, { maxRows: 10 });
  await Promise.all([second.close(), third.close()]);
  // A checkout that fails must give its slot straight back, or two of them would wedge the export for good.
  Object.assign(pool, { connect: async () => { throw new Error("pool exhausted"); } });
  for (let attempt = 0; attempt < 3; attempt += 1) await assert.rejects(store.openExport("t", {}, { maxRows: 10 }), { message: "pool exhausted" });
  Object.assign(pool, { connect: async () => clients[2] as never });
  await store.openExport("t", {}, { maxRows: 10 }).then((cursor) => cursor.close());
  await pool.end();
});

test("a browser that disconnects mid-download closes the cursor through the generator's return()", async () => {
  const client = new FakeExportClient([[documentRow("a")], [documentRow("b")]], 2);
  const { store, pool } = exportStore([client]);
  const cursor = await store.openExport("t", {}, { maxRows: 10, batchSize: 1 });
  const rows = cursor.rows();
  await rows.next();
  await rows.return(undefined);
  assert.deepEqual(client.texts.slice(-2), ["CLOSE export_cur", "COMMIT"]);
  assert.deepEqual(client.released, [false]);
  await store.openExport("t", {}, { maxRows: 10 }).then((next) => next.close(), () => assert.fail("the slot was not freed"));
  await pool.end();
});

test("a backend killed mid-stream rejects the export instead of crashing the process, and the client is destroyed", async () => {
  const dead = new Error("terminating connection due to idle-in-transaction timeout");
  const client = new FakeExportClient([[documentRow("a")]], 2, dead);
  const { store, pool } = exportStore([client]);
  const cursor = await store.openExport("t", {}, { maxRows: 10 });
  client.emitError(dead); // pg-pool removed its own idle listener at checkout: ours is the only one left.
  await assert.rejects((async () => { for await (const page of cursor.rows()) void page; })(), dead);
  assert.deepEqual(client.released, [true], "a client whose backend died is destroyed, not returned to the pool");
  await pool.end();
});

test("previewExport reads the same snapshot the download would, bounded to 20 rows", async () => {
  const client = new FakeExportClient([], 7);
  const { store, pool } = exportStore([client]);
  const preview = await store.previewExport("t", { q: "  somchai  " }, { limit: 99 });
  assert.equal(preview.total, 7);
  assert.equal(client.texts[0], "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const select = client.queries.at(-2)!;
  assert.match(select.text.replace(/\s+/g, " "), / ORDER BY d\.created_at, .* LIMIT \$3$/);
  assert.deepEqual(select.values, ["t", "%somchai%", 20], "the preview is capped at 20 rows whatever the caller asks");
  assert.equal(client.texts.at(-1), "COMMIT");
  await pool.end();
});

test("documentFilterSql is the one WHERE the list and the export share", () => {
  const params: unknown[] = [];
  const tenant = "11111111-1111-4111-8111-111111111111";
  const batch = "22222222-2222-4222-8222-222222222222";
  const sql = documentFilterSql(tenant, { status: ["review", "failed"], batchId: batch, from: "2026-09-01", to: "2026-09-22" }, params);
  assert.match(sql, /^d\.organization_id = \$1::uuid AND d\.deleted_at IS NULL AND d\.status NOT IN \('DELETED','SPLIT'\)/,
    "SPLIT parents and deleted rows are excluded for every caller");
  assert.match(sql, /\(\(d\.status = 'NEEDS_REVIEW'\) OR \(d\.status IN \('FAILED','QUARANTINED'\)\)\)/, "several statuses are OR-ed");
  assert.match(sql, /d\.batch_id = \$2::uuid/);
  assert.match(sql, /d\.created_at >= \(\$3::date::timestamp AT TIME ZONE 'Asia\/Bangkok'\)/);
  assert.match(sql, /d\.created_at < \(\(\$4::date \+ 1\)::timestamp AT TIME ZONE 'Asia\/Bangkok'\)/, "the whole of the 'to' day is included");
  assert.deepEqual(params, [tenant, batch, "2026-09-01", "2026-09-22"]);
  const reviewed: unknown[] = [];
  const confirmed = documentFilterSql(tenant, { dateField: "reviewed_at", from: "2026-09-22", confirmedOnly: true }, reviewed);
  assert.ok(confirmed.includes("d.confirmed_at"), "the confirmation date is the read-side REVIEWED_AT_SQL, not just reviewed_at");
  assert.ok(confirmed.includes("IS NOT NULL"), "a confirmation-date filter implies the row IS confirmed");
  assert.deepEqual(reviewed, [tenant, "2026-09-22"]);
  assert.equal(documentFilterSql(tenant, {}, []).includes("status"), true, "the visibility clause is always there");
  for (const bad of [{ from: "22-09-2026" }, { to: "2026-13-01" }, { from: "2026-09-22", to: "2026-09-21" }, { dateField: "id" as never }]) {
    assert.throws(() => documentFilterSql(tenant, bad, []), { message: "INVALID_EXPORT_FILTER" }, JSON.stringify(bad));
  }
  assert.throws(() => documentFilterSql(tenant, { status: ["nope" as never] }, []), { message: "INVALID_QUERY" });
  assert.throws(() => documentFilterSql(tenant, { batchId: "x" }, []), { message: "BATCH_NOT_FOUND" });
  assert.throws(() => documentFilterSql(tenant, { parentId: "x" }, []), { message: "DOCUMENT_NOT_FOUND" });
});
