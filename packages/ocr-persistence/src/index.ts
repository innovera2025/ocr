import { Pool, type PoolClient, type PoolConfig } from "pg";
import type { OcrResponse } from "@innovera/ocr-client";
import { applyReviewEdits, legacyTreatmentIndex, markReviewed, normalizeStructuredResult, summarizeDocument, type DocumentSummary, type DocumentView } from "./document-view.js";

export * from "./document-view.js";

export type OcrDocumentStatus = "PROCESSING" | "SUCCEEDED" | "NEEDS_REVIEW" | "FAILED";
export type ConfirmStatus = "PENDING" | "SUCCEEDED" | "RETRY";
export type CorrectionAudit = Readonly<{ raw: string; verifiedBy: string }>;

export type UploadedDocument = Readonly<{ documentId: string; runId: string; tenantId: string; reused?: boolean; batchId?: string }>;
export type WorkerDocument = Readonly<{ documentId: string; organizationId: string; sourceKey: string; filename: string; mimeType: string }>;

export type OcrResultPatch = Readonly<{
  ocrDocumentId: string;
  engine?: string;
  version?: string;
  rawResponse: OcrResponse;
  structuredResult: Readonly<Record<string, unknown>>;
  needsReview: boolean;
}>;

export type DocumentStore = Readonly<{
  saveOcrResult(tenantId: string, documentId: string, result: OcrResultPatch): Promise<void>;
  saveCorrection(tenantId: string, documentId: string, field: string, value: string, confirmStatus: ConfirmStatus, confirmError?: string, remainingNeedsReview?: boolean, audit?: CorrectionAudit): Promise<void>;
}>;

/** Derived from the document's `ocr_confirm_outbox` rows (latest correction per field). */
export type DeliveryStatus = "NONE" | "PENDING" | "DELIVERED" | "RETRYING" | "FAILED";
export type DocumentStatusCategory = "queued" | "processing" | "review" | "succeeded" | "confirmed" | "failed";
export const DOCUMENT_STATUS_CATEGORIES: readonly DocumentStatusCategory[] = ["queued", "processing", "review", "succeeded", "confirmed", "failed"];

export type ReviewDocument = Readonly<{
  documentId: string;
  tenantId: string;
  batchId: string | null;
  filename: string;
  mimeType: string;
  status: string;
  ocrDocumentId: string | null;
  ocrEngine: string | null;
  ocrVersion: string | null;
  rawResponse: unknown;
  /** Canonical view (`normalizeStructuredResult`), also for legacy rows and not-yet-processed documents. */
  structuredResult: DocumentView;
  needsReview: boolean;
  confirmStatus: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  updatedAt: string;
  errorMessage: string | null;
  createdAt: string;
  processedAt: string | null;
  deliveryStatus: DeliveryStatus;
}>;

export type ReviewStore = DocumentStore & Readonly<{
  getReviewDocument(tenantId: string, documentId: string): Promise<ReviewDocument | null>;
  /** `status` lets the content route refuse quarantined / not yet scanned originals. */
  getOriginal?: (tenantId: string, documentId: string) => Promise<{ storageKey: string; mimeType: string; status: string } | null>;
}>;

export type BatchSummary = { batchId: string; label: string | null; createdAt: string; expectedTotal: number;
  uploaded: number; queued: number; processing: number; succeeded: number; needsReview: number;
  failed: number; confirmed: number; completed: number /* succeeded+needsReview+failed */;
  finishedAt: string | null /* last completion, once completed === expectedTotal */;
  durationMs: number | null /* createdAt → last completion once finished, or once nothing is queued or processing and
    nothing arrived or completed for 5 minutes (fewer files than expected arrived), else → now; null before the first upload */;
  throughputPerMinute: number | null /* completed per minute of durationMs */ };
export type CreateBatchInput = { createdBy: string; expectedTotal: number; label?: string | null | undefined };
export type DocumentListItem = { documentId: string; batchId: string | null; filename: string; mimeType: string;
  status: string; statusCategory: DocumentStatusCategory; needsReview: boolean; errorMessage: string | null; createdAt: string;
  processedAt: string | null; reviewedAt: string | null; deliveryStatus: DeliveryStatus; summary: DocumentSummary };
export type ListDocumentsQuery = { limit?: number | undefined; offset?: number | undefined; status?: DocumentStatusCategory | undefined; q?: string | undefined; batchId?: string | undefined };
export type SaveReviewInput = { structuredResult: unknown; reviewedBy: string; expectedUpdatedAt?: string | undefined };
export type SaveReviewResult = { corrections: number; delivery: "PENDING" | "NOT_REQUIRED"; document: ReviewDocument };

/** Everything the web workbench needs from the store (fakes in tests can implement this shape). */
export type WorkbenchStore = ReviewStore & Pick<PostgresOcrDocumentStore, "createBatch" | "getBatch" | "listBatches" | "listDocuments" | "retryDocument" | "saveReview">;

/** True when any object inside `value` has `needsReview: true` (apply to the canonical view). */
export function hasReviewFields(response: unknown): boolean {
  const visit = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(visit);
    if (!value || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    if (record.needsReview === true) return true;
    return Object.values(record).some(visit);
  };
  return visit(response);
}

export function structuredStaffResult(response: OcrResponse): Readonly<Record<string, unknown>> {
  return response.staffOnly ?? {};
}

export function structuredDocumentResult(response: OcrResponse): Readonly<Record<string, unknown>> {
  return response as Readonly<Record<string, unknown>>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }

/** Document row → UI category; `null` for rows the list never shows (DELETED). */
export function statusCategoryOf(status: string, reviewedAt: unknown): DocumentStatusCategory | null {
  switch (status) {
    case "VALIDATING": case "SCANNING": case "CLEAN": return "queued";
    case "PROCESSING": return "processing";
    case "NEEDS_REVIEW": return "review";
    case "SUCCEEDED": return reviewedAt ? "confirmed" : "succeeded";
    case "FAILED": case "QUARANTINED": return "failed";
    default: return null;
  }
}

/**
 * When document `d` was confirmed: reviewed in the workbench (`reviewed_at`), or — rows confirmed field by field through
 * the legacy confirm endpoint, incl. every v2.2 confirmation, which never set `reviewed_at` — `confirmed_at` of a
 * SUCCEEDED document with nothing left to review (`needs_review` false). `confirmed_at` is only set by a successful
 * provider confirmation and never cleared, so a later confirmation that is PENDING or ends in RETRY does not un-confirm
 * the row. A stored whole v2.2 response (`{documentId, staffOnly:{treatment,…}}`, not schema 3) only counts once no
 * field flag is left in `staffOnly`: v2.2 confirmed such rows from one field and wrote the value to a top-level key, so
 * their flags still mark unresolved fields (the aggregate `treatment.needsReview` counts only without items, as in the
 * view). NULL = not confirmed. Read-side on purpose: the migrator cannot backfill rows through FORCE RLS.
 */
const REVIEWED_AT_SQL = `(CASE WHEN d.reviewed_at IS NOT NULL THEN d.reviewed_at
  WHEN d.status = 'SUCCEEDED' AND d.needs_review = false AND d.confirmed_at IS NOT NULL
    AND NOT (COALESCE(jsonb_typeof(d.structured_result -> 'staffOnly') = 'object', false)
      AND (d.structured_result ->> 'schemaVersion') IS DISTINCT FROM '3'
      AND jsonb_path_exists(d.structured_result -> 'staffOnly', 'lax $.** ? (@.needsReview == true && !(exists(@.items[0])))'))
  THEN d.confirmed_at END)`;

const CATEGORY_SQL: Readonly<Record<DocumentStatusCategory, string>> = {
  queued: "d.status IN ('VALIDATING','SCANNING','CLEAN')", processing: "d.status = 'PROCESSING'", review: "d.status = 'NEEDS_REVIEW'",
  succeeded: `d.status = 'SUCCEEDED' AND ${REVIEWED_AT_SQL} IS NULL`, confirmed: `d.status = 'SUCCEEDED' AND ${REVIEWED_AT_SQL} IS NOT NULL`,
  failed: "d.status IN ('FAILED','QUARANTINED')"
};

/**
 * Outbox state of the latest correction per field of document `d`. Corrections of one review share `verified_at`; the
 * tie-break prefers the one with an outbox row, so a PENDING or dead delivery is never hidden behind a sibling change.
 */
const DELIVERY_SQL = `(SELECT CASE WHEN count(x.status) = 0 THEN 'NONE'
    WHEN bool_or(x.status IN ('DEAD','FAILED')) THEN 'FAILED' WHEN bool_or(x.status = 'RETRY') THEN 'RETRYING'
    WHEN bool_or(x.status IN ('PENDING','PROCESSING')) THEN 'PENDING' ELSE 'DELIVERED' END
  FROM (SELECT DISTINCT ON (c.field) o.status FROM ocr_corrections c
        LEFT JOIN ocr_confirm_outbox o ON o.correction_id = c.id AND o.organization_id = c.organization_id
        WHERE c.organization_id = d.organization_id AND c.document_id = d.id ORDER BY c.field, c.verified_at DESC, (o.id IS NOT NULL) DESC, c.id) x)`;

const REVIEW_SELECT = `SELECT d.id, d.organization_id, d.batch_id, d.filename, d.mime_type, d.status::text AS status, d.ocr_document_id, d.ocr_engine, d.ocr_version,
  d.raw_response, d.structured_result, d.needs_review, d.confirm_status, ${REVIEWED_AT_SQL} AS reviewed_at, d.reviewed_by, d.updated_at, d.error_message,
  d.created_at, d.processed_at, ${DELIVERY_SQL} AS delivery_status
FROM documents d WHERE d.id = $1::uuid AND d.organization_id = $2::uuid AND d.deleted_at IS NULL`;

/** Counters are derived from document rows on every read (nothing stored, nothing to drift). */
const BATCH_SELECT = `SELECT b.id, b.label, b.created_at, b.expected_total, now() AS db_now,
  count(d.id)::int AS uploaded,
  count(d.id) FILTER (WHERE d.status IN ('VALIDATING','SCANNING','CLEAN'))::int AS queued,
  count(d.id) FILTER (WHERE d.status = 'PROCESSING')::int AS processing,
  count(d.id) FILTER (WHERE d.status = 'SUCCEEDED')::int AS succeeded,
  count(d.id) FILTER (WHERE d.status = 'NEEDS_REVIEW')::int AS needs_review,
  count(d.id) FILTER (WHERE d.status IN ('FAILED','QUARANTINED'))::int AS failed,
  count(d.id) FILTER (WHERE d.status = 'SUCCEEDED' AND ${REVIEWED_AT_SQL} IS NOT NULL)::int AS confirmed,
  max(COALESCE(d.processed_at, d.updated_at)) FILTER (WHERE d.status IN ('SUCCEEDED','NEEDS_REVIEW','FAILED','QUARANTINED')) AS last_completed_at,
  max(d.created_at) AS last_created_at
FROM ocr_batches b
LEFT JOIN documents d ON d.batch_id = b.id AND d.organization_id = b.organization_id AND d.deleted_at IS NULL AND d.status <> 'DELETED'
WHERE b.organization_id = $1::uuid AND ($2::uuid IS NULL OR b.id = $2::uuid)
GROUP BY b.id ORDER BY b.created_at DESC, b.id DESC LIMIT $3`;

type Row = Record<string, unknown>;
/** A replayed upload that is still SCANNING/CLEAN without a job after this long belongs to a request that died. */
const RESUME_AFTER = "2 minutes";
/** A short batch with nothing queued/processing stops its clock only after this long without a new document or completion
 * (a file may still be uploading: its row exists only once the whole body arrived). */
const BATCH_IDLE_AFTER_MS = 5 * 60_000;
function iso(value: unknown): string | null { return value instanceof Date ? value.toISOString() : typeof value === "string" ? new Date(value).toISOString() : null; }
function ms(value: unknown): number | null { return value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : null; }
function str(value: unknown): string | null { return typeof value === "string" ? value : null; }
function num(value: unknown): number { return typeof value === "number" ? value : Number(value ?? 0); }
function delivery(value: unknown): DeliveryStatus { return value === "PENDING" || value === "DELIVERED" || value === "RETRYING" || value === "FAILED" ? value : "NONE"; }
function escapeLike(value: string): string { return value.replace(/[\\%_]/g, (match) => `\\${match}`); }
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.trunc(parsed))) : fallback;
}

function toBatchSummary(row: Row): BatchSummary {
  const createdAt = ms(row.created_at) ?? 0;
  const expectedTotal = num(row.expected_total);
  const uploaded = num(row.uploaded), succeeded = num(row.succeeded), needsReview = num(row.needs_review), failed = num(row.failed);
  const completed = succeeded + needsReview + failed;
  const lastCompleted = ms(row.last_completed_at);
  const now = ms(row.db_now) ?? Date.now();
  const finished = completed >= expectedTotal && lastCompleted !== null;
  // Uploads rejected before persistence (or abandoned) never become documents, so a batch can stay below expectedTotal
  // for good: the clock also stops at the last completion once nothing is queued or processing and nothing new has
  // arrived or completed for BATCH_IDLE_AFTER_MS (before that, OCR may just be ahead of a file still uploading).
  const lastActivity = Math.max(lastCompleted ?? 0, ms(row.last_created_at) ?? 0);
  const idle = uploaded > 0 && num(row.queued) + num(row.processing) === 0 && lastCompleted !== null && now - lastActivity >= BATCH_IDLE_AFTER_MS;
  const end = finished || idle ? lastCompleted! : now;
  const durationMs = uploaded > 0 ? Math.max(0, end - createdAt) : null;
  const throughputPerMinute = completed > 0 && durationMs !== null && durationMs > 0 ? Math.round((completed / (durationMs / 60_000)) * 100) / 100 : null;
  return { batchId: String(row.id), label: str(row.label), createdAt: iso(row.created_at) ?? "", expectedTotal, uploaded,
    queued: num(row.queued), processing: num(row.processing), succeeded, needsReview, failed, confirmed: num(row.confirmed), completed,
    finishedAt: finished ? iso(row.last_completed_at) : null, durationMs, throughputPerMinute };
}

/** Canonical view of a row; a confirmed row (see REVIEWED_AT_SQL) has nothing left to review. */
function viewOf(row: Row): DocumentView {
  const view = normalizeStructuredResult(row.structured_result);
  return String(row.status) === "SUCCEEDED" && row.reviewed_at ? markReviewed(view) : view;
}

function toReviewDocument(row: Row): ReviewDocument {
  return {
    documentId: String(row.id), tenantId: String(row.organization_id), batchId: str(row.batch_id), filename: String(row.filename), mimeType: String(row.mime_type),
    status: String(row.status), ocrDocumentId: str(row.ocr_document_id), ocrEngine: str(row.ocr_engine), ocrVersion: str(row.ocr_version),
    rawResponse: row.raw_response ?? null, structuredResult: viewOf(row),
    needsReview: row.needs_review === true, confirmStatus: str(row.confirm_status), reviewedAt: iso(row.reviewed_at), reviewedBy: str(row.reviewed_by),
    updatedAt: iso(row.updated_at) ?? "", errorMessage: str(row.error_message), createdAt: iso(row.created_at) ?? "", processedAt: iso(row.processed_at),
    deliveryStatus: delivery(row.delivery_status)
  };
}

function toListItem(row: Row): DocumentListItem {
  const status = String(row.status);
  return { documentId: String(row.id), batchId: str(row.batch_id), filename: String(row.filename), mimeType: String(row.mime_type), status,
    statusCategory: statusCategoryOf(status, row.reviewed_at) ?? "failed", needsReview: row.needs_review === true, errorMessage: str(row.error_message),
    createdAt: iso(row.created_at) ?? "", processedAt: iso(row.processed_at), reviewedAt: iso(row.reviewed_at), deliveryStatus: delivery(row.delivery_status),
    summary: summarizeDocument(viewOf(row)) };
}

function isRow(value: unknown): value is Row { return typeof value === "object" && value !== null && !Array.isArray(value); }

/**
 * Target inside a v2.2 `treatment` object ({raw, durations, items, needsReview}) at `prefix`: the one item
 * `legacyTreatmentIndex(items, raw)` picks (the same rule the server uses to exclude that item from "anything else
 * flagged?"), or `treatment` itself — a whole-field answer that replaces every item — when `raw` is the whole field's raw
 * or no single item qualifies.
 */
function v22TreatmentPath(prefix: string[], treatment: Row, raw: string): string[] {
  const index = legacyTreatmentIndex(treatment.items, raw);
  const wholeField = typeof treatment.raw === "string" && raw.trim() === treatment.raw.trim();
  return index !== null && !wholeField ? [...prefix, "treatment", "items", String(index)] : [...prefix, "treatment"];
}

/**
 * Legacy single-field confirm: sectioned rows keep therapistName/roomNo under `staffOnly`; old flat rows at the top level.
 * "treatment" on a sectioned row targets one canonical `staffOnly.treatments[i]` (`legacyTreatmentIndex` with the request's
 * `raw`), or the v2.2 `staffOnly.treatment` object of a stored whole v2.2 response; CONFIRMATION_TARGET_AMBIGUOUS when no
 * single item qualifies (instead of writing a top-level key the canonical view never reads). On v2.2 treatment objects
 * (flat or whole) an item-level confirmation writes that item only (`v22TreatmentPath`), so its siblings are kept.
 */
export function legacyFieldPath(structuredResult: unknown, field: string, raw = ""): string[] {
  const staffOnly = isRow(structuredResult) ? structuredResult.staffOnly : undefined;
  if (!isRow(staffOnly)) {
    return field === "treatment" && isRow(structuredResult) && isRow(structuredResult.treatment) ? v22TreatmentPath([], structuredResult.treatment, raw) : [field];
  }
  const staff = staffOnly;
  if (field === "therapistName" || field === "roomNo") return ["staffOnly", field];
  if (field !== "treatment") return [field];
  if (Array.isArray(staff.treatments) && staff.treatments.length > 0) {
    const index = legacyTreatmentIndex(staff.treatments, raw);
    if (index === null) throw new Error("CONFIRMATION_TARGET_AMBIGUOUS");
    return ["staffOnly", "treatments", String(index)];
  }
  if (isRow(staff.treatment)) return v22TreatmentPath(["staffOnly"], staff.treatment, raw);
  throw new Error("CONFIRMATION_TARGET_AMBIGUOUS");
}

export class PostgresOcrDocumentStore implements ReviewStore {
  readonly pool: Pool;

  constructor(config: Pool | PoolConfig | string) {
    this.pool = config instanceof Pool ? config : new Pool(typeof config === "string" ? { connectionString: config } : config);
  }

  /** Runs `work` in one transaction scoped to `tenantId` through `app.current_org` (RLS). */
  private async tenantTransaction<T>(tenantId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_org', $1, true)", [tenantId]);
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  /** Unexpired upload with the same idempotency key → reused; other fingerprint → IDEMPOTENCY_CONFLICT; none → null. */
  private async reuseIdempotentUpload(client: PoolClient, tenantId: string, idempotencyKey: string, requestFingerprint: string): Promise<UploadedDocument | null> {
    const existing = await client.query<{ document_id: string; request_fingerprint: string; batch_id: string | null }>(
      `SELECT i.document_id, i.request_fingerprint, d.batch_id FROM upload_idempotency_keys i
       LEFT JOIN documents d ON d.id=i.document_id AND d.organization_id=i.organization_id
       WHERE i.organization_id=$1::uuid AND i.idempotency_key=$2 AND i.expires_at > now()`, [tenantId, idempotencyKey]);
    const row = existing.rows[0];
    if (!row) return null;
    if (row.request_fingerprint !== requestFingerprint) throw new Error("IDEMPOTENCY_CONFLICT");
    const existingRun = await client.query<{ id: string }>("SELECT id FROM document_runs WHERE organization_id=$1::uuid AND document_id=$2::uuid ORDER BY created_at DESC LIMIT 1", [tenantId, row.document_id]);
    return { documentId: row.document_id, runId: existingRun.rows[0]!.id, tenantId, reused: true, ...(row.batch_id ? { batchId: row.batch_id } : {}) };
  }

  /**
   * `batchId` attaches the upload to a batch of the same tenant: BATCH_NOT_FOUND when it is not the tenant's (or not a
   * UUID), BATCH_FULL once uploaded >= expected_total. Uploads into one batch are serialised with a transaction-scoped
   * advisory lock (ocr_app has no UPDATE on ocr_batches, so the batch row cannot be locked FOR UPDATE), so there is no overshoot.
   */
  async createUploadedDocument(input: { tenantId: string; filename: string; mimeType: string; sizeBytes: number; contentHash: string; storageKey: string; idempotencyKey?: string; requestFingerprint?: string; batchId?: string | undefined }): Promise<UploadedDocument> {
    if (input.batchId !== undefined && !isUuid(input.batchId)) throw new Error("BATCH_NOT_FOUND");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_org', $1, true)", [input.tenantId]);
      if (input.idempotencyKey) {
        await client.query("DELETE FROM upload_idempotency_keys WHERE organization_id=$1::uuid AND idempotency_key=$2 AND expires_at <= now()", [input.tenantId, input.idempotencyKey]);
      }
      if (input.batchId) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('innovera_ocr:batch'), hashtext($1))", [input.batchId]);
        const batch = await client.query<{ expected_total: number; uploaded: number }>(
          `SELECT b.expected_total, (SELECT count(*)::int FROM documents d WHERE d.organization_id=b.organization_id AND d.batch_id=b.id AND d.deleted_at IS NULL AND d.status <> 'DELETED') AS uploaded
           FROM ocr_batches b WHERE b.id=$1::uuid AND b.organization_id=$2::uuid`, [input.batchId, input.tenantId]);
        const capacity = batch.rows[0];
        if (!capacity) throw new Error("BATCH_NOT_FOUND");
        if (capacity.uploaded >= capacity.expected_total) {
          const reused = input.idempotencyKey && input.requestFingerprint ? await this.reuseIdempotentUpload(client, input.tenantId, input.idempotencyKey, input.requestFingerprint) : null;
          if (!reused) throw new Error("BATCH_FULL");
          await client.query("COMMIT");
          return reused;
        }
      }
      const document = await client.query<{ id: string; public_id: string }>(
        `INSERT INTO documents(id, organization_id, public_id, status, filename, mime_type, size_bytes, content_hash, storage_key, batch_id)
         VALUES (gen_random_uuid(), $1::uuid, encode(gen_random_bytes(16), 'hex'), 'SCANNING', $2, $3, $4, $5, $6, $7::uuid)
         RETURNING id, public_id`,
        [input.tenantId, input.filename, input.mimeType, input.sizeBytes, input.contentHash, input.storageKey, input.batchId ?? null]
      );
      const row = document.rows[0]!;
      const run = await client.query<{ id: string }>(
        `INSERT INTO document_runs(id, organization_id, document_id, outcome) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'RUNNING') RETURNING id`,
        [input.tenantId, row.id]
      );
      if (input.idempotencyKey && input.requestFingerprint) {
        const idem = await client.query<{ document_id: string }>(
          `INSERT INTO upload_idempotency_keys(organization_id, idempotency_key, request_fingerprint, document_id, expires_at)
           VALUES ($1::uuid, $2, $3, $4::uuid, now() + interval '24 hours')
           ON CONFLICT (organization_id, idempotency_key) DO NOTHING RETURNING document_id`,
          [input.tenantId, input.idempotencyKey, input.requestFingerprint, row.id]
        );
        if (idem.rows.length === 0) {
          const reused = await this.reuseIdempotentUpload(client, input.tenantId, input.idempotencyKey, input.requestFingerprint);
          if (!reused) throw new Error("IDEMPOTENCY_CONFLICT");
          await client.query("DELETE FROM document_runs WHERE id=$1::uuid", [run.rows[0]!.id]);
          await client.query("DELETE FROM documents WHERE id=$1::uuid", [row.id]);
          await client.query("COMMIT");
          return reused;
        }
      }
      await client.query("COMMIT");
      return { documentId: row.id, runId: run.rows[0]!.id, tenantId: input.tenantId, ...(input.batchId ? { batchId: input.batchId } : {}) };
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  /**
   * The upload an idempotency key already created, with its job (if any). `status`, `storageKey` and `stale` let a replay
   * resume an upload whose request died before it was enqueued (`stale`: untouched for RESUME_AFTER, far longer than
   * the scan and the two status transactions of a live request can take).
   */
  async findIdempotentUpload(input: { tenantId: string; idempotencyKey?: string; requestFingerprint: string }): Promise<UploadedDocument & { jobId?: string; status?: string; storageKey?: string; stale?: boolean } | null> {
    if (!input.idempotencyKey) return null;
    const client = await this.pool.connect();
    try { await client.query("BEGIN"); await client.query("SELECT set_config('app.current_org', $1, true)", [input.tenantId]);
      const result = await client.query<{ document_id: string; request_fingerprint: string; run_id: string; job_id: string | null; batch_id: string | null; status: string | null; storage_key: string | null; stale: boolean | null }>(
        `SELECT i.document_id, i.request_fingerprint, r.id AS run_id, j.id AS job_id, d.batch_id, d.status::text AS status, d.storage_key,
                d.updated_at < now() - interval '${RESUME_AFTER}' AS stale
         FROM upload_idempotency_keys i JOIN document_runs r ON r.document_id=i.document_id AND r.organization_id=i.organization_id
         LEFT JOIN documents d ON d.id=i.document_id AND d.organization_id=i.organization_id
         LEFT JOIN extraction_jobs j ON j.run_id=r.id AND j.organization_id=r.organization_id
         WHERE i.organization_id=$1::uuid AND i.idempotency_key=$2 AND i.expires_at > now()
         ORDER BY r.created_at DESC LIMIT 1`, [input.tenantId, input.idempotencyKey]);
      const row = result.rows[0];
      if (!row) { await client.query("COMMIT"); return null; }
      if (row.request_fingerprint !== input.requestFingerprint) throw new Error("IDEMPOTENCY_CONFLICT");
      await client.query("COMMIT"); return { tenantId: input.tenantId, documentId: row.document_id, runId: row.run_id, ...(row.job_id ? { jobId: row.job_id } : {}), ...(row.batch_id ? { batchId: row.batch_id } : {}),
        ...(row.status ? { status: row.status } : {}), ...(row.storage_key ? { storageKey: row.storage_key } : {}), stale: row.stale === true };
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
  }

  /**
   * Takes over an upload whose request died before it was queued, before a replay resumes it: bumps `updated_at` only
   * while the document is still SCANNING/CLEAN, untouched for RESUME_AFTER and without a job. Concurrent replays
   * serialise on the row lock and re-check `updated_at`, so exactly one gets true.
   */
  async claimStaleUpload(tenantId: string, documentId: string): Promise<boolean> {
    if (!isUuid(documentId)) return false;
    return this.tenantTransaction(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE documents d SET updated_at = now()
         WHERE d.id = $1::uuid AND d.organization_id = $2::uuid AND d.deleted_at IS NULL AND d.status IN ('SCANNING','CLEAN')
           AND d.updated_at < now() - interval '${RESUME_AFTER}'
           AND NOT EXISTS (SELECT 1 FROM extraction_jobs j JOIN document_runs r ON r.id = j.run_id AND r.organization_id = j.organization_id
                           WHERE r.document_id = d.id AND r.organization_id = d.organization_id)`, [documentId, tenantId]);
      return result.rowCount === 1;
    });
  }

  async updateScanStatus(tenantId: string, documentId: string, status: "CLEAN" | "QUARANTINED" | "FAILED", errorMessage?: string): Promise<void> {
    const client = await this.pool.connect();
    try { await client.query("BEGIN"); await client.query("SELECT set_config('app.current_org', $1, true)", [tenantId]);
      const result = await client.query(`UPDATE documents SET status = $1::document_status, error_message = $2, updated_at = now() WHERE id = $3::uuid AND organization_id = $4::uuid`, [status, errorMessage ?? null, documentId, tenantId]);
      if (result.rowCount !== 1) throw new Error("DOCUMENT_NOT_FOUND_OR_FORBIDDEN"); await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
  }

  async markProcessing(tenantId: string, documentId: string): Promise<void> {
    const client = await this.pool.connect();
    try { await client.query("BEGIN"); await client.query("SELECT set_config('app.current_org', $1, true)", [tenantId]); const result = await client.query("UPDATE documents SET status='PROCESSING', error_message=NULL, updated_at=now() WHERE id=$1::uuid AND organization_id=$2::uuid", [documentId, tenantId]); if (result.rowCount !== 1) throw new Error("DOCUMENT_NOT_FOUND_OR_FORBIDDEN"); await client.query("COMMIT"); }
    catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
  }

  async markFailure(tenantId: string, documentId: string, message: string): Promise<void> {
    const client = await this.pool.connect();
    try { await client.query("BEGIN"); await client.query("SELECT set_config('app.current_org', $1, true)", [tenantId]); const result = await client.query("UPDATE documents SET status='FAILED', error_message=$1, updated_at=now() WHERE id=$2::uuid AND organization_id=$3::uuid", [message.slice(0, 4000), documentId, tenantId]); if (result.rowCount !== 1) throw new Error("DOCUMENT_NOT_FOUND_OR_FORBIDDEN"); await client.query("COMMIT"); }
    catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
  }

  /**
   * The job of `runId` is DEAD but its document could not be loaded by the worker: mark the document FAILED (retryable)
   * instead of leaving it queued forever. Only CLEAN/PROCESSING rows change. Returns whether a row changed.
   */
  async markRunFailure(tenantId: string, runId: string, message: string): Promise<boolean> {
    return this.tenantTransaction(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE documents d SET status='FAILED', error_message=$1, updated_at=now() FROM document_runs r
         WHERE r.id=$2::uuid AND r.organization_id=$3::uuid AND d.id=r.document_id AND d.organization_id=r.organization_id
           AND d.deleted_at IS NULL AND d.status IN ('CLEAN','PROCESSING')`, [message.slice(0, 4000), runId, tenantId]);
      return result.rowCount === 1;
    });
  }

  /** The queue will retry the job: back to CLEAN (queued) with error_message `RETRYING: …`. */
  async markRetrying(tenantId: string, documentId: string, message: string): Promise<void> {
    const text = message.startsWith("RETRYING:") ? message : `RETRYING: ${message}`;
    await this.tenantTransaction(tenantId, async (client) => {
      const result = await client.query("UPDATE documents SET status='CLEAN', error_message=$1, updated_at=now() WHERE id=$2::uuid AND organization_id=$3::uuid AND deleted_at IS NULL", [text.slice(0, 4000), documentId, tenantId]);
      if (result.rowCount !== 1) throw new Error("DOCUMENT_NOT_FOUND_OR_FORBIDDEN");
    });
  }

  async getWorkerDocument(runId: string, tenantId: string): Promise<WorkerDocument | null> {
    const client = await this.pool.connect();
    try { await client.query("BEGIN"); await client.query("SELECT set_config('app.current_org', $1, true)", [tenantId]); const result = await client.query(
      `SELECT d.id, d.organization_id, d.storage_key, d.filename, d.mime_type
       FROM documents d JOIN document_runs r ON r.document_id=d.id AND r.organization_id=d.organization_id
       WHERE r.id=$1::uuid AND r.organization_id=$2::uuid AND d.deleted_at IS NULL`,
      [runId, tenantId]
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row || typeof row.storage_key !== "string") { await client.query("COMMIT"); return null; }
    await client.query("COMMIT"); return { documentId: String(row.id), organizationId: String(row.organization_id), sourceKey: row.storage_key, filename: String(row.filename), mimeType: String(row.mime_type) };
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
  }

  async saveOcrResult(tenantId: string, documentId: string, result: OcrResultPatch): Promise<void> {
    const status: OcrDocumentStatus = result.needsReview ? "NEEDS_REVIEW" : "SUCCEEDED";
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_org', $1, true)", [tenantId]);
      const updated = await client.query(
        `UPDATE documents
         SET status = $1::document_status, ocr_document_id = $2, ocr_engine = $3,
             ocr_version = $4, raw_response = $5::jsonb, structured_result = $6::jsonb,
             needs_review = $7, error_message = NULL, processed_at = now(), updated_at = now()
         WHERE id = $8::uuid AND organization_id = $9::uuid AND deleted_at IS NULL`,
        [status, result.ocrDocumentId, result.engine ?? null, result.version ?? null,
          JSON.stringify(result.rawResponse), JSON.stringify(result.structuredResult), result.needsReview, documentId, tenantId]
      );
      if (updated.rowCount !== 1) throw new Error("DOCUMENT_NOT_FOUND_OR_FORBIDDEN");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Legacy single-field confirm (flow unchanged). Path-aware (`legacyFieldPath`, with `audit.raw` choosing the treatment
   * item). The PENDING call writes the value and `needsReview:false`; the later SUCCEEDED/RETRY calls of the same
   * confirmation only update statuses, so they never re-resolve (and possibly move) the target. The audit row keeps the
   * pre-correction raw/value.
   */
  async saveCorrection(tenantId: string, documentId: string, field: string, value: string, confirmStatus: ConfirmStatus, confirmError?: string, remainingNeedsReview?: boolean, audit: CorrectionAudit = { raw: "", verifiedBy: tenantId }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_org', $1, true)", [tenantId]);
      const current = await client.query<{ structured_result: unknown }>("SELECT structured_result FROM documents WHERE id=$1::uuid AND organization_id=$2::uuid AND deleted_at IS NULL FOR UPDATE", [documentId, tenantId]);
      if (!current.rows[0]) throw new Error("DOCUMENT_NOT_FOUND_OR_FORBIDDEN");
      const stored = current.rows[0].structured_result;
      const path = confirmStatus === "PENDING" ? legacyFieldPath(stored, field, audit.raw) : null;
      const previous = (path ?? []).reduce<unknown>((node, key) => typeof node === "object" && node !== null ? (node as Row)[key] : undefined, stored);
      const previousField: Row = path && typeof previous === "object" && previous !== null ? previous as Row : {};
      const result = await client.query(
        `UPDATE documents
         SET structured_result = CASE WHEN $7::text[] IS NULL THEN structured_result ELSE
               jsonb_set(CASE WHEN jsonb_typeof(structured_result) = 'object' THEN structured_result ELSE '{}'::jsonb END, $7::text[],
               (CASE WHEN jsonb_typeof(structured_result #> $7::text[]) = 'object' THEN structured_result #> $7::text[] ELSE '{}'::jsonb END)
                 || jsonb_build_object('value', to_jsonb($1::text), 'needsReview', false), true) END,
             needs_review = CASE WHEN $2 = 'SUCCEEDED' AND $6::boolean IS NOT NULL THEN $6::boolean WHEN $2 = 'SUCCEEDED' THEN false ELSE needs_review END,
             status = CASE WHEN $2 = 'SUCCEEDED' AND COALESCE($6::boolean, false) = false THEN 'SUCCEEDED'::document_status ELSE status END,
             confirm_status = $2, confirm_error = $3, confirmed_at = CASE WHEN $2 = 'SUCCEEDED' THEN now() ELSE confirmed_at END,
             updated_at = now()
         WHERE id = $4::uuid AND organization_id = $5::uuid AND deleted_at IS NULL`,
        [value, confirmStatus, confirmError ?? null, documentId, tenantId, remainingNeedsReview ?? null, path]
      );
      if (result.rowCount !== 1) throw new Error("DOCUMENT_NOT_FOUND_OR_FORBIDDEN");
      if (confirmStatus === "PENDING") {
        const correction = await client.query<{ id: string }>(
          `INSERT INTO ocr_corrections(organization_id, document_id, field, old_raw, normalized_value, verified_value, verified_by, confirm_status)
           VALUES ($1::uuid, $2::uuid, $3::varchar, COALESCE($4::text, $5::text), COALESCE($6::text, $5::text), $7::text, $8::text, 'PENDING')
           ON CONFLICT (organization_id, document_id, field, verified_value) DO UPDATE SET confirm_status='PENDING', confirm_error=NULL, verified_at=now()
           RETURNING id`,
          [tenantId, documentId, field, str(previousField.raw), audit.raw, str(previousField.value), value, audit.verifiedBy]
        );
        const correctionId = correction.rows[0]!.id;
        await client.query(
          `INSERT INTO ocr_confirm_outbox(organization_id, correction_id, payload, status, attempts, next_attempt_at)
           SELECT $1::uuid, $2::uuid, jsonb_build_object('documentId', ocr_document_id, 'field', $3::text, 'raw', $4::text, 'verifiedValue', $5::text), 'PENDING', 0, now()
           FROM documents WHERE id=$6::uuid AND organization_id=$1::uuid
           ON CONFLICT (correction_id) DO UPDATE SET status='PENDING', next_attempt_at=now(), last_error=NULL`,
          [tenantId, correctionId, field, audit.raw, value, documentId]
        );
      } else {
        await client.query(
          `UPDATE ocr_corrections SET confirm_status=$1::varchar, confirm_error=$2::text
           WHERE id=(SELECT id FROM ocr_corrections WHERE organization_id=$3::uuid AND document_id=$4::uuid AND field=$5::varchar ORDER BY verified_at DESC LIMIT 1)`,
          [confirmStatus, confirmError ?? null, tenantId, documentId, field]
        );
        await client.query(
          `UPDATE ocr_confirm_outbox SET status=$1::varchar, last_error=$2::text, sent_at=CASE WHEN $1::text='SUCCEEDED' THEN now() ELSE sent_at END, attempts=attempts+1
           WHERE correction_id=(SELECT id FROM ocr_corrections WHERE organization_id=$3::uuid AND document_id=$4::uuid AND field=$5::varchar ORDER BY verified_at DESC LIMIT 1)`,
          [confirmStatus, confirmError ?? null, tenantId, documentId, field]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getReviewDocument(tenantId: string, documentId: string): Promise<ReviewDocument | null> {
    if (!isUuid(documentId)) return null;
    return this.tenantTransaction(tenantId, async (client) => {
      const result = await client.query<Row>(REVIEW_SELECT, [documentId, tenantId]);
      return result.rows[0] ? toReviewDocument(result.rows[0]) : null;
    });
  }

  async getOriginal(tenantId: string, documentId: string): Promise<{ storageKey: string; mimeType: string; status: string } | null> {
    if (!isUuid(documentId)) return null;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_org', $1, true)", [tenantId]);
      const result = await client.query<{ storageKey: string; mimeType: string; status: string }>("SELECT storage_key AS \"storageKey\", mime_type AS \"mimeType\", status::text AS status FROM documents WHERE id=$1::uuid AND organization_id=$2::uuid AND deleted_at IS NULL", [documentId, tenantId]);
      await client.query("COMMIT");
      return result.rows[0] ?? null;
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  /** BATCH_INVALID unless expectedTotal is an integer 1..500, label ≤ 200 characters and createdBy non-empty. */
  async createBatch(tenantId: string, input: CreateBatchInput): Promise<BatchSummary> {
    const label = typeof input.label === "string" && input.label.trim() !== "" ? input.label.trim() : null;
    const createdBy = typeof input.createdBy === "string" ? input.createdBy.trim().slice(0, 255) : "";
    if (!Number.isInteger(input.expectedTotal) || input.expectedTotal < 1 || input.expectedTotal > 500 || (label !== null && label.length > 200) || !createdBy) throw new Error("BATCH_INVALID");
    return this.tenantTransaction(tenantId, async (client) => {
      const inserted = await client.query<{ id: string }>("INSERT INTO ocr_batches(organization_id, created_by, label, expected_total) VALUES ($1::uuid, $2, $3, $4) RETURNING id", [tenantId, createdBy, label, input.expectedTotal]);
      const summary = await client.query<Row>(BATCH_SELECT, [tenantId, inserted.rows[0]!.id, 1]);
      return toBatchSummary(summary.rows[0]!);
    });
  }

  async getBatch(tenantId: string, batchId: string): Promise<BatchSummary | null> {
    if (!isUuid(batchId)) return null;
    return this.tenantTransaction(tenantId, async (client) => {
      const result = await client.query<Row>(BATCH_SELECT, [tenantId, batchId, 1]);
      return result.rows[0] ? toBatchSummary(result.rows[0]) : null;
    });
  }

  /** Newest first; limit clamped to 1..100. */
  async listBatches(tenantId: string, limit = 20): Promise<BatchSummary[]> {
    return this.tenantTransaction(tenantId, async (client) => {
      const result = await client.query<Row>(BATCH_SELECT, [tenantId, null, clampInt(limit, 20, 1, 100)]);
      return result.rows.map(toBatchSummary);
    });
  }

  /**
   * Newest first. limit 1..200 (default 50) and offset ≥ 0 are clamped. `q` matches filename, customer name and therapist
   * (case-insensitive, LIKE wildcards escaped). Unknown status → INVALID_QUERY; malformed batchId → BATCH_NOT_FOUND.
   */
  async listDocuments(tenantId: string, query: ListDocumentsQuery = {}): Promise<{ total: number; documents: DocumentListItem[] }> {
    const limit = clampInt(query.limit, 50, 1, 200);
    const offset = clampInt(query.offset, 0, 0, 1_000_000);
    if (query.status !== undefined && !DOCUMENT_STATUS_CATEGORIES.includes(query.status)) throw new Error("INVALID_QUERY");
    if (query.batchId !== undefined && !isUuid(query.batchId)) throw new Error("BATCH_NOT_FOUND");
    const params: unknown[] = [tenantId];
    const where = ["d.organization_id = $1::uuid", "d.deleted_at IS NULL", "d.status <> 'DELETED'"];
    if (query.status) where.push(CATEGORY_SQL[query.status]);
    if (query.batchId) { params.push(query.batchId); where.push(`d.batch_id = $${params.length}::uuid`); }
    const q = typeof query.q === "string" ? query.q.trim().slice(0, 200) : "";
    if (q) {
      params.push(`%${escapeLike(q)}%`);
      const p = `$${params.length}`;
      where.push(`(d.filename ILIKE ${p} ESCAPE '\\' OR (d.structured_result #>> '{customerInformation,name,value}') ILIKE ${p} ESCAPE '\\'
        OR (d.structured_result #>> '{staffOnly,therapistName,value}') ILIKE ${p} ESCAPE '\\' OR (d.structured_result #>> '{therapistName,value}') ILIKE ${p} ESCAPE '\\')`);
    }
    const condition = where.join(" AND ");
    return this.tenantTransaction(tenantId, async (client) => {
      const total = await client.query<{ total: number }>(`SELECT count(*)::int AS total FROM documents d WHERE ${condition}`, params);
      const rows = await client.query<Row>(
        `SELECT d.id, d.batch_id, d.filename, d.mime_type, d.status::text AS status, d.needs_review, d.error_message, d.created_at, d.processed_at,
                ${REVIEWED_AT_SQL} AS reviewed_at, d.structured_result, ${DELIVERY_SQL} AS delivery_status
         FROM documents d WHERE ${condition} ORDER BY d.created_at DESC, d.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]);
      return { total: total.rows[0]?.total ?? 0, documents: rows.rows.map(toListItem) };
    });
  }

  /**
   * Re-queues a FAILED document: status CLEAN, error cleared, one new PENDING job on the latest run (the run stays
   * RUNNING; never a second run). A document that never reached the queue (scan failure → no job) is not retryable,
   * because a retry would skip the malware scan. DOCUMENT_NOT_FOUND / DOCUMENT_NOT_RETRYABLE.
   */
  async retryDocument(tenantId: string, documentId: string): Promise<{ jobId: string }> {
    if (!isUuid(documentId)) throw new Error("DOCUMENT_NOT_FOUND");
    return this.tenantTransaction(tenantId, async (client) => {
      const document = await client.query<{ status: string }>("SELECT status::text AS status FROM documents WHERE id=$1::uuid AND organization_id=$2::uuid AND deleted_at IS NULL FOR UPDATE", [documentId, tenantId]);
      if (!document.rows[0]) throw new Error("DOCUMENT_NOT_FOUND");
      if (document.rows[0].status !== "FAILED") throw new Error("DOCUMENT_NOT_RETRYABLE");
      const run = await client.query<{ id: string; queued: boolean }>(
        `SELECT r.id, EXISTS (SELECT 1 FROM extraction_jobs j JOIN document_runs rr ON rr.id=j.run_id AND rr.organization_id=j.organization_id
                               WHERE rr.organization_id=r.organization_id AND rr.document_id=r.document_id) AS queued
         FROM document_runs r WHERE r.organization_id=$1::uuid AND r.document_id=$2::uuid ORDER BY r.created_at DESC LIMIT 1`, [tenantId, documentId]);
      const latest = run.rows[0];
      if (!latest?.queued) throw new Error("DOCUMENT_NOT_RETRYABLE");
      await client.query("UPDATE documents SET status='CLEAN', error_message=NULL, updated_at=now() WHERE id=$1::uuid AND organization_id=$2::uuid", [documentId, tenantId]);
      const job = await client.query<{ id: string }>(
        "INSERT INTO extraction_jobs(id, organization_id, run_id, kind, status, available_at) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'OCR', 'PENDING', now()) RETURNING id",
        [tenantId, latest.id]);
      return { jobId: job.rows[0]!.id };
    });
  }

  /**
   * Saves the reviewer's full edited view (`applyReviewEdits`) and confirms the document. One ocr_corrections row per
   * change; one ocr_confirm_outbox row per provider change, delivered asynchronously by the worker's outbox dispatcher.
   * DOCUMENT_NOT_FOUND / DOCUMENT_NOT_REVIEWABLE (status not NEEDS_REVIEW|SUCCEEDED) / REVIEW_CONFLICT / REVIEW_INVALID.
   */
  async saveReview(tenantId: string, documentId: string, input: SaveReviewInput): Promise<SaveReviewResult> {
    if (!isUuid(documentId)) throw new Error("DOCUMENT_NOT_FOUND");
    const reviewedBy = typeof input.reviewedBy === "string" ? input.reviewedBy.trim().slice(0, 255) : "";
    const expected = input.expectedUpdatedAt === undefined ? null : Date.parse(input.expectedUpdatedAt);
    if (!reviewedBy || (expected !== null && !Number.isFinite(expected))) throw new Error("REVIEW_INVALID");
    return this.tenantTransaction(tenantId, async (client) => {
      const locked = await client.query<{ status: string; structured_result: unknown; updated_at: unknown; ocr_document_id: string | null; reviewed_at: unknown }>(
        `SELECT d.status::text AS status, d.structured_result, d.updated_at, d.ocr_document_id, ${REVIEWED_AT_SQL} AS reviewed_at
         FROM documents d WHERE d.id=$1::uuid AND d.organization_id=$2::uuid AND d.deleted_at IS NULL FOR UPDATE`,
        [documentId, tenantId]);
      const row = locked.rows[0];
      if (!row) throw new Error("DOCUMENT_NOT_FOUND");
      if (row.status !== "NEEDS_REVIEW" && row.status !== "SUCCEEDED") throw new Error("DOCUMENT_NOT_REVIEWABLE");
      if (expected !== null && ms(row.updated_at) !== expected) throw new Error("REVIEW_CONFLICT");
      // viewOf: fields of an already confirmed row (e.g. v2.2 confirmations) are not re-sent to the provider as "flagged".
      const { merged, changes } = applyReviewEdits(viewOf(row), input.structuredResult);
      const deliver = row.ocr_document_id !== null && changes.some((change) => change.provider);
      await client.query(
        `UPDATE documents SET structured_result=$1::jsonb, needs_review=false, status='SUCCEEDED', reviewed_at=now(), reviewed_by=$2,
           confirm_status=$3, confirm_error=NULL, updated_at=now() WHERE id=$4::uuid AND organization_id=$5::uuid`,
        [JSON.stringify(merged), reviewedBy, deliver ? "PENDING" : null, documentId, tenantId]);
      for (const change of changes) {
        const provider = deliver ? change.provider : undefined;
        const correction = await client.query<{ id: string }>(
          `INSERT INTO ocr_corrections(organization_id, document_id, field, old_raw, normalized_value, verified_value, verified_by, confirm_status)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (organization_id, document_id, field, verified_value) DO UPDATE SET old_raw=EXCLUDED.old_raw, normalized_value=EXCLUDED.normalized_value,
             verified_by=EXCLUDED.verified_by, verified_at=now(), confirm_status=EXCLUDED.confirm_status, confirm_error=NULL
           RETURNING id`,
          [tenantId, documentId, change.path.slice(0, 120), change.oldRaw, change.oldValue, change.newValue ?? "", reviewedBy, provider ? "PENDING" : "NOT_REQUIRED"]);
        if (!provider) continue;
        await client.query(
          `INSERT INTO ocr_confirm_outbox(organization_id, correction_id, payload, status, attempts, next_attempt_at)
           VALUES ($1::uuid, $2::uuid, jsonb_build_object('documentId', $3::text, 'field', $4::text, 'raw', $5::text, 'verifiedValue', $6::text), 'PENDING', 0, now())
           ON CONFLICT (correction_id) DO UPDATE SET payload=EXCLUDED.payload, status='PENDING', attempts=0, next_attempt_at=now(), last_error=NULL,
             sent_at=NULL, locked_at=NULL, locked_by=NULL`,
          [tenantId, correction.rows[0]!.id, row.ocr_document_id, provider.field, provider.raw, provider.verifiedValue]);
      }
      const saved = await client.query<Row>(REVIEW_SELECT, [documentId, tenantId]);
      return { corrections: changes.length, delivery: deliver ? "PENDING" : "NOT_REQUIRED", document: toReviewDocument(saved.rows[0]!) };
    });
  }

  async close(): Promise<void> { await this.pool.end(); }
}
