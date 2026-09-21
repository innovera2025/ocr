import assert from "node:assert/strict";
import { test } from "node:test";
import { OcrClient, OcrClientError, readOcrTimings, type OcrResponse, type TreatmentField } from "./index.js";

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

test("OCR client keeps v3 full-document responses intact", async () => {
  const treatment: TreatmentField = { raw: "ไทย 90 นาที", value: "นวดไทย", confidence: 0.93, source: "master-fuzzy", needsReview: false, nameRaw: "ไทย", duration: "90 นาที", durationMinutes: 90 };
  const body = { documentId: "ocr-4", engine: "typhoon-sections", version: "3.0", schemaVersion: 3, staffOnly: { treatments: [treatment] }, timings: { inferenceMs: 2900, totalMs: 1650, sections: [{ name: "staffOnly", ms: 1500 }] }, needsReview: true };
  const client = new OcrClient({ baseUrl: "https://ocr.example/ocr", timeoutMs: 100, maxRetries: 0, fetchImpl: async () => response(200, body) });
  const result: OcrResponse = await client.processDocument(new Uint8Array([1]), "a.png", "image/png");
  assert.deepEqual(result, body);
  assert.deepEqual(readOcrTimings(result), { inferenceMs: 2900, totalMs: 1650, sections: [{ name: "staffOnly", ms: 1500 }] });
});

test("OCR timings reader ignores missing and malformed values", () => {
  assert.deepEqual(readOcrTimings({}), {});
  assert.deepEqual(readOcrTimings({ timings: "fast" }), {});
  assert.deepEqual(readOcrTimings({ timings: { inferenceMs: "2900", totalMs: -1, checkboxMs: Number.NaN, preprocessMs: 12, sections: [{ name: 1, ms: 2 }, null] } }), { preprocessMs: 12 });
});

test("OCR client marks client errors non-retryable and server errors retryable", async () => {
  const failing = (status: number) => new OcrClient({ baseUrl: "https://ocr.example/ocr", timeoutMs: 100, maxRetries: 0, fetchImpl: async () => response(status, {}) });
  await assert.rejects(() => failing(422).processDocument(new Uint8Array([1])), (error: unknown) => error instanceof OcrClientError && error.status === 422 && !error.retryable);
  await assert.rejects(() => failing(503).processDocument(new Uint8Array([1])), (error: unknown) => error instanceof OcrClientError && error.status === 503 && error.retryable);
  await assert.rejects(() => failing(408).processDocument(new Uint8Array([1])), (error: unknown) => error instanceof OcrClientError && error.status === 408 && error.retryable);
});

test("OCR health check probes GET /health", async () => {
  const seen: string[] = [];
  const client = (body: unknown, status = 200) => new OcrClient({ baseUrl: "https://ocr.example/ocr", timeoutMs: 100, maxRetries: 0, fetchImpl: async (input, init) => { seen.push(`${init?.method ?? "GET"} ${String(input)}`); return response(status, body); } });
  assert.equal(await client({ status: "ok", version: "3.0" }).healthCheck(), true);
  assert.deepEqual(seen, ["GET https://ocr.example/ocr/health"]);
  assert.equal(await client({ status: "degraded" }).healthCheck(), false);
  assert.equal(await client({}, 405).healthCheck(), false);
});
