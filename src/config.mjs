import os from "node:os";
import path from "node:path";

export const DEFAULT_CONFIG = Object.freeze({
  primaryModel: Object.freeze({
    provider: "omniroute",
    modelId: "antigravity/gemini-3.8-flash-tiered",
  }),
  fallbackModel: Object.freeze({
    provider: "omniroute",
    modelId: "antigravity/gemini-3.6-flash-high",
  }),
  maxTokens: 8192,
  thinkingLevel: "low",
  perAttemptTimeoutMs: 60000,
  overallTimeoutMs: 120000,
  // 2,500,000 chars (~625,000 tokens) accommodates ~206k token sessions easily
  // while remaining well within OmniRoute's 1M token context window.
  maxInputChars: 2500000,
  maxSummaryChars: 100000,
  telemetryPath: path.join(os.homedir(), ".local", "state", "pi-auto-compaction", "compaction.jsonl"),
  telemetryMaxBytes: 1024 * 1024, // 1MB
  telemetryMaxFiles: 3,
});

export function resolveConfig(options = {}) {
  const merged = {
    ...DEFAULT_CONFIG,
    ...options,
    primaryModel: {
      ...DEFAULT_CONFIG.primaryModel,
      ...(options.primaryModel || {}),
    },
    fallbackModel: {
      ...DEFAULT_CONFIG.fallbackModel,
      ...(options.fallbackModel || {}),
    },
  };

  // Validations
  if (!Number.isInteger(merged.maxTokens) || merged.maxTokens <= 0) {
    throw new Error("maxTokens must be a positive integer");
  }
  if (merged.maxTokens > 8192) {
    throw new Error("maxTokens cannot exceed 8192");
  }

  if (!Number.isInteger(merged.perAttemptTimeoutMs) || merged.perAttemptTimeoutMs < 1000) {
    throw new Error("perAttemptTimeoutMs must be an integer >= 1000");
  }

  if (!Number.isInteger(merged.overallTimeoutMs) || merged.overallTimeoutMs < merged.perAttemptTimeoutMs) {
    throw new Error("overallTimeoutMs must be >= perAttemptTimeoutMs");
  }

  if (!Number.isInteger(merged.maxInputChars) || merged.maxInputChars < 10000) {
    throw new Error("maxInputChars must be an integer >= 10000");
  }

  if (!merged.primaryModel.provider || !merged.primaryModel.modelId) {
    throw new Error("Invalid primaryModel: provider and modelId are required strings");
  }

  if (!merged.fallbackModel.provider || !merged.fallbackModel.modelId) {
    throw new Error("Invalid fallbackModel: provider and modelId are required strings");
  }

  return merged;
}
