import test from "node:test";
import assert from "node:assert/strict";
import { claim, finish, heartbeat } from "./index.js";

test("lease token is returned once and fencing rejects wrong tokens", () => {
  const claimed = claim({ id: "job", status: "PENDING", attempts: 0 }, 1000);
  assert.equal(claimed.job.leaseTokenHash?.length, 64);
  assert.throws(() => heartbeat(claimed.job, "wrong", 1001), /LEASE_LOST/);
  const alive = heartbeat(claimed.job, claimed.leaseToken, 1001);
  assert.equal(finish(alive, claimed.leaseToken, "SUCCEEDED", 1002).status, "SUCCEEDED");
});

test("expired and non-pending jobs cannot be claimed or finished", () => {
  const claimed = claim({ id: "job", status: "PENDING", attempts: 0 }, 0);
  assert.throws(() => claim(claimed.job), /JOB_NOT_CLAIMABLE/);
  assert.throws(() => finish(claimed.job, claimed.leaseToken, "SUCCEEDED", 120001), /LEASE_LOST/);
});
