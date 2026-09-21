import test from "node:test";
import assert from "node:assert/strict";
import { disabledAiExtractor, parseAiGatewayConfig } from "./index.ts";
test("AI configuration fails closed without endpoint, key and allowlist", () => {
  assert.equal(parseAiGatewayConfig({ OCR_AI_STAGE_ENABLED: "true" }).state, "disabled");
});
test("M1 extractor is inert", async () => {
  await assert.rejects(() => disabledAiExtractor().extract({ documentId: "doc", text: "synthetic" }), /AI_STAGE_DISABLED/);
});
