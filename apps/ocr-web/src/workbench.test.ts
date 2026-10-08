import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Script } from "node:vm";
import { CATEGORY_LABELS_TH, DELIVERY_LABELS_TH, FIELD_LABELS_TH, LEGACY_REVIEWER_LABEL } from "@innovera/ocr-persistence";
import { workbenchPage } from "./workbench.js";

const html = workbenchPage({ nonce: "test-nonce-123" });
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
const inlineScript = scripts[0]?.[2] ?? "";
const markup = html.replace(/<script\b[\s\S]*?<\/script>/g, "");

test("workbench has exactly one inline script carrying the escaped nonce", () => {
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0]?.[1], ' nonce="test-nonce-123"');
  const hostile = workbenchPage({ nonce: "a\"><script>alert(1)</script>&'" });
  assert.match(hostile, /<script nonce="a&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;&amp;&#39;">/);
  assert.equal(hostile.split("<script").length - 1, 1);
});

test("inline script is syntactically valid JavaScript", () => {
  assert.ok(inlineScript.length > 1000);
  assert.doesNotThrow(() => new Script(inlineScript, { filename: "workbench-inline.js" }));
  assert.equal(inlineScript.includes("</script"), false);
});

test("page works under the CSP: no inline handlers, external scripts, eval or javascript: URLs", () => {
  assert.doesNotMatch(markup, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /javascript:/i);
  assert.doesNotMatch(inlineScript, /\beval\s*\(|new\s+Function\s*\(|setTimeout\s*\(\s*['"]|setInterval\s*\(\s*['"]/);
  for (const [, href] of html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)) assert.match(href ?? "", /^https:\/\/fonts\.googleapis\.com\//);
});

test("no native prompt/alert/confirm dialogs, and the session credential is a cookie the script cannot read", () => {
  assert.doesNotMatch(inlineScript, /(^|[^\w.$])(window\.)?(prompt|alert|confirm)\s*\(/);
  assert.doesNotMatch(inlineScript, /window\.confirm|localStorage|sessionStorage|document\.cookie/);
  for (const banned of ["Authorization", "Bearer", "/api/web-token", "HS256", "createHmac", "AUTH_JWT", "jwtSecrets", "subtle.sign"]) {
    assert.equal(inlineScript.includes(banned), false, `the script still mentions ${banned}`);
  }
});

test("password fields are real password inputs inside a posting form, and no input carries a token", () => {
  const inputs = [...markup.matchAll(/<input\b[^>]*>/g)].map(([tag]) => tag);
  assert.ok(inputs.length >= 6);
  for (const tag of inputs) assert.doesNotMatch(tag, /token/i, tag);
  const forms = [...markup.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)];
  const passwords = inputs.filter((tag) => /password/i.test(tag));
  assert.equal(passwords.length, 4, "login, current, new and confirm");
  for (const tag of passwords) {
    assert.match(tag, /\btype="password"/, tag);
    assert.match(tag, /\bautocomplete="(current-password|new-password)"/, tag);
    const form = forms.find(([, , body]) => (body ?? "").includes(tag));
    assert.ok(form, `${tag} sits outside every form`);
    // A form post means a script failure can never put a password in a URL or in an nginx access log.
    assert.match(form?.[1] ?? "", /\bmethod="post"/, "the form around a password field must post");
  }
  assert.match(markup, /<form id="login-form" method="post" action="\/api\/auth\/login">/);
});

test("document text never goes through HTML parsing sinks", () => {
  assert.doesNotMatch(inlineScript, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|createContextualFragment|DOMParser/);
});

test("table exposes all 11 contract columns in order", () => {
  const head = /<thead>([\s\S]*?)<\/thead>/.exec(html)?.[1] ?? "";
  const headers = [...head.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((match) => match[1]);
  assert.deepEqual(headers, ["ไฟล์", "ลูกค้า", "เพศ", "สัญชาติ", "ทรีตเมนต์", "ระยะเวลา", "พนักงานนวด", "ห้อง", "สถานะ", "ความมั่นใจ", "จัดการ"]);
  assert.match(html, /id="scroll" class="scroll" tabindex="0" role="region"/);
});

test("every element id the script looks up exists in the markup", () => {
  const ids = new Set([...inlineScript.matchAll(/\$\('([a-z0-9-]+)'\)/g)].map((match) => match[1]));
  for (const id of ["d-head", "d-alert", "d-body", "d-foot"]) ids.add(id);
  assert.ok(ids.size > 30);
  for (const id of ids) assert.match(markup, new RegExp(`id="${id}"`), `missing #${id}`);
});

test("script follows the HTTP contract of spec §5", () => {
  for (const needle of ["'/api/auth/session'", "'/api/auth/login'", "'/api/auth/logout'", "'/api/auth/password'", "'/api/users'", "'/api/exports/candidates?'", "'/api/exports/marks'", "'/api/exports/documents.'", "'X-CSRF-Token'", "'X-OCR-Background'", "'/api/batches'", "'/api/batches?limit=20'", "'/api/documents?'", "'/ocr/review'", "'/retry'", "'/content'", "'X-Batch-Id'", "'X-Upload-Filename'", "encodeURIComponent(u.file.name)", "'X-Upload-Filename-Encoding','uri'", "'Idempotency-Key'", "expectedUpdatedAt", "structuredResult:state.draft", "CONCURRENCY=3", "MAX_FILES=100", "'document'"]) {
    assert.ok(inlineScript.includes(needle), `missing ${needle}`);
  }
  for (const key of ["name", "gender", "nationality", "hotelName", "referralSources", "healthConditions", "pressure", "massageOilScrub", "preferredAreas", "avoidAreas", "treatments", "therapistName", "roomNo", "duration"]) {
    assert.match(inlineScript, new RegExp(`[{,]${key}:'[^']+'`), `no Thai label for ${key}`);
  }
  for (const section of ["ข้อมูลลูกค้า", "คำแนะนำการนวด", "สำหรับพนักงาน", "บันทึกและยืนยัน"]) assert.ok(html.includes(section), section);
});

test("the drawer's label for pre-login reviews is the one the export and the store share", () => {
  // The inline script cannot import a module, so it carries its own copy; this pins the two together.
  assert.ok(inlineScript.includes(`const LEGACY_REVIEWER='${LEGACY_REVIEWER_LABEL}'`), LEGACY_REVIEWER_LABEL);
});

test("the Thai vocabulary of the table and of the export file is one vocabulary (§10 H3)", () => {
  // Same reason as above: the script carries copies of the maps `labels.ts` exports, and an export column headed
  // "รอตรวจสอบ" must mean exactly what the row badge on screen means.
  const literal = (name: string): Record<string, string> => {
    const source = new RegExp(`const ${name}=\\{([^}]*)\\}`).exec(inlineScript)?.[1] ?? "";
    return Object.fromEntries([...source.matchAll(/(\w+):'([^']*)'/g)].map((entry) => [entry[1]!, entry[2]!]));
  };
  assert.deepEqual(literal("CATEGORY"), CATEGORY_LABELS_TH);
  assert.deepEqual(literal("DELIVERY"), DELIVERY_LABELS_TH);
  assert.deepEqual(literal("LABEL"), FIELD_LABELS_TH);
});

test("nothing in the header or the dialogs can outgrow a 375px viewport", () => {
  // The collapsed pill carries the whole display name and `.btn` is nowrap, so the name must sit in the one element
  // the ≤720px rules cap; otherwise a long Thai name gives the page a horizontal scrollbar (§12's manual check).
  assert.match(markup, /<button id="me-open"[^>]*><span id="me-open-name" class="me-name"><\/span><\/button>/);
  const phone = /@media \(max-width:720px\)\{([^@]*)\}/.exec(html)?.[1] ?? "";
  assert.match(phone, /\.me-name\{max-width:min\(/, "the pill's name is capped again at phone width");
  assert.match(phone, /#conn-text\{position:absolute/, "the connection chip shrinks to its dot, keeping its live region");
  // A grid item's automatic minimum size is its min-content, which for the nowrap users table is about 1000px: without
  // min-width:0 the wide card grows past the viewport instead of letting .x-scroll scroll the table inside it.
  assert.match(html, /\.m-card\{[^}]*min-width:0/);
  assert.match(html, /\.x-scroll\{overflow:auto/);
});

test("search box never exceeds the server's q limit (100 characters → otherwise 400 INVALID_QUERY)", () => {
  assert.match(markup, /<input id="q"[^>]*maxlength="100"/);
  assert.doesNotMatch(inlineScript, /\$\('q'\)\.value\.trim\(\)\.slice\(0,(?!100\))/);
});

test("the export dialog is the selectable list of 0021, not the 20-row column preview (D8)", () => {
  const dialog = /<dialog id="export-dlg"[\s\S]*?<\/dialog>/.exec(markup)?.[0] ?? "";
  for (const id of ["ex-tab-never", "ex-tab-exported", "ex-tab-all", "ex-count", "ex-page", "ex-picked", "ex-all", "ex-clear", "ex-warn",
    "ex-rows", "ex-prev", "ex-next", "ex-size", "ex-limit", "ex-error", "ex-unmark", "ex-mark", "ex-download"]) {
    assert.match(dialog, new RegExp(`id="${id}"`), `missing #${id}`);
  }
  assert.doesNotMatch(markup, /id="ex-head"|ตัวอย่าง 20 แถวแรก/);
  assert.equal(inlineScript.includes("/api/exports/preview"), false, "the UI no longer calls the preview route");
  // The tabs are toggle buttons in a labelled group; the script looks them up as 'ex-tab-'+key, which the id test above
  // cannot see, so they are pinned here.
  assert.match(dialog, /<div class="ex-tabs" role="group" aria-label="สถานะการ Export">/);
  assert.ok(inlineScript.includes("const EX_TABS=['never','exported','all'];"));
  for (const tab of ["never", "exported", "all"]) assert.match(dialog, new RegExp(`<button id="ex-tab-${tab}" class="btn sm" type="button" aria-pressed="(true|false)">`));
  assert.match(dialog, /<label class="chk"><input id="ex-page" type="checkbox"><span>เลือกทั้งหน้านี้<\/span><\/label>/);
  assert.match(dialog, /<p id="ex-warn" role="status" hidden><\/p>/);
  // แสดงต่อหน้า offers exactly the sizes the script accepts (EX_SIZES) and the server allows (≤ CANDIDATES_MAX_LIMIT 500).
  const sizes = /<select id="ex-size">([\s\S]*?)<\/select>/.exec(dialog)?.[1] ?? "";
  assert.deepEqual([...sizes.matchAll(/<option value="(\d+)"( selected)?>(\d+) แถว<\/option>/g)].map((match) => [match[1], match[2] ?? "", match[3]]),
    [["50", "", "50"], ["100", " selected", "100"], ["200", "", "200"], ["500", "", "500"]]);
  const head = /<thead>([\s\S]*?)<\/thead>/.exec(dialog)?.[1] ?? "";
  const headers = [...head.matchAll(/<th[^>]*>(?:<span class="sr-only">)?([^<]*)/g)].map((match) => match[1]);
  assert.deepEqual(headers, ["เลือก", "ชื่อไฟล์ต้นฉบับ", "หน้า", "ลูกค้า", "เลขที่ฟอร์ม", "สถานะ", "Export ล่าสุด"]);
  assert.match(dialog, /<div class="x-scroll"><table><caption class="sr-only">รายการเอกสารที่เลือกส่งออกได้<\/caption>/);
  assert.match(dialog, /<button id="ex-download" class="btn primary" type="button" disabled>ดาวน์โหลด \(0 แถว\)<\/button>/);
  // The state names and limits the plan fixes (§6), so the behaviour tests and a reviewer can find them.
  for (const name of ["exTab:'never'", "exOffset:0", "exRows:[]", "exCounts:null", "exSel:new Set()", "exWarnIds:new Set()", "exAll:false", "exSig:''", "exPending:false", "exSize:100", "EX_SIZES=[50,100,200,500],EX_PICK_MAX=5000"]) {
    assert.ok(inlineScript.includes(name), name);
  }
  // At 375px the tabs and the selection bar wrap, and the list scrolls inside .x-scroll instead of widening the card.
  assert.match(html, /\.ex-tabs\{[^}]*flex-wrap:wrap/);
  assert.match(html, /\.ex-tabs\{[^}]*max-width:100%/);
  assert.match(html, /\.ex-bar\{[^}]*flex-wrap:wrap/);
});

test("every code the export routes can answer the dialog with has Thai text (0021 included)", () => {
  const source = /const ERRORS=\{([\s\S]*?)\};\nconst state=/.exec(inlineScript)?.[1] ?? "";
  const errors = Object.fromEntries([...source.matchAll(/([A-Z_]+):'([^']*)'/g)].map((entry) => [entry[1]!, entry[2]!]));
  // The route module's own codes, read from its source so a new one cannot ship without copy. EXPORT_ABORTED (the
  // client left), EXPORT_TRUNCATED (a cut socket, read as EXPORT_INCOMPLETE) and INTERNAL_ERROR never reach the dialog.
  const route = readFileSync(new URL("./export.ts", import.meta.url), "utf8");
  const routeCodes = new Set([...route.matchAll(/"((?:INVALID_)?EXPORT_[A-Z_]+)"/g)].map((match) => match[1]!));
  for (const internal of ["EXPORT_ABORTED", "EXPORT_TRUNCATED"]) routeCodes.delete(internal);
  // The store's selection codes (persistence) and the script's own EXPORT_INCOMPLETE / INVALID_EXPORT_RANGE.
  const codes = [...routeCodes, "EXPORT_SELECTION_EMPTY", "EXPORT_SELECTION_CHANGED", "EXPORT_NOT_CONFIGURED", "EXPORT_INCOMPLETE", "INVALID_EXPORT_RANGE"];
  for (const code of ["INVALID_EXPORT_SELECTION", "INVALID_EXPORT_FILTER", "EXPORT_MARK_FAILED", "EXPORT_BUSY", "EXPORT_BUSY_ORG", "EXPORT_THROTTLED", "EXPORT_TOO_LARGE"]) {
    assert.ok(codes.includes(code), `${code} is expected among the route codes`);
  }
  for (const code of codes) assert.match(errors[code] ?? "", /[\u0E00-\u0E7F]/, `${code} has no Thai text`);
  // The four new texts are the plan's (Public Contracts), and a cut socket names the mark failure too.
  assert.equal(errors.INVALID_EXPORT_SELECTION, 'รายการที่เลือกไม่ถูกต้องหรือมากเกินไป (เลือกเองได้ไม่เกิน 5,000 แถว) กรุณาใช้ "เลือกทั้งหมด" หรือเลือกใหม่');
  assert.equal(errors.EXPORT_SELECTION_EMPTY, "ไม่พบแถวที่เลือกแล้ว (อาจถูกลบหรือเปลี่ยนไป) กรุณาโหลดรายการใหม่");
  assert.equal(errors.EXPORT_SELECTION_CHANGED, "รายการเปลี่ยนไประหว่างที่คุณเลือก (มีเอกสารเข้ามาใหม่หรือสถานะเปลี่ยน) กรุณาตรวจรายการแล้วเลือกใหม่อีกครั้ง");
  // Review of 0021: EXPORT_MARK_FAILED is now also the answer of ทำเครื่องหมาย / ย้ายกลับ (M1), so it speaks of rows, not a
  // file; another person's download in the same organization has its own text (H1); the limiter's text fits the
  // mark/unmark buttons as well as the filters (L4).
  assert.equal(errors.EXPORT_MARK_FAILED, "บันทึกสถานะ Export ไม่สำเร็จ ยังไม่มีแถวใดเปลี่ยนสถานะ กรุณาลองใหม่อีกครั้ง");
  assert.equal(errors.EXPORT_BUSY_ORG, "มีคนอื่นกำลัง Export อยู่ตอนนี้ กรุณารอสักครู่แล้วลองใหม่");
  assert.equal(errors.EXPORT_THROTTLED, "ทำรายการบ่อยเกินไป กรุณารอประมาณ 15 นาทีแล้วลองใหม่");
  assert.ok(errors.EXPORT_INCOMPLETE?.includes("หรือบันทึกสถานะ Export ไม่สำเร็จ"));
});
