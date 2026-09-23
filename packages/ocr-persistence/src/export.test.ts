import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeStructuredResult } from "./document-view.js";
import { bangkokTimestamp, EXPORT_COLUMNS, EXPORT_COLUMNS_DETAILED, exportCells, exportColumns, flattenDocument, flaggedPaths, formatCell,
  MAX_CELL_LENGTH, TRUNCATION_SUFFIX, type ExportDocument } from "./export.js";
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
  deliveryStatus: "DELIVERED", template: "makkha-v3", structuredResult: normalizeStructuredResult(v31)
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
  assert.deepEqual(EXPORT_COLUMNS_DETAILED.slice(EXPORT_COLUMNS.length, EXPORT_COLUMNS.length + 4).map((column) => [column.key, column.kind]),
    [["form_number_raw", "text"], ["form_number_confidence", "number"], ["form_number_needs_review", "bool"], ["form_number_source", "text"]]);
  assert.equal(EXPORT_COLUMNS_DETAILED.length, EXPORT_COLUMNS.length + 11 * 4, "four provenance columns per scalar field");
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
  assert.deepEqual([row.needs_review, row.review_fields, row.min_confidence], ["FALSE", "", "0.8"]);
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
  assert.deepEqual([row.customer_name_raw, row.customer_name_confidence, row.customer_name_needs_review, row.customer_name_source],
    ["Somchai", "0.92", "FALSE", "ocr"]);
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

test("flattenDocument keeps typed values for JSONL: numbers, booleans and the ISO instant", () => {
  const values = flattenDocument(pageDocument, "compact", { publicBaseUrl: "https://ocr.example.test" });
  assert.deepEqual([values.page, values.page_count, values.total_minutes, values.treatment_1_minutes], [2, 5, 150, 90]);
  assert.deepEqual([values.reviewed, values.needs_review], [true, false]);
  assert.equal(values.uploaded_at, "2026-09-22T07:05:00.000Z", "the writers render Bangkok time; the value stays the UTC instant");
  assert.equal(values.min_confidence, 0.8);
  assert.equal(flattenDocument(pageDocument).review_url, null, "no configured base URL: no link, never one built from Host");
});
