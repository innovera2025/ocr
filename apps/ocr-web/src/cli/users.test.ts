import test from "node:test";
import assert from "node:assert/strict";
import type { AuditContext, AuditDetail, AuditEvent, CreateUserInput, UserListItem } from "@innovera/ocr-persistence";
import { runUsersCli, type CliUserStore } from "./users.js";
import type { Tty, TtyOutput } from "./tty.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
// Obviously fake, and long enough to pass the 12-code-point policy.
const PASSWORD = "not-a-real-password";
const FAKE_HASH = `scrypt$v1$N=32768,r=8,p=3$${"a".repeat(22)}$${"b".repeat(43)}`;

type Chunk = string;
type FakeTty = Readonly<{
  tty: Tty; error: TtyOutput; writes: string[]; errors: string[]; rawModes: boolean[]; remaining: () => number;
}>;

/**
 * A terminal made of two arrays. Every byte the CLI writes is captured, which is how "the password is never echoed"
 * becomes an assertion rather than a promise.
 */
function fakeTty(script: readonly Chunk[], options: { inputTty?: boolean; outputTty?: boolean } = {}): FakeTty {
  const writes: string[] = [];
  const errors: string[] = [];
  const rawModes: boolean[] = [];
  const queue = [...script];
  let listener: ((chunk: Buffer | string) => void) | null = null;
  const deliver = (): void => {
    if (!listener) return;
    const next = queue.shift();
    if (next === undefined) return;
    listener(Buffer.from(next, "utf8"));
  };
  const input = {
    isTTY: options.inputTty ?? true,
    setRawMode: (mode: boolean) => { rawModes.push(mode); },
    resume: () => undefined,
    on: (_event: "data", value: (chunk: Buffer | string) => void) => { listener = value; setTimeout(deliver, 0); },
    off: (_event: "data", value: (chunk: Buffer | string) => void) => { if (listener === value) listener = null; }
  };
  const output: TtyOutput = { isTTY: options.outputTty ?? true, write: (text: string) => writes.push(text) };
  const error: TtyOutput = { write: (text: string) => errors.push(text) };
  return { tty: { input, output }, error, writes, errors, rawModes, remaining: () => queue.length };
}

class FakeStore implements CliUserStore {
  readonly tenantId = TENANT;
  readonly calls: string[] = [];
  readonly audits: Omit<AuditEvent, "tenantId">[] = [];
  readonly resets: { userId: string; hash: string; audit: AuditContext; detail: AuditDetail | undefined }[] = [];
  readonly unlocked: string[] = [];
  created: (CreateUserInput & { tenantId: string }) | null = null;
  admins = 0;
  users: UserListItem[] = [];

  async assertTenant(): Promise<void> { this.calls.push("assertTenant"); }
  async countActiveAdmins(): Promise<number> { this.calls.push("countActiveAdmins"); return this.admins; }
  async listUsers(): Promise<UserListItem[]> { this.calls.push("listUsers"); return this.users; }
  async createUser(input: CreateUserInput): Promise<UserListItem> {
    this.calls.push("createUser");
    this.created = { ...input, tenantId: this.tenantId };
    return listItem({ id: USER_ID, username: input.username, displayName: input.displayName, role: input.role });
  }
  async resetPassword(userId: string, newHash: string, audit: AuditContext, detail?: AuditDetail): Promise<void> {
    this.calls.push("resetPassword");
    this.resets.push({ userId, hash: newHash, audit, detail });
  }
  async unlockUser(userId: string, audit: AuditContext): Promise<void> {
    this.calls.push("unlockUser");
    this.unlocked.push(userId);
    this.audits.push({ ...audit, action: "user.unlocked" });
  }
  async recordAudit(event: Omit<AuditEvent, "tenantId">): Promise<void> {
    this.calls.push("recordAudit");
    this.audits.push(event);
  }
}

function listItem(input: { id: string; username: string; displayName: string; role: "admin" | "staff"; status?: UserListItem["status"] }): UserListItem {
  return {
    id: input.id, username: input.username, displayName: input.displayName, role: input.role, canExport: false,
    status: input.status ?? "active", lockedUntil: null, lastLoginAt: null, createdAt: "2026-09-23T00:00:00.000Z"
  };
}

type RunResult = Readonly<{ code: number; store: FakeStore; hashed: string[]; opened: number; closed: number } & FakeTty>;

async function runCli(argv: readonly string[], script: readonly Chunk[],
  setup: { store?: FakeStore; inputTty?: boolean; outputTty?: boolean } = {}): Promise<RunResult> {
  const store = setup.store ?? new FakeStore();
  const io = fakeTty(script, setup);
  const hashed: string[] = [];
  let opened = 0;
  let closed = 0;
  const code = await runUsersCli(argv, {
    tty: io.tty,
    error: io.error,
    hash: async (password: string) => { hashed.push(password); return FAKE_HASH; },
    openStore: async () => {
      opened += 1;
      return { store, close: async () => { closed += 1; } };
    }
  });
  return { code, store, hashed, opened, closed, ...io };
}

test("a non-interactive stdin or stdout is refused before the database is opened", async () => {
  for (const streams of [{ inputTty: false }, { outputTty: false }]) {
    const result = await runCli(["create-admin"], [], streams);
    assert.equal(result.code, 2);
    assert.equal(result.opened, 0);
    assert.equal(result.store.calls.length, 0);
    assert.match(result.errors.join(""), /^TTY_REQUIRED /);
    assert.equal(result.writes.length, 0);
  }
});

test("unknown commands and unknown flags are rejected without touching the database", async () => {
  for (const argv of [[], ["dump-hashes"], ["create-admin", "--password", PASSWORD], ["create-admin", `--password=${PASSWORD}`],
    ["list", "--username", "admin"], ["create-admin", "--username"], ["create-admin", "--username", "--display-name"],
    ["create-admin", "--username", "a", "--username", "b"]]) {
    const result = await runCli(argv, []);
    assert.equal(result.code, 2, argv.join(" "));
    assert.equal(result.opened, 0, argv.join(" "));
    assert.match(result.errors.join(""), /^USAGE /);
    assert.ok(!result.errors.join("").includes(PASSWORD));
  }
});

test("create-admin inserts one admin under the tenant and prints only the success line", async () => {
  const result = await runCli(["create-admin"], ["admin\n", "ผู้ดูแลระบบ\n", `${PASSWORD}\n`, `${PASSWORD}\n`]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.store.calls, ["assertTenant", "countActiveAdmins", "createUser", "recordAudit"]);
  const created = result.store.created;
  assert.ok(created);
  assert.equal(created.tenantId, TENANT);
  assert.equal(created.username, "admin");
  assert.equal(created.displayName, "ผู้ดูแลระบบ");
  assert.equal(created.role, "admin");
  assert.equal(created.temporary, false);
  // D8: the admin ROLE carries the export right (auth.test.ts pins the gate), so the flag stays off here.
  assert.equal(created.canExport, false);
  assert.equal(created.passwordHash, FAKE_HASH);
  assert.equal(created.audit.actorUserId, null);
  assert.deepEqual(result.hashed, [PASSWORD]);
  assert.deepEqual(result.store.audits, [{ actorUserId: null, action: "user.bootstrap", targetType: "user", targetId: USER_ID }]);
  assert.deepEqual(result.writes.filter((write) => !write.endsWith(": ") && write !== "\n"), ["สร้างผู้ดูแลระบบ admin แล้ว\n"]);
  assert.equal(result.errors.length, 0);
  assert.equal(result.closed, 1);
});

test("the password is never echoed, and raw mode is entered and restored for each secret prompt", async () => {
  const result = await runCli(["create-admin", "--username", "admin", "--display-name", "ผู้ดูแลระบบ"],
    [`${PASSWORD}\n`, `${PASSWORD}\n`]);
  assert.equal(result.code, 0);
  const printed = result.writes.join("") + result.errors.join("");
  assert.ok(!printed.includes(PASSWORD));
  assert.ok(!printed.includes(FAKE_HASH));
  assert.deepEqual(result.rawModes, [true, false, true, false]);
});

test("backspace edits the password, and the confirmation must match the edited value", async () => {
  const result = await runCli(["create-admin", "--username", "admin", "--display-name", "ก"],
    [`${PASSWORD}x\u007f\n`, `${PASSWORD}\n`]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.hashed, [PASSWORD]);
});

test("a mismatched confirmation creates nothing", async () => {
  const result = await runCli(["create-admin", "--username", "admin", "--display-name", "ก"],
    [`${PASSWORD}\n`, `${PASSWORD}-typo\n`]);
  assert.equal(result.code, 1);
  assert.equal(result.store.created, null);
  assert.equal(result.hashed.length, 0);
  assert.match(result.errors.join(""), /^PASSWORD_MISMATCH /);
  assert.ok(!result.errors.join("").includes(PASSWORD));
  assert.equal(result.closed, 1);
});

test("a password that fails the policy is refused after one prompt", async () => {
  const result = await runCli(["create-admin", "--username", "admin", "--display-name", "ก"], ["sh0rt\n", `${PASSWORD}\n`]);
  assert.equal(result.code, 1);
  assert.equal(result.store.created, null);
  assert.equal(result.hashed.length, 0);
  assert.match(result.errors.join(""), /^WEAK_PASSWORD /);
  // The second prompt never ran: one answer is still queued.
  assert.equal(result.remaining(), 1);
});

test("a password containing the username is refused", async () => {
  const result = await runCli(["create-admin", "--username", "admin", "--display-name", "ก"], ["the-admin-password\n"]);
  assert.equal(result.code, 1);
  assert.match(result.errors.join(""), /^WEAK_PASSWORD /);
  assert.equal(result.store.created, null);
});

test("create-admin refuses while an active admin exists, before any prompt", async () => {
  const store = new FakeStore();
  store.admins = 1;
  const result = await runCli(["create-admin"], ["admin\n"], { store });
  assert.equal(result.code, 1);
  assert.match(result.errors.join(""), /^ADMIN_EXISTS /);
  assert.deepEqual(store.calls, ["assertTenant", "countActiveAdmins"]);
  assert.equal(result.remaining(), 1);
  assert.equal(result.writes.length, 0);
});

test("Ctrl-C at the password prompt aborts, restores the terminal and writes nothing", async () => {
  const result = await runCli(["create-admin", "--username", "admin", "--display-name", "ก"], ["\u0003"]);
  assert.equal(result.code, 1);
  assert.match(result.errors.join(""), /^ABORTED /);
  assert.deepEqual(result.rawModes, [true, false]);
  assert.equal(result.store.created, null);
  assert.equal(result.closed, 1);
});

test("reset-password sets the typed password on the named user and audits the CLI as the source", async () => {
  const store = new FakeStore();
  store.users = [listItem({ id: USER_ID, username: "admin", displayName: "ผู้ดูแลระบบ", role: "admin", status: "locked" })];
  const result = await runCli(["reset-password", "--username", "ADMIN"], [`${PASSWORD}\n`, `${PASSWORD}\n`], { store });
  assert.equal(result.code, 0);
  assert.deepEqual(store.calls, ["assertTenant", "listUsers", "resetPassword"]);
  assert.deepEqual(store.resets, [{ userId: USER_ID, hash: FAKE_HASH, audit: { actorUserId: null }, detail: { via: "cli" } }]);
  assert.ok(!result.writes.join("").includes(PASSWORD));
});

test("reset-password and unlock refuse an unknown username", async () => {
  for (const command of ["reset-password", "unlock"]) {
    const result = await runCli([command, "--username", "ghost"], []);
    assert.equal(result.code, 1);
    assert.match(result.errors.join(""), /^USER_NOT_FOUND /);
    assert.deepEqual(result.store.calls, ["assertTenant", "listUsers"]);
  }
});

test("unlock clears the database lock of the named user", async () => {
  const store = new FakeStore();
  store.users = [listItem({ id: USER_ID, username: "somchai", displayName: "สมชาย", role: "staff", status: "locked" })];
  const result = await runCli(["unlock", "--username", "somchai"], [], { store });
  assert.equal(result.code, 0);
  assert.deepEqual(store.unlocked, [USER_ID]);
  assert.deepEqual(store.audits, [{ actorUserId: null, action: "user.unlocked" }]);
});

test("list prints identity, role and status only", async () => {
  const store = new FakeStore();
  store.users = [
    listItem({ id: USER_ID, username: "admin", displayName: "ผู้ดูแลระบบ", role: "admin" }),
    listItem({ id: "33333333-3333-4333-8333-333333333333", username: "somchai", displayName: "สมชาย", role: "staff", status: "locked" })
  ];
  const result = await runCli(["list"], [], { store });
  assert.equal(result.code, 0);
  const printed = result.writes.join("");
  assert.ok(printed.includes("admin"));
  assert.ok(printed.includes("somchai"));
  assert.ok(printed.includes("locked"));
  assert.ok(!printed.includes("scrypt$"));
  assert.ok(!printed.includes(USER_ID));
});

test("a store failure is reported as a code, and the pool is closed either way", async () => {
  const store = new FakeStore();
  store.createUser = async () => { throw new Error("USERNAME_TAKEN"); };
  const result = await runCli(["create-admin", "--username", "admin", "--display-name", "ก"],
    [`${PASSWORD}\n`, `${PASSWORD}\n`], { store });
  assert.equal(result.code, 1);
  assert.match(result.errors.join(""), /^USERNAME_TAKEN /);
  assert.ok(!result.errors.join("").includes(PASSWORD));
  assert.equal(result.closed, 1);
});
