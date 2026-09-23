/**
 * The export's HTTP half (plan §12): the CSV and JSONL writers, the streaming loop, the audit trail and the three
 * routes. Every fixture here is obviously fake.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Server } from "node:http";
import { AuthenticationError } from "@innovera/ocr-auth";
import type { WebConfig } from "@innovera/ocr-config";
import {
  normalizeStructuredResult, type AuditEvent, type DocumentFilter, type ExportCursor, type ExportDocument,
  type OpenExportOptions
} from "@innovera/ocr-persistence";
import type { UserStore, WebAuthContext } from "./auth.js";
import {
  bangkokOffsetIso, csvCell, csvRow, exportFilename, ExportGate, guardFormula, parseExportQuery, type ExportStore
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
}>;
type FakeStore = ExportStore & { closed: number; opened: number; filters: DocumentFilter[]; maxRows: number[] };

/** A store that yields `total` identical rows in pages, and can stall or throw exactly where a test needs it to. */
function fakeStore(documents: readonly ExportDocument[], options: StoreOptions = {}): FakeStore {
  const state = { closed: 0, opened: 0, filters: [] as DocumentFilter[], maxRows: [] as number[] };
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
      if (options.openError) throw new Error(options.openError);
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
function app(store: FakeStore, options: { ctx?: WebAuthContext | null; webConfig?: Partial<WebConfig>; failAudit?: string } = {}): App {
  const audits: Omit<AuditEvent, "tenantId">[] = [];
  const server = createAppServer(
    { ingest: { stage: async () => "key", scan: async () => "CLEAN", enqueue: async () => "job" }, userStore: fakeUsers(audits, options.failAudit), exportStore: store },
    {
      webConfig: { ...baseWebConfig, ...options.webConfig },
      authenticate: () => { if (options.ctx === null) throw new AuthenticationError("UNAUTHENTICATED"); return options.ctx ?? context(); }
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
    assert.equal(instance.audits.find((event) => event.action === "export.failed")?.detail?.error, "aborted");
  });
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
  assert.deepEqual(parseExportQuery(params("")), { columns: "compact", headers: "th" });
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
    for (const path of ["/api/exports/preview", "/api/exports/documents.csv", "/api/exports/documents.jsonl"]) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 403, path);
      assert.deepEqual(await response.json(), { error: "FORBIDDEN" }, path);
    }
    assert.equal(staff.store.opened, 0);
  });
});

test("exportFilename is ASCII, Bangkok-timed and carries no client input", () => {
  assert.equal(exportFilename("csv", Date.parse("2026-09-22T07:05:00.000Z")), "ocr-export-20260922-1405.csv");
  assert.equal(exportFilename("jsonl", Date.parse("2026-09-22T17:00:00.000Z")), "ocr-export-20260923-0000.jsonl");
  assert.doesNotMatch(exportFilename("csv", Date.now()), /[^\x20-\x7E]/, "nothing here can split a response header");
});
