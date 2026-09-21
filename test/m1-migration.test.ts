import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("foundation migration contains tenant-bound tables and forced RLS", () => {
  const sql = readFileSync(new URL("../prisma/migrations/0001_foundation/migration.sql", import.meta.url), "utf8");
  for (const table of ["documents", "document_runs", "document_pages", "extraction_jobs", "ocr_results"]) {
    assert.match(sql, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`));
  }
  assert.match(sql, /FOREIGN KEY \(run_id, organization_id\) REFERENCES document_runs/);
  assert.match(sql, /CREATE UNIQUE INDEX document_run_one_active/);
});
