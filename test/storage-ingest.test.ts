import test from "node:test";
import assert from "node:assert/strict";
import { mintOriginalKey, parseOriginalKey } from "@innovera/ocr-storage";
import { normalizeFilename, transitionIngestState, validateUpload } from "@innovera/ocr-ingest";

const org = "0199c3a1-7b2e-7f41-9c3d-5e6f70819a2b";
const doc = "7qm3v9zx0k5r2t8h6j4n1p7s3d0f5g2b";

test("original key is identity-addressed and round-trips without client bytes", () => {
  const key = mintOriginalKey(org, doc);
  assert.equal(key, `org/${org}/original/7q/${doc}`);
  assert.deepEqual(parseOriginalKey(key), { organizationId: org, documentPublicId: doc, raw: key });
  assert.equal(parseOriginalKey(key.replace("7q/", "zz/")), null);
  assert.throws(() => mintOriginalKey(org, `${doc}/../../escape`), /INVALID_DOCUMENT_PUBLIC_ID/);
});

test("ingest validates cap, NFC filename policy, MIME and scan-gated transitions", () => {
  const upload = validateUpload({ byteLength: 10, filename: "e\u0301.pdf\u0000", mimeType: "application/pdf" });
  assert.equal(upload.filename, "é.pdf");
  assert.equal(normalizeFilename("\u0000"), "untitled");
  assert.throws(() => validateUpload({ byteLength: 209_715_201, filename: "a.pdf", mimeType: "application/pdf" }), /PAYLOAD_TOO_LARGE/);
  assert.throws(() => validateUpload({ byteLength: 1, filename: "a.exe", mimeType: "application/octet-stream" }), /UNSUPPORTED_MEDIA_TYPE/);
  assert.equal(transitionIngestState("STAGED", "SCANNING"), "SCANNING");
  assert.equal(transitionIngestState("SCANNING", "CLEAN"), "CLEAN");
  assert.throws(() => transitionIngestState("STAGED", "CLEAN"), /INVALID_INGEST_TRANSITION/);
});
