/**
 * The export's HTTP half (plan §10 H1/H2/H5): the query parser, the CSV and JSONL writers, the concurrency gate and the
 * three routes. The column contract and the cell values come from `@innovera/ocr-persistence` (`export.ts`), so the file
 * a staff member downloads, the 20 rows they previewed and the table on screen can never disagree.
 *
 * Two writers with deliberately opposite rules:
 * - **CSV** is what Excel opens: one UTF-8 BOM, CRLF, RFC 4180 quoting, a formula guard on every TEXT cell (file names
 *   included — an uploaded file may legitimately be called `=cmd.pdf`) and a 32,000-character cut per cell.
 * - **JSONL** is the lossless one: no BOM, `\n`, no guard, no truncation, and every timestamp as a Bangkok-offset
 *   instant beside its UTC twin.
 */
import type { ServerResponse } from "node:http";
import {
  bangkokTimestamp, DOCUMENT_STATUS_CATEGORIES, exportCells, exportColumns, flattenDocument, MAX_FILTER_QUERY_LENGTH,
  normalizeStructuredResult, type DocumentFilter, type DocumentStatusCategory, type ExportColumn, type ExportColumnSet,
  type ExportCursor, type ExportDateField, type ExportDocument, type ExportPreview, type OpenExportOptions
} from "@innovera/ocr-persistence";
import { logEvent, metrics } from "@innovera/ocr-observability";
import { respond, SlidingWindow, type UserStore, type WebAuthContext } from "./auth.js";

/** The structural subset of `PostgresOcrDocumentStore` the export routes use, so tests can pass a fake. */
export type ExportStore = Readonly<{
  previewExport(tenantId: string, filter: DocumentFilter, options?: { limit?: number | undefined }): Promise<ExportPreview>;
  openExport(tenantId: string, filter: DocumentFilter, options: OpenExportOptions): Promise<ExportCursor>;
}>;

export type ExportFormat = "csv" | "jsonl";
export type ExportHeaders = "th" | "en";
export type ExportQuery = DocumentFilter & Readonly<{ columns: ExportColumnSet; headers: ExportHeaders }>;

/** §10 H1: the preview returns the whole column set for any filter, so it is a paging API over the export's own data. */
export const PREVIEW_LIMIT = 60;
export const PREVIEW_WINDOW_MS = 900_000;
/** §10 H5: one open download per user, two per process (the store enforces the process cap — it owns the connections). */
export const EXPORT_PER_USER = 1;
/** The gate's wall clock. The cursor enforces the same budget itself, so neither half can be the only thing holding. */
export const EXPORT_WALL_CLOCK_MS = 600_000;
export const CSV_BOM = "\uFEFF";
const CRLF = "\r\n";
/** Excel reads a leading `=`, `+`, `-` or `@` as a formula; a leading tab or CR can smuggle one past a naive reader. */
const FORMULA_START = /^[=+\-@\t\r]/;
const PREVIEW_ROUTE = "/api/exports/preview";
const FILE_ROUTES: ReadonlyMap<string, ExportFormat> = new Map([
  ["/api/exports/documents.csv", "csv"], ["/api/exports/documents.jsonl", "jsonl"]
]);
const CONTENT_TYPE: Readonly<Record<ExportFormat, string>> = {
  csv: "text/csv; charset=utf-8", jsonl: "application/x-ndjson; charset=utf-8"
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// ---- the query (§10 H2) ---------------------------------------------------------------------------------------

function uuidParam(value: string): string {
  if (!UUID.test(value)) throw new Error("INVALID_EXPORT_FILTER");
  return value.toLowerCase();
}

/** `2026-02-31` and `2026-13-01` both parse as NaN or roll over; only a day that round-trips is a day. */
function isRealDate(value: string): boolean {
  const at = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(at) && new Date(at).toISOString().startsWith(value);
}

/**
 * Strict, like `parseDocumentListQuery`: any bad value is 400 `INVALID_EXPORT_FILTER` rather than something the store
 * has to make sense of. The date range and `dateField` are validated again inside `documentFilterSql`, because those
 * values reach a `::date` cast where a pg error would be a 500 quoting the input back.
 */
export function parseExportQuery(params: URLSearchParams): ExportQuery {
  const filter: {
    status?: DocumentStatusCategory[]; q?: string; batchId?: string; parentId?: string;
    confirmedOnly?: boolean; from?: string; to?: string; dateField?: ExportDateField;
  } = {};
  const status = params.get("status")?.trim() ?? "";
  if (status) {
    const wanted = [...new Set(status.split(",").map((value) => value.trim()).filter(Boolean))];
    for (const value of wanted) if (!(DOCUMENT_STATUS_CATEGORIES as readonly string[]).includes(value)) throw new Error("INVALID_EXPORT_FILTER");
    filter.status = wanted as DocumentStatusCategory[];
  }
  const q = params.get("q")?.trim() ?? "";
  if (q) {
    if (q.length > MAX_FILTER_QUERY_LENGTH || q.includes("\u0000")) throw new Error("INVALID_EXPORT_FILTER");
    filter.q = q;
  }
  const batchId = params.get("batchId")?.trim() ?? "";
  if (batchId) filter.batchId = uuidParam(batchId);
  const parentId = params.get("parentId")?.trim() ?? "";
  if (parentId) filter.parentId = uuidParam(parentId);
  const confirmedOnly = params.get("confirmedOnly")?.trim() ?? "";
  if (confirmedOnly) {
    if (confirmedOnly !== "1" && confirmedOnly !== "0") throw new Error("INVALID_EXPORT_FILTER");
    if (confirmedOnly === "1") filter.confirmedOnly = true;
  }
  const dateField = params.get("dateField")?.trim() ?? "";
  if (dateField) {
    if (dateField !== "created_at" && dateField !== "reviewed_at") throw new Error("INVALID_EXPORT_FILTER");
    filter.dateField = dateField;
  }
  for (const key of ["from", "to"] as const) {
    const value = params.get(key)?.trim() ?? "";
    if (!value) continue;
    // A real Bangkok day, not just the shape: `2026-13-01` matches the pattern and is not a date.
    if (!ISO_DATE.test(value) || !isRealDate(value)) throw new Error("INVALID_EXPORT_FILTER");
    filter[key] = value;
  }
  if (filter.from !== undefined && filter.to !== undefined && filter.from > filter.to) throw new Error("INVALID_EXPORT_FILTER");
  const columns = params.get("columns")?.trim() || "compact";
  if (columns !== "compact" && columns !== "detailed") throw new Error("INVALID_EXPORT_FILTER");
  const headers = params.get("headers")?.trim() || "th";
  if (headers !== "th" && headers !== "en") throw new Error("INVALID_EXPORT_FILTER");
  return { ...filter, columns, headers };
}

/** The `export.started` / `.completed` detail: which filters were used, never what was searched for. */
function filterDetail(query: ExportQuery): Record<string, string | number | boolean | null> {
  return {
    columns: query.columns, headers: query.headers,
    date_field: query.dateField ?? "created_at",
    statuses: typeof query.status === "string" ? query.status : (query.status ?? []).join(","),
    confirmed_only: query.confirmedOnly === true,
    from: query.from ?? null, to: query.to ?? null,
    batch_id: query.batchId ?? null, parent_id: query.parentId ?? null,
    // The search text itself is customer data (a name, a form number), so only its presence is recorded.
    has_q: typeof query.q === "string" && query.q.length > 0
  };
}

// ---- the CSV writer (§10 H5) ----------------------------------------------------------------------------------

/** A text cell Excel would execute gets a leading `'`, which Excel strips on display and every CSV reader keeps. */
export function guardFormula(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

/** RFC 4180: quote a cell that holds a quote, a comma or a line break, and double every quote inside it. */
export function csvCell(value: string): string {
  return /["\r\n,]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function csvRow(cells: readonly string[]): string {
  return `${cells.map(csvCell).join(",")}${CRLF}`;
}

export function columnLabel(column: ExportColumn, headers: ExportHeaders): string {
  return headers === "en" ? column.key : column.th;
}

/** One document → one CSV line. The guard is keyed on the COLUMN's kind, so a number column stays a bare number. */
export function csvDocumentRow(document: ExportDocument, columns: readonly ExportColumn[], set: ExportColumnSet, publicBaseUrl: string): string {
  const cells = exportCells(document, set, { publicBaseUrl });
  return csvRow(columns.map((column, index) => {
    const cell = cells[index] ?? "";
    return column.kind === "text" ? guardFormula(cell) : cell;
  }));
}

// ---- the JSONL writer (§10 H5) --------------------------------------------------------------------------------

/** `2026-09-22T14:05:00+07:00` — the requirement defines อัปโหลดเมื่อ as Bangkok local time (release2-requirements.md). */
export function bangkokOffsetIso(iso: string | null): string | null {
  const local = bangkokTimestamp(iso);
  return local === null ? null : `${local.replace(" ", "T")}+07:00`;
}

/**
 * One document → one JSONL line. Same keys and same order as the CSV, plus `<key>_utc` beside every timestamp and the
 * whole canonical `structured_result` at the end. No BOM, no formula guard and no truncation: this is the format that
 * keeps everything, so a value starting with `=` is emitted exactly as it was read.
 */
export function jsonlDocumentLine(document: ExportDocument, columns: readonly ExportColumn[], set: ExportColumnSet, publicBaseUrl: string): string {
  const values = flattenDocument(document, set, { publicBaseUrl });
  const line: Record<string, unknown> = {};
  for (const column of columns) {
    const value = values[column.key] ?? null;
    if (column.kind !== "datetime") { line[column.key] = value; continue; }
    const iso = typeof value === "string" ? value : null;
    line[column.key] = bangkokOffsetIso(iso);
    line[`${column.key}_utc`] = iso;
  }
  line.structured_result = normalizeStructuredResult(document.structuredResult);
  return `${JSON.stringify(line)}\n`;
}

// ---- the gate (§10 H5) ----------------------------------------------------------------------------------------

/**
 * One open download per user. The two-per-process cap lives in the store, which owns the pooled connections; this half
 * stops one staff member taking both slots and denying the export to everyone else.
 */
export class ExportGate {
  readonly #open = new Map<string, number>();

  constructor(readonly perUser: number = EXPORT_PER_USER) {}

  get size(): number { return this.#open.size; }

  /** The release function, or null when this user already holds their slot (the caller answers 429 `EXPORT_BUSY`). */
  acquire(userId: string): (() => void) | null {
    const held = this.#open.get(userId) ?? 0;
    if (held >= this.perUser) return null;
    this.#open.set(userId, held + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const now = (this.#open.get(userId) ?? 1) - 1;
      if (now <= 0) this.#open.delete(userId); else this.#open.set(userId, now);
    };
  }
}

// ---- the routes (§10 H1) --------------------------------------------------------------------------------------

export type ExportRouteDeps = Readonly<{
  store: ExportStore;
  users: UserStore;
  gate: ExportGate;
  previewLimit: SlidingWindow;
  maxRows: number;
  publicBaseUrl: string;
  traceId: string;
  now: () => number;
  /** The download's wall clock; production leaves it at `EXPORT_WALL_CLOCK_MS` and only tests shorten it. */
  wallClockMs?: number | undefined;
}>;

/** `Content-Disposition` is ASCII by construction — the name is a Bangkok timestamp, never anything a client sent. */
export function exportFilename(format: ExportFormat, at: number): string {
  const stamp = (bangkokTimestamp(new Date(at).toISOString()) ?? "").replace(/[-:]/g, "").replace(" ", "-").slice(0, 13);
  return `ocr-export-${stamp}.${format}`;
}

/**
 * §13's `exports_total{result}` buckets. `busy` is the per-user download gate (429, `Retry-After: 30`) and
 * `throttled` the preview limiter (429, `Retry-After: 900`): two different remedies, so two different labels.
 */
const RESULTS: ReadonlyMap<string, string> = new Map([
  ["EXPORT_TOO_LARGE", "too_large"], ["EXPORT_BUSY", "busy"], ["EXPORT_THROTTLED", "throttled"], ["EXPORT_ABORTED", "aborted"],
  ["EXPORT_TIMEOUT", "aborted"], ["INVALID_EXPORT_FILTER", "error"]
]);
function resultOf(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return RESULTS.get(message) ?? "error";
}
/** Only SCREAMING_SNAKE codes are recorded; a pg or TypeError message would put internals (and possibly data) in the audit row. */
function errorCodeOf(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^[A-Z][A-Z0-9_]{2,63}$/.test(message) ? message : "INTERNAL_ERROR";
}

/**
 * The `format` label of an export route, or null for anything else. `authorize` refuses a request before the handler
 * is entered, so the 403 is counted from there (§13 `exports_total{result="forbidden"}`).
 */
export function exportFormatLabel(pathname: string): string | null {
  return FILE_ROUTES.get(pathname) ?? (pathname === PREVIEW_ROUTE ? "preview" : null);
}

/**
 * Writes and waits for `'drain'`, so a slow reader bounds our buffering instead of the heap doing it. Both listeners
 * are removed on every path: a 10-minute download is thousands of writes, and a leaked `'close'` listener per write
 * would trip the max-listeners warning long before the file is finished.
 */
async function write(response: ServerResponse, chunk: string): Promise<void> {
  if (response.writableEnded || response.destroyed) throw new Error("EXPORT_ABORTED");
  if (response.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    const done = (error?: Error): void => {
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onError);
      if (error) reject(error); else resolve();
    };
    const onDrain = (): void => done();
    const onClose = (): void => done(new Error("EXPORT_ABORTED"));
    const onError = (error: Error): void => done(error);
    response.on("drain", onDrain);
    response.on("close", onClose);
    response.on("error", onError);
  });
}

/**
 * The three export routes. Returns false when `pathname` is not one of them, so the caller falls through to its 404.
 * The permission gate (`requiredRight`) and the `Sec-Fetch-Site` / `Origin` guards have already run in `authorize`.
 */
export async function handleExportRoutes(response: ServerResponse, url: URL, method: string, ctx: WebAuthContext,
  deps: ExportRouteDeps): Promise<boolean> {
  const pathname = url.pathname;
  const format = FILE_ROUTES.get(pathname);
  if (pathname !== PREVIEW_ROUTE && format === undefined) return false;
  if (method !== "GET") return false;
  const label: string = format ?? "preview";
  try {
    const query = parseExportQuery(url.searchParams);
    if (format === undefined) await preview(response, ctx, query, deps);
    else await download(response, ctx, query, format, deps);
    return true;
  } catch (error) {
    metrics.increment("exports_total", { format: label, result: resultOf(error) });
    if (response.headersSent) {
      // The headers promised a file; a half-written one must never look complete, so the socket is destroyed and the
      // browser's blob() rejects. `export.started` is already committed, and `export.failed` was appended below.
      response.destroy();
      return true;
    }
    throw error;
  }
}

async function preview(response: ServerResponse, ctx: WebAuthContext, query: ExportQuery, deps: ExportRouteDeps): Promise<void> {
  if (deps.previewLimit.blocked(ctx.userId, deps.now())) throw new Error("EXPORT_THROTTLED");
  deps.previewLimit.record(ctx.userId, deps.now());
  const columns = exportColumns(query.columns);
  const result = await deps.store.previewExport(ctx.tenantId, query);
  // §10 H1: the preview answers with the full column set for any filter, so it is audited like the file itself.
  await audit(deps, ctx, "export.previewed", "success", { ...filterDetail(query), format: "preview", rows: result.total });
  metrics.increment("exports_total", { format: "preview", result: "ok" });
  respond(response, 200, {
    columns: columns.map((column) => ({ key: column.key, label: columnLabel(column, query.headers) })),
    total: result.total, maxRows: deps.maxRows,
    // Exactly the strings the file would hold: the preview uses no formula guard, because the UI renders with textContent.
    rows: result.documents.map((document) => exportCells(document, query.columns, { publicBaseUrl: deps.publicBaseUrl }))
  });
}

async function download(response: ServerResponse, ctx: WebAuthContext, query: ExportQuery, format: ExportFormat,
  deps: ExportRouteDeps): Promise<void> {
  const release = deps.gate.acquire(ctx.userId);
  if (release === null) throw new Error("EXPORT_BUSY");
  const startedAt = deps.now();
  let cursor: ExportCursor | null = null;
  let rows = 0;
  let complete = false;
  try {
    // Step 1: the count runs before anything is written, so EXPORT_TOO_LARGE is still a clean 400.
    cursor = await deps.store.openExport(ctx.tenantId, query, { maxRows: deps.maxRows });
    const open = cursor;
    // Step 2: the audit row is committed BEFORE the first byte. Only `export.started` is guaranteed — a crash, a
    // redeploy or an OOM kill during the stream would otherwise let the data leave with no audit row at all.
    await audit(deps, ctx, "export.started", "success", { ...filterDetail(query), format, rows: open.total });
    // The gate's wall clock. It ends BOTH halves of a stalled download: `close()` gives the pooled connection back,
    // and `destroy()` ends the response — without it the loop would stay parked on a `'drain'` that a client which
    // stopped reading never fires, so `release()` below would never run and that user's next export would answer 429
    // `EXPORT_BUSY` for good. A closed cursor ends the loop QUIETLY, so the flag is what stops a truncated file being
    // handed over as a complete one with a 200, and what names the failure EXPORT_TIMEOUT rather than EXPORT_ABORTED.
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; void open.close(); response.destroy(); }, deps.wallClockMs ?? EXPORT_WALL_CLOCK_MS);
    timer.unref?.();
    try {
      const columns = exportColumns(query.columns);
      response.writeHead(200, {
        "content-type": CONTENT_TYPE[format],
        "content-disposition": `attachment; filename="${exportFilename(format, startedAt)}"`,
        "cache-control": "no-store", "x-content-type-options": "nosniff", "x-export-rows": String(open.total)
      });
      // Step 3: the BOM and the header row go out at once, so nginx-proxy does not sit waiting with no data at all.
      // It does not make the proxy's read timeout irrelevant: a FETCH may take up to EXPORT_STATEMENT_TIMEOUT_MS
      // between two writes, which is the gap Deploy B's `proxy_read_timeout` precondition is there to cover.
      if (format === "csv") await write(response, CSV_BOM + csvRow(columns.map((column) => columnLabel(column, query.headers))));
      for await (const page of open.rows()) {
        const chunk = page.map((document) => format === "csv"
          ? csvDocumentRow(document, columns, query.columns, deps.publicBaseUrl)
          : jsonlDocumentLine(document, columns, query.columns, deps.publicBaseUrl)).join("");
        await write(response, chunk);
        rows += page.length;
      }
      if (timedOut) throw new Error("EXPORT_TIMEOUT");
      // The count and the cursor read the same REPEATABLE READ snapshot through the same WHERE, so they agree on how
      // many rows exist. A short stream means something ended the cursor early, and a truncated file must never be
      // handed over as a complete one with a 200 — the socket is destroyed instead and the browser's blob() rejects.
      if (rows !== open.total) throw new Error("EXPORT_TRUNCATED");
      complete = true;
      response.end();
    } catch (error) {
      // The wall clock destroys the response, so the parked write() rejects with EXPORT_ABORTED; the flag is what
      // tells the audit row and the metric that it was our ten minutes, not the client walking away.
      throw timedOut ? new Error("EXPORT_TIMEOUT") : error;
    } finally { clearTimeout(timer); }
    metrics.increment("exports_total", { format, result: "ok" });
    metrics.increment("export_rows_total", { format }, rows);
    // §10 H5: the terminal rows carry the same filter detail as `export.started`, so one row answers what was asked
    // for without a join back to the started row on request_id (which a crash may be the only survivor of).
    await audit(deps, ctx, "export.completed", "success",
      { ...filterDetail(query), format, rows, complete, duration_ms: deps.now() - startedAt });
    logEvent("export_completed", { trace_id: deps.traceId, user_id: ctx.userId, format, rows, duration_ms: deps.now() - startedAt });
  } catch (error) {
    metrics.increment("export_rows_total", { format }, rows);
    // Both the metric bucket and the code: `aborted` alone cannot tell a statement timeout from a client walking away.
    await audit(deps, ctx, "export.failed", "failure",
      { ...filterDetail(query), format, rows, complete, duration_ms: deps.now() - startedAt, result: resultOf(error), error: errorCodeOf(error) });
    throw error;
  } finally {
    await cursor?.close();
    release();
  }
}

/**
 * An audit write must never be what fails an export that already left; a failure is logged and the stream goes on.
 * The two rows written BEFORE any data leaves are the exception, and they are awaited: §10 H1 rests on
 * `export.previewed` for the preview (20 rows of the export's own columns, for any filter) exactly as §10 H5 rests on
 * `export.started` for the file — no audit row, no rows returned.
 */
async function audit(deps: ExportRouteDeps, ctx: WebAuthContext, action: string, outcome: "success" | "failure",
  detail: Record<string, string | number | boolean | null>): Promise<void> {
  if (action === "export.started" || action === "export.previewed") {
    await deps.users.recordAudit({ actorUserId: ctx.userId, sessionId: ctx.sessionId, requestId: deps.traceId, action, outcome, targetType: "export", detail });
    return;
  }
  try {
    await deps.users.recordAudit({ actorUserId: ctx.userId, sessionId: ctx.sessionId, requestId: deps.traceId, action, outcome, targetType: "export", detail });
  } catch (error: unknown) {
    logEvent("audit_write_failed", { trace_id: deps.traceId, action, error: error instanceof Error ? error.message.slice(0, 120) : "unknown" });
  }
}
