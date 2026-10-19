import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRoundCap, parseRoundNo, roundStateOf, RoundAlreadyStartedError, stoppedByName, toQueueControlState } from "./queue-control.js";

const audit = { actorUserId: "00000000-0000-4000-8000-000000000001" };

test("roundStateOf (D7): stopped wins, a full round is round_full, null cap is unlimited", () => {
  assert.equal(roundStateOf({ stopped: false, roundCap: null, roundDone: 10_000 }), "reading");
  assert.equal(roundStateOf({ stopped: false, roundCap: 3, roundDone: 2 }), "reading");
  assert.equal(roundStateOf({ stopped: false, roundCap: 3, roundDone: 3 }), "round_full");
  assert.equal(roundStateOf({ stopped: false, roundCap: 3, roundDone: 7 }), "round_full", "N lowered below the count");
  assert.equal(roundStateOf({ stopped: true, roundCap: 3, roundDone: 3 }), "stopped");
  assert.equal(roundStateOf({ stopped: true, roundCap: null, roundDone: 0 }), "stopped");
});

test("parseRoundCap: an integer 1..100000 or null; anything else ROUND_CAP_INVALID", () => {
  assert.deepEqual([parseRoundCap(1), parseRoundCap(100_000), parseRoundCap(null)], [1, 100_000, null]);
  for (const bad of [undefined, 0, -1, 100_001, 2.5, "3", Number.NaN, Infinity, true, {}]) assert.throws(() => parseRoundCap(bad), { message: "ROUND_CAP_INVALID" }, String(bad));
});

test("parseRoundNo: a positive int4; anything else ROUND_INVALID", () => {
  assert.deepEqual([parseRoundNo(1), parseRoundNo(2_147_483_647)], [1, 2_147_483_647]);
  for (const bad of [undefined, null, 0, -3, 1.5, "2", 2_147_483_648]) assert.throws(() => parseRoundNo(bad), { message: "ROUND_INVALID" }, String(bad));
});

test("toQueueControlState: the API shape, with stoppedBy only while stopped; ROUND_ALREADY_STARTED carries the state", () => {
  const row = { stopped_at: new Date("2026-10-19T01:02:03.000Z"), stopped_by: "แอดมิน", round_cap: 3, round_no: 4, round_started_at: new Date("2026-10-19T00:00:00.000Z"), round_done: 3 };
  const state = toQueueControlState(row);
  assert.deepEqual(state, { stopped: true, stoppedAt: "2026-10-19T01:02:03.000Z", stoppedBy: "แอดมิน", roundCap: 3, roundNo: 4, roundStartedAt: "2026-10-19T00:00:00.000Z",
    roundDone: 3, roundState: "stopped" });
  assert.equal(toQueueControlState({ ...row, stopped_at: null }).stoppedBy, null);
  assert.equal(toQueueControlState({ ...row, stopped_at: null }).roundState, "round_full");
  assert.equal(toQueueControlState({ ...row, stopped_at: null, round_cap: null }).roundState, "reading");
  const error = new RoundAlreadyStartedError(state);
  assert.deepEqual([error.message, error.control.roundNo], ["ROUND_ALREADY_STARTED", 4]);
});

test("stoppedByName: the display name, control characters stripped, at most 255 characters, never empty", () => {
  assert.equal(stoppedByName({ displayName: " สมชาย\u0000 ", audit }), "สมชาย");
  assert.equal(stoppedByName({ displayName: "x".repeat(300), audit }).length, 255);
  assert.equal(stoppedByName({ displayName: "", audit }), "-");
});
