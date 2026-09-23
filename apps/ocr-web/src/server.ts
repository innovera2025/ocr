import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { loadConfig, loadWebConfig, redactLog, type WebConfig } from "@innovera/ocr-config";
import { handleRawUpload, type IngestDependencies } from "@innovera/ocr-ingest/http";
import { OcrClient } from "@innovera/ocr-client";
import { DOCUMENT_STATUS_CATEGORIES, legacyTreatmentIndex, normalizeStructuredResult, type DocumentStatusCategory, type DocumentView, type ReviewStore } from "@innovera/ocr-persistence";
import { assertDatabaseReady, createDatabasePool, runMigrationsWithPool } from "@innovera/ocr-db-runtime";
import { resolve } from "node:path";
import { PostgresOcrDocumentStore } from "@innovera/ocr-persistence";
import { createRuntimeIngest } from "./runtime.js";
import { workbenchPage } from "./workbench.js";
import { AuthenticationError } from "@innovera/ocr-auth";
import { AuditRateLimiter, PostgresUserStore } from "@innovera/ocr-persistence";
import {
  assertCsrfToken, assertOrigin, assertSecFetchSite, hasRight, headerValue, LoginThrottle, PASSWORD_CHANGE_ROUTES,
  PUBLIC_API_ROUTES, readJson, requiredRight, respond, sessionAuthenticator, type UserStore, type WebAuthContext
} from "./auth.js";
import { handleAuthRoutes, LOGIN_BUSY_RETRY_SECONDS, type AuthRouteDeps } from "./auth-routes.js";
import { logEvent, metrics, requestId } from "@innovera/ocr-observability";
import { clamAvHealthCheck } from "@innovera/ocr-ingest/clamav";
import type { LocalStorage } from "@innovera/ocr-storage/local";
import { createLocalStorage } from "@innovera/ocr-storage/local";

export type DocumentListQuery = { limit: number; offset: number; status?: DocumentStatusCategory; q?: string; batchId?: string; parentId?: string };

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
  userStore?: UserStore;
  storage?: LocalStorage;
  ocrClient?: OcrClient;
}>;
/** `authenticate` stays the test seam (§5 C2.4); `clock` and `loginThrottle` let the login tests drive the sliding windows. */
type AppServerOptions = Readonly<{
  readiness?: () => boolean | Promise<boolean>;
  authenticate?: (request: IncomingMessage) => WebAuthContext | Promise<WebAuthContext>;
  webConfig?: WebConfig;
  loginThrottle?: LoginThrottle;
  clock?: () => number;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUTH_ERRORS = new Set(["UNAUTHENTICATED", "AUTH_NOT_CONFIGURED", "INVALID_TOKEN", "TOKEN_EXPIRED", "INVALID_ISSUER", "INVALID_AUDIENCE",
  "INVALID_PRINCIPAL", "INVALID_CREDENTIALS", "PASSWORD_EXPIRED"]);
const FORBIDDEN_ERRORS = new Set(["CSRF_REJECTED", "FORBIDDEN", "PASSWORD_CHANGE_REQUIRED"]);
/** Every 429 carries `Retry-After`; the login route computes its own from the window that is spent. */
const THROTTLED_ERRORS: ReadonlyMap<string, number> = new Map([["LOGIN_THROTTLED", 900], ["LOGIN_BUSY", LOGIN_BUSY_RETRY_SECONDS], ["EXPORT_BUSY", 30]]);
const CONFLICT_ERRORS = new Set(["BATCH_FULL", "IDEMPOTENCY_CONFLICT", "DOCUMENT_NOT_RETRYABLE", "DOCUMENT_NOT_REVIEWABLE", "REVIEW_CONFLICT",
  "DOCUMENT_QUARANTINED", "DOCUMENT_NOT_SCANNED", "CONFIRMATION_TARGET_AMBIGUOUS", "UPLOAD_IN_PROGRESS",
  "USERNAME_TAKEN", "LAST_ADMIN", "CANNOT_CHANGE_SELF"]);
/** Originals are only served once ClamAV let them through: quarantined bytes never reach a reviewer's browser. */
const UNSERVED_CONTENT: ReadonlyMap<string, string> = new Map([["QUARANTINED", "DOCUMENT_QUARANTINED"], ["VALIDATING", "DOCUMENT_NOT_SCANNED"], ["SCANNING", "DOCUMENT_NOT_SCANNED"]]);
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}(:?\d{2})?)?$/;
/** D13: Prometheus scrapes `web:3100` directly, so a request that came through nginx-proxy is not a scrape. */
const PROXY_HEADERS = ["x-forwarded-for", "x-forwarded-host", "x-real-ip"] as const;
const EXACT_ROUTES = ["/", "/metrics", "/health/live", "/health/ready", "/api/batches", "/api/documents", "/api/auth/login",
  "/api/auth/logout", "/api/auth/session", "/api/auth/password", "/api/users", "/api/exports/preview",
  "/api/exports/documents.csv", "/api/exports/documents.jsonl"];

export function healthResponse(pathname: string): { status: number; body: { status: string } } {
  if (pathname === "/health/live") return { status: 200, body: { status: "ok" } };
  if (pathname === "/health/ready") return { status: 200, body: { status: "ready" } };
  return { status: 404, body: { status: "not_found" } };
}

/** Spec §5 status mapping, shared by every route. Codes are the `{ error }` body values. */
export function errorStatus(code: string): number {
  if (AUTH_ERRORS.has(code) || code.startsWith("AUTH_") || code.startsWith("TOKEN_")) return 401;
  if (FORBIDDEN_ERRORS.has(code)) return 403;
  if (/_NOT_FOUND(_OR_FORBIDDEN)?$/.test(code)) return 404;
  if (THROTTLED_ERRORS.has(code)) return 429;
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
  if (EXACT_ROUTES.includes(pathname)) return pathname;
  const users = /^\/api\/users\/[^/]+(\/reset-password|\/unlock)?$/.exec(pathname);
  if (users) return `/api/users/:id${users[1] ?? ""}`;
  const match = /^\/(api\/documents|api\/batches|review)\/[^/]+(\/.*)?$/.exec(pathname);
  if (!match) return "unmatched";
  const suffix = match[2] ?? "";
  return `/${match[1]}/:id${["", "/content", "/ocr", "/ocr/review", "/ocr/confirm", "/retry"].includes(suffix) ? suffix : "/*"}`;
}

export function workbenchCsp(nonce: string): string {
  return `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' blob: data:; frame-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'`;
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

/** Strict `GET /api/documents` query parsing; empty parameters count as absent. `parentId` lists the pages of one PDF. */
export function parseDocumentListQuery(params: URLSearchParams): DocumentListQuery {
  const limit = intParam(params.get("limit"), 50, 1, 200, "INVALID_LIMIT");
  const offset = intParam(params.get("offset"), 0, 0, 1_000_000, "INVALID_OFFSET");
  const status = params.get("status") || undefined;
  if (status !== undefined && !(DOCUMENT_STATUS_CATEGORIES as readonly string[]).includes(status)) throw new Error("INVALID_STATUS");
  const q = params.get("q")?.trim() || undefined;
  if (q !== undefined && (q.length > 100 || q.includes("\u0000"))) throw new Error("INVALID_QUERY");
  const batchId = params.get("batchId") || undefined;
  const parentId = params.get("parentId") || undefined;
  return {
    limit, offset,
    ...(status !== undefined ? { status: status as DocumentStatusCategory } : {}),
    ...(q !== undefined ? { q } : {}),
    ...(batchId !== undefined ? { batchId: uuidOr404(batchId, "BATCH_NOT_FOUND") } : {}),
    ...(parentId !== undefined ? { parentId: uuidOr404(parentId, "DOCUMENT_NOT_FOUND") } : {})
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

/**
 * Legacy confirm: is anything other than the confirmed field still flagged? Legacy names resolve to canonical paths; for
 * "treatment" only the item the store will confirm (`legacyTreatmentIndex`, same rule — also for the items of v2.2
 * `treatment` objects) is excluded, so other flagged treatments keep the document in review. When no single item
 * qualifies (the store then confirms a v2.2 `treatment` object as a whole) every treatment is excluded.
 */
function hasOtherReview(view: DocumentView, field: string, raw: string): boolean {
  const index = field === "treatment" ? legacyTreatmentIndex(view.staffOnly.treatments, raw) : null;
  const excluded = field === "therapistName" || field === "roomNo" ? [`staffOnly.${field}`]
    : field === "treatment" ? (index === null ? ["staffOnly.treatments", "staffOnly.treatment"] : [`staffOnly.treatments[${index}]`]) : [field];
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
  const webConfig = options.webConfig ?? loadWebConfig();
  const env = config.env;
  const clock = options.clock ?? Date.now;
  const throttle = options.loginThrottle ?? new LoginThrottle();
  const deniedAudits = new AuditRateLimiter();
  const app = dependencies && "ingest" in dependencies ? dependencies : dependencies ? { ingest: dependencies } : undefined;
  const workbench = (): WorkbenchStore => { if (!app?.workbenchStore) throw new Error("WORKBENCH_NOT_CONFIGURED"); return app.workbenchStore; };
  const users = (): UserStore => { if (!app?.userStore) throw new Error("LOGIN_NOT_CONFIGURED"); return app.userStore; };
  const authenticate = options.authenticate ?? (app?.userStore
    ? sessionAuthenticator(app.userStore, { env, idleMinutes: webConfig.sessionIdleMinutes })
    : (_request: IncomingMessage): Promise<WebAuthContext> => { throw new Error("LOGIN_NOT_CONFIGURED"); });
  // §5 C11: with hops = 0 every request carries the proxy's address, so the per-IP window would be a global switch.
  if (app?.userStore && config.trustedProxyHops < 1) logEvent("login_ip_throttle_disabled", { level: "warn", trusted_proxy_hops: config.trustedProxyHops });

  const authDeps = (traceId: string): AuthRouteDeps => ({ store: users(), webConfig, env, throttle, hops: config.trustedProxyHops, now: clock, traceId });

  /** §5 C2.7 and §4 B4: a denied request is audited once, at most 5 times per session per minute. */
  const recordDenied = (ctx: WebAuthContext, route: string, traceId: string): void => {
    logEvent("access_denied", { trace_id: traceId, user_id: ctx.userId, route });
    if (!app?.userStore) return;
    if (!deniedAudits.allow(ctx.sessionId, clock())) { metrics.increment("access_denied_suppressed_total"); return; }
    void app.userStore.recordAudit({ actorUserId: ctx.userId, sessionId: ctx.sessionId, requestId: traceId, action: "access.denied", outcome: "denied", detail: { route } })
      .catch((error: unknown) => { logEvent("audit_write_failed", { trace_id: traceId, action: "access.denied", error: error instanceof Error ? error.message.slice(0, 120) : "unknown" }); });
  };

  /**
   * §5 C2, in this order: `Sec-Fetch-Site`, `Origin`, the session, the CSRF token, the forced password change and the
   * permissions. The content type is checked by `readJson` inside each handler. Returns null for the two routes that
   * answer without a session.
   */
  const authorize = async (request: IncomingMessage, pathname: string, method: string, traceId: string): Promise<WebAuthContext | null> => {
    assertSecFetchSite(request);
    assertOrigin(request, method, env, webConfig.publicOrigin);
    if (PUBLIC_API_ROUTES.has(`${method} ${pathname}`)) return null;
    const ctx = await authenticate(request);
    assertCsrfToken(request, method, env);
    if (ctx.mustChangePassword && !PASSWORD_CHANGE_ROUTES.has(pathname)) throw new Error("PASSWORD_CHANGE_REQUIRED");
    const right = requiredRight(pathname);
    if (right !== null && !hasRight(ctx, right)) {
      recordDenied(ctx, routeLabel(pathname), traceId);
      throw new Error("FORBIDDEN");
    }
    return ctx;
  };

  /** The tenant is always `ctx.tenantId`, the configured login tenant; tenant headers stay ignored. Returns false when no /api route matched. */
  const handleApi = async (request: IncomingMessage, response: ServerResponse, url: URL, method: string, reqId: string, traceId: string, ctx: WebAuthContext): Promise<boolean> => {
    const pathname = url.pathname;
    if (pathname === "/api/documents" && method === "POST") {
      if (!app) throw new Error("INGEST_NOT_CONFIGURED");
      const batchHeader = headerValue(request.headers["x-batch-id"])?.trim();
      if (batchHeader !== undefined && !UUID.test(batchHeader)) throw new Error("INVALID_BATCH_ID");
      const batchId = batchHeader?.toLowerCase();
      const idempotencyKey = headerValue(request.headers["idempotency-key"]);
      const uploadDependencies = app.ingestForTenant ? app.ingestForTenant(ctx.tenantId, idempotencyKey, batchId) : app.ingest;
      const uploaded = await handleRawUpload(request, uploadDependencies, config.limits.maxUploadBytes);
      const { stagedKey: _internalStorageKey, ...publicResult } = uploaded;
      metrics.increment("uploads_total", { status: String(uploaded.status) });
      logEvent("upload_completed", { request_id: reqId, trace_id: traceId, user_id: ctx.userId, ...("documentId" in uploaded ? { document_id: uploaded.documentId } : {}), ...(batchId ? { batch_id: batchId } : {}), tenant_id: ctx.tenantId, status: uploaded.status });
      respond(response, 202, { ...publicResult, batchId: batchId ?? null });
      return true;
    }
    if (pathname === "/api/documents" && method === "GET") {
      const store = workbench();
      const query = parseDocumentListQuery(url.searchParams);
      const listed = await store.listDocuments(ctx.tenantId, query);
      // D8's compensating control (§13): `can_export` gates the export file, not the data, so bulk reading is metered.
      metrics.increment("documents_read_total", { kind: "listed" }, listed.documents.length);
      respond(response, 200, { total: listed.total, limit: query.limit, offset: query.offset, documents: listed.documents });
      return true;
    }
    if (pathname === "/api/batches" && method === "POST") {
      const store = workbench();
      const input = parseBatchInput(await readJson(request));
      respond(response, 201, await store.createBatch(ctx.tenantId, { createdBy: ctx.userId, ...input }));
      return true;
    }
    if (pathname === "/api/batches" && method === "GET") {
      const store = workbench();
      const limit = intParam(url.searchParams.get("limit"), 20, 1, 100, "INVALID_LIMIT");
      respond(response, 200, { batches: await store.listBatches(ctx.tenantId, limit) });
      return true;
    }
    const batchMatch = /^\/api\/batches\/([^/]+)$/.exec(pathname);
    if (batchMatch && method === "GET") {
      const store = workbench();
      const batch = await store.getBatch(ctx.tenantId, uuidOr404(batchMatch[1]!, "BATCH_NOT_FOUND"));
      if (!batch) throw new Error("BATCH_NOT_FOUND");
      respond(response, 200, batch);
      return true;
    }
    const documentMatch = /^\/api\/documents\/([^/]+)\/(content|ocr|ocr\/review|ocr\/confirm|retry)$/.exec(pathname);
    if (!documentMatch) return false;
    const action = `${method} ${documentMatch[2]!}`;
    if (action === "GET content") {
      if (!app?.reviewStore?.getOriginal || !app.storage) throw new Error("CONTENT_NOT_CONFIGURED");
      const original = await app.reviewStore.getOriginal(ctx.tenantId, uuidOr404(documentMatch[1]!, "DOCUMENT_NOT_FOUND"));
      if (!original) throw new Error("DOCUMENT_NOT_FOUND");
      const refused = UNSERVED_CONTENT.get(original.status);
      if (refused) throw new Error(refused);
      // A SPLIT PDF is hidden from the list but its original is still served (the "open the original PDF page" link).
      // A page whose render failed has no object yet.
      if (typeof original.storageKey !== "string" || !original.storageKey) throw new Error("CONTENT_NOT_FOUND");
      let bytes: Uint8Array;
      try { bytes = await app.storage.get(original.storageKey); } catch { throw new Error("CONTENT_NOT_FOUND"); }
      response.writeHead(200, { "content-type": original.mimeType, "cache-control": "private, no-store", "x-content-type-options": "nosniff" });
      response.end(Buffer.from(bytes));
      return true;
    }
    if (action === "GET ocr") {
      if (!app?.reviewStore) throw new Error("REVIEW_NOT_CONFIGURED");
      const document = await app.reviewStore.getReviewDocument(ctx.tenantId, uuidOr404(documentMatch[1]!, "DOCUMENT_NOT_FOUND"));
      if (!document) throw new Error("DOCUMENT_NOT_FOUND");
      metrics.increment("documents_read_total", { kind: "opened" });
      respond(response, 200, { document });
      return true;
    }
    if (action === "POST ocr/review") {
      const store = workbench();
      const documentId = uuidOr404(documentMatch[1]!, "DOCUMENT_NOT_FOUND");
      const input = parseReviewInput(await readJson(request));
      const saved = await store.saveReview(ctx.tenantId, documentId, { ...input, reviewedBy: ctx.userId });
      logEvent("review_saved", { request_id: reqId, trace_id: traceId, user_id: ctx.userId, tenant_id: ctx.tenantId, document_id: documentId, corrections: saved.corrections, delivery: saved.delivery });
      respond(response, 200, { status: "confirmed", delivery: saved.delivery, corrections: saved.corrections, document: saved.document });
      return true;
    }
    if (action === "POST retry") {
      const store = workbench();
      const documentId = uuidOr404(documentMatch[1]!, "DOCUMENT_NOT_FOUND");
      const retried = await store.retryDocument(ctx.tenantId, documentId);
      logEvent("document_retry_queued", { request_id: reqId, trace_id: traceId, user_id: ctx.userId, tenant_id: ctx.tenantId, document_id: documentId, job_id: retried.jobId });
      respond(response, 202, { status: "queued", jobId: retried.jobId });
      return true;
    }
    if (action === "POST ocr/confirm") {
      if (!app?.reviewStore || !app.ocrClient) throw new Error("CONFIRM_NOT_CONFIGURED");
      const tenantId = ctx.tenantId;
      const verifiedBy = ctx.userId;
      const documentId = uuidOr404(documentMatch[1]!, "DOCUMENT_NOT_FOUND");
      const body = await readJson(request);
      const field = typeof body.field === "string" ? body.field : "";
      const raw = typeof body.raw === "string" ? body.raw : "";
      const verifiedValue = typeof body.verifiedValue === "string" ? body.verifiedValue : "";
      if (!field || !verifiedValue || [field, raw, verifiedValue].some((value) => value.includes("\u0000"))) throw new Error("INVALID_CONFIRMATION");
      const current = await app.reviewStore.getReviewDocument(tenantId, documentId);
      if (!current?.ocrDocumentId) throw new Error("OCR_RESULT_NOT_FOUND");
      const otherReview = hasOtherReview(normalizeStructuredResult(current.structuredResult), field, raw);
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
    const reqId = requestId(request.headers["x-request-id"]);
    // §4 B4: `reqId` echoes the client's header, so only this server-minted id may join a log line to an audit row.
    const traceId = randomUUID();
    const route = routeLabel(pathname);
    response.setHeader("x-request-id", reqId);
    response.once("finish", () => {
      const duration = Date.now() - startedAt;
      metrics.increment("http_requests_total", { method, route, status: String(response.statusCode) });
      metrics.increment("http_request_duration_ms_sum", { route }, duration);
    });
    try {
      if (pathname === "/" && method === "GET") return respondWorkbench(response);
      if (pathname === "/metrics" && method === "GET") {
        // D13: Prometheus scrapes the container directly, so a metrics request through nginx-proxy does not exist.
        if (PROXY_HEADERS.some((header) => request.headers[header] !== undefined)) return respond(response, 404, { status: "not_found" });
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
      if (pathname.startsWith("/api/")) {
        const ctx = await authorize(request, pathname, method, traceId);
        if (pathname.startsWith("/api/auth/") || pathname === "/api/users" || pathname.startsWith("/api/users/")) {
          if (await handleAuthRoutes(request, response, pathname, method, ctx, authDeps(traceId))) return;
        }
        if (!ctx) throw new AuthenticationError("UNAUTHENTICATED");
        if (await handleApi(request, response, url, method, reqId, traceId, ctx)) return;
      }
      const result = healthResponse(pathname);
      respond(response, result.status, result.body);
      void redactLog({ requestId: reqId, status: result.status });
    } catch (error) {
      const code = errorCode(error);
      if (code === "INTERNAL_ERROR") logEvent("request_failed", { request_id: reqId, trace_id: traceId, route, method, error: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
      if (response.headersSent) { response.destroy(); return; }
      const retryAfter = THROTTLED_ERRORS.get(code);
      respond(response, errorStatus(code), { error: code }, retryAfter === undefined ? {} : { "retry-after": String(retryAfter) });
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
  const webConfig = loadWebConfig();
  const userStore = new PostgresUserStore(pool, webConfig.tenantId);
  // A missing login tenant fails startup loudly, instead of every login answering "wrong password" (§4 B5).
  await userStore.assertTenant();
  const server = createAppServer({ ingest: { stage: async () => { throw new Error("TENANT_REQUIRED"); }, scan: async () => "QUARANTINED", enqueue: async () => { throw new Error("QUEUE_RUNTIME_NOT_CONFIGURED"); } }, ingestForTenant: (tenantId, idempotencyKey, batchId) => createRuntimeIngest(pool, tenantId, idempotencyKey, batchId), reviewStore, workbenchStore: reviewStore, userStore, storage, ocrClient }, { webConfig, readiness: async () => { await assertDatabaseReady(pool); return clamAvHealthCheck({ host: process.env.OCR_CLAMAV_HOST ?? "clamav", port: Number(process.env.OCR_CLAMAV_PORT ?? 3310) }); } });
  return { server, close: async () => { await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())); await pool.end(); } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  createProductionAppServer().then(({ server }) => server.listen(config.port, "0.0.0.0")).catch((error: unknown) => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
}
