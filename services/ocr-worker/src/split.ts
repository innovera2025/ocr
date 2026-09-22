/**
 * Multi-page PDF split (design 2026-09-22 §1.3): the worker renders every page of an uploaded PDF with poppler into an
 * image and creates one child document (+ run + OCR job) per page, in chunks, each chunk in one transaction. Only page
 * images reach the OCR API, so the Local AI's upload limit no longer matters for PDFs and every page is read.
 *
 * Safety: pdfinfo/pdftoppm run as child processes (execFile, no shell) with a wall-clock timeout, a minimal environment
 * and, when `prlimit` exists, an address-space and CPU limit. The PDF was scanned by ClamAV at upload; its renders are
 * our own output and are not re-scanned. Idempotent: page storage keys are deterministic (`childStorageKey`), pages are
 * unique per parent, so a resumed split (lost lease, crash, retry of a FAILED parent) renders only the missing pages.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { crc32, deflate } from "node:zlib";
import type { PageDocumentInput, PageDocumentsResult, WorkerDocument } from "@innovera/ocr-persistence";
import { mintOriginalKey } from "@innovera/ocr-storage";
import type { LocalStorage } from "@innovera/ocr-storage/local";

/** The long side the Local AI renders PDFs at (`api.py:_render_scale`): page pixels match the validated path. */
export const PAGE_LONG_SIDE_PX = 1610;
/** Same page-size rule as the Local AI (`MAX_PDF_PAGE_PT`). */
export const MAX_PAGE_PT = 14_400;
export const SPLIT_CHUNK_PAGES = 10;

export type PageFormat = "png" | "jpeg";
export const PAGE_MIME: Readonly<Record<PageFormat, string>> = { png: "image/png", jpeg: "image/jpeg" };
/** `pages` is the document's page count; `largestSidePt` covers the first `min(pages, maxPages + 1)` pages. */
export type PdfInfo = Readonly<{ pages: number; encrypted: boolean; largestSidePt: number }>;
export type RenderedPage = Readonly<{ pageNumber: number; path: string }>;
export type PdfRenderer = Readonly<{
  format: PageFormat;
  inspect(pdfPath: string, maxPages: number): Promise<PdfInfo>;
  /** Renders pages first..last into `outDir`; resolves the files produced, rejects when the renderer failed. */
  renderRange(pdfPath: string, first: number, last: number, outDir: string): Promise<RenderedPage[]>;
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
    execFile(file, argv, { timeout: options.timeoutMs, killSignal: "SIGKILL", maxBuffer: options.maxBuffer ?? 1_048_576, env: subprocessEnv(), windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) { Object.assign(error, { stderr: String(stderr ?? "") }); rejectRun(error); return; }
        resolveRun({ stdout: String(stdout), stderr: String(stderr) });
      });
  });
}

function timedOut(error: ExecFailure): boolean { return error.killed === true || error.signal === "SIGKILL" || error.signal === "SIGXCPU"; }
function missing(error: ExecFailure): boolean { return error.code === "ENOENT"; }

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

export type PopplerOptions = Readonly<{ timeoutMs?: number; inspectTimeoutMs?: number; memoryBytes?: number; cpuSeconds?: number; format?: PageFormat; usePrlimit?: boolean }>;

/**
 * pdfinfo + pdftoppm (poppler-utils). `pdftoppm -scale-to 1610` fits each page into 1610×1610 px (honours /Rotate).
 * PNG pages are rendered as PPM and encoded by `pngFromPpm` (same pixels, ~25× faster than poppler's PNG writer); JPEG
 * pages come straight from pdftoppm (q95). Defaults: 120 s wall clock per render call, 30 s for pdfinfo, 1 GiB address
 * space and 120 s CPU per process (prlimit).
 */
export function createPopplerRenderer(options: PopplerOptions = {}): PdfRenderer {
  const format = options.format ?? "png";
  const timeoutMs = options.timeoutMs ?? 120_000;
  const inspectTimeoutMs = options.inspectTimeoutMs ?? 30_000;
  const limitArgs = [`--as=${options.memoryBytes ?? 1_073_741_824}`, `--cpu=${options.cpuSeconds ?? 120}`];
  let limits: Promise<readonly string[] | null> | undefined;
  const resolveLimits = () => limits ??= options.usePrlimit === false ? Promise.resolve(null)
    : Promise.any(["/usr/bin/prlimit", "/bin/prlimit"].map((path) => access(path, constants.X_OK))).then(() => limitArgs, () => null);
  const extension = format === "png" ? "ppm" : "jpg";
  return {
    format,
    async inspect(pdfPath, maxPages) {
      let stdout: string;
      try {
        ({ stdout } = await run("pdfinfo", ["-f", "1", "-l", String(Math.max(1, maxPages + 1)), pdfPath], { timeoutMs: inspectTimeoutMs, limits: await resolveLimits() }));
      } catch (error) {
        const failure = error as ExecFailure;
        if (missing(failure)) throw new PdfSplitError("PDF_RENDERER_UNAVAILABLE", "pdfinfo not installed", true);
        if (timedOut(failure)) throw new PdfSplitError("PDF_RENDER_FAILED", "pdfinfo timed out", true);
        if (/password/i.test(failure.stderr ?? "")) throw new PdfSplitError("PDF_ENCRYPTED", "a password is required to open it");
        throw new PdfSplitError("PDF_RENDER_FAILED", "unreadable PDF");
      }
      return parsePdfInfo(stdout);
    },
    async renderRange(pdfPath, first, last, outDir) {
      await mkdir(outDir, { recursive: true });
      const args = [...(format === "png" ? [] : ["-jpeg", "-jpegopt", "quality=95"]), "-scale-to", String(PAGE_LONG_SIDE_PX), "-f", String(first), "-l", String(last), pdfPath, join(outDir, "page")];
      try {
        await run("pdftoppm", args, { timeoutMs, limits: await resolveLimits() });
      } catch (error) {
        const failure = error as ExecFailure;
        if (missing(failure)) throw new PdfSplitError("PDF_RENDERER_UNAVAILABLE", "pdftoppm not installed", true);
        throw new PdfSplitError("PDF_RENDER_FAILED", timedOut(failure) ? `pages ${first}-${last} timed out` : `pages ${first}-${last} failed`, true);
      }
      const pattern = new RegExp(`^page-(\\d+)\\.${extension}$`);
      const pages = (await readdir(outDir)).flatMap((name) => {
        const pageNumber = Number(pattern.exec(name)?.[1] ?? Number.NaN);
        return Number.isInteger(pageNumber) && pageNumber >= first && pageNumber <= last ? [{ pageNumber, path: join(outDir, name) }] : [];
      }).sort((a, b) => a.pageNumber - b.pageNumber);
      if (format === "jpeg") return pages;
      const encoded: RenderedPage[] = [];
      for (const page of pages) {
        const path = page.path.replace(/\.ppm$/, ".png");
        try { await writeFile(path, await pngFromPpm(await readFile(page.path))); encoded.push({ pageNumber: page.pageNumber, path }); } catch { /* an unreadable raster: that page did not render */ }
        await unlink(page.path).catch(() => undefined);
      }
      return encoded;
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

/** A render that produced a real image (PNG / JPEG signature). */
export function isPageImage(bytes: Uint8Array, format: PageFormat): boolean {
  return format === "png"
    ? bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
    : bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
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
}>;
export type SplitResult = Readonly<{ pageCount: number; created: number; existing: number; failedPages: readonly number[]; renderMs: number }>;

async function readPage(renderer: PdfRenderer, path: string): Promise<Uint8Array | null> {
  try { const bytes = new Uint8Array(await readFile(path)); return isPageImage(bytes, renderer.format) ? bytes : null; } catch { return null; }
}

/**
 * Renders `pages` (sorted, one chunk) and returns each page's bytes, or null for a page that does not render. One
 * pdftoppm call covers the chunk; when it fails (or leaves pages out) the missing pages are rendered one by one, so one
 * bad page never costs its neighbours.
 */
export async function renderPages(renderer: PdfRenderer, pdfPath: string, pages: readonly number[], outDir: string): Promise<Map<number, Uint8Array | null>> {
  const result = new Map<number, Uint8Array | null>(pages.map((page) => [page, null]));
  if (pages.length === 0) return result;
  const attempt = async (first: number, last: number, dir: string): Promise<void> => {
    try {
      for (const rendered of await renderer.renderRange(pdfPath, first, last, dir)) {
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
 * page 1..N has a row. Throws PdfSplitError for PDFs that cannot be split.
 */
export async function splitPdf(deps: SplitDependencies, jobId: string, document: WorkerDocument): Promise<SplitResult> {
  const tenantId = document.organizationId;
  if (!document.sourceKey || !document.sourceKey.startsWith(`org/${tenantId}/original/`)) throw new Error("INVALID_TENANT_STORAGE_KEY");
  const workDir = join(deps.tmpRoot, `split-${jobId}`);
  const startedAt = Date.now();
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
      const rendered = await renderPages(deps.renderer, pdfPath, pages, workDir);
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
