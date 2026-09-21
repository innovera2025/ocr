import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalStorage } from "./local.js";

test("local storage round trips bytes and rejects traversal", async () => {
  const storage = createLocalStorage(await mkdtemp(join(tmpdir(), "ocr-storage-")));
  await storage.put("org/a/original/ab/doc", new Uint8Array([1, 2, 3]));
  assert.deepEqual([...await storage.get("org/a/original/ab/doc")], [1, 2, 3]);
  await assert.rejects(() => storage.put("../escape", new Uint8Array()), /INVALID_STORAGE_KEY/);
});

test("local storage removes objects; removing a missing object is not an error", async () => {
  const storage = createLocalStorage(await mkdtemp(join(tmpdir(), "ocr-storage-")));
  await storage.put("org/a/original/ab/doc", new Uint8Array([1]));
  await storage.remove("org/a/original/ab/doc");
  await assert.rejects(() => storage.get("org/a/original/ab/doc"), { code: "ENOENT" });
  await storage.remove("org/a/original/ab/doc");
  await assert.rejects(() => storage.remove("../escape"), /INVALID_STORAGE_KEY/);
});
