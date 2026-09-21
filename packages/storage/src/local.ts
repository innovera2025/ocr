import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type LocalStorage = Readonly<{
  put: (key: string, bytes: Uint8Array) => Promise<void>;
  get: (key: string) => Promise<Uint8Array>;
}>;

function safePath(root: string, key: string): string {
  if (key.includes("\\") || key.split("/").some((part) => part === ".." || part === "." || part === "")) throw new Error("INVALID_STORAGE_KEY");
  const result = resolve(root, key);
  if (!result.startsWith(`${resolve(root)}/`)) throw new Error("INVALID_STORAGE_KEY");
  return result;
}

/** Deletes an object; a missing object is not an error. */
export type RemovableStorage = Readonly<{ remove: (key: string) => Promise<void> }>;

export function createLocalStorage(root: string): LocalStorage & RemovableStorage {
  return {
    async put(key, bytes) { const path = safePath(root, key); await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); },
    async get(key) { return new Uint8Array(await readFile(safePath(root, key))); },
    async remove(key) { await rm(safePath(root, key), { force: true }); }
  };
}
