import { loadConfig, type AppConfig } from "@innovera/ocr-config";

export type OcrField = Readonly<{
  raw?: string;
  value?: string;
  confidence?: number;
  source?: string;
  needsReview?: boolean;
  [key: string]: unknown;
}>;

export type OcrTreatment = Readonly<OcrField & { name?: string; duration?: string }>;

/** Schema v3 (engine `typhoon-sections` 3.0 / 3.1) shapes. Responses are NOT validated against them — read defensively. */
export type Source = "ocr" | "checkbox" | "ink-mark" | "rule" | "master-fuzzy" | "visual-alias" | "verified-memory" | "none" | "human";
export type Field = Readonly<{ raw: string | null; value: string | null; confidence: number; source: Source; needsReview: boolean }>;
export type CheckField = Readonly<Field & { checked: true }>;
/** `guests` (v3.1): a leading guest count ("4 ไทย 1 ชม." → 4), never a duration. */
export type TreatmentField = Readonly<Field & { nameRaw: string | null; duration: string | null; durationMinutes: number | null; guests?: number | null }>;
/** v3.1 form header: the printed form number and the handwritten date and time. */
export type HeaderSection = Readonly<{ formNumber?: Field; date?: Field; time?: Field }>;
export type OcrSectionTiming = Readonly<{ name: string; ms: number }>;
export type OcrTimings = Readonly<{
  preprocessMs?: number; checkboxMs?: number; inferenceMs?: number; inferenceWallMs?: number;
  normalizeMs?: number; totalMs?: number; sections?: readonly OcrSectionTiming[];
}>;

export type OcrResponse = Readonly<{
  documentId: string;
  sourceFile?: string;
  engine?: string;
  version?: string;
  schemaVersion?: number;
  layout?: Readonly<Record<string, unknown>>;
  /** v3.1 `HeaderSection`; absent before 3.1. */
  header?: Readonly<Record<string, unknown>>;
  /** v3.1 adds `branch: Field` and `totalMinutes: number|null`. */
  staffOnly?: Readonly<Record<string, unknown>>;
  customerInformation?: Readonly<Record<string, unknown>>;
  recommendationCard?: Readonly<Record<string, unknown>>;
  evidence?: Readonly<Record<string, unknown>>;
  /** Unvalidated `OcrTimings`; use `readOcrTimings`. */
  timings?: unknown;
  needsReview?: boolean;
  [key: string]: unknown;
}>;

/** Numeric timings of a v3 response; missing or malformed entries are dropped (never throws). */
export function readOcrTimings(response: Readonly<{ timings?: unknown }>): OcrTimings {
  const timings = isRecord(response.timings) ? response.timings : {};
  const timing: Record<string, number> = {};
  for (const key of ["preprocessMs", "checkboxMs", "inferenceMs", "inferenceWallMs", "normalizeMs", "totalMs"] as const) {
    const value = timings[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) timing[key] = value;
  }
  const sections = Array.isArray(timings.sections) ? timings.sections.filter((entry): entry is OcrSectionTiming => isRecord(entry) && typeof entry.name === "string" && typeof entry.ms === "number" && Number.isFinite(entry.ms) && entry.ms >= 0) : [];
  return sections.length > 0 ? { ...timing, sections } : timing;
}

/**
 * v3.1 `layout.detection`: the template verdict of the fitted registration (release1-plan A1/A3). `known` pages are read as
 * the form; `uncertain` pages are read with every field flagged; `unknown` pages come back with empty sections.
 */
export type TemplateVerdict = "known" | "uncertain" | "unknown";
export type LayoutDetection = Readonly<{ verdict: TemplateVerdict; score: number; foundRatio: number; rmsPx: number; scaleX: number; scaleY: number;
  rotationDeg: number; dx: number; dy: number }>;
const DETECTION_NUMBERS = ["score", "foundRatio", "rmsPx", "scaleX", "scaleY", "rotationDeg", "dx", "dy"] as const;

/** `layout.detection` of a v3.1 response; null before 3.1 or when malformed (never throws). */
export function readLayoutDetection(response: Readonly<{ layout?: unknown }>): LayoutDetection | null {
  const detection = isRecord(response.layout) && isRecord(response.layout.detection) ? response.layout.detection : null;
  if (!detection || !["known", "uncertain", "unknown"].includes(detection.verdict as string)) return null;
  if (!DETECTION_NUMBERS.every((key) => typeof detection[key] === "number" && Number.isFinite(detection[key]))) return null;
  return Object.freeze(Object.fromEntries([["verdict", detection.verdict], ...DETECTION_NUMBERS.map((key) => [key, detection[key]])])) as LayoutDetection;
}

export type ConfirmPayload = Readonly<{
  documentId: string;
  field: string;
  raw: string;
  verifiedValue: string;
}>;

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type OcrClientOptions = Readonly<{
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  fetchImpl?: FetchLike;
}>;

export class OcrClientError extends Error {
  readonly code: "timeout" | "network" | "http" | "malformed";
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(code: OcrClientError["code"], message: string, options: { status?: number | undefined; retryable?: boolean } = {}) {
    super(message);
    this.name = "OcrClientError";
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseOcrResponse(value: unknown): OcrResponse {
  if (!isRecord(value) || typeof value.documentId !== "string" || value.documentId.length === 0) {
    throw new OcrClientError("malformed", "OCR response does not contain a documentId");
  }
  return value as OcrResponse;
}

export class OcrClient {
  private readonly options: OcrClientOptions;
  private readonly fetchImpl: FetchLike;

  constructor(options: OcrClientOptions) {
    if (!options.baseUrl || !Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new Error("Invalid OCR client configuration");
    }
    this.options = Object.freeze({ ...options, baseUrl: options.baseUrl.replace(/\/$/, "") });
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  static fromConfig(config: AppConfig = loadConfig()): OcrClient {
    return new OcrClient({
      baseUrl: config.ocr.apiBaseUrl,
      timeoutMs: config.ocr.requestTimeoutSeconds * 1000,
      maxRetries: config.ocr.maxRetries
    });
  }

  async processDocument(file: Uint8Array, filename = "upload", mimeType = "application/octet-stream"): Promise<OcrResponse> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(file).buffer as ArrayBuffer], { type: mimeType }), filename);
    return this.requestJson("/v1/ocr", { method: "POST", body: form }).then(parseOcrResponse);
  }

  async confirmResult(payload: ConfirmPayload): Promise<Readonly<Record<string, unknown>>> {
    if (!payload.documentId || !payload.field) throw new Error("documentId and field are required");
    return this.requestJson("/v1/ocr/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
  }

  /**
   * `GET /health` (FastAPI answers `HEAD /v1/ocr` with 405, so the old probe never succeeded). True when the service can
   * read documents: status "ok", or "degraded" while it serves the last good master data (`masterData: "stale: …"`).
   * Master data that never loaded (`"error: …"`, every OCR request fails) is not up.
   * A 404 means the gateway in front of the Local AI does not route `/health`; that says nothing about OCR, so it counts
   * as up and the worker's single half-open trial job decides instead of the gate staying closed forever.
   */
  async healthCheck(): Promise<boolean> {
    try {
      const body = await this.requestJson("/health", { method: "GET" });
      return body.status === "ok" || (body.status === "degraded" && typeof body.masterData === "string" && body.masterData.startsWith("stale:"));
    } catch (error) {
      return error instanceof OcrClientError && error.code === "http" && error.status === 404;
    }
  }

  private async requestJson(path: string, init: RequestInit): Promise<Readonly<Record<string, unknown>>> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
      try {
        const response = await this.fetchImpl(`${this.options.baseUrl}${path}`, { ...init, signal: controller.signal });
        if (!response.ok) {
          const retryable = response.status >= 500 || response.status === 429 || response.status === 408;
          const error = new OcrClientError("http", `OCR API returned HTTP ${response.status}`, { status: response.status, retryable });
          if (!retryable || attempt === this.options.maxRetries) throw error;
          lastError = error;
          continue;
        }
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          throw new OcrClientError("malformed", "OCR API returned invalid JSON");
        }
        if (!isRecord(body)) throw new OcrClientError("malformed", "OCR API returned a non-object response");
        return body;
      } catch (error) {
        const normalized = error instanceof OcrClientError
          ? error
          : (error instanceof DOMException && error.name === "AbortError")
            ? new OcrClientError("timeout", "OCR API request timed out", { retryable: true })
            : new OcrClientError("network", "OCR API request failed", { retryable: true });
        if (!normalized.retryable || attempt === this.options.maxRetries) throw normalized;
        lastError = normalized;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof Error ? lastError : new OcrClientError("network", "OCR API request failed");
  }
}
