export type AiStageState = "disabled" | "blocked" | "enabled";
export type AiGatewayConfig = Readonly<{ state: AiStageState; baseUrl?: string; modelAllowlist: readonly string[] }>;
export interface AiExtractor {
  readonly state: AiStageState;
  extract(_input: { documentId: string; text: string }): Promise<never>;
}
/** M1 deliberately has no gateway transport. M3 will implement this port in ocr-ai-worker. */
export function disabledAiExtractor(reason = "AI_STAGE_DISABLED"): AiExtractor {
  return { state: "disabled", async extract(): Promise<never> { throw new Error(reason); } };
}
export function parseAiGatewayConfig(env: NodeJS.ProcessEnv = process.env): AiGatewayConfig {
  const enabled = env.OCR_AI_STAGE_ENABLED === "true";
  const baseUrl = env.LITELLM_BASE_URL?.trim();
  const allowlist = (env.OCR_AI_MODEL_ALLOWLIST ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  if (!enabled || !baseUrl || !env.LITELLM_API_KEY || allowlist.length === 0) return Object.freeze({ state: "disabled", modelAllowlist: [] });
  return Object.freeze({ state: "blocked", baseUrl, modelAllowlist: allowlist });
}
