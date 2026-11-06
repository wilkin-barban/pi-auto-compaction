import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRuntimeConfig } from "./runtime-config.mjs";
import { TelemetryLogger } from "./telemetry.mjs";
import { UiManager } from "./ui-manager.mjs";
import { classifyError } from "./errors.mjs";
import {
  accumulateFileOperations,
  formatFileOpsSection,
  validateConversationCapacity,
  buildSummarizerMessages,
} from "./context-builder.mjs";
import { summarizeWithOmniRoute } from "./summarizer.mjs";
import { convertToLlm, serializeConversation } from "./pi-sdk.mjs";

const PI_DEFAULT_RESERVE_TOKENS = 16384;
const PI_DEFAULT_KEEP_RECENT_TOKENS = 20000;

function readAgentSettings(options = {}) {
  if (options.settings !== undefined) {
    if (typeof options.settings !== "object" || options.settings === null || Array.isArray(options.settings)) {
      return null;
    }
    return options.settings;
  }

  const agentDir =
    options.agentDir ||
    process.env.PI_CODING_AGENT_DIR ||
    path.join(os.homedir(), ".pi", "agent");
  const settingsPath = options.settingsPath || path.join(agentDir, "settings.json");

  try {
    if (!fs.existsSync(settingsPath)) {
      return {};
    }
    const content = fs.readFileSync(settingsPath, "utf-8");
    const parsed = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function resolveTokenSetting(overrideVal, globalVal, defaultVal) {
  if (typeof overrideVal === "number" && Number.isInteger(overrideVal) && overrideVal >= 0) {
    return overrideVal;
  }
  if (typeof globalVal === "number" && Number.isInteger(globalVal) && globalVal >= 0) {
    return globalVal;
  }
  if (overrideVal === undefined && globalVal === undefined) {
    return defaultVal;
  }
  return undefined;
}

function isConversationProviderSkipped(skipProviders, model) {
  if (!Array.isArray(skipProviders) || skipProviders.length === 0) return false;
  if (!model || typeof model !== "object") return false;

  const candidates = new Set();
  if (typeof model.provider === "string" && model.provider.length > 0) {
    candidates.add(model.provider);
  }
  if (typeof model.id === "string" && model.id.length > 0) {
    candidates.add(model.id);
    const separator = model.id.indexOf("/");
    if (separator > 0) candidates.add(model.id.slice(0, separator));
  }

  return [...candidates].some((candidate) => skipProviders.includes(candidate));
}

export function resolveConversationContext(ctx, options = {}) {
  try {
    if (!ctx || typeof ctx !== "object" || !ctx.model || typeof ctx.model !== "object") {
      return {};
    }

    const { model } = ctx;
    const result = {};

    if (typeof model.provider === "string" && model.provider.length > 0) {
      result.conversationProvider = model.provider;
    }

    if (typeof model.id === "string" && model.id.length > 0) {
      result.conversationModel = model.id;
    }

    if (typeof model.contextWindow === "number" && Number.isInteger(model.contextWindow) && model.contextWindow > 0) {
      result.contextWindow = model.contextWindow;
    }

    const settings = readAgentSettings(options);
    if (settings !== null) {
      const modelKey = `${model.provider}/${model.id}`;
      const modelOverride = settings.compaction?.modelOverrides?.[modelKey];

      const reserveTokens = resolveTokenSetting(
        modelOverride?.reserveTokens,
        settings.compaction?.reserveTokens,
        PI_DEFAULT_RESERVE_TOKENS,
      );

      const keepRecentTokens = resolveTokenSetting(
        modelOverride?.keepRecentTokens,
        settings.compaction?.keepRecentTokens,
        PI_DEFAULT_KEEP_RECENT_TOKENS,
      );

      if (reserveTokens !== undefined) {
        result.reserveTokens = reserveTokens;
      }

      if (keepRecentTokens !== undefined) {
        result.keepRecentTokens = keepRecentTokens;
      }

      if (result.contextWindow !== undefined && result.reserveTokens !== undefined) {
        result.thresholdTokens = result.contextWindow - result.reserveTokens;
      }
    }

    return result;
  } catch {
    return {};
  }
}

export function autoCompactionExtension(pi, options = {}) {
  const runtime = createRuntimeConfig(options);
  const telemetry = new TelemetryLogger(runtime.get());
  let activeUi = null;
  let activeCycle = null;

  pi.on("session_before_compact", async (event, ctx) => {
    // Snapshot the live configuration so a mid-cycle update never mixes models.
    const config = runtime.get();
    const { preparation, branchEntries, customInstructions, reason, willRetry, signal } = event;

    if (signal?.aborted) {
      activeUi?.cleanup();
      activeUi = null;
      activeCycle = null;
      return { cancel: true };
    }

    // A skipped conversation provider must never be summarized through
    // OmniRoute. Returning undefined lets Pi run its native compaction, where
    // the conversation model summarizes its own session.
    if (isConversationProviderSkipped(config.skipProviders, ctx?.model)) {
      return undefined;
    }

    const {
      firstKeptEntryId,
      tokensBefore,
      messagesToSummarize = [],
      turnPrefixMessages = [],
      previousSummary,
      fileOps,
    } = preparation;

    const sessionId = ctx.sessionManager?.getSessionId?.() || "sess-inmemory";
    const cycleId = `cycle-${sessionId}-${Date.now()}-${tokensBefore}-${crypto.randomUUID().slice(0, 8)}`;
    const startTime = Date.now();
    const conversationContext = resolveConversationContext(ctx, options);

    activeUi = new UiManager(pi, ctx);
    activeCycle = {
      cycleId,
      startTime,
      tokensBefore,
      reason,
      model: `${config.primaryModel.provider}/${config.primaryModel.modelId}`,
      sessionId,
      attemptedOmniRoute: true,
      conversationContext,
    };

    activeUi.startCompaction(reason, config.primaryModel.modelId);

    try {
      // 1. Accumulate files from current turn and previous compactions
      const { readFiles, modifiedFiles } = accumulateFileOperations(fileOps, branchEntries);

      // 2. Combine all messages for compaction
      const allMessages = [...messagesToSummarize, ...turnPrefixMessages];
      const llmMessages = convertToLlm(allMessages);
      const rawSerialized = serializeConversation(llmMessages);

      // 3. Validate conversation capacity to prevent silent loss of decisions
      validateConversationCapacity(rawSerialized, config.maxInputChars);

      // 4. Build prompt
      const summaryMessages = buildSummarizerMessages({
        conversationText: rawSerialized,
        previousSummary,
        customInstructions,
        maxPromptChars: config.maxInputChars,
      });

      // 5. Run OmniRoute summarization (primary with fallback)
      const result = await summarizeWithOmniRoute({
        modelRegistry: ctx.modelRegistry,
        summaryMessages,
        config,
        signal,
        onFallback: (primaryErr) => {
          activeCycle.model = `${config.fallbackModel.provider}/${config.fallbackModel.modelId}`;
          activeUi.fallbackTransition(
            primaryErr ? primaryErr.message : "Primary failed",
            config.fallbackModel.modelId,
          );
        },
      });

      // If user cancelled, clean up and cancel
      if (signal?.aborted) {
        activeUi.cleanup();
        activeUi = null;
        activeCycle = null;
        return { cancel: true };
      }

      // If both models failed, allow Pi's native compaction as last resort
      if (!result?.summary) {
        activeCycle.model = "native";
        activeCycle.attempts = result?.attempts || 2;
        activeUi.nativeTransition();
        // Do NOT fail telemetry here: wait for Pi's session_compact or session_compact_failed!
        return undefined;
      }

      // Append file operations XML section
      const fileSection = formatFileOpsSection(readFiles, modifiedFiles);
      const finalSummary = `${result.summary}${fileSection}`;

      const modelIdString = `${result.model.provider}/${result.model.id}`;
      activeCycle.model = modelIdString;
      activeCycle.usage = result.usage;
      activeCycle.attempts = result.attempts || 1;

      return {
        compaction: {
          summary: finalSummary,
          firstKeptEntryId,
          tokensBefore,
          usage: result.usage,
          details: {
            readFiles,
            modifiedFiles,
            model: modelIdString,
          },
        },
      };
    } catch (err) {
      if (signal?.aborted) {
        activeUi?.cleanup();
        activeUi = null;
        activeCycle = null;
        return { cancel: true };
      }

      // If hook execution threw, transition to native compaction and let Pi handle the outcome
      activeCycle.model = "native";
      activeCycle.attempts = activeCycle.attempts || 1;
      activeUi?.nativeTransition();
      return undefined;
    }
  });

  pi.on("session_compact", async (event, ctx) => {
    const durationMs = activeCycle?.startTime ? Date.now() - activeCycle.startTime : 0;
    // If compaction did not come from extension, it was performed by native Pi
    const model = event.fromExtension ? (activeCycle?.model || "unknown") : "native";
    const tokensBefore = event.compactionEntry?.tokensBefore || activeCycle?.tokensBefore || 0;

    activeUi?.completeCompaction(model, durationMs, tokensBefore);
    const conversationContext = activeCycle?.conversationContext || resolveConversationContext(ctx, options);
    telemetry.recordTerminalSuccess({
      cycleId: activeCycle?.cycleId,
      sessionId: ctx.sessionManager?.getSessionId?.() || activeCycle?.sessionId || "unknown",
      reason: event.reason,
      model,
      durationMs,
      tokensBefore,
      usage: event.fromExtension ? activeCycle?.usage : undefined,
      attemptCount: activeCycle?.attempts !== undefined ? activeCycle.attempts : (event.fromExtension ? 1 : 2),
      conversationModel: conversationContext.conversationModel,
      conversationProvider: conversationContext.conversationProvider,
      contextWindow: conversationContext.contextWindow,
      reserveTokens: conversationContext.reserveTokens,
      keepRecentTokens: conversationContext.keepRecentTokens,
      thresholdTokens: conversationContext.thresholdTokens,
    });

    activeUi = null;
    activeCycle = null;
  });

  pi.on("session_compact_failed", async (event, ctx) => {
    const durationMs = activeCycle?.startTime ? Date.now() - activeCycle.startTime : 0;
    const model = event.fromExtension ? (activeCycle?.model || "unknown") : "native";
    const tokensBefore = activeCycle?.tokensBefore || 0;
    const category = event.aborted ? "abort" : classifyError(event.errorMessage);

    activeUi?.failCompaction(category, event.willRetry);
    const conversationContext = activeCycle?.conversationContext || resolveConversationContext(ctx, options);
    telemetry.recordTerminalFailure({
      cycleId: activeCycle?.cycleId,
      sessionId: ctx.sessionManager?.getSessionId?.() || activeCycle?.sessionId || "unknown",
      reason: event.reason,
      model,
      durationMs,
      tokensBefore,
      errorCategory: category,
      attemptCount: activeCycle?.attempts !== undefined ? activeCycle.attempts : 1,
      conversationModel: conversationContext.conversationModel,
      conversationProvider: conversationContext.conversationProvider,
      contextWindow: conversationContext.contextWindow,
      reserveTokens: conversationContext.reserveTokens,
      keepRecentTokens: conversationContext.keepRecentTokens,
      thresholdTokens: conversationContext.thresholdTokens,
    });

    activeUi = null;
    activeCycle = null;
  });

  pi.on("session_shutdown", () => {
    activeUi?.cleanup();
    activeUi = null;
    activeCycle = null;
  });
}

export default autoCompactionExtension;
