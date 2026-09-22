/**
 * Multi-page PDF split (design 2026-09-22 §1.3): the worker renders every page of an uploaded PDF with poppler into an
 * image and creates one child document (+ run + OCR job) per page, in chunks, each chunk in one transaction. Only page
 * images reach the OCR API, so the Local AI's upload limit no longer matters for PDFs and every page is read.
 *
 * Safety: pdfinfo/pdfimages/pdftoppm run as child processes (execFile, no shell) with a wall-clock timeout, a minimal
 * environment and, when `prlimit` exists, an address-space and CPU limit; a whole split has a time budget
 * (`limits.jobProcessingBudgetMs`). The PDF was scanned by ClamAV at upload; its renders are our own output and are not
 * re-scanned. Idempotent: page storage keys are deterministic (`childStorageKey`), pages are unique per parent, so a
 * resumed split (lost lease, crash, retry of a FAILED parent) renders only the missing pages.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { crc32, deflate } from "node:zlib";
import { limits } from "@innovera/ocr-config";
import type { PageDocumentInput, PageDocumentsResult, WorkerDocument } from "@innovera/ocr-persistence";
import { mintOriginalKey } from "@innovera/ocr-storage";
import type { LocalStorage } from "@innovera/ocr-storage/local";

/**
 * The largest long side a page is rendered at (the Local AI's own PDF render size, `api.py:_render_scale`). A scanned page
 * (one image covering the page) is rendered at its image's own resolution when that is smaller -- never upsampled, and a
 * plain scan page pixel for pixel: the Local AI thresholds were validated on the native ~1400 px scans, and both an
 * upscaled render and a resampled one move them (see `pageRenderPlans`).
 */
export const PAGE_LONG_SIDE_PX = 1610;
/** Same page-size rule as the Local AI (`MAX_PDF_PAGE_PT`). */
export const MAX_PAGE_PT = 14_400;
export const SPLIT_CHUNK_PAGES = 10;

export type PageFormat = "png" | "jpeg";
export const PAGE_MIME: Readonly<Record<PageFormat, string>> = { png: "image/png", jpeg: "image/jpeg" };
/** `pages` is the document's page count; `largestSidePt` covers the first `min(pages, maxPages + 1)` pages. */
export type PdfInfo = Readonly<{ pages: number; encrypted: boolean; largestSidePt: number }>;
export type RenderedPage = Readonly<{ pageNumber: number; path: string }>;
/** `timeoutMs` shortens the renderer's own wall-clock limit for this call (what is left of the split budget). */
export type RenderCallOptions = Readonly<{ timeoutMs?: number }>;
export type PdfRenderer = Readonly<{
  format: PageFormat;
  inspect(pdfPath: string, maxPages: number): Promise<PdfInfo>;
  /**
   * Renders pages first..last into `outDir`; resolves the files produced, rejects when the renderer failed. Rejects with
   * a retryable PDF_RENDERER_UNAVAILABLE when the host, not the PDF, is at fault (renderer missing, scratch disk full or
   * unwritable, staged source gone): such a failure must never become per-page FAILED rows.
   */
  renderRange(pdfPath: string, first: number, last: number, outDir: string, options?: RenderCallOptions): Promise<RenderedPage[]>;
}>;

export type PdfSplitCode = "PDF_ENCRYPTED" | "PDF_TOO_MANY_PAGES" | "PDF_PAGE_TOO_LARGE" | "PDF_RENDER_FAILED" | "PDF_RENDERER_UNAVAILABLE";
/** A PDF that cannot be split. Not retryable → the job ends DEAD and the parent FAILED with `code: detail` (Retry allowed). */
export class PdfSplitError extends Error {
  readonly code: PdfSplitCode;
  readonly retryable: boolean;
  constructor(code: PdfSplitCode, detail = "", retryable = false) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "PdfSplitError";
    this.code = code;
    this.retryable = retryable;
  }
}

/** Deterministic public id / storage key of page `pageNumber` of `parentId`: a re-render overwrites the same object. */
export function childPublicId(parentId: string, pageNumber: number): string {
  return createHash("sha256").update(`page:${parentId}:${pageNumber}`).digest("hex").slice(0, 32);
}
export function childStorageKey(organizationId: string, parentId: string, pageNumber: number): string {
  return mintOriginalKey(organizationId, childPublicId(parentId, pageNumber));
}

const MIME_EXTENSIONS: Readonly<Record<string, readonly string[]>> = { "image/png": ["png"], "image/jpeg": ["jpg", "jpeg"], "image/webp": ["webp"], "application/pdf": ["pdf"] };
/**
 * The filename sent to the OCR API. The Local AI picks its decoder from the extension first, so the extension must match
 * the MIME type: a page is `page-0012.png` (it would otherwise go out under its parent's name `x.pdf` and fail with 400);
 * an upload keeps its name when the extension already matches, else gets the MIME type's extension.
 */
export function ocrUploadName(document: Readonly<{ filename: string; mimeType: string; pageNumber?: number | null }>): string {
  const extensions = MIME_EXTENSIONS[document.mimeType.toLowerCase()];
  const name = document.filename.trim() || "document";
  if (!extensions) return name;
  if (document.pageNumber) return `page-${String(document.pageNumber).padStart(4, "0")}.${extensions[0]}`;
  const dot = name.lastIndexOf(".");
  if (dot > 0 && extensions.includes(name.slice(dot + 1).toLowerCase())) return name;
  return `${dot > 0 ? name.slice(0, dot) : name}.${extensions[0]}`;
}

/** Split target: a top-level PDF waiting to be (or being) split. A legacy PDF (page_count NULL, retried) qualifies too. */
export function isSplitTarget(document: Pick<WorkerDocument, "mimeType" | "parentDocumentId" | "status">): boolean {
  return document.mimeType.toLowerCase() === "application/pdf" && document.parentDocumentId === null && (document.status === "CLEAN" || document.status === "PROCESSING");
}

// ---------- poppler ----------------------------------------------------------------------------------------------------

type ExecFailure = Error & { code?: string | number; killed?: boolean; signal?: string | null; stderr?: string };
type RunOptions = Readonly<{ timeoutMs: number; maxBuffer?: number; limits: readonly string[] | null }>;

function subprocessEnv(): NodeJS.ProcessEnv {
  // Nothing of the worker's environment (database URLs, secrets) reaches the PDF parser.
  return { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", LC_ALL: "C" };
}

function run(command: string, args: readonly string[], options: RunOptions): Promise<{ stdout: string; stderr: string }> {
  const [file, argv] = options.limits ? ["prlimit", [...options.limits, "--", command, ...args]] : [command, [...args]];
  return new Promise((resolveRun, rejectRun) => {
    execFile(file, argv, { timeout: Math.max(1, Math.round(options.timeoutMs)), killSignal: "SIGKILL", maxBuffer: options.maxBuffer ?? 1_048_576, env: subprocessEnv(), windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) { Object.assign(error, { stderr: String(stderr ?? "") }); rejectRun(error); return; }
        resolveRun({ stdout: String(stdout), stderr: String(stderr) });
      });
  });
}

function timedOut(error: ExecFailure): boolean { return error.killed === true || error.signal === "SIGKILL" || error.signal === "SIGXCPU"; }
/**
 * The program itself is missing: ENOENT when it is spawned directly; through prlimit (present on every Debian/Ubuntu
 * host) prlimit starts and exits 127 "prlimit: failed to execute X", or 126 when X is not executable. (A bare 127 is not
 * enough: the dynamic loader also exits 127 when a library cannot be mapped, e.g. under a tiny address-space limit.)
 */
export function rendererMissing(error: Readonly<{ code?: string | number | undefined; stderr?: string | undefined }>): boolean {
  return error.code === "ENOENT" || ((error.code === 127 || error.code === 126) && /failed to execute/i.test(error.stderr ?? ""));
}

/** Errors of the host (disk, file table, permissions), never of the PDF: node errno codes and poppler's messages for them. */
const HOST_ERRNO = new Set(["ENOSPC", "EDQUOT", "EIO", "EMFILE", "ENFILE", "EROFS", "ENOMEM", "EACCES", "EPERM"]);
const HOST_STDERR = /Could not write image|I\/O Error: Couldn't open file|No space left on device|Disk quota exceeded|Input\/output error|Too many open files|Read-only file system|Permission denied/i;
function hostError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && HOST_ERRNO.has(code);
}
function hostFailure(detail: string): PdfSplitError { return new PdfSplitError("PDF_RENDERER_UNAVAILABLE", detail, true); }

/** pdfinfo output → PdfInfo. Per-page sizes come from `-f 1 -l N`; a single "Page size" line is the fallback. */
export function parsePdfInfo(stdout: string): PdfInfo {
  const pages = /^Pages:\s+(\d+)\s*$/m.exec(stdout);
  if (!pages) throw new PdfSplitError("PDF_RENDER_FAILED", "unreadable PDF (no page count)");
  const encrypted = /^Encrypted:\s+yes/m.test(stdout);
  let largestSidePt = 0;
  for (const match of stdout.matchAll(/^Page(?:\s+\d+)?\s+size:\s+([\d.]+)\s+x\s+([\d.]+)/gm)) {
    largestSidePt = Math.max(largestSidePt, Number(match[1]), Number(match[2]));
  }
  return { pages: Number(pages[1]), encrypted, largestSidePt };
}

/**
 * How one page is rendered: `resolution` [x dpi, y dpi] when the page is a plain scan (render it pixel for pixel), else
 * `-scale-to longSide`.
 */
export type PageRenderPlan = Readonly<{ longSide: number; resolution: readonly [number, number] | null }>;

/**
 * Render plan of each page first..last, from `pdfinfo -f first -l last` (page sizes -- the CropBox -- and /Rotate) and
 * `pdfimages -list -f first -l last` (every image drawn on a page: pixel size and effective ppi).
 * - A plain scan page (its only image spans the page within 2 % both ways, no /Rotate, at most `maxLongSide` px) is
 *   rendered with per-axis resolutions that map the image 1:1 onto the output pixels (a hair under the exact value, so
 *   pdftoppm's rounding up never adds a row): the page image is the scan's own pixels, exactly what uploading that scan
 *   as an image would give. (`-scale-to` alone resamples it by up to one pixel across the page.)
 * - Another scan page (one image covering at least 90 % both ways) gets `-scale-to` at that image's own density, capped
 *   at `maxLongSide` (never upsampled).
 * - Any other page (vector text, small images), and every page when the listings are empty or unreadable: `maxLongSide`.
 */
export function pageRenderPlans(pdfinfo: string, pdfimages: string, first: number, last: number, maxLongSide = PAGE_LONG_SIDE_PX): Map<number, PageRenderPlan> {
  const pageSize = new Map<number, readonly [number, number]>(), rotation = new Map<number, number>();
  for (const match of pdfinfo.matchAll(/^Page\s+(\d+)\s+size:\s+([\d.]+)\s+x\s+([\d.]+)/gm)) pageSize.set(Number(match[1]), [Number(match[2]), Number(match[3])]);
  for (const match of pdfinfo.matchAll(/^Page\s+(\d+)\s+rot:\s+(\d+)/gm)) rotation.set(Number(match[1]), Number(match[2]));
  const rows = new Map<number, string[][]>();
  for (const line of pdfimages.split("\n")) {
    const cells = line.trim().split(/\s+/);
    if (cells.length >= 14 && /^\d+$/.test(cells[0]!)) rows.set(Number(cells[0]), [...(rows.get(Number(cells[0])) ?? []), cells]);
  }
  const plans = new Map<number, PageRenderPlan>();
  for (let page = first; page <= last; page += 1) {
    const size = pageSize.get(page), images = rows.get(page) ?? [];
    let native = 0, exact: PageRenderPlan | null = null;
    for (const cells of size ? images : []) {
      const [width, height, xPpi, yPpi] = [cells[3], cells[4], cells[12], cells[13]].map(Number) as [number, number, number, number];
      if (cells[2] !== "image" || ![width, height, xPpi, yPpi].every((value) => Number.isFinite(value) && value > 0)) continue;
      const shown = [width * 72 / xPpi, height * 72 / yPpi] as const; // pt the image spans on the page, along x and y
      const cover = [shown[0] / size![0], shown[1] / size![1]] as const;
      if (!(cover[0] >= 0.9 && cover[1] >= 0.9)) continue;
      // The page's long axis at the image's own density; snapped to the image's pixel count when the image spans that
      // axis (pdfimages rounds the ppi, so 1400 px would otherwise come back as 1398).
      const [pagePt, imagePx, shownPt] = size![0] >= size![1] ? [size![0], width, shown[0]] : [size![1], height, shown[1]];
      let side = Math.round(imagePx * pagePt / shownPt);
      if (Math.abs(side - imagePx) <= 0.02 * imagePx) side = imagePx;
      native = Math.max(native, side);
      if (images.length === 1 && rotation.get(page) === 0 && Math.max(width, height) <= maxLongSide && cover.every((value) => Math.abs(value - 1) <= 0.02)) {
        const margin = 1 - 1e-4;
        exact = { longSide: Math.max(width, height), resolution: [72 * width / size![0] * margin, 72 * height / size![1] * margin] };
      }
    }
    plans.set(page, exact ?? { longSide: native > 0 ? Math.min(maxLongSide, native) : maxLongSide, resolution: null });
  }
  return plans;
}

export type PopplerOptions = Readonly<{ timeoutMs?: number; inspectTimeoutMs?: number; memoryBytes?: number; cpuSeconds?: number; format?: PageFormat; usePrlimit?: boolean }>;

/**
 * pdfinfo + pdfimages + pdftoppm (poppler-utils). `pdftoppm -cropbox` renders each page's CropBox (the box pdfinfo measures
 * and the Local AI's pdfium renders; honours /Rotate) as `pageRenderPlans` says: a plain scan pixel for pixel (`-rx/-ry`),
 * other pages fitted into N×N px (`-scale-to N`, N ≤ 1610); consecutive pages with one plan share a call. PNG pages are
 * rendered as PPM and encoded by `pngFromPpm` (same pixels, ~25× faster than poppler's PNG writer); JPEG pages come
 * straight from pdftoppm (q95). Defaults: 120 s wall clock per render call (a range, its listings included), 30 s for
 * pdfinfo, 1 GiB address space and 120 s CPU per process (prlimit). A render that comes back empty or cut short after a
 * clean exit, a write error or a vanished source is the host's fault (scratch disk full): PDF_RENDERER_UNAVAILABLE
 * (retryable), never a page failure.
 */
export function createPopplerRenderer(options: PopplerOptions = {}): PdfRenderer {
  const format = options.format ?? "png";
  const timeoutMs = options.timeoutMs ?? 120_000;
  const inspectTimeoutMs = options.inspectTimeoutMs ?? 30_000;
  const limitArgs = [`--as=${options.memoryBytes ?? 1_073_741_824}`, `--cpu=${options.cpuSeconds ?? 120}`];
  let processLimits: Promise<readonly string[] | null> | undefined;
  const resolveLimits = () => processLimits ??= options.usePrlimit === false ? Promise.resolve(null)
    : Promise.any(["/usr/bin/prlimit", "/bin/prlimit"].map((path) => access(path, constants.X_OK))).then(() => limitArgs, () => null);
  const extension = format === "png" ? "ppm" : "jpg";

  /** Per-page render plans. The listings are an optimisation only: when they fail, every page gets PAGE_LONG_SIDE_PX. */
  async function renderPlans(pdfPath: string, first: number, last: number, deadline: number, limitsArgs: readonly string[] | null): Promise<Map<number, PageRenderPlan>> {
    try {
      const range = ["-f", String(first), "-l", String(last)];
      const info = await run("pdfinfo", [...range, pdfPath], { timeoutMs: Math.min(inspectTimeoutMs, deadline - Date.now()), limits: limitsArgs });
      const images = await run("pdfimages", ["-list", ...range, pdfPath], { timeoutMs: Math.min(inspectTimeoutMs, deadline - Date.now()), maxBuffer: 8_388_608, limits: limitsArgs });
      return pageRenderPlans(info.stdout, images.stdout, first, last);
    } catch {
      return pageRenderPlans("", "", first, last);
    }
  }

  /** A rendered file → the page to store (PNG encoded), null when that page did not render; throws for host failures. */
  async function finishPage(page: RenderedPage): Promise<RenderedPage | null> {
    const cutShort = () => hostFailure(`page ${page.pageNumber} was written incompletely (scratch space full?)`);
    let bytes: Buffer;
    try { bytes = await readFile(page.path); } catch (error) { if (hostError(error)) throw hostFailure(`page ${page.pageNumber}: ${(error as Error).message}`); return null; }
    if (bytes.length === 0) throw cutShort();
    if (format === "jpeg") {
      // libjpeg always ends a finished file with EOI (FF D9): a file without it was cut off while being written.
      if (bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) throw cutShort();
      return page;
    }
    try {
      let png: Buffer;
      try { png = await pngFromPpm(bytes); } catch (error) {
        if ((error as Error).message === "PPM_TRUNCATED") throw cutShort(); // pdftoppm exits 0 when its write fails
        return null; // an unreadable raster: that page did not render
      }
      const path = page.path.replace(/\.ppm$/, ".png");
      try { await writeFile(path, png); } catch (error) { if (hostError(error)) throw hostFailure(`page ${page.pageNumber}: ${(error as Error).message}`); return null; }
      return { pageNumber: page.pageNumber, path };
    } finally { await unlink(page.path).catch(() => undefined); }
  }

  return {
    format,
    async inspect(pdfPath, maxPages) {
      let stdout: string;
      try {
        ({ stdout } = await run("pdfinfo", ["-f", "1", "-l", String(Math.max(1, maxPages + 1)), pdfPath], { timeoutMs: inspectTimeoutMs, limits: await resolveLimits() }));
      } catch (error) {
        const failure = error as ExecFailure;
        if (rendererMissing(failure)) throw new PdfSplitError("PDF_RENDERER_UNAVAILABLE", "pdfinfo not installed", true);
        if (timedOut(failure)) throw new PdfSplitError("PDF_RENDER_FAILED", "pdfinfo timed out", true);
        if (HOST_STDERR.test(failure.stderr ?? "")) throw hostFailure(`pdfinfo: ${(failure.stderr ?? "").trim().slice(0, 200)}`);
        if (/password/i.test(failure.stderr ?? "")) throw new PdfSplitError("PDF_ENCRYPTED", "a password is required to open it");
        throw new PdfSplitError("PDF_RENDER_FAILED", "unreadable PDF");
      }
      return parsePdfInfo(stdout);
    },
    async renderRange(pdfPath, first, last, outDir, call = {}) {
      const deadline = Date.now() + Math.max(1, Math.min(timeoutMs, call.timeoutMs ?? timeoutMs));
      try { await mkdir(outDir, { recursive: true }); } catch (error) { if (hostError(error)) throw hostFailure(`scratch directory: ${(error as Error).message}`); throw error; }
      const limitsArgs = await resolveLimits();
      const plans = await renderPlans(pdfPath, first, last, deadline, limitsArgs);
      const groups: Array<{ from: number; to: number; size: string[] }> = [];
      for (let page = first; page <= last; page += 1) {
        const plan = plans.get(page), previous = groups.at(-1);
        const size = plan?.resolution ? ["-rx", plan.resolution[0].toFixed(6), "-ry", plan.resolution[1].toFixed(6)] : ["-scale-to", String(plan?.longSide ?? PAGE_LONG_SIDE_PX)];
        if (previous && previous.size.join(" ") === size.join(" ")) previous.to = page; else groups.push({ from: page, to: page, size });
      }
      for (const group of groups) {
        const args = [...(format === "png" ? [] : ["-jpeg", "-jpegopt", "quality=95"]), "-cropbox", ...group.size, "-f", String(group.from), "-l", String(group.to), pdfPath, join(outDir, "page")];
        try {
          await run("pdftoppm", args, { timeoutMs: deadline - Date.now(), limits: limitsArgs });
        } catch (error) {
          const failure = error as ExecFailure;
          if (rendererMissing(failure)) throw new PdfSplitError("PDF_RENDERER_UNAVAILABLE", "pdftoppm not installed", true);
          if (!timedOut(failure) && HOST_STDERR.test(failure.stderr ?? "")) throw hostFailure(`pdftoppm: ${(failure.stderr ?? "").trim().slice(0, 200)}`);
          throw new PdfSplitError("PDF_RENDER_FAILED", timedOut(failure) ? `pages ${first}-${last} timed out` : `pages ${first}-${last} failed`, true);
        }
      }
      const pattern = new RegExp(`^page-(\\d+)\\.${extension}$`);
      let names: string[];
      try { names = await readdir(outDir); } catch (error) { if (hostError(error)) throw hostFailure(`scratch directory: ${(error as Error).message}`); throw error; }
      const rendered = names.flatMap((name) => {
        const pageNumber = Number(pattern.exec(name)?.[1] ?? Number.NaN);
        return Number.isInteger(pageNumber) && pageNumber >= first && pageNumber <= last ? [{ pageNumber, path: join(outDir, name) }] : [];
      }).sort((a, b) => a.pageNumber - b.pageNumber);
      const pages: RenderedPage[] = [];
      for (const page of rendered) {
        const done = await finishPage(page);
        if (done) pages.push(done);
      }
      return pages;
    }
  };
}

const deflateAsync = promisify(deflate);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(data, crc32(head.subarray(4))) >>> 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * Binary PPM (P6, 8-bit RGB, what `pdftoppm` writes by default) → lossless PNG with the same pixels. poppler's and
 * cairo's own PNG writers spend ~5 s per 1610 px scan page on maximum compression; the raster itself takes ~0.2 s.
 * Deflate (level 3, no row filter) runs in the libuv threadpool, so the worker's event loop and heartbeats keep going.
 */
export async function pngFromPpm(ppm: Uint8Array): Promise<Buffer> {
  const bytes = Buffer.from(ppm.buffer, ppm.byteOffset, ppm.byteLength);
  const header = /^P6\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(bytes.subarray(0, 64).toString("latin1"));
  const width = Number(header?.[1]), height = Number(header?.[2]);
  if (!header || header[3] !== "255" || !(width > 0 && height > 0 && width <= 20_000 && height <= 20_000)) throw new Error("PPM_INVALID");
  const stride = width * 3, start = header[0].length;
  if (bytes.length < start + stride * height) throw new Error("PPM_TRUNCATED");
  const rows = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) bytes.copy(rows, y * (stride + 1) + 1, start + y * stride, start + (y + 1) * stride);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit, RGB, deflate, no filter method variants, no interlace
  return Buffer.concat([PNG_SIGNATURE, pngChunk("IHDR", ihdr), pngChunk("IDAT", await deflateAsync(rows, { level: 3 })), pngChunk("IEND", Buffer.alloc(0))]);
}

/** A render that produced a real, complete image (PNG signature; JPEG SOI ... EOI, so a cut-off JPEG is refused). */
export function isPageImage(bytes: Uint8Array, format: PageFormat): boolean {
  return format === "png"
    ? bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
    : bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
}

// ---------- split ------------------------------------------------------------------------------------------------------

export type SplitStore = Readonly<{
  setPageCount(tenantId: string, documentId: string, pageCount: number): Promise<void>;
  existingPages(tenantId: string, parentId: string): Promise<number[]>;
  createPageDocuments(tenantId: string, parentId: string, pageCount: number, pages: readonly PageDocumentInput[]): Promise<PageDocumentsResult>;
  markSplit(tenantId: string, documentId: string, pageCount: number): Promise<void>;
}>;
export type SplitDependencies = Readonly<{
  store: SplitStore; storage: LocalStorage; renderer: PdfRenderer;
  /** Scratch space (`${OCR_STORAGE_ROOT}/tmp` in production, cleaned by deploy/cleanup-retention.sh after a day). */
  tmpRoot: string;
  maxPages: number;
  /** True once a heartbeat reported the lease lost: the split stops before the next chunk (another worker resumes it). */
  leaseLost?: () => boolean;
  chunkPages?: number;
  /** Time budget of one split (default `limits.jobProcessingBudgetMs`, 30 min): past it the split fails, see SPLIT_TOO_SLOW. */
  budgetMs?: number;
}>;
export type SplitResult = Readonly<{ pageCount: number; created: number; existing: number; failedPages: readonly number[]; renderMs: number }>;

async function readPage(renderer: PdfRenderer, path: string): Promise<Uint8Array | null> {
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await readFile(path)); } catch (error) { if (hostError(error)) throw hostFailure(`${(error as Error).message}`); return null; }
  return isPageImage(bytes, renderer.format) ? bytes : null;
}

/** Detail of the non-retryable PDF_RENDER_FAILED of a split that used up its time budget (a pathologically slow PDF). */
export const SPLIT_TOO_SLOW = "rendering the pages takes longer than the split time budget";

/**
 * Renders `pages` (sorted, one chunk) and returns each page's bytes, or null for a page that does not render. One
 * pdftoppm call covers the chunk; when it fails (or leaves pages out) the missing pages are rendered one by one, so one
 * bad page never costs its neighbours. Host failures (PDF_RENDERER_UNAVAILABLE) are rethrown, never turned into null
 * pages. `deadline` (epoch ms) bounds all calls: each gets at most the time left, and none starts after it
 * (non-retryable PDF_RENDER_FAILED SPLIT_TOO_SLOW), so a PDF whose every page renders just under the per-call limit cannot
 * hold a job loop for hours.
 */
export async function renderPages(renderer: PdfRenderer, pdfPath: string, pages: readonly number[], outDir: string, deadline = Number.POSITIVE_INFINITY): Promise<Map<number, Uint8Array | null>> {
  const result = new Map<number, Uint8Array | null>(pages.map((page) => [page, null]));
  if (pages.length === 0) return result;
  const attempt = async (first: number, last: number, dir: string): Promise<void> => {
    const left = deadline - Date.now();
    if (left <= 0) throw new PdfSplitError("PDF_RENDER_FAILED", SPLIT_TOO_SLOW);
    try {
      for (const rendered of await renderer.renderRange(pdfPath, first, last, dir, Number.isFinite(left) ? { timeoutMs: left } : undefined)) {
        if (result.has(rendered.pageNumber) && result.get(rendered.pageNumber) === null) result.set(rendered.pageNumber, await readPage(renderer, rendered.path));
      }
    } catch (error) {
      if (error instanceof PdfSplitError && error.code === "PDF_RENDERER_UNAVAILABLE") throw error;
    } finally { await rm(dir, { recursive: true, force: true }); }
  };
  await attempt(pages[0]!, pages[pages.length - 1]!, join(outDir, `range-${pages[0]}`));
  for (const page of pages) if (result.get(page) === null) await attempt(page, page, join(outDir, `page-${page}`));
  return result;
}

function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

/** The parent's original, copied into the job's scratch directory for the renderer. */
async function stageSource(storage: LocalStorage, sourceKey: string, workDir: string): Promise<string> {
  await mkdir(workDir, { recursive: true });
  const path = join(workDir, "source.pdf");
  await writeFile(path, await storage.get(sourceKey));
  return path;
}

/**
 * Splits `document` (a top-level PDF, see `isSplitTarget`): pdfinfo checks → page count recorded → pages rendered and
 * created chunk by chunk (each chunk's documents, runs and jobs in one transaction, so page 1 is read while later pages
 * render) → parent SPLIT. Pages that already exist are skipped; a page that does not render gets a FAILED row, so every
 * page 1..N has a row. Throws PdfSplitError for PDFs that cannot be split, for host failures (retryable, before any row
 * of the failing chunk is written) and once the split's time budget is used up (non-retryable; a Retry resumes it).
 */
export async function splitPdf(deps: SplitDependencies, jobId: string, document: WorkerDocument): Promise<SplitResult> {
  const tenantId = document.organizationId;
  if (!document.sourceKey || !document.sourceKey.startsWith(`org/${tenantId}/original/`)) throw new Error("INVALID_TENANT_STORAGE_KEY");
  const workDir = join(deps.tmpRoot, `split-${jobId}`);
  const startedAt = Date.now();
  const deadline = startedAt + (deps.budgetMs ?? limits.jobProcessingBudgetMs);
  try {
    const pdfPath = await stageSource(deps.storage, document.sourceKey, workDir);
    const info = await deps.renderer.inspect(pdfPath, deps.maxPages);
    if (info.pages < 1) throw new PdfSplitError("PDF_RENDER_FAILED", "the PDF has no pages");
    if (info.pages > deps.maxPages) throw new PdfSplitError("PDF_TOO_MANY_PAGES", `${info.pages} pages (limit ${deps.maxPages})`);
    if (info.largestSidePt > MAX_PAGE_PT) throw new PdfSplitError("PDF_PAGE_TOO_LARGE", `a page side is ${Math.round(info.largestSidePt)} pt (limit ${MAX_PAGE_PT})`);
    const pageCount = info.pages;
    await deps.store.setPageCount(tenantId, document.documentId, pageCount);
    const existing = new Set(await deps.store.existingPages(tenantId, document.documentId));
    const chunk = Math.max(1, deps.chunkPages ?? SPLIT_CHUNK_PAGES);
    let created = 0, alreadyThere = 0;
    const failedPages: number[] = [];
    for (let first = 1; first <= pageCount; first += chunk) {
      const pages = Array.from({ length: Math.min(chunk, pageCount - first + 1) }, (_, index) => first + index).filter((page) => !existing.has(page));
      if (pages.length === 0) continue;
      if (deps.leaseLost?.()) throw new Error("LEASE_LOST");
      const rendered = await renderPages(deps.renderer, pdfPath, pages, workDir, deadline);
      const inputs: PageDocumentInput[] = [];
      for (const pageNumber of pages) {
        const bytes = rendered.get(pageNumber) ?? null;
        const publicId = childPublicId(document.documentId, pageNumber);
        if (!bytes) { failedPages.push(pageNumber); inputs.push({ pageNumber, publicId, storageKey: null, mimeType: PAGE_MIME[deps.renderer.format], sizeBytes: null, contentHash: null }); continue; }
        const storageKey = childStorageKey(tenantId, document.documentId, pageNumber);
        await deps.storage.put(storageKey, bytes);
        inputs.push({ pageNumber, publicId, storageKey, mimeType: PAGE_MIME[deps.renderer.format], sizeBytes: bytes.byteLength, contentHash: sha256(bytes) });
      }
      const result = await deps.store.createPageDocuments(tenantId, document.documentId, pageCount, inputs);
      created += result.created.length;
      alreadyThere += result.existing.length;
    }
    await deps.store.markSplit(tenantId, document.documentId, pageCount);
    return { pageCount, created, existing: existing.size + alreadyThere, failedPages, renderMs: Date.now() - startedAt };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export type PageSourceDependencies = Readonly<{
  storage: LocalStorage; renderer?: PdfRenderer | undefined; tmpRoot: string;
  store: Readonly<{ setPageObject(tenantId: string, documentId: string, storageKey: string, sizeBytes: number, contentHash: string): Promise<void> }>;
}>;

function notFound(error: unknown): boolean { return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"; }

/**
 * The bytes to OCR. A page whose object is missing (its render failed, or the file was removed) is re-rendered from its
 * parent PDF first and its object recorded; any other document is read from storage as before.
 */
export async function readOrRenderPage(deps: PageSourceDependencies, jobId: string, document: WorkerDocument): Promise<Uint8Array> {
  const page = document.parentDocumentId && document.pageNumber ? { parentId: document.parentDocumentId, pageNumber: document.pageNumber } : null;
  const key = document.sourceKey ?? (page ? childStorageKey(document.organizationId, page.parentId, page.pageNumber) : null);
  if (!key) throw new Error("DOCUMENT_NOT_FOUND");
  if (document.sourceKey) {
    try { return await deps.storage.get(document.sourceKey); } catch (error) { if (!page || !notFound(error)) throw error; }
  }
  if (!page || !document.parentSourceKey) throw new Error("PAGE_SOURCE_NOT_FOUND");
  if (!deps.renderer) throw new PdfSplitError("PDF_RENDERER_UNAVAILABLE", "no renderer configured", true);
  const workDir = join(deps.tmpRoot, `page-${jobId}`);
  try {
    const pdfPath = await stageSource(deps.storage, document.parentSourceKey, workDir);
    const bytes = (await renderPages(deps.renderer, pdfPath, [page.pageNumber], workDir)).get(page.pageNumber);
    if (!bytes) throw new PdfSplitError("PDF_RENDER_FAILED", `page ${page.pageNumber} does not render`, true);
    await deps.storage.put(key, bytes);
    await deps.store.setPageObject(document.organizationId, document.documentId, key, bytes.byteLength, sha256(bytes));
    return bytes;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
