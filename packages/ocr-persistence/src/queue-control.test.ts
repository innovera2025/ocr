import assert from "node:assert/strict";
import { test } from "node:test";
import { median, parseRoundCap, parseRoundNo, queueOverview, queueOverviewTotals, rateFromCompletions, roundStateOf, RoundAlreadyStartedError, stoppedByName,
  toQueueControlState } from "./queue-control.js";

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

// ---- D11 progress: rate, ETA, totals --------------------------------------------------------------------------------

const at = (seconds: number[]) => seconds.map((second) => Date.parse("2026-10-19T00:00:00Z") + second * 1000);

test("median: odd and even counts, input order irrelevant", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([190]), 190);
});

test("rateFromCompletions: gaps between consecutive reads, gaps over 15 min dropped, at least 5 gaps, median in seconds", () => {
  assert.deepEqual(rateFromCompletions([]), { secondsPerPage: null, sample: 0 });
  assert.deepEqual(rateFromCompletions(at([0, 190, 380, 570, 760])), { secondsPerPage: null, sample: 4 }, "4 gaps: not enough");
  assert.deepEqual(rateFromCompletions(at([0, 190, 380, 570, 760, 950])), { secondsPerPage: 190, sample: 5 });
  // A 20-minute stop between two reads is not reading time: that gap is dropped, the rest still decide.
  assert.deepEqual(rateFromCompletions(at([0, 200, 400, 600, 1800, 2000, 2200, 2400])), { secondsPerPage: 200, sample: 6 });
  assert.deepEqual(rateFromCompletions(at([0, 100, 1100, 2100, 3100, 4100, 5100])), { secondsPerPage: null, sample: 1 }, "only one gap at or under 900 s");
  assert.equal(rateFromCompletions(at([0, 900, 1800, 2700, 3600, 4500])).secondsPerPage, 900, "exactly 900 s is kept");
  // Even number of gaps: the mean of the middle two; unsorted input; only the last 21 completions count.
  assert.deepEqual(rateFromCompletions(at([600, 0, 100, 300, 450, 500, 700])), { secondsPerPage: 100, sample: 6 });
  const many = at(Array.from({ length: 40 }, (_, index) => index < 19 ? index * 10 : 1000 + (index - 19) * 300));
  assert.deepEqual(rateFromCompletions(many), { secondsPerPage: 300, sample: 20 }, "21 latest → 20 gaps, the old fast reads are ignored");
  assert.equal(rateFromCompletions(at([0, 190.04, 380.08, 570.12, 760.16, 950.2])).secondsPerPage, 190, "0.1 s precision");
});

const batch = (overrides: Partial<{ rowsExpected: number; completed: number; failed: number; queued: number; processing: number; uploaded: number; expectedTotal: number; filesDone: number; paused: boolean }> = {}) =>
  ({ rowsExpected: 10, completed: 4, failed: 1, queued: 5, processing: 1, uploaded: 2, expectedTotal: 3, filesDone: 1, paused: false, ...overrides });
const control = toQueueControlState({ stopped_at: null, stopped_by: null, round_cap: null, round_no: 1, round_started_at: new Date(0), round_done: 0 });

test("queueOverviewTotals: sums over every open batch; ETA null without a rate; held pages excluded from the ETA", () => {
  const batches = [batch(), batch({ rowsExpected: 20, completed: 0, failed: 0, queued: 20, processing: 0, uploaded: 1, expectedTotal: 1, filesDone: 0 })];
  const noRate = queueOverviewTotals(batches, control, { secondsPerPage: null, sample: 2 });
  assert.deepEqual(noRate, { openBatches: 2, pagesTotal: 30, pagesRead: 4, pagesFailed: 1, pagesWaiting: 25, pagesReading: 1, heldPages: 0, filesUploaded: 3,
    filesExpected: 4, filesDone: 1, secondsPerPage: null, etaSeconds: null, roundEtaSeconds: null, rateSample: 2 });
  const rated = queueOverviewTotals(batches, control, { secondsPerPage: 190, sample: 20 });
  assert.deepEqual([rated.etaSeconds, rated.roundEtaSeconds], [26 * 190, null], "26 pages left, no cap");
  const held = queueOverviewTotals([batches[0]!, { ...batches[1]!, paused: true }], control, { secondsPerPage: 190, sample: 20 });
  assert.deepEqual([held.heldPages, held.etaSeconds], [20, 6 * 190]);
  assert.equal(queueOverviewTotals([batch({ completed: 12 })], control, { secondsPerPage: 10, sample: 5 }).etaSeconds, 0, "never negative");
});

test("roundEtaSeconds: min(remaining, N − done) × rate with a cap; 0 once the round is full", () => {
  const capped = (roundCap: number, roundDone: number) => queueOverviewTotals([batch()], { roundCap, roundDone }, { secondsPerPage: 100, sample: 5 }).roundEtaSeconds;
  assert.equal(capped(3, 1), 200, "2 pages left in the round");
  assert.equal(capped(100, 0), 600, "the queue ends first: 6 pages");
  assert.equal(capped(3, 3), 0);
  assert.equal(capped(3, 7), 0, "N lowered below the count");
});

test("queueOverview: the first 50 batches, totals over all, holdsAvailable as given", () => {
  const many = Array.from({ length: 60 }, (_, index) => ({ ...batch(), batchId: `b-${index}` }));
  const result = queueOverview(control, many, { secondsPerPage: null, sample: 0 }, false);
  assert.deepEqual([result.batches.length, result.batchesTotal, result.overview.openBatches, result.overview.pagesTotal, result.holdsAvailable], [50, 60, 60, 600, false]);
  assert.equal(result.batches[49]!.batchId, "b-49");
  assert.deepEqual(Object.keys(result).sort(), ["batches", "batchesTotal", "control", "holdsAvailable", "overview"]);
});
