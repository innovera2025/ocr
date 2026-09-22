/**
 * The real renderer (poppler pdfinfo + pdftoppm) on synthetic PDFs. Runs where poppler is installed — the worker image
 * (deploy/Dockerfile.worker); skipped elsewhere. The PDFs are generated here: scan-like landscape pages (832×590 pt, one
 * 1400×990 px grey form image per page, like the real 95-page upload), 1 / 12 / 301 pages, /Rotate 90, truncated,
 * encrypted (RC4, with and without a user password), a huge MediaBox, a CropBox smaller than the MediaBox, a 300 dpi scan
 * and a vector page. No customer data. OCR_TEST_SMALL_TMPFS (a ~3 MB tmpfs, e.g. `docker run --tmpfs /small:size=3m`)
 * enables the full-scratch-disk test.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { deflateSync, inflateSync } from "node:zlib";
import type { PageDocumentInput } from "@innovera/ocr-persistence";
import { childStorageKey, createPopplerRenderer, PAGE_LONG_SIDE_PX, PdfSplitError, splitPdf, type PdfRenderer } from "./split.js";

const hasPoppler = (() => { try { execFileSync("pdftoppm", ["-v"], { stdio: "ignore" }); return true; } catch { return false; } })();
const hasPrlimit = (() => { try { execFileSync("prlimit", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const smallTmpfs = process.env.OCR_TEST_SMALL_TMPFS;

// ---------- synthetic PDFs ---------------------------------------------------------------------------------------------

/** `content` replaces the page's drawing (default: the form image over the whole page plus a caption). */
type PageSpec = { widthPt?: number; heightPt?: number; rotate?: number; cropBox?: readonly [number, number, number, number]; content?: string };
const PAD = Buffer.from("28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a", "hex");
const md5 = (...parts: Uint8Array[]) => { const hash = createHash("md5"); for (const part of parts) hash.update(part); return hash.digest(); };
function rc4(key: Uint8Array, data: Uint8Array): Buffer {
  const s = Array.from({ length: 256 }, (_, index) => index);
  for (let i = 0, j = 0; i < 256; i += 1) { j = (j + s[i]! + key[i % key.length]!) & 255; [s[i], s[j]] = [s[j]!, s[i]!]; }
  const out = Buffer.alloc(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k += 1) { i = (i + 1) & 255; j = (j + s[i]!) & 255; [s[i], s[j]] = [s[j]!, s[i]!]; out[k] = data[k]! ^ s[(s[i]! + s[j]!) & 255]!; }
  return out;
}
const padded = (password: string) => Buffer.concat([Buffer.from(password, "latin1"), PAD]).subarray(0, 32);

/** 1400×990 (by default) 8-bit grey "form": white paper, printed rules and boxes, light noise (compresses like a clean scan). */
function formImage(width = 1400, height = 990): Buffer {
  const pixels = Buffer.alloc(width * height, 250);
  let seed = 7;
  for (let index = 0; index < pixels.length; index += 1) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; pixels[index] = 245 + (seed % 11); }
  for (let y = 60; y < height; y += 90) pixels.fill(120, y * width + 40, y * width + width - 40);
  for (let box = 0; box < 39; box += 1) {
    const x0 = 80 + (box % 13) * 95, y0 = 150 + Math.floor(box / 13) * 180;
    for (let y = y0; y < y0 + 24; y += 1) for (let x = x0; x < x0 + 24; x += 1) if (y === y0 || y === y0 + 23 || x === x0 || x === x0 + 23) pixels[y * width + x] = 90;
  }
  return deflateSync(pixels, { level: 6 });
}

/** A PDF with one shared form image per page; `encrypt` applies the standard security handler R2 (RC4-40). */
function syntheticPdf(pages: readonly PageSpec[], encrypt?: { user: string; owner: string }, imageSize: readonly [number, number] = [1400, 990]): Buffer {
  const objects: Array<{ dict: string; stream?: Buffer }> = [];
  const add = (dict: string, stream?: Buffer) => { objects.push(stream ? { dict, stream } : { dict }); return objects.length; };
  const catalog = add(""), pagesId = add(""), font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const image = formImage(...imageSize);
  const imageId = add(`<< /Type /XObject /Subtype /Image /Width ${imageSize[0]} /Height ${imageSize[1]} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.length} >>`, image);
  const kids: number[] = [];
  pages.forEach((page, index) => {
    const w = page.widthPt ?? 832, h = page.heightPt ?? 590;
    const content = Buffer.from(page.content ?? `q ${w} 0 0 ${h} 0 0 cm /Im1 Do Q BT /F1 18 Tf 36 36 Td (Synthetic page ${index + 1}) Tj ET`, "latin1");
    const contentId = add(`<< /Length ${content.length} >>`, content);
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${w} ${h}]${page.cropBox ? ` /CropBox [${page.cropBox.join(" ")}]` : ""}${page.rotate ? ` /Rotate ${page.rotate}` : ""} /Resources << /Font << /F1 ${font} 0 R >> /XObject << /Im1 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`));
  });
  objects[catalog - 1] = { dict: `<< /Type /Catalog /Pages ${pagesId} 0 R >>` };
  objects[pagesId - 1] = { dict: `<< /Type /Pages /Kids [${kids.map((kid) => `${kid} 0 R`).join(" ")}] /Count ${kids.length} >>` };
  const id = randomBytes(16);
  let fileKey: Buffer | null = null, encryptId = 0;
  if (encrypt) {
    const p = Buffer.alloc(4); p.writeInt32LE(-44);
    const owner = rc4(md5(padded(encrypt.owner || encrypt.user)).subarray(0, 5), padded(encrypt.user));
    fileKey = md5(padded(encrypt.user), owner, p, id).subarray(0, 5);
    encryptId = add(`<< /Filter /Standard /V 1 /R 2 /O <${owner.toString("hex")}> /U <${rc4(fileKey, PAD).toString("hex")}> /P -44 >>`);
  }
  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  const offsets: number[] = [];
  let length = chunks[0]!.length;
  objects.forEach((object, index) => {
    const number = index + 1;
    let stream = object.stream;
    if (stream && fileKey && number !== encryptId) {
      const salt = Buffer.from([number & 255, (number >> 8) & 255, (number >> 16) & 255, 0, 0]);
      stream = rc4(md5(fileKey, salt).subarray(0, 10), stream);
    }
    const body = Buffer.concat([Buffer.from(`${number} 0 obj\n${object.dict}\n`, "latin1"), ...(stream ? [Buffer.from("stream\n"), stream, Buffer.from("\nendstream\n")] : []), Buffer.from("endobj\n")]);
    offsets.push(length); chunks.push(body); length += body.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)].join("");
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R${encryptId ? ` /Encrypt ${encryptId} 0 R` : ""} /ID [<${id.toString("hex")}> <${id.toString("hex")}>] >>\nstartxref\n${length}\n%%EOF\n`;
  chunks.push(Buffer.from(xref + trailer, "latin1"));
  return Buffer.concat(chunks);
}

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.subarray(12, 16).toString("latin1"), "IHDR");
  return { width: view.readUInt32BE(16), height: view.readUInt32BE(20) };
}

/** Pixels (RGB) of a PNG written by `pngFromPpm` (8-bit RGB, filter 0 on every row). */
function pngRgb(bytes: Uint8Array): { width: number; height: number; at(x: number, y: number): [number, number, number] } {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { width, height } = pngSize(bytes);
  const idat: Buffer[] = [];
  for (let offset = 8; offset < view.length;) {
    const length = view.readUInt32BE(offset), type = view.subarray(offset + 4, offset + 8).toString("latin1");
    if (type === "IDAT") idat.push(view.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const rows = inflateSync(Buffer.concat(idat));
  return { width, height, at: (x, y) => { const i = y * (width * 3 + 1) + 1 + x * 3; return [rows[i]!, rows[i + 1]!, rows[i + 2]!]; } };
}

// ---------- tests ------------------------------------------------------------------------------------------------------

describe("poppler renderer on synthetic PDFs", { skip: hasPoppler ? false : "poppler-utils (pdfinfo/pdftoppm) not installed: run inside the worker image" }, () => {
  const renderer: PdfRenderer = createPopplerRenderer();
  const tenant = "00000000-0000-4000-8000-000000000001";
  const parentId = "00000000-0000-4000-8000-0000000000aa";
  const parentKey = `org/${tenant}/original/ab/${"ab".repeat(16)}`;

  async function withPdf<T>(bytes: Buffer, run: (path: string, dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "ocr-poppler-"));
    try { const path = join(dir, "in.pdf"); await writeFile(path, bytes); return await run(path, dir); } finally { await rm(dir, { recursive: true, force: true }); }
  }
  /** splitPdf with real poppler and in-memory storage/store. */
  async function split(bytes: Buffer, maxPages = 300) {
    const objects = new Map<string, Uint8Array>([[parentKey, bytes]]);
    const pages = new Map<number, PageDocumentInput>();
    const store = {
      setPageCount: async () => undefined, existingPages: async () => [...pages.keys()], markSplit: async (_t: string, _id: string, count: number) => { assert.equal(pages.size, count); },
      createPageDocuments: async (_t: string, _id: string, _count: number, inputs: readonly PageDocumentInput[]) => { for (const input of inputs) pages.set(input.pageNumber, input); return { created: inputs.map((input) => input.pageNumber), existing: [] }; }
    };
    const storage = { put: async (key: string, value: Uint8Array) => { objects.set(key, value); }, get: async (key: string) => objects.get(key)! };
    const tmpRoot = await mkdtemp(join(tmpdir(), "ocr-poppler-split-"));
    try {
      const started = process.hrtime.bigint();
      const result = await splitPdf({ store, storage, renderer, tmpRoot, maxPages }, "job-poppler", { documentId: parentId, organizationId: tenant, sourceKey: parentKey, filename: "synthetic.pdf",
        mimeType: "application/pdf", status: "CLEAN", batchId: null, parentDocumentId: null, pageNumber: null, pageCount: null, createdAt: "", parentSourceKey: null });
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      assert.deepEqual(await readdir(tmpRoot), [], "scratch removed");
      return { result, pages, objects, ms };
    } finally { await rm(tmpRoot, { recursive: true, force: true }); }
  }

  test("1 page: pdfinfo reads it and pdftoppm renders the scan at its own 1400 px (never upsampled to 1610)", async (t) => {
    const bytes = syntheticPdf([{}]);
    await withPdf(bytes, async (path, dir) => {
      assert.deepEqual(await renderer.inspect(path, 300), { pages: 1, encrypted: false, largestSidePt: 832 });
      const started = Date.now();
      const rendered = await renderer.renderRange(path, 1, 1, join(dir, "out"));
      t.diagnostic(`1 page rendered in ${Date.now() - started} ms`);
      assert.equal(rendered.length, 1);
      assert.equal((await readdir(join(dir, "out"))).length, 1);
    });
    const { result, pages, objects } = await split(bytes);
    assert.deepEqual([result.pageCount, result.created, result.failedPages], [1, 1, []]);
    const size = pngSize(objects.get(childStorageKey(tenant, parentId, 1))!);
    assert.deepEqual(size, { width: 1400, height: 990 }, "a 1400×990 px scan on 832×590 pt → its own 1400×990 px, as validated by the Local AI (not 1610×1142)");
    // Pixel for pixel: the stored page is exactly the embedded scan (no resampling; grey → R = G = B), except where the page
    // draws over it -- the caption "Synthetic page 1" at the bottom left is rendered, not dropped.
    const png = pngRgb(objects.get(childStorageKey(tenant, parentId, 1))!), scan = inflateSync(formImage());
    let outside = 0, caption = 0;
    for (let y = 0; y < 990; y += 1) for (let x = 0; x < 1400; x += 1) {
      const [r, g, b] = png.at(x, y), v = scan[y * 1400 + x]!;
      if (r !== v || g !== v || b !== v) { if (x < 400 && y > 880) caption += 1; else outside += 1; }
    }
    assert.equal(outside, 0, "every page pixel equals its scan pixel");
    assert.ok(caption > 100, "text drawn over the scan is part of the page image");
    assert.equal(pages.get(1)?.mimeType, "image/png");
  });

  test("12 pages: every page stored under its deterministic key, in page order, at the scan's own 1400 px", async (t) => {
    const { result, pages, objects, ms } = await split(syntheticPdf(Array.from({ length: 12 }, () => ({}))));
    t.diagnostic(`12 pages split in ${Math.round(ms)} ms (${Math.round(ms / 12)} ms/page incl. storage), PNG ${Math.round((objects.get(childStorageKey(tenant, parentId, 1))!.byteLength) / 1024)} KB/page`);
    assert.deepEqual([result.pageCount, result.created, result.failedPages], [12, 12, []]);
    assert.deepEqual([...pages.keys()].sort((a, b) => a - b), Array.from({ length: 12 }, (_, index) => index + 1));
    for (let page = 1; page <= 12; page += 1) {
      const stored = objects.get(childStorageKey(tenant, parentId, page));
      assert.ok(stored, `page ${page}`);
      assert.equal(Math.max(...Object.values(pngSize(stored))), 1400);
      assert.equal(pages.get(page)?.sizeBytes, stored.byteLength);
    }
  });

  test("/Rotate 90 is honoured: the landscape page renders portrait with the same long side", async () => {
    const { objects } = await split(syntheticPdf([{}, { rotate: 90 }]));
    assert.deepEqual(pngSize(objects.get(childStorageKey(tenant, parentId, 1))!), { width: 1400, height: 990 });
    // A rotated page is not rendered pixel for pixel but fitted at the scan's density (pdftoppm's uniform scale: 993 rows).
    assert.deepEqual(pngSize(objects.get(childStorageKey(tenant, parentId, 2))!), { width: 993, height: 1400 });
  });

  test("render size: a 300 dpi scan and a vector page are rendered at 1610 px (the cap); a scan is never upsampled", async () => {
    const vector = { content: "0.2 g 72 72 400 300 re f BT /F1 24 Tf 100 500 Td (Vector page) Tj ET" };
    const { objects } = await split(syntheticPdf([{}, vector], undefined, [3467, 2458]));
    assert.deepEqual(pngSize(objects.get(childStorageKey(tenant, parentId, 1))!), { width: PAGE_LONG_SIDE_PX, height: 1142 }, "3467 px scan → capped at 1610");
    assert.deepEqual(pngSize(objects.get(childStorageKey(tenant, parentId, 2))!), { width: PAGE_LONG_SIDE_PX, height: 1142 }, "no scan image → 1610");
    const small = await split(syntheticPdf([{}], undefined, [1100, 778]));
    assert.deepEqual(pngSize(small.objects.get(childStorageKey(tenant, parentId, 1))!), { width: 1100, height: 778 }, "a 1100×778 px scan stays 1100×778 px");
  });

  test("a CropBox smaller than the MediaBox is what gets rendered (as pdfinfo measures it and pdfium renders it)", async () => {
    // MediaBox 1664×1180 painted red, the CropBox 832×590 (bottom-left quarter) painted black: nothing red may show.
    const cropped = { widthPt: 1664, heightPt: 1180, cropBox: [0, 0, 832, 590] as const, content: "1 0 0 rg 0 0 1664 1180 re f 0 g 0 0 900 650 re f" };
    await withPdf(syntheticPdf([cropped]), async (path) => { assert.equal((await renderer.inspect(path, 300)).largestSidePt, 832, "pdfinfo measures the CropBox"); });
    const { objects } = await split(syntheticPdf([cropped]));
    const png = pngRgb(objects.get(childStorageKey(tenant, parentId, 1))!);
    assert.deepEqual([png.width, png.height], [PAGE_LONG_SIDE_PX, 1142], "the 832×590 pt CropBox fills the 1610 px render");
    let red = 0, dark = 0;
    for (let y = 0; y < png.height; y += 1) for (let x = 0; x < png.width; x += 1) {
      const [r, g, b] = png.at(x, y);
      if (r > 200 && g < 80 && b < 80) red += 1;
      if (r < 40 && g < 40 && b < 40) dark += 1;
    }
    assert.equal(red, 0, "content outside the CropBox (cut away by the author) is never rendered");
    assert.ok(dark > 0.9 * png.width * png.height, "the cropped area fills the page");
  });

  test("301 pages: refused over the limit before anything renders; within a raised limit every page renders", async (t) => {
    const bytes = syntheticPdf(Array.from({ length: 301 }, () => ({})));
    await assert.rejects(split(bytes, 300), (error: unknown) => error instanceof PdfSplitError && error.message === "PDF_TOO_MANY_PAGES: 301 pages (limit 300)" && !error.retryable);
    const { result, ms } = await split(bytes, 301);
    t.diagnostic(`301 pages split in ${Math.round(ms / 1000)} s (${Math.round(ms / 301)} ms/page incl. storage)`);
    assert.deepEqual([result.pageCount, result.created, result.failedPages.length], [301, 301, 0]);
  });

  test("a huge MediaBox (20000 pt) is refused as PDF_PAGE_TOO_LARGE without rendering", async () => {
    await assert.rejects(split(syntheticPdf([{}, { widthPt: 20_000, heightPt: 20_000 }])),
      (error: unknown) => error instanceof PdfSplitError && error.message === "PDF_PAGE_TOO_LARGE: a page side is 20000 pt (limit 14400)" && !error.retryable);
  });

  test("encrypted: a user password is PDF_ENCRYPTED (not retryable); a permissions-only PDF (empty user password) still renders", async () => {
    await assert.rejects(split(syntheticPdf([{}, {}], { user: "secret", owner: "owner" })), (error: unknown) => error instanceof PdfSplitError && error.code === "PDF_ENCRYPTED" && !error.retryable);
    const permissionsOnly = syntheticPdf([{}, {}], { user: "", owner: "owner" });
    await withPdf(permissionsOnly, async (path) => { assert.equal((await renderer.inspect(path, 300)).encrypted, true); });
    const { result, objects } = await split(permissionsOnly);
    assert.deepEqual([result.pageCount, result.failedPages], [2, []]);
    assert.equal(Math.max(...Object.values(pngSize(objects.get(childStorageKey(tenant, parentId, 2))!))), 1400);
  });

  test("a truncated PDF never crashes the split: it is refused as unreadable or its unreadable pages become FAILED rows", async (t) => {
    const whole = syntheticPdf(Array.from({ length: 12 }, () => ({})));
    for (const keep of [0.3, 0.6, 0.95]) {
      const bytes = whole.subarray(0, Math.floor(whole.length * keep));
      try {
        const { result } = await split(bytes);
        t.diagnostic(`truncated to ${keep * 100}%: ${result.pageCount} pages, failed ${result.failedPages.length}`);
        assert.ok(result.pageCount >= 1);
      } catch (error) {
        t.diagnostic(`truncated to ${keep * 100}%: ${(error as Error).message}`);
        assert.ok(error instanceof PdfSplitError && error.code === "PDF_RENDER_FAILED" && !error.retryable, String(error));
      }
    }
    await assert.rejects(split(Buffer.from("%PDF-1.4\nnot really a pdf")), (error: unknown) => error instanceof PdfSplitError && error.code === "PDF_RENDER_FAILED" && !error.retryable);
  });

  test("every renderer call has a wall-clock timeout (retryable) and, with prlimit, a memory limit", async () => {
    await withPdf(syntheticPdf(Array.from({ length: 3 }, () => ({}))), async (path, dir) => {
      await assert.rejects(createPopplerRenderer({ timeoutMs: 1 }).renderRange(path, 1, 3, join(dir, "slow")),
        (error: unknown) => error instanceof PdfSplitError && /timed out/.test(error.message) && error.retryable);
      if (hasPrlimit) {
        await assert.rejects(createPopplerRenderer({ memoryBytes: 16 * 1024 * 1024 }).renderRange(path, 1, 3, join(dir, "small")),
          (error: unknown) => error instanceof PdfSplitError && error.code === "PDF_RENDER_FAILED", "a 16 MiB address space is not enough: the limit is applied");
      }
    });
  });

  test("with prlimit, a missing pdfinfo/pdftoppm is PDF_RENDERER_UNAVAILABLE (retryable), never 'unreadable PDF' or failed pages", { skip: hasPrlimit ? false : "prlimit not installed" }, async () => {
    const bin = await mkdtemp(join(tmpdir(), "ocr-poppler-bin-"));
    const path = process.env.PATH;
    try {
      await symlink("/usr/bin/prlimit", join(bin, "prlimit")); // prlimit itself runs, the poppler tools are not on PATH
      process.env.PATH = bin;
      const unavailable = (error: unknown) => error instanceof PdfSplitError && error.code === "PDF_RENDERER_UNAVAILABLE" && error.retryable;
      await withPdf(syntheticPdf([{}]), async (pdf, dir) => {
        await assert.rejects(createPopplerRenderer().inspect(pdf, 300), unavailable);
        await assert.rejects(createPopplerRenderer().renderRange(pdf, 1, 1, join(dir, "out")), unavailable);
      });
    } finally {
      process.env.PATH = path;
      await rm(bin, { recursive: true, force: true });
    }
  });

  test("a full scratch disk fails the split as retryable PDF_RENDERER_UNAVAILABLE and writes no page row", { skip: smallTmpfs ? false : "set OCR_TEST_SMALL_TMPFS to a ~3 MB tmpfs" }, async () => {
    const tmpRoot = await mkdtemp(join(smallTmpfs!, "split-"));
    const created: number[] = [];
    const store = { setPageCount: async () => undefined, existingPages: async () => [], markSplit: async () => { throw new Error("must not be split"); },
      createPageDocuments: async (_t: string, _id: string, _count: number, inputs: readonly PageDocumentInput[]) => { created.push(...inputs.map((input) => input.pageNumber)); return { created: [], existing: [] }; } };
    const objects = new Map<string, Uint8Array>([[parentKey, syntheticPdf(Array.from({ length: 3 }, () => ({})))]]);
    const storage = { put: async (key: string, value: Uint8Array) => { objects.set(key, value); }, get: async (key: string) => objects.get(key)! };
    try {
      await assert.rejects(splitPdf({ store, storage, renderer, tmpRoot, maxPages: 300 }, "job-full", { documentId: parentId, organizationId: tenant, sourceKey: parentKey, filename: "synthetic.pdf",
        mimeType: "application/pdf", status: "CLEAN", batchId: null, parentDocumentId: null, pageNumber: null, pageCount: null, createdAt: "", parentSourceKey: null }),
      (error: unknown) => error instanceof PdfSplitError && error.code === "PDF_RENDERER_UNAVAILABLE" && error.retryable, "a 4 MB PPM does not fit: pdftoppm exits 0 with a cut-off file");
      assert.deepEqual(created, [], "no FAILED page rows: the queue retries the split later");
    } finally { await rm(tmpRoot, { recursive: true, force: true }); }
  });
});
