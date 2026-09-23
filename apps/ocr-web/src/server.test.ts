import assert from "node:assert/strict";
import { test } from "node:test";
import { createAppServer, errorStatus, routeLabel, workbenchCsp, type AppDependencies, type DocumentListQuery, type WorkbenchStore } from "./server.js";
import { csrfTokenFor, type AuthContext } from "@innovera/ocr-auth";
import type { IngestDependencies } from "@innovera/ocr-ingest";
import type { ReviewDocument } from "@innovera/ocr-persistence";

const tenant = "00000000-0000-0000-0000-000000000001";
const documentId = "00000000-0000-0000-0000-000000000002";
const otherTenant = "00000000-0000-0000-0000-000000000099";
const userId = "00000000-0000-0000-0000-000000000009";
const batchId = "10000000-0000-4000-8000-000000000001";
const failedDocumentId = "20000000-0000-4000-8000-000000000002";
const unknownId = "30000000-0000-4000-8000-000000000003";
/** The harness authenticates by a session cookie, like the real server: the token path is gone (§5 C1). */
const sessionToken = "Mp7xk2Qw9ZbF4nLc8TvRy1DgH6sJuA0eXiVoP3rYkNs";
const otherSessionToken = "Zq4TmW8yRv2LbXc7NfKj1GdHs6PuA9eYiVoM3rDkQxB";
const sessionId = "00000000-0000-4000-8000-00000000000a";
const principal = (tenantId: string): AuthContext => ({
  userId, tenantId, sessionId, username: "staff1", displayName: "พนักงาน",
  role: "staff", canExport: false, mustChangePassword: false
});
/** §6 D9: what every store call must carry. The trace id is minted per request, so `maskTrace` checks and masks it. */
const AUDIT = { actorUserId: userId, sessionId, requestId: "<trace>" } as const;
const TRACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const cookie = (token: string) => `ocr_session=${token}`;
const auth = { cookie: cookie(sessionToken), "sec-fetch-site": "same-origin", "x-csrf-token": csrfTokenFor(sessionToken) };
const otherAuth = { cookie: cookie(otherSessionToken), "sec-fetch-site": "same-origin", "x-csrf-token": csrfTokenFor(otherSessionToken) };
const reviewExtras = { batchId: null, reviewedAt: null, reviewedBy: null, reviewedByName: null, updatedAt: "2026-09-21T01:00:00.000Z", errorMessage: null, createdAt: "2026-09-21T00:59:00.000Z", processedAt: "2026-09-21T01:00:00.000Z", deliveryStatus: "NONE",
  parentDocumentId: null, pageNumber: null, pageCount: null, parentFilename: null } as const;
/** Stored views are canonical; tests may still hand the server a legacy flat shape to prove it normalizes defensively. */
const asView = (value: unknown) => value as ReviewDocument["structuredResult"];
/** §5 C2: a mutating request also needs the content type, the same-origin proof and the CSRF token. */
const jsonAuth = { ...auth, "content-type": "application/json" };

function deps(confirmFails = false) {
  const calls: string[] = [];
  const store = {
    saveOcrResult: async () => undefined,
    getReviewDocument: async (tenantId: string, id: string) => tenantId === tenant && id === documentId ? {
      documentId, tenantId, filename: "sample.png", mimeType: "image/png", status: "NEEDS_REVIEW", ocrDocumentId: "ocr-1",
      ocrEngine: "typhoon-crop-only", ocrVersion: "2.2", rawResponse: {}, structuredResult: asView({ therapistName: { raw: "พิพิ", value: "พิพิ", needsReview: true } }), needsReview: true, confirmStatus: null, ...reviewExtras
    } : null,
    saveCorrection: async (_tenantId: string, _id: string, _field: string, _value: string, status: string) => { calls.push(status); }
  };
  const app = createAppServer({
    ingest: { stage: async () => "key", scan: async () => "CLEAN", enqueue: async () => "job" },
    reviewStore: store,
    ocrClient: { confirmResult: async () => { if (confirmFails) throw new Error("network"); return { accepted: true }; } } as never
  }, { authenticate: (request): AuthContext => {
    if (request.headers.cookie !== cookie(sessionToken)) throw new Error("UNAUTHENTICATED");
    return principal(tenant);
  } });
  return { app, calls };
}

test("review endpoint enforces tenant and confirm persists before external call", async () => {
  const { app, calls } = deps();
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  const address = app.address();
  assert.equal(typeof address, "object");
  const base = `http://127.0.0.1:${(address as { port: number }).port}`;
  const unauthorized = await fetch(`${base}/api/documents/${documentId}/ocr`);
  assert.equal(unauthorized.status, 401);
  const confirmed = await fetch(`${base}/api/documents/${documentId}/ocr/confirm`, {
    method: "POST", headers: { ...jsonAuth, "x-tenant-id": "00000000-0000-0000-0000-000000000099" },
    body: JSON.stringify({ field: "therapistName", raw: "พิพิ", verifiedValue: "พีพี" })
  });
  assert.equal(confirmed.status, 200);
  assert.deepEqual(calls, ["PENDING", "SUCCEEDED"]);
  await new Promise<void>((resolve, reject) => app.close((error) => error ? reject(error) : resolve()));
});

test("confirm keeps correction when OCR confirm is unavailable", async () => {
  const { app, calls } = deps(true);
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  const address = app.address() as { port: number };
  const response = await fetch(`http://127.0.0.1:${address.port}/api/documents/${documentId}/ocr/confirm`, {
    method: "POST", headers: { ...jsonAuth, "x-tenant-id": tenant },
    body: JSON.stringify({ field: "therapistName", raw: "พิพิ", verifiedValue: "พีพี" })
  });
  assert.equal(response.status, 202);
  assert.deepEqual(calls, ["PENDING", "RETRY"]);
  await new Promise<void>((resolve, reject) => app.close((error) => error ? reject(error) : resolve()));
});

// ---- workbench API ---------------------------------------------------------------------------

type Call = { method: string; tenantId: string; args: unknown[] };
const summary = (id = batchId) => ({ batchId: id, label: "Morning", createdAt: "2026-09-21T01:00:00.000Z", expectedTotal: 3, uploaded: 1, queued: 1, processing: 0, succeeded: 0, needsReview: 0, failed: 0, confirmed: 0, completed: 0, finishedAt: null, durationMs: null, throughputPerMinute: null });
const canonical = (needsReview: { therapist?: boolean; name?: boolean } = {}) => ({
  schemaVersion: 3,
  customerInformation: { name: { raw: "Anna", value: "Anna", confidence: 0.5, source: "ocr", needsReview: needsReview.name ?? false } },
  recommendationCard: {},
  staffOnly: { treatments: [], therapistName: { raw: "พิพิ", value: "พิพิ", confidence: 0.4, source: "ocr", needsReview: needsReview.therapist ?? true }, roomNo: { raw: "1", value: "1", confidence: 0.9, source: "ocr", needsReview: false } }
});

function workbenchHarness(options: { ingest?: Partial<IngestDependencies>; storeError?: Error; readiness?: () => Promise<boolean>; structuredResult?: unknown; originalStatus?: string; originalKey?: string | null } = {}) {
  const calls: Call[] = [];
  let contentReads = 0;
  const confirmCalls: unknown[] = [];
  const corrections: unknown[][] = [];
  const ingestCalls: unknown[][] = [];
  const persisted: unknown[] = [];
  const traceIds: string[] = [];
  /**
   * §6 D9: an audit context reaching the store must name the actor and carry the request's own trace id — never the
   * client's `X-Request-Id`. The id is recorded for the attribution test and masked, so the other cases stay literal.
   */
  const maskTrace = (value: unknown): unknown => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const entry = value as Record<string, unknown>;
    if ("actorUserId" in entry) {
      traceIds.push(String(entry.requestId));
      assert.match(String(entry.requestId), TRACE_ID, "the audit context carries the server-minted trace id");
      return { ...entry, requestId: "<trace>" };
    }
    if ("audit" in entry) return { ...entry, audit: maskTrace(entry.audit) };
    return value;
  };
  const record = (method: string, tenantId: string, ...args: unknown[]) => {
    calls.push({ method, tenantId, args: args.map(maskTrace) });
    if (options.storeError) throw options.storeError;
  };
  const workbenchStore: WorkbenchStore = {
    createBatch: async (tenantId, input) => { record("createBatch", tenantId, input); return { ...summary(), expectedTotal: input.expectedTotal, label: input.label ?? null }; },
    getBatch: async (tenantId, id) => { record("getBatch", tenantId, id); return id === batchId ? summary() : null; },
    listBatches: async (tenantId, limit) => { record("listBatches", tenantId, limit); return [summary()]; },
    listDocuments: async (tenantId, query: DocumentListQuery) => { record("listDocuments", tenantId, query); return { total: 1, documents: [{ documentId, batchId, filename: "a.png", status: "NEEDS_REVIEW", statusCategory: "review" }] }; },
    retryDocument: async (tenantId, id, audit) => {
      record("retryDocument", tenantId, id, audit);
      if (id === failedDocumentId) return { jobId: "40000000-0000-4000-8000-000000000004" };
      throw new Error(id === documentId ? "DOCUMENT_NOT_RETRYABLE" : "DOCUMENT_NOT_FOUND");
    },
    saveReview: async (tenantId, id, input) => {
      record("saveReview", tenantId, id, input);
      if (id === failedDocumentId) throw new Error("DOCUMENT_NOT_REVIEWABLE");
      if (input.expectedUpdatedAt === "2026-01-01T00:00:00.000Z") throw new Error("REVIEW_CONFLICT");
      if ("invalid" in (input.structuredResult as object)) throw new Error("REVIEW_INVALID");
      return { corrections: 2, delivery: "PENDING", document: { documentId, status: "SUCCEEDED", reviewedBy: input.reviewedBy } };
    }
  };
  const reviewStore = {
    saveOcrResult: async () => undefined,
    getReviewDocument: async (tenantId: string, id: string) => {
      record("getReviewDocument", tenantId, id);
      return tenantId === tenant && id === documentId ? {
        documentId, tenantId, filename: "a.png", mimeType: "image/png", status: "NEEDS_REVIEW", ocrDocumentId: "ocr-1", ocrEngine: "typhoon-sections", ocrVersion: "3.0",
        rawResponse: {}, structuredResult: asView(options.structuredResult ?? canonical()), needsReview: true, confirmStatus: null, ...reviewExtras
      } : null;
    },
    getOriginal: async (tenantId: string, id: string) => { record("getOriginal", tenantId, id); return id === documentId ? { storageKey: options.originalKey === undefined ? "org/x/original/ab/key" : options.originalKey, mimeType: "image/png", status: options.originalStatus ?? "NEEDS_REVIEW" } : null; },
    saveCorrection: async (...args: unknown[]) => { corrections.push(args.map(maskTrace)); }
  };
  const ingest = (tenantId: string, idempotencyKey?: string, batch?: string, actor?: unknown): IngestDependencies => {
    ingestCalls.push([tenantId, idempotencyKey, batch, maskTrace(actor)]);
    return {
      stage: async () => "org/x/original/ab/key", scan: async () => "CLEAN", enqueue: async () => "unused",
      persistUpload: async (input) => { persisted.push(input.filename); return { tenantId, documentId, runId: "run-1" }; },
      updateStatus: async () => undefined,
      enqueuePersistent: async () => "job-1",
      ...options.ingest
    };
  };
  const dependencies: AppDependencies = {
    ingest: { stage: async () => { throw new Error("TENANT_REQUIRED"); }, scan: async () => "QUARANTINED", enqueue: async () => "never" },
    ingestForTenant: ingest, reviewStore, workbenchStore,
    storage: { get: async () => { contentReads += 1; return new Uint8Array([137, 80, 78, 71]); }, put: async () => undefined },
    ocrClient: { confirmResult: async (payload: unknown) => { confirmCalls.push(payload); return { accepted: true }; } } as never
  };
  const app = createAppServer(dependencies, {
    ...(options.readiness ? { readiness: options.readiness } : {}),
    authenticate: (request): AuthContext => {
      if (request.headers.cookie === cookie(sessionToken)) return principal(tenant);
      if (request.headers.cookie === cookie(otherSessionToken)) return principal(otherTenant);
      throw new Error("UNAUTHENTICATED");
    }
  });
  return { app, calls, confirmCalls, corrections, ingestCalls, persisted, traceIds, contentReads: () => contentReads };
}

async function withServer(harness: ReturnType<typeof workbenchHarness>, run: (base: string) => Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => harness.app.listen(0, "127.0.0.1", resolve));
  try { await run(`http://127.0.0.1:${(harness.app.address() as { port: number }).port}`); }
  finally { await new Promise<void>((resolve, reject) => harness.app.close((error) => error ? reject(error) : resolve())); }
}

const body = async (response: Response): Promise<Record<string, unknown>> => await response.json() as Record<string, unknown>;
async function expectError(response: Response, status: number, error: string): Promise<void> {
  assert.equal(response.status, status, `expected ${status} ${error}`);
  assert.deepEqual(await body(response), { error });
}

test("GET / serves the workbench with a fresh CSP script nonce and no token prompt", async () => {
  const h = workbenchHarness();
  await withServer(h, async (base) => {
    const nonces = new Set<string>();
    for (let index = 0; index < 2; index += 1) {
      const response = await fetch(`${base}/`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /^text\/html/);
      const csp = response.headers.get("content-security-policy") ?? "";
      const nonce = /script-src 'nonce-([A-Za-z0-9+/=]+)'/.exec(csp)?.[1] ?? "";
      assert.equal(Buffer.from(nonce, "base64").byteLength, 16);
      assert.equal(csp, workbenchCsp(nonce));
      assert.match(csp, /frame-ancestors 'none'/);
      assert.match(csp, /img-src 'self' blob: data:/);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      assert.equal(response.headers.get("cache-control"), "no-store");
      const html = await response.text();
      assert.ok(html.includes(`nonce="${nonce}"`), "inline script carries the response nonce");
      assert.doesNotMatch(html, /prompt\(/);
      nonces.add(nonce);
    }
    assert.equal(nonces.size, 2);
  });
});

test("GET /review/:id redirects to the workbench for UUIDs only", async () => {
  const h = workbenchHarness();
  await withServer(h, async (base) => {
    const redirected = await fetch(`${base}/review/${documentId.toUpperCase()}`, { redirect: "manual" });
    assert.equal(redirected.status, 302);
    assert.equal(redirected.headers.get("location"), `/?document=${documentId}`);
    await expectError(await fetch(`${base}/review/%3Cscript%3E`, { redirect: "manual" }), 404, "DOCUMENT_NOT_FOUND");
  });
});

test("every workbench API route requires a session", async () => {
  const h = workbenchHarness();
  await withServer(h, async (base) => {
    const routes: Array<[string, string]> = [
      ["POST", "/api/batches"], ["GET", "/api/batches"], ["GET", `/api/batches/${batchId}`], ["GET", "/api/documents"],
      ["POST", "/api/documents"], ["GET", `/api/documents/${documentId}/ocr`], ["GET", `/api/documents/${documentId}/content`],
      ["POST", `/api/documents/${documentId}/ocr/review`], ["POST", `/api/documents/${documentId}/retry`], ["POST", `/api/documents/${documentId}/ocr/confirm`]
    ];
    for (const [method, path] of routes) {
      const response = await fetch(`${base}${path}`, { method, headers: { "x-tenant-id": tenant, "content-type": "application/json", "sec-fetch-site": "same-origin" }, ...(method === "POST" ? { body: "{}" } : {}) });
      await expectError(response, 401, "UNAUTHENTICATED");
    }
    assert.equal(h.calls.length, 0);
    assert.equal(h.ingestCalls.length, 0);
  });
});

test("tenant comes from the token only; tenant headers are ignored", async () => {
  const h = workbenchHarness();
  await withServer(h, async (base) => {
    const spoof = { "x-tenant-id": otherTenant, "x-organization-id": otherTenant };
    assert.equal((await fetch(`${base}/api/documents`, { headers: { ...auth, ...spoof } })).status, 200);
    assert.equal((await fetch(`${base}/api/batches/${batchId}`, { headers: { ...auth, ...spoof } })).status, 200);
    assert.equal((await fetch(`${base}/api/documents/${documentId}/ocr`, { headers: { ...auth, ...spoof } })).status, 200);
    assert.deepEqual(new Set(h.calls.map((call) => call.tenantId)), new Set([tenant]));
    // A session in another tenant cannot read tenant A's document.
    await expectError(await fetch(`${base}/api/documents/${documentId}/ocr`, { headers: { ...otherAuth, "x-tenant-id": tenant } }), 404, "DOCUMENT_NOT_FOUND");
  });
});

test("batches: create, get and list", async () => {
  const h = workbenchHarness();
  await withServer(h, async (base) => {
    const created = await fetch(`${base}/api/batches`, { method: "POST", headers: jsonAuth, body: JSON.stringify({ total: 3, label: "  Morning\u0000 shift  " }) });
    assert.equal(created.status, 201);
    assert.equal((await body(created)).expectedTotal, 3);
    assert.deepEqual(h.calls[0], { method: "createBatch", tenantId: tenant, args: [{ createdBy: userId, expectedTotal: 3, label: "Morning shift", audit: AUDIT }] });
    const unlabeled = await fetch(`${base}/api/batches`, { method: "POST", headers: jsonAuth, body: JSON.stringify({ total: 500, label: "   " }) });
    assert.equal(unlabeled.status, 201);
    assert.deepEqual(h.calls[1]?.args, [{ createdBy: userId, expectedTotal: 500, audit: AUDIT }]);
    for (const total of [0, 501, 2.5, "3", null]) {
      await expectError(await fetch(`${base}/api/batches`, { method: "POST", headers: jsonAuth, body: JSON.stringify({ total }) }), 400, "INVALID_BATCH_TOTAL");
    }
    await expectError(await fetch(`${base}/api/batches`, { method: "POST", headers: jsonAuth, body: JSON.stringify({ total: 1, label: "x".repeat(201) }) }), 400, "INVALID_BATCH_LABEL");
    await expectError(await fetch(`${base}/api/batches`, { method: "POST", headers: jsonAuth, body: JSON.stringify({ total: 1, label: 7 }) }), 400, "INVALID_BATCH_LABEL");
    await expectError(await fetch(`${base}/api/batches`, { method: "POST", headers: jsonAuth, body: "{not json" }), 400, "INVALID_JSON");
    await expectError(await fetch(`${base}/api/batches`, { method: "POST", headers: jsonAuth, body: "[]" }), 400, "INVALID_JSON");

    const fetched = await fetch(`${base}/api/batches/${batchId}`, { headers: auth });
    assert.equal(fetched.status, 200);
    assert.equal((await body(fetched)).batchId, batchId);
    await expectError(await fetch(`${base}/api/batches/${unknownId}`, { headers: auth }), 404, "BATCH_NOT_FOUND");
    const before = h.calls.length;
    await expectError(await fetch(`${base}/api/batches/not-a-uuid`, { headers: auth }), 404, "BATCH_NOT_FOUND");
    await expectError(await fetch(`${base}/api/batches/${batchId}x`, { headers: auth }), 404, "BATCH_NOT_FOUND");
    assert.equal(h.calls.length, before, "invalid ids never reach the store");

    const listed = await fetch(`${base}/api/batches?limit=1`, { headers: auth });
    assert.equal(listed.status, 200);
    assert.equal(((await body(listed)).batches as unknown[]).length, 1);
    assert.deepEqual(h.calls.at(-1), { method: "listBatches", tenantId: tenant, args: [1] });
    await fetch(`${base}/api/batches`, { headers: auth });
    assert.deepEqual(h.calls.at(-1)?.args, [20]);
    await expectError(await fetch(`${base}/api/batches?limit=0`, { headers: auth }), 400, "INVALID_LIMIT");
    await expectError(await fetch(`${base}/api/batches?limit=101`, { headers: auth }), 400, "INVALID_LIMIT");
  });
});

test("documents list parses query parameters strictly", async () => {
  const h = workbenchHarness();
  await withServer(h, async (base) => {
    const defaults = await fetch(`${base}/api/documents?status=&q=`, { headers: auth });
    assert.equal(defaults.status, 200);
    assert.deepEqual(await body(defaults), { total: 1, limit: 50, offset: 0, documents: [{ documentId, batchId, filename: "a.png", status: "NEEDS_REVIEW", statusCategory: "review" }] });
    assert.deepEqual(h.calls.at(-1)?.args, [{ limit: 50, offset: 0 }]);
    const full = await fetch(`${base}/api/documents?limit=200&offset=400&status=review&q=${encodeURIComponent("  อันนา  ")}&batchId=${batchId.toUpperCase()}`, { headers: auth });
    assert.equal(full.status, 200);
    assert.deepEqual(h.calls.at(-1)?.args, [{ limit: 200, offset: 400, status: "review", q: "อันนา", batchId }]);
    assert.equal((await fetch(`${base}/api/documents?parentId=${failedDocumentId.toUpperCase()}`, { headers: auth })).status, 200);
    assert.deepEqual(h.calls.at(-1)?.args, [{ limit: 50, offset: 0, parentId: failedDocumentId }], "the pages of one PDF");
    const count = h.calls.length;
    for (const [query, status, code] of [
      ["limit=0", 400, "INVALID_LIMIT"], ["limit=201", 400, "INVALID_LIMIT"], ["limit=abc", 400, "INVALID_LIMIT"], ["limit=1.5", 400, "INVALID_LIMIT"], ["limit=-1", 400, "INVALID_LIMIT"],
      ["offset=-1", 400, "INVALID_OFFSET"], ["offset=1e3", 400, "INVALID_OFFSET"], ["offset=1000001", 400, "INVALID_OFFSET"],
      ["status=SUCCEEDED", 400, "INVALID_STATUS"], ["status=bogus", 400, "INVALID_STATUS"],
      [`q=${"a".repeat(101)}`, 400, "INVALID_QUERY"], ["batchId=nope", 404, "BATCH_NOT_FOUND"], ["batchId=1%27%20OR%201%3D1", 404, "BATCH_NOT_FOUND"],
      ["parentId=nope", 404, "DOCUMENT_NOT_FOUND"], ["status=split", 400, "INVALID_STATUS"]
    ] as const) {
      await expectError(await fetch(`${base}/api/documents?${query}`, { headers: auth }), status, code);
    }
    assert.equal(h.calls.length, count, "invalid queries never reach the store");
    for (const status of ["queued", "processing", "review", "succeeded", "confirmed", "failed"]) {
      assert.equal((await fetch(`${base}/api/documents?status=${status}`, { headers: auth })).status, 200);
    }
  });
});

test("review save: 200, conflict, validation, size limit, and bad ids", async () => {
  const h = workbenchHarness();
  await withServer(h, async (base) => {
    const url = `${base}/api/documents/${documentId}/ocr/review`;
    const edited = canonical({ therapist: false });
    const saved = await fetch(url, { method: "POST", headers: { ...jsonAuth, "x-tenant-id": otherTenant }, body: JSON.stringify({ structuredResult: edited, expectedUpdatedAt: "2026-09-21T01:02:03.456789+00:00" }) });
    assert.equal(saved.status, 200);
    assert.deepEqual(await body(saved), { status: "confirmed", delivery: "PENDING", corrections: 2, document: { documentId, status: "SUCCEEDED", reviewedBy: userId } });
    assert.deepEqual(h.calls.at(-1), { method: "saveReview", tenantId: tenant, args: [documentId, { structuredResult: edited, expectedUpdatedAt: "2026-09-21T01:02:03.456789+00:00", reviewedBy: userId, audit: AUDIT }] });
    const withoutToken = await fetch(url, { method: "POST", headers: jsonAuth, body: JSON.stringify({ structuredResult: edited, reviewedBy: "spoofed" }) });
    assert.equal(withoutToken.status, 200);
    assert.deepEqual(h.calls.at(-1)?.args[1], { structuredResult: edited, reviewedBy: userId, audit: AUDIT });

    await expectError(await fetch(url, { method: "POST", headers: jsonAuth, body: JSON.stringify({ structuredResult: edited, expectedUpdatedAt: "2026-01-01T00:00:00.000Z" }) }), 409, "REVIEW_CONFLICT");
    await expectError(await fetch(`${base}/api/documents/${failedDocumentId}/ocr/review`, { method: "POST", headers: jsonAuth, body: JSON.stringify({ structuredResult: edited }) }), 409, "DOCUMENT_NOT_REVIEWABLE");
    await expectError(await fetch(url, { method: "POST", headers: jsonAuth, body: JSON.stringify({ structuredResult: { invalid: true } }) }), 400, "REVIEW_INVALID");
    const count = h.calls.length;
    for (const payload of [{}, { structuredResult: [] }, { structuredResult: "x" }, { structuredResult: edited, expectedUpdatedAt: "yesterday" }, { structuredResult: edited, expectedUpdatedAt: 5 }]) {
      await expectError(await fetch(url, { method: "POST", headers: jsonAuth, body: JSON.stringify(payload) }), 400, "REVIEW_INVALID");
    }
    await expectError(await fetch(url, { method: "POST", headers: jsonAuth, body: "not json" }), 400, "INVALID_JSON");
    const oversize = JSON.stringify({ structuredResult: { note: "x".repeat(1_048_576) } });
    await expectError(await fetch(url, { method: "POST", headers: jsonAuth, body: oversize }), 413, "PAYLOAD_TOO_LARGE");
    await expectError(await fetch(`${base}/api/documents/123/ocr/review`, { method: "POST", headers: jsonAuth, body: JSON.stringify({ structuredResult: edited }) }), 404, "DOCUMENT_NOT_FOUND");
    assert.equal(h.calls.length, count, "rejected requests never reach the store");
  });
});

test("retry: 202 queued, 409 when not failed, 404 for unknown or malformed ids", async () => {
  const h = workbenchHarness();
  await withServer(h, async (base) => {
    const retried = await fetch(`${base}/api/documents/${failedDocumentId}/retry`, { method: "POST", headers: auth });
    assert.equal(retried.status, 202);
    assert.deepEqual(await body(retried), { status: "queued", jobId: "40000000-0000-4000-8000-000000000004" });
    assert.deepEqual(h.calls.at(-1), { method: "retryDocument", tenantId: tenant, args: [failedDocumentId, AUDIT] });
    await expectError(await fetch(`${base}/api/documents/${documentId}/retry`, { method: "POST", headers: auth }), 409, "DOCUMENT_NOT_RETRYABLE");
    await expectError(await fetch(`${base}/api/documents/${unknownId}/retry`, { method: "POST", headers: auth }), 404, "DOCUMENT_NOT_FOUND");
    const count = h.calls.length;
    await expectError(await fetch(`${base}/api/documents/..%2F..%2Fetc/retry`, { method: "POST", headers: auth }), 404, "DOCUMENT_NOT_FOUND");
    assert.equal(h.calls.length, count);
  });
});

test("attribution: upload, batch, review, confirm and retry name the session's user, with the server's trace id", async () => {
  const h = workbenchHarness({ structuredResult: canonical({ therapist: true }) });
  await withServer(h, async (base) => {
    // §4 B4: `X-Request-Id` is the client's and is echoed back, but only the server-minted trace id reaches a store call.
    const forged = { "x-request-id": "forged-by-the-client" };
    const uploaded = await fetch(`${base}/api/documents`, { method: "POST", headers: { ...auth, ...forged, "content-type": "image/png", "x-upload-filename": "a.png" }, body: new Uint8Array([137, 80, 78, 71]) });
    assert.equal(uploaded.status, 202);
    assert.equal(uploaded.headers.get("x-request-id"), "forged-by-the-client", "the client's id is still echoed");
    assert.deepEqual(h.ingestCalls.at(-1), [tenant, undefined, undefined, AUDIT]);

    assert.equal((await fetch(`${base}/api/batches`, { method: "POST", headers: { ...jsonAuth, ...forged }, body: JSON.stringify({ total: 1 }) })).status, 201);
    assert.deepEqual(h.calls.at(-1)?.args, [{ createdBy: userId, expectedTotal: 1, audit: AUDIT }]);

    const reviewed = await fetch(`${base}/api/documents/${documentId}/ocr/review`, { method: "POST", headers: { ...jsonAuth, ...forged }, body: JSON.stringify({ structuredResult: canonical({ therapist: false }), reviewedBy: "spoofed" }) });
    assert.equal(reviewed.status, 200);
    assert.deepEqual((h.calls.at(-1)?.args[1] as { reviewedBy: string; audit: unknown }), { structuredResult: canonical({ therapist: false }), reviewedBy: userId, audit: AUDIT });

    const confirmed = await fetch(`${base}/api/documents/${documentId}/ocr/confirm`, { method: "POST", headers: { ...jsonAuth, ...forged }, body: JSON.stringify({ field: "therapistName", raw: "พิพิ", verifiedValue: "พีพี" }) });
    assert.equal(confirmed.status, 200);
    assert.deepEqual(h.corrections[0]?.[7], { raw: "พิพิ", verifiedBy: userId, audit: AUDIT }, "the PENDING call names the actor and writes document.field_confirmed");
    assert.equal(h.corrections[1]?.[7], undefined, "the status-only calls of the same confirmation write no second audit row");

    assert.equal((await fetch(`${base}/api/documents/${failedDocumentId}/retry`, { method: "POST", headers: { ...auth, ...forged } })).status, 202);
    assert.deepEqual(h.calls.at(-1)?.args, [failedDocumentId, AUDIT]);

    assert.equal(h.traceIds.length, 5, "one audit context per action: upload, batch, review, confirm, retry");
    assert.equal(new Set(h.traceIds).size, 5, "each request mints its own trace id");
    assert.equal(h.traceIds.includes("forged-by-the-client"), false);
  });
});

test("document read routes reject malformed ids before the store", async () => {
  const h = workbenchHarness();
  await withServer(h, async (base) => {
    await expectError(await fetch(`${base}/api/documents/not-a-uuid/ocr`, { headers: auth }), 404, "DOCUMENT_NOT_FOUND");
    await expectError(await fetch(`${base}/api/documents/not-a-uuid/content`, { headers: auth }), 404, "DOCUMENT_NOT_FOUND");
    await expectError(await fetch(`${base}/api/documents/not-a-uuid/ocr/confirm`, { method: "POST", headers: jsonAuth, body: "{}" }), 404, "DOCUMENT_NOT_FOUND");
    assert.equal(h.calls.length, 0);
    const content = await fetch(`${base}/api/documents/${documentId}/content`, { headers: auth });
    assert.equal(content.status, 200);
    assert.equal(content.headers.get("content-type"), "image/png");
    assert.deepEqual([...new Uint8Array(await content.arrayBuffer())], [137, 80, 78, 71]);
    const review = await fetch(`${base}/api/documents/${documentId}/ocr`, { headers: auth });
    assert.equal(review.status, 200);
    assert.equal(((await body(review)).document as { documentId: string }).documentId, documentId);
  });
});

test("legacy confirm maps therapistName to therapist and resolves the canonical path", async () => {
  const h = workbenchHarness({ structuredResult: canonical({ therapist: true, name: true }) });
  await withServer(h, async (base) => {
    const response = await fetch(`${base}/api/documents/${documentId}/ocr/confirm`, { method: "POST", headers: jsonAuth, body: JSON.stringify({ field: "therapistName", raw: "พิพิ", verifiedValue: "พีพี" }) });
    assert.equal(response.status, 200);
    assert.deepEqual(await body(response), { status: "confirmed" });
    assert.deepEqual(h.confirmCalls, [{ documentId: "ocr-1", field: "therapist", raw: "พิพิ", verifiedValue: "พีพี" }]);
    assert.deepEqual(h.corrections.map((call) => call[4]), ["PENDING", "SUCCEEDED"]);
    assert.deepEqual(h.corrections[0]?.slice(0, 4), [tenant, documentId, "therapistName", "พีพี"]);
    assert.equal(h.corrections[1]?.[6], true, "customerInformation.name still needs review");
    await expectError(await fetch(`${base}/api/documents/${documentId}/ocr/confirm`, { method: "POST", headers: jsonAuth, body: JSON.stringify({ field: "therapistName" }) }), 400, "INVALID_CONFIRMATION");
  });
  const onlyTherapist = workbenchHarness({ structuredResult: { staffOnly: { treatment: { raw: "x", needsReview: false }, therapistName: { raw: "พิพิ", value: "พิพิ", needsReview: true } } } });
  await withServer(onlyTherapist, async (base) => {
    assert.equal((await fetch(`${base}/api/documents/${documentId}/ocr/confirm`, { method: "POST", headers: jsonAuth, body: JSON.stringify({ field: "therapistName", raw: "พิพิ", verifiedValue: "พีพี" }) })).status, 200);
    assert.equal(onlyTherapist.corrections[1]?.[6], false, "nothing else is flagged");
  });
});

test("upload threads the batch id and decodes URI-encoded filenames", async () => {
  const h = workbenchHarness();
  await withServer(h, async (base) => {
    const name = "ใบลงทะเบียน 01.png";
    const upload = (headers: Record<string, string>) => fetch(`${base}/api/documents`, { method: "POST", headers: { ...auth, "content-type": "image/png", "idempotency-key": "file-1", "x-upload-filename": encodeURIComponent(name), "x-upload-filename-encoding": "uri", ...headers }, body: new Uint8Array([137, 80, 78, 71]) });
    const response = await upload({ "x-batch-id": batchId.toUpperCase(), "x-tenant-id": otherTenant });
    assert.equal(response.status, 202);
    const result = await body(response);
    assert.equal(result.batchId, batchId);
    assert.equal(result.documentId, documentId);
    assert.equal(result.jobId, "job-1");
    assert.equal("stagedKey" in result, false);
    assert.deepEqual(h.ingestCalls, [[tenant, "file-1", batchId, AUDIT]]);
    assert.deepEqual(h.persisted, [name]);
    const unbatched = await upload({});
    assert.equal(unbatched.status, 202);
    assert.equal((await body(unbatched)).batchId, null);
    assert.deepEqual(h.ingestCalls.at(-1), [tenant, "file-1", undefined, AUDIT]);
    await expectError(await upload({ "x-batch-id": "batch-1" }), 400, "INVALID_BATCH_ID");
    await expectError(await upload({ "x-upload-filename": "bad%E0%A4%A.png" }), 400, "INVALID_UPLOAD_HEADERS");
    await expectError(await upload({ "content-type": "text/html" }), 415, "UNSUPPORTED_MEDIA_TYPE");
    for (const office of ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]) {
      await expectError(await upload({ "content-type": office }), 415, "UNSUPPORTED_MEDIA_TYPE");
    }
  });
  for (const [error, status] of [["BATCH_FULL", 409], ["BATCH_NOT_FOUND", 404], ["IDEMPOTENCY_CONFLICT", 409]] as const) {
    const failing = workbenchHarness({ ingest: { persistUpload: async () => { throw new Error(error); } } });
    await withServer(failing, async (base) => {
      const response = await fetch(`${base}/api/documents`, { method: "POST", headers: { ...auth, "content-type": "image/png", "x-upload-filename": "a.png", "x-batch-id": batchId }, body: new Uint8Array([1]) });
      await expectError(response, status, error);
    });
  }
});

test("internal errors are not leaked and readiness failures are 503", async () => {
  const h = workbenchHarness({ storeError: new Error("relation \"documents\" does not exist"), readiness: async () => { throw new Error("connect ECONNREFUSED"); } });
  await withServer(h, async (base) => {
    await expectError(await fetch(`${base}/api/documents`, { headers: auth }), 500, "INTERNAL_ERROR");
    const ready = await fetch(`${base}/health/ready`);
    assert.equal(ready.status, 503);
    assert.deepEqual(await body(ready), { status: "not_ready" });
    assert.equal((await fetch(`${base}/health/live`)).status, 200);
  });
});

test("workbench routes answer 503 when the store is not configured", async () => {
  const { app } = deps();
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
    await expectError(await fetch(`${base}/api/documents`, { headers: auth }), 503, "WORKBENCH_NOT_CONFIGURED");
  } finally { await new Promise<void>((resolve, reject) => app.close((error) => error ? reject(error) : resolve())); }
});

test("metrics use templated routes", async () => {
  const h = workbenchHarness();
  await withServer(h, async (base) => {
    await fetch(`${base}/api/documents/${documentId}/ocr`, { headers: auth });
    await fetch(`${base}/random/${unknownId}`);
    const snapshot = await (await fetch(`${base}/metrics`)).text();
    assert.match(snapshot, /route="\/api\/documents\/:id\/ocr"/);
    assert.doesNotMatch(snapshot, new RegExp(unknownId));
    assert.doesNotMatch(snapshot, new RegExp(`route="[^"]*${documentId}`));
  });
  assert.equal(routeLabel("/api/documents/abc/unknown/x"), "/api/documents/:id/*");
  assert.equal(routeLabel("/wp-admin"), "unmatched");
});

test("error codes map to spec statuses", () => {
  assert.equal(errorStatus("UNAUTHENTICATED"), 401);
  assert.equal(errorStatus("INVALID_AUDIENCE"), 401);
  assert.equal(errorStatus("DOCUMENT_NOT_FOUND"), 404);
  assert.equal(errorStatus("DOCUMENT_NOT_FOUND_OR_FORBIDDEN"), 404);
  assert.equal(errorStatus("BATCH_NOT_FOUND"), 404);
  for (const code of ["BATCH_FULL", "IDEMPOTENCY_CONFLICT", "DOCUMENT_NOT_RETRYABLE", "DOCUMENT_NOT_REVIEWABLE", "REVIEW_CONFLICT",
    "DOCUMENT_QUARANTINED", "DOCUMENT_NOT_SCANNED", "CONFIRMATION_TARGET_AMBIGUOUS", "UPLOAD_IN_PROGRESS"]) assert.equal(errorStatus(code), 409);
  assert.equal(errorStatus("PAYLOAD_TOO_LARGE"), 413);
  assert.equal(errorStatus("UNSUPPORTED_MEDIA_TYPE"), 415);
  assert.equal(errorStatus("REVIEW_INVALID"), 400);
  assert.equal(errorStatus("INVALID_UPLOAD_HEADERS"), 400);
  assert.equal(errorStatus("CONTENT_NOT_CONFIGURED"), 503);
  assert.equal(errorStatus("INTERNAL_ERROR"), 500);
});

test("originals are never served before a clean scan: quarantined and unscanned content is refused", async () => {
  for (const [status, error] of [["QUARANTINED", "DOCUMENT_QUARANTINED"], ["SCANNING", "DOCUMENT_NOT_SCANNED"], ["VALIDATING", "DOCUMENT_NOT_SCANNED"]] as const) {
    const h = workbenchHarness({ originalStatus: status });
    await withServer(h, async (base) => {
      await expectError(await fetch(`${base}/api/documents/${documentId}/content`, { headers: auth }), 409, error);
      assert.equal(h.contentReads(), 0, `${status}: the stored bytes are not even read`);
    });
  }
  for (const status of ["CLEAN", "FAILED", "SUCCEEDED", "SPLIT"]) {
    const h = workbenchHarness({ originalStatus: status });
    await withServer(h, async (base) => {
      assert.equal((await fetch(`${base}/api/documents/${documentId}/content`, { headers: auth })).status, 200, `${status} (a SPLIT PDF is hidden from the list, its original is still served)`);
    });
  }
  const unrendered = workbenchHarness({ originalStatus: "FAILED", originalKey: null });
  await withServer(unrendered, async (base) => {
    await expectError(await fetch(`${base}/api/documents/${documentId}/content`, { headers: auth }), 404, "CONTENT_NOT_FOUND");
    assert.equal(unrendered.contentReads(), 0, "a page whose render failed has no object");
  });
});

test("NUL characters are client errors, not database 500s", async () => {
  const h = workbenchHarness();
  await withServer(h, async (base) => {
    const before = h.calls.length;
    await expectError(await fetch(`${base}/api/documents?q=${encodeURIComponent("a\u0000b")}`, { headers: auth }), 400, "INVALID_QUERY");
    assert.equal(h.calls.length, before);
    for (const payload of [{ field: "therapistName", raw: "พิพิ", verifiedValue: "พี\u0000พี" }, { field: "therapistName", raw: "\u0000", verifiedValue: "พีพี" }, { field: "therapist\u0000Name", raw: "x", verifiedValue: "พีพี" }]) {
      await expectError(await fetch(`${base}/api/documents/${documentId}/ocr/confirm`, { method: "POST", headers: jsonAuth, body: JSON.stringify(payload) }), 400, "INVALID_CONFIRMATION");
    }
    assert.deepEqual(h.corrections, []);
  });
});

test("legacy confirm of one treatment keeps the document in review while another treatment is flagged", async () => {
  const view = canonical({ therapist: false });
  const item = (nameRaw: string, needsReview: boolean) => ({ raw: `${nameRaw} 60 นาที`, nameRaw, value: null, duration: "60 นาที", durationMinutes: 60, confidence: 0.4, source: "master-fuzzy", needsReview });
  const twoFlagged = { ...view, staffOnly: { ...view.staffOnly, treatments: [item("ฟุต", true), item("หน้า", true)] } };
  const h = workbenchHarness({ structuredResult: twoFlagged });
  await withServer(h, async (base) => {
    const confirm = (raw: string) => fetch(`${base}/api/documents/${documentId}/ocr/confirm`, { method: "POST", headers: jsonAuth, body: JSON.stringify({ field: "treatment", raw, verifiedValue: "นวดเท้า" }) });
    assert.equal((await confirm("ฟุต")).status, 200);
    assert.deepEqual(h.corrections.map((call) => call[4]), ["PENDING", "SUCCEEDED"]);
    assert.equal(h.corrections[1]?.[6], true, "staffOnly.treatments[1] is still flagged");
  });
  const oneFlagged = workbenchHarness({ structuredResult: { ...view, staffOnly: { ...view.staffOnly, treatments: [item("ไทย", false), item("ฟุต", true)] } } });
  await withServer(oneFlagged, async (base) => {
    assert.equal((await fetch(`${base}/api/documents/${documentId}/ocr/confirm`, { method: "POST", headers: jsonAuth, body: JSON.stringify({ field: "treatment", raw: "ฟุต", verifiedValue: "นวดเท้า" }) })).status, 200);
    assert.equal(oneFlagged.corrections[1]?.[6], false, "the confirmed item was the only flagged field");
  });
});
