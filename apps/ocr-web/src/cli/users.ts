import {
  checkPasswordPolicy, hashPassword, normalizePassword, PasswordPolicyError, type PasswordPolicyReason
} from "@innovera/ocr-auth";
import { loadWebConfig } from "@innovera/ocr-config";
import { createDatabasePool } from "@innovera/ocr-db-runtime";
import {
  LOGIN_LOCK_MINUTES, normalizeUsername, PostgresUserStore,
  type AuditContext, type AuditDetail, type AuditEvent, type CreateUserInput, type UserListItem
} from "@innovera/ocr-persistence";
import { isInteractive, TtyAborted, TtyReader, type SignalTarget, type Tty, type TtyOutput } from "./tty.js";

/**
 * §7 E1. The first administrator of a fresh tenant cannot be created through the web UI — every route needs a session
 * — so it is created here, at an interactive terminal, by the operator who is already on the host. The password is
 * typed twice, never echoed, and never travels through a flag, an environment variable or a file: `docker compose
 * exec` output does not reach `docker logs`, and the shell history keeps only the command.
 *
 * The CLI connects as **ocr_app** (`DATABASE_URL`) under `OCR_WEB_TENANT_ID`, so FORCE RLS and the least-privilege
 * grants of 0019 apply exactly as they do to the web service. It is never a superuser and it applies no migration.
 */
export type CliUserStore = Readonly<{
  readonly tenantId: string;
  assertTenant(): Promise<void>;
  countActiveAdmins(): Promise<number>;
  listUsers(): Promise<UserListItem[]>;
  createUser(input: CreateUserInput): Promise<UserListItem>;
  resetPassword(userId: string, newHash: string, audit: AuditContext, detail?: AuditDetail): Promise<void>;
  unlockUser(userId: string, audit: AuditContext): Promise<void>;
  recordAudit(event: Omit<AuditEvent, "tenantId">): Promise<void>;
}>;

export type UsersCliDeps = Readonly<{
  tty: Tty;
  /** stderr: usage and failures, so a success line stays the only thing on stdout. */
  error: TtyOutput;
  /** Opened only after the terminal and the arguments are known to be good, so a misuse never touches the database. */
  openStore: () => Promise<{ store: CliUserStore; close: () => Promise<void> }>;
  signals?: SignalTarget | undefined;
  /** The tests pass a cheap stand-in; production always pays the real 32 MiB scrypt cost. */
  hash?: ((password: string) => Promise<string>) | undefined;
}>;

const COMMANDS = ["create-admin", "reset-password", "unlock", "list"] as const;
type Command = (typeof COMMANDS)[number];
/** There is deliberately no password flag, no password file and no password environment variable. */
const FLAGS: Readonly<Record<Command, readonly string[]>> = Object.freeze({
  "create-admin": ["--username", "--display-name"],
  "reset-password": ["--username"],
  unlock: ["--username"],
  list: []
});
const USAGE = "ocr-users <create-admin|reset-password|unlock|list> [--username <ชื่อผู้ใช้>] [--display-name <ชื่อที่แสดง>]";

const POLICY_TEXT: Readonly<Record<PasswordPolicyReason, string>> = Object.freeze({
  too_short: "รหัสผ่านต้องยาวอย่างน้อย 12 ตัวอักษร",
  too_long: "รหัสผ่านยาวเกิน 128 ตัวอักษร",
  too_many_bytes: "รหัสผ่านยาวเกินไป",
  contains_username: "รหัสผ่านต้องไม่มีชื่อผู้ใช้อยู่ข้างใน",
  repeated_character: "รหัสผ่านต้องไม่ใช่ตัวอักษรเดิมซ้ำกันทั้งหมด",
  common_password: "รหัสผ่านนี้ถูกเดาได้ง่ายเกินไป"
});
/** Everything a prompt or the store can refuse with. Nothing here can contain what was typed. */
const ERROR_TEXT: Readonly<Record<string, string>> = Object.freeze({
  ABORTED: "ยกเลิกแล้ว",
  ADMIN_EXISTS: "มีผู้ดูแลระบบที่ใช้งานอยู่แล้ว ให้สร้างบัญชีถัดไปจากหน้าจัดการผู้ใช้",
  PASSWORD_MISMATCH: "รหัสผ่านทั้งสองครั้งไม่ตรงกัน",
  INVALID_USERNAME: "ชื่อผู้ใช้ต้องเป็น a-z 0-9 . _ - ยาว 3-32 ตัว และขึ้นต้นด้วยตัวอักษรหรือตัวเลข",
  INVALID_DISPLAY_NAME: "ชื่อที่แสดงต้องยาว 1-100 ตัวอักษร",
  USERNAME_TAKEN: "ชื่อผู้ใช้นี้มีอยู่แล้ว",
  USER_NOT_FOUND: "ไม่พบผู้ใช้",
  LOGIN_TENANT_NOT_FOUND: "ไม่พบ OCR_WEB_TENANT_ID ในฐานข้อมูล"
});

/** A failure the operator is meant to read, as opposed to a bug: the code is the wire word, the text is the advice. */
class CliError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "CliError";
  }
}

type Flags = Readonly<{ username?: string | undefined; displayName?: string | undefined }>;
type Parsed = Readonly<{ command: Command; flags: Flags }>;

function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}

/** Unknown flags are rejected rather than ignored: a `--password` that is silently dropped is a trap, not a mistake. */
function parseArgs(argv: readonly string[]): Parsed {
  const [name, ...rest] = argv;
  if (name === undefined || !isCommand(name)) throw new CliError("USAGE");
  const allowed = FLAGS[name];
  const seen = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]!;
    const equals = argument.indexOf("=");
    const flag = equals === -1 ? argument : argument.slice(0, equals);
    if (!allowed.includes(flag) || seen.has(flag)) throw new CliError("USAGE");
    let value: string;
    if (equals === -1) {
      const next = rest[index + 1];
      if (next === undefined || next.startsWith("--")) throw new CliError("USAGE");
      value = next;
      index += 1;
    } else {
      value = argument.slice(equals + 1);
    }
    if (value.trim().length === 0) throw new CliError("USAGE");
    seen.set(flag, value);
  }
  return { command: name, flags: { username: seen.get("--username"), displayName: seen.get("--display-name") } };
}

function errorLine(code: string): string {
  const text = ERROR_TEXT[code];
  return text === undefined ? code : `${code} ${text}`;
}

/** The audit actor of every CLI action is NULL: no session created it, and the row says so (§6, `audit.ts`). */
const CLI_AUDIT: AuditContext = Object.freeze({ actorUserId: null });

async function askUsername(reader: TtyReader, given: string | undefined): Promise<string> {
  const value = given ?? await reader.readLine("ชื่อผู้ใช้ (ภาษาอังกฤษ): ");
  const username = normalizeUsername(value);
  if (username.length === 0) throw new CliError("INVALID_USERNAME");
  return username;
}

/**
 * The password, twice, with nothing echoed. The policy runs on the first answer, so a rejected password costs one
 * prompt instead of two, and both answers go through `normalizePassword` — the same NFKC the login form applies, so a
 * Thai password typed here still matches the one typed in the browser.
 */
async function askNewPassword(reader: TtyReader, username: string): Promise<string> {
  const password = normalizePassword(await reader.readSecret("รหัสผ่านใหม่: "));
  checkPasswordPolicy(password, username);
  const again = normalizePassword(await reader.readSecret("พิมพ์รหัสผ่านอีกครั้ง: "));
  if (password !== again) throw new CliError("PASSWORD_MISMATCH");
  return password;
}

async function findByUsername(store: CliUserStore, username: string): Promise<UserListItem> {
  const user = (await store.listUsers()).find((item) => item.username === username);
  if (!user) throw new CliError("USER_NOT_FOUND");
  return user;
}

export async function runUsersCli(argv: readonly string[], deps: UsersCliDeps): Promise<number> {
  const { tty, error } = deps;
  // D2: a password prompt that is not a terminal is a pipe, a CI job or a log file waiting to happen.
  if (!isInteractive(tty)) {
    error.write(`TTY_REQUIRED ต้องรันใน terminal แบบ interactive\n`);
    return 2;
  }
  let parsed: Parsed;
  try {
    parsed = parseArgs(argv);
  } catch {
    error.write(`USAGE ${USAGE}\n`);
    return 2;
  }
  const reader = new TtyReader(tty, deps.signals ?? null);
  const hash = deps.hash ?? ((password: string) => hashPassword(password));
  const { store, close } = await deps.openStore();
  try {
    await store.assertTenant();
    await run(parsed, { store, reader, hash, output: tty.output });
    return 0;
  } catch (caught) {
    if (caught instanceof TtyAborted) { error.write(`${errorLine("ABORTED")}\n`); return 1; }
    if (caught instanceof PasswordPolicyError) { error.write(`WEAK_PASSWORD ${POLICY_TEXT[caught.reason]}\n`); return 1; }
    if (caught instanceof CliError) { error.write(`${errorLine(caught.message)}\n`); return 1; }
    // Anything else is a bug or an unreachable database; the message is a code, never a value the operator typed.
    error.write(`${errorLine(caught instanceof Error ? caught.message.slice(0, 120) : "UNKNOWN_ERROR")}\n`);
    return 1;
  } finally {
    await close();
  }
}

type Run = Readonly<{ store: CliUserStore; reader: TtyReader; hash: (password: string) => Promise<string>; output: TtyOutput }>;

async function run(parsed: Parsed, ctx: Run): Promise<void> {
  switch (parsed.command) {
    case "create-admin": return createAdmin(parsed.flags, ctx);
    case "reset-password": return resetPassword(parsed.flags, ctx);
    case "unlock": return unlock(parsed.flags, ctx);
    case "list": return list(ctx);
  }
}

/**
 * The bootstrap admin owns a password they chose themselves, so `must_change_password` is false and there is no
 * 72-hour temporary window: there is no one else to hand it over to. `can_export` stays off because the **role**
 * carries the export right (D8, and `hasRight` in `../auth.ts`): the flag gates the export file for staff only, so the
 * first admin of a fresh tenant reaches the export without it — and may still turn it on for itself, since §5 C6's
 * self guards cover your own role and your own disabled state, not your own flags.
 */
async function createAdmin(flags: Flags, ctx: Run): Promise<void> {
  if (await ctx.store.countActiveAdmins() > 0) throw new CliError("ADMIN_EXISTS");
  const username = await askUsername(ctx.reader, flags.username);
  const displayName = flags.displayName ?? await ctx.reader.readLine("ชื่อที่แสดง: ");
  const password = await askNewPassword(ctx.reader, username);
  const passwordHash = await ctx.hash(password);
  const user = await ctx.store.createUser({
    username, displayName, role: "admin", canExport: false, passwordHash, temporary: false, audit: CLI_AUDIT
  });
  await ctx.store.recordAudit({ ...CLI_AUDIT, action: "user.bootstrap", targetType: "user", targetId: user.id });
  ctx.output.write(`สร้างผู้ดูแลระบบ ${user.username} แล้ว\n`);
}

/**
 * Break-glass: the only way back in when every administrator is locked out. The store clears the lock, revokes the
 * user's sessions (`admin_reset`) and marks the password as one to change at the next login, so a password that was
 * spoken out loud over the phone does not outlive the emergency.
 */
async function resetPassword(flags: Flags, ctx: Run): Promise<void> {
  const username = await askUsername(ctx.reader, flags.username);
  const user = await findByUsername(ctx.store, username);
  const password = await askNewPassword(ctx.reader, user.username);
  const passwordHash = await ctx.hash(password);
  await ctx.store.resetPassword(user.id, passwordHash, CLI_AUDIT, { via: "cli" });
  ctx.output.write(`ตั้งรหัสผ่านใหม่ให้ ${user.username} แล้ว และปิดเซสชันทั้งหมดของผู้ใช้นี้\n`);
  ctx.output.write(`ผู้ใช้ต้องตั้งรหัสผ่านใหม่อีกครั้งเมื่อเข้าสู่ระบบ (ภายใน 72 ชั่วโมง)\n`);
}

/** Clears the database lock only; the web process keeps its own 15-minute window per username (§5 C7). */
async function unlock(flags: Flags, ctx: Run): Promise<void> {
  const username = await askUsername(ctx.reader, flags.username);
  const user = await findByUsername(ctx.store, username);
  await ctx.store.unlockUser(user.id, CLI_AUDIT);
  ctx.output.write(`ปลดล็อก ${user.username} แล้ว\n`);
  ctx.output.write(`ถ้ายังเข้าสู่ระบบไม่ได้ ให้รอไม่เกิน ${LOGIN_LOCK_MINUTES} นาที แล้วลองใหม่\n`);
}

/** Identity, rights and state only: no hash, no session token and no audit detail. */
async function list(ctx: Run): Promise<void> {
  const users = await ctx.store.listUsers();
  ctx.output.write(`${"ชื่อผู้ใช้".padEnd(20)}${"บทบาท".padEnd(8)}${"สถานะ".padEnd(14)}ชื่อที่แสดง\n`);
  for (const user of users) {
    ctx.output.write(`${user.username.padEnd(20)}${user.role.padEnd(8)}${user.status.padEnd(14)}${user.displayName}\n`);
  }
  ctx.output.write(`ผู้ใช้ทั้งหมด ${users.length} คน\n`);
}

async function main(): Promise<void> {
  const code = await runUsersCli(process.argv.slice(2), {
    tty: { input: process.stdin, output: process.stdout },
    error: process.stderr,
    signals: { on: (event, listener) => process.on(event, listener), off: (event, listener) => process.off(event, listener) },
    openStore: async () => {
      const webConfig = loadWebConfig();
      const pool = createDatabasePool(process.env.DATABASE_URL);
      return { store: new PostgresUserStore(pool, webConfig.tenantId), close: () => pool.end() };
    }
  });
  process.stdin.pause();
  process.exitCode = code;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message.slice(0, 120) : "UNKNOWN_ERROR"}\n`);
    process.exitCode = 1;
  });
}
