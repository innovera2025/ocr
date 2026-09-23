import { StringDecoder } from "node:string_decoder";

/**
 * The terminal seam of the users CLI (§7 E1). The types are structural and minimal, so a test can hand the CLI two
 * plain fakes and read back **every** byte it wrote: that is how "the password is never echoed" is proved.
 */
export type TtyInput = Readonly<{
  isTTY?: boolean | undefined;
  setRawMode?: ((mode: boolean) => unknown) | undefined;
  resume?: (() => unknown) | undefined;
  pause?: (() => unknown) | undefined;
  on: (event: "data", listener: (chunk: Buffer | string) => void) => unknown;
  off: (event: "data", listener: (chunk: Buffer | string) => void) => unknown;
}>;
export type TtyOutput = Readonly<{ isTTY?: boolean | undefined; write: (text: string) => unknown }>;
export type Tty = Readonly<{ input: TtyInput; output: TtyOutput }>;
/** Whatever delivers SIGINT while a prompt is open; `process` in production, a fake in the tests. */
export type SignalTarget = Readonly<{
  on: (event: "SIGINT", listener: () => void) => unknown;
  off: (event: "SIGINT", listener: () => void) => unknown;
}>;

/** Ctrl-C, or Ctrl-D on an empty prompt: the operator changed their mind, and nothing has been typed that may leak. */
export class TtyAborted extends Error {
  constructor() {
    super("ABORTED");
    this.name = "TtyAborted";
  }
}

const ETX = "\u0003";
const EOT = "\u0004";
const DEL = "\u007f";
const BS = "\u0008";
/** A prompt answer is a username or a password; anything longer is a paste accident or a pipe, and is dropped. */
const MAX_INPUT = 1024;

export function isInteractive(tty: Tty): boolean {
  return tty.input.isTTY === true && tty.output.isTTY === true;
}

/**
 * Reads one answer at a time from a terminal. A secret is read in raw mode, so nothing is echoed and nothing reaches
 * the scrollback: the process handles backspace itself, and the raw mode is restored in every exit path — the normal
 * one, an abort, an error and a SIGINT that arrives while the prompt is open.
 */
export class TtyReader {
  private pending = "";

  constructor(private readonly tty: Tty, private readonly signals: SignalTarget | null = null) {}

  /** Echoed by the terminal itself: usernames and display names are not secret. */
  readLine(prompt: string): Promise<string> {
    return this.read(prompt, false);
  }

  readSecret(prompt: string): Promise<string> {
    return this.read(prompt, true);
  }

  private read(prompt: string, secret: boolean): Promise<string> {
    const { input, output } = this.tty;
    const raw = secret && typeof input.setRawMode === "function";
    output.write(prompt);
    if (raw) input.setRawMode?.(true);
    input.resume?.();
    return new Promise<string>((resolve, reject) => {
      const decoder = new StringDecoder("utf8");
      let value = "";
      let rest = this.pending;
      this.pending = "";
      let settled = false;
      const settle = (error: Error | null, result: string): void => {
        if (settled) return;
        settled = true;
        input.off("data", onData);
        this.signals?.off("SIGINT", onSigint);
        // The terminal is restored even when it has gone away under us; there is nothing left to hand back then.
        if (raw) { try { input.setRawMode?.(false); } catch { /* ignore */ } }
        if (secret) output.write("\n");
        if (error) reject(error);
        else resolve(result);
      };
      const onSigint = (): void => { settle(new TtyAborted(), ""); };
      const step = (): void => {
        while (rest.length > 0 && !settled) {
          const char = rest[0]!;
          rest = rest.slice(1);
          if (char === ETX) return settle(new TtyAborted(), "");
          if (char === "\n" || char === "\r") {
            if (char === "\r" && rest.startsWith("\n")) rest = rest.slice(1);
            this.pending = rest;
            return settle(null, value);
          }
          if (secret) {
            if (char === EOT) {
              if (value.length === 0) return settle(new TtyAborted(), "");
              continue;
            }
            if (char === DEL || char === BS) { value = value.slice(0, -1); continue; }
            // Control characters, including the ESC that opens an arrow-key sequence, are not part of a password.
            if (char.charCodeAt(0) < 0x20) continue;
          }
          if (value.length < MAX_INPUT) value += char;
        }
      };
      const onData = (chunk: Buffer | string): void => {
        rest += typeof chunk === "string" ? chunk : decoder.write(chunk);
        step();
      };
      input.on("data", onData);
      this.signals?.on("SIGINT", onSigint);
      step();
    });
  }
}
