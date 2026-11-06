import os from "node:os";
import path from "node:path";

import { resolveSummarizerSettings } from "./summarizer-settings.mjs";

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
  // Conversation providers whose sessions must never be summarized through OmniRoute.
  skipProviders: Object.freeze([]),
});

function resolveSkipProviders(options) {
  const raw = options.skipProviders !== undefined
    ? options.skipProviders
    : (process.env.PI_AUTO_COMPACTION_SKIP_PROVIDERS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

  if (!Array.isArray(raw)) {
    throw new Error("skipProviders must be an array of provider ids");
  }

  const normalized = raw.map((value) => {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error("skipProviders entries must be non-empty strings");
    }
    return value.trim();
  });

  return Object.freeze([...new Set(normalized)]);
}

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
    skipProviders: resolveSkipProviders(options),
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

/**
 * Resolves the effective runtime configuration by layering the persisted
 * summarizer settings under any explicit options. `resolveConfig` stays a pure
 * function with no filesystem access; this is the only resolver that reads the
 * settings file.
 */
export function resolveActiveConfig(options = {}) {
  const summarizer = resolveSummarizerSettings({
    settingsPath: options.settingsPath,
    agentDir: options.agentDir,
    env: options.env,
    options: {
      primaryModel: options.primaryModel,
      fallbackModel: options.fallbackModel,
    },
  });

  const config = resolveConfig({
    ...options,
    primaryModel: summarizer.primaryModel,
    fallbackModel: summarizer.fallbackModel,
  });

  delete config.env;
  delete config.settingsPath;
  delete config.agentDir;

  return {
    ...config,
    summarizer: Object.freeze({
      path: summarizer.path,
      source: summarizer.source,
      sources: summarizer.sources,
      warnings: Object.freeze([...summarizer.warnings]),
    }),
  };
}
