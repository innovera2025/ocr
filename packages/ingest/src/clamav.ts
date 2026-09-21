export type ScanVerdict = "CLEAN" | "QUARANTINED";
export type ClamAvClient = Readonly<{ scan: (bytes: Uint8Array) => Promise<ScanVerdict> }>;

/** Adapter boundary. A transport error is quarantine, never clean. */
export function createClamAvClient(scanStream: (bytes: Uint8Array) => Promise<boolean>): ClamAvClient {
  return { async scan(bytes) { return (await scanStream(bytes)) ? "CLEAN" : "QUARANTINED"; } };
}

export type ClamAvTcpOptions = Readonly<{ host: string; port: number; timeoutMs?: number }>;

export function createClamAvTcpClient(options: ClamAvTcpOptions): ClamAvClient {
  return createClamAvClient((bytes) => new Promise<boolean>((resolveScan) => {
    const socket = connect({ host: options.host, port: options.port });
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (clean: boolean) => { if (settled) return; settled = true; socket.destroy(); resolveScan(clean); };
    socket.setTimeout(options.timeoutMs ?? 15_000, () => finish(false));
    socket.on("error", () => finish(false));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("close", () => {
      const result = Buffer.concat(chunks).toString("utf8");
      finish(/stream:\s*OK/i.test(result));
    });
    socket.on("connect", () => {
      socket.write(Buffer.from("zINSTREAM\0", "ascii"));
      const length = Buffer.allocUnsafe(4);
      length.writeUInt32BE(bytes.byteLength, 0);
      socket.write(length);
      socket.write(bytes);
      socket.write(Buffer.from([0, 0, 0, 0]));
      socket.end();
    });
  }));
}

export function clamAvHealthCheck(options: ClamAvTcpOptions): Promise<boolean> {
  return new Promise((resolveHealth) => {
    const socket = connect({ host: options.host, port: options.port });
    let settled = false;
    const finish = (ready: boolean) => { if (settled) return; settled = true; socket.destroy(); resolveHealth(ready); };
    socket.setTimeout(options.timeoutMs ?? 3_000, () => finish(false));
    socket.on("error", () => finish(false));
    socket.on("data", (chunk: Buffer) => finish(/PONG/i.test(chunk.toString("utf8"))));
    socket.on("connect", () => { socket.write(Buffer.from("PING\\0", "ascii")); });
  });
}

export function createClamAvStorageScanner(storage: LocalStorage, options: ClamAvTcpOptions): (key: string) => Promise<ScanVerdict> {
  const client = createClamAvTcpClient(options);
  return async (key) => {
    try { return await client.scan(await storage.get(key)); }
    catch { return "QUARANTINED"; }
  };
}
import { connect } from "node:net";
import type { LocalStorage } from "@innovera/ocr-storage/local";
