import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { summarizeWithOmniRoute } from "../../src/summarizer.mjs";
import { DEFAULT_CONFIG } from "../../src/config.mjs";

describe("summarizer module", () => {
  const dummyMessages = [{ role: "user", content: [{ type: "text", text: "Summarize this" }] }];

  function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }

  function response(text) {
    return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
  }

  function startTimedSummary(t, overrides = {}, signal) {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
    const primary = deferred();
    const primaryStarted = deferred();
    const fixture = { primary, primaryStarted, calls: [], fallbackErrors: [] };
    const modelRegistry = {
      find(provider, id) { return { provider, id, maxTokens: 8192 }; },
      complete(model, _context, options) {
        fixture.calls.push(model.id);
        if (model.id === DEFAULT_CONFIG.primaryModel.modelId) {
          fixture.primarySignal = options.signal;
          primaryStarted.resolve();
          // Deliberately ignores the attempt's AbortSignal.
          return primary.promise;
        }
        return Promise.resolve(response("Fallback success"));
      },
    };
    fixture.pending = summarizeWithOmniRoute({
      modelRegistry,
      summaryMessages: dummyMessages,
      signal,
      config: { ...DEFAULT_CONFIG, perAttemptTimeoutMs: 1000, overallTimeoutMs: 60000, ...overrides },
      onFallback: (error) => fixture.fallbackErrors.push(error),
    });
    t.after(() => primary.resolve(response("Cleanup")));
    return fixture;
  }

  function assertFallbackSuccess(fixture, result) {
    assert.deepEqual(fixture.calls, [DEFAULT_CONFIG.primaryModel.modelId, DEFAULT_CONFIG.fallbackModel.modelId]);
    assert.equal(result.summary, "Fallback success");
    assert.equal(result.model.id, DEFAULT_CONFIG.fallbackModel.modelId);
    assert.equal(result.fallbackFrom, DEFAULT_CONFIG.primaryModel.modelId);
    assert.equal(result.attempts, 2);
    assert.equal(fixture.primarySignal.aborted, true);
    assert.equal(fixture.fallbackErrors.length, 1);
    assert.equal(fixture.fallbackErrors[0].name, "TimeoutError");
  }

  async function drainEventLoop() {
    await nextEventLoopTurn();
    await nextEventLoopTurn();
  }

  async function assertIndependentLateSettlement(t, settlement) {
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    let fixture;
    try {
      fixture = startTimedSummary(t);
      await fixture.primaryStarted.promise;
      t.mock.timers.tick(1000);
      const result = await fixture.pending;
      assertFallbackSuccess(fixture, result);

      // Each test owns a different underlying promise and settles it exactly once.
      if (settlement === "resolve") fixture.primary.resolve(response("Late primary summary"));
      else fixture.primary.reject(new Error("Independent late network drop"));
      await drainEventLoop();
      assert.deepEqual(unhandled, [], "Late settlement must not emit an asynchronous unhandled rejection");
      assertFallbackSuccess(fixture, result);
    } finally {
      try {
        fixture?.primary.resolve(response("Cleanup"));
        await drainEventLoop();
      } finally {
        process.removeListener("unhandledRejection", onUnhandled);
      }
    }
  }

  it("late delivery of primary timeout consumes overall deadline and skips fallback", async (t) => {
    const fixture = startTimedSummary(t, { perAttemptTimeoutMs: 30, overallTimeoutMs: 200 });
    await fixture.primaryStarted.promise;
    // Reproduce the former scheduling failure: timeout delivery is delayed until the deadline.
    t.mock.timers.tick(200);
    const result = await fixture.pending;
    assert.equal(Date.now(), 1200);
    assert.equal(result.summary, null, "An exhausted overall deadline legitimately skips fallback");
    assert.equal(result.attempts, 1);
    assert.equal(result.primaryError.name, "TimeoutError");
    assert.match(result.error.message, /Overall compaction timeout budget exhausted/);
    assert.deepEqual(fixture.calls, [DEFAULT_CONFIG.primaryModel.modelId]);
    assert.deepEqual(fixture.fallbackErrors, []);
  });

  it("completes successfully using primary model and sends reasoningEffort low for reasoning models", async () => {
    let capturedOptions;
    const mockModelRegistry = {
      find(provider, modelId) {
        return { provider, id: modelId, maxTokens: 8192, reasoning: true };
      },
      async complete(model, context, options) {
        capturedOptions = options;
        return {
          role: "assistant",
          content: [{ type: "text", text: "## Goal\nTest goal\n## Progress\nDone" }],
          stopReason: "stop",
          usage: { inputTokens: 500, outputTokens: 80 },
        };
      },
    };

    const result = await summarizeWithOmniRoute({
      modelRegistry: mockModelRegistry,
      summaryMessages: dummyMessages,
      config: DEFAULT_CONFIG,
    });

    assert.ok(result.summary.includes("## Goal"));
    assert.equal(result.model.id, DEFAULT_CONFIG.primaryModel.modelId);
    assert.equal(result.attempts, 1);
    assert.equal(capturedOptions.cacheRetention, "none");
    assert.equal(capturedOptions.reasoningEffort, "low", "OmniRoute completions API requires reasoningEffort: low");
    assert.equal(capturedOptions.reasoning, "low");
  });

  it("handles provider that hangs forever ignoring signal via bounded Promise.race attempt timeout", async (t) => {
    const fixture = startTimedSummary(t);
    await fixture.primaryStarted.promise;
    t.mock.timers.tick(999);
    await drainEventLoop();
    assert.equal(fixture.primarySignal.aborted, false, "Attempt must not timeout before its budget");
    assert.deepEqual(fixture.calls, [DEFAULT_CONFIG.primaryModel.modelId]);
    t.mock.timers.tick(1);
    assertFallbackSuccess(fixture, await fixture.pending);
  });

  it("safely ignores independent late provider resolution after timeout", async (t) => {
    await assertIndependentLateSettlement(t, "resolve");
  });

  it("does NOT attempt fallback if primary attempt consumed the overallTimeoutMs budget", async (t) => {
    const fixture = startTimedSummary(t, { perAttemptTimeoutMs: 100, overallTimeoutMs: 70 });
    await fixture.primaryStarted.promise;
    t.mock.timers.tick(69);
    await drainEventLoop();
    assert.equal(fixture.primarySignal.aborted, false);
    t.mock.timers.tick(1);
    const result = await fixture.pending;
    assert.equal(result.summary, null);
    assert.equal(result.attempts, 1);
    assert.equal(result.primaryError.name, "TimeoutError");
    assert.match(result.primaryError.message, /after 70ms/);
    assert.match(result.error.message, /Overall compaction timeout budget exhausted/);
    assert.deepEqual(fixture.calls, [DEFAULT_CONFIG.primaryModel.modelId]);
    assert.deepEqual(fixture.fallbackErrors, []);
  });

  it("falls back to fallback model when primary model fails", async () => {
    let callCount = 0;
    const mockModelRegistry = {
      find(provider, modelId) {
        return { provider, id: modelId, maxTokens: 8192 };
      },
      async complete(model) {
        callCount++;
        if (model.id === DEFAULT_CONFIG.primaryModel.modelId) {
          throw new Error("Primary model unavailable (HTTP 503)");
        }
        return {
          role: "assistant",
          content: [{ type: "text", text: "## Fallback Summary\nGoal achieved" }],
          stopReason: "stop",
          usage: { inputTokens: 520, outputTokens: 90 },
        };
      },
    };

    const result = await summarizeWithOmniRoute({
      modelRegistry: mockModelRegistry,
      summaryMessages: dummyMessages,
      config: DEFAULT_CONFIG,
    });

    assert.equal(callCount, 2);
    assert.ok(result.summary.includes("## Fallback Summary"));
    assert.equal(result.model.id, DEFAULT_CONFIG.fallbackModel.modelId);
    assert.equal(result.attempts, 2);
  });

  it("rejects response with stopReason length and triggers fallback", async () => {
    const mockModelRegistry = {
      find(provider, modelId) {
        return { provider, id: modelId, maxTokens: 8192 };
      },
      async complete(model) {
        if (model.id === DEFAULT_CONFIG.primaryModel.modelId) {
          return {
            role: "assistant",
            content: [{ type: "text", text: "Incomplete text..." }],
            stopReason: "length",
          };
        }
        return {
          role: "assistant",
          content: [{ type: "text", text: "Complete fallback summary" }],
          stopReason: "stop",
        };
      },
    };

    const result = await summarizeWithOmniRoute({
      modelRegistry: mockModelRegistry,
      summaryMessages: dummyMessages,
      config: DEFAULT_CONFIG,
    });

    assert.equal(result.model.id, DEFAULT_CONFIG.fallbackModel.modelId);
  });

  it("rejects response containing tool calls and triggers fallback", async () => {
    const mockModelRegistry = {
      find(provider, modelId) {
        return { provider, id: modelId, maxTokens: 8192 };
      },
      async complete(model) {
        if (model.id === DEFAULT_CONFIG.primaryModel.modelId) {
          return {
            role: "assistant",
            content: [
              { type: "text", text: "Let me check" },
              { type: "toolCall", name: "bash", arguments: { command: "ls" } },
            ],
            stopReason: "toolUse",
          };
        }
        return {
          role: "assistant",
          content: [{ type: "text", text: "Clean fallback summary" }],
          stopReason: "stop",
        };
      },
    };

    const result = await summarizeWithOmniRoute({
      modelRegistry: mockModelRegistry,
      summaryMessages: dummyMessages,
      config: DEFAULT_CONFIG,
    });

    assert.equal(result.model.id, DEFAULT_CONFIG.fallbackModel.modelId);
  });

  it("returns null when both primary and fallback fail (allowing native fallback)", async () => {
    const mockModelRegistry = {
      find(provider, modelId) {
        return { provider, id: modelId, maxTokens: 8192 };
      },
      async complete() {
        throw new Error("Provider quota exceeded");
      },
    };

    const result = await summarizeWithOmniRoute({
      modelRegistry: mockModelRegistry,
      summaryMessages: dummyMessages,
      config: DEFAULT_CONFIG,
    });

    assert.equal(result.summary, null);
    assert.equal(result.attempts, 2);
    assert.ok(result.error);
  });

  it("rejects immediately when parent aborts while provider hangs forever ignoring signal", async (t) => {
    const parentController = new AbortController();
    const fixture = startTimedSummary(t, {}, parentController.signal);
    await fixture.primaryStarted.promise;
    const reason = new Error("Immediate user cancellation");
    const rejection = assert.rejects(fixture.pending, (error) => error === reason);
    const startTime = Date.now();
    setTimeout(() => parentController.abort(reason), 15);
    t.mock.timers.tick(15);
    await rejection;
    // No provider settlement or advancement to the attempt timeout is needed for cancellation.
    assert.equal(Date.now() - startTime, 15);
    assert.equal(fixture.primarySignal.aborted, true);
    assert.deepEqual(fixture.calls, [DEFAULT_CONFIG.primaryModel.modelId]);
    assert.deepEqual(fixture.fallbackErrors, []);
  });

  it("handles independent late provider rejection after timeout without unhandled rejection", async (t) => {
    await assertIndependentLateSettlement(t, "reject");
  });

  it("honors parent abort signal immediately without attempting fallback", async () => {
    const controller = new AbortController();
    let fallbackAttempted = false;

    const mockModelRegistry = {
      find(provider, modelId) {
        return { provider, id: modelId, maxTokens: 8192 };
      },
      async complete(model) {
        if (model.id === DEFAULT_CONFIG.primaryModel.modelId) {
          controller.abort(new Error("User cancelled"));
          throw controller.signal.reason;
        }
        fallbackAttempted = true;
        return { role: "assistant", content: [{ type: "text", text: "Fallback" }], stopReason: "stop" };
      },
    };

    await assert.rejects(
      async () => {
        await summarizeWithOmniRoute({
          modelRegistry: mockModelRegistry,
          summaryMessages: dummyMessages,
          config: DEFAULT_CONFIG,
          signal: controller.signal,
        });
      },
      (err) => err.name === "AbortError" || err.message === "User cancelled" || controller.signal.aborted,
    );

    assert.equal(fallbackAttempted, false, "Fallback must NOT be attempted when signal is aborted");
  });

  it("checks context window before attempt: primary with small context rejects without request, but larger fallback succeeds", async () => {
    let primaryCompleteCalled = false;
    let fallbackCompleteCalled = false;

    const mockModelRegistry = {
      find(provider, modelId) {
        if (modelId === DEFAULT_CONFIG.primaryModel.modelId) {
          return {
            provider,
            id: modelId,
            contextWindow: 2000, // Small context window: cannot fit prompt + output cap + safety reserve
            maxTokens: 4096,
          };
        }
        return {
          provider,
          id: modelId,
          contextWindow: 1048576, // 1M window: fits easily
          maxTokens: 8192,
        };
      },
      async complete(model) {
        if (model.id === DEFAULT_CONFIG.primaryModel.modelId) {
          primaryCompleteCalled = true;
          return { role: "assistant", content: [{ type: "text", text: "Primary" }], stopReason: "stop" };
        }
        fallbackCompleteCalled = true;
        return { role: "assistant", content: [{ type: "text", text: "## Goal\nFallback worked" }], stopReason: "stop" };
      },
    };

    const promptMessages = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Previous session summary:\n" + "P".repeat(4000) + "\nSpecial focus instructions:\n" + "I".repeat(1000) + "\n<conversation>\n" + "C".repeat(4000) + "\n</conversation>",
          },
        ],
      },
    ];

    const result = await summarizeWithOmniRoute({
      modelRegistry: mockModelRegistry,
      summaryMessages: promptMessages,
      config: DEFAULT_CONFIG,
    });

    assert.equal(primaryCompleteCalled, false, "Primary complete must NOT be called when context window is exceeded");
    assert.equal(fallbackCompleteCalled, true, "Fallback complete must be called and succeed");
    assert.equal(result.model.id, DEFAULT_CONFIG.fallbackModel.modelId);
    assert.equal(result.attempts, 2);
  });
});
