/**
 * The export's column contract and row flattening (plan §10 H3, design §3.2). Pure: it takes one `ExportDocument` —
 * what `index.ts` reads per document row — and returns one value per column. The CSV writer, the JSONL writer and the
 * preview table all render THESE values, so the file a staff member downloads and the 20 rows they previewed can never
 * disagree.
 *
 * The four columns the user asked for come first, in this order: ชื่อไฟล์ต้นฉบับ (the ORIGINAL uploaded file name, so
 * a page of a split PDF shows the PDF's name, never `page-003.png`), หน้า, จำนวนหน้า and อัปโหลดเมื่อ
 * (`release2-requirements.md`).
 */
import { normalizeStructuredResult, summarizeDocument, type DocumentView } from "./document-view.js";
import { CATEGORY_LABELS_TH, DELIVERY_LABELS_TH, FIELD_LABELS_TH, reviewerLabel, type DeliveryStatus, type DocumentStatusCategory } from "./labels.js";

/** `datetime` values travel as the ISO UTC instant; the CSV writer renders Bangkok local time, JSONL keeps both (§10 H5). */
export type ExportColumnKind = "text" | "number" | "bool" | "datetime";
export type ExportColumn = Readonly<{ key: string; th: string; kind: ExportColumnKind }>;
export type ExportColumnSet = "compact" | "detailed";
export type ExportValue = string | number | boolean | null;
export type ExportValues = Readonly<Record<string, ExportValue>>;

/** One document row of the export, as `index.ts` reads it. `structuredResult` is the canonical view. */
export type ExportDocument = Readonly<{
  documentId: string; batchId: string | null; batchLabel: string | null;
  filename: string; parentFilename: string | null; parentDocumentId: string | null;
  pageNumber: number | null; pageCount: number | null;
  /** The raw `documents.status` (`status_code`); `statusCategory` is the UI bucket behind the Thai `status` column. */
  status: string; statusCategory: DocumentStatusCategory | "split" | null;
  needsReview: boolean; errorMessage: string | null;
  createdAt: string; processedAt: string | null;
  reviewedAt: string | null; reviewedBy: string | null; reviewedByName: string | null;
  deliveryStatus: DeliveryStatus;
  /** `raw_response #>> '{layout,detection,verdict}'`, the detected form template. Never the whole jsonb. */
  template: string | null;
  structuredResult: DocumentView;
}>;

export type FlattenOptions = Readonly<{ publicBaseUrl?: string | undefined }>;

/** Excel's cell limit is 32,767; longer text is cut here so the CSV writer never produces a cell Excel refuses. */
export const MAX_CELL_LENGTH = 32_000;
export const TRUNCATION_SUFFIX = "…[ตัดทอน]";
/** A reading the system is not sure of: a value that is still flagged, or a `raw` with no confirmed value behind it. */
export const UNVERIFIED_SUFFIX = "(?)";
/** Treatments 1–4 get their own columns; item 5 onward are joined into `treatments_more`. */
export const TREATMENT_COLUMNS = 4;
/** Lists (checkbox groups, treatments, flagged paths) are joined with this, as the design specifies. */
export const LIST_SEPARATOR = "; ";

type Json = Record<string, unknown>;
type Scalar = Readonly<{ key: string; th: string; section: keyof DocumentView; field: string }>;

function isRecord(value: unknown): value is Json { return typeof value === "object" && value !== null && !Array.isArray(value); }
function text(value: unknown): string | null {
  const raw = typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : null;
  return raw === null || raw.trim() === "" ? null : raw;
}
function numberOrNull(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function joined(values: readonly (string | null)[]): string | null {
  const kept = values.filter((value): value is string => value !== null);
  return kept.length === 0 ? null : kept.join(LIST_SEPARATOR);
}
function label(field: string): string { return FIELD_LABELS_TH[field] ?? field; }

/** The scalar (single `Field`) columns, in the order they appear in the file; `columns=detailed` expands each of them. */
const SCALARS: readonly Scalar[] = [
  { key: "form_number", th: label("formNumber"), section: "header", field: "formNumber" },
  { key: "form_date", th: label("date"), section: "header", field: "date" },
  { key: "form_time", th: label("time"), section: "header", field: "time" },
  { key: "branch", th: label("branch"), section: "staffOnly", field: "branch" },
  { key: "customer_name", th: label("name"), section: "customerInformation", field: "name" },
  { key: "gender", th: label("gender"), section: "customerInformation", field: "gender" },
  { key: "nationality", th: label("nationality"), section: "customerInformation", field: "nationality" },
  { key: "hotel_name", th: label("hotelName"), section: "customerInformation", field: "hotelName" },
  { key: "pressure", th: label("pressure"), section: "recommendationCard", field: "pressure" },
  { key: "therapist", th: label("therapistName"), section: "staffOnly", field: "therapistName" },
  { key: "room", th: label("roomNo"), section: "staffOnly", field: "roomNo" }
];
const SCALAR_BY_KEY: ReadonlyMap<string, Scalar> = new Map(SCALARS.map((scalar) => [scalar.key, scalar]));

/** The checkbox lists, joined into one cell each. */
const LISTS: readonly Readonly<{ key: string; th: string; section: keyof DocumentView; field: string }>[] = [
  { key: "referral_sources", th: label("referralSources"), section: "customerInformation", field: "referralSources" },
  { key: "health_conditions", th: label("healthConditions"), section: "customerInformation", field: "healthConditions" },
  { key: "massage_oil_scrub", th: label("massageOilScrub"), section: "recommendationCard", field: "massageOilScrub" },
  { key: "preferred_areas", th: label("preferredAreas"), section: "recommendationCard", field: "preferredAreas" },
  { key: "avoid_areas", th: label("avoidAreas"), section: "recommendationCard", field: "avoidAreas" }
];

const LIST_BY_KEY: ReadonlyMap<string, typeof LISTS[number]> = new Map(LISTS.map((list) => [list.key, list]));
/** A text column named by its key, from the scalar-field or checkbox-list table above (the labels live in one place). */
function fieldColumn(key: string): ExportColumn {
  const field = SCALAR_BY_KEY.get(key) ?? LIST_BY_KEY.get(key);
  if (!field) throw new Error(`EXPORT_COLUMN_UNKNOWN:${key}`);
  return { key: field.key, th: field.th, kind: "text" };
}
const treatmentColumns: readonly ExportColumn[] = Array.from({ length: TREATMENT_COLUMNS }, (_unused, index) => index + 1).flatMap((n) => [
  { key: `treatment_${n}_name`, th: `${label("treatments")} ${n}`, kind: "text" as const },
  { key: `treatment_${n}_duration`, th: `${label("duration")} ${n}`, kind: "text" as const },
  { key: `treatment_${n}_minutes`, th: `นาที ${n}`, kind: "number" as const }
]);

/**
 * The compact column set. Order is part of the contract: the four required columns, then batch and review, the form
 * fields, treatments and staff, the review metadata and finally the links and ids.
 */
export const EXPORT_COLUMNS: readonly ExportColumn[] = [
  { key: "original_file_name", th: "ชื่อไฟล์ต้นฉบับ", kind: "text" },
  { key: "page", th: "หน้า", kind: "number" },
  { key: "page_count", th: "จำนวนหน้า", kind: "number" },
  { key: "uploaded_at", th: "อัปโหลดเมื่อ", kind: "datetime" },
  { key: "batch_label", th: "ชุดอัปโหลด", kind: "text" },
  { key: "status", th: "สถานะ", kind: "text" },
  { key: "reviewed", th: "ยืนยันแล้ว", kind: "bool" },
  { key: "reviewed_at", th: "ยืนยันเมื่อ", kind: "datetime" },
  { key: "reviewed_by", th: "ยืนยันโดย", kind: "text" },
  ...["form_number", "form_date", "form_time", "branch", "customer_name", "gender", "nationality", "hotel_name",
    "referral_sources", "health_conditions", "pressure", "massage_oil_scrub", "preferred_areas", "avoid_areas"].map(fieldColumn),
  { key: "treatments", th: label("treatments"), kind: "text" },
  ...treatmentColumns,
  { key: "treatments_more", th: `${label("treatments")} (รายการที่ ${TREATMENT_COLUMNS + 1} ขึ้นไป)`, kind: "text" },
  { key: "total_minutes", th: "รวมนาที", kind: "number" },
  ...["therapist", "room"].map(fieldColumn),
  { key: "needs_review", th: "ต้องตรวจสอบ", kind: "bool" },
  { key: "review_fields", th: "ช่องที่ต้องตรวจ", kind: "text" },
  { key: "min_confidence", th: "ความมั่นใจต่ำสุด", kind: "number" },
  { key: "delivery_status", th: "การส่งการแก้ไขให้ AI", kind: "text" },
  { key: "error_message", th: "ข้อความผิดพลาด", kind: "text" },
  { key: "template", th: "แม่แบบที่ตรวจพบ", kind: "text" },
  { key: "processed_at", th: "อ่านเสร็จเมื่อ", kind: "datetime" },
  { key: "review_url", th: "ลิงก์ตรวจสอบ", kind: "text" },
  { key: "document_id", th: "รหัสเอกสาร", kind: "text" },
  { key: "batch_id", th: "รหัสชุดอัปโหลด", kind: "text" },
  { key: "parent_document_id", th: "รหัสเอกสารต้นฉบับ", kind: "text" },
  { key: "status_code", th: "รหัสสถานะ", kind: "text" }
];

/** `columns=detailed` appends the four provenance columns of every scalar field, in the scalar fields' own order. */
export const EXPORT_DETAIL_SUFFIXES: readonly Readonly<{ suffix: string; th: string; kind: ExportColumnKind }>[] = [
  { suffix: "_raw", th: "ข้อความดิบ", kind: "text" },
  { suffix: "_confidence", th: "ความมั่นใจ", kind: "number" },
  { suffix: "_needs_review", th: "ต้องตรวจ", kind: "bool" },
  { suffix: "_source", th: "ที่มา", kind: "text" }
];
export const EXPORT_COLUMNS_DETAILED: readonly ExportColumn[] = [
  ...EXPORT_COLUMNS,
  ...SCALARS.flatMap((scalar) => EXPORT_DETAIL_SUFFIXES.map((detail) => ({ key: `${scalar.key}${detail.suffix}`, th: `${scalar.th} (${detail.th})`, kind: detail.kind })))
];

export function exportColumns(set: ExportColumnSet): readonly ExportColumn[] {
  return set === "detailed" ? EXPORT_COLUMNS_DETAILED : EXPORT_COLUMNS;
}

function sectionOf(view: DocumentView, section: keyof DocumentView): Json {
  const value = view[section];
  return isRecord(value) ? value : {};
}
function fieldOf(view: DocumentView, section: keyof DocumentView, field: string): Json | null {
  const value = sectionOf(view, section)[field];
  return isRecord(value) ? value : null;
}
function itemsOf(view: DocumentView, section: keyof DocumentView, field: string): Json[] {
  const value = sectionOf(view, section)[field];
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/**
 * Design §3.2: a cell shows `value`; when there is no value but a `raw` reading exists it shows `raw + " (?)"`, so
 * nothing the model read is dropped; and a reading that is still flagged keeps the same marker, so a row exported
 * before anyone reviewed it never looks confirmed. A confirmed document has no flags left (`markReviewed`).
 */
export function fieldCell(field: unknown): string | null {
  if (!isRecord(field)) return text(field);
  const value = text(field.value);
  if (value !== null) return field.needsReview === true ? `${value} ${UNVERIFIED_SUFFIX}` : value;
  const raw = text(field.raw);
  return raw === null ? null : `${raw} ${UNVERIFIED_SUFFIX}`;
}

/** One treatment as staff read it: the service and its duration, e.g. "นวดไทย 90 นาที". */
function treatmentCell(item: Json): string | null {
  const name = fieldCell(item);
  const duration = text(item.duration);
  return name === null ? duration : duration === null ? name : `${name} ${duration}`;
}

/**
 * Canonical paths of every field still flagged for review, for the `review_fields` column: `staffOnly.treatments[1]`,
 * `customerInformation.name`. Array items carry their index, so the cell says which item needs a second look.
 */
export function flaggedPaths(view: DocumentView): string[] {
  const paths: string[] = [];
  for (const section of ["header", "customerInformation", "recommendationCard", "staffOnly"] as const) {
    const values = sectionOf(view, section);
    for (const [key, value] of Object.entries(values)) {
      if (Array.isArray(value)) value.forEach((item, index) => { if (isRecord(item) && item.needsReview === true) paths.push(`${section}.${key}[${index}]`); });
      else if (isRecord(value) && value.needsReview === true) paths.push(`${section}.${key}`);
    }
  }
  return paths;
}

/**
 * One document → one value per column of `set`. Values are typed (numbers stay numbers, `datetime` stays the ISO UTC
 * instant): the CSV writer formats and guards them, JSONL emits them as they are, and the preview renders the CSV's
 * strings. Truncation and the formula guard belong to the CSV writer alone — JSONL is the lossless format (§10 H5).
 */
export function flattenDocument(document: ExportDocument, set: ExportColumnSet = "compact", options: FlattenOptions = {}): ExportValues {
  const view = normalizeStructuredResult(document.structuredResult);
  const summary = summarizeDocument(view);
  const treatments = itemsOf(view, "staffOnly", "treatments");
  const confirmed = document.reviewedAt !== null;
  const baseUrl = options.publicBaseUrl ?? "";
  const values: Record<string, ExportValue> = {
    original_file_name: document.parentFilename ?? document.filename,
    page: document.pageNumber,
    page_count: document.pageCount,
    uploaded_at: document.createdAt,
    batch_label: document.batchLabel,
    status: document.statusCategory === null ? null : CATEGORY_LABELS_TH[document.statusCategory],
    reviewed: confirmed,
    reviewed_at: document.reviewedAt,
    // §10 H3: the reviewer, or the pre-login shared account's label; empty while the row is not confirmed.
    reviewed_by: confirmed ? reviewerLabel(document.reviewedBy, document.reviewedByName) : null,
    treatments: joined(treatments.map(treatmentCell)),
    treatments_more: joined(treatments.slice(TREATMENT_COLUMNS).map(treatmentCell)),
    total_minutes: numberOrNull(sectionOf(view, "staffOnly").totalMinutes),
    needs_review: document.needsReview,
    review_fields: joined(flaggedPaths(view)),
    min_confidence: summary.minConfidence,
    delivery_status: document.deliveryStatus === "NONE" ? null : DELIVERY_LABELS_TH[document.deliveryStatus],
    error_message: document.errorMessage,
    template: document.template,
    processed_at: document.processedAt,
    review_url: baseUrl === "" ? null : `${baseUrl}/review/${document.documentId}`,
    document_id: document.documentId,
    batch_id: document.batchId,
    parent_document_id: document.parentDocumentId,
    status_code: document.status
  };
  for (const scalar of SCALARS) values[scalar.key] = fieldCell(fieldOf(view, scalar.section, scalar.field));
  for (const list of LISTS) values[list.key] = joined(itemsOf(view, list.section, list.field).map(fieldCell));
  for (let index = 0; index < TREATMENT_COLUMNS; index += 1) {
    const item = treatments[index];
    values[`treatment_${index + 1}_name`] = item ? fieldCell(item) : null;
    values[`treatment_${index + 1}_duration`] = item ? text(item.duration) : null;
    values[`treatment_${index + 1}_minutes`] = item ? numberOrNull(item.durationMinutes) : null;
  }
  if (set === "detailed") {
    for (const scalar of SCALARS) {
      const field = fieldOf(view, scalar.section, scalar.field);
      values[`${scalar.key}_raw`] = field ? text(field.raw) : null;
      values[`${scalar.key}_confidence`] = field ? numberOrNull(field.confidence) : null;
      values[`${scalar.key}_needs_review`] = field ? field.needsReview === true : null;
      values[`${scalar.key}_source`] = field ? text(field.source) : null;
    }
  }
  return values;
}

/** Bangkok wall-clock `YYYY-MM-DD HH:MM:SS` of an ISO instant — what Excel parses as a date (design §3.2). */
export function bangkokTimestamp(iso: string | null): string | null {
  if (iso === null) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  return new Date(at + 7 * 3_600_000).toISOString().replace("T", " ").slice(0, 19);
}

/**
 * The display string of one value: what the CSV cell holds (before the formula guard) and what the preview table shows.
 * Times become Bangkok wall-clock, booleans TRUE/FALSE, numbers are bare, and text over `MAX_CELL_LENGTH` is cut.
 */
export function formatCell(value: ExportValue, kind: ExportColumnKind): string {
  if (value === null) return "";
  if (kind === "datetime") return typeof value === "string" ? bangkokTimestamp(value) ?? "" : "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return String(value);
  return value.length > MAX_CELL_LENGTH ? `${value.slice(0, MAX_CELL_LENGTH - TRUNCATION_SUFFIX.length)}${TRUNCATION_SUFFIX}` : value;
}

/** One document → the display strings of `set`, in column order: the preview's row, and the CSV's row before quoting. */
export function exportCells(document: ExportDocument, set: ExportColumnSet = "compact", options: FlattenOptions = {}): string[] {
  const values = flattenDocument(document, set, options);
  return exportColumns(set).map((column) => formatCell(values[column.key] ?? null, column.kind));
}

/**
 * The filters the document list and the export share (§10 H2). `status` is one category for the list and any number of
 * them (OR-ed) for the export; `from`/`to` are `YYYY-MM-DD` Bangkok days applied to `dateField`.
 */
export type ExportDateField = "created_at" | "reviewed_at";
export type DocumentFilter = {
  status?: DocumentStatusCategory | readonly DocumentStatusCategory[] | undefined;
  q?: string | undefined; batchId?: string | undefined; parentId?: string | undefined;
  confirmedOnly?: boolean | undefined; from?: string | undefined; to?: string | undefined;
  dateField?: ExportDateField | undefined;
};
