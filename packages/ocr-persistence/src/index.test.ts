import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { documentFilterSql, EXPORT_MARK_LOCK_TIMEOUT_MS, EXPORT_MARK_STATEMENT_TIMEOUT_MS, EXPORT_MAX_DURATION_MS, EXPORT_SELECTION_MAX, hasReviewFields, isUuid, legacyFieldPath, pageJobPriority, PostgresOcrDocumentStore, statusCategoryOf, structuredStaffResult, structuredDocumentResult, toBatchSummary, toStructuredResult } from "./index.js";

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
  // The sort is validated before any query (document-sort.ts); a valid one gets as far as the (poisoned) pool.
  await assert.rejects(store.listDocuments("t", { sort: "bogus" as never }), { message: "INVALID_SORT" });
  await assert.rejects(store.listDocuments("t", { sort: "customer", dir: "up" as never }), { message: "INVALID_SORT" });
  await assert.rejects(store.listDocuments("t", { dir: "sideways" as never }), { message: "INVALID_SORT" });
  await assert.rejects(store.listDocuments("t", { sort: "customer", dir: "desc" }), { message: "database must not be used" });
  await assert.rejects(store.listDocuments("t", { sort: "confidence" }), { message: "database must not be used" });
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
  /** Runs while the statement is in flight, so a test can kill the backend during the teardown round-trips. */
  during: Partial<Record<string, () => void>> = {};
  /** `inState`: what the H1 expected-state count answers (rows of the selection in the tab's state); defaults to `total`. */
  constructor(private readonly pages: Row[][], private readonly total: number, private readonly fetchFails?: Error, private readonly inState?: number) {}
  async query(text: string, values: readonly unknown[] = []): Promise<{ rows: unknown[] }> {
    this.queries.push({ text, values });
    this.during[text]?.();
    if (text.startsWith("FETCH")) {
      if (this.fetchFails) throw this.fetchFails;
      return { rows: this.pages.shift() ?? [] };
    }
    if (text.startsWith("INSERT")) return { rows: [], rowCount: 0 } as { rows: unknown[] };
    return { rows: text.includes("count(*)") ? [{ total: this.total, ...(text.includes("in_state") ? { in_state: this.inState ?? this.total } : {}) }] : [] };
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

test("close() keeps the 'error' listener until the client is back in the pool", async () => {
  const dead = new Error("terminating connection due to administrator command");
  const client = new FakeExportClient([], 0);
  const { store, pool } = exportStore([client]);
  const cursor = await store.openExport("t", {}, { maxRows: 10 });
  // The backend dies while close() awaits COMMIT. FakeExportClient.emitError throws when no listener is attached, so
  // this case fails loudly on the window that would otherwise raise ERR_UNHANDLED_ERROR and exit the web mid-upload.
  client.during.COMMIT = () => { client.emitError(dead); };
  await cursor.close();
  assert.deepEqual(client.released, [true], "a client whose backend died during the teardown is destroyed, not pooled");
  await pool.end();
});

test("rows() honours close(), so a disconnect handler cannot fire a FETCH at another request's connection", async () => {
  const client = new FakeExportClient([[documentRow("a")], [documentRow("b")]], 2);
  const { store, pool } = exportStore([client]);
  const cursor = await store.openExport("t", {}, { maxRows: 10, batchSize: 1 });
  const rows = cursor.rows();
  await rows.next();
  await cursor.close(); // what a 'close'/'aborted' handler or the wall-clock timer does while the generator is suspended
  const fetches = client.texts.filter((text) => text.startsWith("FETCH")).length;
  assert.deepEqual(await rows.next(), { value: undefined, done: true });
  assert.equal(client.texts.filter((text) => text.startsWith("FETCH")).length, fetches, "no FETCH after the client was released");
  await pool.end();
});

test("an export has a wall-clock budget of its own, whatever the route does", async () => {
  const client = new FakeExportClient([[documentRow("a")], [documentRow("b")]], 2);
  const { store, pool } = exportStore([client]);
  let now = 1_000_000;
  const cursor = await store.openExport("t", {}, { maxRows: 10, batchSize: 1, now: () => now });
  const rows = cursor.rows();
  await rows.next();
  // A reader that accepts one page every two minutes resets statement_timeout and the idle timeout on every FETCH,
  // so only this budget ever ends it.
  now += EXPORT_MAX_DURATION_MS + 1;
  await assert.rejects(rows.next(), { message: "EXPORT_TIMEOUT" });
  assert.deepEqual(client.texts.slice(-2), ["CLOSE export_cur", "COMMIT"], "the cursor is still closed and the client released");
  await pool.end();
});

test("a non-finite maxRows is refused instead of silently disabling the cap", async () => {
  const client = new FakeExportClient([], 999_999);
  const { store, pool } = exportStore([client]);
  // `Math.max(1, Math.trunc(NaN))` is NaN and `999999 > NaN` is false: an unset OCR_EXPORT_MAX_ROWS would have
  // streamed the whole tenant.
  for (const bad of [Number(undefined), Number.POSITIVE_INFINITY, 0, -1]) {
    await assert.rejects(store.openExport("t", {}, { maxRows: bad }), { message: "EXPORT_MAX_ROWS_INVALID" }, String(bad));
  }
  assert.deepEqual(client.queries, [], "it never even opens a transaction");
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

// ---- the export history (0021): selection and export-state predicates, selection checks, input guards -----------

test("documentFilterSql: an explicit selection is one bound uuid[] after the other predicates, de-duplicated and capped", () => {
  const tenant = "11111111-1111-4111-8111-111111111111";
  const a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const params: unknown[] = [];
  const sql = documentFilterSql(tenant, { ids: [a, b, a.toUpperCase(), b] }, params);
  assert.match(sql, /^d\.organization_id = \$1::uuid AND d\.deleted_at IS NULL AND d\.status NOT IN \('DELETED','SPLIT'\) AND d\.id = ANY\(\$2::uuid\[\]\)$/,
    "tenant and visibility stay first; the ids are one parameter, never interpolated");
  assert.deepEqual(params, [tenant, [a, b]], "lower-cased and de-duplicated, first occurrence order");
  const mixed: unknown[] = [];
  const both = documentFilterSql(tenant, { batchId: b, q: "x", ids: [a] }, mixed);
  assert.match(both, /d\.batch_id = \$2::uuid .* AND d\.id = ANY\(\$4::uuid\[\]\)$/s, "independent predicates: the ids come last");
  assert.deepEqual(mixed, [tenant, b, "%x%", [a]]);
  const max = Array.from({ length: EXPORT_SELECTION_MAX }, (_unused, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
  const capped: unknown[] = [];
  documentFilterSql(tenant, { ids: [...max, ...max] }, capped);
  assert.equal((capped[1] as string[]).length, EXPORT_SELECTION_MAX, "5,000 distinct ids are accepted, duplicates do not count");
  const over = [...max, "00000000-0000-4000-8000-999999999999"];
  for (const bad of [over, ["not-a-uuid"], [a, "1; DROP TABLE documents"], [42], [null], "a,b" as never, {} as never]) {
    assert.throws(() => documentFilterSql(tenant, { ids: bad as readonly string[] }, []), { message: "INVALID_EXPORT_SELECTION" },
      Array.isArray(bad) ? `${bad.length} ids` : typeof bad);
  }
  const empty: unknown[] = [];
  assert.match(documentFilterSql(tenant, { ids: [] }, empty), /d\.id = ANY\(\$2::uuid\[\]\)$/, "an empty selection matches nothing (the store reports EXPORT_SELECTION_EMPTY)");
  assert.deepEqual(empty, [tenant, []]);
});

test("documentFilterSql: exportState adds the latest-event predicate from a closed set and binds nothing", () => {
  const tenant = "11111111-1111-4111-8111-111111111111";
  for (const state of ["never", "exported"] as const) {
    const params: unknown[] = [];
    const sql = documentFilterSql(tenant, { status: "confirmed", exportState: state, from: "2026-09-01" }, params);
    assert.ok(sql.endsWith(`'never') = '${state}'`), `${state}: the state predicate follows the date range`);
    assert.match(sql, /FROM document_export_marks m\s+WHERE m\.organization_id = d\.organization_id AND m\.document_id = d\.id ORDER BY m\.seq DESC LIMIT 1/,
      "the latest event of this row, same tenant, by seq");
    assert.deepEqual(params, [tenant, "2026-09-01"], "the parameter order of the other filters is unchanged");
  }
  assert.ok(!documentFilterSql(tenant, {}, []).includes("document_export_marks"), "no state filter, no history lookup in the WHERE");
  for (const bad of ["all", "NEVER", "' OR 1=1 --"]) {
    assert.throws(() => documentFilterSql(tenant, { exportState: bad as never }, []), { message: "INVALID_EXPORT_FILTER" }, bad);
  }
});

test("openExport selection checks run after the count and before the cursor: too large, then changed, then empty", async () => {
  const tenant = "11111111-1111-4111-8111-111111111111";
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const refused = async (total: number, filter: Parameters<PostgresOcrDocumentStore["openExport"]>[1], options: { maxRows: number; expectedTotal?: number }, message: string) => {
    const client = new FakeExportClient([], total);
    const { store, pool } = exportStore([client]);
    await assert.rejects(store.openExport(tenant, filter, options), { message }, message);
    assert.ok(!client.texts.some((text) => text.startsWith("DECLARE")), `${message}: no cursor, so no byte`);
    assert.deepEqual(client.released, [false], `${message}: the connection goes back intact`);
    await pool.end();
  };
  await refused(11, {}, { maxRows: 10, expectedTotal: 7 }, "EXPORT_TOO_LARGE");
  await refused(8, {}, { maxRows: 10, expectedTotal: 7 }, "EXPORT_SELECTION_CHANGED");
  await refused(0, { ids: [id] }, { maxRows: 10 }, "EXPORT_SELECTION_EMPTY");
  await refused(0, { ids: [id] }, { maxRows: 10, expectedTotal: 1 }, "EXPORT_SELECTION_CHANGED");
  // The GET path (no expectedTotal, no ids) still streams an empty file, and a matching expectedTotal streams.
  for (const [total, options] of [[0, { maxRows: 10 }], [3, { maxRows: 10, expectedTotal: 3 }]] as const) {
    const client = new FakeExportClient([], total);
    const { store, pool } = exportStore([client]);
    const cursor = await store.openExport(tenant, {}, options);
    assert.equal(cursor.total, total);
    await cursor.close();
    await pool.end();
  }
  const client = new FakeExportClient([], 0);
  const { store, pool } = exportStore([client]);
  for (const bad of [-1, 1.5, Number.NaN, "3" as never]) {
    await assert.rejects(store.openExport(tenant, {}, { maxRows: 10, expectedTotal: bad }), { message: "INVALID_EXPORT_SELECTION" }, String(bad));
  }
  assert.deepEqual(client.queries, [], "a malformed expectedTotal never opens a transaction");
  await pool.end();
});

test("the export history methods refuse malformed input without touching the database", async () => {
  const pool = new Pool();
  const store = new PostgresOcrDocumentStore(pool);
  Object.assign(pool, { connect: async () => { throw new Error("database must not be used"); } });
  const tenant = "11111111-1111-4111-8111-111111111111";
  const user = "22222222-2222-4222-8222-222222222222", request = "33333333-3333-4333-8333-333333333333";
  const doc = "44444444-4444-4444-8444-444444444444";
  const record = { kind: "exported" as const, source: "csv" as const, actorUserId: user, requestId: request, rows: [{ documentId: doc, rowVersion: "2026-09-22T08:00:00.123456Z" }] };
  assert.equal(await store.recordExportMarks(tenant, { ...record, rows: [] }), 0, "nothing streamed, nothing written, no connection");
  for (const bad of [{ kind: "marked" }, { source: "manual" }, { actorUserId: "admin" }, { requestId: "forged-by-the-client" }, { rows: "x" },
    { rows: [{ documentId: "x", rowVersion: "2026-09-22T08:00:00.123456Z" }] },
    { rows: [{ documentId: doc, rowVersion: "2026-09-22T08:00:00.123Z" }] },
    { rows: [{ documentId: doc, rowVersion: "now()" }] }, { rows: [null] }]) {
    await assert.rejects(store.recordExportMarks(tenant, { ...record, ...bad } as never), { message: "EXPORT_MARK_INVALID" }, JSON.stringify(bad));
  }
  await assert.rejects(store.recordExportMarks("t", record), { message: "EXPORT_MARK_INVALID" });
  const change = { action: "mark" as const, filter: { ids: [doc] }, maxRows: 10, actorUserId: user, requestId: request };
  await assert.rejects(store.markExportState(tenant, { ...change, action: "delete" as never }), { message: "INVALID_EXPORT_SELECTION" });
  await assert.rejects(store.markExportState(tenant, { ...change, maxRows: Number.NaN }), { message: "EXPORT_MAX_ROWS_INVALID" });
  await assert.rejects(store.markExportState(tenant, { ...change, actorUserId: "admin" }), { message: "EXPORT_MARK_INVALID" });
  await assert.rejects(store.markExportState(tenant, { ...change, expectedTotal: -1 }), { message: "INVALID_EXPORT_SELECTION" });
  await assert.rejects(store.markExportState(tenant, { ...change, filter: { ids: ["x"] } }), { message: "INVALID_EXPORT_SELECTION" });
  await assert.rejects(store.markExportState(tenant, { ...change, filter: { exportState: "all" as never } }), { message: "INVALID_EXPORT_FILTER" });
  await assert.rejects(store.listExportCandidates(tenant, { exportState: "all" as never }), { message: "INVALID_EXPORT_FILTER" });
  await assert.rejects(store.listExportCandidates(tenant, { batchId: "x" }), { message: "BATCH_NOT_FOUND" });
  await pool.end();
});

test("H1: openExport and markExportState check an explicit selection's expected state in the count's own statement", async () => {
  const tenant = "11111111-1111-4111-8111-111111111111";
  const user = "22222222-2222-4222-8222-222222222222", request = "33333333-3333-4333-8333-333333333333";
  const [a, b] = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"];
  // [rows found, rows in the tab's state, expectState, expected outcome]
  const cases: [number, number, "never" | "exported" | null, string][] = [
    [2, 2, "never", "ok"], [2, 1, "never", "EXPORT_SELECTION_CHANGED"], [2, 1, "exported", "EXPORT_SELECTION_CHANGED"],
    [1, 1, "never", "EXPORT_SELECTION_CHANGED"], [1, 1, null, "EXPORT_SELECTION_CHANGED"], [2, 0, null, "ok"], [0, 0, "never", "EXPORT_SELECTION_EMPTY"]
  ];
  for (const [found, inState, expectState, outcome] of cases) {
    const label = `${found} found, ${inState} in state, expect ${String(expectState)}`;
    const client = new FakeExportClient([], found, undefined, inState);
    const { store, pool } = exportStore([client]);
    const opening = store.openExport(tenant, { ids: [a, b, a.toUpperCase()] }, { maxRows: 10, expectState });
    if (outcome === "ok") await (await opening).close(); else await assert.rejects(opening, { message: outcome }, label);
    const count = client.texts.find((text) => text.includes("count(*)"))!;
    // One statement: the same snapshot the cursor then reads. null (ทั้งหมด) needs no state predicate at all.
    assert.equal(count.includes("count(*) FILTER (WHERE COALESCE("), expectState !== null, label);
    assert.equal(client.texts.some((text) => text.startsWith("DECLARE")), outcome === "ok", `${label}: a cursor only when the selection still holds`);
    const flip = new FakeExportClient([], found, undefined, inState);
    const flips = exportStore([flip]);
    const change = flips.store.markExportState(tenant, { action: "mark", filter: { ids: [a, b] }, expectState, maxRows: 10, actorUserId: user, requestId: request });
    if (outcome === "ok") await change; else await assert.rejects(change, { message: outcome }, `marks: ${label}`);
    assert.equal(flip.texts.some((text) => text.startsWith("INSERT")), outcome === "ok", `marks: ${label}: nothing written on a refusal`);
    await pool.end();
    await flips.pool.end();
  }
  const pool = new Pool();
  Object.assign(pool, { connect: async () => { throw new Error("database must not be used"); } });
  const store = new PostgresOcrDocumentStore(pool);
  for (const [filter, expectState] of [[{ batchId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }, "never"], [{ ids: [a] }, "all"], [{ ids: [a] }, 1]] as const) {
    await assert.rejects(store.openExport(tenant, filter, { maxRows: 10, expectState: expectState as never }), { message: "INVALID_EXPORT_SELECTION" }, JSON.stringify([filter, expectState]));
    await assert.rejects(store.markExportState(tenant, { action: "unmark", filter, expectState: expectState as never, maxRows: 10, actorUserId: user, requestId: request }),
      { message: "INVALID_EXPORT_SELECTION" });
  }
  await pool.end();
});

test("M1: the two export-history writes bound their lock waits and statements transaction-locally", async () => {
  const tenant = "11111111-1111-4111-8111-111111111111";
  const user = "22222222-2222-4222-8222-222222222222", request = "33333333-3333-4333-8333-333333333333";
  const doc = "44444444-4444-4444-8444-444444444444";
  const bounds = (client: FakeExportClient) => client.queries.filter((query) => /set_config\('(statement_timeout|lock_timeout)'/.test(query.text))
    .map((query) => [/'(\w+)'/.exec(query.text)![1], query.values[0]]);
  const record = new FakeExportClient([], 0);
  const recorded = exportStore([record]);
  await recorded.store.recordExportMarks(tenant, { kind: "exported", source: "csv", actorUserId: user, requestId: request,
    rows: [{ documentId: doc, rowVersion: "2026-09-22T08:00:00.123456Z" }] });
  assert.deepEqual(bounds(record), [["statement_timeout", String(EXPORT_MARK_STATEMENT_TIMEOUT_MS)], ["lock_timeout", String(EXPORT_MARK_LOCK_TIMEOUT_MS)]]);
  assert.deepEqual([EXPORT_MARK_LOCK_TIMEOUT_MS, EXPORT_MARK_STATEMENT_TIMEOUT_MS], [5_000, 30_000]);
  const flip = new FakeExportClient([], 1);
  const flipped = exportStore([flip]);
  await flipped.store.markExportState(tenant, { action: "mark", filter: { ids: [doc] }, maxRows: 10, actorUserId: user, requestId: request });
  assert.equal(flip.texts[0], "BEGIN ISOLATION LEVEL REPEATABLE READ");
  assert.deepEqual(bounds(flip), [["statement_timeout", "30000"], ["lock_timeout", "5000"]]);
  // A lock that is not granted in time: pg cancels the statement (55P03), the transaction rolls back and the client goes back.
  const stuck = new FakeExportClient([], 1);
  const lockTimeout = Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
  const original = stuck.query.bind(stuck);
  Object.assign(stuck, { query: async (text: string, values?: readonly unknown[]) => { if (text.startsWith("INSERT")) { stuck.queries.push({ text, values: values ?? [] }); throw lockTimeout; } return original(text, values); } });
  const stuckStore = exportStore([stuck]);
  await assert.rejects(stuckStore.store.recordExportMarks(tenant, { kind: "exported", source: "jsonl", actorUserId: user, requestId: request,
    rows: [{ documentId: doc, rowVersion: "2026-09-22T08:00:00.123456Z" }] }), { code: "55P03" });
  assert.deepEqual([stuck.texts.at(-1), stuck.released], ["ROLLBACK", [false]], "rolled back, connection returned intact");
  await Promise.all([recorded.pool.end(), flipped.pool.end(), stuckStore.pool.end()]);
});
