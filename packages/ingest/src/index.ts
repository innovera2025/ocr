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
  lookupUpload?: (input: { filename: string; mimeType: SupportedMimeType; bytes: Uint8Array }) => Promise<{ tenantId: string; documentId: string; runId: string; jobId?: string } | null>;
  persistUpload?: (input: { filename: string; mimeType: SupportedMimeType; bytes: Uint8Array; stagedKey: string }) => Promise<{ tenantId: string; documentId: string; runId: string; reused?: boolean }>;
  updateStatus?: (input: { tenantId: string; documentId: string; status: "CLEAN" | "QUARANTINED" | "FAILED"; errorMessage?: string }) => Promise<void>;
  enqueuePersistent?: (input: { tenantId: string; documentId: string; runId: string; stagedKey: string }) => Promise<string>;
}>;

export async function ingestDocument(input: { filename: string; bytes: Uint8Array; mimeType: string }, deps: IngestDependencies) {
  const valid = validateUpload({ byteLength: input.bytes.byteLength, filename: input.filename, mimeType: input.mimeType });
  const existing = deps.lookupUpload ? await deps.lookupUpload({ filename: valid.filename, mimeType: valid.mimeType, bytes: input.bytes }) : null;
  if (existing) return { status: "CLEAN" as const, stagedKey: "", jobId: existing.jobId ?? "", ...existing };
  const stagedKey = await deps.stage({ filename: valid.filename, bytes: input.bytes, mimeType: valid.mimeType });
  const persisted = deps.persistUpload ? await deps.persistUpload({ ...input, filename: valid.filename, mimeType: valid.mimeType, stagedKey }) : undefined;
  // A concurrent request may win the idempotency race while this request was staging.
  // Reuse the winner and stop before scanning/enqueuing a second job.
  if (persisted?.reused) return { status: "CLEAN" as const, stagedKey: "", jobId: "", ...persisted };
  let verdict: "CLEAN" | "QUARANTINED";
  try {
    verdict = await deps.scan(stagedKey);
  } catch (error) {
    if (persisted && deps.updateStatus) await deps.updateStatus({ tenantId: persisted.tenantId, documentId: persisted.documentId, status: "FAILED", errorMessage: error instanceof Error ? error.message : "SCAN_FAILED" });
    throw error;
  }
  if (verdict === "QUARANTINED") {
    if (persisted && deps.updateStatus) await deps.updateStatus({ tenantId: persisted.tenantId, documentId: persisted.documentId, status: "QUARANTINED" });
    return persisted
      ? { status: "QUARANTINED" as const, stagedKey, ...persisted }
      : { status: "QUARANTINED" as const, stagedKey };
  }
  if (persisted && deps.updateStatus) await deps.updateStatus({ tenantId: persisted.tenantId, documentId: persisted.documentId, status: "CLEAN" });
  const jobId = persisted && deps.enqueuePersistent
    ? await deps.enqueuePersistent({ tenantId: persisted.tenantId, documentId: persisted.documentId, runId: persisted.runId, stagedKey })
    : await deps.enqueue(stagedKey);
  return persisted
    ? { status: "CLEAN" as const, stagedKey, jobId, ...persisted }
    : { status: "CLEAN" as const, stagedKey, jobId };
}
