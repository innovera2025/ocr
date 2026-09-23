/**
 * Labels shared by the workbench and the export, so the two never drift apart.
 *
 * §6 D9: documents confirmed before login existed carry an actor that matches no user — the shared account everyone
 * used. Nothing is backfilled and no fake user row is created, so the name simply comes back null and the reader is
 * told what it means instead of seeing a blank or a raw id.
 */
export const LEGACY_REVIEWER_LABEL = "บัญชีรวม (ก่อนมีระบบล็อกอิน)";

/** null when the document was never confirmed; the reviewer's display name, or the legacy label when it joins to none. */
export function reviewerLabel(reviewedBy: string | null | undefined, reviewedByName: string | null | undefined): string | null {
  if (!reviewedBy) return null;
  return reviewedByName || LEGACY_REVIEWER_LABEL;
}

/** Derived from the document's `ocr_confirm_outbox` rows (latest correction per field). */
export type DeliveryStatus = "NONE" | "PENDING" | "DELIVERED" | "RETRYING" | "FAILED";
/** Categories of visible rows (the list filter). A `SPLIT` PDF parent is never a row: its category is "split". */
export type DocumentStatusCategory = "queued" | "processing" | "review" | "succeeded" | "confirmed" | "failed";
export const DOCUMENT_STATUS_CATEGORIES: readonly DocumentStatusCategory[] = ["queued", "processing", "review", "succeeded", "confirmed", "failed"];

/**
 * The Thai vocabulary the workbench and the export share (§10 H3). The workbench's inline script cannot import a
 * module, so it carries its own copies and `workbench.test.ts` pins them to these — an export column headed
 * "รอตรวจสอบ" must mean exactly what the table's badge means.
 */
export const CATEGORY_LABELS_TH: Readonly<Record<DocumentStatusCategory | "split", string>> = {
  queued: "รอคิว", processing: "กำลังอ่าน", review: "รอตรวจสอบ", succeeded: "อ่านสำเร็จ", confirmed: "ยืนยันแล้ว",
  failed: "ไม่สำเร็จ", split: "แยกเป็นรายหน้าแล้ว"
};
/** `NONE` (no correction was ever sent) has no label: the cell stays empty, as the workbench shows no chip for it. */
export const DELIVERY_LABELS_TH: Readonly<Record<Exclude<DeliveryStatus, "NONE">, string>> = {
  PENDING: "รอส่งการแก้ไขให้ AI", DELIVERED: "AI รับการแก้ไขแล้ว", RETRYING: "กำลังลองส่งการแก้ไขให้ AI อีกครั้ง", FAILED: "ส่งการแก้ไขให้ AI ไม่สำเร็จ"
};
/** One label per canonical field (`document-view.ts` keys), used for the drawer and for the export's column headers. */
export const FIELD_LABELS_TH: Readonly<Record<string, string>> = {
  formNumber: "เลขที่ฟอร์ม", date: "วันที่", time: "เวลา", branch: "สาขา", name: "ชื่อลูกค้า", gender: "เพศ", nationality: "สัญชาติ",
  hotelName: "โรงแรมที่พัก", referralSources: "รู้จักร้านจาก", healthConditions: "ภาวะสุขภาพ", pressure: "แรงกด",
  massageOilScrub: "น้ำมัน / สครับ", preferredAreas: "จุดที่ต้องการเน้น", avoidAreas: "จุดที่ควรหลีกเลี่ยง", treatments: "ทรีตเมนต์",
  therapistName: "พนักงานนวด", roomNo: "ห้อง", duration: "ระยะเวลา"
};
