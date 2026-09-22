import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { limits, loadConfig } from "@innovera/ocr-config";
import { validatePayload } from "@innovera/ocr-worker";

test("M1 limits remain aligned with the canonical upload and OCR budgets", () => {
  assert.equal(limits.maxUploadBytes, 209_715_200);
  assert.equal(limits.jobProcessingBudgetMs, 1_800_000);
  assert.equal(limits.maxOcrPagesPerDocument, 300);
});

test("worker rejects storage keys outside the payload organisation prefix", () => {
  assert.throws(() => validatePayload({
    schemaVersion: 1,
    documentId: "doc_01",
    organizationId: "org_01",
    sourceKey: "org/org_02/documents/doc_01/original"
  }), /INVALID_TENANT_STORAGE_KEY/);
});

test("OCR requests wait 300 s by default (config and both compose services), within the 900 s schema cap", () => {
  assert.equal(loadConfig({}).ocr.requestTimeoutSeconds, 300);
  assert.equal(loadConfig({ OCR_REQUEST_TIMEOUT: "900" }).ocr.requestTimeoutSeconds, 900);
  assert.throws(() => loadConfig({ OCR_REQUEST_TIMEOUT: "901" }));
  const compose = readFileSync(new URL("../deploy/docker-compose.yml", import.meta.url), "utf8");
  assert.equal(compose.match(/OCR_REQUEST_TIMEOUT: \$\{OCR_REQUEST_TIMEOUT:-300\}/g)?.length, 2);
  assert.match(compose, /OCR_MAX_PDF_PAGES: \$\{OCR_MAX_PDF_PAGES:-300\}/);
});

test("the worker image ships poppler-utils for the PDF split", () => {
  const dockerfile = readFileSync(new URL("../deploy/Dockerfile.worker", import.meta.url), "utf8");
  assert.match(dockerfile, /apt-get install -y --no-install-recommends poppler-utils/);
  assert.match(dockerfile, /rm -rf \/var\/lib\/apt\/lists/);
});
