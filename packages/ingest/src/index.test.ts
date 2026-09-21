import test from "node:test";
import assert from "node:assert/strict";
import { transitionIngestState, validateUpload } from "./index.js";

test("upload validation enforces the canonical cap and state gate", () => {
  assert.equal(validateUpload({ byteLength: 1, filename: "ใบกำกับภาษี.pdf", mimeType: "application/pdf" }).mimeType, "application/pdf");
  assert.throws(() => validateUpload({ byteLength: 209_715_201, filename: "a.pdf", mimeType: "application/pdf" }), /PAYLOAD_TOO_LARGE/);
  assert.equal(transitionIngestState("SCANNING", "CLEAN"), "CLEAN");
  assert.throws(() => transitionIngestState("STAGED", "CLEAN"), /INVALID_INGEST_TRANSITION/);
});
