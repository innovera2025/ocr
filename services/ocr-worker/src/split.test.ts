import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import type { OcrResponse } from "@innovera/ocr-client";
import type { PageDocumentInput, WorkerDocument } from "@innovera/ocr-persistence";
import { parseOriginalKey } from "@innovera/ocr-storage";
import { inflateSync, crc32 } from "node:zlib";
import { limits } from "@innovera/ocr-config";
import { childPublicId, childStorageKey, createPopplerRenderer, isSplitTarget, ocrUploadName, PAGE_LONG_SIDE_PX, pageFormat, pageRenderPlans, parsePdfInfo, pdfPageLimit, PdfSplitError, pngFromPpm, rendererMissing,
  runWorkerOnce, SPLIT_TOO_SLOW, splitPdf, validatePayload, type FinishOutcome, type PdfInfo, type PdfRenderer } from "./index.js";

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

test("split: a host failure (scratch disk full, renderer gone) is retryable and never becomes FAILED page rows", async () => {
  const tmpRoot = await scratch();
  try {
    const { renderer, calls } = fakeRenderer();
    const hostFailing: PdfRenderer = { ...renderer, renderRange: async (pdf, first, last, outDir, options) => {
      if (first === 11) throw new PdfSplitError("PDF_RENDERER_UNAVAILABLE", "page 11 was written incompletely (scratch space full?)", true);
      return renderer.renderRange(pdf, first, last, outDir, options);
    } };
    const store = memoryStore();
    await assert.rejects(splitPdf({ store, storage: memoryStorage(), renderer: hostFailing, tmpRoot, maxPages: 300 }, "job-host", parent()),
      (error: unknown) => error instanceof PdfSplitError && error.code === "PDF_RENDERER_UNAVAILABLE" && error.retryable);
    assert.deepEqual(calls, ["1-10"], "no page-by-page retry of a host failure");
    assert.deepEqual(store.chunks, [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]], "the failing chunk wrote no row at all");
    assert.equal(store.calls.includes("markSplit:25"), false, "the parent stays splittable: the queue retries the job, and a resume renders only pages 11-25");
  } finally { await rm(tmpRoot, { recursive: true, force: true }); }
});

test("split time budget: every call gets at most the time left, and a split past its budget fails for good (a Retry resumes it)", async () => {
  const tmpRoot = await scratch();
  try {
    const { renderer } = fakeRenderer();
    const timeouts: number[] = [];
    const slow: PdfRenderer = { ...renderer, renderRange: async (pdf, first, last, outDir, options) => {
      timeouts.push(options?.timeoutMs ?? Number.NaN);
      await new Promise((resolve) => setTimeout(resolve, 40)); // every page renders, just slowly
      return renderer.renderRange(pdf, first, last, outDir, options);
    } };
    const store = memoryStore();
    await assert.rejects(splitPdf({ store, storage: memoryStorage(), renderer: slow, tmpRoot, maxPages: 300, budgetMs: 60 }, "job-slow", parent()),
      (error: unknown) => error instanceof PdfSplitError && error.message === `PDF_RENDER_FAILED: ${SPLIT_TOO_SLOW}` && !error.retryable);
    assert.ok(timeouts.length >= 1 && timeouts.every((timeout) => timeout > 0 && timeout <= 60), `each call is bounded by what is left of the budget: ${timeouts.join(", ")}`);
    assert.ok(store.pages.size < 25 && !store.calls.includes("markSplit:25"), "the split stopped; the pages created so far stay and are read");
    assert.deepEqual(await readdir(tmpRoot), [], "scratch removed");
  } finally { await rm(tmpRoot, { recursive: true, force: true }); }
  assert.equal(limits.jobProcessingBudgetMs, 1_800_000, "production default: 30 min per split");
});

test("renderer missing: ENOENT, or prlimit's 'failed to execute' (exit 127/126); a loader failure (bare 127) is not", () => {
  assert.equal(rendererMissing({ code: "ENOENT" }), true);
  assert.equal(rendererMissing({ code: 127, stderr: "prlimit: failed to execute pdfinfo: No such file or directory\n" }), true);
  assert.equal(rendererMissing({ code: 126, stderr: "prlimit: failed to execute pdftoppm: Permission denied\n" }), true);
  assert.equal(rendererMissing({ code: 127, stderr: "pdftoppm: error while loading shared libraries: libpoppler.so: failed to map segment from shared object\n" }), false);
  assert.equal(rendererMissing({ code: 1, stderr: "Syntax Error: Couldn't read xref table\n" }), false);
});

test("render plans: a plain scan page is rendered pixel for pixel, other scans at their own density (never upsampled, at most 1610 px), other pages at 1610 px", () => {
  const info = (pages: Array<[number, number, number?]>) => pages.map(([w, h, rot], index) => `Page ${String(index + 1).padStart(4)} size: ${w} x ${h} pts\nPage ${String(index + 1).padStart(4)} rot:  ${rot ?? 0}`).join("\n");
  const header = "page   num  type   width height color comp bpc  enc interp  object ID x-ppi y-ppi size ratio\n--------------------------------------------------------------------------------------------\n";
  const image = (page: number, width: number, height: number, ppi: number, type = "image") => `${String(page).padStart(4)} ${String(page - 1).padStart(5)} ${type.padEnd(6)} ${String(width).padStart(6)} ${String(height).padStart(6)}  rgb     3   8  jpeg   no  ${String(10 + page).padStart(9)}  0 ${String(ppi).padStart(5)} ${String(ppi).padStart(5)}  201K 4.9%`;
  const listing = header + [
    image(1, 1400, 991, 121),            // the real upload: a 1400×991 px scan on an 833.06×589.69 pt page (ppi rounded by pdfimages)
    image(2, 3500, 2475, 300),           // a 300 dpi scan: capped at 1610
    image(3, 200, 100, 150),             // a logo on a vector page
    image(3, 200, 100, 150, "smask"),
    image(5, 990, 1400, 121),            // portrait scan, but the page is rotated: native density, uniform scale
    image(6, 1400, 990, 121),            // a scan whose CropBox shows the left half of the page (990 rows along the long axis)
    image(7, 990, 1400, 121),            // an image drawn rotated (axes swapped): not recognised, 1610 px
    image(8, 1400, 991, 121),            // a scan with a second (small) image drawn over it: rendered, at the scan's density
    image(8, 120, 60, 121),
    image(9, 1400, 991, 121)             // a scan stretched onto a fixed 832×590 pt page: still pixel for pixel
  ].join("\n");
  const plans = pageRenderPlans(info([[833.06, 589.69], [840, 594], [595, 842], [595, 842], [589.09, 833.06, 90], [416, 590], [832, 590], [833.06, 589.69], [832, 590]]), listing, 1, 9);
  const exact = (page: number) => plans.get(page)!.resolution!.map((dpi) => Math.round(dpi * 1000) / 1000);
  assert.deepEqual(plans.get(1)?.longSide, 1400);
  assert.deepEqual(exact(1), [120.988, 120.987], "72·1400/833.06 and 72·991/589.69, a hair under 121 dpi: 1400×991 output pixels, one per image pixel");
  assert.deepEqual(exact(9), [121.142, 120.923], "per-axis: the scan's own 1400×991 pixels even when the PDF stretched it");
  assert.deepEqual([2, 3, 4, 5, 6, 7, 8].map((page) => [page, plans.get(page)!.longSide, plans.get(page)!.resolution]),
    [[2, PAGE_LONG_SIDE_PX, null], [3, PAGE_LONG_SIDE_PX, null], [4, PAGE_LONG_SIDE_PX, null], [5, 1400, null], [6, 990, null], [7, PAGE_LONG_SIDE_PX, null], [8, 1400, null]]);
  assert.deepEqual([...pageRenderPlans("", "", 3, 4).values()], [{ longSide: PAGE_LONG_SIDE_PX, resolution: null }, { longSide: PAGE_LONG_SIDE_PX, resolution: null }], "no listing: the previous behaviour (1610 px)");
});

/** The real poppler renderer driven by fake pdfinfo/pdfimages/pdftoppm scripts on PATH (no prlimit): its error handling. */
async function withFakePoppler(pdftoppm: string, run: (renderer: (format?: "png" | "jpeg") => PdfRenderer, dir: string) => Promise<void>): Promise<void> {
  const dir = await scratch();
  const path = process.env.PATH;
  try {
    const bin = join(dir, "bin");
    await mkdir(bin);
    const script = async (name: string, body: string) => { await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`); await chmod(join(bin, name), 0o755); };
    await script("pdfinfo", "printf 'Pages:          2\\nPage    1 size: 832 x 590 pts\\nPage    2 size: 832 x 590 pts\\n'");
    await script("pdfimages", "echo 'page   num  type   width height color comp bpc  enc interp  object ID x-ppi y-ppi size ratio'");
    await script("pdftoppm", pdftoppm);
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    await run((format = "png") => createPopplerRenderer({ usePrlimit: false, format }), dir);
  } finally {
    process.env.PATH = path;
    await rm(dir, { recursive: true, force: true });
  }
}
const lastArg = 'for last; do :; done';
const hostFailure = (error: unknown) => error instanceof PdfSplitError && error.code === "PDF_RENDERER_UNAVAILABLE" && error.retryable;

test("poppler renderer: a render cut short or refused by a full disk is a host failure, not a failed page", async () => {
  // pdftoppm exits 0 when its write fails (ENOSPC): the PPM is cut short, and later pages of the range are empty.
  await withFakePoppler(`${lastArg}; printf 'P6\\n4 4\\n255\\n' > "$last-1.ppm"; : > "$last-2.ppm"`, async (renderer, dir) => {
    await assert.rejects(renderer().renderRange(join(dir, "in.pdf"), 1, 2, join(dir, "out")), hostFailure);
  });
  await withFakePoppler(`${lastArg}; : > "$last-1.ppm"`, async (renderer, dir) => {
    await assert.rejects(renderer().renderRange(join(dir, "in.pdf"), 1, 1, join(dir, "out")), hostFailure, "an empty file");
  });
  await withFakePoppler(`${lastArg}; printf '\\377\\330\\377\\340 no end marker' > "$last-1.jpg"`, async (renderer, dir) => {
    await assert.rejects(renderer("jpeg").renderRange(join(dir, "in.pdf"), 1, 1, join(dir, "out")), hostFailure, "a JPEG without its EOI marker");
  });
  await withFakePoppler(`${lastArg}; echo "Could not write image to $last-1.ppm; exiting" >&2; exit 1`, async (renderer, dir) => {
    await assert.rejects(renderer().renderRange(join(dir, "in.pdf"), 1, 1, join(dir, "out")), hostFailure, "output file not writable");
  });
  await withFakePoppler(`echo "I/O Error: Couldn't open file 'in.pdf': No such file or directory." >&2; exit 1`, async (renderer, dir) => {
    await assert.rejects(renderer().renderRange(join(dir, "in.pdf"), 1, 1, join(dir, "out")), hostFailure, "the staged source vanished");
  });
  // A page-specific failure stays a (retryable, swallowed-by-renderPages) PDF_RENDER_FAILED, and a complete render works.
  await withFakePoppler(`echo "Syntax Error: Bad block header" >&2; exit 99`, async (renderer, dir) => {
    await assert.rejects(renderer().renderRange(join(dir, "in.pdf"), 1, 1, join(dir, "out")), (error: unknown) => error instanceof PdfSplitError && error.code === "PDF_RENDER_FAILED");
  });
  await withFakePoppler(`${lastArg}; printf 'P6\\n1 1\\n255\\n\\001\\002\\003' > "$last-1.ppm"; printf '\\377\\330\\377\\340\\377\\331' > "$last-1.jpg"`, async (renderer, dir) => {
    assert.deepEqual((await renderer().renderRange(join(dir, "in.pdf"), 1, 1, join(dir, "out"))).map((page) => page.pageNumber), [1]);
    assert.deepEqual((await renderer("jpeg").renderRange(join(dir, "in.pdf"), 1, 1, join(dir, "out2"))).map((page) => page.pageNumber), [1]);
  });
});

test("poppler renderer: pdftoppm renders the CropBox, a page without a scan image at 1610 px", async () => {
  await withFakePoppler(`echo "$@" > "$(dirname "$0")/args"; ${lastArg}; printf 'P6\\n1 1\\n255\\n\\001\\002\\003' > "$last-1.ppm"`, async (renderer, dir) => {
    await renderer().renderRange(join(dir, "in.pdf"), 1, 1, join(dir, "out"));
    const args = (await readFile(join(dir, "bin", "args"), "utf8")).trim().split(" ");
    assert.ok(args.includes("-cropbox"), "the CropBox, as pdfinfo and pdfium measure it");
    assert.equal(args[args.indexOf("-scale-to") + 1], String(PAGE_LONG_SIDE_PX), "a page without a scan image: 1610 px");
  });
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
