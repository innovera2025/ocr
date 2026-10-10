import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalFilenameKey, cleanFilename, FILENAME_KEY_SQL_WS_PATTERN, filenameKeySql, KEY_WS_CHARS } from "./filename-key.js";
import { FILENAME_KEY_JS_ONLY_VECTORS, FILENAME_KEY_VECTORS } from "./filename-key.vectors.js";

/** packages/ingest is not a dependency of this package (it would be a cycle); the test loads it by path, as batch.db.test.ts loads the queue. */
const ingest = await import(new URL("../../ingest/src/index.ts", import.meta.url).href) as { normalizeFilename(name: string): string };

test("every shared vector yields its key (the JS-only group too: client and server are both JavaScript)", () => {
  assert.ok(FILENAME_KEY_VECTORS.length >= 30);
  for (const vector of [...FILENAME_KEY_VECTORS, ...FILENAME_KEY_JS_ONLY_VECTORS]) assert.equal(canonicalFilenameKey(vector.input), vector.key, JSON.stringify(vector.input));
});

test("the Makkha-B5 spellings the user reported are one name; a different extension is another", () => {
  const keys = new Set(["Makkha-B5.pdf", "makkha-b5.PDF", "Makkha-B5.pdf ", " Makkha-B5.pdf", "MAKKHA-B5.PDF"].map(canonicalFilenameKey));
  assert.deepEqual([...keys], ["makkha-b5.pdf"]);
  assert.equal(canonicalFilenameKey("Makkha   B5.pdf"), canonicalFilenameKey("makkha b5.PDF"));
  assert.notEqual(canonicalFilenameKey("Makkha-B5.pdf"), canonicalFilenameKey("Makkha-B5.png"));
});

test("the key is idempotent: key(key(x)) = key(x)", () => {
  for (const { input, key } of [...FILENAME_KEY_VECTORS, ...FILENAME_KEY_JS_ONLY_VECTORS]) {
    // A name of spaces only keys to "" (D2), and "" is `untitled` once it is a name again: the one documented exception.
    if (key === "") continue;
    assert.equal(canonicalFilenameKey(canonicalFilenameKey(input)), canonicalFilenameKey(input), JSON.stringify(input));
  }
});

test("the strip set equals normalizeFilename's over U+0000 to U+FFFF", () => {
  for (let code = 0; code <= 0xffff; code += 1) {
    if (code >= 0xd800 && code <= 0xdfff) continue; // lone surrogates are not characters
    const name = `a${String.fromCharCode(code)}b`;
    assert.equal(cleanFilename(name), ingest.normalizeFilename(name), `U+${code.toString(16).padStart(4, "0")}`);
  }
  assert.equal(cleanFilename(""), ingest.normalizeFilename(""));
  assert.equal(cleanFilename("​"), "untitled");
});

test("one whitespace class for JavaScript and SQL: the explicit list, and the SQL expression binds it", () => {
  assert.equal(FILENAME_KEY_SQL_WS_PATTERN, `[${KEY_WS_CHARS}]+`);
  // The class is exactly ECMAScript's WhiteSpace + LineTerminator, written out so PostgreSQL reads the same set.
  for (let code = 0; code <= 0xffff; code += 1) {
    if (code >= 0xd800 && code <= 0xdfff) continue;
    const char = String.fromCharCode(code);
    assert.equal(new RegExp(FILENAME_KEY_SQL_WS_PATTERN).test(char), /\s/.test(char), `U+${code.toString(16)}`);
  }
  assert.equal(filenameKeySql("d.filename", "$3"), "lower(btrim(regexp_replace(d.filename, $3, ' ', 'g'), ' '))");
});
