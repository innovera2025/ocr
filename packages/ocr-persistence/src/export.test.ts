import assert from "node:assert/strict";
import { test } from "node:test";
import { displayedConfidencePercent } from "./document-sort.js";
import { applyReviewEdits, normalizeStructuredResult, summarizeDocument, type DocumentView } from "./document-view.js";
import { bangkokTimestamp, EXPORT_COLUMNS, EXPORT_COLUMNS_DETAILED, EXPORT_LIST_SUFFIXES, EXPORT_SCALAR_SUFFIXES, EXPORT_TREATMENT_SUFFIXES,
  exportCells, exportColumns, flattenDocument, flaggedPaths, formatCell, MAX_CELL_LENGTH, ocrReadSummary, TRUNCATION_SUFFIX,
  type ExportDocument } from "./export.js";
import { LEGACY_REVIEWER_LABEL } from "./labels.js";

const field = (raw: string | null, value: string | null, confidence: number, needsReview = false, source = "ocr") => ({ raw, value, confidence, source, needsReview });
const treatment = (nameRaw: string, value: string | null, duration: string | null, needsReview = false) =>
  ({ raw: nameRaw, nameRaw, value, duration, durationMinutes: duration === null ? null : Number.parseInt(duration, 10), confidence: 0.9, source: "master-fuzzy", needsReview });

const v31 = {
  schemaVersion: 3,
  header: { formNumber: field("A-0042", "A-0042", 0.99), date: field("22/09/2026", "22/09/2026", 0.9), time: field("14:05", "14:05", 0.8) },
  customerInformation: { name: field("Somchai", "Somchai", 0.92), gender: field("Male", "Male", 0.97, false, "checkbox"), nationality: field("Thai", "Thai", 0.9),
    hotelName: field("Blue Bay", "Blue Bay", 0.88), referralSources: [{ ...field("Walk-in", "Walk-in", 0.9, false, "checkbox"), checked: true }, { ...field("Friend", "Friend", 0.9, false, "checkbox"), checked: true }],
    healthConditions: [{ ...field("Menstruation", "Menstruation", 0.9, false, "checkbox"), checked: true }] },
  recommendationCard: { pressure: field("Strong", "Strong", 0.9, false, "checkbox"), massageOilScrub: [{ ...field("Lavender", "Lavender", 0.9, false, "checkbox"), checked: true }],
    preferredAreas: [{ ...field("Back", "Back", 0.9, false, "checkbox"), checked: true }], avoidAreas: [] },
  staffOnly: { branch: field("Rawai", "Rawai", 0.95), totalMinutes: 150,
    treatments: [treatment("ไทย", "นวดไทย", "90 นาที"), treatment("ฟุต", "นวดเท้า", "60 นาที")],
    therapistName: field("อันนา", "Anna", 1, false, "verified-memory"), roomNo: field("007", "007", 0.95) }
};

/** A page of a split PDF: the ORIGINAL uploaded PDF's name, its own page number, the parent's page count and time. */
const pageDocument: ExportDocument = {
  documentId: "11111111-1111-4111-8111-111111111111", batchId: "22222222-2222-4222-8222-222222222222", batchLabel: "รอบเช้า",
  filename: "page-002.png", parentFilename: "ใบลูกค้า 22-09-2026.pdf", parentDocumentId: "33333333-3333-4333-8333-333333333333",
  pageNumber: 2, pageCount: 5, status: "SUCCEEDED", statusCategory: "confirmed", needsReview: false, errorMessage: null,
  createdAt: "2026-09-22T07:05:00.000Z", processedAt: "2026-09-22T07:09:30.000Z",
  reviewedAt: "2026-09-22T08:00:00.000Z", reviewedBy: "44444444-4444-4444-8444-444444444444", reviewedByName: "นก พนักงาน",
  deliveryStatus: "DELIVERED", template: "makkha-v3", structuredResult: normalizeStructuredResult(v31),
  rowVersion: "2026-09-22T08:00:00.123456Z"
};

const cells = (document: ExportDocument, set: "compact" | "detailed" = "compact") => {
  const values = exportCells(document, set, { publicBaseUrl: "https://ocr.example.test/ocr" });
  return Object.fromEntries(exportColumns(set).map((column, index) => [column.key, values[index]!]));
};

test("the four required columns come first, in the order the user asked for", () => {
  assert.deepEqual(EXPORT_COLUMNS.slice(0, 4).map((column) => [column.key, column.th, column.kind]), [
    ["original_file_name", "ชื่อไฟล์ต้นฉบับ", "text"], ["page", "หน้า", "number"], ["page_count", "จำนวนหน้า", "number"], ["uploaded_at", "อัปโหลดเมื่อ", "datetime"]]);
  assert.equal(new Set(EXPORT_COLUMNS.map((column) => column.key)).size, EXPORT_COLUMNS.length, "column keys are unique");
  assert.equal(new Set(EXPORT_COLUMNS_DETAILED.map((column) => column.key)).size, EXPORT_COLUMNS_DETAILED.length);
  assert.deepEqual(EXPORT_COLUMNS_DETAILED.slice(0, EXPORT_COLUMNS.length), EXPORT_COLUMNS, "detailed only APPENDS to compact");
  assert.deepEqual(EXPORT_COLUMNS_DETAILED.slice(EXPORT_COLUMNS.length, EXPORT_COLUMNS.length + 6).map((column) => [column.key, column.kind]),
    [["form_number_raw", "text"], ["form_number_confidence", "number"], ["form_number_ocr_confidence", "number"], ["form_number_needs_review", "bool"],
      ["form_number_source", "text"], ["form_number_edited", "bool"]]);
  assert.equal(EXPORT_COLUMNS_DETAILED.length, EXPORT_COLUMNS.length + 13 * 6 + 5 * 5 + 4 * 5, "6 per scalar, 5 per list, 5 per treatment slot");
  // Pinned on purpose: the Others free-text change took compact 52 -> 54 and detailed 96 -> 106; the full-confidence
  // change appended the three OCR summary columns (compact 54 -> 57) and rebuilt the full set (106 -> 180). Anyone
  // reading the CSV by position must be told when these numbers move.
  assert.equal(EXPORT_COLUMNS.length, 57);
  assert.equal(EXPORT_COLUMNS_DETAILED.length, 180);
  assert.ok(EXPORT_COLUMNS.every((column) => column.th.trim().length > 0), "every column has a Thai header");
});

test("a page row carries the original file name, its page number, the page count and Bangkok upload time", () => {
  const row = cells(pageDocument);
  assert.equal(row.original_file_name, "ใบลูกค้า 22-09-2026.pdf");
  assert.deepEqual([row.page, row.page_count], ["2", "5"], "bare numbers: the UI's 'หน้า 2/5' is not a cell value");
  assert.equal(row.uploaded_at, "2026-09-22 14:05:00", "07:05 UTC is 14:05 in Bangkok");
  assert.equal(row.processed_at, "2026-09-22 14:09:30");
  assert.deepEqual([row.batch_label, row.status, row.status_code, row.reviewed], ["รอบเช้า", "ยืนยันแล้ว", "SUCCEEDED", "TRUE"]);
  assert.deepEqual([row.reviewed_at, row.reviewed_by], ["2026-09-22 15:00:00", "นก พนักงาน"]);
  assert.equal(row.review_url, "https://ocr.example.test/ocr/review/11111111-1111-4111-8111-111111111111");
  assert.deepEqual([row.document_id, row.batch_id, row.parent_document_id], [pageDocument.documentId, pageDocument.batchId, pageDocument.parentDocumentId]);
  assert.equal(row.delivery_status, "AI รับการแก้ไขแล้ว");
  assert.equal(row.room, "007", "room stays text: Excel must not eat the leading zeros");
});

test("a single image has no page number and no page count", () => {
  const image = { ...pageDocument, filename: "form.png", parentFilename: null, parentDocumentId: null, pageNumber: null, pageCount: null };
  const row = cells(image);
  assert.deepEqual([row.original_file_name, row.page, row.page_count, row.parent_document_id], ["form.png", "", "", ""]);
  const values = flattenDocument(image);
  assert.deepEqual([values.page, values.page_count], [null, null], "JSONL gets null, not an empty string");
});

test("v3.1 fields, joined lists and the first four treatments each get their column", () => {
  const row = cells(pageDocument);
  assert.deepEqual([row.form_number, row.form_date, row.form_time, row.branch], ["A-0042", "22/09/2026", "14:05", "Rawai"]);
  assert.deepEqual([row.customer_name, row.gender, row.nationality, row.hotel_name], ["Somchai", "Male", "Thai", "Blue Bay"]);
  assert.equal(row.referral_sources, "Walk-in; Friend");
  assert.deepEqual([row.health_conditions, row.pressure, row.massage_oil_scrub, row.preferred_areas, row.avoid_areas],
    ["Menstruation", "Strong", "Lavender", "Back", ""]);
  assert.equal(row.treatments, "นวดไทย 90 นาที; นวดเท้า 60 นาที");
  assert.deepEqual([row.treatment_1_name, row.treatment_1_duration, row.treatment_1_minutes], ["นวดไทย", "90 นาที", "90"]);
  assert.deepEqual([row.treatment_2_name, row.treatment_2_minutes, row.treatment_3_name, row.treatments_more], ["นวดเท้า", "60", "", ""]);
  assert.deepEqual([row.total_minutes, row.therapist, row.template], ["150", "Anna", "makkha-v3"]);
  assert.deepEqual([row.needs_review, row.review_fields, row.min_confidence], ["FALSE", "", "80"], "an integer percent, like the drawer");
});

test("more than four treatments: items 5 and up are joined into treatments_more", () => {
  const many = ["ไทย", "ฟุต", "หน้า", "คอบ่าไหล่", "น้ำมัน", "สครับ"].map((name, index) => treatment(name, `นวด${name}`, `${30 + index * 10} นาที`));
  const row = cells({ ...pageDocument, structuredResult: normalizeStructuredResult({ ...v31, staffOnly: { ...v31.staffOnly, treatments: many } }) });
  assert.equal(row.treatment_4_name, "นวดคอบ่าไหล่");
  assert.equal(row.treatments_more, "นวดน้ำมัน 70 นาที; นวดสครับ 80 นาที");
  assert.equal(row.treatments!.split("; ").length, 6, "the joined column still holds every item");
});

test("an unverified reading keeps its raw text and the (?) marker, so an export never looks confirmed", () => {
  const unsure = {
    schemaVersion: 3,
    customerInformation: { name: field("Chun Li", null, 0.41, true), gender: field(null, null, 0, false, "none") },
    staffOnly: { treatments: [treatment("ฟุต", null, "60 นาที", true), treatment("ไทย", "นวดไทย", "90 นาที", true)], roomNo: field("12", "12", 0.95) }
  };
  const document: ExportDocument = { ...pageDocument, statusCategory: "review", status: "NEEDS_REVIEW", needsReview: true, reviewedAt: null, reviewedBy: null,
    reviewedByName: null, deliveryStatus: "NONE", structuredResult: normalizeStructuredResult(unsure) };
  const row = cells(document);
  assert.equal(row.customer_name, "Chun Li (?)", "no confirmed value: the raw reading is kept, marked as unsure");
  assert.equal(row.gender, "", "nothing was read at all");
  assert.equal(row.treatments, "ฟุต (?) 60 นาที; นวดไทย (?) 90 นาที", "a flagged item keeps the marker even with a value");
  assert.equal(row.review_fields, "customerInformation.name; staffOnly.treatments[0]; staffOnly.treatments[1]");
  assert.deepEqual([row.needs_review, row.reviewed, row.reviewed_by, row.reviewed_at], ["TRUE", "FALSE", "", ""], "an unconfirmed row names no reviewer");
  assert.deepEqual([row.delivery_status, row.status], ["", "รอตรวจสอบ"]);
  assert.deepEqual(flaggedPaths(document.structuredResult), ["customerInformation.name", "staffOnly.treatments[0]", "staffOnly.treatments[1]"]);
});

test("legacy v2.2 rows flatten through the canonical view, and a legacy reviewer reads as the shared account", () => {
  const legacy = { treatment: { raw: "ไทย 60 นาที", durations: ["60 นาที"], needsReview: false,
      items: [{ raw: "ไทย", value: "นวดไทย", duration: "60 นาที", confidence: 0.95, source: "rule", needsReview: false }] },
    therapistName: field("Legacyname", "Legacyname", 1, false, "verified-memory"), roomNo: field("7", null, 0, true) };
  const row = cells({ ...pageDocument, reviewedBy: "front-desk", reviewedByName: null, structuredResult: normalizeStructuredResult(legacy) });
  assert.equal(row.treatments, "นวดไทย 60 นาที");
  assert.deepEqual([row.therapist, row.room], ["Legacyname", "7 (?)"]);
  assert.equal(row.reviewed_by, LEGACY_REVIEWER_LABEL, "a pre-login actor matches no user row");
  assert.deepEqual([row.form_number, row.customer_name, row.total_minutes], ["", "", ""], "a v2.2 row simply has no header or customer section");
});

test("the detailed column set adds the provenance of every scalar field", () => {
  const row = cells(pageDocument, "detailed");
  assert.deepEqual([row.customer_name_raw, row.customer_name_confidence, row.customer_name_ocr_confidence, row.customer_name_needs_review,
    row.customer_name_source, row.customer_name_edited], ["Somchai", "92", "92", "FALSE", "ocr", "FALSE"]);
  assert.deepEqual([row.therapist_source, row.gender_source], ["verified-memory", "checkbox"]);
  const missing = cells({ ...pageDocument, structuredResult: normalizeStructuredResult({ schemaVersion: 3 }) }, "detailed");
  assert.deepEqual([missing.customer_name_raw, missing.customer_name_confidence, missing.customer_name_needs_review], ["", "", ""]);
  assert.equal(exportColumns("detailed").length, EXPORT_COLUMNS_DETAILED.length);
  assert.equal(exportColumns("compact").length, EXPORT_COLUMNS.length);
});

test("display rules: Bangkok times, TRUE/FALSE, bare numbers and the 32,000-character cut", () => {
  assert.equal(formatCell("2026-01-01T17:30:00.000Z", "datetime"), "2026-01-02 00:30:00", "the day rolls over in Bangkok");
  assert.equal(formatCell(null, "datetime"), "");
  assert.equal(formatCell("not a date", "datetime"), "");
  assert.deepEqual([formatCell(true, "bool"), formatCell(false, "bool")], ["TRUE", "FALSE"]);
  assert.equal(formatCell(0.41, "number"), "0.41");
  assert.equal(formatCell("=cmd|'/c calc'!A1", "text"), "=cmd|'/c calc'!A1", "the formula guard belongs to the CSV writer, not here");
  const long = "ก".repeat(MAX_CELL_LENGTH + 500);
  const cut = formatCell(long, "text");
  assert.equal(cut.length, MAX_CELL_LENGTH);
  assert.ok(cut.endsWith(TRUNCATION_SUFFIX));
  assert.equal(formatCell("ก".repeat(MAX_CELL_LENGTH), "text").length, MAX_CELL_LENGTH, "exactly at the limit is untouched");
  assert.equal(bangkokTimestamp(null), null);
});

test("a cut that lands inside a surrogate pair drops the pair rather than emit a lone surrogate", () => {
  // `slice` counts UTF-16 units. A file name or a reading holding an emoji at exactly the cut would otherwise end in
  // a lone high surrogate, which any UTF-8 encoder writes as U+FFFD — a value the matching JSONL export does not have.
  const end = MAX_CELL_LENGTH - TRUNCATION_SUFFIX.length;
  for (const lead of [0, 1]) {
    const cut = formatCell(`${"ก".repeat(end - 1 + lead)}😀${"ก".repeat(600)}`, "text");
    assert.ok(cut.length <= MAX_CELL_LENGTH, "still inside Excel's cell limit");
    assert.ok(cut.endsWith(TRUNCATION_SUFFIX));
    assert.doesNotMatch(cut, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, "no half of a pair survives alone");
    assert.ok(!Buffer.from(cut, "utf8").includes(Buffer.from([0xef, 0xbf, 0xbd])), "and no U+FFFD is introduced");
  }
});

test("flattenDocument keeps typed values for JSONL: numbers, booleans and the ISO instant", () => {
  const values = flattenDocument(pageDocument, "compact", { publicBaseUrl: "https://ocr.example.test" });
  assert.deepEqual([values.page, values.page_count, values.total_minutes, values.treatment_1_minutes], [2, 5, 150, 90]);
  assert.deepEqual([values.reviewed, values.needs_review], [true, false]);
  assert.equal(values.uploaded_at, "2026-09-22T07:05:00.000Z", "the writers render Bangkok time; the value stays the UTC instant");
  assert.equal(values.min_confidence, 80);
  assert.equal(flattenDocument(pageDocument).review_url, null, "no configured base URL: no link, never one built from Host");
});

test("rowVersion is never rendered: the file is identical whatever snapshot the row carries (0021, D3)", () => {
  const other: ExportDocument = { ...pageDocument, rowVersion: "1999-01-01T00:00:00.000001Z" };
  for (const set of ["compact", "detailed"] as const) {
    assert.deepEqual(flattenDocument(other, set, { publicBaseUrl: "https://ocr.example.test" }),
      flattenDocument(pageDocument, set, { publicBaseUrl: "https://ocr.example.test" }), set);
    assert.deepEqual(exportCells(other, set), exportCells(pageDocument, set), set);
    assert.ok(!exportColumns(set).some((column) => /version/i.test(column.key)), `no ${set} column carries the snapshot`);
    assert.ok(!Object.values(flattenDocument(pageDocument, set)).includes(pageDocument.rowVersion), `no ${set} value is the snapshot`);
  }
});

test("Others free text: two columns right after their lists, filled from the Field, empty for old documents", () => {
  const keys = EXPORT_COLUMNS.map((column) => column.key);
  const at = keys.indexOf("referral_sources");
  assert.deepEqual(keys.slice(at, at + 4), ["referral_sources", "referral_other", "health_conditions", "health_other"]);
  const th = Object.fromEntries(EXPORT_COLUMNS.map((column) => [column.key, column.th]));
  assert.deepEqual([th.referral_other, th.health_other], ["รู้จักร้านจาก: อื่น ๆ (ระบุ)", "ภาวะสุขภาพ: อื่น ๆ (ระบุ)"]);
  assert.equal(EXPORT_COLUMNS.find((column) => column.key === "referral_other")!.kind, "text");
  const detailedKeys = EXPORT_COLUMNS_DETAILED.map((column) => column.key);
  for (const key of ["referral_other", "health_other"]) for (const suffix of ["_raw", "_confidence", "_ocr_confidence", "_needs_review", "_source", "_edited"]) assert.ok(detailedKeys.includes(`${key}${suffix}`), `${key}${suffix}`);

  const withOthers = (customer: Record<string, unknown>): ExportDocument => ({ ...pageDocument,
    structuredResult: normalizeStructuredResult({ ...v31, customerInformation: { ...v31.customerInformation, ...customer } }) });
  const typed = flattenDocument(withOthers({ referralOther: { raw: null, value: "Chat GPT", confidence: 1, source: "human", needsReview: false } }), "detailed");
  assert.deepEqual([typed.referral_other, typed.referral_other_source, typed.referral_other_confidence, typed.referral_other_ocr_confidence, typed.referral_other_edited, typed.health_other],
    ["Chat GPT", "human", 100, null, true, null], "typed by staff: 100 %, no OCR %, edited");
  const rawOnly = flattenDocument(withOthers({ healthOther: { raw: "Asthma", value: null, confidence: 0.4, source: "ocr", needsReview: true },
    referralOther: { raw: "Chat GPT", value: "Chat GPT", confidence: 0.6, source: "ocr", needsReview: true } }), "detailed");
  assert.equal(rawOnly.referral_other, "Chat GPT (?)", "a still-flagged value keeps the unverified marker");
  assert.match(String(rawOnly.review_fields), /customerInformation\.referralOther/);
  assert.deepEqual([rawOnly.health_other, rawOnly.health_other_raw, rawOnly.health_other_needs_review], ["Asthma (?)", "Asthma", true]);
  assert.match(String(rawOnly.review_fields), /customerInformation\.healthOther/);
  const old = flattenDocument(pageDocument, "detailed");
  assert.deepEqual([old.referral_other, old.health_other, old.referral_other_raw, old.health_other_source], [null, null, null, null]);
  assert.deepEqual([cells(pageDocument).referral_other, cells(pageDocument).health_other], ["", ""]);
});

// ---- the full format: every field, confidence %, original OCR % and the edited flag -----------------------------

/** The first 54 compact keys exactly as they were at c8ba60d: positions anyone reading the CSV by column relies on. */
const COMPACT_54 = ["original_file_name", "page", "page_count", "uploaded_at", "batch_label", "status", "reviewed", "reviewed_at", "reviewed_by",
  "form_number", "form_date", "form_time", "branch", "customer_name", "gender", "nationality", "hotel_name", "referral_sources", "referral_other",
  "health_conditions", "health_other", "pressure", "massage_oil_scrub", "preferred_areas", "avoid_areas", "treatments", "treatment_1_name",
  "treatment_1_duration", "treatment_1_minutes", "treatment_2_name", "treatment_2_duration", "treatment_2_minutes", "treatment_3_name",
  "treatment_3_duration", "treatment_3_minutes", "treatment_4_name", "treatment_4_duration", "treatment_4_minutes", "treatments_more", "total_minutes",
  "therapist", "room", "needs_review", "review_fields", "min_confidence", "delivery_status", "error_message", "template", "processed_at", "review_url",
  "document_id", "batch_id", "parent_document_id", "status_code"];
const SUMMARY_KEYS = ["handwriting_confidence", "handwriting_read", "checkbox_confidence"];
const SCALAR_KEYS = ["form_number", "form_date", "form_time", "branch", "customer_name", "gender", "nationality", "hotel_name", "referral_other", "health_other", "pressure", "therapist", "room"];
const LIST_KEYS = ["referral_sources", "health_conditions", "massage_oil_scrub", "preferred_areas", "avoid_areas"];
const withView = (structuredResult: unknown): ExportDocument => ({ ...pageDocument, structuredResult: normalizeStructuredResult(structuredResult) });
const human = (raw: string | null, value: string | null, confidence: number | null) => ({ raw, value, confidence, source: "human", needsReview: false });

test("T1 column counts and order: compact 57 (54 pinned + 3 summary), full 180 = 57 + 78 + 25 + 20", () => {
  const compact = EXPORT_COLUMNS.map((column) => column.key);
  assert.deepEqual(compact.slice(0, 54), COMPACT_54, "the first 54 compact positions never move");
  assert.deepEqual(compact.slice(54), SUMMARY_KEYS, "the OCR summary is appended at the very end");
  assert.deepEqual(EXPORT_COLUMNS.slice(54).map((column) => [column.th, column.kind]),
    [["% อ่านลายมือ (OCR)", "number"], ["ลายมืออ่านได้ (ช่อง)", "text"], ["% ช่องติ๊ก (OCR)", "number"]]);
  assert.equal(EXPORT_COLUMNS.find((column) => column.key === "min_confidence")!.th, "ความมั่นใจต่ำสุด (%)");
  assert.deepEqual(EXPORT_COLUMNS_DETAILED.slice(0, 57), EXPORT_COLUMNS, "keys, Thai headers and kinds of the first 57 are compact's");
  const full = EXPORT_COLUMNS_DETAILED.map((column) => column.key);
  assert.equal(new Set(full).size, 180, "every key is unique");
  assert.equal(new Set(EXPORT_COLUMNS_DETAILED.map((column) => column.th)).size, 180, "every Thai header is unique");
  assert.ok(EXPORT_COLUMNS_DETAILED.every((column) => column.th.trim().length > 0));
  const expected = [
    ...SCALAR_KEYS.flatMap((key) => ["_raw", "_confidence", "_ocr_confidence", "_needs_review", "_source", "_edited"].map((suffix) => key + suffix)),
    ...LIST_KEYS.flatMap((key) => ["_raw", "_confidence", "_ocr_confidence", "_needs_review", "_edited"].map((suffix) => key + suffix)),
    ...[1, 2, 3, 4].flatMap((n) => ["_raw", "_confidence", "_ocr_confidence", "_edited", "_guests"].map((suffix) => `treatment_${n}${suffix}`))];
  assert.deepEqual(full.slice(57), expected, "scalars in SCALARS order, then lists, then treatment slots");
  assert.deepEqual([EXPORT_SCALAR_SUFFIXES.length, EXPORT_LIST_SUFFIXES.length, EXPORT_TREATMENT_SUFFIXES.length], [6, 5, 5]);
  assert.ok(!EXPORT_LIST_SUFFIXES.some((detail) => detail.suffix === "_source"), "a list's items mix sources");
  assert.equal(EXPORT_TREATMENT_SUFFIXES.at(-1)!.suffix, "_guests");
  const th = Object.fromEntries(EXPORT_COLUMNS_DETAILED.map((column) => [column.key, column.th]));
  assert.deepEqual([th.customer_name_raw, th.customer_name_confidence, th.customer_name_ocr_confidence, th.customer_name_edited],
    ["ชื่อลูกค้า (ข้อความที่ OCR อ่าน)", "ชื่อลูกค้า (ความมั่นใจ %)", "ชื่อลูกค้า (ความมั่นใจ OCR เดิม %)", "ชื่อลูกค้า (แก้ไขโดยพนักงาน)"]);
  assert.deepEqual([th.treatment_2_guests, th.avoid_areas_needs_review], ["ทรีตเมนต์ 2 (จำนวนลูกค้า)", "จุดที่ควรหลีกเลี่ยง (ต้องตรวจ)"]);
});

test("T2 the per-field semantics matrix: OCR, edited, accepted, added, filled-where-empty, unread and the % rounding", () => {
  const values = flattenDocument(withView({ schemaVersion: 3,
    header: { formNumber: field("A-1", "A-1", 0.9) },
    customerInformation: {
      name: field("Somchai", "Somchai", 0.92),
      nationality: human("Thia", "Thai", 0.62),
      hotelName: field("Bay", "Bay", 0.62, false),
      referralOther: { raw: null, value: "Chat", confidence: 1, source: "human", needsReview: false }
    },
    staffOnly: { therapistName: human(null, "Anna", 0), branch: { raw: null, value: null, confidence: 0, source: "none", needsReview: false } } }), "detailed");
  const row = (key: string) => [values[`${key}_confidence`], values[`${key}_ocr_confidence`], values[`${key}_edited`], values[`${key}_source`], values[`${key}_needs_review`]];
  assert.deepEqual(row("customer_name"), [92, 92, false, "ocr", false], "(a) OCR-read, never touched");
  assert.deepEqual(row("nationality"), [100, 62, true, "human", false], "(b) changed by staff: 100, the OCR % kept beside it");
  assert.equal(values.nationality_raw, "Thia", "the OCR text the save kept");
  assert.deepEqual(row("hotel_name"), [62, 62, false, "ocr", false], "(c) accepted without a change is not a correction");
  assert.deepEqual(row("referral_other"), [100, null, true, "human", false], "(d) added by staff: no OCR %");
  assert.deepEqual(row("therapist"), [100, null, true, "human", false], "(e) filled where the OCR read nothing");
  assert.deepEqual(row("branch"), [null, null, false, "none", false], "(f) unread: no confidence at all");
  assert.deepEqual(row("gender"), [null, null, null, null, null], "a field that is not there: every column empty");
  for (const [stored, shown] of [[85, 85], [0.894, 89], [0.895, 90], [1, 100], [0, 0], [Number.NaN, null], ["abc", null], [null, null]] as const) {
    const one = flattenDocument(withView({ schemaVersion: 3, header: { formNumber: { raw: "1", value: "1", confidence: stored, source: "ocr", needsReview: false } } }), "detailed");
    assert.deepEqual([one.form_number_confidence, one.form_number_ocr_confidence], [shown, shown], `(g) ${String(stored)}`);
    assert.equal(displayedConfidencePercent(stored), shown, "the same rule as the list and the drawer");
  }
});

test("T3 lists: one aggregate per list over the items the value cell joins", () => {
  const values = flattenDocument(withView({ schemaVersion: 3, customerInformation: {
    referralSources: [
      { ...field("Walk-in", "Walk-in", 0.9, false, "checkbox"), checked: true },
      { ...field("Friend", "Friend", 0.7, true, "checkbox"), checked: true },
      { ...human("Hotel", "Hotel staff", 0.5), checked: true },
      { ...human(null, "Chat", 1), checked: true }],
    healthConditions: [{ ...human(null, "Asthma", 1), checked: true }] },
    recommendationCard: { avoidAreas: [] } }), "detailed");
  assert.deepEqual(["_raw", "_confidence", "_ocr_confidence", "_needs_review", "_edited"].map((suffix) => values[`referral_sources${suffix}`]),
    ["Walk-in; Friend; Hotel", 70, 50, true, true], "raw joins the OCR texts; % = min effective (edited = 100); OCR % = min kept OCR");
  assert.deepEqual(["_raw", "_confidence", "_ocr_confidence", "_needs_review", "_edited"].map((suffix) => values[`health_conditions${suffix}`]),
    [null, 100, null, false, true], "only staff-added items");
  for (const key of ["avoid_areas", "preferred_areas"]) {
    assert.deepEqual(["_raw", "_confidence", "_ocr_confidence", "_needs_review", "_edited"].map((suffix) => values[`${key}${suffix}`]), [null, null, null, null, null], key);
  }
});

test("T4 treatments: slots 1-4 with OCR text, %, original %, edited and guests; item 5 stays in treatments_more", () => {
  const items = [
    { raw: "ไทย 90", nameRaw: "ไทย", value: "นวดไทย", duration: "90 นาที", confidence: 0.9, source: "master-fuzzy", needsReview: false, guests: 2 },
    { raw: "ฟุต", nameRaw: "ฟุต", value: "นวดเท้า", duration: "60 นาที", confidence: 0.55, source: "human", needsReview: false },
    { raw: "หน้า", nameRaw: "หน้า", value: "นวดหน้า", duration: "45 นาที", confidence: 0.8, source: "human", needsReview: false },
    { raw: null, nameRaw: null, value: "สครับ", duration: "30 นาที", confidence: 1, source: "human", needsReview: false },
    { raw: "อื่น", nameRaw: "อื่น", value: "นวดน้ำมัน", duration: "60 นาที", confidence: 0.2, source: "rule", needsReview: false }];
  const values = flattenDocument(withView({ schemaVersion: 3, staffOnly: { treatments: items } }), "detailed");
  const slot = (n: number) => ["_raw", "_confidence", "_ocr_confidence", "_edited", "_guests"].map((suffix) => values[`treatment_${n}${suffix}`]);
  assert.deepEqual(slot(1), ["ไทย", 90, 90, false, 2], "nameRaw first, guests as a number");
  assert.deepEqual(slot(2), ["ฟุต", 100, 55, true, null], "edited name");
  assert.deepEqual(slot(3), ["หน้า", 100, 80, true, null], "edited duration only");
  assert.deepEqual(slot(4), [null, 100, null, true, null], "added by staff");
  assert.equal(values.treatments_more, "นวดน้ำมัน 60 นาที", "item 5 has no per-slot columns");
  assert.equal(values.min_confidence, 20, "but min_confidence still covers it");
  const two = flattenDocument(withView({ schemaVersion: 3, staffOnly: { treatments: items.slice(0, 2) } }), "detailed");
  for (const n of [3, 4]) for (const suffix of ["_raw", "_confidence", "_ocr_confidence", "_edited", "_guests"]) assert.equal(two[`treatment_${n}${suffix}`], null, `treatment_${n}${suffix}`);
});

test("T5 min_confidence is an integer percent in both sets and equals the list's displayed confidence", () => {
  const view = normalizeStructuredResult({ schemaVersion: 3, customerInformation: { name: human("x", "Y", 0.1), hotelName: field("Bay", "Bay", 0.55) } });
  for (const set of ["compact", "detailed"] as const) {
    const values = flattenDocument({ ...pageDocument, structuredResult: view }, set);
    assert.equal(values.min_confidence, 55, `${set}: the edited name counts as 100, the hotel's 55 % is the minimum`);
    assert.equal(values.min_confidence, displayedConfidencePercent(summarizeDocument(view).minConfidence));
    assert.ok(Number.isInteger(values.min_confidence));
  }
  assert.equal(flattenDocument(withView({ schemaVersion: 3 })).min_confidence, null);
});

/** The minimum over every effective confidence the full file carries (scalars, list aggregates, treatment slots 1-4). */
function exportedMinimum(document: ExportDocument): number | null {
  const values = flattenDocument(document, "detailed");
  const keys = [...SCALAR_KEYS, ...LIST_KEYS, "treatment_1", "treatment_2", "treatment_3", "treatment_4"].map((key) => `${key}_confidence`);
  const numbers = keys.map((key) => values[key]).filter((value): value is number => typeof value === "number");
  return numbers.length === 0 ? null : Math.min(...numbers);
}

test("T6 parity: the exported per-field % and min_confidence follow summarizeDocument's two rules (human = 100, unread skipped)", () => {
  const fixtures: Record<string, unknown> = {
    "v3 canonical": v31,
    "flat legacy v2.2": { treatment: { raw: "ไทย 60 นาที", durations: ["60 นาที"], needsReview: false, items: [{ raw: "ไทย", value: "นวดไทย", duration: "60 นาที", confidence: 0.95, source: "rule", needsReview: false }] },
      therapistName: field("Legacyname", "Legacyname", 1, false, "verified-memory"), roomNo: field("7", null, 0.3, true) },
    "whole v2.2 response": { documentId: "x", staffOnly: { treatment: { raw: "ฟุต", durations: [], needsReview: true, items: [] }, therapistName: field("B", "B", 0.7) }, evidence: {} },
    "human-confirmed legacy": { treatment: { raw: "ไทย", durations: ["60 นาที"], value: "นวดไทย", needsReview: false, items: [{ raw: "ไทย", value: null, confidence: 0.2, source: "ocr", needsReview: true }] },
      roomNo: field("9", "9", 0.8) },
    "all empty": { schemaVersion: 3 },
    "edited mix": { schemaVersion: 3, customerInformation: { name: human("x", "Y", 0.1), nationality: field("Thai", "Thai", 0.66), referralSources: [{ ...human(null, "A", 1), checked: true }] },
      staffOnly: { branch: { raw: null, value: null, confidence: 0, source: "none", needsReview: false }, treatments: [{ raw: "ไทย", nameRaw: "ไทย", value: "นวดไทย", duration: null, confidence: 0.4, source: "human", needsReview: false }] } }
  };
  for (const [name, fixture] of Object.entries(fixtures)) {
    const document = withView(fixture);
    const exported = exportedMinimum(document);
    assert.equal(exported, flattenDocument(document).min_confidence, `${name}: the file's own minimum is min_confidence`);
    assert.equal(exported, displayedConfidencePercent(summarizeDocument(document.structuredResult).minConfidence), name);
  }
  // The domain difference: min_confidence also covers leaves without per-field columns (treatment 5+, unknown fields).
  const beyond = withView({ schemaVersion: 3, customerInformation: { name: field("A", "A", 0.9), age: field("40", "40", 0.3) },
    staffOnly: { treatments: [1, 2, 3, 4, 5].map((n) => ({ raw: `t${n}`, nameRaw: `t${n}`, value: `T${n}`, duration: null, confidence: n === 5 ? 0.1 : 0.8, source: "ocr", needsReview: false })) } });
  assert.equal(flattenDocument(beyond).min_confidence, 10);
  assert.equal(exportedMinimum(beyond), 80, "per-field columns never go below the document minimum (80 >= 10)");
});

test("T7 every key exists for every row: missing, null sections, empty lists, no treatments, legacy and malformed results", () => {
  const shapes: Record<string, unknown> = {
    "schemaVersion only": { schemaVersion: 3 },
    "null sections": { schemaVersion: 3, header: null, customerInformation: null, recommendationCard: null, staffOnly: null },
    "empty lists": { schemaVersion: 3, customerInformation: { referralSources: [], healthConditions: [] }, recommendationCard: { massageOilScrub: [], preferredAreas: [], avoidAreas: [] } },
    "no treatments": { schemaVersion: 3, staffOnly: { treatments: [], roomNo: field("1", "1", 0.9) } },
    "legacy v2.2": { therapistName: field("A", "A", 0.9), roomNo: field("7", null, 0, true) },
    "malformed string": "not a result", "malformed number": 42, "malformed array": [1, 2]
  };
  const appended = EXPORT_COLUMNS_DETAILED.slice(57).map((column) => column.key);
  for (const [name, shape] of Object.entries(shapes)) {
    const document: ExportDocument = { ...pageDocument, structuredResult: (typeof shape === "object" && shape !== null && !Array.isArray(shape) ? normalizeStructuredResult(shape) : shape) as DocumentView };
    for (const set of ["compact", "detailed"] as const) {
      const values = flattenDocument(document, set);
      assert.deepEqual(Object.keys(values).sort(), exportColumns(set).map((column) => column.key).sort(), `${name} ${set}: exactly the set's keys`);
      assert.ok(Object.values(values).every((value) => value !== undefined), `${name} ${set}: never undefined`);
      assert.equal(exportCells(document, set).length, exportColumns(set).length);
    }
    const values = flattenDocument(document, "detailed");
    const cellsOf = cells(document, "detailed");
    const shouldBeEmpty = name === "legacy v2.2" ? appended.filter((key) => !/^(therapist|room|treatment_)/.test(key))
      : name === "no treatments" ? appended.filter((key) => !key.startsWith("room_")) : appended;
    for (const key of shouldBeEmpty) {
      assert.equal(values[key], null, `${name}: ${key} is null, not false or undefined`);
      assert.equal(cellsOf[key], "", `${name}: ${key} is an empty cell`);
    }
    if (name !== "legacy v2.2" && name !== "no treatments") for (const key of SUMMARY_KEYS) assert.equal(values[key], null, `${name}: ${key}`);
  }
});

// ---- the OCR-only reading summary (D18) -------------------------------------------------------------------------

const summaryOf = (structuredResult: unknown) => ocrReadSummary(normalizeStructuredResult(structuredResult));
const ink = (confidence = 0.95) => ({ raw: null, value: null, confidence, source: "ink-mark", needsReview: false });
const unreadInk = () => ({ raw: null, value: null, confidence: 0, source: "none", needsReview: true });
const nothing = () => ({ raw: null, value: null, confidence: 0, source: "none", needsReview: false });
const box = (label: string, confidence: number, extra: Record<string, unknown> = {}) => ({ ...field(label, label, confidence, false, "checkbox"), checked: true, ...extra });

test("T9 summary: which handwritten slots had writing, which were read, and the mean original OCR %", () => {
  const allRead = { schemaVersion: 3,
    header: { formNumber: field("0123", "0123", 0.9), date: field("1/9", "2026-09-01", 0.8), time: field("14:05", "14:05", 0.8) },
    customerInformation: { name: field("A", "A", 0.92), nationality: field("Thai", "Thai", 0.9, false, "master-fuzzy"), hotelName: field("B", "B", 0.88),
      referralOther: field("C", "C", 0.6) },
    staffOnly: { therapistName: field("D", "D", 1, false, "verified-memory"), roomNo: field("7", "7", 0.95), branch: field("Rawai", "Rawai", 0.1) } };
  assert.deepEqual(summaryOf(allRead), { handwritingConfidence: 86, handwritingRead: { read: 9, withWriting: 9 }, checkboxConfidence: null },
    "(a)+(h) nine read slots, AI-filled referral_other included, branch in neither group: (90+80+80+92+90+88+60+100+95)/9 = 86.1");
  const values = flattenDocument(withView(allRead));
  assert.deepEqual([values.handwriting_read, values.handwriting_confidence, values.checkbox_confidence], ["9 จาก 9", 86, null]);
  const mixed = { schemaVersion: 3, header: { formNumber: field("12", "12", 0.9), date: ink(), time: ink(0.97) },
    customerInformation: { name: unreadInk(), nationality: nothing(), hotelName: human("Bay", "Blue Bay", 0.5), referralOther: human(null, "Chat", 1), healthOther: { raw: null, value: null, needsReview: false } },
    staffOnly: { therapistName: field("Anna", null, 0.3, true, "master-fuzzy") } };
  // formNumber read 90; date/time ink-empty (b) out; name unread ink (c) 0; nationality nothing (d) out; hotel edited with
  // OCR text (e) 50 (never 100); referralOther typed by staff (f) out; healthOther empty (h) out; therapist written, not read: 0.
  assert.deepEqual(summaryOf(mixed), { handwritingConfidence: 35, handwritingRead: { read: 2, withWriting: 4 }, checkboxConfidence: null }, "(140)/4 = 35");
});

test("T9 summary: treatment items (all of them, beyond slot 4) and the checkbox marks", () => {
  const read = (n: number, confidence: number) => ({ raw: `t${n}`, nameRaw: `t${n}`, value: `T${n}`, duration: "60 นาที", confidence, source: "master-fuzzy", needsReview: false });
  const treatments = [read(1, 0.9), read(2, 0.8), read(3, 0.7), read(4, 0.6),
    { raw: "xx", nameRaw: "xx", value: null, duration: null, confidence: 0, source: "none", needsReview: true },
    { raw: null, nameRaw: null, value: "added", duration: "30 นาที", confidence: 1, source: "human", needsReview: false }];
  assert.deepEqual(summaryOf({ schemaVersion: 3, staffOnly: { treatments } }).handwritingRead, { read: 4, withWriting: 5 }, "(g) item 5 written-unread, item 6 added");
  assert.equal(summaryOf({ schemaVersion: 3, staffOnly: { treatments } }).handwritingConfidence, 60, "(90+80+70+60+0)/5");
  const checks = { schemaVersion: 3,
    customerInformation: { gender: field("Male", "Male", 0.95, false, "checkbox"),
      referralSources: [box("Walk-in", 0.9), box("Friend", 0.99, { checked: false }), { ...unreadInk(), checked: true }, { ...human(null, "Chat", 1), checked: true }] },
    recommendationCard: { pressure: field("Strong", "Strong", 0.6, true, "ink-mark") } };
  assert.equal(summaryOf(checks).checkboxConfidence, 82, "(i) (95+60+90)/3 = 81.7: unticked, none and staff-added items are skipped");
  assert.equal(summaryOf(checks).handwritingRead.withWriting, 0);
  // Edited checkbox leaves keep the reading they had: OCR text, or a stored confidence between 0 and 100 %.
  const editedChecks = { schemaVersion: 3, customerInformation: { gender: human(null, "Female", 0.88), referralSources: [{ ...human("Walk-in", "Friend", 0.7), checked: true }] },
    recommendationCard: { pressure: human(null, "Soft", 1) } };
  assert.equal(summaryOf(editedChecks).checkboxConfidence, 79, "(88+70)/2: the staff-set pressure (100 %) is not a reading");
});

test("T9 summary: nothing to summarise, legacy shapes, rounding once on the mean", () => {
  const empty = { handwritingConfidence: null, handwritingRead: { read: 0, withWriting: 0 }, checkboxConfidence: null };
  assert.deepEqual(summaryOf({ schemaVersion: 3 }), empty, "(k)");
  assert.deepEqual(summaryOf({ treatment: { raw: null, durations: [], needsReview: false, items: [] } }), empty, "(k) a legacy row with nothing read");
  assert.deepEqual(summaryOf({ schemaVersion: 3, header: { date: ink() }, customerInformation: { name: nothing() } }), empty, "(j) no writing, no mark");
  const values = flattenDocument(withView({ schemaVersion: 3 }));
  assert.deepEqual(SUMMARY_KEYS.map((key) => values[key]), [null, null, null]);
  assert.deepEqual(summaryOf({ therapistName: field("Legacyname", "Legacyname", 1, false, "verified-memory"), roomNo: field("7", null, 0, true) }),
    { handwritingConfidence: 50, handwritingRead: { read: 1, withWriting: 2 }, checkboxConfidence: null }, "a legacy row with readings is counted like any other");
  for (const [stored, shown] of [[0.894, 89], [0.895, 90]] as const) {
    assert.equal(summaryOf({ schemaVersion: 3, customerInformation: { name: field("A", "A", stored), gender: field("M", "M", stored, false, "checkbox") } }).handwritingConfidence, shown, `(m) ${stored}`);
    assert.equal(summaryOf({ schemaVersion: 3, customerInformation: { gender: field("M", "M", stored, false, "checkbox") } }).checkboxConfidence, shown);
  }
  assert.equal(summaryOf({ schemaVersion: 3, customerInformation: { name: field("A", "A", 0.89), hotelName: field("B", "B", 0.9) } }).handwritingConfidence, 90, "(m) 89.5 rounds once, up");
});

test("T9 summary: a review never moves the numbers (the edited twin equals the saved, unedited one)", () => {
  const stored = normalizeStructuredResult({ schemaVersion: 3,
    header: { formNumber: field("0123", "0123", 0.9), date: ink() },
    customerInformation: { name: field("Somchai", "Somchai", 0.7, true), hotelName: field("Bay", "Bay", 0.8), gender: field("Male", "Male", 0.9, false, "checkbox"),
      referralSources: [box("Walk-in", 0.85)] },
    staffOnly: { therapistName: field("Anna", "Anna", 0.6, true, "master-fuzzy"), roomNo: field("7", "7", 0.95),
      treatments: [{ raw: "ไทย", nameRaw: "ไทย", value: "นวดไทย", duration: "60 นาที", confidence: 0.9, source: "master-fuzzy", needsReview: false }] } });
  const draft = JSON.parse(JSON.stringify(stored)) as Record<string, Record<string, unknown>>;
  const unedited = applyReviewEdits(stored, JSON.parse(JSON.stringify(stored))).merged;
  (draft.customerInformation!.name as Record<string, unknown>).value = "Somchai J.";
  (draft.staffOnly!.therapistName as Record<string, unknown>).value = "Ann";
  (draft.customerInformation!.gender as Record<string, unknown>).value = "Female";
  ((draft.customerInformation!.referralSources as unknown[])[0] as Record<string, unknown>).value = "Friend";
  (draft.customerInformation!.referralSources as unknown[]).push({ value: "Chat" });
  ((draft.staffOnly!.treatments as unknown[])[0] as Record<string, unknown>).duration = "90 นาที";
  (draft.staffOnly!.treatments as unknown[]).push({ value: "สครับ", duration: "30 นาที" });
  draft.header!.date = { value: "2026-09-01" };
  const edited = applyReviewEdits(stored, draft);
  assert.ok(edited.changes.length >= 7, "the edits really happened");
  assert.deepEqual(ocrReadSummary(edited.merged), ocrReadSummary(unedited), "(l) edited twin = saved unedited twin");
  assert.deepEqual(ocrReadSummary(edited.merged), ocrReadSummary(stored), "and, with no unread ink on the page, = the stored OCR result");
  const values = flattenDocument({ ...pageDocument, structuredResult: edited.merged }, "detailed");
  assert.deepEqual([values.customer_name_confidence, values.customer_name_ocr_confidence, values.customer_name_edited], [100, 70, true]);
  // Known limit (documented in the guide): a save clears every review flag, so a slot whose ink the OCR could not read
  // (source none, flagged) stops counting as writing once the document is saved, edited or not.
  const unreadOnPage = normalizeStructuredResult({ schemaVersion: 3, customerInformation: { name: field("A", "A", 0.8), hotelName: unreadInk() } });
  assert.deepEqual(ocrReadSummary(unreadOnPage).handwritingRead, { read: 1, withWriting: 2 });
  assert.deepEqual(ocrReadSummary(applyReviewEdits(unreadOnPage, JSON.parse(JSON.stringify(unreadOnPage))).merged).handwritingRead, { read: 1, withWriting: 1 });
});

test("T10 Excel: text columns keep their leading zeros, and the read count is words, never a date-like 7/9", () => {
  const document = withView({ schemaVersion: 3, header: { formNumber: field("0123", "0123", 0.9) }, staffOnly: { roomNo: field("007", "007", 0.95) },
    customerInformation: Object.fromEntries(["name", "nationality", "hotelName", "referralOther", "healthOther"].map((key, index) => [key, index < 3 ? field("x", "x", 0.8) : unreadInk()])) });
  const row = cells(document, "detailed");
  const values = flattenDocument(document, "detailed");
  assert.deepEqual([row.form_number, row.room, row.form_number_raw, row.room_raw], ["0123", "007", "0123", "007"]);
  assert.deepEqual([values.form_number, values.room], ["0123", "007"], "JSONL carries the same strings");
  assert.equal(row.handwriting_read, "5 จาก 7");
  assert.ok(!row.handwriting_read!.includes("/"));
  const seven = withView({ schemaVersion: 3, header: { formNumber: field("1", "1", 0.9), time: field("1", "1", 0.9), date: unreadInk() },
    customerInformation: { name: field("a", "a", 0.9), nationality: field("a", "a", 0.9), hotelName: field("a", "a", 0.9), healthOther: unreadInk() },
    staffOnly: { therapistName: field("a", "a", 0.9), roomNo: field("1", "1", 0.9) } });
  assert.equal(cells(seven).handwriting_read, "7 จาก 9");
});
