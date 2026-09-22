import assert from "node:assert/strict";
import { test } from "node:test";
import { pageJobPriority } from "@innovera/ocr-persistence";
import { DEFAULT_JOB_PRIORITY } from "@innovera/ocr-queue/postgres";
import { batchJobPriority } from "./runtime.js";

test("fair priority at insert time: k-th file of a batch 100 + k, single upload / retry 100, PDF page p 100 + (p - 1)", () => {
  assert.equal(DEFAULT_JOB_PRIORITY, 100);
  assert.deepEqual([1, 2, 3, 500].map(batchJobPriority), [101, 102, 103, 600]);
  assert.deepEqual([1, 2, 95].map(pageJobPriority), [100, 101, 194]);
});

test("claim order (priority ASC, available_at ASC like ocr_claim_v1): two big uploads interleave and a single image goes next", () => {
  type Job = { name: string; priority: number; at: number };
  const pdf = (prefix: string, start: number): Job[] => Array.from({ length: 95 }, (_, index) => ({ name: `${prefix}${index + 1}`, priority: pageJobPriority(index + 1), at: start + index }));
  const imageBatch = Array.from({ length: 5 }, (_, index) => ({ name: `batch${index + 1}`, priority: batchJobPriority(index + 1), at: 5 + index }));
  const jobs: Job[] = [...pdf("A", 10), { name: "single", priority: DEFAULT_JOB_PRIORITY, at: 50 }, ...pdf("B", 60), ...imageBatch];
  const order = [...jobs].sort((a, b) => a.priority - b.priority || a.at - b.at).map((job) => job.name);
  assert.deepEqual(order.slice(0, 9), ["A1", "single", "B1", "batch1", "A2", "B2", "batch2", "A3", "B3"]);
  // The single image arrived while the 95-page PDF was queued: it waits for at most one page per big upload.
  assert.ok(order.indexOf("single") < order.indexOf("A2"));
});
