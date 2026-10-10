import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { decodeUploadFilename, handleRawUpload, readRawUpload } from "./http.js";

const rawRequest = (headers: Record<string, string>, body = "pdf") => Object.assign(Readable.from([Buffer.from(body)]), { headers: { "content-type": "application/pdf", "content-length": String(Buffer.byteLength(body)), ...headers } }) as never;

test("raw upload enforces declared length and canonical validation", async () => {
  const request = Object.assign(Readable.from([Buffer.from("pdf")]), { headers: { "content-type": "application/pdf", "content-length": "3", "x-upload-filename": "a.pdf" } });
  const upload = await readRawUpload(request as never, 100);
  assert.equal(upload.filename, "a.pdf");
  assert.deepEqual([...upload.bytes], [112, 100, 102]);
});

test("raw upload decodes URI-encoded Thai filenames", async () => {
  const name = "ใบลงทะเบียน 01 (สปา).pdf";
  const upload = await readRawUpload(rawRequest({ "x-upload-filename": encodeURIComponent(name), "x-upload-filename-encoding": "uri" }), 100);
  assert.equal(upload.filename, name.normalize("NFC"));
});

test("raw upload keeps a literal filename when no encoding is declared", async () => {
  const upload = await readRawUpload(rawRequest({ "x-upload-filename": "a%20b.pdf" }), 100);
  assert.equal(upload.filename, "a%20b.pdf");
});

test("raw upload rejects malformed URI filenames and unknown encodings", async () => {
  await assert.rejects(() => readRawUpload(rawRequest({ "x-upload-filename": "bad%E0%A4%A.pdf", "x-upload-filename-encoding": "uri" }), 100), /INVALID_UPLOAD_HEADERS/);
  await assert.rejects(() => readRawUpload(rawRequest({ "x-upload-filename": "a.pdf", "x-upload-filename-encoding": "base64" }), 100), /INVALID_UPLOAD_HEADERS/);
});

test("decoded filenames still pass canonical filename validation", async () => {
  const upload = await readRawUpload(rawRequest({ "x-upload-filename": encodeURIComponent("a\u0000‮b.pdf"), "x-upload-filename-encoding": "URI" }), 100);
  assert.equal(upload.filename, "ab.pdf");
  await assert.rejects(() => readRawUpload(rawRequest({ "x-upload-filename": encodeURIComponent("ก".repeat(121)), "x-upload-filename-encoding": "uri" }), 100), /FILENAME_TOO_LONG/);
});

test("filename decoder is a no-op without an encoding", () => {
  assert.equal(decodeUploadFilename("a%41.pdf", undefined), "a%41.pdf");
  assert.equal(decodeUploadFilename("a%41.pdf", " uri "), "aA.pdf");
});

test("a DUPLICATE_FILENAME refusal propagates through handleRawUpload unchanged, after the staged bytes are discarded", async () => {
  const duplicate = Object.assign(new Error("DUPLICATE_FILENAME"), { existing: { documentId: "doc-0" } });
  const discarded: string[] = [];
  await assert.rejects(() => handleRawUpload(rawRequest({ "x-upload-filename": encodeURIComponent("Makkha-B5.pdf "), "x-upload-filename-encoding": "uri" }), {
    stage: async () => "org/t/original/ab/dup", scan: async () => "CLEAN", enqueue: async () => "never",
    persistUpload: async () => { throw duplicate; },
    discard: async (key) => { discarded.push(key); }
  }, 100), (error: unknown) => error === duplicate);
  assert.deepEqual(discarded, ["org/t/original/ab/dup"]);
});
