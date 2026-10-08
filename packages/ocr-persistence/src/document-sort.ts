/**
 * Server-side sort of the document list (`GET /api/documents?sort=K&dir=D`). The whole filtered set is ordered, not the
 * page on screen. Nine keys are plain SQL expressions over `documents d`; `confidence` is ranked in application code by
 * the very `summarizeDocument` value the table shows (see `rankByDisplayedConfidence`), so the two can never drift.
 *
 * Safety: the ORDER BY text comes only from the static tables below. The only variable parts are a whitelisted key and a
 * direction literal mapped from the enum; nothing a client sends is ever interpolated, and the collation name is a
 * constant too.
 */
import type { DocumentStatusCategory } from "./labels.js";

export const DOCUMENT_SORT_KEYS = ["file", "customer", "gender", "nationality", "treatment", "duration", "therapist", "room", "status", "confidence"] as const;
export type DocumentSortKey = typeof DOCUMENT_SORT_KEYS[number];
export const DOCUMENT_SORT_DIRS = ["asc", "desc"] as const;
export type DocumentSortDir = typeof DOCUMENT_SORT_DIRS[number];
export type DocumentSort = Readonly<{ sort: DocumentSortKey; dir: DocumentSortDir }>;

/**
 * The list's default order and the tie-break of every sort: newest upload first, the pages of one PDF together in page
 * order at the position of their upload (they share its created_at), then the id. With no sort the list's ORDER BY is
 * exactly this text, byte for byte what it was before sorting existed.
 */
export const DEFAULT_ORDER_SQL = "d.created_at DESC, COALESCE(d.parent_document_id, d.id) DESC, d.page_number ASC NULLS FIRST, d.id DESC";

/**
 * `sort=confidence` reads every filtered row once to rank it in application code; above this many rows it is refused
 * with SORT_TOO_LARGE (the workbench then asks staff to narrow the filter). The other nine keys have no cap.
 */
export const CONFIDENCE_SORT_MAX_ROWS = 2000;

/**
 * Text keys sort in Thai dictionary order (ICU, PostgreSQL's `th-TH-x-icu`, present in the production image
 * postgres:17.6): Thai leading vowels เ แ โ ใ ไ sort by the consonant that follows, Thai sorts before Latin, and
 * `lower()` makes English names case-insensitive A to Z. A constant, never input.
 */
export const SORT_COLLATION = "th-TH-x-icu";

/**
 * The status order of a status sort, ascending: attention first (the order of the status filter), so the first click
 * shows what needs a person. Descending is the exact reverse.
 */
export const STATUS_SORT_ORDER: readonly DocumentStatusCategory[] = ["review", "failed", "processing", "queued", "succeeded", "confirmed"];

/** `NULLIF(btrim(structured_result #>> path), '')`: a stored text leaf, empty or blank as NULL. */
function txt(path: string): string { return `NULLIF(btrim(d.structured_result #>> '{${path}}'), '')`; }
function text(expression: string): string { return `lower(${expression}) COLLATE "${SORT_COLLATION}"`; }

/** Leading digits of the room (up to 9) as a number: "12" -> 12, "007" -> 7, "A3" -> NULL. */
const ROOM = `COALESCE(${txt("staffOnly,roomNo,value")}, ${txt("roomNo,value")})`;
const ROOM_NUMBER = `(substring(${ROOM} from '^[0-9]{1,9}'))::int`;
/** The v3 treatment list and, for rows without it, the legacy v2.2 shapes `legacyTreatments` understands (flat and whole). */
const FIRST_TREATMENT = `COALESCE(${txt("staffOnly,treatments,0,value")}, ${txt("staffOnly,treatment,value")}, ${txt("staffOnly,treatment,items,0,value")}, ${txt("treatment,value")}, ${txt("treatment,items,0,value")})`;
/** The numeric treatment minutes added up (what the ระยะเวลา column lists), else the form's own total, else NULL. */
const DURATION = `COALESCE((SELECT sum((t ->> 'durationMinutes')::numeric) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d.structured_result #> '{staffOnly,treatments}') = 'array' THEN d.structured_result #> '{staffOnly,treatments}' ELSE '[]'::jsonb END) t WHERE jsonb_typeof(t -> 'durationMinutes') = 'number'), CASE WHEN jsonb_typeof(d.structured_result #> '{staffOnly,totalMinutes}') = 'number' THEN (d.structured_result #>> '{staffOnly,totalMinutes}')::numeric END)`;

/** One sort key: its expression (NULL = empty) and, for room, the ORDER BY items per direction. */
type SqlKey = Readonly<{ key: string; asc?: string; desc?: string }>;
const SQL_KEYS: Readonly<Record<Exclude<DocumentSortKey, "status" | "confidence">, SqlKey>> = {
  file: { key: text("NULLIF(btrim(d.filename), '')") },
  customer: { key: text(txt("customerInformation,name,value")) },
  gender: { key: text(txt("customerInformation,gender,value")) },
  nationality: { key: text(txt("customerInformation,nationality,value")) },
  treatment: { key: text(FIRST_TREATMENT) },
  duration: { key: DURATION },
  therapist: { key: text(`COALESCE(${txt("staffOnly,therapistName,value")}, ${txt("therapistName,value")})`) },
  // Numeric rooms by number, then the others by text; descending is the exact reverse; an empty room is last both ways.
  room: { key: ROOM, asc: `${ROOM_NUMBER} ASC NULLS LAST, ${text(ROOM)} ASC`, desc: `${ROOM_NUMBER} DESC NULLS FIRST, ${text(ROOM)} DESC` }
};

function invalidSort(): Error { return new Error("INVALID_SORT"); }

/**
 * Validates a sort request (defence in depth: the API parser checks the same). No `sort` means the default order
 * (`dir` alone is ignored when valid); `sort` without `dir` is ascending. Anything outside the whitelist is INVALID_SORT.
 */
export function parseDocumentSort(sort: unknown, dir: unknown): DocumentSort | null {
  if (dir !== undefined && !(DOCUMENT_SORT_DIRS as readonly unknown[]).includes(dir)) throw invalidSort();
  if (sort === undefined) return null;
  if (!(DOCUMENT_SORT_KEYS as readonly unknown[]).includes(sort)) throw invalidSort();
  return { sort: sort as DocumentSortKey, dir: (dir ?? "asc") as DocumentSortDir };
}

/**
 * The ORDER BY of the list (without the keywords): `DEFAULT_ORDER_SQL` alone with no sort, else the key, empty values
 * last in both directions, then `DEFAULT_ORDER_SQL` as the tie-break, so equal keys keep the default order and paging
 * is deterministic. `status` maps the list's own category conditions (`categorySql`) to `STATUS_SORT_ORDER`.
 * `confidence` is not SQL: its first pass reads in the default order and `rankByDisplayedConfidence` orders it.
 */
export function documentOrderSql(sort: DocumentSort | null, categorySql: Readonly<Record<DocumentStatusCategory, string>>): string {
  if (sort === null || sort.sort === "confidence") return DEFAULT_ORDER_SQL;
  const direction = sort.dir === "desc" ? "DESC" : "ASC";
  if (sort.sort === "status") {
    const rank = `(CASE ${STATUS_SORT_ORDER.map((category, index) => `WHEN (${categorySql[category]}) THEN ${index + 1}`).join(" ")} ELSE 99 END)`;
    return `${rank} ${direction}, ${DEFAULT_ORDER_SQL}`;
  }
  const key = SQL_KEYS[sort.sort];
  const items = (sort.dir === "desc" ? key.desc : key.asc) ?? `${key.key} ${direction}`;
  return `(${key.key} IS NULL) ASC, ${items}, ${DEFAULT_ORDER_SQL}`;
}

/** The percentage the table shows for a confidence (the workbench's `pct()`): 0.894 -> 89, 0.895 -> 90, 85 -> 85; null when none. */
export function displayedConfidencePercent(confidence: unknown): number | null {
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return null;
  return Math.round(confidence <= 1 ? confidence * 100 : confidence);
}

/**
 * Orders `items` (already in the default order) by the displayed percentage of `confidenceOf(item)`: stable, so equal
 * percentages keep the incoming order; rows without a confidence last in both directions; `desc` reverses only the
 * ranked part. Returns a new array.
 */
export function rankByDisplayedConfidence<T>(items: readonly T[], confidenceOf: (item: T) => unknown, dir: DocumentSortDir): T[] {
  const keyed = items.map((item, index) => ({ item, index, key: displayedConfidencePercent(confidenceOf(item)) }));
  const sign = dir === "desc" ? -1 : 1;
  keyed.sort((a, b) => {
    if (a.key === null || b.key === null) return a.key === b.key ? a.index - b.index : a.key === null ? 1 : -1;
    return a.key === b.key ? a.index - b.index : sign * (a.key - b.key);
  });
  return keyed.map((entry) => entry.item);
}
