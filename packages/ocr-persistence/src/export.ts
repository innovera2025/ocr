/**
 * The export's column contract and row flattening (plan §10 H3, design §3.2). Pure: it takes one `ExportDocument` —
 * what `index.ts` reads per document row — and returns one value per column. The CSV writer, the JSONL writer and the
 * preview table all render THESE values, so the file a staff member downloads and the 20 rows they previewed can never
 * disagree.
 *
 * The four columns the user asked for come first, in this order: ชื่อไฟล์ต้นฉบับ (the ORIGINAL uploaded file name, so
 * a page of a split PDF shows the PDF's name, never `page-003.png`), หน้า, จำนวนหน้า and อัปโหลดเมื่อ
 * (`release2-requirements.md`).
 *
 * Every confidence in the file is an integer percent 0-100 rounded like the workbench's `pct()`
 * (`displayedConfidencePercent`), so the document list, the review drawer and the export agree. The column guide for
 * staff is `docs/operations/real-data/export-columns-guide.md` (its column table is pinned to `EXPORT_COLUMNS_DETAILED`).
 */
import { displayedConfidencePercent } from "./document-sort.js";
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
  /**
   * `documents.updated_at` exactly as the export's own snapshot read it: an opaque, exact-microsecond UTC string made in
   * SQL (a JS `Date` keeps milliseconds only, and a truncated snapshot would make every exported row look changed). It
   * travels from the cursor to `recordExportMarks` and is never rendered: no column reads it, so the file is unchanged.
   */
  rowVersion: string;
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
  { key: "referral_other", th: label("referralOther"), section: "customerInformation", field: "referralOther" },
  { key: "health_other", th: label("healthOther"), section: "customerInformation", field: "healthOther" },
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
 * The compact column set (57). Order is part of the contract: the four required columns, then batch and review, the
 * form fields, treatments and staff, the review metadata, the links and ids, and finally the three OCR-only reading
 * summary columns (`ocrReadSummary`), appended LAST so none of the first 54 positions moved when they were added.
 * `min_confidence` is an integer percent: an edited field counts as 100, an unread one is skipped (`summarizeDocument`).
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
    "referral_sources", "referral_other", "health_conditions", "health_other", "pressure", "massage_oil_scrub", "preferred_areas", "avoid_areas"].map(fieldColumn),
  { key: "treatments", th: label("treatments"), kind: "text" },
  ...treatmentColumns,
  { key: "treatments_more", th: `${label("treatments")} (รายการที่ ${TREATMENT_COLUMNS + 1} ขึ้นไป)`, kind: "text" },
  { key: "total_minutes", th: "รวมนาที", kind: "number" },
  ...["therapist", "room"].map(fieldColumn),
  { key: "needs_review", th: "ต้องตรวจสอบ", kind: "bool" },
  { key: "review_fields", th: "ช่องที่ต้องตรวจ", kind: "text" },
  { key: "min_confidence", th: "ความมั่นใจต่ำสุด (%)", kind: "number" },
  { key: "delivery_status", th: "การส่งการแก้ไขให้ AI", kind: "text" },
  { key: "error_message", th: "ข้อความผิดพลาด", kind: "text" },
  { key: "template", th: "แม่แบบที่ตรวจพบ", kind: "text" },
  { key: "processed_at", th: "อ่านเสร็จเมื่อ", kind: "datetime" },
  { key: "review_url", th: "ลิงก์ตรวจสอบ", kind: "text" },
  { key: "document_id", th: "รหัสเอกสาร", kind: "text" },
  { key: "batch_id", th: "รหัสชุดอัปโหลด", kind: "text" },
  { key: "parent_document_id", th: "รหัสเอกสารต้นฉบับ", kind: "text" },
  { key: "status_code", th: "รหัสสถานะ", kind: "text" },
  { key: "handwriting_confidence", th: "% อ่านลายมือ (OCR)", kind: "number" },
  // Words, not "7/9": Excel turns a text like 7/9 into a date when the CSV is opened.
  { key: "handwriting_read", th: "ลายมืออ่านได้ (ช่อง)", kind: "text" },
  { key: "checkbox_confidence", th: "% ช่องติ๊ก (OCR)", kind: "number" }
];

type DetailSuffix = Readonly<{ suffix: string; th: string; kind: ExportColumnKind }>;
/**
 * The full set ("ทั้งหมด", `columns=detailed`) appends, per scalar field in `SCALARS` order: the OCR text, the
 * effective confidence % (an edited field is 100), the original OCR %, the review flag, the raw source code and the
 * edited flag.
 */
export const EXPORT_SCALAR_SUFFIXES: readonly DetailSuffix[] = [
  { suffix: "_raw", th: "ข้อความที่ OCR อ่าน", kind: "text" },
  { suffix: "_confidence", th: "ความมั่นใจ %", kind: "number" },
  { suffix: "_ocr_confidence", th: "ความมั่นใจ OCR เดิม %", kind: "number" },
  { suffix: "_needs_review", th: "ต้องตรวจ", kind: "bool" },
  { suffix: "_source", th: "ที่มา", kind: "text" },
  { suffix: "_edited", th: "แก้ไขโดยพนักงาน", kind: "bool" }
];
/** Per checkbox list (`LISTS` order), one aggregate over its items; no `_source`, since the items mix sources. */
export const EXPORT_LIST_SUFFIXES: readonly DetailSuffix[] = [
  { suffix: "_raw", th: "ข้อความที่ OCR อ่าน", kind: "text" },
  { suffix: "_confidence", th: "ความมั่นใจ %", kind: "number" },
  { suffix: "_ocr_confidence", th: "ความมั่นใจ OCR เดิม %", kind: "number" },
  { suffix: "_needs_review", th: "ต้องตรวจ", kind: "bool" },
  { suffix: "_edited", th: "แก้ไขโดยพนักงาน", kind: "bool" }
];
/** Per treatment slot 1..4 (`treatment_N`); items 5 and up stay value-only in `treatments_more`. */
export const EXPORT_TREATMENT_SUFFIXES: readonly DetailSuffix[] = [
  { suffix: "_raw", th: "ข้อความที่ OCR อ่าน", kind: "text" },
  { suffix: "_confidence", th: "ความมั่นใจ %", kind: "number" },
  { suffix: "_ocr_confidence", th: "ความมั่นใจ OCR เดิม %", kind: "number" },
  { suffix: "_edited", th: "แก้ไขโดยพนักงาน", kind: "bool" },
  { suffix: "_guests", th: "จำนวนลูกค้า", kind: "number" }
];
function detailColumns(base: Readonly<{ key: string; th: string }>, suffixes: readonly DetailSuffix[]): ExportColumn[] {
  return suffixes.map((detail) => ({ key: `${base.key}${detail.suffix}`, th: `${base.th} (${detail.th})`, kind: detail.kind }));
}
const TREATMENT_SLOTS: readonly Readonly<{ key: string; th: string }>[] = Array.from({ length: TREATMENT_COLUMNS }, (_unused, index) =>
  ({ key: `treatment_${index + 1}`, th: `${label("treatments")} ${index + 1}` }));
/**
 * The full column set (180) = compact (57) + 13 scalars x 6 + 5 lists x 5 + 4 treatment slots x 5. It only APPENDS to
 * compact, so every compact position is the same in both files.
 */
export const EXPORT_COLUMNS_DETAILED: readonly ExportColumn[] = [
  ...EXPORT_COLUMNS,
  ...SCALARS.flatMap((scalar) => detailColumns(scalar, EXPORT_SCALAR_SUFFIXES)),
  ...LISTS.flatMap((list) => detailColumns(list, EXPORT_LIST_SUFFIXES)),
  ...TREATMENT_SLOTS.flatMap((slot) => detailColumns(slot, EXPORT_TREATMENT_SUFFIXES))
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

// ---- per-leaf confidence, original OCR % and the edited flag (full set) ------------------------------------------

/** `document-view.ts`'s own `text()` (a boolean or "" is still text there), so `isUnreadLeaf` matches `isUnread` exactly. */
function storedText(value: unknown): string | null {
  return typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : typeof value === "boolean" ? String(value) : null;
}
/**
 * Mirror of the private `isUnread` in `document-view.ts` (kept private there on purpose): nothing found, not flagged.
 * Such a leaf has no confidence in the file, exactly as `summarizeDocument` skips it; `export.test.ts` pins the parity.
 */
function isUnreadLeaf(leaf: Json): boolean {
  return leaf.source === "none" && leaf.needsReview !== true && storedText(leaf.raw) === null && storedText(leaf.value) === null;
}
/** A reviewer CHANGED this leaf (or added it): the save path writes `source:"human"` and keeps the OCR `raw`/`confidence`. */
function isEditedLeaf(leaf: Json): boolean { return leaf.source === "human"; }
/** What the OCR wrote for the leaf: `raw`, and for a treatment the service as written (`nameRaw`) first. */
function ocrTextOf(leaf: Json, treatment: boolean): string | null {
  return treatment ? text(leaf.nameRaw) ?? text(leaf.raw) : text(leaf.raw);
}
/** Effective confidence %: an edited leaf is 100 (a person set it), an unread one has none, else the OCR's own %. */
function leafConfidence(leaf: Json): number | null {
  if (isUnreadLeaf(leaf)) return null;
  return isEditedLeaf(leaf) ? 100 : displayedConfidencePercent(leaf.confidence);
}
/**
 * Original OCR %: for a leaf nobody edited it is its effective %. For an edited leaf it is the OCR confidence the save
 * kept, but only when the OCR had text there; a leaf staff added (or filled where the OCR read nothing) has none.
 */
function leafOcrConfidence(leaf: Json, treatment = false): number | null {
  if (!isEditedLeaf(leaf)) return leafConfidence(leaf);
  return ocrTextOf(leaf, treatment) === null ? null : displayedConfidencePercent(leaf.confidence);
}
function minOrNull(values: readonly (number | null)[]): number | null {
  const kept = values.filter((value): value is number => value !== null);
  return kept.length === 0 ? null : Math.min(...kept);
}

// ---- the OCR-only reading summary (both sets, and the drawer's summary line) -------------------------------------

/**
 * Slots whose value the model READS from handwriting. Groups are slots, not sources: a reviewer's edit overwrites
 * `source` with "human", so the slot must say which group a leaf belongs to. `branch` is neither (layout/rules).
 * Source facts (Local AI `local-ai/ocr_confidence.py` `_SKIP_SOURCES = ("ink-mark", "none", "checkbox")`): the model
 * reads `ocr`, `rule`, `master-fuzzy`, `visual-alias` and `verified-memory`; `ink-mark` is the ink check (an empty
 * date/time box is `ink-mark`, value null, 0.95); `none` with a review flag is ink the model could not read.
 * The drawer's `ocrSummary` in `apps/ocr-web/src/workbench.ts` is a line-for-line port; a parity test pins the two.
 */
const HANDWRITTEN_KEYS: readonly string[] = ["form_number", "form_date", "form_time", "customer_name", "nationality", "hotel_name", "therapist", "room", "referral_other", "health_other"];
const HANDWRITTEN_SLOTS: readonly Scalar[] = SCALARS.filter((scalar) => HANDWRITTEN_KEYS.includes(scalar.key));
/** Single-choice checkbox groups; every item of the five `LISTS` is a checkbox slot too. */
const CHECKBOX_KEYS: readonly string[] = ["gender", "pressure"];
const CHECKBOX_SLOTS: readonly Scalar[] = SCALARS.filter((scalar) => CHECKBOX_KEYS.includes(scalar.key));

/** The stored confidence as a percent, unrounded (fraction or percent, exactly like `displayedConfidencePercent`); 0 when none. */
function ocrPercent(leaf: Json): number {
  const confidence = leaf.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return 0;
  return confidence <= 1 ? confidence * 100 : confidence;
}
/**
 * Whether a handwritten leaf had writing on the page, and whether the OCR read it. An edited leaf keeps its OCR `raw`
 * and `confidence`, so the OCR text it kept proves writing that was read; an edited leaf without OCR text cannot be
 * placed (the save cleared the review flag and overwrote the source, and a 0 % reading looks the same whether the box
 * was empty or unreadable), so it is left out of both counts, like a leaf staff added.
 */
function handwritingState(leaf: Json, ocrText: string | null, written: boolean): Readonly<{ writing: boolean; read: boolean }> {
  if (isEditedLeaf(leaf)) return ocrText === null ? { writing: false, read: false } : { writing: true, read: true };
  if (leaf.source === "ink-mark") return { writing: false, read: false };
  if (written) return { writing: true, read: text(leaf.value) !== null };
  const unreadInk = leaf.source === "none" && leaf.needsReview === true;
  return { writing: unreadInk, read: false };
}
/**
 * Whether a checkbox leaf carries a mark the checkbox reader judged (`checkbox` / `ink-mark`); an unticked list item
 * and `none` (no mark found) do not. An edited leaf counts with the reading it kept when that reading is still
 * recognisable: OCR text, or a stored confidence strictly between 0 and 100 % (a staff-added leaf is 100 %, a `none`
 * leaf 0 %).
 */
function hasCheckboxMark(leaf: Json): boolean {
  if (leaf.checked === false) return false;
  if (isEditedLeaf(leaf)) {
    if (text(leaf.raw) !== null) return true;
    const percent = ocrPercent(leaf);
    return percent > 0 && percent < 100;
  }
  return leaf.source === "checkbox" || leaf.source === "ink-mark";
}
function meanPercent(values: readonly number[]): number | null {
  return values.length === 0 ? null : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

export type OcrReadSummary = Readonly<{
  /** Mean original OCR % over the handwritten slots that had writing (an unread one counts 0); null when none had. */
  handwritingConfidence: number | null;
  /** `read` of `withWriting` handwritten slots were read by the OCR. */
  handwritingRead: Readonly<{ read: number; withWriting: number }>;
  /** Mean original OCR % over the checkbox leaves that carry a mark; null when there is none. */
  checkboxConfidence: number | null;
}>;

/**
 * How well the MACHINE read this form, from the stored leaves only: handwriting (the slots above plus every treatment
 * item, name and duration together) and checkboxes (gender, pressure and the items of the five lists). It uses the
 * original OCR confidence only, never the 100 % of an edit, so reviewing a document does not move these numbers.
 * Known limit: a save clears every review flag, so after it a `none` slot the OCR could not read no longer counts as
 * writing. Never throws.
 */
export function ocrReadSummary(view: DocumentView): OcrReadSummary {
  const handwriting: number[] = [];
  let read = 0;
  const count = (leaf: Json, ocrText: string | null, written: boolean): void => {
    const state = handwritingState(leaf, ocrText, written);
    if (!state.writing) return;
    handwriting.push(state.read ? ocrPercent(leaf) : 0);
    if (state.read) read += 1;
  };
  for (const slot of HANDWRITTEN_SLOTS) {
    const leaf = fieldOf(view, slot.section, slot.field);
    if (leaf) count(leaf, text(leaf.raw), text(leaf.raw) !== null || text(leaf.value) !== null);
  }
  for (const item of itemsOf(view, "staffOnly", "treatments")) {
    const ocrText = ocrTextOf(item, true);
    count(item, ocrText, ocrText !== null || text(item.value) !== null || text(item.duration) !== null);
  }
  const checkbox: number[] = [];
  const mark = (leaf: Json): void => { if (hasCheckboxMark(leaf)) checkbox.push(ocrPercent(leaf)); };
  for (const slot of CHECKBOX_SLOTS) { const leaf = fieldOf(view, slot.section, slot.field); if (leaf) mark(leaf); }
  for (const list of LISTS) itemsOf(view, list.section, list.field).forEach(mark);
  return { handwritingConfidence: meanPercent(handwriting), handwritingRead: { read, withWriting: handwriting.length }, checkboxConfidence: meanPercent(checkbox) };
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
  const reading = ocrReadSummary(view);
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
    min_confidence: displayedConfidencePercent(summary.minConfidence),
    delivery_status: document.deliveryStatus === "NONE" ? null : DELIVERY_LABELS_TH[document.deliveryStatus],
    error_message: document.errorMessage,
    template: document.template,
    processed_at: document.processedAt,
    review_url: baseUrl === "" ? null : `${baseUrl}/review/${document.documentId}`,
    document_id: document.documentId,
    batch_id: document.batchId,
    parent_document_id: document.parentDocumentId,
    status_code: document.status,
    handwriting_confidence: reading.handwritingConfidence,
    handwriting_read: reading.handwritingRead.withWriting === 0 ? null : `${reading.handwritingRead.read} จาก ${reading.handwritingRead.withWriting}`,
    checkbox_confidence: reading.checkboxConfidence
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
    // Every key of the set is assigned for every row: a missing field, an empty list or an absent slot is null.
    for (const scalar of SCALARS) {
      const field = fieldOf(view, scalar.section, scalar.field);
      values[`${scalar.key}_raw`] = field ? text(field.raw) : null;
      values[`${scalar.key}_confidence`] = field ? leafConfidence(field) : null;
      values[`${scalar.key}_ocr_confidence`] = field ? leafOcrConfidence(field) : null;
      values[`${scalar.key}_needs_review`] = field ? field.needsReview === true : null;
      values[`${scalar.key}_source`] = field ? text(field.source) : null;
      values[`${scalar.key}_edited`] = field ? isEditedLeaf(field) : null;
    }
    for (const list of LISTS) {
      const items = itemsOf(view, list.section, list.field);
      const any = items.length > 0;
      values[`${list.key}_raw`] = joined(items.map((item) => text(item.raw)));
      values[`${list.key}_confidence`] = minOrNull(items.map(leafConfidence));
      values[`${list.key}_ocr_confidence`] = minOrNull(items.map((item) => leafOcrConfidence(item)));
      values[`${list.key}_needs_review`] = any ? items.some((item) => item.needsReview === true) : null;
      values[`${list.key}_edited`] = any ? items.some(isEditedLeaf) : null;
    }
    TREATMENT_SLOTS.forEach((slot, index) => {
      const item = treatments[index];
      values[`${slot.key}_raw`] = item ? ocrTextOf(item, true) : null;
      values[`${slot.key}_confidence`] = item ? leafConfidence(item) : null;
      values[`${slot.key}_ocr_confidence`] = item ? leafOcrConfidence(item, true) : null;
      values[`${slot.key}_edited`] = item ? isEditedLeaf(item) : null;
      values[`${slot.key}_guests`] = item ? numberOrNull(item.guests) : null;
    });
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
  return value.length > MAX_CELL_LENGTH ? `${value.slice(0, truncationEnd(value))}${TRUNCATION_SUFFIX}` : value;
}

/**
 * Where a cell is cut. `slice` counts UTF-16 units, so a cut landing between the two halves of a surrogate pair emits
 * a lone surrogate that any UTF-8 encoder turns into U+FFFD; backing off one unit keeps the cell valid text and still
 * inside Excel's limit. Thai is entirely BMP — this is for emoji and the astral blocks.
 */
function truncationEnd(value: string): number {
  const end = MAX_CELL_LENGTH - TRUNCATION_SUFFIX.length;
  const last = value.charCodeAt(end - 1);
  return last >= 0xd800 && last <= 0xdbff ? end - 1 : end;
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
/** A document's export history state: `exported` while its latest event is a download or a manual mark, else `never`. */
export type ExportState = "never" | "exported";
/**
 * `exportState` keeps only rows in that history state. `ids` is an explicit selection (the rows a staff member ticked):
 * at most `EXPORT_SELECTION_MAX` distinct UUIDs, matched under the tenant and the visibility rule like everything else.
 * Its presence is what tells the store a selection was made (an empty match is then EXPORT_SELECTION_EMPTY).
 */
export type DocumentFilter = {
  status?: DocumentStatusCategory | readonly DocumentStatusCategory[] | undefined;
  q?: string | undefined; batchId?: string | undefined; parentId?: string | undefined;
  confirmedOnly?: boolean | undefined; from?: string | undefined; to?: string | undefined;
  dateField?: ExportDateField | undefined;
  exportState?: ExportState | undefined;
  ids?: readonly string[] | undefined;
};

/** The most rows one explicit (`ids`) selection may name, after de-duplication. "Select all matching" uses a filter instead. */
export const EXPORT_SELECTION_MAX = 5000;

/** One row of the export dialog's list: identifying fields only (what the document list shows) plus its export history. */
export type ExportCandidate = Readonly<{
  documentId: string;
  /** The ORIGINAL uploaded file name: the PDF's name for a page of a split PDF. */
  filename: string;
  pageNumber: number | null; pageCount: number | null;
  statusCategory: DocumentStatusCategory; needsReview: boolean;
  customerName: string | null; formNumber: string | null;
  createdAt: string; reviewedAt: string | null;
  exportState: ExportState;
  /** Exported, and `documents.updated_at` moved past the value the latest download or mark saw. */
  changedAfterExport: boolean;
  /** The latest download or manual mark; all three are null while the row is `never` exported (incl. after an unmark). */
  lastExportedAt: string | null; lastExportKind: "exported" | "marked" | null; lastExportedByName: string | null;
}>;
/** `never`/`exported`/`all` count the filter WITHOUT `exportState` (stable tab labels); `unconfirmed` counts the current tab. */
export type ExportCandidateCounts = Readonly<{ never: number; exported: number; all: number; unconfirmed: number }>;
/** `total` is the number of rows in the current tab (the filter WITH `exportState`). */
export type ExportCandidatesResult = Readonly<{ total: number; limit: number; offset: number; counts: ExportCandidateCounts; rows: ExportCandidate[] }>;
/**
 * What a completed download records (`recordExportMarks`): one `exported` event per streamed row, each with the
 * `rowVersion` the cursor read. `requestId` is the server-minted trace id that also stamps the request's audit rows.
 */
export type ExportMarkInput = Readonly<{
  kind: "exported"; source: "csv" | "jsonl"; actorUserId: string; requestId: string;
  rows: readonly Readonly<{ documentId: string; rowVersion: string }>[];
}>;
/**
 * A manual flip (`markExportState`). The selection is `filter`: an explicit one carries `ids` (and, from the dialog, the
 * `expectState` of the tab they were ticked in: every id must still be visible and, unless null, in that state, or the
 * flip is EXPORT_SELECTION_CHANGED), "select all matching" carries the filter and the `expectedTotal` the user saw.
 * `maxRows` is `OCR_EXPORT_MAX_ROWS`.
 */
export type ExportStateChangeInput = Readonly<{
  action: "mark" | "unmark"; filter: DocumentFilter; expectedTotal?: number | undefined; maxRows: number;
  expectState?: ExportState | null | undefined;
  actorUserId: string; requestId: string;
}>;
/** `total` rows matched the selection; `affected` got an event, `skipped` already were in the requested state. */
export type ExportMarkResult = Readonly<{ total: number; affected: number; skipped: number }>;
