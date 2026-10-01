import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, resolveConfig } from "../../src/config.mjs";

describe("config module", () => {
  it("provides correct defaults conforming to feature requirements", () => {
    assert.deepEqual(DEFAULT_CONFIG.primaryModel, {
      provider: "omniroute",
      modelId: "antigravity/gemini-3.8-flash-tiered",
    });
    assert.deepEqual(DEFAULT_CONFIG.fallbackModel, {
      provider: "omniroute",
      modelId: "antigravity/gemini-3.6-flash-high",
    });
    assert.equal(DEFAULT_CONFIG.maxTokens, 8192);
    assert.equal(DEFAULT_CONFIG.thinkingLevel, "low");
    assert.equal(DEFAULT_CONFIG.perAttemptTimeoutMs, 60000);
    assert.equal(DEFAULT_CONFIG.overallTimeoutMs, 120000);
    assert.equal(DEFAULT_CONFIG.maxInputChars, 2500000);
    assert.equal(DEFAULT_CONFIG.maxSummaryChars, 100000);
    assert.ok(DEFAULT_CONFIG.telemetryPath.includes("pi-auto-compaction"));
  });

  it("merges custom options safely", () => {
    const custom = resolveConfig({
      maxTokens: 4096,
      perAttemptTimeoutMs: 30000,
      primaryModel: {
        provider: "custom-provider",
        modelId: "custom-model",
      },
    });

    assert.equal(custom.maxTokens, 4096);
    assert.equal(custom.perAttemptTimeoutMs, 30000);
    assert.deepEqual(custom.primaryModel, {
      provider: "custom-provider",
      modelId: "custom-model",
    });
    assert.deepEqual(custom.fallbackModel, DEFAULT_CONFIG.fallbackModel);
  });

  it("validates and rejects invalid token limits", () => {
    assert.throws(() => resolveConfig({ maxTokens: -10 }), /maxTokens must be a positive integer/);
    assert.throws(() => resolveConfig({ maxTokens: 999999 }), /maxTokens cannot exceed 8192/);
  });

  it("validates and rejects invalid model structures", () => {
    assert.throws(() => resolveConfig({ primaryModel: { provider: "" } }), /Invalid primaryModel/);
  });
});
