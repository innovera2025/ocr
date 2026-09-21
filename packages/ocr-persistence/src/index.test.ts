import assert from "node:assert/strict";
import { test } from "node:test";
import { hasReviewFields, structuredStaffResult } from "./index.js";

test("needsReview mapping detects any staff field requiring review", () => {
  const response = { documentId: "d", staffOnly: { therapistName: { needsReview: false }, treatment: { needsReview: true } } };
  assert.equal(hasReviewFields(response), true);
  assert.deepEqual(structuredStaffResult(response), response.staffOnly);
});

test("needsReview mapping remains false when all fields are verified", () => {
  assert.equal(hasReviewFields({ documentId: "d", staffOnly: { roomNo: { needsReview: false } } }), false);
});
