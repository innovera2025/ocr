/**
 * The migration freeze (plan §14, §15 Deploy A step 11). `runMigrations` stores the sha256 of every file it applies and
 * refuses to start when the file it reads no longer matches (`packages/db-runtime/src/index.ts`
 * `MIGRATION_CHECKSUM_MISMATCH`). That check only ever fires in production, AFTER the container is built and BEFORE it
 * listens — so an edit to an applied migration passes typecheck, lint and every other test in this repo and then
 * crash-loops the only way staff can log in.
 *
 * This test is the one that fails first. A migration that is already applied anywhere is frozen: a fix goes into a NEW
 * migration. When a genuinely new one is added, its entry is added here in the same commit.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const directory = fileURLToPath(new URL("../prisma/migrations", import.meta.url));

/** version → sha256 of its `migration.sql`, exactly as `schema_migrations.checksum` holds it. */
const CHECKSUMS: Readonly<Record<string, string>> = {
  "0001_foundation": "627396ed9c7ccd959ab9e8b82e19f6443aa8de60e4c2d79e833d8a9a3d952c14",
  "0002_queue_functions": "844d0238f2d58c2e81dbfeb31d6765f1c33e5a6bb7b2caac58d13ea6c473358c",
  "0003_ocr_integration": "daf7248b6066abebf41218ca8b09d3edff6f575dbed847cb5c14eea9ef5bb1e1",
  "0004_queue_claim_qualification": "2ed6e3c18280e0213b3ca15dccc6a6adc46f314a3c61fc772dc14028bf007408",
  "0005_queue_kind_cast": "fa92469d1f348b3e8241851a3f049ac82c870f97b2f91a4042e291acfa1d8ec5",
  "0006_correction_audit_outbox": "7c60263d8ea7a3ebfae06bf4e107fc0044964da23675d28aa2a4346a4424ac7a",
  "0007_queue_retry_function": "eedadc36ff9743d285cd8c60f6b58d7db3e9cbbc40608c8ca1e6f4ebe447e8ce",
  "0008_queue_recovery_function": "bcc305f941184277dd053dc3917067c5e41b9c29f2c096f16d0c5687dc999d55",
  "0009_role_grants": "cd1d06c2d0574af130417a5a670f1ef0afdfdd2f8c3a525e9fa0f7d9cd071187",
  "0010_outbox_dispatcher": "33bd81e36cfbe2466dbd3f378738d158d8e602b13131be345ee46b83ee0b2dab",
  "0011_upload_idempotency": "5396534bc0105bab6fb15d28906fecccff831d75aff665c8acb09d94ce8749f9",
  "0012_role_tightening": "9c16f8f65c34424f6eb8b6de18fbe51ae596c976c92c89dcff370cace0e16555",
  "0013_runtime_fk_privileges": "7eae605ff4e44fca1607906ec5557585473ad5c78757285c0f41be0445c0bc72",
  "0014_idempotency_cleanup_privilege": "a25dab9ee0ebeebba4b04f8c91f7c61e71940f3b34ca9c445ec4511578fe20c8",
  "0015_worker_schema_readiness": "5ecd796be66eda86f1366100ff3fb2a380c5cdd4947bd8843af7a5f41ed4efac",
  "0016_runtime_queue_permissions": "a2ab81a3807c388cde7bd05e4d7effa4c720ce92718dd28020f52e01874c36ee",
  "0017_batch_processing": "60d2fbcc8ed9b380b0abe607a2821dc6140959eb1bd578d4297a88bee053ff5e",
  "0018_multipage_documents": "90c44786f7424ade6012f722354c41b0a8af19d87c9b326f934aef1435c416cc",
  // Applied in production by Deploy A and frozen there: a policy fix takes 0021, never an edit to this file.
  "0019_user_auth": "45700e3814d1c3472dc017ae1b7384af9de81cede0d8ae26ee0b592895bda58c",
  // Applied by NO deploy yet — Deploy B applies it and freezes it. Until then an edit is allowed: regenerate this
  // line in the same commit (`sha256sum prisma/migrations/0020_batch_round_clock/migration.sql`).
  "0020_batch_round_clock": "a8a351fd40364a96c60b67672a0e83de3073de2ccfb02cd5af1053e4d3e6ecd9"
};

function sha256(version: string): string {
  return createHash("sha256").update(readFileSync(join(directory, version, "migration.sql"), "utf8")).digest("hex");
}

/**
 * The newest version `schema_migrations` records in production today: Deploy A applied 0001–0019. Everything up to
 * and including it is frozen — a fix goes in a NEW migration. Anything after it is not applied anywhere yet and may
 * still be edited; the pin is simply regenerated in the same commit, because the pin is what freezes it the moment
 * the deploy that applies it runs. Move this line in the same commit as the deploy that applies the next one.
 */
export const APPLIED_IN_PRODUCTION = "0020_batch_round_clock";

test("every applied migration still hashes to the value production recorded", () => {
  for (const [version, expected] of Object.entries(CHECKSUMS)) {
    assert.equal(sha256(version), expected, version <= APPLIED_IN_PRODUCTION
      ? `${version} changed, and it is applied in production (0001–${APPLIED_IN_PRODUCTION} are frozen): put the fix `
        + `in a new migration, or production answers MIGRATION_CHECKSUM_MISMATCH:${version} at startup and crash-loops.`
      : `${version} changed. It is not applied anywhere yet, so editing it is allowed — regenerate its pin in this `
        + "same commit, which is what freezes it when the deploy that applies it runs.");
  }
});

test("no migration directory is missing from the pin, and none is pinned that does not exist", () => {
  const onDisk = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+_[a-z0-9_]+$/.test(entry.name)).map((entry) => entry.name).sort();
  // `runMigrations` iterates exactly this list in exactly this order, so a new migration that is not pinned here would
  // be free to change after it is applied.
  assert.deepEqual(onDisk, Object.keys(CHECKSUMS).sort());
});
