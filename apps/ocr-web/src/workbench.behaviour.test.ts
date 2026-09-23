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
  // Dialogs, inputs and checkboxes: the parts of the real DOM the login, password and users screens drive.
  open = false;
  value = "";
  checked = false;
  type = "";
  readOnly = false;
  maxLength = 0;
  spellcheck = false;
  autocomplete = "";
  placeholder = "";
  htmlFor = "";
  id = "";
  href: string | undefined;
  /** The parent is tracked so `remove()` behaves: the export's download anchor is appended and taken away again. */
  parent: FakeElement | null = null;
  clicks = 0;
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
  append(...nodes: Array<FakeElement | string>): void {
    for (const node of nodes) { const child = typeof node === "string" ? textNode(node) : node; child.parent = this; this.children.push(child); }
  }
  remove(): void { const index = this.parent?.children.indexOf(this) ?? -1; if (this.parent && index >= 0) this.parent.children.splice(index, 1); this.parent = null; }
  /** The real anchor's click is what starts the download; counting it keeps that path from going untested. */
  click(): void { this.clicks += 1; }
  replaceChildren(...nodes: Array<FakeElement | string>): void { this.children = []; this.ownText = ""; this.append(...nodes); }
  setAttribute(name: string, value: unknown): void { this.attributes.set(name, String(value)); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  hasAttribute(name: string): boolean { return this.attributes.has(name); }
  addEventListener(type: string, listener: Listener): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  /** Fires the handlers the script registered; `preventDefault` is supplied because every form handler calls it. */
  dispatch(type: string, event: Record<string, unknown> = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ preventDefault: () => undefined, stopPropagation: () => undefined, ...event });
  }
  showModal(): void { this.open = true; }
  close(): void { if (!this.open) return; this.open = false; this.dispatch("close"); }
  contains(node: unknown): boolean { return node === this || this.children.some((child) => child.contains(node)); }
  querySelector(): null { return null; }
  querySelectorAll(): FakeElement[] { return []; }
  focus(): void { /* no layout */ }
  scrollIntoView(): void { /* no layout */ }
  descendants(): FakeElement[] { return this.children.flatMap((child) => [child, ...child.descendants()]); }
}
function textNode(text: string): FakeElement { const node = new FakeElement("#text"); node.textContent = text; return node; }

type FakeResponse = { ok: boolean; status: number; headers: { get(name: string): string | null }; json(): Promise<unknown>; blob(): Promise<unknown> };
const json = (status: number, body: unknown): FakeResponse => ({
  ok: status >= 200 && status < 300, status, headers: { get: () => null },
  json: async () => body, blob: async () => ({ type: "application/pdf" })
});
type Upload = { status: string; retryable: boolean; error: string; group: { batchId: string | null; total: number } | null; file: { name: string } };
type Workbench = {
  wire(): void;
  init(): Promise<void>;
  checkSession(): Promise<unknown>;
  requireLogin(): Promise<unknown>;
  api(path: string, opts?: Record<string, unknown>): Promise<unknown>;
  loadDocuments(): Promise<void>;
  logout(): Promise<void>;
  openUsers(): void;
  openExportDialog(): void;
  downloadExport(): Promise<void>;
  applyUser(): void;
  renderHead(): void;
  reviewerLabel(by: unknown, name: unknown): string | null;
  row(document: Record<string, unknown>): FakeElement;
  applyDocument(document: Record<string, unknown>): void;
  failText(document: Record<string, unknown>): string;
  toggleOriginal(): Promise<void>;
  renderBatch(): void;
  addFiles(files: unknown[]): void;
  loadPreview(seq: number, id: string): Promise<void>;
  save(): Promise<void>;
  ERRORS: Record<string, string>;
  state: {
    uploads: Upload[]; batch: unknown; batchId: string | null; current: unknown; draft: unknown; editable: boolean;
    openSeq: number; originalSig: string; user: { id: string } | null; csrf: string; dirty: boolean; leaving: boolean;
    timer: number; users: unknown[]; tempPass: string; q: string; status: string; parentFilter: string; parentName: string;
    exQ: string; exParent: string; exTotal: number | null; exMax: number; batchFilter: string;
  };
};

const inline = /<script\b[^>]*>([\s\S]*?)<\/script>/.exec(workbenchPage({ nonce: "n" }))?.[1] ?? "";
const EXPOSE = "globalThis.__wb={wire,init,checkSession,requireLogin,api,loadDocuments,logout,openUsers,openExportDialog,downloadExport,applyUser,renderHead,reviewerLabel,"
  + "row,renderBatch,addFiles,loadPreview,save,ERRORS,state,applyDocument,failText,toggleOriginal};";

/** setTimeout/clearTimeout with no wall clock: a test decides when an armed timer fires (and can see that one is armed). */
class FakeClock {
  seq = 0;
  readonly timers = new Map<number, () => void>();
  readonly set = (fn: () => void): number => { this.seq += 1; this.timers.set(this.seq, fn); return this.seq; };
  readonly clear = (id: number): void => { this.timers.delete(id); };
  run(id: number): void { const fn = this.timers.get(id); this.timers.delete(id); fn?.(); }
}

type XhrAnswer = { status: number; body?: unknown; hang?: boolean };
type LoadOptions = { blobs?: { created: number; revoked: number }; narrow?: boolean };
type Sent = { headers: Record<string, string>; url: string };
type Call = { method: string; url: string; headers: Record<string, string>; body: string };

/** Runs the workbench script without init(). `fetchImpl` answers every fetch; `xhr` answers every upload. */
function load(fetchImpl: (url: string, init?: Record<string, unknown>) => Promise<FakeResponse>,
  xhr: XhrAnswer | ((index: number) => XhrAnswer) = { status: 202, body: {} }, options: LoadOptions = {}) {
  assert.ok(inline.endsWith("init();\n})();\n"), "the script still ends with init()");
  const elements = new Map<string, FakeElement>();
  const fetches: string[] = [];
  const calls: Call[] = [];
  const sent: Sent[] = [];
  const replaced: string[] = [];
  const clock = new FakeClock();
  let aborted = 0;
  let sends = 0;
  const body = new FakeElement("body");
  const document = {
    getElementById: (id: string) => { let element = elements.get(id); if (!element) { element = new FakeElement("div"); element.id = id; elements.set(id, element); } return element; },
    createElement: (tag: string) => new FakeElement(tag), createTextNode: textNode, activeElement: null, hidden: false,
    body, addEventListener: () => undefined, contains: () => true
  };
  class FakeXhr {
    status = 0; responseText = ""; timeout = 0;
    readonly headers: Record<string, string> = {};
    url = "";
    readonly listeners = new Map<string, () => void>();
    readonly upload = { addEventListener: () => undefined };
    open(_method: string, url: string): void { this.url = url; }
    setRequestHeader(name: string, value: string): void { this.headers[name] = value; }
    addEventListener(type: string, listener: () => void): void { this.listeners.set(type, listener); }
    abort(): void { aborted += 1; this.listeners.get("abort")?.(); }
    send(): void {
      sends += 1;
      const answer = typeof xhr === "function" ? xhr(sends) : xhr;
      sent.push({ headers: { ...this.headers }, url: this.url });
      if (answer.hang) return;
      queueMicrotask(() => {
        this.status = answer.status;
        this.responseText = JSON.stringify(answer.body ?? {});
        this.listeners.get(answer.status === 0 ? "error" : "load")?.();
      });
    }
  }
  // Counts blob URLs (`blobs`) so a test can see that none is left alive behind the preview.
  const blobs = options.blobs;
  const CountingURL = blobs ? Object.assign(class extends URL {}, {
    createObjectURL: (blob: Blob) => { blobs.created += 1; return URL.createObjectURL(blob); },
    revokeObjectURL: (url: string) => { blobs.revoked += 1; URL.revokeObjectURL(url); }
  }) : URL;
  const context = createContext({
    document,
    window: { matchMedia: (query: string) => ({ matches: query.includes("max-width") ? options.narrow === true : true }), addEventListener: () => undefined },
    location: { href: "http://127.0.0.1/", search: "", pathname: "/", replace: (url: string) => { replaced.push(url); } },
    history: { replaceState: () => undefined }, CSS: { escape: (value: string) => value }, crypto: webcrypto, Node: { DOCUMENT_POSITION_PRECEDING: 2 },
    Option: class { constructor(readonly text: string, readonly value: string) {} }, URL: CountingURL, URLSearchParams, Blob, TextEncoder, AbortController,
    setTimeout: clock.set, clearTimeout: clock.clear, XMLHttpRequest: FakeXhr,
    fetch: (url: string, init?: Record<string, unknown>) => {
      const method = String(init?.method ?? "GET");
      fetches.push(`${method} ${url}`);
      calls.push({ method, url, headers: { ...(init?.headers as Record<string, string> | undefined) }, body: String(init?.body ?? "") });
      return fetchImpl(url, init);
    }
  });
  new Script(inline.replace(/init\(\);\n\}\)\(\);\n$/, `${EXPOSE}\n})();\n`)).runInContext(context);
  return {
    wb: (context as { __wb: Workbench }).__wb, $: document.getElementById, fetches, calls, sent, replaced, clock, body,
    get aborted() { return aborted; },
    /** Every text the script has rendered anywhere, for the "no customer data is left on screen" assertions. */
    dom: () => [...elements.values()].map((element) => element.textContent).join("␟")
  };
}
const settle = async (): Promise<void> => { for (let index = 0; index < 30; index += 1) await new Promise((resolve) => setImmediate(resolve)); };
const ID = "10000000-0000-4000-8000-000000000001";

// ---- the session fake -----------------------------------------------------------------------------------------------

type SessionUser = { id: string; username: string; displayName: string; role: string; canExport: boolean; mustChangePassword: boolean };
const STAFF: SessionUser = { id: "11111111-1111-4111-8111-111111111111", username: "nok", displayName: "นก", role: "staff", canExport: false, mustChangePassword: false };
const ADMIN: SessionUser = { id: "22222222-2222-4222-8222-222222222222", username: "boss", displayName: "บอส", role: "admin", canExport: true, mustChangePassword: false };
const OTHER: SessionUser = { id: "33333333-3333-4333-8333-333333333333", username: "fon", displayName: "ฝน", role: "staff", canExport: false, mustChangePassword: false };
type Server = { user: SessionUser; csrf: string; sessionStatus: number; loginUser?: SessionUser };
const sessionBody = (user: SessionUser, csrf: string) => ({ user, csrfToken: csrf, idleMinutes: 30, expiresAt: "2026-09-23T12:00:00.000Z" });

type Routes = (url: string, init: Record<string, unknown>) => FakeResponse | null;
/** Answers the auth routes from `server` and the empty-list routes, and lets a test override anything else. */
function server(state: Server, routes: Routes = () => null) {
  return async (url: string, init?: Record<string, unknown>): Promise<FakeResponse> => {
    const method = String(init?.method ?? "GET");
    if (url === "/api/auth/session") return state.sessionStatus === 200 ? json(200, sessionBody(state.user, state.csrf)) : json(state.sessionStatus, { error: "UNAUTHENTICATED" });
    if (url === "/api/auth/login") { state.user = state.loginUser ?? state.user; return json(200, sessionBody(state.user, state.csrf)); }
    if (url === "/api/auth/logout") return json(204, {});
    const override = routes(url, init ?? {});
    if (override) return override;
    if (url.startsWith("/api/documents?")) return json(200, { documents: [], total: 0, limit: 50, offset: 0 });
    if (url === "/api/batches" && method === "POST") return json(201, { batchId: ID, expectedTotal: 1 });
    if (url.startsWith("/api/batches")) return json(200, { batches: [] });
    return json(200, {});
  };
}
/** Boots the page with a live session, then forgets the startup traffic so a case only sees its own. */
async function bootedIn(state: Server, routes?: Routes, xhr?: XhrAnswer | ((index: number) => XhrAnswer), options?: LoadOptions) {
  const ctx = load(server(state, routes), xhr, options);
  await ctx.wb.init();
  await settle();
  ctx.fetches.length = 0;
  ctx.calls.length = 0;
  return ctx;
}
function signIn(ctx: { $: (id: string) => FakeElement }, username = "nok", password = "not-a-real-password"): void {
  ctx.$("login-user").value = username;
  ctx.$("login-pass").value = password;
  ctx.$("login-form").dispatch("submit");
}

// ---- login and session ----------------------------------------------------------------------------------------------

test("a 401 on the session shows the login dialog and fetches no data", async () => {
  const state: Server = { user: STAFF, csrf: "csrf-1", sessionStatus: 401 };
  const ctx = load(server(state));
  void ctx.wb.init();
  await settle();
  assert.equal(ctx.$("auth-dlg").open, true);
  assert.deepEqual(ctx.fetches, ["GET /api/auth/session"], "nothing is loaded before there is a session");
  assert.equal(ctx.body.dataset.auth, "out");
});

test("a successful login closes the dialog, clears the password field and loads the workbench", async () => {
  const state: Server = { user: STAFF, csrf: "csrf-1", sessionStatus: 401 };
  const ctx = load(server(state));
  const started = ctx.wb.init();
  await settle();
  signIn(ctx);
  await settle();
  await started;
  assert.equal(ctx.$("auth-dlg").open, false);
  assert.equal(ctx.$("login-pass").value, "", "the password never lingers in the DOM");
  assert.equal(ctx.body.dataset.auth, "in");
  assert.equal(ctx.$("me-name").textContent, "นก");
  assert.ok(ctx.fetches.some((call) => call.startsWith("GET /api/documents?")));
  const login = ctx.calls.find((call) => call.url === "/api/auth/login");
  assert.equal(login?.method, "POST");
  assert.equal(login?.headers["Content-Type"], "application/json");
  assert.equal(JSON.parse(login?.body ?? "{}").password, "not-a-real-password");
});

test("a 401 mid-session opens the overlay; after the login the pending list load is retried exactly once", async () => {
  const state: Server = { user: STAFF, csrf: "csrf-1", sessionStatus: 200 };
  let listStatus = 200;
  const ctx = await bootedIn(state, (url) => url.startsWith("/api/documents?") && listStatus === 401 ? json(401, { error: "UNAUTHENTICATED" }) : null);
  listStatus = 401;
  const pending = ctx.wb.loadDocuments();
  await settle();
  assert.equal(ctx.$("auth-dlg").open, true);
  listStatus = 200;
  state.csrf = "csrf-2";
  signIn(ctx);
  await settle();
  await pending;
  assert.equal(ctx.fetches.filter((call) => call.startsWith("GET /api/documents?")).length, 2, "the 401 and its one retry; the restore does not load a second list");
  assert.equal(ctx.$("auth-dlg").open, false);
  assert.equal(ctx.wb.state.csrf, "csrf-2");
});

test("session expiry in the middle of a review: one retried save, the new CSRF token, and the draft untouched", async () => {
  const state: Server = { user: STAFF, csrf: "csrf-1", sessionStatus: 200 };
  let reviewStatus = 401;
  const ctx = await bootedIn(state, (url) => url.endsWith("/ocr/review")
    ? (reviewStatus === 401 ? json(401, { error: "UNAUTHENTICATED" }) : json(200, { status: "confirmed", delivery: "PENDING", corrections: 1 }))
    : null);
  ctx.wb.state.current = { documentId: ID, filename: "a.png", status: "NEEDS_REVIEW", statusCategory: "review", updatedAt: "2026-09-22T01:00:00.000Z" };
  ctx.wb.state.draft = { schemaVersion: 3, customerInformation: { name: { raw: "Anna", value: "Anna Smith", confidence: 1, source: "human", needsReview: false } }, recommendationCard: {}, staffOnly: {} };
  ctx.wb.state.editable = true;
  const before = JSON.stringify(ctx.wb.state.draft);
  const saving = ctx.wb.save();
  await settle();
  assert.equal(ctx.$("auth-dlg").open, true);
  reviewStatus = 200;
  state.csrf = "csrf-2";
  signIn(ctx);
  await settle();
  await saving;
  const posts = ctx.calls.filter((call) => call.url.endsWith("/ocr/review"));
  assert.equal(posts.length, 2, "the save is retried once, not resent on every 401");
  assert.equal(posts[0]?.headers["X-CSRF-Token"], "csrf-1");
  assert.equal(posts[1]?.headers["X-CSRF-Token"], "csrf-2");
  assert.equal(JSON.stringify(ctx.wb.state.draft), before, "the reviewer's edits survived the re-login");
});

test("a stale CSRF token is refreshed once from the session route; a 401 there opens the login dialog instead", async () => {
  const state: Server = { user: STAFF, csrf: "csrf-1", sessionStatus: 200 };
  let attempts = 0;
  const ctx = await bootedIn(state, (url) => {
    if (!url.endsWith("/ocr/review")) return null;
    attempts += 1;
    return attempts === 1 ? json(403, { error: "CSRF_REJECTED" }) : json(200, { status: "confirmed", delivery: "NOT_REQUIRED", corrections: 0 });
  });
  state.csrf = "csrf-2"; // another tab logged in: this tab's token is stale while its GETs keep working
  ctx.wb.state.current = { documentId: ID, filename: "a.png", status: "NEEDS_REVIEW", statusCategory: "review" };
  ctx.wb.state.draft = { schemaVersion: 3, customerInformation: {}, recommendationCard: {}, staffOnly: {} };
  ctx.wb.state.editable = true;
  await ctx.wb.save();
  await settle();
  assert.equal(ctx.$("auth-dlg").open, false, "the draft is never lost to a reload over a token refresh");
  assert.deepEqual(ctx.fetches.filter((call) => call.includes("/api/auth/session")), ["GET /api/auth/session"]);
  const posts = ctx.calls.filter((call) => call.url.endsWith("/ocr/review"));
  assert.deepEqual(posts.map((call) => call.headers["X-CSRF-Token"]), ["csrf-1", "csrf-2"]);

  const expired: Server = { user: STAFF, csrf: "csrf-1", sessionStatus: 200 };
  const second = await bootedIn(expired, (url) => url.endsWith("/ocr/review") ? json(403, { error: "CSRF_REJECTED" }) : null);
  expired.sessionStatus = 401;
  second.wb.state.current = { documentId: ID, filename: "a.png", status: "NEEDS_REVIEW", statusCategory: "review" };
  second.wb.state.draft = { schemaVersion: 3, customerInformation: {}, recommendationCard: {}, staffOnly: {} };
  second.wb.state.editable = true;
  void second.wb.save();
  await settle();
  assert.equal(second.$("auth-dlg").open, true);
});

test("an upload that meets a 401 waits for the login and is resent once with the same Idempotency-Key", async () => {
  const state: Server = { user: STAFF, csrf: "csrf-1", sessionStatus: 200 };
  let uploadStatus = 401;
  const ctx = await bootedIn(state, undefined, () => uploadStatus === 401 ? { status: 401, body: { error: "UNAUTHENTICATED" } } : { status: 202, body: { documentId: ID } });
  ctx.wb.addFiles([{ name: "a.pdf", size: 10, type: "application/pdf" }]);
  await settle();
  assert.equal(ctx.wb.state.uploads[0]?.status, "authwait", "the file waits instead of failing");
  assert.equal(ctx.$("up-list").textContent.includes("รอเข้าสู่ระบบ"), true);
  assert.equal(ctx.$("auth-dlg").open, true);
  uploadStatus = 202;
  state.csrf = "csrf-2";
  signIn(ctx);
  await settle();
  assert.equal(ctx.wb.state.uploads[0]?.status, "done");
  assert.equal(ctx.sent.length, 2);
  assert.equal(ctx.sent[0]?.headers["Idempotency-Key"], ctx.sent[1]?.headers["Idempotency-Key"]);
  assert.equal(ctx.sent[1]?.headers["X-CSRF-Token"], "csrf-2");
});

test("a different user logging in sends nothing further: the XHR is aborted, the queue is cancelled and the page reloads", async () => {
  const state: Server = { user: STAFF, csrf: "csrf-1", sessionStatus: 200, loginUser: OTHER };
  const ctx = await bootedIn(state, undefined, (index) => index === 1 ? { status: 0, hang: true } : { status: 401, body: { error: "UNAUTHENTICATED" } });
  ctx.wb.state.dirty = true;
  ctx.wb.addFiles([{ name: "a.pdf", size: 10, type: "application/pdf" }, { name: "b.pdf", size: 10, type: "application/pdf" }]);
  await settle();
  assert.equal(ctx.$("auth-dlg").open, true);
  state.csrf = "csrf-b";
  signIn(ctx, "fon");
  await settle();
  const afterLogin = ctx.fetches.slice(ctx.fetches.lastIndexOf("POST /api/auth/login") + 1);
  assert.deepEqual(afterLogin, [], "nothing may go out carrying user B's cookie and CSRF token");
  assert.equal(ctx.aborted, 1, "the upload still on the wire is aborted");
  assert.equal(ctx.wb.state.uploads[1]?.status, "cancelled");
  assert.match(ctx.wb.state.uploads[1]?.error ?? "", /เปลี่ยนผู้ใช้/);
  assert.equal(ctx.wb.state.dirty, false, "user A's draft is not offered to user B");
  assert.equal(ctx.wb.state.leaving, true, "the beforeunload guard is off, so B cannot click Stay into A's draft");
  assert.deepEqual(ctx.replaced, ["/"]);
});

test("polling re-arms after a login: an armed tick that fires during the wait does not end the 3/15 s chain", async () => {
  const state: Server = { user: STAFF, csrf: "csrf-1", sessionStatus: 200 };
  let listStatus = 200;
  const ctx = await bootedIn(state, (url) => url.startsWith("/api/documents?") && listStatus === 401 ? json(401, { error: "UNAUTHENTICATED" }) : null);
  const armed = ctx.wb.state.timer;
  assert.ok(armed !== 0 && ctx.clock.timers.has(armed), "startup armed the polling chain");
  listStatus = 401;
  const pending = ctx.wb.loadDocuments();
  await settle();
  assert.equal(ctx.$("auth-dlg").open, true);
  ctx.clock.run(armed); // the already-armed tick fires while the login dialog is open
  await settle();
  assert.equal(ctx.wb.state.timer, 0, "polling stops while the login is open");
  listStatus = 200;
  signIn(ctx);
  await settle();
  await pending;
  assert.notEqual(ctx.wb.state.timer, 0);
  assert.ok(ctx.clock.timers.has(ctx.wb.state.timer), "the list keeps refreshing itself after the re-login");
});

test("only polling marks its calls X-OCR-Background; a user action never does", async () => {
  // The header decides whether the request moves the idle deadline (§5 C4). If a user action ever carried it, staff
  // would be logged out 30 minutes into a shift no matter how hard they were working.
  const state: Server = { user: STAFF, csrf: "csrf-1", sessionStatus: 200 };
  const ctx = await bootedIn(state, (url) => url.startsWith("/api/documents/") ? json(200, { document: { documentId: ID, filename: "a.png", status: "QUEUED", statusCategory: "queued" } }) : null);
  ctx.wb.state.batchId = ID;
  ctx.$("drawer").open = true;
  ctx.wb.state.current = { documentId: ID, filename: "a.png", status: "QUEUED", statusCategory: "queued" };
  ctx.clock.run(ctx.wb.state.timer);
  await settle();
  const polled = ctx.calls.filter((call) => call.url.startsWith("/api/"));
  assert.equal(polled.length, 3, "the list, the batch and the open drawer");
  for (const call of polled) assert.equal(call.headers["X-OCR-Background"], "1", call.url);
  ctx.calls.length = 0;
  await ctx.wb.loadDocuments();
  await settle();
  const byHand = ctx.calls.filter((call) => call.url.startsWith("/api/"));
  assert.equal(byHand.length, 1);
  assert.equal(byHand[0]?.headers["X-OCR-Background"], undefined, "the same function, called by a user, keeps the session alive");
});

test("the login overlay holds no customer data, and the draft behind it comes back", async () => {
  const state: Server = { user: STAFF, csrf: "csrf-1", sessionStatus: 200 };
  let listStatus = 200;
  const rows = { documents: [{ documentId: ID, filename: "intake.png", status: "NEEDS_REVIEW", statusCategory: "review", createdAt: "2026-09-22T01:00:00.000Z", summary: { customerName: "สมหญิง ใจดี", treatments: [] } }], total: 1 };
  const ctx = await bootedIn(state, (url) => url.startsWith("/api/documents?") ? (listStatus === 401 ? json(401, { error: "UNAUTHENTICATED" }) : json(200, rows)) : null);
  await ctx.wb.loadDocuments();
  ctx.$("drawer").open = true;
  ctx.wb.applyDocument({ documentId: ID, filename: "intake.png", status: "NEEDS_REVIEW", statusCategory: "review",
    structuredResult: { schemaVersion: 3, header: {}, customerInformation: { name: { raw: "สมหญิง ใจดี", value: "สมหญิง ใจดี", confidence: 0.4, source: "ocr", needsReview: true } }, recommendationCard: {}, staffOnly: {} } });
  ctx.wb.state.dirty = true;
  assert.match(ctx.dom(), /สมหญิง ใจดี/, "the name is on screen before the session expires");
  listStatus = 401;
  const pending = ctx.wb.loadDocuments();
  await settle();
  assert.equal(ctx.$("auth-dlg").open, true);
  assert.doesNotMatch(ctx.dom(), /สมหญิง ใจดี/, "an opaque backdrop is not enough: nothing readable may be left in the DOM");
  assert.ok(ctx.wb.state.draft, "the draft itself survives in memory");
  listStatus = 200;
  signIn(ctx);
  await settle();
  await pending;
  assert.match(ctx.dom(), /สมหญิง ใจดี/, "the same user gets the rows and the draft back");
});

test("after a re-login the drawer head comes back even though the dirty draft blocks the reload", async () => {
  const state: Server = { user: STAFF, csrf: "csrf-1", sessionStatus: 200 };
  let listStatus = 200;
  const ctx = await bootedIn(state, (url) => url.startsWith("/api/documents?") && listStatus === 401 ? json(401, { error: "UNAUTHENTICATED" }) : null);
  ctx.$("drawer").open = true;
  ctx.wb.applyDocument({ documentId: ID, filename: "intake-p12.png", parentDocumentId: "20000000-0000-4000-8000-000000000002",
    parentFilename: "intake.pdf", pageNumber: 12, pageCount: 95, status: "NEEDS_REVIEW", statusCategory: "review",
    structuredResult: { schemaVersion: 3, header: {}, customerInformation: {}, recommendationCard: {}, staffOnly: {} } });
  assert.equal(ctx.$("d-title").textContent, "intake.pdf · หน้า 12/95");
  ctx.wb.state.dirty = true;
  listStatus = 401;
  const pending = ctx.wb.loadDocuments();
  await settle();
  assert.equal(ctx.$("auth-dlg").open, true);
  assert.equal(ctx.$("d-title").textContent, "กำลังโหลด…", "the head is cleared with the rest of the customer data");
  listStatus = 200;
  signIn(ctx);
  await settle();
  await pending;
  // loadReview() returns early while the draft is dirty, so nothing else would ever repair the head.
  assert.equal(ctx.$("d-title").textContent, "intake.pdf · หน้า 12/95", "the reviewer sees which page they are editing");
  assert.equal(ctx.$("d-draft").textContent, "มีการแก้ไขที่ยังไม่ได้บันทึก");
  assert.equal(ctx.$("p-pdf").hidden, false);
  assert.equal(ctx.$("p-pdf").textContent, "เปิด PDF ต้นฉบับ (หน้า 12)", "the preview is the page image again, so the link offers the parent");
});

test("logging out with an upload in flight asks first, then revokes the session and reloads", async () => {
  const state: Server = { user: STAFF, csrf: "csrf-1", sessionStatus: 200 };
  const ctx = await bootedIn(state, undefined, { status: 0, hang: true });
  ctx.wb.addFiles([{ name: "a.pdf", size: 10, type: "application/pdf" }]);
  await settle();
  ctx.fetches.length = 0; // the batch the upload created
  const leaving = ctx.wb.logout();
  await settle();
  assert.equal(ctx.$("confirm-dlg").open, true, "a real top-level dialog, not the drawer's inert ask overlay");
  assert.equal(ctx.$("cf-yes").textContent, "ออกจากระบบ");
  assert.deepEqual(ctx.fetches, [], "nothing is sent before the answer");
  ctx.$("cf-yes").dispatch("click");
  await leaving;
  assert.equal(ctx.$("confirm-dlg").open, false);
  assert.deepEqual(ctx.fetches, ["POST /api/auth/logout"]);
  assert.deepEqual(ctx.replaced, ["/"]);
  assert.equal(ctx.aborted, 1);
});

// ---- password and users ---------------------------------------------------------------------------------------------

test("a forced password change blocks the workbench, cannot be dismissed, and still offers ออกจากระบบ", async () => {
  const state: Server = { user: { ...STAFF, mustChangePassword: true }, csrf: "csrf-1", sessionStatus: 200 };
  const ctx = load(server(state, (url) => url === "/api/auth/password" ? json(200, sessionBody({ ...STAFF, mustChangePassword: false }, "csrf-2")) : null));
  const started = ctx.wb.init();
  await settle();
  assert.equal(ctx.$("pw-dlg").open, true);
  assert.equal(ctx.$("pw-current-box").hidden, true, "the temporary password was typed seconds ago");
  assert.equal(ctx.$("pw-cancel").hidden, true);
  assert.equal(ctx.$("pw-logout").hidden, false, "otherwise the wrong account has no way out but closing the tab");
  ctx.$("pw-dlg").dispatch("cancel");
  assert.equal(ctx.$("pw-dlg").open, true, "Escape does not dismiss it");
  assert.equal(ctx.fetches.some((call) => call.startsWith("GET /api/documents?")), false, "nothing loads while the change is pending");
  ctx.$("pw-new").value = "ผ้าขนหนูสีฟ้า 42";
  ctx.$("pw-confirm").value = "ผ้าขนหนูสีฟ้า 42";
  ctx.$("pw-form").dispatch("submit");
  await settle();
  await started;
  const sentBody = JSON.parse(ctx.calls.find((call) => call.url === "/api/auth/password")?.body ?? "{}");
  assert.deepEqual(Object.keys(sentBody), ["newPassword"]);
  assert.equal(ctx.$("pw-dlg").open, false);
  assert.equal(ctx.wb.state.csrf, "csrf-2", "the rotated session's token replaces the old one");
  assert.ok(ctx.fetches.some((call) => call.startsWith("GET /api/documents?")));
});

test("a voluntary password change asks for the current password and reports the server's refusal", async () => {
  const state: Server = { user: STAFF, csrf: "csrf-1", sessionStatus: 200 };
  const ctx = await bootedIn(state, (url) => url === "/api/auth/password" ? json(400, { error: "PASSWORD_UNCHANGED" }) : null);
  ctx.$("pw-open").dispatch("click");
  assert.equal(ctx.$("pw-dlg").open, true);
  assert.equal(ctx.$("pw-current-box").hidden, false);
  ctx.$("pw-new").value = "ผ้าขนหนูสีฟ้า 42";
  ctx.$("pw-confirm").value = "ผ้าขนหนูสีเขียว 42";
  ctx.$("pw-form").dispatch("submit");
  await settle();
  assert.equal(ctx.$("pw-error").textContent, "รหัสผ่านใหม่ทั้งสองช่องไม่ตรงกัน");
  assert.deepEqual(ctx.fetches, [], "a typo never reaches the server");
  ctx.$("pw-confirm").value = "ผ้าขนหนูสีฟ้า 42";
  ctx.$("pw-current").value = "not-a-real-password";
  ctx.$("pw-form").dispatch("submit");
  await settle();
  assert.equal(ctx.$("pw-error").textContent, ctx.wb.ERRORS.PASSWORD_UNCHANGED);
  assert.equal(ctx.$("pw-dlg").open, true);
});

test("staff never see the user administration entry points", async () => {
  const staff = await bootedIn({ user: STAFF, csrf: "csrf-1", sessionStatus: 200 });
  assert.equal(staff.$("users-open").hidden, true);
  assert.equal(staff.$("me-users").hidden, true);
  const admin = await bootedIn({ user: ADMIN, csrf: "csrf-1", sessionStatus: 200 });
  assert.equal(admin.$("users-open").hidden, false);
  assert.equal(admin.$("me-users").hidden, false);
});

test("an admin row action asks through confirm-dlg and then posts the change (the drawer's ask would hang)", async () => {
  const users = [
    { id: ADMIN.id, username: "boss", displayName: "บอส", role: "admin", canExport: true, status: "active", lockedUntil: null, lastLoginAt: "2026-09-22T01:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: STAFF.id, username: "nok", displayName: "นก", role: "staff", canExport: false, status: "locked", lockedUntil: "2026-09-23T01:00:00.000Z", lastLoginAt: null, createdAt: "2026-02-01T00:00:00.000Z" }
  ];
  const state: Server = { user: ADMIN, csrf: "csrf-1", sessionStatus: 200 };
  const ctx = await bootedIn(state, (url, init) => url === "/api/users" && String(init.method ?? "GET") === "GET" ? json(200, { users }) : null);
  ctx.$("users-open").dispatch("click");
  await settle();
  assert.equal(ctx.$("users-dlg").open, true);
  const rows = ctx.$("users-rows").children;
  assert.equal(rows.length, 2);
  const labels = (row: FakeElement) => row.descendants().filter((node) => node.tagName === "BUTTON").map((node) => node.textContent);
  assert.equal(labels(rows[0]!).includes("รีเซ็ตรหัสผ่าน"), false, "a self reset would revoke your session and hide the one-time password");
  assert.equal(labels(rows[0]!).includes("ปลดล็อก"), false);
  assert.deepEqual(labels(rows[1]!), ["รีเซ็ตรหัสผ่าน", "ปลดล็อก", "ปิดใช้งาน", "เปลี่ยนเป็นผู้ดูแล", "อนุญาตส่งออก"]);
  assert.match(rows[1]!.textContent, /ถูกล็อกชั่วคราว/);
  const disable = rows[1]!.descendants().find((node) => node.textContent === "ปิดใช้งาน");
  disable?.dispatch("click");
  await settle();
  assert.equal(ctx.$("confirm-dlg").open, true);
  ctx.$("cf-yes").dispatch("click");
  await settle();
  const post = ctx.calls.find((call) => call.url === `/api/users/${STAFF.id}`);
  assert.equal(post?.method, "POST");
  assert.equal(post?.body, JSON.stringify({ disabled: true }));
  assert.equal(post?.headers["X-CSRF-Token"], "csrf-1");
  assert.equal(ctx.$("confirm-dlg").open, false, "the promise resolved: the drawer-scoped ask would have hung here");
  assert.equal(ctx.fetches.filter((call) => call === "GET /api/users").length, 2, "the list is reloaded from the server");
});

test("a temporary password is shown once and leaves the DOM when the dialog closes", async () => {
  const state: Server = { user: ADMIN, csrf: "csrf-1", sessionStatus: 200 };
  const created = { id: OTHER.id, username: "fon", displayName: "ฝน", role: "staff", canExport: false, status: "must_change", lockedUntil: null, lastLoginAt: null, createdAt: "2026-09-23T00:00:00.000Z" };
  const ctx = await bootedIn(state, (url, init) => url === "/api/users" && String(init.method ?? "GET") === "POST"
    ? json(201, { user: created, temporaryPassword: "aaaa-bbbb-cccc-dddd" }) : url === "/api/users" ? json(200, { users: [created] }) : null);
  ctx.$("users-open").dispatch("click");
  await settle();
  ctx.$("nu-name").value = "fon";
  ctx.$("nu-display").value = "ฝน";
  ctx.$("nu-role").value = "staff";
  ctx.$("user-form").dispatch("submit");
  await settle();
  assert.equal(ctx.$("temp-box").hidden, false);
  assert.equal(ctx.$("temp-pass").textContent, "aaaa-bbbb-cccc-dddd");
  assert.equal(ctx.$("nu-name").value, "", "the form is cleared so the next admin does not resend it");
  ctx.$("users-dlg").close();
  assert.equal(ctx.$("temp-pass").textContent, "");
  assert.equal(ctx.$("temp-box").hidden, true);
  assert.equal(ctx.wb.state.tempPass, "");
});

// ---- the login form itself ------------------------------------------------------------------------------------------

test("a non-ASCII username explains the keyboard layout, and the reveal toggle flips the password field", () => {
  const ctx = load(() => new Promise(() => undefined));
  ctx.wb.wire();
  ctx.$("login-pass").type = "password"; // as the markup declares it (workbench.test.ts asserts that statically)
  ctx.$("login-user").value = "นก";
  ctx.$("login-user").dispatch("input");
  assert.equal(ctx.$("login-hint").hidden, false, "a Thai layout would otherwise burn throttle attempts on INVALID_CREDENTIALS");
  ctx.$("login-user").value = "nok";
  ctx.$("login-user").dispatch("input");
  assert.equal(ctx.$("login-hint").hidden, true);
  ctx.$("login-reveal").dispatch("click");
  assert.equal(ctx.$("login-pass").type, "text");
  assert.equal(ctx.$("login-reveal").textContent, "ซ่อนรหัสผ่าน");
  assert.equal(ctx.$("login-reveal").getAttribute("aria-pressed"), "true");
  ctx.$("login-reveal").dispatch("click");
  assert.equal(ctx.$("login-pass").type, "password");
});

test("at phone width the header collapses to one pill instead of a name, a badge and three buttons", () => {
  const wide = load(() => new Promise(() => undefined));
  wide.wb.wire();
  wide.wb.state.user = { ...ADMIN } as unknown as { id: string };
  wide.wb.applyUser();
  assert.equal(wide.$("me").hidden, false);
  assert.equal(wide.$("me-open").hidden, true);
  const small = load(() => new Promise(() => undefined), undefined, { narrow: true });
  small.wb.wire();
  small.wb.state.user = { ...ADMIN } as unknown as { id: string };
  small.wb.applyUser();
  assert.equal(small.$("me").hidden, true, "a name, a badge and three pills would push the 56px header past 375px");
  assert.equal(small.$("me-open").hidden, false);
  // The name goes into the element the ≤720px rules cap, not into the nowrap button itself: a long Thai display name
  // would otherwise widen the 56px header past the viewport and give the whole page a horizontal scrollbar.
  assert.equal(small.$("me-open-name").textContent, "บอส");
});

// ---- attribution in the drawer ---------------------------------------------------------------------------------------

test("the drawer names who confirmed a document, and labels the pre-login shared account", () => {
  const ctx = load(() => new Promise(() => undefined));
  const base = { documentId: ID, filename: "a.png", mimeType: "image/png", status: "SUCCEEDED", statusCategory: "confirmed", reviewedAt: "2026-09-22T03:00:00.000Z",
    structuredResult: { schemaVersion: 3, header: {}, customerInformation: {}, recommendationCard: {}, staffOnly: {} } };
  ctx.wb.applyDocument({ ...base, reviewedBy: STAFF.id, reviewedByName: "นก" });
  assert.match(ctx.$("d-status").textContent, /ยืนยันโดย นก · /);
  ctx.wb.applyDocument({ ...base, reviewedBy: "front-desk", reviewedByName: null });
  assert.match(ctx.$("d-status").textContent, /ยืนยันโดย บัญชีรวม \(ก่อนมีระบบล็อกอิน\) · /);
  assert.equal(ctx.wb.reviewerLabel(null, null), null, "a document that was never confirmed names nobody");
  assert.equal(ctx.wb.reviewerLabel("front-desk", ""), "บัญชีรวม (ก่อนมีระบบล็อกอิน)");
});

// ---- release 1 behaviour, unchanged by login ---------------------------------------------------------------------------

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
  const { wb, $, fetches } = load(async () => json(409, { error: "DOCUMENT_QUARANTINED" }));
  wb.state.current = { documentId: ID, status: "QUARANTINED" };
  await wb.loadPreview(wb.state.openSeq, ID);
  assert.deepEqual(fetches, []);
  assert.equal($("p-content").textContent, wb.ERRORS.DOCUMENT_QUARANTINED);
  wb.state.current = { documentId: ID }; // deep link: status not known yet, the server refuses
  await wb.loadPreview(wb.state.openSeq, ID);
  assert.deepEqual(fetches, [`GET /api/documents/${ID}/content`], "no credential is minted before a call any more");
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
  assert.deepEqual(fetches, ["POST /api/batches"], "one batch for the whole selection; nothing else is sent");
});

test("deterministic upload rejections get no retry button; network failures do", async () => {
  const api = async (url: string) => json(url === "/api/batches" ? 201 : 200, url === "/api/batches" ? { batchId: ID, expectedTotal: 1 } : { batches: [] });
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
  const { wb, $ } = load(() => new Promise((resolve) => { answer = resolve; }));
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

test("a reopened round shows '—' until its first claim, then counts from that claim and from the round's completions", () => {
  const { wb, $ } = load(() => new Promise(() => undefined));
  // Uploaded hours ago, one page retried just now: the retry is queued and the server has no duration to give yet.
  const reopened = { batchId: ID, label: null, createdAt: "2026-09-22T01:00:00.000Z", expectedTotal: 1, uploaded: 1,
    rows: 95, pages: 95, pagesExpected: 95, splitting: 0, rowsExpected: 95, queued: 1, processing: 0, succeeded: 93,
    needsReview: 0, failed: 1, confirmed: 0, completed: 94, finished: false, finishedAt: null, durationMs: null,
    throughputPerMinute: null, roundOpenedAt: "2026-09-22T05:00:00.000Z", roundStartedAt: null, roundCompleted: 0 };
  wb.state.batchId = ID;
  wb.state.batch = reopened;
  wb.renderBatch();
  const waiting = $("batch-stats").textContent;
  assert.match(waiting, /เวลาที่ใช้—/, "a fallback to createdAt would print the four idle hours since the upload");
  assert.match(waiting, /หน้า\/นาที—/, "and a rate near 0 beside it — the Release 1 symptom this carry-over removes");
  assert.doesNotMatch(waiting, /เอกสาร\/นาที/, "the rows are pages: one PDF is 95 of them");
  assert.match($("batch-meta").textContent, /รอเริ่มอ่านรอบใหม่/);
  // The worker claimed it: the server sends the round's own duration and rate, and the meta line names the round.
  wb.state.batch = { ...reopened, queued: 0, processing: 0, succeeded: 94, completed: 95, finished: true,
    finishedAt: "2026-09-22T05:03:00.000Z", durationMs: 120_000, throughputPerMinute: 0.5,
    roundStartedAt: "2026-09-22T05:01:00.000Z", roundCompleted: 1 };
  wb.renderBatch();
  assert.match($("batch-stats").textContent, /เวลาที่ใช้2:00/);
  assert.match($("batch-stats").textContent, /หน้า\/นาที0\.5/);
  assert.match($("batch-meta").textContent, /รอบอ่านใหม่ เริ่ม /);
  // No server numbers (a poll between rounds): the client falls back to the round's start and the round's completions.
  wb.state.batch = { ...reopened, queued: 0, processing: 1, succeeded: 94, completed: 95, durationMs: null,
    throughputPerMinute: null, roundStartedAt: new Date(Date.now() - 120_000).toISOString(), roundCompleted: 1 };
  wb.renderBatch();
  assert.match($("batch-stats").textContent, /เวลาที่ใช้2:0\d/, "the fallback start is the round's first claim, not createdAt");
  assert.match($("batch-stats").textContent, /หน้า\/นาที0\.5/, "the fallback rate counts the round's completions, not all 95");
});

test("the drawer of a page is titled 'file.pdf · หน้า 12/95' and opens the original PDF at that page", async () => {
  const { wb, $, fetches } = load(async () => json(200, {}));
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
  const { wb, $ } = load(async (url, init) => (url.includes(PARENT)
    ? holdPdf ? new Promise<FakeResponse>((resolve, reject) => {
      releasePdf = resolve;
      (init?.signal as AbortSignal | undefined)?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }) : pdf()
    : { ...json(200, {}), blob: async () => ({ type: "image/png" }) }), undefined, { blobs });
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
  const { wb, $, fetches } = load(async (url) => (url.endsWith("/content")
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

// ---- the export dialog (§10 H6) -------------------------------------------------------------------------------------

const EXPORT_PREVIEW = {
  columns: [{ key: "original_file_name", label: "ชื่อไฟล์ต้นฉบับ" }, { key: "page", label: "หน้า" },
    { key: "page_count", label: "จำนวนหน้า" }, { key: "uploaded_at", label: "อัปโหลดเมื่อ" }],
  total: 240, maxRows: 50_000,
  rows: [["ใบลูกค้า 22-09-2026.pdf", "3", "95", "2026-09-22 14:05:00"]]
};
const previewRoutes = (body: unknown = EXPORT_PREVIEW): Routes =>
  (url) => url.startsWith("/api/exports/preview") ? json(200, body) : null;
/** The dialog's preview is debounced, so a case fires whatever timer the script armed last. */
function runLastTimer(ctx: { clock: FakeClock }): void {
  const id = [...ctx.clock.timers.keys()].at(-1);
  if (id !== undefined) ctx.clock.run(id);
}

test("the ส่งออก pill follows the EFFECTIVE export right, not the raw can_export flag", async () => {
  const staff = await bootedIn({ user: STAFF, csrf: "csrf-1", sessionStatus: 200 });
  assert.equal(staff.$("export-open").hidden, true, "a staff account without the flag has no way in");
  const exporter = await bootedIn({ user: { ...STAFF, canExport: true }, csrf: "csrf-1", sessionStatus: 200 });
  assert.equal(exporter.$("export-open").hidden, false);
  // D8: the admin role carries export by itself, and `ocr-users create-admin` writes can_export = false — the
  // bootstrap admin must still see the button, which is the whole of the reported "the only admin cannot export".
  const admin = await bootedIn({ user: { ...ADMIN, canExport: false }, csrf: "csrf-1", sessionStatus: 200 });
  assert.equal(admin.$("export-open").hidden, false);
});

test("the preview table shows the file's own cells: the original name first, 3 in หน้า and 95 in จำนวนหน้า", async () => {
  const ctx = await bootedIn({ user: ADMIN, csrf: "csrf-1", sessionStatus: 200 }, previewRoutes());
  ctx.wb.openExportDialog();
  await settle();
  assert.equal(ctx.$("export-dlg").open, true);
  assert.deepEqual(ctx.$("ex-head").children.map((cell) => cell.textContent), ["ชื่อไฟล์ต้นฉบับ", "หน้า", "จำนวนหน้า", "อัปโหลดเมื่อ"]);
  const cells = ctx.$("ex-rows").children[0]!.children;
  assert.deepEqual(cells.map((cell) => cell.textContent), ["ใบลูกค้า 22-09-2026.pdf", "3", "95", "2026-09-22 14:05:00"]);
  // pageLabel() is deliberately not reused: it returns the prefixed "หน้า 3/95", which would make the preview's หน้า
  // column differ from the downloaded file's while จำนวนหน้า repeated the same 95.
  assert.equal((cells[1] as FakeElement & { title?: string }).title, "หน้า 3/95");
  assert.equal(ctx.$("ex-count").textContent, "พบ 240 แถว · แสดง 1 แถวแรก");
  assert.equal(ctx.$("ex-download").disabled, false);
  assert.equal(ctx.$("ex-limit").textContent, "");
});

test("the inherited search and PDF filters are removable chips that narrow only the export", async () => {
  const ctx = await bootedIn({ user: ADMIN, csrf: "csrf-1", sessionStatus: 200 }, previewRoutes());
  ctx.wb.state.q = "สมชาย";
  ctx.wb.state.status = "confirmed";
  ctx.wb.state.parentFilter = ID;
  ctx.wb.state.parentName = "ใบลูกค้า 22-09-2026.pdf";
  ctx.wb.openExportDialog();
  await settle();
  const first = ctx.calls.find((call) => call.url.startsWith("/api/exports/preview"))!.url;
  assert.match(first, /q=%E0%B8%AA/, "the page's search still applies unless it is removed");
  assert.ok(first.includes(`parentId=${ID}`));
  assert.ok(first.includes("status=confirmed"), "the page's status checkbox is pre-ticked");
  assert.ok(first.includes("dateField=created_at") && first.includes("columns=compact"));
  const chips = ctx.$("ex-chips");
  assert.equal(chips.hidden, false);
  assert.deepEqual(chips.children.map((chip) => chip.children[0]!.textContent),
    ["ค้นหา: สมชาย", "เฉพาะหน้าของ ใบลูกค้า 22-09-2026.pdf"]);
  ctx.calls.length = 0;
  chips.children[0]!.descendants().find((node) => node.tagName === "BUTTON")!.dispatch("click");
  runLastTimer(ctx);
  await settle();
  const second = ctx.calls.find((call) => call.url.startsWith("/api/exports/preview"))!.url;
  assert.ok(!second.includes("q="), "the chip is gone, so the file is no longer narrowed by it");
  assert.ok(second.includes(`parentId=${ID}`), "the other chip is untouched");
  assert.equal(ctx.wb.state.q, "สมชาย", "and the page's own filter is unchanged");
});

test("more rows than OCR_EXPORT_MAX_ROWS disables the download and says so in Thai", async () => {
  const ctx = await bootedIn({ user: ADMIN, csrf: "csrf-1", sessionStatus: 200 },
    previewRoutes({ ...EXPORT_PREVIEW, total: 60_000, maxRows: 50_000 }));
  ctx.wb.openExportDialog();
  await settle();
  assert.equal(ctx.$("ex-download").disabled, true);
  assert.equal(ctx.$("ex-limit").textContent, "เกิน 50000 แถว กรุณาเลือกช่วงวันที่ให้แคบลง");
  assert.equal(ctx.wb.state.exTotal, 60_000);
});

test("an empty result disables the download instead of handing over an empty file", async () => {
  const ctx = await bootedIn({ user: ADMIN, csrf: "csrf-1", sessionStatus: 200 },
    previewRoutes({ ...EXPORT_PREVIEW, total: 0, rows: [] }));
  ctx.wb.openExportDialog();
  await settle();
  assert.equal(ctx.$("ex-download").disabled, true);
  assert.equal(ctx.$("ex-limit").textContent, "ไม่มีเอกสารที่ตรงกับตัวกรองนี้");
});

test("the download goes through the session cookie and releases its blob URL", async () => {
  const blobs = { created: 0, revoked: 0 };
  const state: Server = { user: ADMIN, csrf: "csrf-1", sessionStatus: 200 };
  const download = (url: string): FakeResponse | null => url.startsWith("/api/exports/documents.csv")
    ? { ok: true, status: 200, headers: { get: (name) => name === "content-disposition" ? 'attachment; filename="ocr-export-20260922-1405.csv"' : null },
      json: async () => ({}), blob: async () => new Blob(["﻿a,b\r\n"]) }
    : null;
  const ctx = load(server(state, (url) => download(url) ?? previewRoutes()(url, {})), undefined, { blobs });
  await ctx.wb.init();
  await settle();
  ctx.wb.openExportDialog();
  await settle();
  const armed = [...ctx.clock.timers.keys()];
  ctx.$("ex-download").dispatch("click");
  await settle();
  const call = ctx.calls.find((entry) => entry.url.startsWith("/api/exports/documents.csv"));
  assert.ok(call, "the file is fetched, not linked: a plain <a href> would carry no credentials check we can retry");
  assert.equal(call.method, "GET");
  // The anchor is in the document when it is clicked and gone afterwards, and the blob URL outlives the click by a
  // turn: a detached anchor and a same-tick revoke are only reliable in Chromium.
  const anchors = ctx.body.children.filter((node) => node.tagName === "A");
  assert.deepEqual(anchors, [], "the anchor does not stay in the document");
  assert.deepEqual([blobs.created, blobs.revoked], [1, 0], "the object URL survives the click");
  // The first timer armed by the click is the deferred revoke (the one after it is the notice's own auto-hide).
  ctx.clock.run([...ctx.clock.timers.keys()].find((id) => !armed.includes(id))!);
  assert.deepEqual([blobs.created, blobs.revoked], [1, 1], "and is revoked on the next turn, so none is left alive");
  assert.equal(ctx.$("ex-error").textContent, "");
  assert.equal(ctx.$("ex-download").textContent, "ดาวน์โหลด", "the button goes back from กำลังเตรียมไฟล์…");
});

test("every export error the routes can answer with has a Thai message, never the raw code", async () => {
  // Each of these is reachable from the dialog: the per-user gate, the preview limiter, the row cap and a bad range.
  for (const [status, code] of [[429, "EXPORT_BUSY"], [429, "EXPORT_THROTTLED"], [400, "EXPORT_TOO_LARGE"], [400, "INVALID_EXPORT_FILTER"]] as const) {
    const state: Server = { user: ADMIN, csrf: "csrf-1", sessionStatus: 200 };
    const ctx = await bootedIn(state, (url) => url.startsWith("/api/exports/documents.csv")
      ? json(status, { error: code }) : previewRoutes()(url, {}));
    ctx.wb.openExportDialog();
    await settle();
    ctx.$("ex-download").dispatch("click");
    await settle();
    // Equality, not a match: an alternation on the code would pass on the untranslated fallback.
    assert.equal(ctx.$("ex-error").textContent, ctx.wb.ERRORS[code], code);
    assert.ok(!ctx.$("ex-error").textContent.includes(code), `${code} must not reach staff as a raw code`);
    assert.equal(ctx.$("ex-download").disabled, false);
  }
});

test("a stream cut off after the 200 headers is a Thai error and no success notice", async () => {
  // What the route does on EXPORT_TRUNCATED / EXPORT_TIMEOUT: the headers are out, so it destroys the socket and the
  // browser rejects the body read with its own English TypeError.
  const state: Server = { user: ADMIN, csrf: "csrf-1", sessionStatus: 200 };
  const ctx = await bootedIn(state, (url) => url.startsWith("/api/exports/documents.csv")
    ? { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}),
      blob: async () => { throw new TypeError("terminated"); } } : previewRoutes()(url, {}));
  ctx.wb.openExportDialog();
  await settle();
  ctx.$("ex-download").dispatch("click");
  await settle();
  assert.equal(ctx.$("ex-error").textContent, ctx.wb.ERRORS.EXPORT_INCOMPLETE);
  assert.ok(!ctx.$("notice").textContent.includes("ดาวน์โหลดไฟล์ส่งออกแล้ว"), "nothing was saved, so nothing is announced");
  assert.equal(ctx.$("ex-download").disabled, false);
});

test("a batch the /api/batches page does not carry still narrows the export", async () => {
  // ensureBatch() sets the filter to a batch just created; loadBatches() lists only the newest 20 and swallows its
  // own errors. A <select> set to a value no <option> holds reads back as '', which would export every batch.
  const held = "99999999-9999-4999-8999-999999999999";
  const ctx = await bootedIn({ user: ADMIN, csrf: "csrf-1", sessionStatus: 200 }, previewRoutes());
  ctx.wb.state.batchFilter = held;
  ctx.wb.openExportDialog();
  await settle();
  assert.equal(ctx.$("ex-batch").value, held, "the fallback option keeps the selection");
  assert.ok(ctx.$("ex-batch").children.some((option) => option.value === held));
  const url = ctx.calls.find((call) => call.url.startsWith("/api/exports/preview"))!.url;
  assert.ok(url.includes(`batchId=${held}`), "the export covers the batch the table is showing, not every batch");
});

test("the dialog makes no claim about the data before a count has answered, and none beside an error", async () => {
  const state: Server = { user: ADMIN, csrf: "csrf-1", sessionStatus: 200 };
  let refuse = false;
  const ctx = await bootedIn(state, (url) => url.startsWith("/api/exports/preview")
    ? (refuse ? json(429, { error: "EXPORT_THROTTLED" }) : json(200, EXPORT_PREVIEW)) : null);
  ctx.wb.openExportDialog();
  assert.equal(ctx.$("ex-limit").textContent, "", "ไม่มีเอกสาร… is a claim about the data, and nothing has been counted");
  assert.equal(ctx.$("ex-download").disabled, true);
  await settle();
  assert.equal(ctx.$("ex-download").disabled, false);
  // A filter change invalidates the count on screen before the debounce even fires: the request at click time would
  // carry the new filters while the enabled/disabled decision came from the old count.
  refuse = true;
  ctx.$("ex-columns").value = "detailed";
  ctx.$("ex-columns").dispatch("change");
  assert.equal(ctx.$("ex-download").disabled, true, "the button dies with the count it was based on");
  runLastTimer(ctx);
  await settle();
  assert.equal(ctx.$("ex-error").textContent, ctx.wb.ERRORS.EXPORT_THROTTLED);
  assert.equal(ctx.$("ex-limit").textContent, "", "waiting is the remedy, not widening a filter that was never counted");
  assert.equal(ctx.$("ex-download").disabled, true);
});

test("ถึงวันที่ before ตั้งแต่วันที่ is named in Thai and never reaches the server", async () => {
  const ctx = await bootedIn({ user: ADMIN, csrf: "csrf-1", sessionStatus: 200 }, previewRoutes());
  ctx.wb.openExportDialog();
  await settle();
  ctx.calls.length = 0;
  ctx.$("ex-from").value = "2026-09-22";
  ctx.$("ex-to").value = "2026-09-01";
  ctx.$("ex-to").dispatch("change");
  runLastTimer(ctx);
  await settle();
  // parseExportQuery throws INVALID_EXPORT_FILTER for from > to, which names none of the dialog's six filters.
  assert.equal(ctx.$("ex-error").textContent, ctx.wb.ERRORS.INVALID_EXPORT_RANGE);
  assert.equal(ctx.$("ex-download").disabled, true);
  assert.deepEqual(ctx.calls.filter((call) => call.url.startsWith("/api/exports/")), [], "nothing is asked of the server");
});

test("closing the dialog takes the previewed customer rows with it", async () => {
  const ctx = await bootedIn({ user: ADMIN, csrf: "csrf-1", sessionStatus: 200 }, previewRoutes());
  ctx.wb.state.q = "สมชาย";
  ctx.wb.openExportDialog();
  await settle();
  assert.match(ctx.dom(), /ใบลูกค้า 22-09-2026\.pdf/);
  ctx.$("ex-close").dispatch("click");
  await settle();
  assert.equal(ctx.$("export-dlg").open, false);
  assert.ok(!ctx.dom().includes("ใบลูกค้า 22-09-2026.pdf"), "ปิด is not a weaker clear than logging out");
  assert.ok(!ctx.dom().includes("ค้นหา: สมชาย"), "the chip carries the staff member's search text");
});

test("an expired session leaves no exported customer data on screen", async () => {
  const state: Server = { user: ADMIN, csrf: "csrf-1", sessionStatus: 200 };
  const ctx = await bootedIn(state, previewRoutes());
  ctx.wb.openExportDialog();
  await settle();
  assert.match(ctx.dom(), /ใบลูกค้า 22-09-2026\.pdf/);
  state.sessionStatus = 401;
  void ctx.wb.requireLogin();
  await settle();
  assert.ok(!ctx.dom().includes("ใบลูกค้า 22-09-2026.pdf"), "the preview holds the same data the table does");
  assert.equal(ctx.$("export-dlg").open, false);
  assert.equal(ctx.$("export-open").hidden, true);
});

test("the users table shows the effective export right and offers no pointless grant on an admin row", async () => {
  // Exactly what `ocr-users create-admin` writes: the bootstrap admin owns the tenant with can_export = false.
  const users = [
    { id: ADMIN.id, username: "boss", displayName: "บอส", role: "admin", canExport: false, status: "active", lockedUntil: null, lastLoginAt: null, createdAt: "2026-01-01T00:00:00.000Z" },
    { id: STAFF.id, username: "nok", displayName: "นก", role: "staff", canExport: false, status: "active", lockedUntil: null, lastLoginAt: null, createdAt: "2026-02-01T00:00:00.000Z" }
  ];
  const ctx = await bootedIn({ user: ADMIN, csrf: "csrf-1", sessionStatus: 200 },
    (url, init) => url === "/api/users" && String(init.method ?? "GET") === "GET" ? json(200, { users }) : null);
  ctx.$("users-open").dispatch("click");
  await settle();
  const rows = ctx.$("users-rows").children;
  assert.match(rows[0]!.textContent, /ใช่ \(ผู้ดูแล\)/, "an admin reaches /api/exports/* on the role alone");
  assert.match(rows[1]!.textContent, /ไม่/);
  const labels = (row: FakeElement) => row.descendants().filter((node) => node.tagName === "BUTTON").map((node) => node.textContent);
  assert.equal(labels(rows[0]!).includes("อนุญาตส่งออก"), false, "the flag does nothing on an admin row");
  assert.equal(labels(rows[1]!).includes("อนุญาตส่งออก"), true);
});
