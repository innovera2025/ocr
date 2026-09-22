import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import type { OcrResponse } from "@innovera/ocr-client";
import type { PageDocumentInput, WorkerDocument } from "@innovera/ocr-persistence";
import { parseOriginalKey } from "@innovera/ocr-storage";
import { inflateSync, crc32 } from "node:zlib";
import { childPublicId, childStorageKey, isSplitTarget, ocrUploadName, pageFormat, parsePdfInfo, pdfPageLimit, PdfSplitError, pngFromPpm, runWorkerOnce, splitPdf, validatePayload,
  type FinishOutcome, type PdfInfo, type PdfRenderer } from "./index.js";

const tenant = "00000000-0000-4000-8000-000000000001";
const parentId = "00000000-0000-4000-8000-0000000000aa";
const parentKey = `org/${tenant}/original/ab/${"ab".repeat(16)}`;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const parent = (extra: Partial<WorkerDocument> = {}): WorkerDocument => ({ documentId: parentId, organizationId: tenant, sourceKey: parentKey, filename: "intake.pdf",
  mimeType: "application/pdf", status: "CLEAN", batchId: null, parentDocumentId: null, pageNumber: null, pageCount: null, createdAt: "2026-09-22T01:00:00.000Z", parentSourceKey: null, ...extra });
const child = (pageNumber: number, extra: Partial<WorkerDocument> = {}): WorkerDocument => ({ ...parent(), documentId: `00000000-0000-4000-8000-00000000${String(pageNumber).padStart(4, "0")}`,
  sourceKey: childStorageKey(tenant, parentId, pageNumber), mimeType: "image/png", parentDocumentId: parentId, pageNumber, pageCount: 25, parentSourceKey: parentKey, ...extra });

/** Renders page n as a tiny PNG whose last byte is n; `fail` lists ranges ("11-20") and single pages ("15") that fail. */
function fakeRenderer(info: Partial<PdfInfo> | Error = {}, fail: readonly string[] = []) {
  const calls: string[] = [];
  const renderer: PdfRenderer = {
    format: "png",
    inspect: async () => { if (info instanceof Error) throw info; return { pages: 25, encrypted: false, largestSidePt: 842, ...info }; },
    renderRange: async (_pdf, first, last, outDir) => {
      const range = first === last ? `${first}` : `${first}-${last}`;
      calls.push(range);
      if (fail.includes(range)) throw new PdfSplitError("PDF_RENDER_FAILED", `pages ${range} failed`, true);
      await mkdir(outDir, { recursive: true });
      const pages = Array.from({ length: last - first + 1 }, (_, index) => first + index).filter((page) => !(first !== last && fail.includes(String(page))));
      for (const page of pages) await writeFile(join(outDir, `page-${String(page).padStart(2, "0")}.png`), new Uint8Array([...PNG, page]));
      return pages.map((pageNumber) => ({ pageNumber, path: join(outDir, `page-${String(pageNumber).padStart(2, "0")}.png`) }));
    }
  };
  return { renderer, calls };
}

function memoryStorage(initial: Record<string, Uint8Array> = { [parentKey]: new Uint8Array([0x25, 0x50, 0x44, 0x46]) }) {
  const objects = new Map(Object.entries(initial));
  return {
    objects,
    put: async (key: string, bytes: Uint8Array) => { objects.set(key, bytes); },
    get: async (key: string) => { const bytes = objects.get(key); if (!bytes) throw Object.assign(new Error(`ENOENT: ${key}`), { code: "ENOENT" }); return bytes; }
  };
}

function memoryStore(existing: number[] = []) {
  const pages = new Map<number, PageDocumentInput>(existing.map((pageNumber) => [pageNumber, { pageNumber, publicId: childPublicId(parentId, pageNumber), storageKey: "x", mimeType: "image/png", sizeBytes: 1, contentHash: "h" }]));
  const calls: string[] = [];
  const chunks: number[][] = [];
  return {
    pages, calls, chunks,
    setPageCount: async (_tenant: string, _id: string, count: number) => { calls.push(`setPageCount:${count}`); },
    existingPages: async () => [...pages.keys()].sort((a, b) => a - b),
    createPageDocuments: async (tenantId: string, id: string, pageCount: number, inputs: readonly PageDocumentInput[]) => {
      assert.deepEqual([tenantId, id], [tenant, parentId]);
      chunks.push(inputs.map((input) => input.pageNumber));
      const created: number[] = [], already: number[] = [];
      for (const input of inputs) {
        assert.ok(input.pageNumber >= 1 && input.pageNumber <= pageCount);
        if (pages.has(input.pageNumber)) already.push(input.pageNumber); else { pages.set(input.pageNumber, input); created.push(input.pageNumber); }
      }
      return { created, existing: already };
    },
    markSplit: async (_tenant: string, _id: string, count: number) => { if (pages.size < count) throw new Error("SPLIT_INCOMPLETE"); calls.push(`markSplit:${count}`); },
    setPageObject: async (_tenant: string, id: string, key: string, size: number) => { calls.push(`setPageObject:${id}:${key}:${size}`); }
  };
}

async function scratch(): Promise<string> { return mkdtemp(join(tmpdir(), "ocr-split-test-")); }

test("ocrUploadName: pages go out as page-NNNN.<ext of their MIME>, uploads keep a matching name", () => {
  assert.equal(ocrUploadName({ filename: "intake.pdf", mimeType: "image/png", pageNumber: 12 }), "page-0012.png", "never the parent's .pdf name");
  assert.equal(ocrUploadName({ filename: "intake.pdf", mimeType: "image/jpeg", pageNumber: 3 }), "page-0003.jpg");
  assert.equal(ocrUploadName({ filename: "scan.PNG", mimeType: "image/png" }), "scan.PNG");
  assert.equal(ocrUploadName({ filename: "a.jpeg", mimeType: "image/jpeg" }), "a.jpeg");
  assert.equal(ocrUploadName({ filename: "scan.pdf", mimeType: "image/png" }), "scan.png");
  assert.equal(ocrUploadName({ filename: "photo", mimeType: "image/jpeg" }), "photo.jpg");
  assert.equal(ocrUploadName({ filename: "ใบลงทะเบียน.webp", mimeType: "image/webp", pageNumber: null }), "ใบลงทะเบียน.webp");
  assert.equal(ocrUploadName({ filename: " ", mimeType: "image/png" }), "document.png");
  assert.equal(ocrUploadName({ filename: "x.bin", mimeType: "application/octet-stream" }), "x.bin");
});

test("page storage keys are deterministic, follow the original-key grammar and pass the worker's tenant check", () => {
  const key = childStorageKey(tenant, parentId, 12);
  assert.equal(key, childStorageKey(tenant, parentId, 12));
  assert.notEqual(key, childStorageKey(tenant, parentId, 13));
  assert.notEqual(key, childStorageKey(tenant, "00000000-0000-4000-8000-0000000000bb", 12));
  assert.deepEqual(parseOriginalKey(key), { organizationId: tenant, documentPublicId: childPublicId(parentId, 12), raw: key });
  assert.match(childPublicId(parentId, 12), /^[0-9a-f]{32}$/);
  assert.doesNotThrow(() => validatePayload({ schemaVersion: 1, documentId: "d", organizationId: tenant, sourceKey: key }));
});

test("dispatch: a top-level PDF that is queued or being split (also a legacy row) is split; pages, images and finished rows are not", () => {
  assert.equal(isSplitTarget(parent()), true);
  assert.equal(isSplitTarget(parent({ status: "PROCESSING" })), true, "resumed after a lost lease");
  assert.equal(isSplitTarget(parent({ mimeType: "APPLICATION/PDF", pageCount: null })), true, "legacy PDF without page_count, retried");
  assert.equal(isSplitTarget(child(3)), false);
  assert.equal(isSplitTarget(parent({ status: "FAILED" })), false);
  assert.equal(isSplitTarget(parent({ status: "SPLIT" })), false);
  assert.equal(isSplitTarget(parent({ mimeType: "image/png" })), false);
});

test("OCR_MAX_PDF_PAGES (default 300, 1..1000) and OCR_PAGE_FORMAT (png unless jpeg)", () => {
  assert.deepEqual([undefined, "", "abc", "2.5", "0", "301", "5000"].map(pdfPageLimit), [300, 300, 300, 300, 1, 301, 1000]);
  assert.deepEqual([undefined, "png", "JPEG", "webp"].map(pageFormat), ["png", "png", "jpeg", "png"]);
});

test("pdfinfo output: page count, encryption flag and the largest page side", () => {
  const out = "Producer:  scanner\nEncrypted:       no\nPage    1 size:  832 x 590 pts\nPage    1 rot:   0\nPage    2 size:  590.5 x 832 pts\nPages:           2\n";
  assert.deepEqual(parsePdfInfo(out), { pages: 2, encrypted: false, largestSidePt: 832 });
  assert.deepEqual(parsePdfInfo("Pages: 1\nEncrypted: yes (print:yes copy:no)\nPage size: 20000 x 20000 pts\n"), { pages: 1, encrypted: true, largestSidePt: 20000 });
  assert.throws(() => parsePdfInfo("Syntax Error: broken"), (error: unknown) => error instanceof PdfSplitError && error.code === "PDF_RENDER_FAILED" && !error.retryable);
});

test("split: pages are rendered and created in chunks of 10 (one transaction each), stored under deterministic keys, then the parent is SPLIT", async () => {
  const tmpRoot = await scratch();
  try {
    const { renderer, calls } = fakeRenderer();
    const store = memoryStore();
    const storage = memoryStorage();
    const result = await splitPdf({ store, storage, renderer, tmpRoot, maxPages: 300 }, "job-1", parent());
    assert.deepEqual(calls, ["1-10", "11-20", "21-25"]);
    assert.deepEqual(store.chunks, [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [11, 12, 13, 14, 15, 16, 17, 18, 19, 20], [21, 22, 23, 24, 25]]);
    assert.deepEqual(store.calls, ["setPageCount:25", "markSplit:25"]);
    assert.deepEqual([result.pageCount, result.created, result.existing, result.failedPages], [25, 25, 0, []]);
    const page12 = store.pages.get(12)!;
    assert.deepEqual([page12.storageKey, page12.publicId, page12.mimeType, page12.sizeBytes], [childStorageKey(tenant, parentId, 12), childPublicId(parentId, 12), "image/png", 9]);
    assert.match(page12.contentHash ?? "", /^[0-9a-f]{64}$/);
    assert.deepEqual([...storage.objects.get(childStorageKey(tenant, parentId, 12))!], [...PNG, 12]);
    assert.deepEqual(await readdir(tmpRoot), [], "the scratch directory is removed");
  } finally { await rm(tmpRoot, { recursive: true, force: true }); }
});

test("split resume: pages that already exist are neither rendered nor created again", async () => {
  const tmpRoot = await scratch();
  try {
    const { renderer, calls } = fakeRenderer();
    const store = memoryStore([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 21]);
    const result = await splitPdf({ store, storage: memoryStorage(), renderer, tmpRoot, maxPages: 300 }, "job-2", parent({ status: "PROCESSING" }));
    assert.deepEqual(calls, ["13-20", "22-25"]);
    assert.deepEqual(store.chunks, [[13, 14, 15, 16, 17, 18, 19, 20], [22, 23, 24, 25]]);
    assert.deepEqual([result.created, result.existing], [12, 13]);
    assert.equal(store.pages.size, 25);
  } finally { await rm(tmpRoot, { recursive: true, force: true }); }
});

test("split: a chunk that fails is retried page by page; a page that never renders gets a FAILED row (no object, no job)", async () => {
  const tmpRoot = await scratch();
  try {
    const { renderer, calls } = fakeRenderer({}, ["11-20", "15", "23"]);
    const store = memoryStore();
    const storage = memoryStorage();
    const result = await splitPdf({ store, storage, renderer, tmpRoot, maxPages: 300 }, "job-3", parent());
    assert.deepEqual(calls, ["1-10", "11-20", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20", "21-25", "23"]);
    assert.deepEqual(result.failedPages, [15, 23]);
    assert.deepEqual(store.pages.get(15), { pageNumber: 15, publicId: childPublicId(parentId, 15), storageKey: null, mimeType: "image/png", sizeBytes: null, contentHash: null });
    assert.equal(storage.objects.has(childStorageKey(tenant, parentId, 15)), false);
    assert.equal(store.pages.get(16)?.storageKey, childStorageKey(tenant, parentId, 16));
    assert.deepEqual(store.calls.at(-1), "markSplit:25", "every page 1..N has a row");
  } finally { await rm(tmpRoot, { recursive: true, force: true }); }
});

test("split refuses encrypted, oversized, empty and too long PDFs before creating anything", async () => {
  const cases: Array<[Partial<PdfInfo> | Error, string]> = [
    [new PdfSplitError("PDF_ENCRYPTED", "a password is required to open it"), "PDF_ENCRYPTED: a password is required to open it"],
    [{ pages: 301 }, "PDF_TOO_MANY_PAGES: 301 pages (limit 300)"],
    [{ largestSidePt: 20_000 }, "PDF_PAGE_TOO_LARGE: a page side is 20000 pt (limit 14400)"],
    [{ pages: 0 }, "PDF_RENDER_FAILED: the PDF has no pages"]
  ];
  for (const [info, message] of cases) {
    const tmpRoot = await scratch();
    try {
      const store = memoryStore();
      const { renderer, calls } = fakeRenderer(info);
      await assert.rejects(splitPdf({ store, storage: memoryStorage(), renderer, tmpRoot, maxPages: 300 }, "job-4", parent()),
        (error: unknown) => error instanceof PdfSplitError && error.message === message && !error.retryable);
      assert.deepEqual([calls, store.calls, store.chunks], [[], [], []], message);
      assert.deepEqual(await readdir(tmpRoot), [], "scratch removed after a refusal");
    } finally { await rm(tmpRoot, { recursive: true, force: true }); }
  }
  const tmpRoot = await scratch();
  try { // the limit is configurable (OCR_MAX_PDF_PAGES)
    const store = memoryStore();
    await splitPdf({ store, storage: memoryStorage(), renderer: fakeRenderer({ pages: 301 }).renderer, tmpRoot, maxPages: 301 }, "job-5", parent());
    assert.equal(store.pages.size, 301);
  } finally { await rm(tmpRoot, { recursive: true, force: true }); }
});

test("split stops before the next chunk once the lease is lost (another worker resumes it)", async () => {
  const tmpRoot = await scratch();
  try {
    let chunks = 0;
    const store = memoryStore();
    const create = store.createPageDocuments;
    store.createPageDocuments = async (...args) => { chunks += 1; return create(...args); };
    await assert.rejects(splitPdf({ store, storage: memoryStorage(), renderer: fakeRenderer().renderer, tmpRoot, maxPages: 300, leaseLost: () => chunks >= 1 }, "job-6", parent()), /LEASE_LOST/);
    assert.equal(store.pages.size, 10);
    assert.equal(store.calls.includes("markSplit:25"), false);
  } finally { await rm(tmpRoot, { recursive: true, force: true }); }
});

test("pngFromPpm keeps the pixels exactly (lossless) and writes valid PNG chunks", async () => {
  const pixels = [255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30, 40, 50, 60, 250, 251, 252];
  const png = await pngFromPpm(Buffer.concat([Buffer.from("P6\n3 2\n255\n", "latin1"), Buffer.from(pixels)]));
  assert.deepEqual([...png.subarray(0, 8)], PNG);
  const chunks: Array<{ type: string; data: Buffer }> = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset), type = png.subarray(offset + 4, offset + 8).toString("latin1"), data = png.subarray(offset + 8, offset + 8 + length);
    assert.equal(png.readUInt32BE(offset + 8 + length), crc32(data, crc32(Buffer.from(type, "latin1"))) >>> 0, `${type} CRC`);
    chunks.push({ type, data }); offset += 12 + length;
  }
  assert.deepEqual(chunks.map((chunk) => chunk.type), ["IHDR", "IDAT", "IEND"]);
  assert.deepEqual([chunks[0]!.data.readUInt32BE(0), chunks[0]!.data.readUInt32BE(4), ...chunks[0]!.data.subarray(8)], [3, 2, 8, 2, 0, 0, 0]);
  assert.deepEqual([...inflateSync(chunks[1]!.data)], [0, ...pixels.slice(0, 9), 0, ...pixels.slice(9)], "filter byte 0 + the rows, unchanged");
  await assert.rejects(pngFromPpm(Buffer.from("P5\n3 2\n255\n\0\0\0\0\0\0", "latin1")), /PPM_INVALID/);
  await assert.rejects(pngFromPpm(Buffer.from("P6\n3 2\n255\n\0\0", "latin1")), /PPM_TRUNCATED/);
});

// ---------- runWorkerOnce dispatch ---------------------------------------------------------------------------------------

function jobHarness(document: WorkerDocument, options: { renderer?: PdfRenderer; storage?: ReturnType<typeof memoryStorage>; finalStatus?: "PENDING" | "DEAD"; ocr?: () => Promise<OcrResponse> } = {}) {
  const calls: string[] = [];
  const ocrNames: string[] = [];
  const store = memoryStore();
  const storage = options.storage ?? memoryStorage();
  const tmpRoot = join(tmpdir(), `ocr-split-job-${process.pid}-${Math.random().toString(16).slice(2)}`);
  const dependencies = {
    queue: {
      claim: async () => ({ jobId: "10000000-0000-4000-8000-000000000009", organizationId: tenant, runId: "run-1", kind: "OCR", leaseToken: "lease" }),
      heartbeat: async () => true,
      finishDetailed: async (_job: string, _lease: string, outcome: FinishOutcome, error?: string) => {
        calls.push(`finish:${outcome}${error ? `:${error}` : ""}`);
        return { accepted: true, finalStatus: outcome === "FAILED" ? options.finalStatus ?? "PENDING" : outcome };
      }
    },
    store: {
      ...store,
      getWorkerDocument: async () => document,
      markProcessing: async () => { calls.push("markProcessing"); },
      markFailure: async (_t: string, _id: string, message: string) => { calls.push(`markFailure:${message}`); },
      markRetrying: async (_t: string, _id: string, message: string) => { calls.push(`markRetrying:${message}`); },
      markRunFailure: async () => true,
      saveOcrResult: async () => { calls.push("saveOcrResult"); },
      saveCorrection: async () => undefined
    },
    storage,
    ocrClient: { processDocument: async (_file: Uint8Array, filename?: string) => { ocrNames.push(filename ?? ""); calls.push("ocr"); return options.ocr ? options.ocr() : { documentId: "ocr-1", staffOnly: {} }; } },
    tmpRoot, maxPdfPages: 300,
    ...(options.renderer ? { renderer: options.renderer } : {})
  };
  return { calls, ocrNames, store, storage, dependencies, cleanup: () => rm(tmpRoot, { recursive: true, force: true }) };
}

test("a PDF job splits the PDF (no OCR call) and finishes SUCCEEDED; the parent becomes SPLIT", async () => {
  const h = jobHarness(parent(), { renderer: fakeRenderer({ pages: 3 }).renderer });
  try {
    assert.equal(await runWorkerOnce(h.dependencies), true);
    assert.deepEqual(h.calls, ["markProcessing", "finish:SUCCEEDED"]);
    assert.deepEqual(h.store.calls, ["setPageCount:3", "markSplit:3"]);
    assert.equal(h.store.pages.size, 3);
  } finally { await h.cleanup(); }
});

test("a PDF that cannot be split ends DEAD with its code; a missing renderer is retried", async () => {
  const encrypted = jobHarness(parent(), { renderer: fakeRenderer(new PdfSplitError("PDF_ENCRYPTED", "a password is required to open it")).renderer });
  try {
    await runWorkerOnce(encrypted.dependencies);
    assert.deepEqual(encrypted.calls, ["markProcessing", "finish:DEAD:PDF_ENCRYPTED: a password is required to open it", "markFailure:PDF_ENCRYPTED: a password is required to open it"]);
  } finally { await encrypted.cleanup(); }
  const unconfigured = jobHarness(parent());
  try {
    await runWorkerOnce(unconfigured.dependencies);
    assert.deepEqual(unconfigured.calls, ["markProcessing", "finish:FAILED:PDF_RENDERER_UNAVAILABLE: no renderer configured", "markRetrying:PDF_RENDERER_UNAVAILABLE: no renderer configured"]);
  } finally { await unconfigured.cleanup(); }
});

test("a job for an already SPLIT parent (lost lease after the split) just finishes, without touching the document", async () => {
  const h = jobHarness(parent({ status: "SPLIT", pageCount: 3 }), { renderer: fakeRenderer().renderer });
  try {
    await runWorkerOnce(h.dependencies);
    assert.deepEqual(h.calls, ["finish:SUCCEEDED"]);
    assert.deepEqual(h.store.calls, []);
  } finally { await h.cleanup(); }
});

test("a page job sends the page image to the OCR API as page-NNNN.png", async () => {
  const page = child(3);
  const h = jobHarness(page, { storage: memoryStorage({ [page.sourceKey!]: new Uint8Array([...PNG, 3]) }) });
  try {
    await runWorkerOnce(h.dependencies);
    assert.deepEqual(h.calls, ["markProcessing", "ocr", "saveOcrResult", "finish:SUCCEEDED"]);
    assert.deepEqual(h.ocrNames, ["page-0003.png"]);
  } finally { await h.cleanup(); }
});

test("a page whose object is missing (failed render, or removed) is re-rendered from its PDF before OCR", async () => {
  for (const page of [child(7, { sourceKey: null }), child(7)]) {
    const { renderer, calls: renders } = fakeRenderer();
    const h = jobHarness(page, { renderer });
    try {
      await runWorkerOnce(h.dependencies);
      assert.deepEqual(renders, ["7"]);
      assert.deepEqual(h.calls, ["markProcessing", "ocr", "saveOcrResult", "finish:SUCCEEDED"]);
      const key = childStorageKey(tenant, parentId, 7);
      assert.deepEqual([...h.storage.objects.get(key)!], [...PNG, 7]);
      assert.deepEqual(h.store.calls, [`setPageObject:${page.documentId}:${key}:9`]);
      assert.equal(existsSync(h.dependencies.tmpRoot) ? (await readdir(h.dependencies.tmpRoot)).length : 0, 0, "scratch removed");
    } finally { await h.cleanup(); }
  }
  const stillBroken = jobHarness(child(7, { sourceKey: null }), { renderer: fakeRenderer({}, ["7"]).renderer, finalStatus: "DEAD" });
  try {
    await runWorkerOnce(stillBroken.dependencies);
    assert.deepEqual(stillBroken.calls, ["markProcessing", "finish:FAILED:PDF_RENDER_FAILED: page 7 does not render", "markFailure:PDF_RENDER_FAILED: page 7 does not render"]);
  } finally { await stillBroken.cleanup(); }
});
