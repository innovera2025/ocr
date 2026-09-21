import { Pool, type PoolConfig } from "pg";
import type { OcrResponse } from "@innovera/ocr-client";

export type OcrDocumentStatus = "PROCESSING" | "SUCCEEDED" | "NEEDS_REVIEW" | "FAILED";
export type ConfirmStatus = "PENDING" | "SUCCEEDED" | "RETRY";
export type CorrectionAudit = Readonly<{ raw: string; verifiedBy: string }>;

export type UploadedDocument = Readonly<{ documentId: string; runId: string; tenantId: string; reused?: boolean }>;
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

export type ReviewDocument = Readonly<{
  documentId: string;
  tenantId: string;
  filename: string;
  mimeType: string;
  status: string;
  ocrDocumentId: string | null;
  ocrEngine: string | null;
  ocrVersion: string | null;
  rawResponse: unknown;
  structuredResult: unknown;
  needsReview: boolean;
  confirmStatus: string | null;
}>;

export type ReviewStore = DocumentStore & Readonly<{
  getReviewDocument(tenantId: string, documentId: string): Promise<ReviewDocument | null>;
  getOriginal?: (tenantId: string, documentId: string) => Promise<{ storageKey: string; mimeType: string } | null>;
}>;

export function hasReviewFields(response: OcrResponse): boolean {
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

export class PostgresOcrDocumentStore implements ReviewStore {
  readonly pool: Pool;

  constructor(config: Pool | PoolConfig | string) {
    this.pool = config instanceof Pool ? config : new Pool(typeof config === "string" ? { connectionString: config } : config);
  }

  async createUploadedDocument(input: { tenantId: string; filename: string; mimeType: string; sizeBytes: number; contentHash: string; storageKey: string; idempotencyKey?: string; requestFingerprint?: string }): Promise<UploadedDocument> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_org', $1, true)", [input.tenantId]);
      if (input.idempotencyKey) {
        await client.query("DELETE FROM upload_idempotency_keys WHERE organization_id=$1::uuid AND idempotency_key=$2 AND expires_at <= now()", [input.tenantId, input.idempotencyKey]);
      }
      const document = await client.query<{ id: string; public_id: string }>(
        `INSERT INTO documents(id, organization_id, public_id, status, filename, mime_type, size_bytes, content_hash, storage_key)
         VALUES (gen_random_uuid(), $1::uuid, encode(gen_random_bytes(16), 'hex'), 'SCANNING', $2, $3, $4, $5, $6)
         RETURNING id, public_id`,
        [input.tenantId, input.filename, input.mimeType, input.sizeBytes, input.contentHash, input.storageKey]
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
          const existing = await client.query<{ document_id: string; request_fingerprint: string }>("SELECT document_id, request_fingerprint FROM upload_idempotency_keys WHERE organization_id=$1::uuid AND idempotency_key=$2 AND expires_at > now()", [input.tenantId, input.idempotencyKey]);
          if (existing.rows[0]?.request_fingerprint !== input.requestFingerprint) throw new Error("IDEMPOTENCY_CONFLICT");
          const existingRun = await client.query<{ id: string }>("SELECT id FROM document_runs WHERE organization_id=$1::uuid AND document_id=$2::uuid ORDER BY created_at DESC LIMIT 1", [input.tenantId, existing.rows[0]!.document_id]);
          await client.query("DELETE FROM document_runs WHERE id=$1::uuid", [run.rows[0]!.id]);
          await client.query("DELETE FROM documents WHERE id=$1::uuid", [row.id]);
          await client.query("COMMIT");
          return { documentId: existing.rows[0]!.document_id, runId: existingRun.rows[0]!.id, tenantId: input.tenantId, reused: true };
        }
      }
      await client.query("COMMIT");
      return { documentId: row.id, runId: run.rows[0]!.id, tenantId: input.tenantId };
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  async findIdempotentUpload(input: { tenantId: string; idempotencyKey?: string; requestFingerprint: string }): Promise<UploadedDocument & { jobId?: string } | null> {
    if (!input.idempotencyKey) return null;
    const client = await this.pool.connect();
    try { await client.query("BEGIN"); await client.query("SELECT set_config('app.current_org', $1, true)", [input.tenantId]);
      const result = await client.query<{ document_id: string; request_fingerprint: string; run_id: string; job_id: string | null }>(
        `SELECT i.document_id, i.request_fingerprint, r.id AS run_id, j.id AS job_id
         FROM upload_idempotency_keys i JOIN document_runs r ON r.document_id=i.document_id AND r.organization_id=i.organization_id
         LEFT JOIN extraction_jobs j ON j.run_id=r.id AND j.organization_id=r.organization_id
         WHERE i.organization_id=$1::uuid AND i.idempotency_key=$2 AND i.expires_at > now()
         ORDER BY r.created_at DESC LIMIT 1`, [input.tenantId, input.idempotencyKey]);
      const row = result.rows[0];
      if (!row) { await client.query("COMMIT"); return null; }
      if (row.request_fingerprint !== input.requestFingerprint) throw new Error("IDEMPOTENCY_CONFLICT");
      await client.query("COMMIT"); return { tenantId: input.tenantId, documentId: row.document_id, runId: row.run_id, ...(row.job_id ? { jobId: row.job_id } : {}) };
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
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

  async saveCorrection(tenantId: string, documentId: string, field: string, value: string, confirmStatus: ConfirmStatus, confirmError?: string, remainingNeedsReview?: boolean, audit: CorrectionAudit = { raw: "", verifiedBy: tenantId }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_org', $1, true)", [tenantId]);
      const result = await client.query(
        `UPDATE documents
         SET structured_result = jsonb_set(COALESCE(structured_result, '{}'::jsonb), ARRAY[$1, 'value'], to_jsonb($2::text), true),
             needs_review = CASE WHEN $3 = 'SUCCEEDED' AND $7::boolean IS NOT NULL THEN $7::boolean WHEN $3 = 'SUCCEEDED' THEN false ELSE needs_review END,
             status = CASE WHEN $3 = 'SUCCEEDED' AND COALESCE($7::boolean, false) = false THEN 'SUCCEEDED'::document_status ELSE status END,
             confirm_status = $3, confirm_error = $4, confirmed_at = CASE WHEN $3 = 'SUCCEEDED' THEN now() ELSE confirmed_at END,
             updated_at = now()
         WHERE id = $5::uuid AND organization_id = $6::uuid AND deleted_at IS NULL`,
        [field, value, confirmStatus, confirmError ?? null, documentId, tenantId, remainingNeedsReview ?? null]
      );
      if (result.rowCount !== 1) throw new Error("DOCUMENT_NOT_FOUND_OR_FORBIDDEN");
      if (confirmStatus === "PENDING") {
        const correction = await client.query<{ id: string }>(
          `INSERT INTO ocr_corrections(organization_id, document_id, field, old_raw, normalized_value, verified_value, verified_by, confirm_status)
           SELECT $1::uuid, id, $2::varchar, COALESCE(structured_result->($2::text)->>'raw', $3::text), COALESCE(structured_result->($2::text)->>'value', $3::text), $4::text, $5::text, 'PENDING'
           FROM documents WHERE id=$6::uuid AND organization_id=$1::uuid
           ON CONFLICT (organization_id, document_id, field, verified_value) DO UPDATE SET confirm_status='PENDING', confirm_error=NULL, verified_at=now()
           RETURNING id`,
          [tenantId, field, audit.raw, value, audit.verifiedBy, documentId]
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
    const client = await this.pool.connect();
    try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_org', $1, true)", [tenantId]);
    const result = await client.query(
      `SELECT id, organization_id, filename, mime_type, status::text, ocr_document_id, ocr_engine, ocr_version,
              raw_response, structured_result, needs_review, confirm_status
       FROM documents WHERE id = $1::uuid AND organization_id = $2::uuid AND deleted_at IS NULL`,
      [documentId, tenantId]
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) { await client.query("COMMIT"); return null; }
    const review = {
      documentId: String(row.id), tenantId: String(row.organization_id), filename: String(row.filename), mimeType: String(row.mime_type),
      status: String(row.status), ocrDocumentId: (row.ocr_document_id as string | null) ?? null,
      ocrEngine: (row.ocr_engine as string | null) ?? null, ocrVersion: (row.ocr_version as string | null) ?? null,
      rawResponse: row.raw_response ?? null, structuredResult: row.structured_result ?? null,
      needsReview: row.needs_review === true, confirmStatus: (row.confirm_status as string | null) ?? null
    };
    await client.query("COMMIT");
    return review;
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
  }

  async getOriginal(tenantId: string, documentId: string): Promise<{ storageKey: string; mimeType: string } | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_org', $1, true)", [tenantId]);
      const result = await client.query<{ storageKey: string; mimeType: string }>("SELECT storage_key AS \"storageKey\", mime_type AS \"mimeType\" FROM documents WHERE id=$1::uuid AND organization_id=$2::uuid AND deleted_at IS NULL", [documentId, tenantId]);
      await client.query("COMMIT");
      return result.rows[0] ?? null;
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  async close(): Promise<void> { await this.pool.end(); }
}
