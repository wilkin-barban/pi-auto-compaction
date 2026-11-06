// Compatibility smoke for the Pi SDK version that real installs run.
//
// This file lives outside test/ on purpose: `node --test` discovers every
// module under test/, while the repository pins an older SDK than production.
// Run it explicitly after installing the target SDK, e.g.:
//   npm install --no-save @earendil-works/pi-coding-agent@1.5.0 @earendil-works/pi-ai@1.5.0
//   node scripts/compat/pi-1.5.0-smoke.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const EXPECTED_VERSION = process.env.PI_COMPAT_VERSION || "1.5.0";
const checks = [];
const failures = [];

function packageVersion(name) {
  let directory = path.dirname(fileURLToPath(import.meta.resolve(name)));
  while (true) {
    const metadataPath = path.join(directory, "package.json");
    if (fs.existsSync(metadataPath)) {
      const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
      if (metadata.name === name) return metadata.version;
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`Cannot locate installed package ${name}`);
    directory = parent;
  }
}

async function check(label, run) {
  try {
    await run();
    checks.push(label);
    process.stdout.write(`ok - ${label}\n`);
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
    process.stdout.write(`not ok - ${label}\n  ${error.message}\n`);
  }
}

const sdk = await import("@earendil-works/pi-coding-agent");

await check(`installs @earendil-works/pi-coding-agent ${EXPECTED_VERSION}`, () => {
  const version = packageVersion("@earendil-works/pi-coding-agent");
  assert.equal(version, EXPECTED_VERSION, `expected ${EXPECTED_VERSION}, found ${version}`);
  assert.equal(packageVersion("@earendil-works/pi-ai"), EXPECTED_VERSION);
});

await check("publishes the compaction defaults the extension documents", () => {
  assert.ok(sdk.DEFAULT_COMPACTION_SETTINGS, "DEFAULT_COMPACTION_SETTINGS must be exported");
  assert.equal(sdk.DEFAULT_COMPACTION_SETTINGS.reserveTokens, 16384);
  assert.equal(sdk.DEFAULT_COMPACTION_SETTINGS.keepRecentTokens, 20000);
});

await check("exports the conversation helpers the extension imports", () => {
  for (const name of ["createAgentSession", "serializeConversation", "convertToLlm", "estimateTokens"]) {
    assert.equal(typeof sdk[name], "function", `${name} must be a function`);
  }
});

const extensionModule = await import("../../src/extension.mjs");

await check("serializes a conversation through the resolved SDK", () => {
  const messages = [{ role: "user", content: [{ type: "text", text: "Smoke: keep the conversation" }] }];
  const llmMessages = sdk.convertToLlm(messages);
  const serialized = sdk.serializeConversation(llmMessages);
  assert.equal(typeof serialized, "string");
  assert.ok(serialized.includes("Smoke: keep the conversation"));
  assert.ok(sdk.estimateTokens(messages[0]) > 0);
});

await check("registers every compaction hook and completes a cycle through modelRegistry.complete", async () => {
  const telemetryFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "pi-compat-smoke-")),
    "telemetry.jsonl",
  );
  const handlers = new Map();
  const pi = {
    on(name, handler) {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    events: { emit() {} },
  };
  let completions = 0;
  const ctx = {
    hasUI: false,
    mode: "text",
    ui: { setStatus() {}, setWidget() {}, notify() {} },
    sessionManager: { getSessionId: () => "smoke-session" },
    model: { provider: "openai", id: "gpt-6-sol", contextWindow: 400000 },
    modelRegistry: {
      find(provider, modelId) {
        return { provider, id: modelId, maxTokens: 8192 };
      },
      async complete() {
        completions += 1;
        return {
          role: "assistant",
          content: [{ type: "text", text: "## Goal\nSmoke summary" }],
          stopReason: "stop",
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
    },
  };

  extensionModule.autoCompactionExtension(pi, {
    telemetryPath: telemetryFile,
    settings: {
      compaction: {
        modelOverrides: { "openai/gpt-6-sol": { reserveTokens: 65536, keepRecentTokens: 20000 } },
      },
    },
  });

  for (const hook of ["session_before_compact", "session_compact", "session_compact_failed", "session_shutdown"]) {
    assert.ok(handlers.has(hook), `${hook} must be registered`);
  }

  const result = await handlers.get("session_before_compact")(
    {
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId: "entry-1",
        messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "Hola" }] }],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 300000,
        fileOps: { read: new Set(), write: new Set(), edit: new Set() },
      },
      branchEntries: [],
      reason: "threshold",
      willRetry: false,
      signal: new AbortController().signal,
    },
    ctx,
  );
  assert.ok(result?.compaction?.summary?.includes("Smoke summary"), "the summarizer must produce a compaction");
  assert.equal(completions, 1);

  await handlers.get("session_compact")(
    {
      type: "session_compact",
      compactionEntry: { id: "comp-1", type: "compaction", tokensBefore: 300000 },
      fromExtension: true,
      reason: "threshold",
      willRetry: false,
    },
    ctx,
  );

  const record = JSON.parse(fs.readFileSync(telemetryFile, "utf8").trim());
  assert.equal(record.status, "success");
  assert.equal(record.conversationProvider, "openai");
  assert.equal(record.conversationModel, "gpt-6-sol");
  assert.equal(record.contextWindow, 400000);
  assert.equal(record.reserveTokens, 65536);
  assert.equal(record.thresholdTokens, 334464);
});

if (failures.length > 0) {
  process.stderr.write(`\n${failures.length} compatibility check(s) failed against Pi ${EXPECTED_VERSION}:\n`);
  for (const failure of failures) process.stderr.write(`- ${failure}\n`);
  process.exit(1);
}

process.stdout.write(`\nAll ${checks.length} compatibility checks passed against Pi ${EXPECTED_VERSION}.\n`);
