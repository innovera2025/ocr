import assert from "node:assert/strict";
import { test } from "node:test";
import { Script } from "node:vm";
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

test("no native prompt/alert/confirm dialogs and no token inputs or token storage", () => {
  assert.doesNotMatch(inlineScript, /(^|[^\w.$])(window\.)?(prompt|alert|confirm)\s*\(/);
  assert.doesNotMatch(inlineScript, /window\.confirm|localStorage|sessionStorage|document\.cookie/);
  assert.doesNotMatch(markup, /<input[^>]*(token|password)/i);
  assert.doesNotMatch(html, /Bearer token/i);
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
  for (const needle of ["'/api/web-token'", "'/api/batches'", "'/api/batches?limit=20'", "'/api/documents?'", "'/ocr/review'", "'/retry'", "'/content'", "'X-Batch-Id'", "'X-Upload-Filename'", "encodeURIComponent(u.file.name)", "'X-Upload-Filename-Encoding','uri'", "'Idempotency-Key'", "expectedUpdatedAt", "structuredResult:state.draft", "CONCURRENCY=3", "MAX_FILES=100", "'document'"]) {
    assert.ok(inlineScript.includes(needle), `missing ${needle}`);
  }
  for (const key of ["name", "gender", "nationality", "hotelName", "referralSources", "healthConditions", "pressure", "massageOilScrub", "preferredAreas", "avoidAreas", "treatments", "therapistName", "roomNo", "duration"]) {
    assert.match(inlineScript, new RegExp(`[{,]${key}:'[^']+'`), `no Thai label for ${key}`);
  }
  for (const section of ["ข้อมูลลูกค้า", "คำแนะนำการนวด", "สำหรับพนักงาน", "บันทึกและยืนยัน"]) assert.ok(html.includes(section), section);
});

test("search box never exceeds the server's q limit (100 characters → otherwise 400 INVALID_QUERY)", () => {
  assert.match(markup, /<input id="q"[^>]*maxlength="100"/);
  assert.doesNotMatch(inlineScript, /\$\('q'\)\.value\.trim\(\)\.slice\(0,(?!100\))/);
});
