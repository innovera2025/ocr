import type { IncomingMessage } from "node:http";
import { validateUpload, type IngestDependencies, ingestDocument } from "./index.js";
export type { IngestDependencies } from "./index.js";

/**
 * Header values are Latin-1 on the wire, so browsers send non-ASCII (e.g. Thai) names as
 * `encodeURIComponent(name)` with `X-Upload-Filename-Encoding: uri`. Absent encoding keeps the raw value.
 */
export function decodeUploadFilename(value: string, encoding: string | undefined): string {
  const scheme = encoding?.trim().toLowerCase() ?? "";
  if (scheme === "") return value;
  if (scheme !== "uri") throw new Error("INVALID_UPLOAD_HEADERS");
  try { return decodeURIComponent(value); } catch { throw new Error("INVALID_UPLOAD_HEADERS"); }
}

export async function readRawUpload(request: IncomingMessage, maxBytes: number): Promise<{ filename: string; mimeType: string; bytes: Uint8Array }> {
  const mimeType = request.headers["content-type"]?.split(";", 1)[0]?.trim() ?? "";
  const filenameHeader = request.headers["x-upload-filename"];
  const encodingHeader = request.headers["x-upload-filename-encoding"];
  const filename = decodeUploadFilename(Array.isArray(filenameHeader) ? filenameHeader[0] ?? "" : filenameHeader ?? "", Array.isArray(encodingHeader) ? encodingHeader[0] : encodingHeader);
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (!filename || !mimeType || !Number.isSafeInteger(declaredLength) || declaredLength < 1 || declaredLength > maxBytes) throw new Error("INVALID_UPLOAD_HEADERS");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.length;
    if (total > maxBytes) throw new Error("PAYLOAD_TOO_LARGE");
    chunks.push(value);
  }
  if (total !== declaredLength) throw new Error("UPLOAD_LENGTH_MISMATCH");
  const valid = validateUpload({ byteLength: total, filename, mimeType });
  return { filename: valid.filename, mimeType: valid.mimeType, bytes: new Uint8Array(Buffer.concat(chunks)) };
}

export async function handleRawUpload(request: IncomingMessage, deps: IngestDependencies, maxBytes: number) {
  const upload = await readRawUpload(request, maxBytes);
  return ingestDocument(upload, deps);
}
