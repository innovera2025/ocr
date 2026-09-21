import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PostgresOcrDocumentStore } from "@innovera/ocr-persistence";

const migrator = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATOR });
const app = new PostgresOcrDocumentStore(process.env.DATABASE_URL_APP!);
const tenant = randomUUID();
const key = `e2e-${randomUUID()}`;
const bytes = new Uint8Array([137, 80, 78, 71]);
async function main(): Promise<void> {
try {
  await migrator.query("INSERT INTO organizations(id,name) VALUES ($1,$2)", [tenant, "runtime-hardening-check"]);
  const create = () => app.createUploadedDocument({ tenantId: tenant, filename: "sample.png", mimeType: "image/png", sizeBytes: bytes.byteLength, contentHash: "e2e-hash", storageKey: `org/${tenant}/original/e2/sample`, idempotencyKey: key, requestFingerprint: "e2e-fingerprint" });
  const rows = await Promise.all([create(), create()]);
  const count = await migrator.query("SELECT count(*)::int AS count FROM documents WHERE organization_id=$1", [tenant]);
  if (Number(count.rows[0].count) !== 1 || rows[0].documentId !== rows[1].documentId) throw new Error("IDEMPOTENCY_E2E_FAILED");
  process.stdout.write(`${JSON.stringify({ idempotency: "ok", documentId: rows[0].documentId })}\n`);
} finally {
  await migrator.query("DELETE FROM upload_idempotency_keys WHERE organization_id=$1", [tenant]);
  await migrator.query("DELETE FROM extraction_jobs WHERE organization_id=$1", [tenant]);
  await migrator.query("DELETE FROM document_runs WHERE organization_id=$1", [tenant]);
  await migrator.query("DELETE FROM documents WHERE organization_id=$1", [tenant]);
  await migrator.query("DELETE FROM organizations WHERE id=$1", [tenant]);
  await app.close();
  await migrator.end();
}
}
main().catch((error: unknown) => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
