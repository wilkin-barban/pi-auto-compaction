import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
  loadPiAI,
} from "../../src/pi-sdk.mjs";
const { AssistantMessageEventStream } = await loadPiAI();
const { streamSimple } = await loadPiAI("compat");

describe("pi-sdk-runtime integration", () => {
  let tempDir;
  let agentDir;
  let telemetryFile;
  let sessionFile;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sdk-test-"));
    agentDir = path.join(tempDir, "agent");
    telemetryFile = path.join(agentDir, "telemetry.jsonl");
    sessionFile = path.join(tempDir, "session.jsonl");

    fs.mkdirSync(path.join(agentDir, "extensions"), { recursive: true });

    // 100% Synthetic auth.json - NO live production credentials!
    fs.writeFileSync(
      path.join(agentDir, "auth.json"),
      JSON.stringify({
        "synthetic-openai": { type: "api_key", key: "mock-key-12345" },
        omniroute: { type: "api_key", key: "mock-omni-key-67890" },
      }),
    );

    // 100% Synthetic models.json
    fs.writeFileSync(
      path.join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          "synthetic-openai": {
            baseUrl: "http://127.0.0.1:20129/v1",
            apiKey: "mock-key-12345",
            api: "openai-responses",
            models: [
              {
                id: "gpt-6-sol",
                name: "GPT-6 Sol",
                input: ["text"],
                contextWindow: 100000,
                maxTokens: 4096,
              },
            ],
          },
          omniroute: {
            baseUrl: "http://127.0.0.1:20129/v1",
            apiKey: "mock-omni-key-67890",
            api: "openai-completions",
            models: [
              {
                id: "antigravity/gemini-3.8-flash-tiered",
                name: "Gemini 3.8 Flash (OmniRoute)",
                input: ["text"],
                reasoning: true,
                contextWindow: 1048576,
                maxTokens: 8192,
              },
              {
                id: "antigravity/gemini-3.6-flash-high",
                name: "Gemini 3.6 Flash",
                input: ["text"],
                contextWindow: 1048576,
                maxTokens: 8192,
              },
            ],
          },
        },
      }),
    );

    // Generate real TypeScript extension loader inside agentDir/extensions
    // pointing directly to our local source package entry point
    const packageSourcePath = path.resolve("index.mjs");
    fs.writeFileSync(
      path.join(agentDir, "extensions", "omniroute-compaction.ts"),
      `
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function (pi: ExtensionAPI) {
  const ext = await import("${packageSourcePath}");
  ext.autoCompactionExtension(pi, {
    telemetryPath: "${telemetryFile}",
  });
}
`,
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function populateSessionHistory(sessionManager) {
    // 200,000 characters = ~50,000 tokens (> 34,464 threshold for 100k window - 65536 reserve)
    sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Initial user request: " + "a".repeat(60000) }],
      timestamp: Date.now(),
    });
    sessionManager.appendMessage({
      role: "assistant",
      content: [
        { type: "text", text: "Assistant response 1: " + "b".repeat(60000) },
        { type: "toolCall", name: "read", arguments: { path: "src/server.ts" } },
        { type: "toolCall", name: "edit", arguments: { path: "src/handler.ts" } },
      ],
      timestamp: Date.now(),
    });
    sessionManager.appendMessage({
      role: "toolResult",
      content: [{ type: "text", text: "file content" }],
      timestamp: Date.now(),
    });
    sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Recent user message: " + "c".repeat(40000) }],
      timestamp: Date.now(),
    });
    sessionManager.appendMessage({
      role: "assistant",
      content: [
        { type: "text", text: "Recent assistant response: " + "d".repeat(40000) },
      ],
      timestamp: Date.now(),
    });
  }

  it("auto-discovers loader via jiti, triggers compaction on public session.prompt, and persists to disk session file", async () => {
    // Real on-disk SessionManager
    const sessionManager = SessionManager.open(sessionFile);
    populateSessionHistory(sessionManager);

    const settingsManager = SettingsManager.inMemory({
      compaction: {
        enabled: true,
        reserveTokens: 65536,
        keepRecentTokens: 5000,
        modelOverrides: {
          "synthetic-openai/gpt-6-sol": {
            reserveTokens: 65536,
            keepRecentTokens: 5000,
          },
        },
      },
    });

    const resourceLoader = new DefaultResourceLoader({
      cwd: tempDir,
      agentDir,
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd: tempDir,
      agentDir,
      sessionManager,
      settingsManager,
      resourceLoader,
    });

    const targetModel = session.modelRuntime.getModel("synthetic-openai", "gpt-6-sol");
    assert.ok(targetModel, "synthetic-openai/gpt-6-sol must exist in modelRuntime");
    await session.setModel(targetModel);

    // Mock OmniRoute complete in modelRuntime to assert reasoningEffort payload and return synthetic summary
    let capturedOptions;
    session.modelRuntime.complete = async (model, context, options) => {
      if (model.provider === "omniroute") {
        capturedOptions = options;
        return {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "## Goal\nSynthetic compaction summary\n## Progress\nDone",
            },
          ],
          stopReason: "stop",
          usage: { inputTokens: 2500, outputTokens: 250 },
        };
      }
      throw new Error(`Unexpected complete call for ${model.provider}/${model.id}`);
    };

    // Mock streamSimple to deliver a mock assistant message without real network
    session.modelRuntime.streamSimple = () => {
      const stream = new AssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          type: "start",
          partial: {
            role: "assistant",
            content: [{ type: "text", text: "Turn completed successfully" }],
          },
        });
        stream.push({
          type: "done",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Turn completed successfully" }],
            stopReason: "stop",
          },
        });
        stream.end();
      });
      return stream;
    };

    // Execute public session.prompt!
    // Since history has ~50k tokens and threshold is 34,464, Pi triggers auto-compaction before the next turn!
    await session.prompt("Continue work");

    // Conversation model must remain unchanged
    assert.equal(session.model.id, "gpt-6-sol");
    assert.equal(session.model.provider, "synthetic-openai");

    // Verify OmniRoute request options had reasoningEffort: "low"
    assert.equal(capturedOptions?.reasoningEffort, "low");

    // Verify compaction entry was written to the real disk session file
    const compactionEntry = session.sessionManager.getEntries().find((e) => e.type === "compaction");
    assert.ok(compactionEntry, "Compaction entry must be persisted in sessionManager");
    assert.equal(compactionEntry.fromHook, true);
    assert.ok(compactionEntry.summary.includes("## Goal"));
    assert.ok(compactionEntry.summary.includes("<read-files>\nsrc/server.ts\n</read-files>"));
    assert.ok(compactionEntry.summary.includes("<modified-files>\nsrc/handler.ts\n</modified-files>"));

    // Verify disk file persisted it
    const fileLines = fs.readFileSync(sessionFile, "utf-8").trim().split("\n");
    const hasCompactionInFile = fileLines.some((l) => l.includes('"type":"compaction"'));
    assert.ok(hasCompactionInFile, "Compaction must be saved to on-disk session file");

    // Verify telemetry
    assert.ok(fs.existsSync(telemetryFile), "Telemetry file must exist");
    const telemetryLines = fs.readFileSync(telemetryFile, "utf-8").trim().split("\n");
    assert.equal(telemetryLines.length, 1);
    const telemetry = JSON.parse(telemetryLines[0]);
    assert.equal(telemetry.status, "success");
    assert.equal(telemetry.reason, "threshold");
    assert.equal(telemetry.model, "omniroute/antigravity/gemini-3.8-flash-tiered");

    session.dispose();
  });

  it("handles large ~850,000 chars near-206k context session without truncation via public session.prompt", async () => {
    const sessionManager = SessionManager.open(sessionFile);
    // Build ~950,000 chars of history to summarize (~237,500 tokens using chars/4)
    sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Long-term architecture: " + "A".repeat(500000) }],
      timestamp: Date.now(),
    });
    sessionManager.appendMessage({
      role: "assistant",
      content: [
        { type: "text", text: "Verified implementation: " + "B".repeat(400000) },
        { type: "toolCall", name: "read", arguments: { path: "src/big-module.ts" } },
      ],
      timestamp: Date.now(),
    });
    sessionManager.appendMessage({
      role: "toolResult",
      content: [{ type: "text", text: "file content" }],
      timestamp: Date.now(),
    });
    sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Recent user instructions: " + "C".repeat(50000) }],
      timestamp: Date.now(),
    });

    const settingsManager = SettingsManager.inMemory({
      compaction: {
        enabled: true,
        reserveTokens: 65536,
        keepRecentTokens: 5000,
        modelOverrides: {
          "synthetic-openai/gpt-6-sol": {
            reserveTokens: 65536,
            keepRecentTokens: 5000,
          },
        },
      },
    });

    const resourceLoader = new DefaultResourceLoader({
      cwd: tempDir,
      agentDir,
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd: tempDir,
      agentDir,
      sessionManager,
      settingsManager,
      resourceLoader,
    });

    const targetModel = session.modelRuntime.getModel("synthetic-openai", "gpt-6-sol");
    await session.setModel(targetModel);

    let omniRoutePromptReceived = "";
    session.modelRuntime.complete = async (model, context) => {
      if (model.provider === "omniroute") {
        omniRoutePromptReceived = context.messages[0].content[0].text;
        return {
          role: "assistant",
          content: [{ type: "text", text: "## Goal\nSummarized huge session\n## Progress\nDone" }],
          stopReason: "stop",
          usage: { inputTokens: 215000, outputTokens: 300 },
        };
      }
      throw new Error(`Unexpected complete call for ${model.provider}`);
    };

    session.modelRuntime.streamSimple = () => {
      const stream = new AssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          type: "done",
          message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" },
        });
        stream.end();
      });
      return stream;
    };

    await session.prompt("Proceed with next task");

    // Must have processed the full ~850k chars without truncation!
    assert.ok(omniRoutePromptReceived.length > 800000, "Must send full ~850k chars history to OmniRoute 1M context");
    assert.ok(omniRoutePromptReceived.includes("Long-term architecture: AAAAA"));
    assert.ok(!omniRoutePromptReceived.includes("truncated"), "Must NOT silently truncate middle decisions");

    const compactionEntry = session.sessionManager.getEntries().find((e) => e.type === "compaction");
    assert.ok(compactionEntry, "Compaction must be saved to on-disk session");
    assert.equal(compactionEntry.fromHook, true);
    assert.ok(compactionEntry.summary.includes("<read-files>\nsrc/big-module.ts\n</read-files>"));

    session.dispose();
  });

  it("preserves prior file lists across multiple public compaction cycles in the same session", async () => {
    const sessionManager = SessionManager.open(sessionFile);
    populateSessionHistory(sessionManager);

    const settingsManager = SettingsManager.inMemory({
      compaction: {
        enabled: true,
        reserveTokens: 65536,
        keepRecentTokens: 5000,
        modelOverrides: {
          "synthetic-openai/gpt-6-sol": {
            reserveTokens: 65536,
            keepRecentTokens: 5000,
          },
        },
      },
    });

    const resourceLoader = new DefaultResourceLoader({
      cwd: tempDir,
      agentDir,
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd: tempDir,
      agentDir,
      sessionManager,
      settingsManager,
      resourceLoader,
    });

    const targetModel = session.modelRuntime.getModel("synthetic-openai", "gpt-6-sol");
    await session.setModel(targetModel);

    let cycleIndex = 0;
    const promptsReceivedInOmniRoute = [];
    session.modelRuntime.complete = async (model, context) => {
      cycleIndex++;
      const promptText = context.messages?.[0]?.content?.[0]?.text || "";
      promptsReceivedInOmniRoute.push(promptText);
      return {
        role: "assistant",
        content: [{ type: "text", text: `## Goal\nSummary cycle ${cycleIndex}\n## Progress\nDone` }],
        stopReason: "stop",
        usage: { inputTokens: 2000, outputTokens: 100 },
      };
    };

    session.modelRuntime.streamSimple = () => {
      const stream = new AssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          type: "done",
          message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
        });
        stream.end();
      });
      return stream;
    };

    // Cycle 1 compaction
    await session.prompt("Cycle 1");
    assert.equal(cycleIndex, 1);

    // Now add new messages in session and trigger Cycle 2
    const now = Date.now() + 2000;
    const msg1 = {
      role: "assistant",
      content: [
        { type: "text", text: "Working on database " + "E".repeat(100000) },
        { type: "toolCall", name: "write", arguments: { path: "src/database.ts" } },
      ],
      timestamp: now,
      usage: { inputTokens: 50000, outputTokens: 100 },
    };
    const msg2 = {
      role: "toolResult",
      content: [{ type: "text", text: "ok" }],
      timestamp: now + 1,
    };
    const msg3 = {
      role: "user",
      content: [{ type: "text", text: "Add migration " + "F".repeat(100000) }],
      timestamp: now + 2,
    };

    session.sessionManager.appendMessage(msg1);
    session.sessionManager.appendMessage(msg2);
    session.sessionManager.appendMessage(msg3);
    session.agent.state.messages.push(msg1, msg2, msg3);

    // Cycle 2 compaction triggered by public session.prompt!
    await session.prompt("Cycle 2");
    assert.equal(cycleIndex, 2);

    const compactions = session.sessionManager.getEntries().filter((e) => e.type === "compaction");
    assert.equal(compactions.length, 2, "Must record 2 compactions in session tree");

    // Both compactions must have fromHook: true
    const fromHookEntries = compactions.filter((e) => e.fromHook === true);
    assert.equal(fromHookEntries.length, 2, "Both compaction entries must have fromHook: true");

    // Second compaction prompt must have included previousSummary from Cycle 1
    assert.ok(
      promptsReceivedInOmniRoute[1].includes("Previous session summary"),
      "OmniRoute prompt in cycle 2 must include previousSummary header",
    );
    assert.ok(
      promptsReceivedInOmniRoute[1].includes("Summary cycle 1"),
      "OmniRoute prompt in cycle 2 must include summary text from cycle 1",
    );

    // Second compaction must accumulate files from first compaction (server.ts, handler.ts) AND new file (database.ts)
    const secondCompaction = compactions[1];
    assert.ok(secondCompaction.summary.includes("<read-files>\nsrc/server.ts\n</read-files>"));
    assert.ok(secondCompaction.summary.includes("src/database.ts"));
    assert.ok(secondCompaction.summary.includes("src/handler.ts"));

    // Telemetry must record 2 distinct cycles
    const telemetryLines = fs.readFileSync(telemetryFile, "utf-8").trim().split("\n");
    assert.equal(telemetryLines.length, 2);

    session.dispose();
  });

  it("verifies auth-before-hook caveat: unauthenticated conversation model fails before extension hook in synthetic setup", async () => {
    const sessionManager = SessionManager.inMemory();
    populateSessionHistory(sessionManager);

    const resourceLoader = new DefaultResourceLoader({
      cwd: tempDir,
      agentDir,
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd: tempDir,
      agentDir,
      sessionManager,
      resourceLoader,
    });

    const targetModel = session.modelRuntime.getModel("synthetic-openai", "gpt-6-sol");
    await session.setModel(targetModel);

    // Set streamFunction to streamSimple and simulate expired/missing credentials for conversation model
    session.agent.streamFunction = streamSimple;
    session.modelRuntime.getAuth = async () => undefined;

    let extensionHookReached = false;
    session._extensionRunner.emit = async (ev) => {
      if (ev.type === "session_before_compact") {
        extensionHookReached = true;
      }
    };

    // Run compaction check: Pi's internal _getRequiredRequestAuth rejects before emitting session_before_compact
    await session._runAutoCompaction("threshold", false);

    assert.equal(extensionHookReached, false, "Extension hook must NOT be reached when conversation model auth fails");

    session.dispose();
  });
});
