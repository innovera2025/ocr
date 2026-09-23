import assert from "node:assert/strict";
import { test } from "node:test";
import { Script } from "node:vm";
import { LEGACY_REVIEWER_LABEL } from "@innovera/ocr-persistence";
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
  for (const needle of ["'/api/auth/session'", "'/api/auth/login'", "'/api/auth/logout'", "'/api/auth/password'", "'/api/users'", "'X-CSRF-Token'", "'X-OCR-Background'", "'/api/batches'", "'/api/batches?limit=20'", "'/api/documents?'", "'/ocr/review'", "'/retry'", "'/content'", "'X-Batch-Id'", "'X-Upload-Filename'", "encodeURIComponent(u.file.name)", "'X-Upload-Filename-Encoding','uri'", "'Idempotency-Key'", "expectedUpdatedAt", "structuredResult:state.draft", "CONCURRENCY=3", "MAX_FILES=100", "'document'"]) {
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
