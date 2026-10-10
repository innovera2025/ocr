/**
 * Shared vectors of the canonical upload file-name key (D2, D15): pure data. Every implementation runs them — the
 * server's `canonicalFilenameKey`, the workbench's `nameKey`, and (on stored, `cleanFilename`-d names) the SQL key, the
 * last one against PostgreSQL in batch.db.test.ts. File names here are synthetic, never customer names.
 */
export type FilenameKeyVector = Readonly<{ input: string; key: string }>;

const MAKKHA = "makkha-b5.pdf";
const THAI = "ใบลงทะเบียน ลูกค้า.pdf";

export const FILENAME_KEY_VECTORS: readonly FilenameKeyVector[] = Object.freeze([
  // One name in several spellings: case of the stem and of the extension, edge spaces, inner runs of whitespace.
  { input: "Makkha-B5.pdf", key: MAKKHA },
  { input: "makkha-b5.PDF", key: MAKKHA },
  { input: "Makkha-B5.pdf ", key: MAKKHA },
  { input: " Makkha-B5.pdf", key: MAKKHA },
  { input: "  Makkha-B5.pdf   ", key: MAKKHA },
  { input: "Makkha  B5.pdf", key: "makkha b5.pdf" },
  { input: "Makkha\tB5.pdf", key: "makkhab5.pdf" }, // TAB is a control character: stripped before the key is taken
  { input: "Makkha B5.pdf", key: "makkha b5.pdf" },
  { input: "Makkha   B5.pdf", key: "makkha b5.pdf" },
  { input: "Makkha　B5.pdf", key: "makkha b5.pdf" }, // IDEOGRAPHIC SPACE
  { input: "Makkha B5.pdf", key: "makkha b5.pdf" }, // NBSP
  { input: "Makkha    B5.pdf", key: "makkha b5.pdf" }, // a mixed run collapses to one space
  { input: "Makkha B5.pdf", key: "makkha b5.pdf" }, // LINE SEPARATOR
  { input: "﻿Makkha-B5.pdf", key: MAKKHA }, // a leading BOM is whitespace, trimmed
  // Thai: no case, and no listed whitespace inside words; only the edges and the runs between words change.
  { input: "ใบลงทะเบียน ลูกค้า.pdf", key: THAI },
  { input: "ใบลงทะเบียน ลูกค้า.pdf ", key: THAI },
  { input: "ใบลงทะเบียน  ลูกค้า.PDF", key: THAI },
  { input: "ใบลูกค้า ABC-01.PDF", key: "ใบลูกค้า abc-01.pdf" },
  { input: "ใบลูกค้า abc-01.pdf", key: "ใบลูกค้า abc-01.pdf" },
  // NFD and NFC spellings of one accented name are one name.
  { input: "Café.png", key: "café.png" },
  { input: "Café.png", key: "café.png" },
  { input: "CAFÉ.PNG", key: "café.png" },
  // Zero-width and bidi-format characters are stripped (as normalizeFilename stores the name).
  { input: "scan​-01.png", key: "scan-01.png" },
  { input: "‮scan-01.png‬", key: "scan-01.png" },
  { input: "scan⁦-01⁩.png", key: "scan-01.png" },
  { input: "scan‎-01‏.png", key: "scan-01.png" },
  // The extension is part of the name and is lowercased like the rest.
  { input: "A.PNG", key: "a.png" },
  { input: "a.png", key: "a.png" },
  { input: "a.jpg", key: "a.jpg" },
  { input: "scan_100%.png", key: "scan_100%.png" },
  // Empty after normalization → `untitled`, which collides with `untitled` (accepted).
  { input: "", key: "untitled" },
  { input: "\u0000\u0007", key: "untitled" },
  { input: "\t\r\n", key: "untitled" }, // control whitespace is stripped, not collapsed
  { input: "​‮", key: "untitled" },
  { input: "Untitled", key: "untitled" },
  // Spaces only: not empty after normalization (U+0020 is no control character), so D2 trims it to "".
  { input: "   ", key: "" },
  // Cased letters outside ASCII where PostgreSQL lower() (database default collation, en_US.utf8) equals JavaScript.
  { input: "STRASSE ß.png", key: "strasse ß.png" },
  { input: "ẞ.png", key: "ß.png" },
  { input: "ÀÉÎÕÜ.png", key: "àéîõü.png" },
  { input: "ДОКУМЕНТ.pdf", key: "документ.pdf" },
  { input: "Ωmega.png", key: "ωmega.png" },
  { input: "ＡＢＣ.PDF", key: "ａｂｃ.pdf" }
]);

/**
 * Characters where JavaScript's toLowerCase and PostgreSQL's lower() disagree (verified on postgres:17.6, en_US.utf8):
 * excluded from the JS/SQL parity run and documented. `İ` lowercases to `i` + U+0307 in JavaScript but to `i` in
 * PostgreSQL; a word-final capital sigma becomes `ς` in JavaScript but `σ` in PostgreSQL. Both implementations of the
 * client and the server still agree with each other (they are both JavaScript).
 */
export const FILENAME_KEY_JS_ONLY_VECTORS: readonly FilenameKeyVector[] = Object.freeze([
  { input: "İstanbul.PDF", key: "i̇stanbul.pdf" },
  { input: "ΟΔΟΣ", key: "οδος" }
]);
