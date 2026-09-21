import test from "node:test";
import assert from "node:assert/strict";
import { mintOriginalKey, parseOriginalKey } from "./index.js";

const org = "11111111-1111-4111-8111-111111111111";
const doc = "abcdefghijklmnopqrstuvwxyz123456";

test("original keys are identity addressed and round trip", () => {
  const key = mintOriginalKey(org, doc);
  assert.equal(key, `org/${org}/original/ab/${doc}`);
  assert.deepEqual(parseOriginalKey(key)?.documentPublicId, doc);
});

test("malformed or cross-shaped keys are rejected", () => {
  assert.equal(parseOriginalKey(`org/${org}/original/zz/${doc}`), null);
  assert.throws(() => mintOriginalKey(org, "../../escape"), /INVALID_DOCUMENT_PUBLIC_ID/);
});
