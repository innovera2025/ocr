import { z } from "zod";

const envSchema = z.object({
  OCR_ENV: z.enum(["development", "test", "production"]).default("development"),
  OCR_PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  OCR_TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
  OCR_API_BASE_URL: z.string().url().default("https://ai.innoveraappcenter.com/ocr"),
  OCR_REQUEST_TIMEOUT: z.coerce.number().int().min(1).max(900).default(120),
  OCR_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3)
  ,AUTH_JWT_SECRET: z.string().default("")
  ,AUTH_JWT_SECRETS: z.string().default("")
  ,AUTH_JWT_ISSUER: z.string().default("")
  ,AUTH_JWT_AUDIENCE: z.string().default("")
});

export const limits = Object.freeze({
  maxUploadBytes: 209_715_200,
  maxPagesPerDocument: 500,
  maxOcrPagesPerDocument: 50,
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
