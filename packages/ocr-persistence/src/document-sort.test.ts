import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIDENCE_SORT_MAX_ROWS, DEFAULT_ORDER_SQL, displayedConfidencePercent, DOCUMENT_SORT_DIRS, DOCUMENT_SORT_KEYS, documentOrderSql, parseDocumentSort,
  rankByDisplayedConfidence, SORT_COLLATION, STATUS_SORT_ORDER, type DocumentSortKey } from "./document-sort.js";
import { DOCUMENT_STATUS_CATEGORIES } from "./labels.js";

/** The ORDER BY of `listDocuments` before sorting existed (dd1500f), copied here as the pin: no sort must emit exactly this. */
const PRE_CHANGE_ORDER = "d.created_at DESC, COALESCE(d.parent_document_id, d.id) DESC, d.page_number ASC NULLS FIRST, d.id DESC";
const CATEGORY_SQL = Object.fromEntries(DOCUMENT_STATUS_CATEGORIES.map((category) => [category, `d.status = '${category.toUpperCase()}'`])) as Record<typeof DOCUMENT_STATUS_CATEGORIES[number], string>;

test("the whitelist is exactly the ten list columns (all but จัดการ) and two directions", () => {
  assert.deepEqual([...DOCUMENT_SORT_KEYS], ["file", "customer", "gender", "nationality", "treatment", "duration", "therapist", "room", "status", "confidence"]);
  assert.deepEqual([...DOCUMENT_SORT_DIRS], ["asc", "desc"]);
  assert.equal(CONFIDENCE_SORT_MAX_ROWS, 2000);
  assert.deepEqual([...STATUS_SORT_ORDER], ["review", "failed", "processing", "queued", "succeeded", "confirmed"]);
  assert.deepEqual([...STATUS_SORT_ORDER].sort(), [...DOCUMENT_STATUS_CATEGORIES].sort(), "every category has a rank");
});

test("no sort emits the pre-change ORDER BY byte for byte", () => {
  assert.equal(DEFAULT_ORDER_SQL, PRE_CHANGE_ORDER);
  assert.equal(documentOrderSql(null, CATEGORY_SQL), PRE_CHANGE_ORDER);
  assert.equal(documentOrderSql({ sort: "confidence", dir: "desc" }, CATEGORY_SQL), PRE_CHANGE_ORDER, "confidence is ranked in code over the default order");
});

test("every key x direction is static SQL: no placeholder, empty values last, the default order as tie-break", () => {
  const seen = new Set<string>();
  for (const sort of DOCUMENT_SORT_KEYS) for (const dir of DOCUMENT_SORT_DIRS) {
    const sql = documentOrderSql({ sort, dir }, CATEGORY_SQL);
    assert.equal(sql.includes("$"), false, `${sort} ${dir}: no bind placeholder`);
    assert.ok(sql.endsWith(`, ${DEFAULT_ORDER_SQL}`) || sql === DEFAULT_ORDER_SQL, `${sort} ${dir}: ends with the default order`);
    assert.doesNotMatch(sql, /;|--|\/\*/, `${sort} ${dir}: one expression list`);
    if (sort !== "confidence") {
      assert.equal(seen.has(sql), false, `${sort} ${dir}: its own ORDER BY`);
      seen.add(sql);
    }
    if (sort !== "confidence" && sort !== "status") assert.ok(sql.startsWith("("), `${sort}: empty first decides`);
    if (["file", "customer", "gender", "nationality", "treatment", "therapist", "room"].includes(sort)) assert.ok(sql.includes(`COLLATE "${SORT_COLLATION}"`), `${sort}: Thai collation`);
  }
  assert.match(documentOrderSql({ sort: "customer", dir: "asc" }, CATEGORY_SQL), /^\(lower\(NULLIF\(btrim\(d\.structured_result #>> '\{customerInformation,name,value\}'\), ''\)\) COLLATE "th-TH-x-icu" IS NULL\) ASC, lower\(.*\) COLLATE "th-TH-x-icu" ASC, d\.created_at DESC/);
  assert.match(documentOrderSql({ sort: "customer", dir: "desc" }, CATEGORY_SQL), / DESC, d\.created_at DESC/);
  assert.match(documentOrderSql({ sort: "room", dir: "asc" }, CATEGORY_SQL), /::int ASC NULLS LAST, lower\(.*\) COLLATE "th-TH-x-icu" ASC, d\.created_at/);
  assert.match(documentOrderSql({ sort: "room", dir: "desc" }, CATEGORY_SQL), /::int DESC NULLS FIRST, lower\(.*\) COLLATE "th-TH-x-icu" DESC, d\.created_at/);
  const status = documentOrderSql({ sort: "status", dir: "asc" }, CATEGORY_SQL);
  assert.ok(status.startsWith("(CASE WHEN (d.status = 'REVIEW') THEN 1 WHEN (d.status = 'FAILED') THEN 2 WHEN (d.status = 'PROCESSING') THEN 3 WHEN (d.status = 'QUEUED') THEN 4 WHEN (d.status = 'SUCCEEDED') THEN 5 WHEN (d.status = 'CONFIRMED') THEN 6 ELSE 99 END) ASC, "), status);
  assert.equal(SORT_COLLATION, "th-TH-x-icu");
});

test("parseDocumentSort: whitelist only; dir alone is ignored, sort alone is ascending", () => {
  assert.equal(parseDocumentSort(undefined, undefined), null);
  assert.equal(parseDocumentSort(undefined, "desc"), null);
  assert.deepEqual(parseDocumentSort("customer", undefined), { sort: "customer", dir: "asc" });
  assert.deepEqual(parseDocumentSort("room", "desc"), { sort: "room", dir: "desc" });
  for (const key of DOCUMENT_SORT_KEYS) assert.deepEqual(parseDocumentSort(key, "asc"), { sort: key, dir: "asc" });
  for (const [sort, dir] of [["bogus", "asc"], ["CUSTOMER", undefined], ["customer", "up"], [undefined, "bogus"], ["", undefined], ["customer", ""], ["__proto__", undefined], [1, undefined], ["d.id; DROP TABLE documents", "asc"]] as const) {
    assert.throws(() => parseDocumentSort(sort, dir), { message: "INVALID_SORT" }, `${String(sort)} ${String(dir)}`);
  }
  assert.throws(() => documentOrderSql({ sort: "bogus" as DocumentSortKey, dir: "asc" }, CATEGORY_SQL));
});

test("the displayed percent is the workbench's pct(): same rounding, percentages as-is, null for no number", () => {
  const cases: Array<[unknown, number | null]> = [[0, 0], [0.894, 89], [0.895, 90], [0.41, 41], [1, 100], [85, 85], [85.5, 86], [null, null], [Number.NaN, null], [undefined, null], ["0.9", null], [Number.POSITIVE_INFINITY, null]];
  for (const [input, expected] of cases) assert.equal(displayedConfidencePercent(input), expected, String(input));
  // The client rule, copied: function pct(c){...return Math.round(c<=1?c*100:c)+'%';}
  const pct = (c: number) => Math.round(c <= 1 ? c * 100 : c);
  for (let c = 0; c <= 1.0001; c += 0.0005) assert.equal(displayedConfidencePercent(c), pct(c), String(c));
});

test("rankByDisplayedConfidence: stable, empty last both ways, equal displayed percent keeps the incoming order", () => {
  const rows = [{ id: "a", c: 0.9 }, { id: "b", c: null }, { id: "c", c: 0.41 }, { id: "d", c: 0.894 }, { id: "e", c: 0.89 }, { id: "f", c: 0.41 }, { id: "g", c: undefined }];
  const ids = (dir: "asc" | "desc") => rankByDisplayedConfidence(rows, (row) => row.c, dir).map((row) => row.id).join("");
  // 0.894 and 0.89 both show 89 %: they keep the incoming (default) order d, e in BOTH directions.
  assert.equal(ids("asc"), "cfdeabg");
  assert.equal(ids("desc"), "adecfbg");
  assert.deepEqual(rows.map((row) => row.id).join(""), "abcdefg", "the input is not mutated");
  assert.deepEqual(rankByDisplayedConfidence([], () => null, "asc"), []);
});

test("Thai dictionary order (ICU th) as the DB parity test assumes it: leading vowels by consonant, Thai before Latin, case-insensitive", () => {
  // Node's full ICU and PostgreSQL's th-TH-x-icu (postgres:17.6, ICU 76) agree on this sample; the DB test proves the
  // server side, this documents the expected order next to the code that chose it.
  const collator = new Intl.Collator("th");
  const sample = ["ไก่", "เกด", "แม่", "โต", "ใจ", "ไข่", "กา", "ขิม", "ฮา", "Zed", "apple", "Bob", "alice"];
  const ordered = sample.map((value) => value.toLowerCase()).sort(collator.compare);
  assert.deepEqual(ordered, ["กา", "เกด", "ไก่", "ขิม", "ไข่", "ใจ", "โต", "แม่", "ฮา", "alice", "apple", "bob", "zed"]);
});
