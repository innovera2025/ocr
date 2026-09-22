import test from "node:test";
import assert from "node:assert/strict";
import { transitionIngestState, validateUpload } from "./index.js";

test("upload validation enforces the canonical cap and state gate", () => {
  assert.equal(validateUpload({ byteLength: 1, filename: "ใบกำกับภาษี.pdf", mimeType: "application/pdf" }).mimeType, "application/pdf");
  assert.throws(() => validateUpload({ byteLength: 209_715_201, filename: "a.pdf", mimeType: "application/pdf" }), /PAYLOAD_TOO_LARGE/);
  assert.equal(transitionIngestState("SCANNING", "CLEAN"), "CLEAN");
  assert.throws(() => transitionIngestState("STAGED", "CLEAN"), /INVALID_INGEST_TRANSITION/);
});

test("DOCX and XLSX are refused at upload (the OCR pipeline cannot read them)", () => {
  for (const mimeType of ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]) {
    assert.throws(() => validateUpload({ byteLength: 10, filename: "a.docx", mimeType }), /UNSUPPORTED_MEDIA_TYPE/);
  }
  for (const mimeType of ["application/pdf", "image/jpeg", "image/png", "image/webp"]) assert.equal(validateUpload({ byteLength: 10, filename: "a", mimeType }).mimeType, mimeType);
});
