import assert from "node:assert/strict";
import { test } from "node:test";
import { OcrClient, OcrClientError } from "./index.js";

const response = (status: number, body: unknown): Response => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" }
});

test("OCR client posts multipart upload and parses result", async () => {
  let seenUrl = "";
  let seenBody: FormData | undefined;
  const client = new OcrClient({
    baseUrl: "https://ocr.example/ocr",
    timeoutMs: 100,
    maxRetries: 0,
    fetchImpl: async (input, init) => {
      seenUrl = String(input);
      seenBody = init?.body as FormData;
      return response(200, { documentId: "ocr-1", staffOnly: { therapistName: { needsReview: true } } });
    }
  });
  const result = await client.processDocument(new Uint8Array([1, 2]), "sample.png", "image/png");
  assert.equal(result.documentId, "ocr-1");
  assert.equal(seenUrl, "https://ocr.example/ocr/v1/ocr");
  assert.equal(seenBody?.get("file") instanceof File, true);
});

test("OCR client retries HTTP 500", async () => {
  let attempts = 0;
  const client = new OcrClient({ baseUrl: "https://ocr.example/ocr", timeoutMs: 100, maxRetries: 2, fetchImpl: async () => {
    attempts += 1;
    return attempts < 2 ? response(500, {}) : response(200, { documentId: "ocr-2" });
  } });
  assert.equal((await client.processDocument(new Uint8Array([1]))).documentId, "ocr-2");
  assert.equal(attempts, 2);
});

test("OCR client exposes timeout after retries", async () => {
  const client = new OcrClient({ baseUrl: "https://ocr.example/ocr", timeoutMs: 1, maxRetries: 1, fetchImpl: async (_input, init) => {
    await new Promise<void>((resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
    return response(200, {});
  } });
  await assert.rejects(() => client.processDocument(new Uint8Array([1])), (error: unknown) => error instanceof OcrClientError && error.code === "timeout");
});

test("OCR client rejects malformed response", async () => {
  const client = new OcrClient({ baseUrl: "https://ocr.example/ocr", timeoutMs: 100, maxRetries: 0, fetchImpl: async () => response(200, { nope: true }) });
  await assert.rejects(() => client.processDocument(new Uint8Array([1])), (error: unknown) => error instanceof OcrClientError && error.code === "malformed");
});

test("OCR confirm sends corrected value", async () => {
  let body = "";
  const client = new OcrClient({ baseUrl: "https://ocr.example/ocr", timeoutMs: 100, maxRetries: 0, fetchImpl: async (_input, init) => {
    body = String(init?.body);
    return response(200, { accepted: true });
  } });
  await client.confirmResult({ documentId: "ocr-3", field: "therapist", raw: "พิพิ", verifiedValue: "พีพี" });
  assert.match(body, /verifiedValue/);
  assert.match(body, /พีพี/);
});
