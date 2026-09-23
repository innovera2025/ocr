import assert from "node:assert/strict";
import { test } from "node:test";
import { LEGACY_REVIEWER_LABEL, reviewerLabel } from "./labels.js";

test("the reviewer label: the joined name, the pre-login label for a row that matches no user, null when unconfirmed", () => {
  const userId = "0b7e9f5e-3b1c-4c0e-9d53-2a5f0c7c8f11";
  assert.equal(reviewerLabel(userId, "นก พนักงาน"), "นก พนักงาน");
  // reviewed_by is a varchar: a deleted account, a row from before login existed, or free text all join to no name.
  assert.equal(reviewerLabel(userId, null), LEGACY_REVIEWER_LABEL);
  assert.equal(reviewerLabel("user-a", null), LEGACY_REVIEWER_LABEL);
  assert.equal(reviewerLabel(userId, ""), LEGACY_REVIEWER_LABEL, "an empty display_name cannot exist, and would read as blank");
  // Never confirmed: the drawer shows no reviewer line at all, rather than the legacy label.
  assert.equal(reviewerLabel(null, null), null);
  assert.equal(reviewerLabel(undefined, undefined), null);
  assert.equal(reviewerLabel("", "นก พนักงาน"), null);
  assert.equal(LEGACY_REVIEWER_LABEL, "บัญชีรวม (ก่อนมีระบบล็อกอิน)");
});
