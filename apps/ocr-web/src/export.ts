/**
 * The export's HTTP half (plan §10 H1/H2/H5): the query parser, the CSV and JSONL writers, the concurrency gate and the
 * routes. The column contract and the cell values come from `@innovera/ocr-persistence` (`export.ts`), so the file
 * a staff member downloads, the 20 rows they previewed and the table on screen can never disagree.
 *
 * Export selection (migration 0021): the dialog lists candidates (`GET /api/exports/candidates`), downloads a
 * selection (`POST /api/exports/documents.{csv,jsonl}`, which records an `exported` event per row once the stream has
 * completed) and flips rows by hand (`POST /api/exports/marks`). The `GET` downloads keep working and never mark.
 *
 * Two writers with deliberately opposite rules:
 * - **CSV** is what Excel opens: one UTF-8 BOM, CRLF, RFC 4180 quoting, a formula guard on every TEXT cell (file names
 *   included — an uploaded file may legitimately be called `=cmd.pdf`) and a 32,000-character cut per cell.
 * - **JSONL** is the lossless one: no BOM, `\n`, no guard, no truncation, and every timestamp as a Bangkok-offset
 *   instant beside its UTC twin.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  bangkokTimestamp, DOCUMENT_STATUS_CATEGORIES, EXPORT_SELECTION_MAX, exportCells, exportColumns, flattenDocument,
  MAX_FILTER_QUERY_LENGTH, normalizeStructuredResult, type DocumentFilter, type DocumentStatusCategory, type ExportCandidatesPage,
  type ExportCandidatesResult, type ExportColumn, type ExportColumnSet, type ExportCursor, type ExportDateField,
  type ExportDocument, type ExportMarkInput, type ExportMarkResult, type ExportPreview, type ExportState,
  type ExportStateChangeInput, type OpenExportOptions
} from "@innovera/ocr-persistence";
import { logEvent, metrics } from "@innovera/ocr-observability";
import { readJson, respond, SlidingWindow, type UserStore, type WebAuthContext } from "./auth.js";

/** The structural subset of `PostgresOcrDocumentStore` the export routes use, so tests can pass a fake. */
export type ExportStore = Readonly<{
  previewExport(tenantId: string, filter: DocumentFilter, options?: { limit?: number | undefined }): Promise<ExportPreview>;
  openExport(tenantId: string, filter: DocumentFilter, options: OpenExportOptions): Promise<ExportCursor>;
  listExportCandidates(tenantId: string, filter: DocumentFilter, page?: ExportCandidatesPage): Promise<ExportCandidatesResult>;
  recordExportMarks(tenantId: string, input: ExportMarkInput): Promise<number>;
  markExportState(tenantId: string, input: ExportStateChangeInput): Promise<ExportMarkResult>;
}>;

export type ExportFormat = "csv" | "jsonl";
export type ExportHeaders = "th" | "en";
export type ExportQuery = DocumentFilter & Readonly<{ columns: ExportColumnSet; headers: ExportHeaders }>;

/** §10 H1: the preview returns the whole column set for any filter, so it is a paging API over the export's own data. */
export const PREVIEW_LIMIT = 60;
export const PREVIEW_WINDOW_MS = 900_000;
/**
 * D9: the dialog's list is paged and re-read on every tab switch, so it gets a wider window than the preview (same 15
 * minutes). C3: manual marks write to an append-only table, so a stuck client must not be able to flood it.
 */
export const EXPORT_LIST_LIMIT = 300;
export const EXPORT_MARK_LIMIT = 60;
/** C1 paging: `limit` 1..100 (default 50), `offset` 0..1,000,000. */
export const CANDIDATES_DEFAULT_LIMIT = 50;
export const CANDIDATES_MAX_LIMIT = 100;
export const CANDIDATES_MAX_OFFSET = 1_000_000;
/** §10 H5: one open download per user, two per process (the store enforces the process cap — it owns the connections). */
export const EXPORT_PER_USER = 1;
/**
 * H1 (review of 0021): one MARKING download (the dialog's POST) per organization at a time. Two staff who ticked the
 * same "ยังไม่เคย Export" rows would otherwise both pass the expected-state check in their own snapshots, both stream and
 * both mark: the double import this feature exists to prevent. Serialized, the second one opens its snapshot only
 * after the first one's marks committed (the slot is released after them), so its check sees the rows as exported and
 * answers 409 EXPORT_SELECTION_CHANGED. The GET download never marks and keeps only the per-user gate. Per process:
 * production runs one web process (a second one would need this gate in the database).
 */
export const EXPORT_MARKING_PER_TENANT = 1;
/** The gate's wall clock. The cursor enforces the same budget itself, so neither half can be the only thing holding. */
export const EXPORT_WALL_CLOCK_MS = 600_000;
export const CSV_BOM = "\uFEFF";
const CRLF = "\r\n";
/** Excel reads a leading `=`, `+`, `-` or `@` as a formula; a leading tab or CR can smuggle one past a naive reader. */
const FORMULA_START = /^[=+\-@\t\r]/;
const PREVIEW_ROUTE = "/api/exports/preview";
const CANDIDATES_ROUTE = "/api/exports/candidates";
const MARKS_ROUTE = "/api/exports/marks";
const FILE_ROUTES: ReadonlyMap<string, ExportFormat> = new Map([
  ["/api/exports/documents.csv", "csv"], ["/api/exports/documents.jsonl", "jsonl"]
]);
/** The `format` label of every export route (`exports_total{format}`), so a refused request is counted under its route. */
const ROUTE_LABELS: ReadonlyMap<string, string> = new Map([
  [PREVIEW_ROUTE, "preview"], [CANDIDATES_ROUTE, "candidates"], [MARKS_ROUTE, "marks"], ...FILE_ROUTES
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
 * The export filters (§10 H2) plus `exportState` (0021), shared by the GET query, the candidates list and the filter
 * of a POSTed selection, so the three can never validate differently. Strict, like `parseDocumentListQuery`: any bad
 * value is 400 `INVALID_EXPORT_FILTER` rather than something the store has to make sense of. The date range and
 * `dateField` are validated again inside `documentFilterSql`, because those values reach a `::date` cast where a pg
 * error would be a 500 quoting the input back.
 */
export function parseExportFilter(params: URLSearchParams): DocumentFilter {
  const filter: {
    status?: DocumentStatusCategory[]; q?: string; batchId?: string; parentId?: string;
    confirmedOnly?: boolean; from?: string; to?: string; dateField?: ExportDateField; exportState?: ExportState;
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
  // 0021: the dialog's tabs. Omitted means every row (the "ทั้งหมด" tab); there is no `all` value.
  const exportState = params.get("exportState")?.trim() ?? "";
  if (exportState) {
    if (exportState !== "never" && exportState !== "exported") throw new Error("INVALID_EXPORT_FILTER");
    filter.exportState = exportState;
  }
  return filter;
}

function columnsParam(value: string): ExportColumnSet {
  if (value !== "compact" && value !== "detailed") throw new Error("INVALID_EXPORT_FILTER");
  return value;
}
function headersParam(value: string): ExportHeaders {
  if (value !== "th" && value !== "en") throw new Error("INVALID_EXPORT_FILTER");
  return value;
}

/** The GET download and the preview: the shared filters plus the column set and the header language. */
export function parseExportQuery(params: URLSearchParams): ExportQuery {
  const filter = parseExportFilter(params);
  const columns = columnsParam(params.get("columns")?.trim() || "compact");
  const headers = headersParam(params.get("headers")?.trim() || "th");
  return { ...filter, columns, headers };
}

/** `intParam` of the document list, with the export's one error code: digits only, inside the range, empty = default. */
function intParam(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null || value.trim() === "") return fallback;
  if (!/^\d{1,9}$/.test(value.trim())) throw new Error("INVALID_EXPORT_FILTER");
  const parsed = Number(value.trim());
  if (parsed < min || parsed > max) throw new Error("INVALID_EXPORT_FILTER");
  return parsed;
}

export type CandidatesQuery = Readonly<{ filter: DocumentFilter; limit: number; offset: number }>;
/** C1: the shared filters (with `exportState`), then `limit` 1..100 (default 50) and `offset` 0..1,000,000. */
export function parseCandidatesQuery(params: URLSearchParams): CandidatesQuery {
  const filter = parseExportFilter(params);
  const limit = intParam(params.get("limit"), CANDIDATES_DEFAULT_LIMIT, 1, CANDIDATES_MAX_LIMIT);
  const offset = intParam(params.get("offset"), 0, 0, CANDIDATES_MAX_OFFSET);
  return { filter, limit, offset };
}

/**
 * D6: what the user selected. `ids` is what they ticked (at most `EXPORT_SELECTION_MAX` distinct UUIDs, lower-cased),
 * with `expectState`, the tab they ticked them in (`never` / `exported`, null for "ทั้งหมด"): H1, an id that is gone or
 * no longer in that state is refused before anything happens. `filter` is "select all N matching", carrying the N they
 * saw so a moved count is refused before anything happens.
 */
export type ExportSelection =
  | Readonly<{ mode: "ids"; ids: readonly string[]; expectState: ExportState | null }>
  | Readonly<{ mode: "filter"; filter: DocumentFilter; expectedTotal: number }>;
export type ExportBody = Readonly<{ columns: ExportColumnSet; headers: ExportHeaders; selection: ExportSelection }>;
export type MarksBody = Readonly<{ action: "mark" | "unmark"; selection: ExportSelection }>;

type Json = Record<string, unknown>;
function isPlainObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Unknown keys are refused, so a typo (`expected_total`) is a 400 instead of a silently different request. */
function onlyKeys(value: Json, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error("INVALID_EXPORT_SELECTION");
}
const FILTER_STRING_KEYS = ["q", "batchId", "parentId", "dateField", "from", "to", "exportState"] as const;
const FILTER_KEYS: readonly string[] = ["status", "confirmedOnly", ...FILTER_STRING_KEYS];

/**
 * A POSTed filter object becomes the query string the GET would have carried and goes through `parseExportFilter`, so
 * the two can never validate differently. Shape errors (unknown key, wrong type) are INVALID_EXPORT_SELECTION; a bad
 * value is INVALID_EXPORT_FILTER, exactly as on the GET.
 */
function filterFromBody(value: unknown): DocumentFilter {
  if (!isPlainObject(value)) throw new Error("INVALID_EXPORT_SELECTION");
  onlyKeys(value, FILTER_KEYS);
  const params = new URLSearchParams();
  if (value.status !== undefined) {
    if (!Array.isArray(value.status) || !value.status.every((item) => typeof item === "string")) throw new Error("INVALID_EXPORT_SELECTION");
    const statuses = value.status as string[];
    // The GET's list separator: an element holding a comma would otherwise smuggle in a second value.
    if (statuses.some((item) => item.includes(","))) throw new Error("INVALID_EXPORT_FILTER");
    if (statuses.length > 0) params.set("status", statuses.join(","));
  }
  if (value.confirmedOnly !== undefined) {
    if (typeof value.confirmedOnly !== "boolean") throw new Error("INVALID_EXPORT_SELECTION");
    if (value.confirmedOnly) params.set("confirmedOnly", "1");
  }
  for (const key of FILTER_STRING_KEYS) {
    const item = value[key];
    if (item === undefined) continue;
    if (typeof item !== "string") throw new Error("INVALID_EXPORT_SELECTION");
    params.set(key, item);
  }
  return parseExportFilter(params);
}

/**
 * C2/C3 `selection`, strictly: `{ mode: "ids", ids, expectState }` with 1..5,000 distinct UUIDs and the REQUIRED tab
 * state (`"never"`, `"exported"` or null), or `{ mode: "filter", filter, expectedTotal }` with an integer 0..maxRows.
 * Everything is checked before the store is touched; the ids reach SQL only as one bound `uuid[]`.
 */
export function parseSelectionBody(value: unknown, maxRows: number): ExportSelection {
  if (!isPlainObject(value)) throw new Error("INVALID_EXPORT_SELECTION");
  if (value.mode === "ids") {
    onlyKeys(value, ["mode", "ids", "expectState"]);
    // Required, not defaulted: a client that does not say which tab it ticked in must not get an unguarded export.
    const expectState = value.expectState;
    if (expectState !== null && expectState !== "never" && expectState !== "exported") throw new Error("INVALID_EXPORT_SELECTION");
    if (!Array.isArray(value.ids) || value.ids.length === 0) throw new Error("INVALID_EXPORT_SELECTION");
    const ids = new Set<string>();
    for (const id of value.ids) {
      if (typeof id !== "string" || !UUID.test(id)) throw new Error("INVALID_EXPORT_SELECTION");
      ids.add(id.toLowerCase());
      if (ids.size > EXPORT_SELECTION_MAX) throw new Error("INVALID_EXPORT_SELECTION");
    }
    return { mode: "ids", ids: [...ids], expectState };
  }
  if (value.mode === "filter") {
    onlyKeys(value, ["mode", "filter", "expectedTotal"]);
    const expectedTotal = value.expectedTotal;
    if (typeof expectedTotal !== "number" || !Number.isSafeInteger(expectedTotal) || expectedTotal < 0 || expectedTotal > maxRows) {
      throw new Error("INVALID_EXPORT_SELECTION");
    }
    return { mode: "filter", filter: filterFromBody(value.filter), expectedTotal };
  }
  throw new Error("INVALID_EXPORT_SELECTION");
}

/** C2 body: `columns` (default compact), `headers` (default th) and the `selection`. A bad column/header value is the GET's error. */
export function parseExportBody(value: unknown, maxRows: number): ExportBody {
  if (!isPlainObject(value)) throw new Error("INVALID_EXPORT_SELECTION");
  onlyKeys(value, ["columns", "headers", "selection"]);
  for (const key of ["columns", "headers"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") throw new Error("INVALID_EXPORT_SELECTION");
  }
  const columns = columnsParam((value.columns as string | undefined)?.trim() || "compact");
  const headers = headersParam((value.headers as string | undefined)?.trim() || "th");
  return { columns, headers, selection: parseSelectionBody(value.selection, maxRows) };
}

/** C3 body: `action` (`mark` | `unmark`) and the `selection`. */
export function parseMarksBody(value: unknown, maxRows: number): MarksBody {
  if (!isPlainObject(value)) throw new Error("INVALID_EXPORT_SELECTION");
  onlyKeys(value, ["action", "selection"]);
  if (value.action !== "mark" && value.action !== "unmark") throw new Error("INVALID_EXPORT_SELECTION");
  return { action: value.action, selection: parseSelectionBody(value.selection, maxRows) };
}

/**
 * What the store is asked for: an explicit selection is ONLY its ids (D6) plus the state they must still be in (H1),
 * "select all" is the filter plus N.
 */
function selectionFilter(selection: ExportSelection): { filter: DocumentFilter; expectedTotal?: number; expectState?: ExportState | null } {
  return selection.mode === "ids" ? { filter: { ids: selection.ids }, expectState: selection.expectState }
    : { filter: selection.filter, expectedTotal: selection.expectedTotal };
}

/** §7: how the rows were chosen, as counts only. `filter_get` is the Release 2 GET download, which never marks. */
type SelectionDetail = Readonly<{ selection: "ids" | "filter" | "filter_get"; requested: number | null; export_state: string | null }>;
function selectionDetail(selection: ExportSelection | null, filter: DocumentFilter): SelectionDetail {
  if (selection === null) return { selection: "filter_get", requested: null, export_state: filter.exportState ?? null };
  if (selection.mode === "ids") return { selection: "ids", requested: selection.ids.length, export_state: null };
  return { selection: "filter", requested: selection.expectedTotal, export_state: selection.filter.exportState ?? null };
}

/** The `export.started` / `.completed` detail: which filters were used, never what was searched for (and never ids). */
function filterDetail(filter: DocumentFilter, columns: ExportColumnSet, headers: ExportHeaders): Record<string, string | number | boolean | null> {
  return {
    columns, headers,
    date_field: filter.dateField ?? "created_at",
    statuses: typeof filter.status === "string" ? filter.status : (filter.status ?? []).join(","),
    confirmed_only: filter.confirmedOnly === true,
    from: filter.from ?? null, to: filter.to ?? null,
    batch_id: filter.batchId ?? null, parent_id: filter.parentId ?? null,
    // The search text itself is customer data (a name, a form number), so only its presence is recorded.
    has_q: typeof filter.q === "string" && filter.q.length > 0
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
 * One open download per key: per user (`gate`, every download), and per organization for the marking POST downloads
 * (`tenantGate`, H1). The two-per-process cap lives in the store, which owns the pooled connections; the per-user half
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
  /** H1: one marking (POST) download per organization, keyed by tenant (`EXPORT_MARKING_PER_TENANT`). */
  tenantGate: ExportGate;
  previewLimit: SlidingWindow;
  /** `EXPORT_LIST_LIMIT` candidates requests per user per window (D9). */
  listLimit: SlidingWindow;
  /** `EXPORT_MARK_LIMIT` manual mark/unmark requests per user per window (C3). */
  markLimit: SlidingWindow;
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
  ["EXPORT_TOO_LARGE", "too_large"], ["EXPORT_BUSY", "busy"], ["EXPORT_BUSY_ORG", "busy"], ["EXPORT_THROTTLED", "throttled"], ["EXPORT_ABORTED", "aborted"],
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
  return ROUTE_LABELS.get(pathname) ?? null;
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
 * The export routes. Returns false when `pathname` is not one of them or the method is not served there, so the caller
 * falls through to its 404. The permission gate (`requiredRight`) and the `Sec-Fetch-Site` / `Origin` / CSRF guards
 * have already run in `authorize`; the POST bodies go through `readJson` (JSON content type, 1 MB).
 *
 * - `GET  /api/exports/candidates`          the dialog's list (C1), metered, not audited per call
 * - `GET  /api/exports/preview`             unchanged (kept one release for rollback, D8)
 * - `GET  /api/exports/documents.{csv,jsonl}` unchanged Release 2 download, never marks (D7)
 * - `POST /api/exports/documents.{csv,jsonl}` a selection download, marks on a complete stream (C2, D4)
 * - `POST /api/exports/marks`               manual mark / unmark (C3)
 */
export async function handleExportRoutes(request: IncomingMessage, response: ServerResponse, url: URL, method: string,
  ctx: WebAuthContext, deps: ExportRouteDeps): Promise<boolean> {
  const pathname = url.pathname;
  const label = exportFormatLabel(pathname);
  if (label === null) return false;
  const format = FILE_ROUTES.get(pathname);
  const served = method === "GET" ? pathname !== MARKS_ROUTE : method === "POST" && (format !== undefined || pathname === MARKS_ROUTE);
  if (!served) return false;
  try {
    if (pathname === CANDIDATES_ROUTE) await candidates(response, ctx, parseCandidatesQuery(url.searchParams), deps);
    else if (pathname === PREVIEW_ROUTE) await preview(response, ctx, parseExportQuery(url.searchParams), deps);
    else if (pathname === MARKS_ROUTE) await marks(request, response, ctx, deps);
    else if (format !== undefined && method === "GET") {
      const { columns, headers, ...filter } = parseExportQuery(url.searchParams);
      await download(response, ctx, { filter, columns, headers, selection: null }, format, deps);
    } else if (format !== undefined) {
      // Everything is validated before the gate or the store: a bad body is a clean 400 that costs nothing.
      const body = parseExportBody(await readJson(request), deps.maxRows);
      const { filter, expectedTotal, expectState } = selectionFilter(body.selection);
      await download(response, ctx, { filter, columns: body.columns, headers: body.headers, selection: body.selection,
        ...(expectedTotal === undefined ? {} : { expectedTotal }), ...(expectState === undefined ? {} : { expectState }) }, format, deps);
    }
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

/**
 * C1: one page of the rows the export would hold, with each row's export history and the tab counts. Identifying
 * fields only (the same class `GET /api/documents` returns), so it is metered (D8's bulk-read control) and throttled,
 * not audited per call.
 */
async function candidates(response: ServerResponse, ctx: WebAuthContext, query: CandidatesQuery, deps: ExportRouteDeps): Promise<void> {
  if (deps.listLimit.blocked(ctx.userId, deps.now())) throw new Error("EXPORT_THROTTLED");
  deps.listLimit.record(ctx.userId, deps.now());
  const result = await deps.store.listExportCandidates(ctx.tenantId, query.filter, { limit: query.limit, offset: query.offset });
  metrics.increment("exports_total", { format: "candidates", result: "ok" });
  metrics.increment("documents_read_total", { kind: "export_candidates" }, result.rows.length);
  respond(response, 200, {
    total: result.total, limit: result.limit, offset: result.offset, counts: result.counts,
    maxRows: deps.maxRows, selectionMax: EXPORT_SELECTION_MAX, rows: result.rows
  });
}

/**
 * C3: a manual mark or unmark. The store runs the count, the `expectedTotal` check and the insert in one REPEATABLE
 * READ transaction (nothing is half-written); the audit row follows the commit, and a failure to write it is logged
 * without undoing the mark — the event rows themselves (actor, request id, time) are the durable record (§7).
 */
async function marks(request: IncomingMessage, response: ServerResponse, ctx: WebAuthContext, deps: ExportRouteDeps): Promise<void> {
  if (deps.markLimit.blocked(ctx.userId, deps.now())) throw new Error("EXPORT_THROTTLED");
  deps.markLimit.record(ctx.userId, deps.now());
  const body = parseMarksBody(await readJson(request), deps.maxRows);
  const kind = body.action === "mark" ? "marked" : "unmarked";
  const { filter, expectedTotal, expectState } = selectionFilter(body.selection);
  let result: ExportMarkResult;
  try {
    result = await deps.store.markExportState(ctx.tenantId, {
      action: body.action, filter, maxRows: deps.maxRows, actorUserId: ctx.userId, requestId: deps.traceId,
      ...(expectedTotal === undefined ? {} : { expectedTotal }), ...(expectState === undefined ? {} : { expectState })
    });
  } catch (error) {
    metrics.increment("export_marks_total", { kind, result: "error" });
    // A refusal is the store's own code (409 / 400). Anything else is the write itself failing: a lock wait or a
    // statement past EXPORT_MARK_*_TIMEOUT_MS, a pg error. The transaction rolled back, so nothing changed: that is
    // EXPORT_MARK_FAILED (503), and the pg message is only logged, truncated.
    if (errorCodeOf(error) !== "INTERNAL_ERROR") throw error;
    logEvent("export_mark_failed", { level: "error", trace_id: deps.traceId, user_id: ctx.userId, action: body.action,
      error: error instanceof Error ? error.message.slice(0, 120) : "unknown" });
    throw new Error("EXPORT_MARK_FAILED");
  }
  metrics.increment("export_marks_total", { kind, result: "ok" });
  metrics.increment("export_marked_rows_total", { kind }, result.affected);
  metrics.increment("exports_total", { format: "marks", result: "ok" });
  const detail = selectionDetail(body.selection, filter);
  await audit(deps, ctx, `export.${kind}`, "success",
    { selection: detail.selection, requested: detail.requested, total: result.total, affected: result.affected, skipped: result.skipped });
  respond(response, 200, { action: body.action, affected: result.affected, skipped: result.skipped, total: result.total });
}

async function preview(response: ServerResponse, ctx: WebAuthContext, query: ExportQuery, deps: ExportRouteDeps): Promise<void> {
  if (deps.previewLimit.blocked(ctx.userId, deps.now())) throw new Error("EXPORT_THROTTLED");
  deps.previewLimit.record(ctx.userId, deps.now());
  const columns = exportColumns(query.columns);
  const result = await deps.store.previewExport(ctx.tenantId, query);
  // §10 H1: the preview answers with the full column set for any filter, so it is audited like the file itself.
  await audit(deps, ctx, "export.previewed", "success", { ...filterDetail(query, query.columns, query.headers), format: "preview", rows: result.total });
  metrics.increment("exports_total", { format: "preview", result: "ok" });
  respond(response, 200, {
    columns: columns.map((column) => ({ key: column.key, label: columnLabel(column, query.headers) })),
    total: result.total, maxRows: deps.maxRows,
    // Exactly the strings the file would hold: the preview uses no formula guard, because the UI renders with textContent.
    rows: result.documents.map((document) => exportCells(document, query.columns, { publicBaseUrl: deps.publicBaseUrl }))
  });
}

/**
 * One download. `selection` is null for the Release 2 GET (never marks, D7); a POSTed selection marks every streamed
 * row once the stream is complete (D4). `expectedTotal` is "select all N" (D6).
 */
type DownloadRequest = Readonly<{
  filter: DocumentFilter; columns: ExportColumnSet; headers: ExportHeaders;
  selection: ExportSelection | null; expectedTotal?: number; expectState?: ExportState | null;
}>;

async function download(response: ServerResponse, ctx: WebAuthContext, request: DownloadRequest, format: ExportFormat,
  deps: ExportRouteDeps): Promise<void> {
  const mark = request.selection !== null;
  const releaseUser = deps.gate.acquire(ctx.userId);
  if (releaseUser === null) throw new Error("EXPORT_BUSY");
  // H1: a marking download also holds its organization's one slot, taken BEFORE the snapshot opens and given back only
  // after its marks committed (the finally below), so the next marking download sees them.
  const releaseTenant = mark ? deps.tenantGate.acquire(ctx.tenantId) : () => undefined;
  if (releaseTenant === null) { releaseUser(); throw new Error("EXPORT_BUSY_ORG"); }
  const release = (): void => { releaseTenant(); releaseUser(); };
  const startedAt = deps.now();
  const detail = { ...filterDetail(request.filter, request.columns, request.headers), ...selectionDetail(request.selection, request.filter) };
  let cursor: ExportCursor | null = null;
  let rows = 0;
  let marked = 0;
  let complete = false;
  try {
    // Step 1: the count runs before anything is written, so EXPORT_TOO_LARGE, EXPORT_SELECTION_CHANGED and
    // EXPORT_SELECTION_EMPTY are still clean 4xx answers.
    cursor = await deps.store.openExport(ctx.tenantId, request.filter, { maxRows: deps.maxRows,
      ...(request.expectedTotal === undefined ? {} : { expectedTotal: request.expectedTotal }),
      ...(request.expectState === undefined ? {} : { expectState: request.expectState }) });
    const open = cursor;
    // Step 2: the audit row is committed BEFORE the first byte. Only `export.started` is guaranteed — a crash, a
    // redeploy or an OOM kill during the stream would otherwise let the data leave with no audit row at all.
    await audit(deps, ctx, "export.started", "success", { ...detail, format, rows: open.total });
    // The gate's wall clock. It ends BOTH halves of a stalled download: `close()` gives the pooled connection back,
    // and `destroy()` ends the response — without it the loop would stay parked on a `'drain'` that a client which
    // stopped reading never fires, so `release()` below would never run and that user's next export would answer 429
    // `EXPORT_BUSY` for good. A closed cursor ends the loop QUIETLY, so the flag is what stops a truncated file being
    // handed over as a complete one with a 200, and what names the failure EXPORT_TIMEOUT rather than EXPORT_ABORTED.
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; void open.close(); response.destroy(); }, deps.wallClockMs ?? EXPORT_WALL_CLOCK_MS);
    timer.unref?.();
    // D2: the snapshot of each row is the `rowVersion` the cursor itself read, collected only for rows actually written.
    const streamed: { documentId: string; rowVersion: string }[] = [];
    try {
      const columns = exportColumns(request.columns);
      response.writeHead(200, {
        "content-type": CONTENT_TYPE[format],
        "content-disposition": `attachment; filename="${exportFilename(format, startedAt)}"`,
        "cache-control": "no-store", "x-content-type-options": "nosniff", "x-export-rows": String(open.total),
        ...(request.selection === null ? {} : { "x-export-selection": request.selection.mode })
      });
      // Step 3: the BOM and the header row go out at once, so nginx-proxy does not sit waiting with no data at all.
      // It does not make the proxy's read timeout irrelevant: a FETCH may take up to EXPORT_STATEMENT_TIMEOUT_MS
      // between two writes, which is the gap Deploy B's `proxy_read_timeout` precondition is there to cover.
      if (format === "csv") await write(response, CSV_BOM + csvRow(columns.map((column) => columnLabel(column, request.headers))));
      for await (const page of open.rows()) {
        const chunk = page.map((document) => format === "csv"
          ? csvDocumentRow(document, columns, request.columns, deps.publicBaseUrl)
          : jsonlDocumentLine(document, columns, request.columns, deps.publicBaseUrl)).join("");
        await write(response, chunk);
        rows += page.length;
        if (mark) for (const document of page) streamed.push({ documentId: document.documentId, rowVersion: document.rowVersion });
      }
      if (timedOut) throw new Error("EXPORT_TIMEOUT");
      // The count and the cursor read the same REPEATABLE READ snapshot through the same WHERE, so they agree on how
      // many rows exist. A short stream means something ended the cursor early, and a truncated file must never be
      // handed over as a complete one with a 200 — the socket is destroyed instead and the browser's blob() rejects.
      if (rows !== open.total) throw new Error("EXPORT_TRUNCATED");
      // The stream is done: the wall clock has nothing left to guard, and it must not cut the response AFTER the marks
      // below have committed (that would mark rows the browser never saved). The cursor goes back before the marks
      // take a second connection.
      clearTimeout(timer);
      await open.close();
      if (mark) {
        // D4: marks only for a complete stream, and BEFORE the final end(), so "file saved" implies "rows marked". A
        // client that already left gets no marks; a failed insert fails the download (strict), so the socket is
        // destroyed and the browser saves nothing.
        if (response.destroyed || response.writableEnded) throw new Error("EXPORT_ABORTED");
        marked = await recordMarks(ctx, format, streamed, deps);
        // The documented residual window (D4): the client left WHILE the marks were being written. They are committed,
        // but no file was saved, so this is no completed export: export.failed EXPORT_ABORTED carrying `marked` tells
        // the operator which request left rows to move back (ย้ายกลับเป็นยังไม่ Export).
        if (response.destroyed) throw new Error("EXPORT_ABORTED");
      }
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
      { ...detail, format, rows, complete, marked, mark, duration_ms: deps.now() - startedAt });
    logEvent("export_completed", { trace_id: deps.traceId, user_id: ctx.userId, format, rows, marked, duration_ms: deps.now() - startedAt });
  } catch (error) {
    metrics.increment("export_rows_total", { format }, rows);
    // Both the metric bucket and the code: `aborted` alone cannot tell a statement timeout from a client walking away.
    await audit(deps, ctx, "export.failed", "failure",
      { ...detail, format, rows, complete, marked, duration_ms: deps.now() - startedAt, result: resultOf(error), error: errorCodeOf(error) });
    throw error;
  } finally {
    await cursor?.close();
    release();
  }
}

/** One `exported` event per streamed row (D4). Any store failure is EXPORT_MARK_FAILED; the pg message is only logged, truncated. */
async function recordMarks(ctx: WebAuthContext, format: ExportFormat, streamed: readonly { documentId: string; rowVersion: string }[],
  deps: ExportRouteDeps): Promise<number> {
  try {
    const inserted = await deps.store.recordExportMarks(ctx.tenantId,
      { kind: "exported", source: format, actorUserId: ctx.userId, requestId: deps.traceId, rows: streamed });
    metrics.increment("export_marks_total", { kind: "exported", result: "ok" });
    metrics.increment("export_marked_rows_total", { kind: "exported" }, inserted);
    return inserted;
  } catch (error: unknown) {
    metrics.increment("export_marks_total", { kind: "exported", result: "error" });
    logEvent("export_mark_failed", { level: "error", trace_id: deps.traceId, user_id: ctx.userId, rows: streamed.length,
      error: error instanceof Error ? error.message.slice(0, 120) : "unknown" });
    throw new Error("EXPORT_MARK_FAILED");
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
