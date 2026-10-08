/**
 * The export's HTTP half (plan §12): the CSV and JSONL writers, the streaming loop, the audit trail and the three
 * routes. Every fixture here is obviously fake.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { connect } from "node:net";
import { AuthenticationError, csrfTokenFor } from "@innovera/ocr-auth";
import type { WebConfig } from "@innovera/ocr-config";
import {
  EXPORT_COLUMNS, EXPORT_COLUMNS_DETAILED, normalizeStructuredResult, type AuditEvent, type DocumentFilter, type ExportCandidate, type ExportCandidatesPage,
  type ExportCandidatesResult, type ExportCursor, type ExportDocument, type ExportMarkInput, type ExportMarkResult,
  type ExportStateChangeInput, type OpenExportOptions
} from "@innovera/ocr-persistence";
import type { UserStore, WebAuthContext } from "./auth.js";
import { SlidingWindow } from "./auth.js";
import {
  bangkokOffsetIso, csvCell, csvRow, EXPORT_LIST_LIMIT, EXPORT_MARK_LIMIT, exportFilename, exportFormatLabel, ExportGate,
  guardFormula, handleExportRoutes, jsonlDocumentLine, csvDocumentRow, parseCandidatesQuery, parseExportBody, parseExportQuery, parseMarksBody, parseSelectionBody,
  PREVIEW_LIMIT, PREVIEW_WINDOW_MS, type ExportRouteDeps, type ExportStore
} from "./export.js";
import { createAppServer } from "./server.js";

const tenant = "00000000-0000-0000-0000-000000000001";
const userId = "00000000-0000-4000-8000-000000000001";
const sessionId = "00000000-0000-4000-8000-0000000000aa";
const otherUserId = "00000000-0000-4000-8000-000000000002";

const baseWebConfig: WebConfig = { tenantId: tenant, publicBaseUrl: "https://ocr.example.test", publicOrigin: "https://ocr.example.test", sessionIdleMinutes: 30, sessionAbsoluteHours: 12, exportMaxRows: 50_000 };

// ---- fixtures ---------------------------------------------------------------------------------

const field = (value: string | null) => ({ raw: value, value, confidence: 0.9, source: "ocr", needsReview: false });
/** A page of a split PDF: the ORIGINAL uploaded PDF's name, its own page number and the parent's count. */
function document(overrides: Partial<ExportDocument> = {}): ExportDocument {
  return {
    documentId: "11111111-1111-4111-8111-111111111111", batchId: null, batchLabel: null,
    filename: "page-002.png", parentFilename: "ใบลูกค้า 22-09-2026.pdf", parentDocumentId: "33333333-3333-4333-8333-333333333333",
    pageNumber: 2, pageCount: 5, status: "SUCCEEDED", statusCategory: "confirmed", needsReview: false, errorMessage: null,
    createdAt: "2026-09-22T07:05:00.000Z", processedAt: null, reviewedAt: null, reviewedBy: null, reviewedByName: null,
    deliveryStatus: "NONE", template: null,
    structuredResult: normalizeStructuredResult({ schemaVersion: 3, staffOnly: { roomNo: field("007"), therapistName: field("อันนา") } }),
    rowVersion: "2026-09-22T07:05:00.000000Z",
    ...overrides
  };
}

type Deferred = { promise: Promise<void>; resolve: () => void };
function deferred(): Deferred {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((settle) => { resolve = () => { settle(); }; });
  return { promise, resolve };
}

type StoreOptions = Readonly<{
  total?: number; pageSize?: number; failAfter?: number; gateBeforePage?: number; gate?: Deferred;
  openError?: string; previewTotal?: number; stopAfter?: number;
  /** `recordExportMarks` throws this (a pg-style lowercase message, so it is never a client code by itself). */
  markError?: string;
  /** `recordExportMarks` waits for this before it "commits" (a client can leave while the marks are being written). */
  markGate?: Deferred;
  /** `markExportState` throws this code, or answers `markResult`. */
  stateError?: string; markResult?: ExportMarkResult;
  candidates?: ExportCandidatesResult;
}>;
type FakeStore = ExportStore & {
  closed: number; opened: number; filters: DocumentFilter[]; maxRows: number[]; expectedTotals: (number | undefined)[];
  expectStates: OpenExportOptions["expectState"][];
  marks: ExportMarkInput[]; closedAtMark: number[]; stateCalls: ExportStateChangeInput[];
  listCalls: { filter: DocumentFilter; page: ExportCandidatesPage | undefined }[];
};

/**
 * A store that yields `total` identical rows in pages, and can stall or throw exactly where a test needs it to. Like
 * the real `openExport`, a POSTed "select all N" whose N differs is EXPORT_SELECTION_CHANGED and an explicit selection
 * that matches nothing is EXPORT_SELECTION_EMPTY, both before the cursor exists.
 */
function fakeStore(documents: readonly ExportDocument[], options: StoreOptions = {}): FakeStore {
  const state = {
    closed: 0, opened: 0, filters: [] as DocumentFilter[], maxRows: [] as number[], expectedTotals: [] as (number | undefined)[],
    expectStates: [] as OpenExportOptions["expectState"][],
    marks: [] as ExportMarkInput[], closedAtMark: [] as number[], stateCalls: [] as ExportStateChangeInput[],
    listCalls: [] as { filter: DocumentFilter; page: ExportCandidatesPage | undefined }[]
  };
  const total = options.total ?? documents.length;
  const pageSize = options.pageSize ?? Math.max(1, documents.length);
  return Object.assign(state, {
    previewExport: async (_tenantId: string, filter: DocumentFilter): Promise<{ total: number; documents: ExportDocument[] }> => {
      state.filters.push(filter);
      return { total: options.previewTotal ?? total, documents: [...documents] };
    },
    openExport: async (_tenantId: string, filter: DocumentFilter, open: OpenExportOptions): Promise<ExportCursor> => {
      state.filters.push(filter);
      state.maxRows.push(open.maxRows);
      state.expectedTotals.push(open.expectedTotal);
      state.expectStates.push(open.expectState);
      if (options.openError) throw new Error(options.openError);
      if (open.expectedTotal !== undefined && open.expectedTotal !== total) throw new Error("EXPORT_SELECTION_CHANGED");
      if (total === 0 && filter.ids !== undefined) throw new Error("EXPORT_SELECTION_EMPTY");
      state.opened += 1;
      let closed = false;
      const close = async (): Promise<void> => { if (!closed) { closed = true; state.closed += 1; } };
      async function* rows(): AsyncGenerator<ExportDocument[], void, undefined> {
        try {
          for (let sent = 0, page = 0; sent < total; page += 1) {
            if (options.gate && options.gateBeforePage === page) await options.gate.promise;
            // What the gate's 10-minute timer does: it closes the cursor while the generator is suspended, and the
            // loop then ends QUIETLY on the next turn.
            if (options.stopAfter !== undefined && sent >= options.stopAfter) { await close(); return; }
            if (options.failAfter !== undefined && sent >= options.failAfter) throw new Error("PG_STREAM_DIED");
            const size = Math.min(pageSize, total - sent);
            yield Array.from({ length: size }, (_unused, index) => documents[(sent + index) % documents.length]!);
            sent += size;
          }
        } finally { await close(); }
      }
      return { total, rows, close };
    },
    listExportCandidates: async (_tenantId: string, filter: DocumentFilter, page?: ExportCandidatesPage): Promise<ExportCandidatesResult> => {
      state.listCalls.push({ filter, page });
      return options.candidates ?? { total: 0, limit: page?.limit ?? 50, offset: page?.offset ?? 0, counts: { never: 0, exported: 0, all: 0, unconfirmed: 0 }, rows: [] };
    },
    recordExportMarks: async (_tenantId: string, input: ExportMarkInput): Promise<number> => {
      // How many cursors were closed when the marks were written: the export's connection must go back first.
      state.closedAtMark.push(state.closed);
      if (options.markGate) await options.markGate.promise;
      if (options.markError) throw new Error(options.markError);
      state.marks.push(input);
      return input.rows.length;
    },
    markExportState: async (_tenantId: string, input: ExportStateChangeInput): Promise<ExportMarkResult> => {
      state.stateCalls.push(input);
      if (options.stateError) throw new Error(options.stateError);
      return options.markResult ?? { total: 0, affected: 0, skipped: 0 };
    }
  });
}

/** Only `recordAudit` and `tenantId` are used by the export routes; everything else would be a bug in this file. */
function fakeUsers(audits: Omit<AuditEvent, "tenantId">[], failAudit?: string): UserStore {
  const unused = async (): Promise<never> => { throw new Error("USER_STORE_NOT_USED"); };
  return {
    tenantId: tenant,
    findLoginUser: unused, recordLoginFailure: unused, recordLoginSuccess: unused, createSession: unused,
    resolveSession: unused, touchSession: unused, revokeSession: unused, changeOwnPassword: unused, listUsers: unused,
    createUser: unused, updateUser: unused, resetPassword: unused, unlockUser: unused,
    recordAudit: async (event) => {
      // Lowercase on purpose: a pg failure is not a client-facing code, so it must surface as INTERNAL_ERROR.
      if (failAudit && event.action === failAudit) throw new Error("insert into audit_events failed");
      audits.push(event);
    }
  };
}

const context = (overrides: Partial<WebAuthContext> = {}): WebAuthContext => ({
  userId, tenantId: tenant, sessionId, username: "boss", displayName: "บอส", role: "admin", canExport: true,
  mustChangePassword: false, ...overrides
});

type App = Readonly<{ store: FakeStore; audits: Omit<AuditEvent, "tenantId">[]; server: Server }>;
/** `ctxFor` picks the signed-in user per request (a test header), for the cases that need two people at once. */
function app(store: FakeStore, options: { ctx?: WebAuthContext | null; webConfig?: Partial<WebConfig>; failAudit?: string;
  ctxFor?: (request: IncomingMessage) => WebAuthContext } = {}): App {
  const audits: Omit<AuditEvent, "tenantId">[] = [];
  const server = createAppServer(
    { ingest: { stage: async () => "key", scan: async () => "CLEAN", enqueue: async () => "job" }, userStore: fakeUsers(audits, options.failAudit), exportStore: store },
    {
      webConfig: { ...baseWebConfig, ...options.webConfig },
      authenticate: (request) => {
        if (options.ctx === null) throw new AuthenticationError("UNAUTHENTICATED");
        return options.ctxFor?.(request) ?? options.ctx ?? context();
      }
    });
  return { store, audits, server };
}

async function withServer(instance: App, run: (base: string) => Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => instance.server.listen(0, "127.0.0.1", resolve));
  const address = instance.server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  try { await run(`http://127.0.0.1:${port}`); }
  finally { await new Promise<void>((resolve) => instance.server.close(() => resolve())); }
}

const started = (instance: App) => instance.audits.filter((event) => event.action === "export.started");
/** `response.text()` strips a leading BOM, which is exactly what these cases are here to see. */
async function bodyText(response: Response): Promise<string> {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(await response.arrayBuffer());
}
/** The metric registry is one process-wide singleton, so a case asserts its own delta, never an absolute count. */
async function counter(base: string, pattern: RegExp): Promise<number> {
  const match = pattern.exec(await (await fetch(`${base}/metrics`)).text());
  return match ? Number(match[1]) : 0;
}
const tick = async (): Promise<void> => { for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setImmediate(resolve)); };

// ---- CSV encoding -----------------------------------------------------------------------------

test("the CSV is RFC 4180: CRLF rows, doubled quotes and Thai text untouched", () => {
  assert.equal(csvCell("ใบลูกค้า"), "ใบลูกค้า", "Thai needs no quoting: it holds no comma, quote or line break");
  assert.equal(csvCell('เขา "บอก" ว่า'), '"เขา ""บอก"" ว่า"');
  assert.equal(csvCell("นวดไทย, 90 นาที"), '"นวดไทย, 90 นาที"');
  assert.equal(csvCell("บรรทัด\r\nใหม่"), '"บรรทัด\r\nใหม่"');
  assert.equal(csvRow(["a", "b"]), "a,b\r\n");
});

test("the formula guard covers every text cell, file names included, and leaves numbers alone", () => {
  for (const dangerous of ["=cmd.pdf", "+1", "-5", "@x", "\tsneaky", "\rsneaky"]) {
    assert.equal(guardFormula(dangerous), `'${dangerous}`, dangerous);
  }
  assert.equal(guardFormula("007"), "007", "a leading zero is not a formula");
  assert.equal(guardFormula("ใบลูกค้า.pdf"), "ใบลูกค้า.pdf");
});

test("a CSV download carries exactly one BOM, the Thai header row and one CRLF row per document", async () => {
  const instance = app(fakeStore([document({ parentFilename: "=cmd.pdf" }), document({ parentFilename: 'มี "คำพูด", และจุลภาค.pdf' })]));
  await withServer(instance, async (base) => {
    const response = await fetch(`${base}/api/exports/documents.csv`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8");
    assert.match(response.headers.get("content-disposition") ?? "", /^attachment; filename="ocr-export-\d{8}-\d{4}\.csv"$/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-export-rows"), "2");
    const text = await bodyText(response);
    assert.equal(text.indexOf("\uFEFF"), 0);
    assert.equal(text.split("\uFEFF").length - 1, 1, "the BOM appears exactly once");
    const lines = text.slice(1).split("\r\n").filter(Boolean);
    assert.equal(lines.length, 3, "one header row and two document rows");
    assert.ok(lines[0]!.startsWith("ชื่อไฟล์ต้นฉบับ,หน้า,จำนวนหน้า,อัปโหลดเมื่อ,"), lines[0]);
    // A file legitimately called `=cmd.pdf` must not become a formula when the spa opens the export in Excel.
    assert.ok(lines[1]!.startsWith("'=cmd.pdf,2,5,2026-09-22 14:05:00,"), lines[1]);
    assert.ok(lines[2]!.startsWith('"มี ""คำพูด"", และจุลภาค.pdf",2,5,'), lines[2]);
    assert.ok(text.includes(",007,"), "a room number stays a text cell, never a number column");
  });
});

test("a CSV cell over 32,000 characters is cut, and headers=en names the columns by key", async () => {
  const long = "ก".repeat(40_000);
  const instance = app(fakeStore([document({ parentFilename: `${long}.pdf` })]));
  await withServer(instance, async (base) => {
    const text = await bodyText(await fetch(`${base}/api/exports/documents.csv?headers=en`));
    const lines = text.slice(1).split("\r\n").filter(Boolean);
    assert.ok(lines[0]!.startsWith("original_file_name,page,page_count,uploaded_at,"), lines[0]);
    const cell = lines[1]!.split(",")[0]!;
    assert.equal(cell.length, 32_000);
    assert.ok(cell.endsWith("…[ตัดทอน]"));
  });
});

// ---- JSONL ------------------------------------------------------------------------------------

test("JSONL is the lossless format: no BOM, no guard, no truncation, Bangkok offset beside the UTC instant", async () => {
  const long = "ก".repeat(40_000);
  const instance = app(fakeStore([document({ parentFilename: "=cmd.pdf" }), document({ parentFilename: `${long}.pdf`, pageNumber: null, pageCount: null, parentDocumentId: null })]));
  await withServer(instance, async (base) => {
    const response = await fetch(`${base}/api/exports/documents.jsonl`);
    assert.equal(response.headers.get("content-type"), "application/x-ndjson; charset=utf-8");
    assert.match(response.headers.get("content-disposition") ?? "", /filename="ocr-export-\d{8}-\d{4}\.jsonl"$/);
    const text = await bodyText(response);
    assert.ok(!text.includes("\uFEFF"), "no BOM: a JSON reader would choke on it");
    assert.ok(!text.includes("\r\n"), "lines are \\n-separated");
    const lines = text.split("\n").filter(Boolean);
    assert.equal(lines.length, 2);
    const rows = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(Object.keys(rows[0]!).slice(0, 4), ["original_file_name", "page", "page_count", "uploaded_at"]);
    assert.deepEqual([rows[0]!.original_file_name, rows[0]!.page, rows[0]!.page_count], ["=cmd.pdf", 2, 5],
      "unchanged: the guard and the string conversion belong to the CSV alone");
    assert.equal(rows[0]!.uploaded_at, "2026-09-22T14:05:00+07:00");
    assert.equal(rows[0]!.uploaded_at_utc, "2026-09-22T07:05:00.000Z");
    assert.equal(Date.parse(String(rows[0]!.uploaded_at)), Date.parse(String(rows[0]!.uploaded_at_utc)), "the pair is the same instant");
    assert.equal(String(rows[1]!.original_file_name).length, long.length + 4, "no 32,000-character cut here");
    assert.deepEqual([rows[1]!.page, rows[1]!.page_count], [null, null], "a single image gets null, not an empty string");
    assert.equal((rows[0]!.structured_result as { schemaVersion?: unknown }).schemaVersion, 3, "the canonical result travels whole");
  });
});

test("bangkokOffsetIso pairs the wall clock with its offset, and nothing with a bad instant", () => {
  assert.equal(bangkokOffsetIso("2026-09-22T07:05:00.000Z"), "2026-09-22T14:05:00+07:00");
  assert.equal(bangkokOffsetIso(null), null);
  assert.equal(bangkokOffsetIso("not a date"), null);
});

// ---- streaming, aborts and audit --------------------------------------------------------------

test("10,000 rows stream through drain without buffering the file, and export_rows_total counts them", async () => {
  const instance = app(fakeStore([document()], { total: 10_000, pageSize: 500 }));
  await withServer(instance, async (base) => {
    const ROWS = /export_rows_total\{format="csv"\} (\d+)/;
    const OK = /exports_total\{format="csv",result="ok"\} (\d+)/;
    const before = [await counter(base, ROWS), await counter(base, OK)];
    const text = await bodyText(await fetch(`${base}/api/exports/documents.csv`));
    assert.equal(text.slice(1).split("\r\n").filter(Boolean).length, 10_001);
    assert.equal(instance.store.closed, 1, "the cursor is closed exactly once");
    const completed = instance.audits.find((event) => event.action === "export.completed");
    assert.deepEqual([completed?.detail?.rows, completed?.detail?.complete], [10_000, true]);
    assert.deepEqual([await counter(base, ROWS) - before[0]!, await counter(base, OK) - before[1]!], [10_000, 1]);
  });
});

test("export.started is committed before the first byte, and survives a stream that dies", async () => {
  const instance = app(fakeStore([document()], { total: 10, pageSize: 1, failAfter: 3 }));
  await withServer(instance, async (base) => {
    // The response has already begun, so the socket is destroyed: the browser's blob() rejects and no file is saved.
    await assert.rejects(fetch(`${base}/api/exports/documents.csv`).then((response) => response.text()));
    assert.equal(started(instance).length, 1, "the row that answers 'who exported' is there even though nothing completed");
    assert.deepEqual(started(instance)[0]!.detail?.rows, 10);
    assert.equal(started(instance)[0]!.targetType, "export");
    const failed = instance.audits.find((event) => event.action === "export.failed");
    assert.equal(failed?.outcome, "failure");
    assert.deepEqual([failed?.detail?.complete, failed?.detail?.rows], [false, 3]);
    assert.equal(instance.store.closed, 1, "the connection goes back whatever happened");
    assert.ok(!instance.audits.some((event) => event.action === "export.completed"));
  });
});

test("a cursor that ends early never hands over a truncated file with a 200", async () => {
  const instance = app(fakeStore([document()], { total: 10, pageSize: 1, stopAfter: 4 }));
  await withServer(instance, async (base) => {
    await assert.rejects(fetch(`${base}/api/exports/documents.csv`).then((response) => response.arrayBuffer()),
      "the socket is destroyed, so the browser saves nothing");
    const failed = instance.audits.find((event) => event.action === "export.failed");
    assert.deepEqual([failed?.detail?.rows, failed?.detail?.complete], [4, false]);
    assert.ok(!instance.audits.some((event) => event.action === "export.completed"),
      "the count and the cursor share one snapshot: 4 of 10 rows means something ended it early");
  });
});

test("a client that walks away runs the generator's finally and still leaves export.started", async () => {
  const gate = deferred();
  const instance = app(fakeStore([document()], { total: 4, pageSize: 1, gate, gateBeforePage: 1 }));
  await withServer(instance, async (base) => {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/exports/documents.csv`, { signal: controller.signal });
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await tick();
    gate.resolve(); // the generator wakes up to a socket that is gone
    await tick();
    assert.equal(instance.store.closed, 1, "the pooled connection is released by the generator's finally");
    assert.equal(started(instance).length, 1);
    const failed = instance.audits.find((event) => event.action === "export.failed")!;
    // The metric bucket AND the code: `aborted` alone cannot tell a statement timeout from a client walking away.
    assert.deepEqual([failed.detail?.result, failed.detail?.error], ["aborted", "EXPORT_ABORTED"]);
  });
});

test("the terminal audit rows say what was asked for, not just how it ended", async () => {
  const instance = app(fakeStore([document()], { total: 2 }));
  await withServer(instance, async (base) => {
    const query = "columns=detailed&headers=en&status=confirmed&q=somchai&dateField=reviewed_at&from=2026-09-01&to=2026-09-22";
    await bodyText(await fetch(`${base}/api/exports/documents.csv?${query}`));
    const completed = instance.audits.find((event) => event.action === "export.completed")!;
    // §10 H5: the filters live on the terminal row too, so "which export was that?" needs no join back to
    // `export.started` on request_id — the row a crash may be the only survivor of.
    assert.deepEqual(completed.detail, {
      columns: "detailed", headers: "en", date_field: "reviewed_at", statuses: "confirmed", confirmed_only: false,
      from: "2026-09-01", to: "2026-09-22", batch_id: null, parent_id: null, has_q: true,
      // 0021 (§7): the Release 2 GET is its own selection kind and never marks.
      selection: "filter_get", requested: null, export_state: null, marked: 0, mark: false,
      format: "csv", rows: 2, complete: true, duration_ms: completed.detail?.duration_ms
    });
    assert.equal(completed.detail?.q, undefined, "the search text itself is customer data, never the filter value");
  });
});

test("the wall clock ends a download stuck on drain, and gives the user's slot back", async () => {
  // A client that stops reading but keeps the socket open: response.write() returns false and the route parks on
  // 'drain', a promise only 'close' can settle. Closing the cursor alone would leave the gate slot and the socket
  // held, and every later export by that account would answer 429 EXPORT_BUSY until the container restarted.
  const store = fakeStore([document()], { total: 200_000, pageSize: 500 });
  const audits: Omit<AuditEvent, "tenantId">[] = [];
  const gate = new ExportGate();
  const tenantGate = new ExportGate(1);
  const deps = {
    store, users: fakeUsers(audits), gate, tenantGate, previewLimit: new SlidingWindow(PREVIEW_LIMIT, PREVIEW_WINDOW_MS),
    listLimit: new SlidingWindow(EXPORT_LIST_LIMIT, PREVIEW_WINDOW_MS), markLimit: new SlidingWindow(EXPORT_MARK_LIMIT, PREVIEW_WINDOW_MS),
    maxRows: 500_000, publicBaseUrl: "https://ocr.example.test", traceId: "t-1", now: Date.now, wallClockMs: 60
  };
  const server = createServer((request, response) => {
    void handleExportRoutes(request, response, new URL(request.url ?? "/", "http://127.0.0.1"), request.method ?? "GET", context(), deps)
      .catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const client = connect(port, "127.0.0.1");
  try {
    // A raw socket that sends the request and never reads the answer, so the kernel buffers fill and stay full.
    client.pause();
    await new Promise<void>((resolve) => client.on("connect", () => resolve()));
    client.write("GET /api/exports/documents.csv HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    for (let waited = 0; waited < 200 && gate.size === 0; waited += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(gate.size, 1, "the download holds this user's one slot");
    for (let waited = 0; waited < 300 && gate.size > 0; waited += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(gate.size, 0, "the wall clock released the slot, so the next export is not 429 EXPORT_BUSY for ever");
    assert.equal(store.closed, 1, "and the pooled connection went back with it");
    await tick();
    const failed = audits.find((event) => event.action === "export.failed")!;
    assert.deepEqual([failed.detail?.result, failed.detail?.error, failed.detail?.complete], ["aborted", "EXPORT_TIMEOUT", false]);
  } finally {
    client.destroy();
    await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  }
});

test("an audit store that refuses export.started stops the export before a single byte leaves", async () => {
  const instance = app(fakeStore([document()], { total: 3 }), { failAudit: "export.started" });
  await withServer(instance, async (base) => {
    const response = await fetch(`${base}/api/exports/documents.csv`);
    assert.equal(response.status, 500, "no audit row, no file");
    assert.deepEqual(await response.json(), { error: "INTERNAL_ERROR" });
    assert.equal(instance.store.closed, 1);
  });
});

// ---- the gate and the limits ------------------------------------------------------------------

test("ExportGate allows one open download per user and gives the slot back once", () => {
  const gate = new ExportGate();
  const release = gate.acquire(userId);
  assert.ok(release);
  assert.equal(gate.acquire(userId), null, "the same user cannot hold two");
  const other = gate.acquire(otherUserId);
  assert.ok(other, "a different user is unaffected");
  release();
  release();
  assert.equal(gate.size, 1, "a double release does not free someone else's slot");
  assert.ok(gate.acquire(userId));
});

test("a second concurrent download by the same user is 429 EXPORT_BUSY, and the slot comes back", async () => {
  const gate = deferred();
  const instance = app(fakeStore([document()], { total: 2, pageSize: 1, gate, gateBeforePage: 1 }));
  await withServer(instance, async (base) => {
    const first = fetch(`${base}/api/exports/documents.csv`).then((response) => response.text());
    await tick();
    const second = await fetch(`${base}/api/exports/documents.jsonl`);
    assert.equal(second.status, 429);
    assert.deepEqual(await second.json(), { error: "EXPORT_BUSY" });
    assert.equal(second.headers.get("retry-after"), "30");
    gate.resolve();
    await first;
    await tick();
    assert.equal((await fetch(`${base}/api/exports/documents.csv`)).status, 200, "the slot was released");
  });
});

test("EXPORT_TOO_LARGE is a clean 400 with no headers written, and the cap is the configured one", async () => {
  const instance = app(fakeStore([], { openError: "EXPORT_TOO_LARGE" }), { webConfig: { exportMaxRows: 1_000 } });
  await withServer(instance, async (base) => {
    const response = await fetch(`${base}/api/exports/documents.csv`);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "EXPORT_TOO_LARGE" });
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    assert.deepEqual(instance.store.maxRows, [1_000], "the route passes the validated config value, never a raw env read");
    assert.equal(started(instance).length, 0, "nothing was exported, so nothing is recorded as started");
    assert.ok(await counter(base, /exports_total\{format="csv",result="too_large"\} (\d+)/) >= 1);
  });
});

test("the preview is audited, bounded to 60 a quarter of an hour, and renders the file's own cells", async () => {
  const instance = app(fakeStore([document()], { previewTotal: 3 }));
  await withServer(instance, async (base) => {
    const response = await fetch(`${base}/api/exports/preview?status=confirmed,review&dateField=reviewed_at&from=2026-09-01&to=2026-09-22`);
    assert.equal(response.status, 200);
    const payload = await response.json() as { columns: { key: string; label: string }[]; total: number; maxRows: number; rows: string[][] };
    assert.deepEqual(payload.columns.slice(0, 4).map((column) => [column.key, column.label]), [
      ["original_file_name", "ชื่อไฟล์ต้นฉบับ"], ["page", "หน้า"], ["page_count", "จำนวนหน้า"], ["uploaded_at", "อัปโหลดเมื่อ"]]);
    assert.deepEqual([payload.total, payload.maxRows], [3, 50_000]);
    // Exactly what the file would hold: `2`, not the UI's `หน้า 2/5`.
    assert.deepEqual(payload.rows[0]!.slice(0, 4), ["ใบลูกค้า 22-09-2026.pdf", "2", "5", "2026-09-22 14:05:00"]);
    const previewed = instance.audits.find((event) => event.action === "export.previewed");
    assert.deepEqual([previewed?.detail?.format, previewed?.detail?.rows, previewed?.detail?.has_q], ["preview", 3, false]);
    assert.deepEqual([previewed?.detail?.statuses, previewed?.detail?.date_field], ["confirmed,review", "reviewed_at"]);
    for (let call = 1; call < 60; call += 1) assert.equal((await fetch(`${base}/api/exports/preview`)).status, 200, `call ${call}`);
    const throttled = await fetch(`${base}/api/exports/preview`);
    assert.equal(throttled.status, 429);
    assert.deepEqual(await throttled.json(), { error: "EXPORT_THROTTLED" });
    assert.equal(throttled.headers.get("retry-after"), "900");
  });
});

test("the search text never reaches an audit row, only the fact that there was one", async () => {
  const instance = app(fakeStore([document()]));
  await withServer(instance, async (base) => {
    await fetch(`${base}/api/exports/preview?q=${encodeURIComponent("สมชาย ใจดี")}`);
    const previewed = instance.audits.find((event) => event.action === "export.previewed")!;
    assert.equal(previewed.detail?.has_q, true);
    assert.ok(!JSON.stringify(previewed.detail).includes("สมชาย"), "a customer name is not audit metadata");
    assert.equal(instance.store.filters[0]!.q, "สมชาย ใจดี", "but the store still gets it");
  });
});

// ---- the query parser and the routes ----------------------------------------------------------

test("parseExportQuery is strict, and every bad value is one error code", () => {
  const params = (query: string) => new URLSearchParams(query);
  assert.deepEqual(parseExportQuery(params("")), { columns: "detailed", headers: "th" }, "the full set is the default");
  assert.deepEqual(parseExportQuery(params("columns=compact")), { columns: "compact", headers: "th" }, "สรุป is still one parameter away");
  assert.deepEqual(parseExportQuery(params("columns=%20")), { columns: "detailed", headers: "th" }, "blank is the default too");
  assert.deepEqual(parseExportQuery(params("status=review,failed,review&confirmedOnly=1&dateField=reviewed_at&from=2026-09-01&to=2026-09-22&columns=detailed&headers=en&batchId=22222222-2222-4222-8222-222222222222")), {
    status: ["review", "failed"], confirmedOnly: true, dateField: "reviewed_at", from: "2026-09-01", to: "2026-09-22",
    batchId: "22222222-2222-4222-8222-222222222222", columns: "detailed", headers: "en"
  });
  assert.equal(parseExportQuery(params("confirmedOnly=0")).confirmedOnly, undefined);
  for (const bad of ["status=nope", "status=review,nope", "dateField=id", "columns=all", "headers=de", "confirmedOnly=yes",
    "batchId=not-a-uuid", "parentId=not-a-uuid", `q=${"x".repeat(101)}`, "q=a%00b",
    "from=22-09-2026", "to=2026-13-01", "to=2026-02-31", "from=2026-09-22&to=2026-09-21"]) {
    assert.throws(() => parseExportQuery(params(bad)), { message: "INVALID_EXPORT_FILTER" }, bad);
  }
});

test("a bad filter is 400 INVALID_EXPORT_FILTER, before the store is touched", async () => {
  const instance = app(fakeStore([document()]));
  await withServer(instance, async (base) => {
    for (const path of ["/api/exports/preview?status=nope", "/api/exports/documents.csv?to=2026-13-01", "/api/exports/documents.jsonl?columns=all"]) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 400, path);
      assert.deepEqual(await response.json(), { error: "INVALID_EXPORT_FILTER" }, path);
    }
    assert.deepEqual([instance.store.opened, instance.audits.length], [0, 0]);
  });
});

test("the export routes need a session, and a staff account without can_export is refused", async () => {
  const anonymous = app(fakeStore([document()]), { ctx: null });
  await withServer(anonymous, async (base) => {
    for (const path of ["/api/exports/preview", "/api/exports/documents.csv", "/api/exports/documents.jsonl"]) {
      assert.equal((await fetch(`${base}${path}`)).status, 401, path);
    }
  });
  const staff = app(fakeStore([document()]), { ctx: context({ role: "staff", canExport: false }) });
  await withServer(staff, async (base) => {
    const FORBIDDEN = /exports_total\{format="csv",result="forbidden"\} (\d+)/;
    const before = await counter(base, FORBIDDEN);
    for (const path of ["/api/exports/preview", "/api/exports/documents.csv", "/api/exports/documents.jsonl"]) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 403, path);
      assert.deepEqual(await response.json(), { error: "FORBIDDEN" }, path);
    }
    assert.equal(staff.store.opened, 0);
    // §13 lists `result="forbidden"`, and the right is checked in authorize() before the handler is entered — so the
    // counter has to be raised from the denial itself or the dashboard panel is "No data" for ever.
    assert.equal(await counter(base, FORBIDDEN) - before, 1);
    assert.ok(await counter(base, /exports_total\{format="preview",result="forbidden"\} (\d+)/) >= 1);
    assert.ok(await counter(base, /exports_total\{format="jsonl",result="forbidden"\} (\d+)/) >= 1);
  });
});

test("exportFormatLabel names the five export routes and nothing else", () => {
  assert.deepEqual(["/api/exports/preview", "/api/exports/documents.csv", "/api/exports/documents.jsonl", "/api/exports/candidates",
    "/api/exports/marks"].map(exportFormatLabel), ["preview", "csv", "jsonl", "candidates", "marks"]);
  for (const path of ["/api/documents", "/api/exports", "/api/exports/documents.txt", "/api/exports/marks/x", "unmatched"]) {
    assert.equal(exportFormatLabel(path), null, path);
  }
});

test("a throttled preview is its own metric bucket, not the download gate's", async () => {
  // 429 EXPORT_BUSY (Retry-After 30) and 429 EXPORT_THROTTLED (Retry-After 900) have different remedies, so an
  // operator watching `busy` climb must not be looking at preview throttling.
  const instance = app(fakeStore([document()]));
  await withServer(instance, async (base) => {
    const THROTTLED = /exports_total\{format="preview",result="throttled"\} (\d+)/;
    const before = await counter(base, THROTTLED);
    for (let call = 0; call < PREVIEW_LIMIT; call += 1) await fetch(`${base}/api/exports/preview`);
    assert.equal((await fetch(`${base}/api/exports/preview`)).status, 429);
    assert.equal(await counter(base, THROTTLED) - before, 1);
  });
});

test("a preview that cannot be audited returns no rows at all", async () => {
  // §10 H1: the preview is the export's own paging API — the full column set for any filter, 20 rows a call — so
  // `export.previewed` is as load-bearing as `export.started`, and a failed write must fail the request.
  const instance = app(fakeStore([document()], { previewTotal: 500 }), { failAudit: "export.previewed" });
  await withServer(instance, async (base) => {
    const response = await fetch(`${base}/api/exports/preview`);
    assert.equal(response.status, 500, "no audit row, no customer rows");
    assert.deepEqual(await response.json(), { error: "INTERNAL_ERROR" });
  });
});

test("exportFilename is ASCII, Bangkok-timed and carries no client input", () => {
  assert.equal(exportFilename("csv", Date.parse("2026-09-22T07:05:00.000Z")), "ocr-export-20260922-1405.csv");
  assert.equal(exportFilename("jsonl", Date.parse("2026-09-22T17:00:00.000Z")), "ocr-export-20260923-0000.jsonl");
  assert.doesNotMatch(exportFilename("csv", Date.now()), /[^\x20-\x7E]/, "nothing here can split a response header");
});

// ---- export selection (0021): parsers -------------------------------------------------------------

/** Obviously fake ids: the row number is the last group, so a failing assertion names the row. */
const docId = (n: number): string => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
const idList = (count: number): string[] => Array.from({ length: count }, (_unused, index) => docId(index + 1));
/** `count` different documents, each with its own exact-microsecond snapshot (the value that must reach the marks). */
const distinctDocuments = (count: number): ExportDocument[] => idList(count).map((documentId, index) =>
  document({ documentId, rowVersion: `2026-09-22T07:05:00.${String(index + 1).padStart(6, "0")}Z` }));

test("parseSelectionBody: ids are 1..5,000 distinct UUIDs, filter mode needs expectedTotal, and unknown keys are refused", () => {
  const upper = docId(1).toUpperCase();
  assert.deepEqual(parseSelectionBody({ mode: "ids", ids: [upper, docId(1), docId(2)], expectState: "never" }, 50_000), { mode: "ids", ids: [docId(1), docId(2)], expectState: "never" },
    "lower-cased and de-duplicated");
  assert.deepEqual(parseSelectionBody({ mode: "ids", ids: [...idList(5000), docId(1)], expectState: "never" }, 50_000).mode, "ids", "5,000 distinct after de-dup is fine");
  // H1: the tab the rows were ticked in; null is "ทั้งหมด" (every id must still be there, in either state).
  for (const expectState of ["exported", null] as const) {
    assert.deepEqual(parseSelectionBody({ mode: "ids", ids: [docId(1)], expectState }, 50_000), { mode: "ids", ids: [docId(1)], expectState });
  }
  assert.deepEqual(parseSelectionBody({ mode: "filter", filter: {}, expectedTotal: 0 }, 50_000), { mode: "filter", filter: {}, expectedTotal: 0 });
  assert.deepEqual(parseSelectionBody({
    mode: "filter", expectedTotal: 12, filter: { status: ["review", "failed"], q: "  สมชาย ", batchId: "22222222-2222-4222-8222-222222222222",
      confirmedOnly: true, dateField: "reviewed_at", from: "2026-09-01", to: "2026-09-22", exportState: "never" }
  }, 50_000), {
    mode: "filter", expectedTotal: 12, filter: { status: ["review", "failed"], q: "สมชาย", batchId: "22222222-2222-4222-8222-222222222222",
      confirmedOnly: true, dateField: "reviewed_at", from: "2026-09-01", to: "2026-09-22", exportState: "never" }
  });
  assert.deepEqual(parseSelectionBody({ mode: "filter", filter: { confirmedOnly: false, status: [] }, expectedTotal: 3 }, 50_000).mode, "filter");
  const shape: [string, unknown][] = [
    ["not an object", "ids"], ["array", [docId(1)]], ["null", null], ["no mode", { ids: [docId(1)] }], ["unknown mode", { mode: "all" }],
    ["empty ids", { mode: "ids", ids: [], expectState: "never" }], ["ids not an array", { mode: "ids", ids: docId(1), expectState: "never" }], ["non-uuid id", { mode: "ids", ids: ["nope"], expectState: "never" }],
    ["number id", { mode: "ids", ids: [1], expectState: "never" }], ["5,001 distinct", { mode: "ids", ids: idList(5001), expectState: "never" }],
    ["extra key in ids mode", { mode: "ids", ids: [docId(1)], expectState: "never", filter: {} }],
    // H1: required, not defaulted; only the two tab states or null.
    ["ids without expectState", { mode: "ids", ids: [docId(1)] }], ["expectState all", { mode: "ids", ids: [docId(1)], expectState: "all" }],
    ["expectState marked", { mode: "ids", ids: [docId(1)], expectState: "marked" }], ["expectState not a string", { mode: "ids", ids: [docId(1)], expectState: 1 }],
    ["expectState in filter mode", { mode: "filter", filter: {}, expectedTotal: 1, expectState: "never" }],
    ["missing expectedTotal", { mode: "filter", filter: {} }], ["string expectedTotal", { mode: "filter", filter: {}, expectedTotal: "3" }],
    ["fractional expectedTotal", { mode: "filter", filter: {}, expectedTotal: 1.5 }], ["negative expectedTotal", { mode: "filter", filter: {}, expectedTotal: -1 }],
    ["expectedTotal above maxRows", { mode: "filter", filter: {}, expectedTotal: 50_001 }], ["missing filter", { mode: "filter", expectedTotal: 1 }],
    ["filter not an object", { mode: "filter", filter: "status=review", expectedTotal: 1 }],
    ["unknown filter key", { mode: "filter", filter: { ids: [docId(1)] }, expectedTotal: 1 }],
    ["status not an array", { mode: "filter", filter: { status: "review" }, expectedTotal: 1 }],
    ["confirmedOnly not a boolean", { mode: "filter", filter: { confirmedOnly: 1 }, expectedTotal: 1 }],
    ["q not a string", { mode: "filter", filter: { q: 5 }, expectedTotal: 1 }], ["null value", { mode: "filter", filter: { batchId: null }, expectedTotal: 1 }]
  ];
  for (const [name, value] of shape) assert.throws(() => parseSelectionBody(value, 50_000), { message: "INVALID_EXPORT_SELECTION" }, name);
  const values: [string, Record<string, unknown>][] = [
    ["status value", { status: ["nope"] }], ["status with a comma", { status: ["review,failed"] }], ["bad batch id", { batchId: "x" }],
    ["long q", { q: "x".repeat(101) }], ["bad date", { from: "2026-13-01" }], ["inverted range", { from: "2026-09-22", to: "2026-09-21" }],
    ["bad date field", { dateField: "id" }], ["exportState all", { exportState: "all" }]
  ];
  for (const [name, filter] of values) {
    assert.throws(() => parseSelectionBody({ mode: "filter", filter, expectedTotal: 1 }, 50_000), { message: "INVALID_EXPORT_FILTER" }, name);
  }
});

test("parseExportBody and parseMarksBody: defaults, strict keys, and the GET's own error for a bad column set", () => {
  const ids = { mode: "ids", ids: [docId(1)], expectState: "never" };
  assert.deepEqual(parseExportBody({ selection: ids }, 50_000), { columns: "detailed", headers: "th", selection: { mode: "ids", ids: [docId(1)], expectState: "never" } });
  assert.deepEqual(parseExportBody({ columns: "compact", selection: ids }, 50_000).columns, "compact", "an explicit compact is honoured");
  assert.deepEqual(parseExportBody({ columns: "", selection: ids }, 50_000).columns, "detailed");
  assert.deepEqual(parseExportBody({ columns: "detailed", headers: "en", selection: ids }, 50_000).columns, "detailed");
  assert.throws(() => parseExportBody({ columns: "all", selection: ids }, 50_000), { message: "INVALID_EXPORT_FILTER" });
  assert.throws(() => parseExportBody({ headers: "de", selection: ids }, 50_000), { message: "INVALID_EXPORT_FILTER" });
  for (const value of [{ columns: 1, selection: ids }, { selection: ids, format: "csv" }, {}, { selection: null }, []]) {
    assert.throws(() => parseExportBody(value, 50_000), { message: "INVALID_EXPORT_SELECTION" }, JSON.stringify(value));
  }
  assert.deepEqual(parseMarksBody({ action: "unmark", selection: ids }, 50_000), { action: "unmark", selection: { mode: "ids", ids: [docId(1)], expectState: "never" } });
  for (const value of [{ action: "delete", selection: ids }, { selection: ids }, { action: "mark" }, { action: "mark", selection: ids, extra: true }]) {
    assert.throws(() => parseMarksBody(value, 50_000), { message: "INVALID_EXPORT_SELECTION" }, JSON.stringify(value));
  }
});

test("parseCandidatesQuery pages strictly, and every export query now understands exportState", () => {
  const params = (query: string) => new URLSearchParams(query);
  assert.deepEqual(parseCandidatesQuery(params("")), { filter: {}, limit: 50, offset: 0 });
  assert.deepEqual(parseCandidatesQuery(params("exportState=exported&status=review&limit=500&offset=1000000")),
    { filter: { status: ["review"], exportState: "exported" }, limit: 500, offset: 1_000_000 });
  for (const bad of ["limit=0", "limit=501", "limit=-1", "limit=1.5", "limit=ten", "offset=1000001", "offset=-1", "exportState=all", "status=nope"]) {
    assert.throws(() => parseCandidatesQuery(params(bad)), { message: "INVALID_EXPORT_FILTER" }, bad);
  }
  assert.equal(parseExportQuery(params("exportState=never")).exportState, "never", "the GET download accepts it too (and still never marks)");
  assert.throws(() => parseExportQuery(params("exportState=marked")), { message: "INVALID_EXPORT_FILTER" });
});

// ---- export selection (0021): POST download -------------------------------------------------------

/** The cookie and the token `assertCsrfToken` checks; `authenticate` is the test seam, so any well-formed token works. */
const SESSION = "Mp7xk2Qw9ZbF4nLc8TvRy1DgH6sJuA0eXiVoP3rYkNs";
const POST_HEADERS = { cookie: `ocr_session=${SESSION}`, "sec-fetch-site": "same-origin", "x-csrf-token": csrfTokenFor(SESSION), "content-type": "application/json" };
function post(base: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${path}`, { method: "POST", headers: { ...POST_HEADERS, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
}

test("an explicit selection exports exactly those ids and marks every streamed row once, after the stream and the cursor", async () => {
  const instance = app(fakeStore(distinctDocuments(3), { pageSize: 2 }));
  await withServer(instance, async (base) => {
    const MARKS = /export_marks_total\{kind="exported",result="ok"\} (\d+)/;
    const MARKED_ROWS = /export_marked_rows_total\{kind="exported"\} (\d+)/;
    const before = [await counter(base, MARKS), await counter(base, MARKED_ROWS)];
    const response = await post(base, "/api/exports/documents.csv",
      { columns: "compact", headers: "th", selection: { mode: "ids", ids: [docId(1).toUpperCase(), docId(2), docId(3), docId(2)], expectState: "never" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-export-selection"), "ids");
    assert.equal(response.headers.get("x-export-rows"), "3");
    const text = await bodyText(response);
    assert.equal(text.slice(1).split("\r\n").filter(Boolean).length, 4, "header row plus the three selected rows");
    assert.ok(!text.includes("2026-09-22T07:05:00.000001Z"), "the snapshot travels to the marks, never into the file");
    // D6: the ticked rows and nothing else; tenant and visibility are the store's.
    assert.deepEqual(instance.store.filters, [{ ids: [docId(1), docId(2), docId(3)] }]);
    assert.deepEqual(instance.store.expectedTotals, [undefined]);
    assert.deepEqual(instance.store.expectStates, ["never"], "H1: the tab the rows were ticked in reaches the snapshot check");
    assert.equal(instance.store.marks.length, 1, "one recordExportMarks call per download");
    const marks = instance.store.marks[0]!;
    assert.deepEqual([marks.kind, marks.source, marks.actorUserId], ["exported", "csv", userId]);
    assert.match(marks.requestId, /^[0-9a-f-]{36}$/, "the server-minted trace id, which also stamps the audit rows");
    assert.deepEqual(marks.rows, [
      { documentId: docId(1), rowVersion: "2026-09-22T07:05:00.000001Z" }, { documentId: docId(2), rowVersion: "2026-09-22T07:05:00.000002Z" },
      { documentId: docId(3), rowVersion: "2026-09-22T07:05:00.000003Z" }]);
    assert.deepEqual(instance.store.closedAtMark, [1], "the export's cursor went back before the marks took a connection");
    const startedRow = started(instance)[0]!;
    const completed = instance.audits.find((event) => event.action === "export.completed")!;
    assert.deepEqual([startedRow.detail?.selection, startedRow.detail?.requested, startedRow.detail?.export_state], ["ids", 3, null]);
    assert.deepEqual([completed.detail?.rows, completed.detail?.marked, completed.detail?.mark, completed.detail?.complete], [3, 3, true, true]);
    for (const event of instance.audits) assert.ok(!JSON.stringify(event.detail).includes("aaaaaaaa-"), `${event.action}: counts only, never ids`);
    assert.deepEqual([await counter(base, MARKS) - before[0]!, await counter(base, MARKED_ROWS) - before[1]!], [1, 3]);
  });
});

test("select all N: the filter and N reach the store, JSONL marks with source jsonl, and the audit names the selection", async () => {
  const instance = app(fakeStore(distinctDocuments(2)));
  await withServer(instance, async (base) => {
    const response = await post(base, "/api/exports/documents.jsonl",
      { selection: { mode: "filter", filter: { status: ["review"], q: "สมชาย", exportState: "never" }, expectedTotal: 2 } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-export-selection"), "filter");
    assert.equal((await bodyText(response)).split("\n").filter(Boolean).length, 2);
    assert.deepEqual(instance.store.filters, [{ status: ["review"], q: "สมชาย", exportState: "never" }]);
    assert.deepEqual(instance.store.expectedTotals, [2]);
    assert.deepEqual(instance.store.expectStates, [undefined], "a filter selection is pinned by expectedTotal instead");
    assert.deepEqual([instance.store.marks[0]?.source, instance.store.marks[0]?.rows.length], ["jsonl", 2]);
    const completed = instance.audits.find((event) => event.action === "export.completed")!;
    assert.deepEqual([completed.detail?.selection, completed.detail?.requested, completed.detail?.export_state, completed.detail?.has_q],
      ["filter", 2, "never", true]);
    assert.ok(!JSON.stringify(instance.audits).includes("สมชาย"), "the search text is never audit metadata");
  });
});

test("a moved count is 409 EXPORT_SELECTION_CHANGED and a vanished selection 400 EXPORT_SELECTION_EMPTY, both before any byte or mark", async () => {
  const changed = app(fakeStore(distinctDocuments(3)));
  await withServer(changed, async (base) => {
    const response = await post(base, "/api/exports/documents.csv", { selection: { mode: "filter", filter: {}, expectedTotal: 2 } });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "EXPORT_SELECTION_CHANGED" });
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8", "no file headers were written");
    assert.deepEqual([changed.store.marks.length, started(changed).length], [0, 0]);
    assert.equal(changed.audits.find((event) => event.action === "export.failed")?.detail?.error, "EXPORT_SELECTION_CHANGED");
  });
  const empty = app(fakeStore([], { total: 0 }));
  await withServer(empty, async (base) => {
    const response = await post(base, "/api/exports/documents.csv", { selection: { mode: "ids", ids: [docId(9)], expectState: "never" } });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "EXPORT_SELECTION_EMPTY" });
    assert.deepEqual([empty.store.marks.length, started(empty).length], [0, 0]);
  });
});

test("no marks unless the stream completed: a dead stream, a truncated cursor, a failed open and a client that left", async () => {
  const selection = { selection: { mode: "ids", ids: idList(10), expectState: "never" } };
  for (const [name, options] of [["stream died", { failAfter: 3 }], ["cursor ended early", { stopAfter: 4 }]] as const) {
    const instance = app(fakeStore(distinctDocuments(10), { pageSize: 1, ...options }));
    await withServer(instance, async (base) => {
      await assert.rejects(post(base, "/api/exports/documents.csv", selection).then((response) => response.arrayBuffer()), name);
      assert.equal(instance.store.marks.length, 0, `${name}: nothing marked`);
      assert.equal(instance.store.closedAtMark.length, 0, `${name}: recordExportMarks never called`);
      assert.ok(!instance.audits.some((event) => event.action === "export.completed"), name);
    });
  }
  const refused = app(fakeStore(distinctDocuments(2), { openError: "EXPORT_TOO_LARGE" }));
  await withServer(refused, async (base) => {
    const response = await post(base, "/api/exports/documents.csv", { selection: { mode: "filter", filter: {}, expectedTotal: 2 } });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "EXPORT_TOO_LARGE" });
    assert.equal(refused.store.closedAtMark.length, 0, "open failed: nothing marked");
  });
  const gate = deferred();
  const walked = app(fakeStore(distinctDocuments(4), { pageSize: 1, gate, gateBeforePage: 1 }));
  await withServer(walked, async (base) => {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/exports/documents.csv`, { method: "POST", headers: POST_HEADERS, body: JSON.stringify({ selection: { mode: "ids", ids: idList(4), expectState: "never" } }), signal: controller.signal });
    await response.body!.getReader().read();
    controller.abort();
    await tick();
    gate.resolve();
    await tick();
    assert.equal(walked.store.closedAtMark.length, 0, "aborted: nothing marked");
    assert.equal(walked.audits.find((event) => event.action === "export.failed")?.detail?.error, "EXPORT_ABORTED");
  });
});

test("a mark that cannot be saved fails the whole download: the socket is cut, export.failed says EXPORT_MARK_FAILED", async () => {
  const instance = app(fakeStore(distinctDocuments(3), { markError: "insert into document_export_marks failed" }));
  await withServer(instance, async (base) => {
    const ERRORS = /export_marks_total\{kind="exported",result="error"\} (\d+)/;
    const before = await counter(base, ERRORS);
    await assert.rejects(post(base, "/api/exports/documents.csv", { selection: { mode: "ids", ids: idList(3), expectState: "never" } }).then((response) => response.arrayBuffer()),
      "D4 strict: the browser's blob() rejects, so no unmarked file is ever saved");
    const failed = instance.audits.find((event) => event.action === "export.failed")!;
    assert.deepEqual([failed.detail?.error, failed.detail?.complete, failed.detail?.rows], ["EXPORT_MARK_FAILED", false, 3]);
    assert.ok(!instance.audits.some((event) => event.action === "export.completed"));
    assert.equal(instance.store.closed, 1);
    assert.equal(await counter(base, ERRORS) - before, 1);
    assert.ok(!JSON.stringify(failed.detail).includes("document_export_marks"), "the pg message stays out of the audit row");
  });
});

test("the wall clock ends a stalled POST download without marking anything", async () => {
  const store = fakeStore(distinctDocuments(1), { total: 200_000, pageSize: 500 });
  const audits: Omit<AuditEvent, "tenantId">[] = [];
  const gate = new ExportGate();
  const tenantGate = new ExportGate(1);
  const deps: ExportRouteDeps = {
    store, users: fakeUsers(audits), gate, tenantGate, previewLimit: new SlidingWindow(PREVIEW_LIMIT, PREVIEW_WINDOW_MS),
    listLimit: new SlidingWindow(EXPORT_LIST_LIMIT, PREVIEW_WINDOW_MS), markLimit: new SlidingWindow(EXPORT_MARK_LIMIT, PREVIEW_WINDOW_MS),
    maxRows: 500_000, publicBaseUrl: "https://ocr.example.test", traceId: "00000000-0000-4000-8000-0000000000ff", now: Date.now, wallClockMs: 60
  };
  const server = createServer((request, response) => {
    void handleExportRoutes(request, response, new URL(request.url ?? "/", "http://127.0.0.1"), request.method ?? "GET", context(), deps)
      .catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const client = connect(port, "127.0.0.1");
  try {
    client.pause();
    await new Promise<void>((resolve) => client.on("connect", () => resolve()));
    const body = JSON.stringify({ selection: { mode: "filter", filter: {}, expectedTotal: 200_000 } });
    client.write(`POST /api/exports/documents.csv HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    for (let waited = 0; waited < 200 && gate.size === 0; waited += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(gate.size, 1);
    assert.equal(tenantGate.size, 1, "a marking download also holds its organization's slot");
    for (let waited = 0; waited < 300 && gate.size > 0; waited += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(gate.size, 0, "the slot came back");
    assert.equal(tenantGate.size, 0, "and so did the organization's");
    await tick();
    assert.equal(store.closedAtMark.length, 0, "timed out: nothing marked");
    assert.equal(audits.find((event) => event.action === "export.failed")?.detail?.error, "EXPORT_TIMEOUT");
  } finally {
    client.destroy();
    await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  }
});

test("the GET download never marks, and shares the one-download-per-user gate with the POST", async () => {
  const plain = app(fakeStore(distinctDocuments(2)));
  await withServer(plain, async (base) => {
    const response = await fetch(`${base}/api/exports/documents.csv?exportState=never`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-export-selection"), null, "the Release 2 response headers are unchanged");
    await bodyText(response);
    assert.equal(plain.store.closedAtMark.length, 0, "D7: a GET has no side effect");
    assert.deepEqual(plain.store.filters, [{ exportState: "never" }]);
    const completed = plain.audits.find((event) => event.action === "export.completed")!;
    assert.deepEqual([completed.detail?.selection, completed.detail?.marked, completed.detail?.mark, completed.detail?.export_state],
      ["filter_get", 0, false, "never"]);
  });
  const gate = deferred();
  const busy = app(fakeStore(distinctDocuments(2), { pageSize: 1, gate, gateBeforePage: 1 }));
  await withServer(busy, async (base) => {
    const first = fetch(`${base}/api/exports/documents.csv`).then((response) => response.text());
    await tick();
    const second = await post(base, "/api/exports/documents.jsonl", { selection: { mode: "ids", ids: [docId(1)], expectState: "never" } });
    assert.equal(second.status, 429);
    assert.deepEqual(await second.json(), { error: "EXPORT_BUSY" });
    assert.equal(second.headers.get("retry-after"), "30");
    gate.resolve();
    await first;
  });
});

test("a bad POST body is refused before the gate or the store: 400, 415 and 413", async () => {
  const instance = app(fakeStore(distinctDocuments(1)));
  await withServer(instance, async (base) => {
    const ids = { mode: "ids", ids: [docId(1)], expectState: "never" };
    // [download body, marks body, status, download code, marks code]
    const cases: [unknown, unknown, Record<string, string>, number, string, string][] = [
      [{ selection: { mode: "ids", ids: [], expectState: "never" } }, { action: "mark", selection: { mode: "ids", ids: [], expectState: "never" } }, {}, 400, "INVALID_EXPORT_SELECTION", "INVALID_EXPORT_SELECTION"],
      [{ selection: { mode: "filter", filter: {} } }, { action: "mark", selection: { mode: "filter", filter: {} } }, {}, 400, "INVALID_EXPORT_SELECTION", "INVALID_EXPORT_SELECTION"],
      [{ selection: { mode: "filter", filter: { status: ["nope"] }, expectedTotal: 1 } }, { action: "mark", selection: { mode: "filter", filter: { status: ["nope"] }, expectedTotal: 1 } },
        {}, 400, "INVALID_EXPORT_FILTER", "INVALID_EXPORT_FILTER"],
      // `columns` belongs to the download only: a bad value there is the GET's error, on the marks route an unknown key.
      [{ selection: ids, columns: "all" }, { action: "mark", selection: ids, columns: "all" }, {}, 400, "INVALID_EXPORT_FILTER", "INVALID_EXPORT_SELECTION"],
      [[ids], [ids], {}, 400, "INVALID_JSON", "INVALID_JSON"],
      ["{not json", "{not json", {}, 400, "INVALID_JSON", "INVALID_JSON"],
      [{ selection: ids }, { action: "mark", selection: ids }, { "content-type": "text/plain" }, 415, "UNSUPPORTED_MEDIA_TYPE", "UNSUPPORTED_MEDIA_TYPE"],
      [{ selection: ids, pad: "x".repeat(1_100_000) }, { action: "mark", selection: ids, pad: "x".repeat(1_100_000) }, {}, 413, "PAYLOAD_TOO_LARGE", "PAYLOAD_TOO_LARGE"]
    ];
    for (const [downloadBody, marksBody, headers, status, downloadCode, marksCode] of cases) {
      const download = await post(base, "/api/exports/documents.csv", downloadBody, headers);
      assert.equal(download.status, status, `download ${downloadCode}`);
      assert.deepEqual(await download.json(), { error: downloadCode }, `download ${downloadCode}`);
      const marks = await post(base, "/api/exports/marks", marksBody, headers);
      assert.equal(marks.status, status, `marks ${marksCode}`);
      assert.deepEqual(await marks.json(), { error: marksCode }, `marks ${marksCode}`);
    }
    assert.deepEqual([instance.store.opened, instance.store.filters.length, instance.store.stateCalls.length, instance.audits.length], [0, 0, 0, 0]);
  });
});

// ---- export selection (0021): candidates ----------------------------------------------------------

const candidateRow: ExportCandidate = {
  documentId: docId(1), filename: "ใบลูกค้า ทดสอบ.pdf", pageNumber: 2, pageCount: 5, statusCategory: "review", needsReview: true,
  customerName: "ลูกค้า ทดสอบ", formNumber: "F-0001", createdAt: "2026-09-22T07:05:00.000Z", reviewedAt: null,
  exportState: "exported", changedAfterExport: true, lastExportedAt: "2026-09-23T03:00:00.000Z", lastExportKind: "marked", lastExportedByName: "บอส"
};

test("candidates: the C1 shape, the filters and page reach the store, metered and never audited", async () => {
  const listed: ExportCandidatesResult = { total: 7, limit: 2, offset: 4, counts: { never: 5, exported: 7, all: 12, unconfirmed: 3 }, rows: [candidateRow] };
  const instance = app(fakeStore([], { candidates: listed }), { webConfig: { exportMaxRows: 20_000 } });
  await withServer(instance, async (base) => {
    const READ = /documents_read_total\{kind="export_candidates"\} (\d+)/;
    const OK = /exports_total\{format="candidates",result="ok"\} (\d+)/;
    const before = [await counter(base, READ), await counter(base, OK)];
    const response = await fetch(`${base}/api/exports/candidates?exportState=exported&status=review,failed&confirmedOnly=0&limit=2&offset=4&q=${encodeURIComponent("ทดสอบ")}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      total: 7, limit: 2, offset: 4, counts: { never: 5, exported: 7, all: 12, unconfirmed: 3 }, maxRows: 20_000, selectionMax: 5000, rows: [candidateRow]
    });
    assert.deepEqual(instance.store.listCalls, [{ filter: { status: ["review", "failed"], q: "ทดสอบ", exportState: "exported" }, page: { limit: 2, offset: 4 } }]);
    assert.equal(instance.audits.length, 0, "D9: metered, not audited per call");
    assert.deepEqual([await counter(base, READ) - before[0]!, await counter(base, OK) - before[1]!], [1, 1]);
    const bad = await fetch(`${base}/api/exports/candidates?limit=501`);
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: "INVALID_EXPORT_FILTER" });
    assert.equal(instance.store.listCalls.length, 1, "a bad query never reaches the store");
  });
});

test("candidates: 300 a quarter of an hour per user, then 429 EXPORT_THROTTLED in its own metric bucket", async () => {
  const instance = app(fakeStore([]));
  await withServer(instance, async (base) => {
    const THROTTLED = /exports_total\{format="candidates",result="throttled"\} (\d+)/;
    const before = await counter(base, THROTTLED);
    for (let call = 0; call < EXPORT_LIST_LIMIT; call += 1) assert.equal((await fetch(`${base}/api/exports/candidates`)).status, 200, `call ${call}`);
    const throttled = await fetch(`${base}/api/exports/candidates`);
    assert.equal(throttled.status, 429);
    assert.deepEqual(await throttled.json(), { error: "EXPORT_THROTTLED" });
    assert.equal(throttled.headers.get("retry-after"), "900");
    assert.equal(await counter(base, THROTTLED) - before, 1);
    assert.equal((await fetch(`${base}/api/exports/preview`)).status, 200, "the preview keeps its own window");
  });
});

// ---- export selection (0021): manual marks --------------------------------------------------------

test("marks: mark and unmark reach the store as one call, answer C3, and are audited with counts after the commit", async () => {
  const instance = app(fakeStore([], { markResult: { total: 3, affected: 2, skipped: 1 } }), { webConfig: { exportMaxRows: 7_000 } });
  await withServer(instance, async (base) => {
    const OK = /export_marks_total\{kind="marked",result="ok"\} (\d+)/;
    const ROWS = /export_marked_rows_total\{kind="marked"\} (\d+)/;
    const before = [await counter(base, OK), await counter(base, ROWS)];
    const marked = await post(base, "/api/exports/marks", { action: "mark", selection: { mode: "ids", ids: [docId(1), docId(2), docId(3), docId(3)], expectState: "never" } });
    assert.equal(marked.status, 200);
    assert.deepEqual(await marked.json(), { action: "mark", affected: 2, skipped: 1, total: 3 });
    const call = instance.store.stateCalls[0]!;
    assert.deepEqual([call.action, call.filter, call.expectedTotal, call.expectState, call.maxRows, call.actorUserId],
      ["mark", { ids: [docId(1), docId(2), docId(3)] }, undefined, "never", 7_000, userId]);
    assert.match(call.requestId, /^[0-9a-f-]{36}$/);
    const audit = instance.audits.find((event) => event.action === "export.marked")!;
    assert.deepEqual([audit.outcome, audit.targetType, audit.requestId], ["success", "export", call.requestId]);
    assert.deepEqual(audit.detail, { selection: "ids", requested: 3, total: 3, affected: 2, skipped: 1 });
    assert.deepEqual([await counter(base, OK) - before[0]!, await counter(base, ROWS) - before[1]!], [1, 2]);

    const unmarked = await post(base, "/api/exports/marks", { action: "unmark", selection: { mode: "filter", filter: { exportState: "exported" }, expectedTotal: 3 } });
    assert.equal(unmarked.status, 200);
    assert.deepEqual(await unmarked.json(), { action: "unmark", affected: 2, skipped: 1, total: 3 });
    assert.deepEqual([instance.store.stateCalls[1]!.filter, instance.store.stateCalls[1]!.expectedTotal, instance.store.stateCalls[1]!.expectState],
      [{ exportState: "exported" }, 3, undefined]);
    assert.deepEqual(instance.audits.find((event) => event.action === "export.unmarked")?.detail, { selection: "filter", requested: 3, total: 3, affected: 2, skipped: 1 });
    assert.equal(instance.audits.length, 2, "no export.started or file audit rows for a manual flip");
  });
});

test("marks: a refused flip is its status code with no audit row, and a failed audit write never undoes a committed mark", async () => {
  for (const [code, status] of [["EXPORT_SELECTION_CHANGED", 409], ["EXPORT_TOO_LARGE", 400], ["EXPORT_SELECTION_EMPTY", 400]] as const) {
    const refused = app(fakeStore([], { stateError: code }));
    await withServer(refused, async (base) => {
      const response = await post(base, "/api/exports/marks", { action: "mark", selection: { mode: "filter", filter: {}, expectedTotal: 5 } });
      assert.equal(response.status, status, code);
      assert.deepEqual(await response.json(), { error: code });
      assert.equal(refused.audits.length, 0, `${code}: nothing was written, so nothing is audited`);
      assert.ok(await counter(base, /export_marks_total\{kind="marked",result="error"\} (\d+)/) >= 1);
    });
  }
  const unaudited = app(fakeStore([], { markResult: { total: 1, affected: 1, skipped: 0 } }), { failAudit: "export.unmarked" });
  await withServer(unaudited, async (base) => {
    const response = await post(base, "/api/exports/marks", { action: "unmark", selection: { mode: "ids", ids: [docId(1)], expectState: "never" } });
    assert.equal(response.status, 200, "the event rows are the durable record; the audit failure is only logged");
    assert.deepEqual(await response.json(), { action: "unmark", affected: 1, skipped: 0, total: 1 });
  });
});

test("marks: 60 a quarter of an hour per user, then 429 EXPORT_THROTTLED; GET on the route is not served", async () => {
  const instance = app(fakeStore([], { markResult: { total: 1, affected: 0, skipped: 1 } }));
  await withServer(instance, async (base) => {
    const body = { action: "mark", selection: { mode: "ids", ids: [docId(1)], expectState: "never" } };
    for (let call = 0; call < EXPORT_MARK_LIMIT; call += 1) assert.equal((await post(base, "/api/exports/marks", body)).status, 200, `call ${call}`);
    const throttled = await post(base, "/api/exports/marks", body);
    assert.equal(throttled.status, 429);
    assert.deepEqual(await throttled.json(), { error: "EXPORT_THROTTLED" });
    assert.equal(throttled.headers.get("retry-after"), "900");
    assert.equal(instance.store.stateCalls.length, EXPORT_MARK_LIMIT, "the throttled call never reached the store");
    assert.equal((await fetch(`${base}/api/exports/marks`)).status, 404, "marks are POST only");
  });
});

test("the new export routes need a session and the export right, and a refusal is counted under its own route", async () => {
  const anonymous = app(fakeStore([]), { ctx: null });
  await withServer(anonymous, async (base) => {
    assert.equal((await fetch(`${base}/api/exports/candidates`)).status, 401);
    assert.equal((await post(base, "/api/exports/marks", { action: "mark", selection: { mode: "ids", ids: [docId(1)], expectState: "never" } })).status, 401);
    assert.equal((await post(base, "/api/exports/documents.csv", { selection: { mode: "ids", ids: [docId(1)], expectState: "never" } })).status, 401);
  });
  const staff = app(fakeStore(distinctDocuments(1)), { ctx: context({ role: "staff", canExport: false }) });
  await withServer(staff, async (base) => {
    const before = [await counter(base, /exports_total\{format="candidates",result="forbidden"\} (\d+)/), await counter(base, /exports_total\{format="marks",result="forbidden"\} (\d+)/)];
    for (const response of [await fetch(`${base}/api/exports/candidates`),
      await post(base, "/api/exports/marks", { action: "mark", selection: { mode: "ids", ids: [docId(1)], expectState: "never" } }),
      await post(base, "/api/exports/documents.csv", { selection: { mode: "ids", ids: [docId(1)], expectState: "never" } })]) {
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: "FORBIDDEN" });
    }
    assert.deepEqual([staff.store.listCalls.length, staff.store.stateCalls.length, staff.store.opened], [0, 0, 0]);
    assert.deepEqual([await counter(base, /exports_total\{format="candidates",result="forbidden"\} (\d+)/) - before[0]!,
      await counter(base, /exports_total\{format="marks",result="forbidden"\} (\d+)/) - before[1]!], [1, 1]);
  });
});

// ---- review of 0021 (Phase 4 step 39): H1 expected state + organization gate, M1 bounded marks ---------------------

/**
 * The routes on a bare server with deps the case can see (both gates, the audit rows), for the paths where a slot must
 * be proven to come back: a mark failure, a mark timeout, an abort, a client leaving during the marks.
 */
async function directServer(store: FakeStore, run: (base: string, seen: { gate: ExportGate; tenantGate: ExportGate; audits: Omit<AuditEvent, "tenantId">[] }) => Promise<void>): Promise<void> {
  const audits: Omit<AuditEvent, "tenantId">[] = [];
  const gate = new ExportGate();
  const tenantGate = new ExportGate(1);
  const deps: ExportRouteDeps = {
    store, users: fakeUsers(audits), gate, tenantGate, previewLimit: new SlidingWindow(PREVIEW_LIMIT, PREVIEW_WINDOW_MS),
    listLimit: new SlidingWindow(EXPORT_LIST_LIMIT, PREVIEW_WINDOW_MS), markLimit: new SlidingWindow(EXPORT_MARK_LIMIT, PREVIEW_WINDOW_MS),
    maxRows: 50_000, publicBaseUrl: "https://ocr.example.test", traceId: "00000000-0000-4000-8000-0000000000fe", now: Date.now
  };
  const server = createServer((request, response) => {
    void handleExportRoutes(request, response, new URL(request.url ?? "/", "http://127.0.0.1"), request.method ?? "GET", context(), deps)
      .catch((error: unknown) => {
        // What server.ts does: a refusal before the headers is a JSON code, a failure after them a destroyed socket.
        if (response.headersSent) { response.destroy(); return; }
        response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: error instanceof Error ? error.message : "?" }));
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  try { await run(`http://127.0.0.1:${port}`, { gate, tenantGate, audits }); }
  finally { await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }); }
}
const postBody = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const waitFor = async (done: () => boolean): Promise<void> => {
  for (let waited = 0; waited < 300 && !done(); waited += 1) await new Promise((resolve) => setTimeout(resolve, 10));
};

test("H1: an explicit selection whose rows moved tab or vanished is 409 before any byte or mark, and frees both slots", async () => {
  const instance = app(fakeStore(distinctDocuments(2), { openError: "EXPORT_SELECTION_CHANGED" }));
  await withServer(instance, async (base) => {
    for (const expectState of ["never", "exported", null]) {
      const response = await post(base, "/api/exports/documents.csv", { selection: { mode: "ids", ids: idList(2), expectState } });
      assert.equal(response.status, 409, String(expectState));
      assert.deepEqual(await response.json(), { error: "EXPORT_SELECTION_CHANGED" });
      assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8", "no file headers were written");
    }
    assert.deepEqual(instance.store.expectStates, ["never", "exported", null], "the tab state reaches the snapshot check as sent");
    assert.deepEqual([instance.store.marks.length, started(instance).length], [0, 0]);
    // Three refusals in a row from one user, and each one answered 409, not 429: the slots came back every time.
  });
});

test("H1: one marking download per organization; the second person gets 429 EXPORT_BUSY_ORG, GET and other organizations do not", async () => {
  const gate = deferred();
  const otherTenant = "00000000-0000-0000-0000-000000000002";
  const instance = app(fakeStore(distinctDocuments(2), { pageSize: 1, gate, gateBeforePage: 1 }), {
    ctxFor: (request) => {
      const who = request.headers["x-test-user"];
      if (who === "b") return context({ userId: otherUserId, sessionId: "00000000-0000-4000-8000-0000000000bb" });
      if (who === "c") return context({ userId: "00000000-0000-4000-8000-000000000003", tenantId: otherTenant, sessionId: "00000000-0000-4000-8000-0000000000cc" });
      return context();
    }
  });
  await withServer(instance, async (base) => {
    const BUSY = /exports_total\{format="csv",result="busy"\} (\d+)/;
    const before = await counter(base, BUSY);
    const selection = { selection: { mode: "ids", ids: idList(2), expectState: "never" } };
    const first = post(base, "/api/exports/documents.csv", selection).then((response) => bodyText(response));
    // Whatever happens below, the parked streams are let go, so a regression is a failure and never a hang.
    try {
      await tick();
      const second = await post(base, "/api/exports/documents.csv", selection, { "x-test-user": "b" });
      assert.equal(second.status, 429);
      assert.deepEqual(await second.json(), { error: "EXPORT_BUSY_ORG" });
      assert.equal(second.headers.get("retry-after"), "30");
      assert.equal(await counter(base, BUSY) - before, 1, "counted as busy");
      const filterMode = await post(base, "/api/exports/documents.csv", { selection: { mode: "filter", filter: { exportState: "never" }, expectedTotal: 2 } }, { "x-test-user": "b" });
      assert.equal(filterMode.status, 429, "select all N of the same tab waits too: its snapshot must see the first one's marks");
      assert.deepEqual(await filterMode.json(), { error: "EXPORT_BUSY_ORG" });
      // The Release 2 GET never marks, so it keeps only the per-user gate; another organization has its own slot.
      const plain = fetch(`${base}/api/exports/documents.csv`, { headers: { "x-test-user": "b" } });
      const elsewhere = post(base, "/api/exports/documents.csv", selection, { "x-test-user": "c" });
      assert.deepEqual([(await plain).status, (await elsewhere).status], [200, 200]);
      assert.equal(instance.store.opened, 3, "the refused one never opened a snapshot");
    } finally { gate.resolve(); }
    await first;
    await tick();
    const after = await post(base, "/api/exports/documents.csv", selection, { "x-test-user": "b" });
    assert.equal(after.status, 200, "the organization's slot came back once the first download's marks were written");
    await bodyText(after);
  });
});

test("H1: a busy organization never charges the user's own slot", async () => {
  await directServer(fakeStore(distinctDocuments(1)), async (base, seen) => {
    assert.ok(seen.tenantGate.acquire(tenant), "someone else in this organization is exporting");
    const response = await fetch(`${base}/api/exports/documents.csv`, postBody({ selection: { mode: "ids", ids: idList(1), expectState: "never" } }));
    assert.deepEqual(await response.json(), { error: "EXPORT_BUSY_ORG" });
    await tick();
    assert.equal(seen.gate.size, 0, "the per-user slot taken before the refusal was given back");
  });
});

test("M1: a mark write that fails or runs out of time cuts the socket and gives back both slots and the cursor", async () => {
  for (const markError of ["insert into document_export_marks failed", "canceling statement due to lock timeout", "canceling statement due to statement timeout"]) {
    const store = fakeStore(distinctDocuments(3), { markError });
    await directServer(store, async (base, seen) => {
      await assert.rejects(fetch(`${base}/api/exports/documents.csv`, postBody({ selection: { mode: "ids", ids: idList(3), expectState: "never" } }))
        .then((response) => response.arrayBuffer()), markError);
      await waitFor(() => seen.audits.some((event) => event.action === "export.failed"));
      const failed = seen.audits.find((event) => event.action === "export.failed")!;
      assert.deepEqual([failed.detail?.error, failed.detail?.marked, failed.detail?.complete], ["EXPORT_MARK_FAILED", 0, false], markError);
      assert.deepEqual([seen.gate.size, seen.tenantGate.size, store.closed], [0, 0, 1], `${markError}: nothing is held afterwards`);
      assert.ok(!seen.audits.some((event) => event.action === "export.completed"));
    });
  }
});

test("M1: a manual flip that runs out of time is 503 EXPORT_MARK_FAILED with no audit row; a refusal keeps its own code", async () => {
  for (const stateError of ["canceling statement due to lock timeout", "canceling statement due to statement timeout", "connection terminated unexpectedly"]) {
    const instance = app(fakeStore([], { stateError }));
    await withServer(instance, async (base) => {
      const ERRORS = /export_marks_total\{kind="unmarked",result="error"\} (\d+)/;
      const before = await counter(base, ERRORS);
      const response = await post(base, "/api/exports/marks", { action: "unmark", selection: { mode: "ids", ids: [docId(1)], expectState: "exported" } });
      assert.equal(response.status, 503, stateError);
      assert.deepEqual(await response.json(), { error: "EXPORT_MARK_FAILED" }, "the pg message never reaches the browser");
      assert.equal(instance.audits.length, 0, "rolled back, so nothing to audit");
      assert.equal(await counter(base, ERRORS) - before, 1);
    });
  }
});

test("an aborted POST download gives back both slots and the cursor, and marks nothing", async () => {
  const gate = deferred();
  const store = fakeStore(distinctDocuments(4), { pageSize: 1, gate, gateBeforePage: 1 });
  await directServer(store, async (base, seen) => {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/exports/documents.csv`, { ...postBody({ selection: { mode: "ids", ids: idList(4), expectState: "never" } }), signal: controller.signal });
    await response.body!.getReader().read();
    assert.deepEqual([seen.gate.size, seen.tenantGate.size], [1, 1], "both slots are held while the file streams");
    controller.abort();
    await tick();
    gate.resolve();
    await waitFor(() => seen.gate.size === 0 && seen.tenantGate.size === 0);
    assert.deepEqual([seen.gate.size, seen.tenantGate.size, store.closed, store.closedAtMark.length], [0, 0, 1, 0]);
    assert.equal(seen.audits.find((event) => event.action === "export.failed")?.detail?.error, "EXPORT_ABORTED");
  });
});

test("a client that leaves WHILE the marks are written: the marks stand, export.failed EXPORT_ABORTED says how many, no completed row", async () => {
  const markGate = deferred();
  const store = fakeStore(distinctDocuments(3), { markGate });
  await directServer(store, async (base, seen) => {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/exports/documents.csv`, { ...postBody({ selection: { mode: "ids", ids: idList(3), expectState: "never" } }), signal: controller.signal });
    assert.equal(response.status, 200);
    await waitFor(() => store.closedAtMark.length === 1);
    assert.equal(store.closedAtMark.length, 1, "the stream is complete and the marks are being written");
    controller.abort();
    await tick();
    markGate.resolve();
    await waitFor(() => seen.audits.some((event) => event.action === "export.failed"));
    assert.equal(store.marks.length, 1, "the marks committed before the browser's departure was noticed (D4's residual window)");
    const failed = seen.audits.find((event) => event.action === "export.failed")!;
    assert.deepEqual([failed.detail?.error, failed.detail?.marked, failed.detail?.rows, failed.detail?.complete], ["EXPORT_ABORTED", 3, 3, false],
      "the operator can find the request whose rows need ย้ายกลับ");
    assert.ok(!seen.audits.some((event) => event.action === "export.completed"), "no file was saved, so no completed export");
    assert.deepEqual([seen.gate.size, seen.tenantGate.size, store.closed], [0, 0, 1]);
  });
});

// ---- the full format is the default (export-full-confidence) ------------------------------------------------------

/** A CSV line split on its separators (the fixture has no quoted cells). */
const csvFields = (line: string): string[] => line.split(",");

test("a POST without columns downloads the full set (180), its first 57 headers are compact's, and compact is 57", async () => {
  const instance = app(fakeStore(distinctDocuments(2)));
  await withServer(instance, async (base) => {
    const selection = { mode: "ids", ids: idList(2), expectState: "never" };
    const full = (await bodyText(await post(base, "/api/exports/documents.csv", { selection }))).slice(1).split("\r\n").filter(Boolean);
    assert.equal(csvFields(full[0]!).length, 180, "the header row of the default file");
    assert.deepEqual(csvFields(full[0]!).slice(0, 57), EXPORT_COLUMNS.map((column) => column.th));
    assert.deepEqual(csvFields(full[0]!), EXPORT_COLUMNS_DETAILED.map((column) => column.th));
    for (const line of full.slice(1)) assert.equal(csvFields(line).length, 180, "every row has every column");
    const compact = (await bodyText(await post(base, "/api/exports/documents.csv", { columns: "compact", selection }))).slice(1).split("\r\n").filter(Boolean);
    assert.deepEqual(csvFields(compact[0]!), EXPORT_COLUMNS.map((column) => column.th));
    assert.equal(csvFields(compact[1]!).length, 57);
    const started = instance.audits.filter((event) => event.action === "export.started").map((event) => event.detail?.columns);
    assert.deepEqual(started, ["detailed", "compact"], "the audit names the set that was really exported");
    const jsonl = (await bodyText(await post(base, "/api/exports/documents.jsonl", { selection }))).split("\n").filter(Boolean);
    const keys = Object.keys(JSON.parse(jsonl[0]!) as Record<string, unknown>);
    const expected = EXPORT_COLUMNS_DETAILED.flatMap((column) => column.kind === "datetime" ? [column.key, `${column.key}_utc`] : [column.key]);
    assert.deepEqual(keys, [...expected, "structured_result"], "JSONL keys: the full set (plus each _utc twin) and the canonical result");
  });
});

test("a GET without columns is the full set too, and columns=compact still gives the 57 compact columns", async () => {
  const instance = app(fakeStore([document()]));
  await withServer(instance, async (base) => {
    const header = async (query: string) => csvFields((await bodyText(await fetch(`${base}/api/exports/documents.csv${query}`))).slice(1).split("\r\n")[0]!);
    assert.equal((await header("")).length, 180);
    assert.equal((await header("?columns=compact")).length, 57);
    assert.deepEqual(await header("?headers=en"), EXPORT_COLUMNS_DETAILED.map((column) => column.key));
  });
});

test("an empty, legacy or malformed result still writes every column: empty CSV cells, JSONL nulls", () => {
  const shapes: [string, ExportDocument["structuredResult"]][] = [["empty", normalizeStructuredResult({ schemaVersion: 3 })],
    ["legacy", normalizeStructuredResult({ roomNo: field("7") })], ["garbage", "garbage" as unknown as ExportDocument["structuredResult"]]];
  for (const [name, structuredResult] of shapes) {
    const row = document({ structuredResult });
    for (const [set, columns] of [["detailed", EXPORT_COLUMNS_DETAILED], ["compact", EXPORT_COLUMNS]] as const) {
      const line = csvDocumentRow(row, columns, set, "https://ocr.example.test");
      assert.equal(csvFields(line.replace(/\r\n$/, "")).length, columns.length, `${set}: ${columns.length} CSV fields`);
      const parsed = JSON.parse(jsonlDocumentLine(row, columns, set, "https://ocr.example.test")) as Record<string, unknown>;
      for (const column of columns) assert.ok(column.key in parsed, `${set}: ${column.key} present in JSONL`);
      if (name === "legacy") continue; // its room reading fills room_* and the summary; presence is what is checked here
      for (const column of columns.slice(54)) assert.equal(parsed[column.key], null, `${name} ${set}: ${column.key} is null, not missing or false`);
    }
  }
});

test("Excel: the CSV body starts with the UTF-8 BOM bytes EF BB BF exactly once, and JSONL carries none", async () => {
  const instance = app(fakeStore([document()]));
  await withServer(instance, async (base) => {
    const csv = new Uint8Array(await (await fetch(`${base}/api/exports/documents.csv`)).arrayBuffer());
    assert.deepEqual([...csv.slice(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.notDeepEqual([...csv.slice(3, 6)], [0xef, 0xbb, 0xbf], "one BOM, not two");
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(csv);
    assert.ok(text.slice(1).startsWith("ชื่อไฟล์ต้นฉบับ,"), "Thai headers right after it");
    assert.ok(text.includes(",007,"), "a room number is written exactly as stored");
    const jsonl = new Uint8Array(await (await fetch(`${base}/api/exports/documents.jsonl`)).arrayBuffer());
    assert.equal(jsonl[0], "{".charCodeAt(0), "JSONL starts with the first object, no BOM");
  });
});
