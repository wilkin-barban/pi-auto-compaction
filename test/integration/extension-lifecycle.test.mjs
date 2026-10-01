import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { autoCompactionExtension } from "../../src/extension.mjs";

describe("extension-lifecycle integration", () => {
  let tempDir;
  let telemetryFile;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ext-test-"));
    telemetryFile = path.join(tempDir, "telemetry.jsonl");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createHarness() {
    const handlers = new Map();
    const emittedEvents = [];
    const uiStatuses = new Map();
    const notifications = [];

    const mockPi = {
      on(event, handler) {
        handlers.set(event, handler);
        return () => handlers.delete(event);
      },
      events: {
        emit(event, data) {
          emittedEvents.push({ event, data });
        },
      },
    };

    const mockCtx = {
      hasUI: true,
      mode: "tui",
      ui: {
        setStatus(key, text) {
          if (text === undefined) uiStatuses.delete(key);
          else uiStatuses.set(key, text);
        },
        setWidget() {},
        notify(message, type) {
          notifications.push({ message, type });
        },
      },
      sessionManager: {
        getSessionId() {
          return "sess-lifecycle";
        },
      },
      modelRegistry: {
        find(provider, modelId) {
          return { provider, id: modelId, maxTokens: 8192 };
        },
        async complete() {
          return {
            role: "assistant",
            content: [{ type: "text", text: "## Goal\nComplete feature\n## Progress\nDone" }],
            stopReason: "stop",
            usage: { inputTokens: 1000, outputTokens: 100 },
          };
        },
      },
    };

    return { mockPi, mockCtx, handlers, emittedEvents, uiStatuses, notifications };
  }

  it("registers all required hooks on extension initialization", () => {
    const { mockPi, handlers } = createHarness();
    autoCompactionExtension(mockPi, { telemetryPath: telemetryFile });

    assert.ok(handlers.has("session_before_compact"));
    assert.ok(handlers.has("session_compact"));
    assert.ok(handlers.has("session_compact_failed"));
    assert.ok(handlers.has("session_shutdown"));
  });

  it("handles session_before_compact, produces compaction and records session_compact telemetry", async () => {
    const { mockPi, mockCtx, handlers, emittedEvents } = createHarness();
    autoCompactionExtension(mockPi, { telemetryPath: telemetryFile });

    const beforeCompactHandler = handlers.get("session_before_compact");
    const result = await beforeCompactHandler(
      {
        type: "session_before_compact",
        preparation: {
          firstKeptEntryId: "entry-42",
          messagesToSummarize: [
            { role: "user", content: [{ type: "text", text: "Initial user request" }] },
            { role: "assistant", content: [{ type: "text", text: "Working on it" }] },
          ],
          turnPrefixMessages: [],
          isSplitTurn: false,
          tokensBefore: 205000,
          fileOps: { read: new Set(["a.ts"]), written: new Set(["b.ts"]), edited: new Set() },
        },
        branchEntries: [],
        reason: "threshold",
        willRetry: false,
        signal: new AbortController().signal,
      },
      mockCtx,
    );

    assert.ok(result.compaction, "Must return compaction result");
    assert.equal(result.compaction.firstKeptEntryId, "entry-42");
    assert.equal(result.compaction.tokensBefore, 205000);
    assert.ok(result.compaction.summary.includes("## Goal"));
    assert.ok(result.compaction.summary.includes("<read-files>\na.ts\n</read-files>"));
    assert.ok(result.compaction.summary.includes("<modified-files>\nb.ts\n</modified-files>"));

    // Verify herdr:blocked was active during compaction
    assert.ok(emittedEvents.some((e) => e.event === "herdr:blocked" && e.data.active === true));

    // Simulate Pi committing the compaction
    const compactHandler = handlers.get("session_compact");
    await compactHandler(
      {
        type: "session_compact",
        compactionEntry: {
          id: "comp-1",
          type: "compaction",
          tokensBefore: 205000,
        },
        fromExtension: true,
        reason: "threshold",
        willRetry: false,
      },
      mockCtx,
    );

    // Verify herdr:blocked was released on session_compact
    assert.ok(emittedEvents.some((e) => e.event === "herdr:blocked" && e.data.active === false));

    // Verify telemetry file recorded terminal success
    assert.ok(fs.existsSync(telemetryFile));
    const lines = fs.readFileSync(telemetryFile, "utf-8").trim().split("\n");
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.status, "success");
    assert.equal(entry.reason, "threshold");
    assert.equal(entry.tokensBefore, 205000);
    assert.equal(entry.attemptCount, 1, "Primary model success must record attemptCount: 1");
  });

  it("handles native fallback terminal accounting correctly when OmniRoute fails and native succeeds", async () => {
    const { mockPi, mockCtx, handlers } = createHarness();
    mockCtx.modelRegistry.complete = async () => {
      throw new Error("All OmniRoute models down");
    };

    autoCompactionExtension(mockPi, { telemetryPath: telemetryFile });

    const beforeCompactHandler = handlers.get("session_before_compact");
    const result = await beforeCompactHandler(
      {
        type: "session_before_compact",
        preparation: {
          firstKeptEntryId: "entry-42",
          messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
          turnPrefixMessages: [],
          isSplitTurn: false,
          tokensBefore: 205000,
          fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        },
        branchEntries: [],
        reason: "threshold",
        willRetry: false,
        signal: new AbortController().signal,
      },
      mockCtx,
    );

    // Returns undefined to let Pi attempt native compaction
    assert.equal(result, undefined);

    // Native compaction subsequently succeeds!
    const compactHandler = handlers.get("session_compact");
    await compactHandler(
      {
        type: "session_compact",
        compactionEntry: {
          id: "comp-native",
          type: "compaction",
          tokensBefore: 205000,
        },
        fromExtension: false,
        reason: "threshold",
        willRetry: false,
      },
      mockCtx,
    );

    // Telemetry must record terminal success with native model, NOT falsely reporting fallback failure
    const lines = fs.readFileSync(telemetryFile, "utf-8").trim().split("\n");
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.status, "success");
    assert.equal(entry.model, "native");
    assert.equal(entry.attemptCount, 2, "Native fallback after OmniRoute failure must record attemptCount: 2");
  });

  it("records attemptCount: 2 when primary model fails and fallback model succeeds", async () => {
    const { mockPi, mockCtx, handlers } = createHarness();
    let completeCount = 0;
    mockCtx.modelRegistry.complete = async (model) => {
      completeCount++;
      if (completeCount === 1) {
        throw new Error("Primary model temporary 503");
      }
      return {
        role: "assistant",
        content: [{ type: "text", text: "## Goal\nFallback worked\n## Progress\nDone" }],
        stopReason: "stop",
        usage: { inputTokens: 1200, outputTokens: 80 },
      };
    };

    autoCompactionExtension(mockPi, { telemetryPath: telemetryFile });

    const beforeCompactHandler = handlers.get("session_before_compact");
    const result = await beforeCompactHandler(
      {
        type: "session_before_compact",
        preparation: {
          firstKeptEntryId: "entry-fb",
          messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "Retry request" }] }],
          turnPrefixMessages: [],
          isSplitTurn: false,
          tokensBefore: 120000,
          fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        },
        branchEntries: [],
        reason: "threshold",
        willRetry: false,
        signal: new AbortController().signal,
      },
      mockCtx,
    );

    assert.ok(result.compaction, "Compaction from fallback must succeed");

    const compactHandler = handlers.get("session_compact");
    await compactHandler(
      {
        type: "session_compact",
        compactionEntry: { id: "comp-fb", type: "compaction", tokensBefore: 120000 },
        fromExtension: true,
        reason: "threshold",
        willRetry: false,
      },
      mockCtx,
    );

    const lines = fs.readFileSync(telemetryFile, "utf-8").trim().split("\n");
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.status, "success");
    assert.equal(entry.attemptCount, 2, "Fallback model success must record attemptCount: 2");
  });

  it("records separate telemetry entries for repeated compactions in the same session", async () => {
    const { mockPi, mockCtx, handlers } = createHarness();
    autoCompactionExtension(mockPi, { telemetryPath: telemetryFile });

    const beforeCompactHandler = handlers.get("session_before_compact");
    const compactHandler = handlers.get("session_compact");

    // Cycle 1
    await beforeCompactHandler(
      {
        type: "session_before_compact",
        preparation: {
          firstKeptEntryId: "entry-1",
          messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "Turn 1" }] }],
          turnPrefixMessages: [],
          isSplitTurn: false,
          tokensBefore: 100000,
          fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        },
        branchEntries: [],
        reason: "threshold",
        willRetry: false,
        signal: new AbortController().signal,
      },
      mockCtx,
    );
    await compactHandler(
      {
        type: "session_compact",
        compactionEntry: { id: "comp-1", type: "compaction", tokensBefore: 100000 },
        fromExtension: true,
        reason: "threshold",
        willRetry: false,
      },
      mockCtx,
    );

    // Cycle 2 (same session)
    await beforeCompactHandler(
      {
        type: "session_before_compact",
        preparation: {
          firstKeptEntryId: "entry-2",
          messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "Turn 2" }] }],
          turnPrefixMessages: [],
          isSplitTurn: false,
          tokensBefore: 150000,
          fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        },
        branchEntries: [],
        reason: "threshold",
        willRetry: false,
        signal: new AbortController().signal,
      },
      mockCtx,
    );
    await compactHandler(
      {
        type: "session_compact",
        compactionEntry: { id: "comp-2", type: "compaction", tokensBefore: 150000 },
        fromExtension: true,
        reason: "threshold",
        willRetry: false,
      },
      mockCtx,
    );

    const lines = fs.readFileSync(telemetryFile, "utf-8").trim().split("\n");
    assert.equal(lines.length, 2, "Both distinct cycles in the same session must be recorded");
  });
});
