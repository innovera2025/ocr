import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { COMMON_PASSWORDS } from "./common-passwords.js";
import {
  adminGate, checkPasswordPolicy, DUMMY_HASH, generateTemporaryPassword, HashGate, hashPassword, loginGate,
  needsRehash, normalizePassword, PasswordPolicyError, SCRYPT_PARAMS, verifyPassword, type ScryptParams
} from "./password.js";

/** The cheapest setting the verifier still accepts, so the suite is not ten seconds of key derivation. */
const FAST: ScryptParams = { N: 16_384, r: 8, p: 1 };
const HASH_FORMAT = /^scrypt\$v1\$N=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/;
const FAKE_PASSWORD = "fake-test-password-01";

function forgeHash(N: number, r: number, p: number): string {
  return `scrypt$v1$N=${N},r=${r},p=${p}$${randomBytes(16).toString("base64url")}$${randomBytes(32).toString("base64url")}`;
}

function paramsOf(stored: string): ScryptParams {
  const match = HASH_FORMAT.exec(stored);
  assert.ok(match, `not a stored hash: ${stored.slice(0, 16)}…`);
  return { N: Number(match[1]), r: Number(match[2]), p: Number(match[3]) };
}

test("password hashes are self-describing and round-trip", async () => {
  const stored = await hashPassword(FAKE_PASSWORD, FAST);
  assert.match(stored, HASH_FORMAT);
  assert.ok(stored.startsWith("scrypt$"), "the 0019 CHECK requires the scrypt$ prefix");
  assert.ok(stored.length <= 200, "password_hash is varchar(200)");
  assert.deepEqual(paramsOf(stored), FAST);
  assert.equal(await verifyPassword(stored, FAKE_PASSWORD), true);
});

test("password verification rejects a wrong password and re-salts every hash", async () => {
  const stored = await hashPassword(FAKE_PASSWORD, FAST);
  assert.equal(await verifyPassword(stored, "fake-test-password-02"), false);
  assert.equal(await verifyPassword(stored, ""), false);
  const again = await hashPassword(FAKE_PASSWORD, FAST);
  assert.notEqual(again, stored, "a fresh salt every time");
  assert.equal(await verifyPassword(again, FAKE_PASSWORD), true);
});

test("password verification rejects malformed and out-of-bounds hashes without derivation", async () => {
  const rejected = [
    "", "not-a-hash", "scrypt$", "scrypt$v2$N=32768,r=8,p=3$AAAA$AAAA",
    `scrypt$v1$N=32768,r=8,p=3$${randomBytes(15).toString("base64url")}$${randomBytes(32).toString("base64url")}`,
    `scrypt$v1$N=32768,r=8,p=3$${randomBytes(16).toString("base64url")}$${randomBytes(31).toString("base64url")}`,
    forgeHash(8_192, 8, 3), forgeHash(262_144, 8, 3), forgeHash(24_576, 8, 3),
    forgeHash(32_768, 4, 3), forgeHash(32_768, 32, 3), forgeHash(32_768, 8, 0), forgeHash(32_768, 8, 5)
  ];
  const started = performance.now();
  for (const stored of rejected) assert.equal(await verifyPassword(stored, FAKE_PASSWORD), false, stored);
  const each = (performance.now() - started) / rejected.length;
  assert.ok(each < 5, `a rejected hash must cost no derivation, took ${each.toFixed(2)} ms each`);
});

test("password needsRehash tracks the current parameters", async () => {
  assert.equal(needsRehash(forgeHash(SCRYPT_PARAMS.N, SCRYPT_PARAMS.r, SCRYPT_PARAMS.p)), false);
  assert.equal(needsRehash(await hashPassword(FAKE_PASSWORD, FAST)), true);
  assert.equal(needsRehash("not-a-hash"), true);
  assert.equal(needsRehash(forgeHash(SCRYPT_PARAMS.N, SCRYPT_PARAMS.r, 1)), true);
});

test("password normalization makes Thai sara am equal its decomposition", async () => {
  const composed = `รหัสผ่านทำงาน`;
  const decomposed = composed.replace("ำ", "ํา");
  assert.notEqual(composed, decomposed);
  assert.equal(normalizePassword(composed), normalizePassword(decomposed));
  const stored = await hashPassword(composed, FAST);
  assert.equal(await verifyPassword(stored, decomposed), true);
});

test("password DUMMY_HASH costs exactly what a real hash costs", async () => {
  assert.match(DUMMY_HASH, HASH_FORMAT);
  assert.deepEqual(paramsOf(DUMMY_HASH), paramsOf(await hashPassword(FAKE_PASSWORD, SCRYPT_PARAMS)));
  assert.equal(needsRehash(DUMMY_HASH), false);
  assert.equal(await verifyPassword(DUMMY_HASH, FAKE_PASSWORD), false);
});

test("password policy enforces the length and byte limits", () => {
  checkPasswordPolicy("fake-passphrase-ok", "somchai");
  assert.throws(() => checkPasswordPolicy("fake-pass12", "somchai"), (error: unknown) => {
    assert.ok(error instanceof PasswordPolicyError);
    assert.equal(error.message, "WEAK_PASSWORD");
    assert.equal(error.reason, "too_short");
    return true;
  });
  const longest = "fake-passphrase-".repeat(8);
  assert.equal([...longest].length, 128);
  checkPasswordPolicy(longest, "somchai");
  assert.throws(() => checkPasswordPolicy(`${longest}x`, "somchai"), /WEAK_PASSWORD/);
  // Code points, not UTF-16 units: 128 astral symbols are 512 bytes, exactly the byte ceiling, so both limits agree.
  const astral = Array.from({ length: 128 }, (_, index) => String.fromCodePoint(0x1f600 + (index % 64))).join("");
  assert.equal(Buffer.byteLength(astral, "utf8"), 512);
  checkPasswordPolicy(astral, "somchai");
  assert.throws(() => checkPasswordPolicy(astral + String.fromCodePoint(0x1f600), "somchai"), /WEAK_PASSWORD/);
  // Spaces and Thai are allowed, and there are no composition rules.
  checkPasswordPolicy("การนวดไทย สบายดี", "somchai");
});

test("password policy rejects the username, repetition and the denylist", () => {
  assert.throws(() => checkPasswordPolicy("xxSomchaixx-fake-1", "somchai"), /WEAK_PASSWORD/);
  assert.throws(() => checkPasswordPolicy("somchai-fake-pass", "SOMCHAI"), /WEAK_PASSWORD/);
  assert.throws(() => checkPasswordPolicy("aaaaaaaaaaaaaa", "somchai"), /WEAK_PASSWORD/);
  assert.throws(() => checkPasswordPolicy("Password123456", "somchai"), /WEAK_PASSWORD/);
  assert.throws(() => checkPasswordPolicy("makkhaspa2026", "somchai"), /WEAK_PASSWORD/);
  assert.ok(COMMON_PASSWORDS.size >= 150, "the bundled denylist is about 200 entries");
  for (const entry of COMMON_PASSWORDS) assert.equal(entry, entry.toLowerCase(), "entries are compared lower-cased");
  // An empty username must not make every password "contain" it.
  checkPasswordPolicy("fake-passphrase-ok", "");
});

test("password temporary generator uses the look-alike-free alphabet", () => {
  const seen = new Set<string>();
  for (let index = 0; index < 50; index += 1) {
    const value = generateTemporaryPassword();
    assert.match(value, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
    assert.equal(value.replace(/-/g, "").length, 16);
    assert.doesNotMatch(value, /[ilo01]/, "no look-alike symbols");
    seen.add(value);
  }
  assert.equal(seen.size, 50, "temporary passwords are random");
  checkPasswordPolicy(generateTemporaryPassword(), "somchai");
});

test("password HashGate queues to its limit and then refuses with LOGIN_BUSY", async () => {
  const gate = new HashGate(1, 1);
  const release: (() => void)[] = [];
  const hold = (): Promise<void> => new Promise<void>((resolve) => release.push(resolve));
  const tick = (): Promise<void> => new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  const first = gate.run(hold);
  const second = gate.run(hold);
  await tick();
  assert.equal(gate.running, 1);
  assert.equal(gate.queued, 1);
  await assert.rejects(gate.run(hold), /LOGIN_BUSY/);
  release[0]!();
  await first;
  await tick();
  assert.equal(gate.running, 1, "the freed slot goes straight to the waiter");
  assert.equal(gate.queued, 0);
  release[1]!();
  await second;
  assert.equal(gate.running, 0);
  assert.equal(gate.queued, 0);
  assert.equal(await gate.run(async () => "open"), "open");
});

test("password gates are split so an admin reset survives a saturated login gate", () => {
  assert.equal(loginGate.limit, 2);
  assert.equal(loginGate.queueLimit, 16);
  assert.equal(adminGate.limit, 1);
  assert.equal(adminGate.queueLimit, 4);
  assert.notEqual(loginGate, adminGate);
});
