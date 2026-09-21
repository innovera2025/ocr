import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { readRawUpload } from "./http.js";

test("raw upload enforces declared length and canonical validation", async () => {
  const request = Object.assign(Readable.from([Buffer.from("pdf")]), { headers: { "content-type": "application/pdf", "content-length": "3", "x-upload-filename": "a.pdf" } });
  const upload = await readRawUpload(request as never, 100);
  assert.equal(upload.filename, "a.pdf");
  assert.deepEqual([...upload.bytes], [112, 100, 102]);
});
