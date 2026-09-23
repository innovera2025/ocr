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
