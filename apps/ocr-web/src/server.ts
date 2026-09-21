import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHmac } from "node:crypto";
import { loadConfig, redactLog } from "@innovera/ocr-config";
import { handleRawUpload, type IngestDependencies } from "@innovera/ocr-ingest/http";
import { OcrClient } from "@innovera/ocr-client";
import type { ReviewStore } from "@innovera/ocr-persistence";
import { assertDatabaseReady, createDatabasePool, runMigrationsWithPool } from "@innovera/ocr-db-runtime";
import { resolve } from "node:path";
import { PostgresOcrDocumentStore } from "@innovera/ocr-persistence";
import { createRuntimeIngest } from "./runtime.js";
import { authenticateBearer, type Principal } from "@innovera/ocr-auth";
import { logEvent, metrics, requestId } from "@innovera/ocr-observability";
import { clamAvHealthCheck } from "@innovera/ocr-ingest/clamav";
import type { LocalStorage } from "@innovera/ocr-storage/local";
import { createLocalStorage } from "@innovera/ocr-storage/local";

export type AppDependencies = Readonly<{
  ingest: IngestDependencies;
  ingestForTenant?: (tenantId: string, idempotencyKey?: string) => IngestDependencies;
  reviewStore?: ReviewStore;
  storage?: LocalStorage;
  ocrClient?: OcrClient;
}>;
type AppServerOptions = Readonly<{ readiness?: () => boolean | Promise<boolean>; authenticate?: (request: IncomingMessage) => Principal }>;

export function healthResponse(pathname: string): { status: number; body: { status: string } } {
  if (pathname === "/health/live") return { status: 200, body: { status: "ok" } };
  if (pathname === "/health/ready") return { status: 200, body: { status: "ready" } };
  return { status: 404, body: { status: "not_found" } };
}

function respond(response: ServerResponse, status: number, body: object): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
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

function respondHtml(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(html);
}

function reviewPage(documentId: string): string {
  const safeId = documentId.replace(/[^a-zA-Z0-9_-]/g, "");
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>OCR Review</title><style>body{font:16px system-ui;max-width:900px;margin:2rem auto;padding:0 1rem}img{max-width:100%;max-height:420px}table{width:100%;border-collapse:collapse}td,th{border:1px solid #ddd;padding:.5rem;text-align:left}.review{background:#fff3cd}</style></head><body><h1>OCR Review</h1><img id="original" alt="Original document" src="/api/documents/${safeId}/content"><table><thead><tr><th>Field</th><th>Raw</th><th>Value</th><th>Confidence</th><th>Status</th><th>Correction</th></tr></thead><tbody id="fields"></tbody></table><script>
const id=${JSON.stringify(safeId)};const token=prompt('Bearer token');const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const auth={authorization:'Bearer '+(token||'')};
fetch('/api/documents/'+id+'/ocr',{headers:auth}).then(r=>r.json()).then(({document})=>{const fields=document?.structuredResult||{};for(const [name,field] of Object.entries(fields)){const tr=document.createElement('tr');if(field.needsReview)tr.className='review';tr.innerHTML='<td>'+esc(name)+'</td><td>'+esc(field.raw)+'</td><td>'+esc(field.value)+'</td><td>'+esc(field.confidence)+'</td><td>'+esc(field.needsReview?'Review':'Verified')+'</td><td><input data-field="'+esc(name)+'" value="'+esc(field.value)+'"><button>Confirm</button></td>';tr.querySelector('button').onclick=()=>fetch('/api/documents/'+id+'/ocr/confirm',{method:'POST',headers:{...auth,'content-type':'application/json'},body:JSON.stringify({field:name,raw:field.raw??'',verifiedValue:tr.querySelector('input').value)}).then(()=>location.reload()));document.querySelector('#fields').append(tr)}});
</script></body></html>`;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 1_048_576) throw new Error("PAYLOAD_TOO_LARGE");
    chunks.push(buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("INVALID_JSON");
  return parsed as Record<string, unknown>;
}

export function createAppServer(dependencies?: IngestDependencies | AppDependencies, options: AppServerOptions = {}) {
  const config = loadConfig();
  const principalFor = (request: IncomingMessage): Principal => options.authenticate ? options.authenticate(request) : authenticateBearer(typeof request.headers.authorization === "string" ? request.headers.authorization : undefined, config.auth.jwtSecrets, { issuer: config.auth.issuer, audience: config.auth.audience });
  const app = dependencies && "ingest" in dependencies ? dependencies : dependencies ? { ingest: dependencies } : undefined;
  return createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const startedAt = Date.now();
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;


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

    // INNOVERA_OCR_ROOT_UI
    if (pathname === "/" && request.method === "GET") {
      return respondHtml(response, 200, `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>INNOVERA OCR</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:920px;margin:40px auto;padding:0 20px;background:#f6f7f9;color:#1f2937}
h1{margin:0 0 6px}
.sub{color:#6b7280;margin-bottom:24px}
.card{background:white;border:1px solid #e5e7eb;border-radius:14px;padding:22px;margin-top:18px}
button{border:0;border-radius:9px;padding:11px 20px;background:#111827;color:white;font-size:15px;cursor:pointer}
input[type=file]{margin:12px 0 18px}
.status{font-weight:600;margin-top:16px}
pre{white-space:pre-wrap;word-break:break-word;background:#111827;color:#e5e7eb;padding:18px;border-radius:10px;overflow:auto;min-height:100px}
</style>
</head>
<body>

<h1>INNOVERA OCR</h1>
<div class="sub">Production OCR Test</div>

<div class="card">
  <h3>Upload Document</h3>
  <input id="file" type="file" accept="image/png,image/jpeg,image/webp,application/pdf">
  <br>
  <button id="upload">Upload & OCR</button>
  <div class="status" id="status"></div>
</div>

<div class="card">
  <h3>OCR Result</h3>
  <pre id="result">ยังไม่มีผลลัพธ์</pre>
</div>

<script>
const statusEl = document.getElementById('status');
const resultEl = document.getElementById('result');

document.getElementById('upload').onclick = async () => {
  try {
    const file = document.getElementById('file').files[0];

    if (!file) {
      statusEl.textContent = 'กรุณาเลือกไฟล์';
      return;
    }

    statusEl.textContent = 'Preparing secure session...';

    const tokenResponse = await fetch('/api/web-token', {
      cache: 'no-store'
    });

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok || !tokenData.token) {
      statusEl.textContent = 'Authentication unavailable';
      resultEl.textContent = JSON.stringify(tokenData, null, 2);
      return;
    }

    const token = tokenData.token;

    statusEl.textContent = 'Uploading...';
    resultEl.textContent = '';

    const upload = await fetch('/api/documents', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Idempotency-Key': 'web-' + Date.now(),
        'Content-Type': file.type || 'application/octet-stream',
        'X-Upload-Filename': file.name
      },
      body: file
    });

    const uploaded = await upload.json();

    if (!upload.ok) {
      statusEl.textContent = 'Upload failed: HTTP ' + upload.status;
      resultEl.textContent = JSON.stringify(uploaded, null, 2);
      return;
    }

    const id = uploaded.documentId;
    statusEl.textContent = 'OCR Processing...';
    resultEl.textContent = JSON.stringify(uploaded, null, 2);

    for (let i = 0; i < 120; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000));

      const res = await fetch('/api/documents/' + id + '/ocr', {
        headers: {
          'Authorization': 'Bearer ' + token
        }
      });

      const data = await res.json();
      resultEl.textContent = JSON.stringify(data, null, 2);

      const st = data && data.document ? data.document.status : '';
      statusEl.textContent = st || 'Processing...';

      if (st === 'SUCCEEDED' || st === 'NEEDS_REVIEW' || st === 'FAILED') {
        break;
      }
    }
  } catch (err) {
    statusEl.textContent = 'Error';
    resultEl.textContent = String(err);
  }
};
</script>

</body>
</html>`);
    }

    const reqId = requestId(request.headers["x-request-id"]);
    response.setHeader("x-request-id", reqId);
    response.once("finish", () => {
      const duration = Date.now() - startedAt;
      metrics.increment("http_requests_total", { method: request.method ?? "UNKNOWN", route: pathname, status: String(response.statusCode) });
      metrics.increment("http_request_duration_ms_sum", { route: pathname }, duration);
    });
    if (pathname === "/metrics" && request.method === "GET") {
      response.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" });
      response.end(metrics.snapshot());
      return;
    }
    const result = healthResponse(pathname);
    if (pathname === "/health/ready" && options.readiness && !(await options.readiness())) return respond(response, 503, { status: "not_ready" });
    const pageMatch = /^\/review\/([^/]+)$/.exec(pathname);
    if (pageMatch && request.method === "GET") return respondHtml(response, 200, reviewPage(pageMatch[1]!));
    const contentMatch = /^\/api\/documents\/([^/]+)\/content$/.exec(pathname);
    if (contentMatch && request.method === "GET") {
      if (!app?.reviewStore?.getOriginal || !app.storage) return respond(response, 503, { error: "CONTENT_NOT_CONFIGURED" });
      try {
        const principal = principalFor(request);
        const original = await app.reviewStore.getOriginal(principal.tenantId, contentMatch[1]!);
        if (!original) return respond(response, 404, { error: "DOCUMENT_NOT_FOUND" });
        const bytes = await app.storage.get(original.storageKey);
        response.writeHead(200, { "content-type": original.mimeType, "cache-control": "private, no-store" });
        response.end(Buffer.from(bytes));
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : "CONTENT_FAILED";
        return respond(response, message.includes("AUTH") || message.includes("TOKEN") || message.includes("PRINCIPAL") ? 401 : 404, { error: message });
      }
    }
    if (request.method === "POST" && request.url?.split("?", 1)[0] === "/api/documents") {
      if (!app) return respond(response, 503, { error: "INGEST_NOT_CONFIGURED" });
      try {
        const principal = principalFor(request);
        const idempotencyKey = request.headers["idempotency-key"];
        const uploadDependencies = app.ingestForTenant ? app.ingestForTenant(principal.tenantId, Array.isArray(idempotencyKey) ? idempotencyKey[0] : idempotencyKey) : app.ingest;
        const uploaded = await handleRawUpload(request, uploadDependencies, config.limits.maxUploadBytes);
        const { stagedKey: _internalStorageKey, ...publicResult } = uploaded;
        metrics.increment("uploads_total", { status: String(uploaded.status) });
        logEvent("upload_completed", { request_id: reqId, ...(typeof uploaded === "object" && "documentId" in uploaded ? { document_id: uploaded.documentId } : {}), tenant_id: principal.tenantId, status: uploaded.status });
        return respond(response, 202, publicResult);
      } catch (error) {
        const message = error instanceof Error ? error.message : "UPLOAD_FAILED";
        const status = message.startsWith("UNAUTHENTICATED") || message.startsWith("AUTH_") || message.startsWith("INVALID_TOKEN") || message.startsWith("TOKEN_") || message.startsWith("INVALID_PRINCIPAL") ? 401 : message === "IDEMPOTENCY_CONFLICT" ? 409 : message === "PAYLOAD_TOO_LARGE" ? 413 : message === "UNSUPPORTED_MEDIA_TYPE" ? 415 : 400;
        return respond(response, status, { error: message });
      }
    }
    const reviewMatch = /^\/api\/documents\/([^/]+)\/ocr$/.exec(pathname);
    if (reviewMatch && request.method === "GET") {
      if (!app?.reviewStore) return respond(response, 503, { error: "REVIEW_NOT_CONFIGURED" });
      try {
        const document = await app.reviewStore.getReviewDocument(principalFor(request).tenantId, reviewMatch[1]!);
        return document ? respond(response, 200, { document }) : respond(response, 404, { error: "DOCUMENT_NOT_FOUND" });
      } catch (error) {
        const message = error instanceof Error ? error.message : "REVIEW_FAILED";
        return respond(response, message.includes("AUTH") || message.includes("TOKEN") || message.includes("PRINCIPAL") ? 401 : 400, { error: message });
      }
    }
    const confirmMatch = /^\/api\/documents\/([^/]+)\/ocr\/confirm$/.exec(pathname);
    if (confirmMatch && request.method === "POST") {
      if (!app?.reviewStore || !app.ocrClient) return respond(response, 503, { error: "CONFIRM_NOT_CONFIGURED" });
      try {
        const principal = principalFor(request);
        const tenantId = principal.tenantId;
        const verifiedBy = principal.userId;
        const body = await readJson(request);
        const field = typeof body.field === "string" ? body.field : "";
        const raw = typeof body.raw === "string" ? body.raw : "";
        const verifiedValue = typeof body.verifiedValue === "string" ? body.verifiedValue : "";
        if (!field || !verifiedValue) return respond(response, 400, { error: "INVALID_CONFIRMATION" });
        const current = await app.reviewStore.getReviewDocument(tenantId, confirmMatch[1]!);
        if (!current?.ocrDocumentId) return respond(response, 404, { error: "OCR_RESULT_NOT_FOUND" });
        const currentFields = current.structuredResult && typeof current.structuredResult === "object" ? current.structuredResult as Record<string, unknown> : {};
        const hasOtherReview = Object.entries(currentFields).some(([name, entry]) => {
          if (name === field) return false;
          return typeof entry === "object" && entry !== null && (entry as { needsReview?: unknown }).needsReview === true;
        });
        await app.reviewStore.saveCorrection(tenantId, confirmMatch[1]!, field, verifiedValue, "PENDING", undefined, undefined, { raw, verifiedBy });
        try {
          const providerField = field === "therapistName" ? "therapist" : field;
        await app.ocrClient.confirmResult({ documentId: current.ocrDocumentId, field: providerField, raw, verifiedValue });
          await app.reviewStore.saveCorrection(tenantId, confirmMatch[1]!, field, verifiedValue, "SUCCEEDED", undefined, hasOtherReview);
          return respond(response, 200, { status: "confirmed" });
        } catch (error) {
          const message = error instanceof Error ? error.message : "OCR_CONFIRM_FAILED";
          await app.reviewStore.saveCorrection(tenantId, confirmMatch[1]!, field, verifiedValue, "RETRY", message);
          return respond(response, 202, { status: "saved_retry", error: "OCR_CONFIRM_UNAVAILABLE" });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "CONFIRM_FAILED";
        return respond(response, message.includes("AUTH") || message.includes("TOKEN") || message.includes("PRINCIPAL") ? 401 : message === "PAYLOAD_TOO_LARGE" ? 413 : 400, { error: message });
      }
    }
    respond(response, result.status, result.body);
    void redactLog({ requestId: reqId, status: result.status });
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
  const server = createAppServer({ ingest: { stage: async () => { throw new Error("TENANT_REQUIRED"); }, scan: async () => "QUARANTINED", enqueue: async () => { throw new Error("QUEUE_RUNTIME_NOT_CONFIGURED"); } }, ingestForTenant: (tenantId, idempotencyKey) => createRuntimeIngest(pool, tenantId, idempotencyKey), reviewStore, storage, ocrClient }, { readiness: async () => { await assertDatabaseReady(pool); return clamAvHealthCheck({ host: process.env.OCR_CLAMAV_HOST ?? "clamav", port: Number(process.env.OCR_CLAMAV_PORT ?? 3310) }); } });
  return { server, close: async () => { await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())); await pool.end(); } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  createProductionAppServer().then(({ server }) => server.listen(config.port, "0.0.0.0")).catch((error: unknown) => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
}
