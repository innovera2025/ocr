import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("queue migration exposes only fenced security-definer functions", () => {
  const sql = readFileSync(new URL("../prisma/migrations/0002_queue_functions/migration.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE OR REPLACE FUNCTION ocr_claim_v1/);
  assert.match(sql, /SECURITY DEFINER/);
  assert.match(sql, /REVOKE ALL ON extraction_jobs FROM ocr_worker/);
  assert.match(sql, /lease_token_hash=digest\(p_lease_token, 'sha256'\)/);
  assert.match(sql, /FOR UPDATE SKIP LOCKED/);
});
