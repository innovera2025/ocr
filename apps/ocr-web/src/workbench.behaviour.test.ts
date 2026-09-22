/**
 * Behaviour of the workbench script (not just its source text): the inline script runs in a vm context against a minimal
 * fake DOM, fetch and XMLHttpRequest, and exposes its internals instead of calling init().
 */
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { test } from "node:test";
import { createContext, Script } from "node:vm";
import { workbenchPage } from "./workbench.js";

type Listener = (event: Record<string, unknown>) => unknown;

class FakeElement {
  readonly tagName: string;
  children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly listeners = new Map<string, Listener[]>();
  className = "";
  hidden = false;
  disabled = false;
  href: string | undefined;
  private ownText = "";
  constructor(tagName: string) { this.tagName = tagName.toUpperCase(); }
  get textContent(): string { return this.ownText + this.children.map((child) => child.textContent).join(""); }
  set textContent(value: string) { this.children = []; this.ownText = String(value); }
  get firstChild(): FakeElement | null { return this.children[0] ?? null; }
  get classList() {
    const names = () => this.className.split(/\s+/).filter(Boolean);
    const set = (list: string[]) => { this.className = list.join(" "); };
    return {
      add: (...add: string[]) => set([...new Set([...names(), ...add])]),
      remove: (...remove: string[]) => set(names().filter((name) => !remove.includes(name))),
      toggle: (name: string, force?: boolean) => { const on = force ?? !names().includes(name); set(on ? [...new Set([...names(), name])] : names().filter((n) => n !== name)); return on; },
      contains: (name: string) => names().includes(name)
    };
  }
  append(...nodes: Array<FakeElement | string>): void { for (const node of nodes) this.children.push(typeof node === "string" ? textNode(node) : node); }
  replaceChildren(...nodes: Array<FakeElement | string>): void { this.children = []; this.ownText = ""; this.append(...nodes); }
  setAttribute(name: string, value: unknown): void { this.attributes.set(name, String(value)); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  hasAttribute(name: string): boolean { return this.attributes.has(name); }
  addEventListener(type: string, listener: Listener): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  contains(node: unknown): boolean { return node === this || this.children.some((child) => child.contains(node)); }
  querySelector(): null { return null; }
  querySelectorAll(): FakeElement[] { return []; }
  focus(): void { /* no layout */ }
  scrollIntoView(): void { /* no layout */ }
  descendants(): FakeElement[] { return this.children.flatMap((child) => [child, ...child.descendants()]); }
}
function textNode(text: string): FakeElement { const node = new FakeElement("#text"); node.textContent = text; return node; }

type FakeResponse = { ok: boolean; status: number; json(): Promise<unknown>; blob(): Promise<unknown> };
const json = (status: number, body: unknown): FakeResponse => ({ ok: status >= 200 && status < 300, status, json: async () => body, blob: async () => ({ type: "application/pdf" }) });
type Upload = { status: string; retryable: boolean; error: string; group: { batchId: string | null; total: number } | null; file: { name: string } };
type Workbench = {
  row(document: Record<string, unknown>): FakeElement;
  applyDocument(document: Record<string, unknown>): void;
  failText(document: Record<string, unknown>): string;
  toggleOriginal(): Promise<void>;
  renderBatch(): void;
  addFiles(files: unknown[]): void;
  loadPreview(seq: number, id: string): Promise<void>;
  save(): Promise<void>;
  ERRORS: Record<string, string>;
  state: { uploads: Upload[]; batch: unknown; batchId: string | null; current: unknown; draft: unknown; editable: boolean; openSeq: number; originalSig: string };
};

const inline = /<script\b[^>]*>([\s\S]*?)<\/script>/.exec(workbenchPage({ nonce: "n" }))?.[1] ?? "";
const EXPOSE = "globalThis.__wb={row,renderBatch,addFiles,loadPreview,save,ERRORS,state,applyDocument,failText,toggleOriginal};";

/** Runs the workbench script without init(). `fetchImpl` answers every fetch; `xhrStatus` answers every upload. */
function load(fetchImpl: (url: string, init?: Record<string, unknown>) => Promise<FakeResponse>, xhr: { status: number; body: unknown } = { status: 202, body: {} },
  blobs?: { created: number; revoked: number }) {
  assert.ok(inline.endsWith("init();\n})();\n"), "the script still ends with init()");
  const elements = new Map<string, FakeElement>();
  const fetches: string[] = [];
  const document = {
    getElementById: (id: string) => { let element = elements.get(id); if (!element) { element = new FakeElement("div"); elements.set(id, element); } return element; },
    createElement: (tag: string) => new FakeElement(tag), createTextNode: textNode, activeElement: null, hidden: false,
    body: new FakeElement("body"), addEventListener: () => undefined, contains: () => true
  };
  class FakeXhr {
    status = 0; responseText = ""; timeout = 0;
    readonly listeners = new Map<string, () => void>();
    readonly upload = { addEventListener: () => undefined };
    open(): void { /* recorded by send */ }
    setRequestHeader(): void { /* not needed */ }
    addEventListener(type: string, listener: () => void): void { this.listeners.set(type, listener); }
    send(): void { queueMicrotask(() => { this.status = xhr.status; this.responseText = JSON.stringify(xhr.body); this.listeners.get(xhr.status === 0 ? "error" : "load")?.(); }); }
  }
  // Counts blob URLs (`blobs`) so a test can see that none is left alive behind the preview.
  const CountingURL = blobs ? Object.assign(class extends URL {}, {
    createObjectURL: (blob: Blob) => { blobs.created += 1; return URL.createObjectURL(blob); },
    revokeObjectURL: (url: string) => { blobs.revoked += 1; URL.revokeObjectURL(url); }
  }) : URL;
  const context = createContext({
    document, window: { matchMedia: () => ({ matches: true }), addEventListener: () => undefined }, location: { href: "http://127.0.0.1/", search: "" },
    history: { replaceState: () => undefined }, CSS: { escape: (value: string) => value }, crypto: webcrypto, Node: { DOCUMENT_POSITION_PRECEDING: 2 },
    Option: class { constructor(readonly text: string, readonly value: string) {} }, URL: CountingURL, URLSearchParams, Blob, TextEncoder, AbortController,
    setTimeout: () => 0, clearTimeout: () => undefined, XMLHttpRequest: FakeXhr,
    fetch: (url: string, init?: Record<string, unknown>) => { fetches.push(`${String(init?.method ?? "GET")} ${url}`); return fetchImpl(url, init); }
  });
  new Script(inline.replace(/init\(\);\n\}\)\(\);\n$/, `${EXPOSE}\n})();\n`)).runInContext(context);
  return { wb: (context as { __wb: Workbench }).__wb, $: document.getElementById, fetches };
}
const settle = async (): Promise<void> => { for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setImmediate(resolve)); };
const token = (url: string) => url === "/api/web-token" ? Promise.resolve(json(200, { token: "t" })) : null;
const ID = "10000000-0000-4000-8000-000000000001";

test("quarantined rows offer no preview, no link and no retry; FAILED rows keep retry", () => {
  const { wb } = load(() => new Promise(() => undefined));
  const actions = (status: string) => wb.row({ documentId: ID, filename: "scan.pdf", status, statusCategory: "failed", summary: {} })
    .descendants().filter((node) => node.dataset.action).map((node) => String(node.dataset.action));
  assert.deepEqual(actions("QUARANTINED"), []);
  assert.match(wb.row({ documentId: ID, filename: "scan.pdf", status: "QUARANTINED", statusCategory: "failed", summary: {} }).textContent, /กรุณาอัปโหลดไฟล์ใหม่/);
  assert.deepEqual(actions("FAILED"), ["review", "retry", "review"]);
  assert.doesNotMatch(wb.ERRORS.DOCUMENT_NOT_RETRYABLE ?? "", /ไม่ได้อยู่ในสถานะไม่สำเร็จ จึง/, "the message must not contradict a 'failed' badge");
});

test("the original of a quarantined document is never fetched, and a server refusal is shown without an open link", async () => {
  const { wb, $, fetches } = load(async (url) => token(url) ?? json(409, { error: "DOCUMENT_QUARANTINED" }));
  wb.state.current = { documentId: ID, status: "QUARANTINED" };
  await wb.loadPreview(wb.state.openSeq, ID);
  assert.deepEqual(fetches, []);
  assert.equal($("p-content").textContent, wb.ERRORS.DOCUMENT_QUARANTINED);
  wb.state.current = { documentId: ID }; // deep link: status not known yet, the server refuses
  await wb.loadPreview(wb.state.openSeq, ID);
  assert.deepEqual(fetches, ["GET /api/web-token", `GET /api/documents/${ID}/content`]);
  assert.match($("p-content").textContent, /ไม่ผ่านการตรวจความปลอดภัย/);
  assert.equal($("p-open").href, undefined);
});

test("files the server always rejects are refused before the batch is created and are not counted in its total", async () => {
  const { wb, fetches } = load(() => new Promise(() => undefined));
  const thaiName = `${"ใบลงทะเบียนลูกค้า".repeat(8)}.pdf`; // > 120 code points
  wb.addFiles([
    { name: "ok.pdf", size: 10, type: "application/pdf" }, { name: "empty.pdf", size: 0, type: "application/pdf" },
    { name: "huge.pdf", size: 209_715_201, type: "application/pdf" }, { name: thaiName, size: 10, type: "application/pdf" },
    { name: "note.txt", size: 10, type: "text/plain" }, { name: "ok2.png", size: 10, type: "image/png" }
  ]);
  await settle();
  // Array.from: arrays made inside the vm context have another Array.prototype.
  assert.deepEqual(Array.from(wb.state.uploads, (upload) => upload.status), ["uploading", "rejected", "rejected", "rejected", "rejected", "uploading"]);
  assert.deepEqual(Array.from(wb.state.uploads, (upload) => upload.group?.total ?? null), [2, null, null, null, null, 2]);
  assert.match(wb.state.uploads[3]!.error, /120/);
  assert.deepEqual(fetches, ["GET /api/web-token"], "the batch request waits for the token; nothing else is sent");
});

test("deterministic upload rejections get no retry button; network failures do", async () => {
  const api = async (url: string) => token(url) ?? json(url === "/api/batches" ? 201 : 200, url === "/api/batches" ? { batchId: ID, expectedTotal: 1 } : { batches: [] });
  for (const [status, code, retryable] of [[400, "FILENAME_TOO_LONG", false], [400, "INVALID_UPLOAD_HEADERS", false], [404, "BATCH_NOT_FOUND", false], [400, "FILENAME_TOO_LARGE", false], [409, "UPLOAD_IN_PROGRESS", true], [0, "", true]] as const) {
    const { wb } = load(api, { status, body: code ? { error: code } : {} });
    wb.addFiles([{ name: "a.pdf", size: 10, type: "application/pdf" }]);
    await settle();
    assert.deepEqual([wb.state.uploads[0]!.status, wb.state.uploads[0]!.retryable], ["failed", retryable], code || "network");
  }
});

test("a batch whose missing files can no longer arrive is shown as finished, with the server's frozen elapsed time", () => {
  const { wb, $ } = load(() => new Promise(() => undefined));
  const batch = { batchId: ID, label: null, createdAt: "2026-09-21T01:00:00.000Z", expectedTotal: 4, uploaded: 3, queued: 0, processing: 0, succeeded: 2, needsReview: 1, failed: 0, confirmed: 0, completed: 3, finishedAt: null, durationMs: 120_000, throughputPerMinute: 1.5 };
  wb.state.batchId = ID;
  wb.state.batch = batch;
  wb.state.uploads = [{ status: "failed", retryable: false, error: "x", group: { batchId: ID, total: 4 }, file: { name: "a.pdf" } }];
  wb.renderBatch();
  assert.match($("batch-title").textContent, /อ่านครบทุกไฟล์ที่อัปโหลดได้/);
  assert.match($("batch-meta").textContent, /อัปโหลดไม่ครบ 1 ไฟล์/);
  assert.match($("batch-stats").textContent, /2:00/);
  wb.state.uploads[0]!.retryable = true; // the user can still retry that file: not finished yet
  wb.renderBatch();
  assert.match($("batch-title").textContent, /กำลังดำเนินการ/);
});

test("the editor is inert while a save is in flight, so no keystroke is silently replaced by the saved document", async () => {
  let answer: (response: FakeResponse) => void = () => undefined;
  const saved = { documentId: ID, filename: "a.png", status: "SUCCEEDED", statusCategory: "confirmed", updatedAt: "2026-09-21T01:05:00.000Z",
    structuredResult: { schemaVersion: 3, customerInformation: { name: { raw: "Anna", value: "Anna", confidence: 1, source: "human", needsReview: false } }, recommendationCard: {}, staffOnly: {} } };
  const { wb, $ } = load((url) => token(url) ?? new Promise((resolve) => { answer = resolve; }));
  wb.state.current = { documentId: ID, filename: "a.png", status: "NEEDS_REVIEW", statusCategory: "review", updatedAt: "2026-09-21T01:00:00.000Z" };
  wb.state.draft = structuredClone(saved.structuredResult);
  wb.state.editable = true;
  const saving = wb.save();
  await settle();
  assert.equal($("d-body").hasAttribute("inert"), true, "inputs cannot change the draft while it is being saved");
  answer(json(200, { status: "confirmed", delivery: "NOT_REQUIRED", corrections: 0, document: saved }));
  await saving;
  assert.equal($("d-body").hasAttribute("inert"), false);
});

// ---- multi-page PDFs (release 1, B7) ---------------------------------------------------------------------------------

const PARENT = "10000000-0000-4000-8000-0000000000aa";
const page12 = { documentId: ID, filename: "intake.pdf", parentFilename: "intake.pdf", mimeType: "image/png", status: "NEEDS_REVIEW", statusCategory: "review",
  parentDocumentId: PARENT, pageNumber: 12, pageCount: 95, summary: { formNumber: "012345", branch: "SUKHUMVIT 33", treatments: [] } };

test("a page row shows 'หน้า 12/95' under the file name, with the form number and branch", () => {
  const { wb } = load(() => new Promise(() => undefined));
  const text = wb.row(page12).textContent;
  assert.match(text, /intake\.pdf/);
  assert.match(text, /หน้า 12\/95/);
  assert.match(text, /เลขที่ 012345 · SUKHUMVIT 33/);
  assert.doesNotMatch(wb.row({ documentId: ID, filename: "a.png", status: "SUCCEEDED", statusCategory: "succeeded", summary: {} }).textContent, /หน้า \d/, "a plain image has no page label");
});

test("a PDF being split says so; split failures are explained in Thai", () => {
  const { wb } = load(() => new Promise(() => undefined));
  const splitting = wb.row({ documentId: ID, filename: "intake.pdf", mimeType: "application/pdf", parentDocumentId: null, status: "PROCESSING", statusCategory: "processing", pageCount: 95, summary: {} });
  assert.match(splitting.textContent, /กำลังแยก PDF เป็นรายหน้า \(95 หน้า\)/);
  assert.match(wb.row({ documentId: ID, filename: "intake.pdf", mimeType: "application/pdf", parentDocumentId: null, status: "CLEAN", statusCategory: "queued", summary: {} }).textContent, /รอแยก PDF เป็นรายหน้า/);
  assert.match(wb.failText({ status: "FAILED", errorMessage: "PDF_ENCRYPTED: a password is required to open it" }), /รหัสผ่าน/);
  assert.equal(wb.failText({ status: "FAILED", errorMessage: "PDF_TOO_MANY_PAGES: 412 pages (limit 300)" }), "PDF มี 412 หน้า เกินที่ระบบรองรับ (สูงสุด 300 หน้า) กรุณาแบ่งไฟล์แล้วอัปโหลดใหม่");
  assert.match(wb.failText({ status: "FAILED", errorMessage: "PAGE_RENDER_FAILED" }), /ลองอีกครั้ง/);
  assert.equal(wb.failText({ status: "FAILED", errorMessage: "OCR API returned HTTP 413" }), "สาเหตุ: OCR API returned HTTP 413", "other errors unchanged");
});

test("the batch strip counts files and rows separately and trusts the server's finished flag", () => {
  const { wb, $ } = load(() => new Promise(() => undefined));
  const base = { batchId: ID, label: null, createdAt: "2026-09-22T01:00:00.000Z", expectedTotal: 1, uploaded: 1, queued: 9, processing: 1, succeeded: 1, needsReview: 0, failed: 0, confirmed: 0, completed: 1, durationMs: 60_000, throughputPerMinute: 1 };
  wb.state.batchId = ID;
  wb.state.batch = { ...base, rows: 31, pages: 30, pagesExpected: 95, splitting: 1, rowsExpected: 95, finished: false, finishedAt: null };
  wb.renderBatch();
  assert.match($("batch-title").textContent, /กำลังแยก PDF เป็นรายหน้า/);
  assert.match($("batch-meta").textContent, /ไฟล์ 1\/1 · กำลังแยกหน้า 30\/95 · อ่านเสร็จ 1 จาก 95 แถว/, "a 95-page PDF is 95 rows, also while it is split");
  assert.match($("batch-stats").textContent, /ทั้งหมด \(แถว\)95/);
  wb.state.batch = { ...base, queued: 0, processing: 0, succeeded: 95, completed: 95, rows: 95, pages: 95, pagesExpected: 95, splitting: 0, finished: true, finishedAt: "2026-09-22T01:40:00.000Z" };
  wb.renderBatch();
  assert.match($("batch-title").textContent, /อ่านครบแล้ว/);
  assert.match($("batch-meta").textContent, /หน้า PDF 95\/95 · อ่านเสร็จ 95 จาก 95 แถว/);
  wb.state.batch = { ...base, queued: 5, processing: 0, succeeded: 1, completed: 1, rows: 6, pages: 5, pagesExpected: 5, splitting: 0, finished: false, finishedAt: null };
  wb.renderBatch();
  assert.doesNotMatch($("batch-title").textContent, /อ่านครบแล้ว/, "1 file, 1 of 6 rows read: not finished (the old files-vs-rows rule said it was)");
});

test("the drawer of a page is titled 'file.pdf · หน้า 12/95' and opens the original PDF at that page", async () => {
  const { wb, $, fetches } = load(async (url) => token(url) ?? json(200, {}));
  wb.applyDocument({ ...page12, structuredResult: { schemaVersion: 3, header: { formNumber: { raw: "012345", value: "012345", confidence: 0.9, source: "ocr", needsReview: false } }, customerInformation: {}, recommendationCard: {},
    staffOnly: { branch: { raw: "SUKHUMVIT 33", value: "SUKHUMVIT 33", confidence: 0.9, source: "master-fuzzy", needsReview: false }, totalMinutes: 90, treatments: [] } } });
  assert.equal($("d-title").textContent, "intake.pdf · หน้า 12/95");
  assert.equal($("p-pdf").hidden, false);
  assert.equal($("p-pdf").textContent, "เปิด PDF ต้นฉบับ (หน้า 12)");
  assert.match($("d-status").textContent, /เลขที่ 012345 · SUKHUMVIT 33/);
  const editor = $("editor").textContent;
  for (const text of ["หัวแบบฟอร์ม", "เลขที่ฟอร์ม", "สาขา", "เวลารวมที่เขียนไว้ในฟอร์ม 90 นาที", "ดูทุกหน้าของไฟล์นี้"]) assert.ok(editor.includes(text), text);
  await wb.toggleOriginal();
  assert.deepEqual(fetches.slice(-1), [`GET /api/documents/${PARENT}/content`]);
  const frame = $("p-content").children[0] as FakeElement & { src?: string };
  assert.equal(frame.tagName, "IFRAME");
  assert.match(String(frame.src), /#page=12$/);
  assert.match(String($("p-open").href), /#page=12$/);
  assert.equal($("p-pdf").textContent, "กลับไปดูภาพหน้านี้");
});

test("v3.0 results show no empty header group and no branch row; a SPLIT parent points to its pages", () => {
  const { wb, $ } = load(() => new Promise(() => undefined));
  wb.applyDocument({ documentId: ID, filename: "a.png", mimeType: "image/png", status: "NEEDS_REVIEW", statusCategory: "review",
    structuredResult: { schemaVersion: 3, header: {}, customerInformation: {}, recommendationCard: {}, staffOnly: { treatments: [], roomNo: { raw: "1", value: "1", needsReview: false } } } });
  assert.doesNotMatch($("editor").textContent, /หัวแบบฟอร์ม|สาขา/);
  assert.equal($("p-pdf").hidden, true);
  wb.applyDocument({ documentId: PARENT, filename: "intake.pdf", mimeType: "application/pdf", status: "SPLIT", pageCount: 95, parentDocumentId: null,
    structuredResult: { schemaVersion: 3, header: {}, customerInformation: {}, recommendationCard: {}, staffOnly: {} } });
  assert.match($("editor").textContent, /ไฟล์นี้ถูกแยกเป็น 95 หน้า/);
  assert.match($("d-status").textContent, /แยกเป็นรายหน้าแล้ว/);
  assert.equal(wb.state.editable, false);
});

test("toggling page ↔ PDF while the big PDF is still downloading: the late PDF is dropped, the label stays right and no blob URL leaks", async () => {
  let releasePdf: (response: FakeResponse) => void = () => undefined, holdPdf = true;
  const pdf = (): FakeResponse => ({ ...json(200, {}), blob: async () => ({ type: "application/pdf" }) });
  const blobs = { created: 0, revoked: 0 };
  const { wb, $ } = load(async (url, init) => token(url) ?? (url.includes(PARENT)
    ? holdPdf ? new Promise<FakeResponse>((resolve, reject) => {
      releasePdf = resolve;
      (init?.signal as AbortSignal | undefined)?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }) : pdf()
    : { ...json(200, {}), blob: async () => ({ type: "image/png" }) }), undefined, blobs);
  wb.applyDocument({ ...page12, structuredResult: { schemaVersion: 3, header: {}, customerInformation: {}, recommendationCard: {}, staffOnly: {} } });
  const toPdf = wb.toggleOriginal();           // the 44.8 MB parent PDF starts downloading
  await settle();
  const back = wb.toggleOriginal();            // the reviewer goes back to the page image before it arrived
  await back;
  assert.equal(($("p-content").children[0] as FakeElement).tagName, "IMG");
  releasePdf(pdf()); // arrives late (or was aborted)
  holdPdf = false;
  await toPdf.catch(() => undefined);
  await settle();
  assert.equal(($("p-content").children[0] as FakeElement).tagName, "IMG", "the superseded PDF never replaces the image");
  assert.equal($("p-pdf").textContent, "เปิด PDF ต้นฉบับ (หน้า 12)");
  assert.equal($("z-tools").hidden, false, "zoom tools belong to the image that is shown");
  assert.equal(blobs.created - blobs.revoked, 1, "only the URL on screen is alive");
  await wb.toggleOriginal();                   // now the PDF for real: the zoom tools hide (they cannot zoom an iframe)
  assert.equal(($("p-content").children[0] as FakeElement).tagName, "IFRAME");
  assert.equal($("z-tools").hidden, true);
  assert.equal(blobs.created - blobs.revoked, 1);
});

test("a missing original is explained by what is open; after a Retry re-renders the page the preview loads again", async () => {
  let pageImage = false;
  const { wb, $, fetches } = load(async (url) => token(url) ?? (url.endsWith("/content")
    ? (pageImage ? { ...json(200, {}), blob: async () => ({ type: "image/png" }) } : json(404, { error: "CONTENT_NOT_FOUND" }))
    : json(200, {})));
  const failedPage = { ...page12, status: "FAILED", statusCategory: "failed", errorMessage: "PAGE_RENDER_FAILED", summary: {} };
  wb.state.current = failedPage;
  await wb.loadPreview(wb.state.openSeq, ID);
  assert.match($("p-content").textContent, /แปลงหน้า PDF เป็นภาพไม่สำเร็จ กด "ลองอ่านอีกครั้ง"/);
  wb.state.current = { documentId: ID, filename: "a.png", mimeType: "image/png", status: "SUCCEEDED", statusCategory: "succeeded" };
  await wb.loadPreview(wb.state.openSeq, ID);
  assert.equal($("p-content").textContent, `โหลดต้นฉบับไม่ได้: ${wb.ERRORS.CONTENT_NOT_FOUND}`, "an image upload has no page to re-render and no retry: neutral text");
  assert.doesNotMatch(wb.ERRORS.CONTENT_NOT_FOUND ?? "", /ลองอีกครั้ง|PDF/);
  wb.state.current = { ...failedPage, status: "CLEAN", statusCategory: "queued", errorMessage: "" };
  await wb.loadPreview(wb.state.openSeq, ID);
  assert.match($("p-content").textContent, /กำลังแปลงหน้านี้เป็นภาพใหม่/, "retried, not re-rendered yet: no button to press");
  // The re-rendered page was read: the drawer swaps in the result and the preview is fetched again.
  pageImage = true;
  const before = fetches.filter((url) => url.endsWith("/content")).length;
  wb.applyDocument({ ...page12, structuredResult: { schemaVersion: 3, header: {}, customerInformation: {}, recommendationCard: {}, staffOnly: {} } });
  await settle();
  assert.equal(fetches.filter((url) => url.endsWith("/content")).length, before + 1);
  assert.equal(($("p-content").children[0] as FakeElement).tagName, "IMG");
});
