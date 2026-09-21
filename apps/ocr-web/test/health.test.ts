import test from "node:test";
import assert from "node:assert/strict";
import { healthResponse } from "../src/server.js";

test("health endpoints expose only readiness state", () => {
  assert.deepEqual(healthResponse("/health/live"), { status: 200, body: { status: "ok" } });
  assert.deepEqual(healthResponse("/health/ready"), { status: 200, body: { status: "ready" } });
  assert.equal(healthResponse("/api/documents").status, 404);
});
