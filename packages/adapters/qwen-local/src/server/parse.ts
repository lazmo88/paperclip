import { asNumber, asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

/**
 * Qwen model pricing (USD per token)
 * Source: https://help.aliyun.com/zh/model-studio/getting-started/models
 * Note: Prices may change; update this table as needed.
 */
const QWEN_MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // Qwen3 Coder models
  "qwen3-coder-plus": { input: 0.0000006, output: 0.0000024 },
  "qwen3-coder-next": { input: 0.0000012, output: 0.0000048 },
  // Qwen3.5 models
  "qwen3.5-plus": { input: 0.0000004, output: 0.0000012 },
  "qwen3.5-turbo": { input: 0.0000003, output: 0.0000006 },
  // Qwen3 Max models
  "qwen3-max": { input: 0.000002, output: 0.000008 },
  "qwen3-max-2026-01-23": { input: 0.000002, output: 0.000008 },
  // GLM models (Zhipu AI)
  "glm-4": { input: 0.000014, output: 0.000014 },
  "glm-4-plus": { input: 0.00005, output: 0.00005 },
  "glm-4.7": { input: 0.000001, output: 0.000001 },
  "glm-5": { input: 0.000001, output: 0.000001 },
  // Kimi models (Moonshot AI)
  "kimi-k2.5": { input: 0.0000006, output: 0.0000024 },
  "moonshot-v1-8k": { input: 0.000012, output: 0.000012 },
  "moonshot-v1-32k": { input: 0.000024, output: 0.000024 },
  "moonshot-v1-128k": { input: 0.00006, output: 0.00006 },
  // MiniMax models
  "MiniMax-M2.5": { input: 0.0000004, output: 0.0000012 },
  "abab6.5-chat": { input: 0.00003, output: 0.00003 },
  // DeepSeek models
  "deepseek-chat": { input: 0.00000014, output: 0.00000028 },
  "deepseek-coder": { input: 0.00000014, output: 0.00000028 },
};

/**
 * Calculate cost from token usage when Qwen doesn't return cost data
 * (e.g., for Alibaba Coding Plan subscriptions)
 */
function calculateCostFromTokens(
  model: string | null,
  inputTokens: number,
  outputTokens: number,
): number {
  if (!model || inputTokens === 0) return 0;

  // Try exact match first
  let pricing = QWEN_MODEL_PRICING[model];

  // Try case-insensitive match
  if (!pricing) {
    const lowerModel = model.toLowerCase();
    for (const [key, value] of Object.entries(QWEN_MODEL_PRICING)) {
      if (key.toLowerCase() === lowerModel) {
        pricing = value;
        break;
      }
    }
  }

  // Try prefix match (e.g., "qwen3-coder-plus-123" matches "qwen3-coder-plus")
  if (!pricing) {
    const lowerModel = model.toLowerCase();
    for (const [key, value] of Object.entries(QWEN_MODEL_PRICING)) {
      if (lowerModel.startsWith(key.toLowerCase())) {
        pricing = value;
        break;
      }
    }
  }

  if (!pricing) return 0;

  return inputTokens * pricing.input + outputTokens * pricing.output;
}

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((entry) => textFromUnknown(entry))
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (typeof value !== "object" || value === null) return "";
  const record = parseObject(value);
  const result = parseObject(record.result);
  return (
    asString(record.text, "").trim() ||
    asString(record.content, "").trim() ||
    asString(record.message, "").trim() ||
    asString(record.summary, "").trim() ||
    asString(result.summary, "").trim() ||
    asString(result.message, "").trim() ||
    asString(result.text, "").trim() ||
    textFromUnknown(record.part) ||
    textFromUnknown(record.parts) ||
    textFromUnknown(record.contentParts)
  );
}

export function parseQwenStreamJson(stdout: string) {
  let sessionId: string | null = null;
  let model: string | null = null;
  let provider: string | null = null;
  let costUsd = 0;
  let resultJson: Record<string, unknown> | null = null;
  let resultSummary: string | null = null;
  const messages: string[] = [];
  const errors: string[] = [];
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = parseJson(line);
    if (!event) continue;

    const type = asString(event.type, "");
    const subtype = asString(event.subtype, "");
    const usageRecord = parseObject(event.usage);
    const metrics = parseObject(event.metrics);

    const currentSessionId =
      asString(event.sessionId, "").trim() ||
      asString(event.session_id, "").trim() ||
      asString(event.id, "").trim();
    if ((type === "system" || subtype === "session_start") && currentSessionId) {
      sessionId = currentSessionId;
    }

    model ||= asString(event.model, "").trim() || null;
    provider ||= asString(event.provider, "").trim() || null;

    if (type === "assistant" || type === "text") {
      const text =
        textFromUnknown(event.text) ||
        textFromUnknown(event.content) ||
        textFromUnknown(event.message) ||
        textFromUnknown(event.part) ||
        textFromUnknown(event.parts) ||
        textFromUnknown(event.contentParts);
      if (text) messages.push(text);
      continue;
    }

    if (type === "result") {
      resultJson = event;
      resultSummary ||=
        textFromUnknown(event.summary) ||
        textFromUnknown(event.message) ||
        textFromUnknown(event.result) ||
        null;
      usage.inputTokens +=
        asNumber(usageRecord.inputTokens, 0) ||
        asNumber(usageRecord.input_tokens, 0) ||
        asNumber(usageRecord.promptTokens, 0) ||
        asNumber(metrics.inputTokens, 0);
      usage.outputTokens +=
        asNumber(usageRecord.outputTokens, 0) ||
        asNumber(usageRecord.output_tokens, 0) ||
        asNumber(usageRecord.completionTokens, 0) ||
        asNumber(metrics.outputTokens, 0);
      usage.cachedInputTokens +=
        asNumber(usageRecord.cachedInputTokens, 0) ||
        asNumber(usageRecord.cached_input_tokens, 0);
      costUsd +=
        asNumber(usageRecord.costUsd, 0) ||
        asNumber(usageRecord.cost_usd, 0) ||
        asNumber(event.costUsd, 0) ||
        asNumber(event.cost, 0);
      const errorText =
        textFromUnknown(event.error) ||
        (event.is_error === true || event.isError === true ? textFromUnknown(event.message) : "");
      if (errorText) errors.push(errorText);
      continue;
    }

    if (type === "error") {
      const errorText = textFromUnknown(event.error) || textFromUnknown(event.message) || line;
      if (errorText) errors.push(errorText);
      continue;
    }
  }

  // If no cost was returned (e.g., for subscription plans), calculate from tokens
  const calculatedCostUsd =
    costUsd > 0
      ? costUsd
      : calculateCostFromTokens(model, usage.inputTokens, usage.outputTokens);

  return {
    sessionId,
    model,
    provider,
    usage,
    costUsd: calculatedCostUsd,
    resultJson,
    summary: messages.join("\n\n").trim() || resultSummary,
    errorMessage: errors.length > 0 ? errors.join("\n") : null,
  };
}

export function isQwenUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`;
  return /unknown\s+session|session\b.*\bnot\s+found|invalid\s+session|resume\b.*\bfailed|cannot\s+resume/i.test(
    haystack,
  );
}
