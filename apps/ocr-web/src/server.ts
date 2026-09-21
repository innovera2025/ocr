import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHmac, randomBytes } from "node:crypto";
import { loadConfig, redactLog } from "@innovera/ocr-config";
import { handleRawUpload, type IngestDependencies } from "@innovera/ocr-ingest/http";
import { OcrClient } from "@innovera/ocr-client";
import { DOCUMENT_STATUS_CATEGORIES, normalizeStructuredResult, type DocumentStatusCategory, type ReviewStore } from "@innovera/ocr-persistence";
import { assertDatabaseReady, createDatabasePool, runMigrationsWithPool } from "@innovera/ocr-db-runtime";
import { resolve } from "node:path";
import { PostgresOcrDocumentStore } from "@innovera/ocr-persistence";
import { createRuntimeIngest } from "./runtime.js";
import { workbenchPage } from "./workbench.js";
import { AuthenticationError, authenticateBearer, type Principal } from "@innovera/ocr-auth";
import { logEvent, metrics, requestId } from "@innovera/ocr-observability";
import { clamAvHealthCheck } from "@innovera/ocr-ingest/clamav";
import type { LocalStorage } from "@innovera/ocr-storage/local";
import { createLocalStorage } from "@innovera/ocr-storage/local";

export type DocumentListQuery = { limit: number; offset: number; status?: DocumentStatusCategory; q?: string; batchId?: string };

/** Structural subset of the store methods behind the workbench routes (spec §4), so tests can pass fakes. PostgresOcrDocumentStore implements it; results are passed through as JSON. */
export type WorkbenchStore = Readonly<{
  createBatch(tenantId: string, input: { createdBy: string; expectedTotal: number; label?: string }): Promise<object>;
  getBatch(tenantId: string, batchId: string): Promise<object | null>;
  listBatches(tenantId: string, limit?: number): Promise<readonly object[]>;
  listDocuments(tenantId: string, query: DocumentListQuery): Promise<{ total: number; documents: readonly object[] }>;
  retryDocument(tenantId: string, documentId: string): Promise<{ jobId: string }>;
  saveReview(tenantId: string, documentId: string, input: { structuredResult: unknown; reviewedBy: string; expectedUpdatedAt?: string }): Promise<{ corrections: number; delivery: "PENDING" | "NOT_REQUIRED"; document: unknown }>;
}>;

export type AppDependencies = Readonly<{
  ingest: IngestDependencies;
  ingestForTenant?: (tenantId: string, idempotencyKey?: string, batchId?: string) => IngestDependencies;
  reviewStore?: ReviewStore;
  workbenchStore?: WorkbenchStore;
  storage?: LocalStorage;
  ocrClient?: OcrClient;
}>;
type AppServerOptions = Readonly<{ readiness?: () => boolean | Promise<boolean>; authenticate?: (request: IncomingMessage) => Principal }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUTH_ERRORS = new Set(["UNAUTHENTICATED", "AUTH_NOT_CONFIGURED", "INVALID_TOKEN", "TOKEN_EXPIRED", "INVALID_ISSUER", "INVALID_AUDIENCE", "INVALID_PRINCIPAL"]);
const CONFLICT_ERRORS = new Set(["BATCH_FULL", "IDEMPOTENCY_CONFLICT", "DOCUMENT_NOT_RETRYABLE", "DOCUMENT_NOT_REVIEWABLE", "REVIEW_CONFLICT"]);
const JSON_BODY_LIMIT = 1_048_576;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}(:?\d{2})?)?$/;

export function healthResponse(pathname: string): { status: number; body: { status: string } } {
  if (pathname === "/health/live") return { status: 200, body: { status: "ok" } };
  if (pathname === "/health/ready") return { status: 200, body: { status: "ready" } };
  return { status: 404, body: { status: "not_found" } };
}

/** Spec §5 status mapping, shared by every route. Codes are the `{ error }` body values. */
export function errorStatus(code: string): number {
  if (AUTH_ERRORS.has(code) || code.startsWith("AUTH_") || code.startsWith("TOKEN_")) return 401;
  if (/_NOT_FOUND(_OR_FORBIDDEN)?$/.test(code)) return 404;
  if (CONFLICT_ERRORS.has(code)) return 409;
  if (code === "PAYLOAD_TOO_LARGE") return 413;
  if (code === "UNSUPPORTED_MEDIA_TYPE") return 415;
  if (code.endsWith("_NOT_CONFIGURED")) return 503;
  if (code === "INTERNAL_ERROR") return 500;
  return 400;
}

/** Only SCREAMING_SNAKE codes reach clients; anything else (pg, fs, TypeError…) becomes INTERNAL_ERROR so internals never leak. */
export function errorCode(error: unknown): string {
  if (error instanceof AuthenticationError) return AUTH_ERRORS.has(error.message) ? error.message : "UNAUTHENTICATED";
  const message = error instanceof Error ? error.message : "";
  return /^[A-Z][A-Z0-9_]{2,63}$/.test(message) ? message : "INTERNAL_ERROR";
}

/** Bounded metric label: ids are templated so per-document paths cannot grow the registry. */
export function routeLabel(pathname: string): string {
  if (["/", "/metrics", "/health/live", "/health/ready", "/api/web-token", "/api/batches", "/api/documents"].includes(pathname)) return pathname;
  const match = /^\/(api\/documents|api\/batches|review)\/[^/]+(\/.*)?$/.exec(pathname);
  if (!match) return "unmatched";
  const suffix = match[2] ?? "";
  return `/${match[1]}/:id${["", "/content", "/ocr", "/ocr/review", "/ocr/confirm", "/retry"].includes(suffix) ? suffix : "/*"}`;
}

export function workbenchCsp(nonce: string): string {
  return `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' blob: data:; frame-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'`;
}

function respond(response: ServerResponse, status: number, body: object): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(body));
}

function respondWorkbench(response: ServerResponse): void {
  const nonce = randomBytes(16).toString("base64");
  const html = workbenchPage({ nonce });
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": workbenchCsp(nonce),
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer"
  });
  response.end(html);
}

function mintWebJwt(): string {
  if (process.env.OCR_WEB_AUTO_AUTH !== "1") {
    throw new Error("WEB_AUTO_AUTH_DISABLED");
  }

  const secret = (process.env.AUTH_JWT_SECRETS ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)[0];

  const issuer = process.env.AUTH_JWT_ISSUER ?? "";
  const audience = process.env.AUTH_JWT_AUDIENCE ?? "";
  const tenantId = process.env.OCR_WEB_TENANT_ID ?? "";
  const subjectId = process.env.OCR_WEB_SUBJECT_ID ?? "";

  if (!secret || !issuer || !audience || !tenantId || !subjectId) {
    throw new Error("WEB_AUTO_AUTH_CONFIG_REQUIRED");
  }

  const now = Math.floor(Date.now() / 1000);

  const header = {
    alg: "HS256",
    typ: "JWT"
  };

  const payload = {
    sub: subjectId,
    tenant_id: tenantId,
    organization_id: tenantId,
    iss: issuer,
    aud: audience,
    iat: now,
    exp: now + 900
  };

  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");

  const h = encode(header);
  const p = encode(payload);

  const signature = createHmac("sha256", secret)
    .update(`${h}.${p}`)
    .digest("base64url");

  return `${h}.${p}.${signature}`;
}

async function readJson(request: IncomingMessage, limit = JSON_BODY_LIMIT): Promise<Record<string, unknown>> {
  // A declared oversize body is refused before reading, so the client still receives the 413.
  if (Number(request.headers["content-length"] ?? 0) > limit) throw new Error("PAYLOAD_TOO_LARGE");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > limit) throw new Error("PAYLOAD_TOO_LARGE");
    chunks.push(buffer);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("INVALID_JSON"); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("INVALID_JSON");
  return parsed as Record<string, unknown>;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Ids are validated before any SQL cast; a malformed id is indistinguishable from a missing one. */
function uuidOr404(value: string, code: "DOCUMENT_NOT_FOUND" | "BATCH_NOT_FOUND"): string {
  if (!UUID.test(value)) throw new Error(code);
  return value.toLowerCase();
}

function intParam(value: string | null, fallback: number, min: number, max: number, code: string): number {
  if (value === null || value === "") return fallback;
  if (!/^\d{1,9}$/.test(value)) throw new Error(code);
  const parsed = Number(value);
  if (parsed < min || parsed > max) throw new Error(code);
  return parsed;
}

/** Strict `GET /api/documents` query parsing; empty parameters count as absent. */
export function parseDocumentListQuery(params: URLSearchParams): DocumentListQuery {
  const limit = intParam(params.get("limit"), 50, 1, 200, "INVALID_LIMIT");
  const offset = intParam(params.get("offset"), 0, 0, 1_000_000, "INVALID_OFFSET");
  const status = params.get("status") || undefined;
  if (status !== undefined && !(DOCUMENT_STATUS_CATEGORIES as readonly string[]).includes(status)) throw new Error("INVALID_STATUS");
  const q = params.get("q")?.trim() || undefined;
  if (q !== undefined && q.length > 100) throw new Error("INVALID_QUERY");
  const batchId = params.get("batchId") || undefined;
  return {
    limit, offset,
    ...(status !== undefined ? { status: status as DocumentStatusCategory } : {}),
    ...(q !== undefined ? { q } : {}),
    ...(batchId !== undefined ? { batchId: uuidOr404(batchId, "BATCH_NOT_FOUND") } : {})
  };
}

function parseBatchInput(body: Record<string, unknown>): { expectedTotal: number; label?: string } {
  const total = body.total;
  if (typeof total !== "number" || !Number.isInteger(total) || total < 1 || total > 500) throw new Error("INVALID_BATCH_TOTAL");
  if (body.label === undefined || body.label === null) return { expectedTotal: total };
  if (typeof body.label !== "string") throw new Error("INVALID_BATCH_LABEL");
  // Strip C0 controls (PostgreSQL text rejects NUL).
  const label = body.label.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (label.length > 200) throw new Error("INVALID_BATCH_LABEL");
  return label ? { expectedTotal: total, label } : { expectedTotal: total };
}

function parseReviewInput(body: Record<string, unknown>): { structuredResult: Record<string, unknown>; expectedUpdatedAt?: string } {
  const structuredResult = body.structuredResult;
  if (typeof structuredResult !== "object" || structuredResult === null || Array.isArray(structuredResult)) throw new Error("REVIEW_INVALID");
  const expected = body.expectedUpdatedAt;
  if (expected === undefined || expected === null) return { structuredResult: structuredResult as Record<string, unknown> };
  if (typeof expected !== "string" || !TIMESTAMP.test(expected)) throw new Error("REVIEW_INVALID");
  return { structuredResult: structuredResult as Record<string, unknown>, expectedUpdatedAt: expected };
}

/** Legacy confirm: is anything other than the confirmed field still flagged? Legacy names resolve to canonical paths. */
function hasOtherReview(view: unknown, field: string): boolean {
  const excluded = field === "therapistName" || field === "roomNo" ? [`staffOnly.${field}`] : field === "treatment" ? ["staffOnly.treatments", "staffOnly.treatment"] : [field];
  const visit = (value: unknown, path: string): boolean => {
    if (excluded.some((prefix) => path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`))) return false;
    if (Array.isArray(value)) return value.some((item, index) => visit(item, `${path}[${index}]`));
    if (!value || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    if (record.needsReview === true) return true;
    return Object.entries(record).some(([key, item]) => visit(item, path ? `${path}.${key}` : key));
  };
  return visit(view, "");
}

export function createAppServer(dependencies?: IngestDependencies | AppDependencies, options: AppServerOptions = {}) {
  const config = loadConfig();
  const principalFor = (request: IncomingMessage): Principal => options.authenticate ? options.authenticate(request) : authenticateBearer(typeof request.headers.authorization === "string" ? request.headers.authorization : undefined, config.auth.jwtSecrets, { issuer: config.auth.issuer, audience: config.auth.audience });
  const app = dependencies && "ingest" in dependencies ? dependencies : dependencies ? { ingest: dependencies } : undefined;
  const workbench = (): WorkbenchStore => { if (!app?.workbenchStore) throw new Error("WORKBENCH_NOT_CONFIGURED"); return app.workbenchStore; };

  /** Tenant always comes from the verified token (principal.tenantId); tenant headers are ignored. Returns false when no /api route matched. Throws coded errors. */
  const handleApi = async (request: IncomingMessage, response: ServerResponse, url: URL, method: string, reqId: string): Promise<boolean> => {
    const pathname = url.pathname;
    if (pathname === "/api/documents" && method === "POST") {
      if (!app) throw new Error("INGEST_NOT_CONFIGURED");
      const principal = principalFor(request);
      const batchHeader = headerValue(request.headers["x-batch-id"])?.trim();
      if (batchHeader !== undefined && !UUID.test(batchHeader)) throw new Error("INVALID_BATCH_ID");
      const batchId = batchHeader?.toLowerCase();
      const idempotencyKey = headerValue(request.headers["idempotency-key"]);
      const uploadDependencies = app.ingestForTenant ? app.ingestForTenant(principal.tenantId, idempotencyKey, batchId) : app.ingest;
      const uploaded = await handleRawUpload(request, uploadDependencies, config.limits.maxUploadBytes);
      const { stagedKey: _internalStorageKey, ...publicResult } = uploaded;
      metrics.increment("uploads_total", { status: String(uploaded.status) });
      logEvent("upload_completed", { request_id: reqId, ...("documentId" in uploaded ? { document_id: uploaded.documentId } : {}), ...(batchId ? { batch_id: batchId } : {}), tenant_id: principal.tenantId, status: uploaded.status });
      respond(response, 202, { ...publicResult, batchId: batchId ?? null });
      return true;
    }
    if (pathname === "/api/documents" && method === "GET") {
      const store = workbench();
      const principal = principalFor(request);
      const query = parseDocumentListQuery(url.searchParams);
      const listed = await store.listDocuments(principal.tenantId, query);
      respond(response, 200, { total: listed.total, limit: query.limit, offset: query.offset, documents: listed.documents });
      return true;
    }
    if (pathname === "/api/batches" && method === "POST") {
      const store = workbench();
      const principal = principalFor(request);
      const input = parseBatchInput(await readJson(request));
      respond(response, 201, await store.createBatch(principal.tenantId, { createdBy: principal.userId, ...input }));
      return true;
    }
    if (pathname === "/api/batches" && method === "GET") {
      const store = workbench();
      const principal = principalFor(request);
      const limit = intParam(url.searchParams.get("limit"), 20, 1, 100, "INVALID_LIMIT");
      respond(response, 200, { batches: await store.listBatches(principal.tenantId, limit) });
      return true;
    }
    const batchMatch = /^\/api\/batches\/([^/]+)$/.exec(pathname);
    if (batchMatch && method === "GET") {
      const store = workbench();
      const principal = principalFor(request);
      const batch = await store.getBatch(principal.tenantId, uuidOr404(batchMatch[1]!, "BATCH_NOT_FOUND"));
      if (!batch) throw new Error("BATCH_NOT_FOUND");
      respond(response, 200, batch);
      return true;
    }
    const documentMatch = /^\/api\/documents\/([^/]+)\/(content|ocr|ocr\/review|ocr\/confirm|retry)$/.exec(pathname);
    if (!documentMatch) return false;
    const action = `${method} ${documentMatch[2]!}`;
    if (action === "GET content") {
      if (!app?.reviewStore?.getOriginal || !app.storage) throw new Error("CONTENT_NOT_CONFIGURED");
      const principal = principalFor(request);
      const original = await app.reviewStore.getOriginal(principal.tenantId, uuidOr404(documentMatch[1]!, "DOCUMENT_NOT_FOUND"));
      if (!original) throw new Error("DOCUMENT_NOT_FOUND");
      let bytes: Uint8Array;
      try { bytes = await app.storage.get(original.storageKey); } catch { throw new Error("CONTENT_NOT_FOUND"); }
      response.writeHead(200, { "content-type": original.mimeType, "cache-control": "private, no-store", "x-content-type-options": "nosniff" });
      response.end(Buffer.from(bytes));
      return true;
    }
    if (action === "GET ocr") {
      if (!app?.reviewStore) throw new Error("REVIEW_NOT_CONFIGURED");
      const principal = principalFor(request);
      const document = await app.reviewStore.getReviewDocument(principal.tenantId, uuidOr404(documentMatch[1]!, "DOCUMENT_NOT_FOUND"));
      if (!document) throw new Error("DOCUMENT_NOT_FOUND");
      respond(response, 200, { document });
      return true;
    }
    if (action === "POST ocr/review") {
      const store = workbench();
      const principal = principalFor(request);
      const documentId = uuidOr404(documentMatch[1]!, "DOCUMENT_NOT_FOUND");
      const input = parseReviewInput(await readJson(request));
      const saved = await store.saveReview(principal.tenantId, documentId, { ...input, reviewedBy: principal.userId });
      logEvent("review_saved", { request_id: reqId, tenant_id: principal.tenantId, document_id: documentId, corrections: saved.corrections, delivery: saved.delivery });
      respond(response, 200, { status: "confirmed", delivery: saved.delivery, corrections: saved.corrections, document: saved.document });
      return true;
    }
    if (action === "POST retry") {
      const store = workbench();
      const principal = principalFor(request);
      const documentId = uuidOr404(documentMatch[1]!, "DOCUMENT_NOT_FOUND");
      const retried = await store.retryDocument(principal.tenantId, documentId);
      logEvent("document_retry_queued", { request_id: reqId, tenant_id: principal.tenantId, document_id: documentId, job_id: retried.jobId });
      respond(response, 202, { status: "queued", jobId: retried.jobId });
      return true;
    }
    if (action === "POST ocr/confirm") {
      if (!app?.reviewStore || !app.ocrClient) throw new Error("CONFIRM_NOT_CONFIGURED");
      const principal = principalFor(request);
      const tenantId = principal.tenantId;
      const verifiedBy = principal.userId;
      const documentId = uuidOr404(documentMatch[1]!, "DOCUMENT_NOT_FOUND");
      const body = await readJson(request);
      const field = typeof body.field === "string" ? body.field : "";
      const raw = typeof body.raw === "string" ? body.raw : "";
      const verifiedValue = typeof body.verifiedValue === "string" ? body.verifiedValue : "";
      if (!field || !verifiedValue) throw new Error("INVALID_CONFIRMATION");
      const current = await app.reviewStore.getReviewDocument(tenantId, documentId);
      if (!current?.ocrDocumentId) throw new Error("OCR_RESULT_NOT_FOUND");
      const otherReview = hasOtherReview(normalizeStructuredResult(current.structuredResult), field);
      await app.reviewStore.saveCorrection(tenantId, documentId, field, verifiedValue, "PENDING", undefined, undefined, { raw, verifiedBy });
      try {
        const providerField = field === "therapistName" ? "therapist" : field;
        await app.ocrClient.confirmResult({ documentId: current.ocrDocumentId, field: providerField, raw, verifiedValue });
        await app.reviewStore.saveCorrection(tenantId, documentId, field, verifiedValue, "SUCCEEDED", undefined, otherReview);
        respond(response, 200, { status: "confirmed" });
      } catch (error) {
        const message = error instanceof Error ? error.message : "OCR_CONFIRM_FAILED";
        await app.reviewStore.saveCorrection(tenantId, documentId, field, verifiedValue, "RETRY", message);
        respond(response, 202, { status: "saved_retry", error: "OCR_CONFIRM_UNAVAILABLE" });
      }
      return true;
    }
    return false;
  };

  return createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const startedAt = Date.now();
    const url = new URL(request.url ?? "/", "http://localhost");
    const pathname = url.pathname;
    const method = request.method ?? "UNKNOWN";


    // OCR_WEB_AUTO_TOKEN_ROUTE
    if (pathname === "/api/web-token" && request.method === "GET") {
      try {
        return respond(response, 200, {
          token: mintWebJwt(),
          expiresIn: 900
        });
      } catch {
        return respond(response, 503, {
          error: "WEB_AUTO_AUTH_UNAVAILABLE"
        });
      }
    }

    const reqId = requestId(request.headers["x-request-id"]);
    const route = routeLabel(pathname);
    response.setHeader("x-request-id", reqId);
    response.once("finish", () => {
      const duration = Date.now() - startedAt;
      metrics.increment("http_requests_total", { method, route, status: String(response.statusCode) });
      metrics.increment("http_request_duration_ms_sum", { route }, duration);
    });
    try {
      // INNOVERA_OCR_ROOT_UI: the workbench authenticates itself through /api/web-token (no token prompt).
      if (pathname === "/" && method === "GET") return respondWorkbench(response);
      if (pathname === "/metrics" && method === "GET") {
        response.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" });
        response.end(metrics.snapshot());
        return;
      }
      if (pathname === "/health/ready" && options.readiness) {
        const ready = await Promise.resolve().then(options.readiness).catch(() => false);
        if (!ready) return respond(response, 503, { status: "not_ready" });
      }
      const reviewPage = /^\/review\/([^/]+)$/.exec(pathname);
      if (reviewPage && method === "GET") {
        const documentId = uuidOr404(reviewPage[1]!, "DOCUMENT_NOT_FOUND");
        response.writeHead(302, { location: `/?document=${documentId}`, "cache-control": "no-store" });
        response.end();
        return;
      }
      if (pathname.startsWith("/api/") && await handleApi(request, response, url, method, reqId)) return;
      const result = healthResponse(pathname);
      respond(response, result.status, result.body);
      void redactLog({ requestId: reqId, status: result.status });
    } catch (error) {
      const code = errorCode(error);
      if (code === "INTERNAL_ERROR") logEvent("request_failed", { request_id: reqId, route, method, error: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
      if (response.headersSent) { response.destroy(); return; }
      respond(response, errorStatus(code), { error: code });
    }
  }).on("error", () => undefined);
}

export async function createProductionAppServer(): Promise<{ server: ReturnType<typeof createAppServer>; close: () => Promise<void> }> {
  const migrationPool = createDatabasePool(process.env.DATABASE_URL_MIGRATOR || process.env.DATABASE_URL);
  await runMigrationsWithPool(migrationPool, resolve(process.cwd(), "../../prisma/migrations"));
  await migrationPool.end();
  const pool = createDatabasePool(process.env.DATABASE_URL);
  await assertDatabaseReady(pool);
  const reviewStore = new PostgresOcrDocumentStore(pool);
  const ocrClient = OcrClient.fromConfig();
  const storage = createLocalStorage(process.env.OCR_STORAGE_ROOT ?? "/var/lib/ocr");
  const server = createAppServer({ ingest: { stage: async () => { throw new Error("TENANT_REQUIRED"); }, scan: async () => "QUARANTINED", enqueue: async () => { throw new Error("QUEUE_RUNTIME_NOT_CONFIGURED"); } }, ingestForTenant: (tenantId, idempotencyKey, batchId) => createRuntimeIngest(pool, tenantId, idempotencyKey, batchId), reviewStore, workbenchStore: reviewStore, storage, ocrClient }, { readiness: async () => { await assertDatabaseReady(pool); return clamAvHealthCheck({ host: process.env.OCR_CLAMAV_HOST ?? "clamav", port: Number(process.env.OCR_CLAMAV_PORT ?? 3310) }); } });
  return { server, close: async () => { await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())); await pool.end(); } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  createProductionAppServer().then(({ server }) => server.listen(config.port, "0.0.0.0")).catch((error: unknown) => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
}
