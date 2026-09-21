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
  renderBatch(): void;
  addFiles(files: unknown[]): void;
  loadPreview(seq: number, id: string): Promise<void>;
  save(): Promise<void>;
  ERRORS: Record<string, string>;
  state: { uploads: Upload[]; batch: unknown; batchId: string | null; current: unknown; draft: unknown; editable: boolean; openSeq: number; originalSig: string };
};

const inline = /<script\b[^>]*>([\s\S]*?)<\/script>/.exec(workbenchPage({ nonce: "n" }))?.[1] ?? "";
const EXPOSE = "globalThis.__wb={row,renderBatch,addFiles,loadPreview,save,ERRORS,state};";

/** Runs the workbench script without init(). `fetchImpl` answers every fetch; `xhrStatus` answers every upload. */
function load(fetchImpl: (url: string, init?: Record<string, unknown>) => Promise<FakeResponse>, xhr: { status: number; body: unknown } = { status: 202, body: {} }) {
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
  const context = createContext({
    document, window: { matchMedia: () => ({ matches: true }), addEventListener: () => undefined }, location: { href: "http://127.0.0.1/", search: "" },
    history: { replaceState: () => undefined }, CSS: { escape: (value: string) => value }, crypto: webcrypto, Node: { DOCUMENT_POSITION_PRECEDING: 2 },
    Option: class { constructor(readonly text: string, readonly value: string) {} }, URL, URLSearchParams, Blob, TextEncoder, AbortController,
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
