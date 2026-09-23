import { z } from "zod";

const envSchema = z.object({
  OCR_ENV: z.enum(["development", "test", "production"]).default("development"),
  OCR_PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  OCR_TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
  OCR_API_BASE_URL: z.string().url().default("https://ai.innoveraappcenter.com/ocr"),
  OCR_REQUEST_TIMEOUT: z.coerce.number().int().min(1).max(900).default(300),
  OCR_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3)
  ,AUTH_JWT_SECRET: z.string().default("")
  ,AUTH_JWT_SECRETS: z.string().default("")
  ,AUTH_JWT_ISSUER: z.string().default("")
  ,AUTH_JWT_AUDIENCE: z.string().default("")
});

export const limits = Object.freeze({
  maxUploadBytes: 209_715_200,
  maxPagesPerDocument: 500,
  /** Default page limit of one PDF (`OCR_MAX_PDF_PAGES`, 1..1000 — the 0018 CHECK allows 1000). */
  maxOcrPagesPerDocument: 300,
  jobProcessingBudgetMs: 1_800_000,
  pageOcrTimeoutSeconds: 45
});

export type AppConfig = Readonly<{
  env: "development" | "test" | "production";
  port: number;
  trustedProxyHops: number;
  ocr: Readonly<{
    apiBaseUrl: string;
    requestTimeoutSeconds: number;
    maxRetries: number;
  }>;
  auth: Readonly<{ jwtSecrets: readonly string[]; issuer: string; audience: string }>;
  limits: typeof limits;
}>;

export function loadConfig(input: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(input);
  const jwtSecrets = (parsed.AUTH_JWT_SECRETS || parsed.AUTH_JWT_SECRET).split(",").map((value) => value.trim()).filter(Boolean);
  if (parsed.OCR_ENV === "production" && (jwtSecrets.length === 0 || !parsed.AUTH_JWT_ISSUER || !parsed.AUTH_JWT_AUDIENCE)) throw new Error("PRODUCTION_AUTH_POLICY_REQUIRED");
  return Object.freeze({
    env: parsed.OCR_ENV,
    port: parsed.OCR_PORT,
    trustedProxyHops: parsed.OCR_TRUSTED_PROXY_HOPS,
    ocr: Object.freeze({
      apiBaseUrl: parsed.OCR_API_BASE_URL.replace(/\/$/, ""),
      requestTimeoutSeconds: parsed.OCR_REQUEST_TIMEOUT,
      maxRetries: parsed.OCR_MAX_RETRIES
    }),
    auth: Object.freeze({ jwtSecrets, issuer: parsed.AUTH_JWT_ISSUER, audience: parsed.AUTH_JWT_AUDIENCE }),
    limits
  });
}

const webEnvSchema = z.object({
  OCR_ENV: z.enum(["development", "test", "production"]).default("development"),
  OCR_WEB_TENANT_ID: z.string().default(""),
  OCR_PUBLIC_BASE_URL: z.string().default(""),
  OCR_SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(480).default(30),
  OCR_SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).max(24).default(12),
  OCR_EXPORT_MAX_ROWS: z.coerce.number().int().min(1).max(200_000).default(50_000)
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Settings only the web app and the users CLI need. `trustedProxyHops` and the rest still come from `loadConfig`. */
export type WebConfig = Readonly<{
  tenantId: string;
  /** No trailing slash. Empty outside production, where the Origin guard falls back to the request Host. */
  publicBaseUrl: string;
  /** `new URL(publicBaseUrl).origin`, the only origin the CSRF check accepts. */
  publicOrigin: string;
  sessionIdleMinutes: number;
  sessionAbsoluteHours: number;
  exportMaxRows: number;
}>;

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function loadWebConfig(input: NodeJS.ProcessEnv = process.env): WebConfig {
  const parsed = webEnvSchema.parse(input);
  const tenantId = parsed.OCR_WEB_TENANT_ID.trim();
  if (tenantId && !UUID.test(tenantId)) throw new Error("INVALID_WEB_TENANT_ID");
  const baseUrl = parsed.OCR_PUBLIC_BASE_URL.trim().replace(/\/$/, "");
  const url = baseUrl ? parseUrl(baseUrl) : null;
  if (baseUrl && !url) throw new Error("INVALID_PUBLIC_BASE_URL");
  // A session cookie is only as good as the origin it is bound to, so production insists on a tenant and an https origin.
  if (parsed.OCR_ENV === "production" && (!tenantId || !url || url.protocol !== "https:")) throw new Error("PRODUCTION_WEB_CONFIG_INVALID");
  return Object.freeze({
    tenantId,
    publicBaseUrl: baseUrl,
    publicOrigin: url ? url.origin : "",
    sessionIdleMinutes: parsed.OCR_SESSION_IDLE_MINUTES,
    sessionAbsoluteHours: parsed.OCR_SESSION_ABSOLUTE_HOURS,
    exportMaxRows: parsed.OCR_EXPORT_MAX_ROWS
  });
}

export type RedactedLog = Readonly<Record<string, string | number | boolean>>;
const forbiddenKeys = /filename|ip|ocr|text|secret|token|password|credential/i;

export function redactLog(fields: Record<string, unknown>): RedactedLog {
  const safe: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (forbiddenKeys.test(key) || (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")) continue;
    safe[key] = value;
  }
  return Object.freeze(safe);
}
