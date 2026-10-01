import crypto from "node:crypto";
import { DEFAULT_CONFIG } from "./config.mjs";

let sdkEstimateTokens;
try {
  const sdk = await import("./pi-sdk.mjs");
  sdkEstimateTokens = sdk.estimateTokens;
} catch {
  // Standalone unit tests without Pi SDK available
}

/**
 * Estimates full token count for an array of messages using SDK estimateTokens when available,
 * or documented conservative heuristic: Math.ceil(chars / 3.5) + 4 tokens per message framing.
 * Estimation limit disclosed: approximate token count based on character density and message framing overhead.
 */
export function estimateFullMessagesTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let total = 0;
  for (const msg of messages) {
    let counted = 0;
    if (typeof sdkEstimateTokens === "function") {
      try {
        const est = sdkEstimateTokens(msg);
        if (typeof est === "number" && Number.isFinite(est) && est > 0) {
          counted = est;
        }
      } catch {
        counted = 0;
      }
    }
    if (counted === 0) {
      let chars = 0;
      if (typeof msg?.content === "string") {
        chars += msg.content.length;
      } else if (Array.isArray(msg?.content)) {
        for (const part of msg.content) {
          if (typeof part?.text === "string") chars += part.text.length;
          else if (typeof part === "string") chars += part.length;
        }
      }
      counted = Math.ceil(chars / 3.5) + 4;
    }
    total += counted;
  }
  return total;
}

/**
 * Executes a single completion attempt bounded by an attempt-level Promise.race timeout
 * and honoring the parent AbortSignal with immediate rejection.
 * Attaches a no-op rejection handler to the underlying promise to prevent unhandled
 * rejections if the provider resolves or rejects after timeout/abort settlement.
 */
async function executeAttempt({
  modelRegistry,
  modelConfig,
  summaryMessages,
  config,
  parentSignal,
  attemptTimeoutMs,
}) {
  if (parentSignal?.aborted) {
    throw parentSignal.reason || new Error("Compaction aborted by caller");
  }

  const model =
    modelRegistry.find?.(modelConfig.provider, modelConfig.modelId) ||
    modelRegistry.runtime?.getModel?.(modelConfig.provider, modelConfig.modelId);

  if (!model) {
    throw new Error(`Model not found: ${modelConfig.provider}/${modelConfig.modelId}`);
  }

  // Pre-check context window: estimated full prompt tokens + output cap + safety reserve against model.contextWindow
  if (typeof model.contextWindow === "number" && model.contextWindow > 0) {
    const estimatedMessageTokens = estimateFullMessagesTokens(summaryMessages);
    const outputCap = Math.min(config.maxTokens, model.maxTokens > 0 ? model.maxTokens : config.maxTokens);
    const safetyReserve = typeof config.safetyReserveTokens === "number" ? config.safetyReserveTokens : 1024;
    const totalRequiredTokens = estimatedMessageTokens + outputCap + safetyReserve;

    if (totalRequiredTokens > model.contextWindow) {
      const err = new Error(
        `Estimated prompt context (${totalRequiredTokens} tokens = ${estimatedMessageTokens} msg + ${outputCap} output + ${safetyReserve} reserve) exceeds model context window (${model.contextWindow} tokens) for ${model.provider}/${model.id}`,
      );
      err.code = "context_window_exceeded";
      throw err;
    }
  }

  const attemptController = new AbortController();

  // 1. Explicit parent abort rejection promise for immediate race settlement
  let onParentAbortListener;
  const parentAbortPromise = new Promise((_, reject) => {
    if (parentSignal?.aborted) {
      reject(parentSignal.reason || new Error("Compaction aborted by caller"));
      return;
    }
    if (parentSignal) {
      onParentAbortListener = () => {
        const reason = parentSignal.reason || new Error("Compaction aborted by caller");
        attemptController.abort(reason);
        reject(reason);
      };
      parentSignal.addEventListener("abort", onParentAbortListener, { once: true });
    }
  });

  // 2. Explicit attempt timeout rejection promise
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      attemptController.abort(new Error(`Attempt timed out after ${attemptTimeoutMs}ms`));
      const err = new Error(`Attempt timed out after ${attemptTimeoutMs}ms`);
      err.name = "TimeoutError";
      reject(err);
    }, attemptTimeoutMs);
  });

  const requestOptions = {
    maxTokens: Math.min(config.maxTokens, model.maxTokens > 0 ? model.maxTokens : config.maxTokens),
    cacheRetention: "none",
    sessionId: crypto.randomUUID(),
    signal: attemptController.signal,
  };

  if (model.reasoning && config.thinkingLevel && config.thinkingLevel !== "off") {
    requestOptions.reasoning = config.thinkingLevel;
    requestOptions.reasoningEffort = config.thinkingLevel;
  }

  // 3. Provider execution promise
  const completePromise = Promise.resolve().then(() =>
    modelRegistry.complete(model, { messages: summaryMessages }, requestOptions),
  );

  // Catch late rejections so they don't produce unhandled rejections if timeout or parent abort wins
  completePromise.catch(() => {});

  try {
    const response = await Promise.race([completePromise, timeoutPromise, parentAbortPromise]);

    if (parentSignal?.aborted) {
      throw parentSignal.reason || new Error("Compaction aborted by caller");
    }

    if (!response) {
      throw new Error("No response returned from summarizer");
    }

    if (response.stopReason === "length") {
      throw new Error("generation hit the token cap and the summary is incomplete");
    }
    if (response.stopReason === "error") {
      throw new Error(response.errorMessage || "Model provider returned an error");
    }

    const content = Array.isArray(response.content) ? response.content : [];

    // Check for forbidden tool calls
    if (content.some((b) => b?.type === "toolCall")) {
      throw new Error("Summary contained tool calls which are prohibited");
    }

    const summary = content
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n")
      .trim();

    if (!summary) {
      throw new Error("Compaction summary was empty");
    }

    if (summary.length > config.maxSummaryChars) {
      throw new Error("Summary exceeded maximum allowed character threshold");
    }

    return {
      summary,
      model,
      usage: response.usage,
    };
  } finally {
    clearTimeout(timeoutId);
    if (parentSignal && onParentAbortListener) {
      parentSignal.removeEventListener("abort", onParentAbortListener);
    }
  }
}

export async function summarizeWithOmniRoute({
  modelRegistry,
  summaryMessages,
  config = DEFAULT_CONFIG,
  signal,
  onFallback,
}) {
  const overallStart = Date.now();
  let primaryError;

  // 1. Primary Attempt
  const primaryBudget = Math.min(
    config.perAttemptTimeoutMs,
    Math.max(10, config.overallTimeoutMs - (Date.now() - overallStart)),
  );

  try {
    const result = await executeAttempt({
      modelRegistry,
      modelConfig: config.primaryModel,
      summaryMessages,
      config,
      parentSignal: signal,
      attemptTimeoutMs: primaryBudget,
    });

    return {
      summary: result.summary,
      model: result.model,
      usage: result.usage,
      attempts: 1,
    };
  } catch (err) {
    if (signal?.aborted) {
      throw err;
    }
    primaryError = err;
  }

  // Check remaining overall deadline before attempting fallback
  const elapsed = Date.now() - overallStart;
  const remainingBudget = config.overallTimeoutMs - elapsed;
  if (remainingBudget < 50) {
    // Budget exhausted; do not attempt fallback
    return {
      summary: null,
      error: new Error(`Overall compaction timeout budget exhausted (${elapsed}ms >= ${config.overallTimeoutMs}ms)`),
      primaryError,
      attempts: 1,
    };
  }

  // Notify stage transition
  onFallback?.(primaryError);

  // 2. Fallback Attempt (bounded by remaining budget and perAttemptTimeoutMs)
  const fallbackTimeoutMs = Math.min(config.perAttemptTimeoutMs, remainingBudget);

  try {
    const fallbackResult = await executeAttempt({
      modelRegistry,
      modelConfig: config.fallbackModel,
      summaryMessages,
      config,
      parentSignal: signal,
      attemptTimeoutMs: fallbackTimeoutMs,
    });

    return {
      summary: fallbackResult.summary,
      model: fallbackResult.model,
      usage: fallbackResult.usage,
      attempts: 2,
      fallbackFrom: config.primaryModel.modelId,
    };
  } catch (fallbackError) {
    if (signal?.aborted) {
      throw fallbackError;
    }
    return {
      summary: null,
      error: fallbackError,
      primaryError,
      attempts: 2,
    };
  }
}
