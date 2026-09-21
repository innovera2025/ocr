import test from "node:test";
import assert from "node:assert/strict";
import { createClamAvClient } from "./clamav.js";

test("clamav adapter maps a positive scan to clean", async () => {
  assert.equal(await createClamAvClient(async () => true).scan(new Uint8Array([1])), "CLEAN");
  assert.equal(await createClamAvClient(async () => false).scan(new Uint8Array([1])), "QUARANTINED");
});

test("scanner transport errors fail closed", async () => {
  const client = createClamAvClient(async () => { throw new Error("daemon unavailable"); });
  await assert.rejects(() => client.scan(new Uint8Array([1])), /daemon unavailable/);
});
