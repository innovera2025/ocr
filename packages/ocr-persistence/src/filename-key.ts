/**
 * The canonical key of an upload's file name (plan upload-duplicate-filename, D2): two uploads are "the same file name"
 * when their keys are equal. One definition, implemented three times and pinned by `filename-key.vectors.ts`:
 *   - here (the server: the upload rule and the name pre-check),
 *   - `nameKey` in the workbench's inline script (it cannot import),
 *   - `filenameKeySql` (stored names, compared inside PostgreSQL).
 *
 * The input is the name as `normalizeFilename` (packages/ingest) stores it: NFC, control and bidi-format characters
 * stripped, empty → `untitled`. On that string: (1) every run of KEY_WS characters becomes one U+0020, (2) U+0020 is
 * trimmed from both ends, (3) Unicode lowercase. The extension is part of the name. The whitespace class is an explicit
 * list, not `\s`, because JavaScript's `\s` and PostgreSQL's `\s` differ by locale.
 */

/**
 * The D2 whitespace class as literal characters (a bracket-expression body, valid in a JavaScript RegExp and in a
 * PostgreSQL ARE): space, TAB, LF, CR, FF, VT, NBSP, OGHAM SPACE MARK, U+2000–U+200A, LINE and PARAGRAPH SEPARATOR,
 * NARROW NBSP, MEDIUM MATHEMATICAL SPACE, IDEOGRAPHIC SPACE and the BOM. The range dash is the only syntax in it.
 */
export const KEY_WS_CHARS = " \t\n\r\f\v   -     　﻿";
/** The pattern PostgreSQL receives as a bound parameter (never a hand-escaped copy inside SQL). */
export const FILENAME_KEY_SQL_WS_PATTERN = `[${KEY_WS_CHARS}]+`;
const KEY_WS = new RegExp(FILENAME_KEY_SQL_WS_PATTERN, "g");
/**
 * MUST equal the strip set of `normalizeFilename` in packages/ingest/src/index.ts (this package cannot import ingest
 * without a dependency cycle); `filename-key.test.ts` sweeps U+0000–U+FFFF to prove both strip the same characters.
 */
const STRIPPED = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g;
const EDGE_SPACES = /^ +| +$/g;

/** `normalizeFilename` without its length checks: NFC, the strip set, empty → `untitled`. */
export function cleanFilename(name: string): string {
  return name.normalize("NFC").replace(STRIPPED, "") || "untitled";
}

/** D2: the key two upload names are compared by (also on a raw, not yet normalized name). */
export function canonicalFilenameKey(name: string): string {
  return cleanFilename(name).replace(KEY_WS, " ").replace(EDGE_SPACES, "").toLowerCase();
}

/**
 * D3: the same key inside PostgreSQL, for a column holding stored (already normalized) names. `patternParam` is the
 * placeholder bound to FILENAME_KEY_SQL_WS_PATTERN. `lower()` follows the column's collation (the database default):
 * see the vectors' JS-only group for the characters where it differs from JavaScript.
 */
export function filenameKeySql(column: string, patternParam: string): string {
  return `lower(btrim(regexp_replace(${column}, ${patternParam}, ' ', 'g'), ' '))`;
}
