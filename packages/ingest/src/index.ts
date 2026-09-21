import { limits } from "@innovera/ocr-config";

export const supportedMimeTypes = Object.freeze([
  "application/pdf", "image/jpeg", "image/png", "image/webp",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
] as const);
export type SupportedMimeType = typeof supportedMimeTypes[number];

export type IngestState = "STAGED" | "SCANNING" | "CLEAN" | "QUARANTINED";
const transitions: Readonly<Record<IngestState, readonly IngestState[]>> = {
  STAGED: ["SCANNING"], SCANNING: ["CLEAN", "QUARANTINED"], CLEAN: [], QUARANTINED: []
};

export function normalizeFilename(filename: string): string {
  const normalized = filename.normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "");
  const value = normalized || "untitled";
  if ([...value].length > 120) throw new Error("FILENAME_TOO_LONG");
  if (Buffer.byteLength(value, "utf8") > 1080) throw new Error("FILENAME_TOO_LARGE");
  return value;
}

export function validateUpload(input: { byteLength: number; filename: string; mimeType: string }): {
  filename: string; mimeType: SupportedMimeType;
} {
  if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 0 || input.byteLength > limits.maxUploadBytes) {
    throw new Error("PAYLOAD_TOO_LARGE");
  }
  if (!(supportedMimeTypes as readonly string[]).includes(input.mimeType)) throw new Error("UNSUPPORTED_MEDIA_TYPE");
  return { filename: normalizeFilename(input.filename), mimeType: input.mimeType as SupportedMimeType };
}

export function transitionIngestState(from: IngestState, to: IngestState): IngestState {
  if (!transitions[from].includes(to)) throw new Error("INVALID_INGEST_TRANSITION");
  return to;
}

export type IngestDependencies = Readonly<{
  stage: (input: { filename: string; bytes: Uint8Array; mimeType: SupportedMimeType }) => Promise<string>;
  scan: (stagedKey: string) => Promise<"CLEAN" | "QUARANTINED">;
  enqueue: (stagedKey: string) => Promise<string>;
  /** `status`/`storageKey`/`stale` (no activity for minutes) let a replay resume an upload whose request died before enqueueing. */
  lookupUpload?: (input: { filename: string; mimeType: SupportedMimeType; bytes: Uint8Array }) => Promise<{ tenantId: string; documentId: string; runId: string; jobId?: string; status?: string; storageKey?: string; stale?: boolean } | null>;
  persistUpload?: (input: { filename: string; mimeType: SupportedMimeType; bytes: Uint8Array; stagedKey: string }) => Promise<{ tenantId: string; documentId: string; runId: string; reused?: boolean }>;
  updateStatus?: (input: { tenantId: string; documentId: string; status: "CLEAN" | "QUARANTINED" | "FAILED"; errorMessage?: string }) => Promise<void>;
  enqueuePersistent?: (input: { tenantId: string; documentId: string; runId: string; stagedKey: string }) => Promise<string>;
  /** Deletes a staged original that no document references (persistUpload refused it or reused another upload). */
  discard?: (stagedKey: string) => Promise<void>;
}>;

type Persisted = { tenantId: string; documentId: string; runId: string };
export type IngestResult = Readonly<{ status: "CLEAN" | "QUARANTINED"; stagedKey: string; jobId?: string; tenantId?: string; documentId?: string; runId?: string; reused?: boolean }>;

/** Scan → status → enqueue for a persisted upload (fresh, or resumed after its request died). */
async function scanAndEnqueue(persisted: Persisted, stagedKey: string, deps: IngestDependencies, scanned?: "CLEAN"): Promise<IngestResult> {
  let verdict: "CLEAN" | "QUARANTINED";
  try {
    verdict = scanned ?? await deps.scan(stagedKey);
  } catch (error) {
    if (deps.updateStatus) await deps.updateStatus({ tenantId: persisted.tenantId, documentId: persisted.documentId, status: "FAILED", errorMessage: error instanceof Error ? error.message : "SCAN_FAILED" });
    throw error;
  }
  if (verdict === "QUARANTINED") {
    if (deps.updateStatus) await deps.updateStatus({ tenantId: persisted.tenantId, documentId: persisted.documentId, status: "QUARANTINED" });
    return { status: "QUARANTINED" as const, stagedKey, ...persisted };
  }
  if (deps.updateStatus && !scanned) await deps.updateStatus({ tenantId: persisted.tenantId, documentId: persisted.documentId, status: "CLEAN" });
  const jobId = deps.enqueuePersistent
    ? await deps.enqueuePersistent({ tenantId: persisted.tenantId, documentId: persisted.documentId, runId: persisted.runId, stagedKey })
    : await deps.enqueue(stagedKey);
  return { status: "CLEAN" as const, stagedKey, jobId, ...persisted };
}

export async function ingestDocument(input: { filename: string; bytes: Uint8Array; mimeType: string }, deps: IngestDependencies): Promise<IngestResult> {
  const valid = validateUpload({ byteLength: input.bytes.byteLength, filename: input.filename, mimeType: input.mimeType });
  const existing = deps.lookupUpload ? await deps.lookupUpload({ filename: valid.filename, mimeType: valid.mimeType, bytes: input.bytes }) : null;
  if (existing) {
    const { status, storageKey, stale, ...ids } = existing;
    // The first request persisted the document and then died (restart, crash) before it was queued. Its replay resumes
    // the pipeline; while that request may still be alive (scan in progress) the replay is refused, never duplicated.
    if (!ids.jobId && (status === "SCANNING" || status === "CLEAN") && storageKey) {
      if (!stale) throw new Error("UPLOAD_IN_PROGRESS");
      const { jobId: _none, ...persisted } = ids;
      const resumed = await scanAndEnqueue(persisted, storageKey, deps, status === "CLEAN" ? "CLEAN" : undefined);
      return { ...resumed, stagedKey: "" };
    }
    return { status: status === "QUARANTINED" ? "QUARANTINED" as const : "CLEAN" as const, stagedKey: "", jobId: ids.jobId ?? "", ...ids };
  }
  const stagedKey = await deps.stage({ filename: valid.filename, bytes: input.bytes, mimeType: valid.mimeType });
  let persisted: Awaited<ReturnType<NonNullable<IngestDependencies["persistUpload"]>>> | undefined;
  try {
    persisted = deps.persistUpload ? await deps.persistUpload({ ...input, filename: valid.filename, mimeType: valid.mimeType, stagedKey }) : undefined;
  } catch (error) {
    // BATCH_FULL, BATCH_NOT_FOUND, IDEMPOTENCY_CONFLICT…: no document references the staged bytes.
    await deps.discard?.(stagedKey).catch(() => undefined);
    throw error;
  }
  // A concurrent request may win the idempotency race while this request was staging.
  // Reuse the winner and stop before scanning/enqueuing a second job.
  if (persisted?.reused) {
    await deps.discard?.(stagedKey).catch(() => undefined);
    return { status: "CLEAN" as const, stagedKey: "", jobId: "", ...persisted };
  }
  if (persisted) return scanAndEnqueue(persisted, stagedKey, deps);
  const verdict = await deps.scan(stagedKey);
  if (verdict === "QUARANTINED") return { status: "QUARANTINED" as const, stagedKey };
  return { status: "CLEAN" as const, stagedKey, jobId: await deps.enqueue(stagedKey) };
}
