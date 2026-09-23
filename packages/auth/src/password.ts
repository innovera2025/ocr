import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { COMMON_PASSWORDS } from "./common-passwords.js";

export type ScryptParams = Readonly<{ N: number; r: number; p: number }>;

/**
 * Current cost (plan §2 D3): OWASP's scrypt setting, 32 MiB and about 250 ms. Changing it is a staged rollout —
 * new constant, every account rehashed by `needsRehash` at its next login, and only then may the old parameter set
 * leave the accepted bounds below.
 */
export const SCRYPT_PARAMS: ScryptParams = Object.freeze({ N: 32_768, r: 8, p: 3 });

const SALT_BYTES = 16;
const KEY_BYTES = 32;
/** 64 MiB, which is twice what `SCRYPT_PARAMS` needs. An older in-bounds hash gets whatever its own cost requires. */
const MAXMEM = 67_108_864;
/** Self-describing, so a stored hash carries the parameters it was made with: `scrypt$v1$N=…,r=…,p=…$salt$key`. */
const HASH_FORMAT = /^scrypt\$v1\$N=(\d{1,7}),r=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
export const PASSWORD_MAX_BYTES = 512;

/** Alphabet without look-alikes (no i, l, o, 0, 1); 31 symbols, so 16 of them carry about 79 bits. */
const TEMPORARY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const TEMPORARY_LENGTH = 16;
/** Largest multiple of the alphabet size that fits in a byte; above it the byte is redrawn, so every symbol is equally likely. */
const TEMPORARY_CUTOFF = TEMPORARY_ALPHABET.length * Math.floor(256 / TEMPORARY_ALPHABET.length);

export type PasswordPolicyReason = "too_short" | "too_long" | "too_many_bytes" | "contains_username" | "repeated_character" | "common_password";

/** The message is the wire code (`errorStatus` maps `WEAK_PASSWORD` to 400); `reason` is for the CLI and the UI only. */
export class PasswordPolicyError extends Error {
  readonly reason: PasswordPolicyReason;
  constructor(reason: PasswordPolicyReason) {
    super("WEAK_PASSWORD");
    this.name = "PasswordPolicyError";
    this.reason = reason;
  }
}

/** NFKC, so the Thai ำ a reviewer types equals the ํ + า another keyboard produces. */
export function normalizePassword(password: string): string {
  return password.normalize("NFKC");
}

function withinBounds(params: ScryptParams): boolean {
  const { N, r, p } = params;
  return Number.isInteger(N) && N >= 16_384 && N <= 131_072 && (N & (N - 1)) === 0
    && Number.isInteger(r) && r >= 8 && r <= 16
    && Number.isInteger(p) && p >= 1 && p <= 4;
}

type StoredHash = Readonly<{ params: ScryptParams; salt: Buffer; key: Buffer }>;

/** Returns null for anything malformed or out of bounds, without deriving a key, so a bad row costs no CPU. */
function parseHash(stored: string): StoredHash | null {
  const match = HASH_FORMAT.exec(stored);
  if (!match) return null;
  const params: ScryptParams = { N: Number(match[1]), r: Number(match[2]), p: Number(match[3]) };
  if (!withinBounds(params)) return null;
  const salt = Buffer.from(match[4]!, "base64url");
  const key = Buffer.from(match[5]!, "base64url");
  if (salt.length !== SALT_BYTES || key.length !== KEY_BYTES) return null;
  return { params, salt, key };
}

function formatHash(params: ScryptParams, salt: Buffer, key: Buffer): string {
  return `scrypt$v1$N=${params.N},r=${params.r},p=${params.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const maxmem = Math.max(MAXMEM, 128 * params.N * params.r * 2);
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_BYTES, { N: params.N, r: params.r, p: params.p, maxmem }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string, params: ScryptParams = SCRYPT_PARAMS): Promise<string> {
  if (!withinBounds(params)) throw new Error("INVALID_SCRYPT_PARAMS");
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(normalizePassword(password), salt, params);
  return formatHash(params, salt, key);
}

/** Verifies against the parameters the stored hash carries, so old hashes keep working until their owner logs in. */
export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  let key: Buffer;
  try {
    key = await derive(normalizePassword(password), parsed.salt, parsed.params);
  } catch {
    return false;
  }
  return key.length === parsed.key.length && timingSafeEqual(key, parsed.key);
}

/** True when the hash is unreadable or was made with parameters other than the current ones. */
export function needsRehash(stored: string): boolean {
  const parsed = parseHash(stored);
  return parsed === null || parsed.params.N !== SCRYPT_PARAMS.N || parsed.params.r !== SCRYPT_PARAMS.r || parsed.params.p !== SCRYPT_PARAMS.p;
}

/**
 * Verified when the username is unknown, so an unknown name costs the same as a known one. It is a well-formed hash
 * carrying exactly `SCRYPT_PARAMS`, built from random bytes rather than from a placeholder password: the derivation
 * `verifyPassword` runs is identical either way, no password can match 32 random bytes, and start-up stays free.
 */
export const DUMMY_HASH: string = formatHash(SCRYPT_PARAMS, randomBytes(SALT_BYTES), randomBytes(KEY_BYTES));

/**
 * Throws `WEAK_PASSWORD` (a `PasswordPolicyError` carrying the reason). Spaces and Thai are allowed and there are no
 * composition rules: length plus a denylist is what ASVS asks for.
 */
export function checkPasswordPolicy(password: string, username: string): void {
  const normalized = normalizePassword(password);
  const points = [...normalized];
  if (points.length < PASSWORD_MIN_LENGTH) throw new PasswordPolicyError("too_short");
  if (points.length > PASSWORD_MAX_LENGTH) throw new PasswordPolicyError("too_long");
  if (Buffer.byteLength(normalized, "utf8") > PASSWORD_MAX_BYTES) throw new PasswordPolicyError("too_many_bytes");
  const lowered = normalized.toLowerCase();
  const name = normalizePassword(username).trim().toLowerCase();
  if (name.length > 0 && lowered.includes(name)) throw new PasswordPolicyError("contains_username");
  if (points.every((point) => point === points[0])) throw new PasswordPolicyError("repeated_character");
  if (COMMON_PASSWORDS.has(lowered)) throw new PasswordPolicyError("common_password");
}

/** 16 symbols (about 79 bits) grouped as `xxxx-xxxx-xxxx-xxxx` so an admin can read it out once. */
export function generateTemporaryPassword(): string {
  const symbols: string[] = [];
  while (symbols.length < TEMPORARY_LENGTH) {
    for (const byte of randomBytes(TEMPORARY_LENGTH * 2)) {
      if (symbols.length === TEMPORARY_LENGTH) break;
      if (byte >= TEMPORARY_CUTOFF) continue;
      symbols.push(TEMPORARY_ALPHABET[byte % TEMPORARY_ALPHABET.length]!);
    }
  }
  return [0, 4, 8, 12].map((start) => symbols.slice(start, start + 4).join("")).join("-");
}

/**
 * Bounds the concurrent scrypt jobs, so a login flood cannot take the box. A slot freed by a finished job is handed
 * straight to the next waiter, never released into the open, so the limit holds under bursts.
 */
export class HashGate {
  readonly limit: number;
  readonly queueLimit: number;
  #running = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(limit: number, queueLimit: number) {
    this.limit = limit;
    this.queueLimit = queueLimit;
  }

  get running(): number { return this.#running; }
  get queued(): number { return this.#waiting.length; }

  /** Throws `LOGIN_BUSY` once the queue is full. The work itself must never hold a database transaction. */
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.#running < this.limit) this.#running += 1;
    else if (this.#waiting.length < this.queueLimit) await new Promise<void>((resolve) => this.#waiting.push(resolve));
    else throw new Error("LOGIN_BUSY");
    try {
      return await work();
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#running -= 1;
    }
  }
}

/**
 * Two gates, not one (plan §4 B1): a saturated login gate must not also block an admin's password reset, which is
 * the recovery path out of exactly that situation.
 */
export const loginGate = new HashGate(2, 16);
export const adminGate = new HashGate(1, 4);
