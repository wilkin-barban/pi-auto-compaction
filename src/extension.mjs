import crypto from "node:crypto";
import { resolveConfig } from "./config.mjs";
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

export function autoCompactionExtension(pi, options = {}) {
  const config = resolveConfig(options);
  const telemetry = new TelemetryLogger(config);
  let activeUi = null;
  let activeCycle = null;

  pi.on("session_before_compact", async (event, ctx) => {
    const { preparation, branchEntries, customInstructions, reason, willRetry, signal } = event;

    if (signal?.aborted) {
      activeUi?.cleanup();
      activeUi = null;
      activeCycle = null;
      return { cancel: true };
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

    activeUi = new UiManager(pi, ctx);
    activeCycle = {
      cycleId,
      startTime,
      tokensBefore,
      reason,
      model: `${config.primaryModel.provider}/${config.primaryModel.modelId}`,
      sessionId,
      attemptedOmniRoute: true,
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
    telemetry.recordTerminalSuccess({
      cycleId: activeCycle?.cycleId,
      sessionId: ctx.sessionManager?.getSessionId?.() || activeCycle?.sessionId || "unknown",
      reason: event.reason,
      model,
      durationMs,
      tokensBefore,
      usage: event.fromExtension ? activeCycle?.usage : undefined,
      attemptCount: activeCycle?.attempts !== undefined ? activeCycle.attempts : (event.fromExtension ? 1 : 2),
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
    telemetry.recordTerminalFailure({
      cycleId: activeCycle?.cycleId,
      sessionId: ctx.sessionManager?.getSessionId?.() || activeCycle?.sessionId || "unknown",
      reason: event.reason,
      model,
      durationMs,
      tokensBefore,
      errorCategory: category,
      attemptCount: activeCycle?.attempts !== undefined ? activeCycle.attempts : 1,
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
