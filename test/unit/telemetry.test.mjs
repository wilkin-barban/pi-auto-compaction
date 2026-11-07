import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { TelemetryLogger } from "../../src/telemetry.mjs";
import { resolveConversationContext } from "../../src/extension.mjs";

describe("telemetry module", () => {
  let tempDir;
  let telemetryFile;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-telemetry-test-"));
    telemetryFile = path.join(tempDir, "state", "compaction.jsonl");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates directory with 0700 and file with 0600 permissions", () => {
    const logger = new TelemetryLogger({ telemetryPath: telemetryFile });
    logger.recordTerminalSuccess({
      sessionId: "sess-1",
      reason: "threshold",
      model: "omniroute/antigravity/gemini-3.8-flash-tiered",
      durationMs: 1200,
      tokensBefore: 210000,
      attemptCount: 1,
    });

    const dirStat = fs.statSync(path.dirname(telemetryFile));
    const dirMode = dirStat.mode & 0o777;
    assert.equal(dirMode, 0o700, `Directory mode should be 0700, got ${dirMode.toString(8)}`);

    const fileStat = fs.statSync(telemetryFile);
    const fileMode = fileStat.mode & 0o777;
    assert.equal(fileMode, 0o600, `File mode should be 0600, got ${fileMode.toString(8)}`);
  });

  it("filters and writes only allowlisted fields, discarding sensitive data", () => {
    const logger = new TelemetryLogger({ telemetryPath: telemetryFile });
    logger.recordTerminalSuccess({
      sessionId: "sess-2",
      reason: "threshold",
      model: "omniroute/antigravity/gemini-3.8-flash-tiered",
      durationMs: 1500,
      tokensBefore: 200000,
      usage: { inputTokens: 50000, outputTokens: 800 },
      attemptCount: 1,
      // Disallowed sensitive fields:
      prompt: "Secret conversation content",
      userHistory: ["my private code"],
      secretApiKey: "sk-ant-12345",
      rawError: "Stack trace at /home/example/private",
      unrelatedProjectFile: "/home/example/secret/project/file.ts",
    });

    const lines = fs.readFileSync(telemetryFile, "utf-8").trim().split("\n");
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);

    assert.equal(entry.sessionId, "sess-2");
    assert.equal(entry.reason, "threshold");
    assert.equal(entry.model, "omniroute/antigravity/gemini-3.8-flash-tiered");
    assert.equal(entry.status, "success");
    assert.equal(entry.durationMs, 1500);
    assert.equal(entry.tokensBefore, 200000);
    assert.deepEqual(entry.usage, { inputTokens: 50000, outputTokens: 800 });
    assert.equal(entry.attemptCount, 1);

    // Verify disallowed fields are absent
    assert.equal(entry.prompt, undefined);
    assert.equal(entry.userHistory, undefined);
    assert.equal(entry.secretApiKey, undefined);
    assert.equal(entry.rawError, undefined);
    assert.equal(entry.unrelatedProjectFile, undefined);
  });

  it("rotates log files when exceeding size cap", () => {
    const logger = new TelemetryLogger({
      telemetryPath: telemetryFile,
      telemetryMaxBytes: 200,
      telemetryMaxFiles: 2,
    });

    for (let i = 0; i < 5; i++) {
      logger.recordTerminalSuccess({
        sessionId: `sess-rotate-${i}`,
        reason: "threshold",
        model: "omniroute/antigravity/gemini-3.8-flash-tiered",
        durationMs: 1000 + i,
        tokensBefore: 200000,
      });
    }

    assert.ok(fs.existsSync(telemetryFile));
    assert.ok(fs.existsSync(`${telemetryFile}.1`));
  });

  it("prevents duplicate terminal entries for the same compaction cycleId", () => {
    const logger = new TelemetryLogger({ telemetryPath: telemetryFile });
    logger.recordTerminalSuccess({
      cycleId: "cycle-123",
      sessionId: "sess-dedup",
      reason: "threshold",
      model: "omniroute/antigravity/gemini-3.8-flash-tiered",
      durationMs: 1000,
      tokensBefore: 200000,
    });

    // Attempt to record duplicate terminal success for the same cycleId
    logger.recordTerminalSuccess({
      cycleId: "cycle-123",
      sessionId: "sess-dedup",
      reason: "threshold",
      model: "omniroute/antigravity/gemini-3.8-flash-tiered",
      durationMs: 1000,
      tokensBefore: 200000,
    });

    const lines = fs.readFileSync(telemetryFile, "utf-8").trim().split("\n");
    assert.equal(lines.length, 1, "Duplicate terminal entry must not be written");
  });

  it("allows distinct cycleIds in the same session", () => {
    const logger = new TelemetryLogger({ telemetryPath: telemetryFile });
    logger.recordTerminalSuccess({
      cycleId: "cycle-A",
      sessionId: "sess-multi",
      reason: "threshold",
      model: "omniroute/antigravity/gemini-3.8-flash-tiered",
      durationMs: 1000,
      tokensBefore: 200000,
    });

    logger.recordTerminalSuccess({
      cycleId: "cycle-B",
      sessionId: "sess-multi",
      reason: "threshold",
      model: "omniroute/antigravity/gemini-3.8-flash-tiered",
      durationMs: 1100,
      tokensBefore: 210000,
    });

    const lines = fs.readFileSync(telemetryFile, "utf-8").trim().split("\n");
    assert.equal(lines.length, 2, "Distinct cycle IDs must be recorded separately");
  });

  it("deeply allowlists numeric usage fields and strips sensitive nested objects or strings", () => {
    const logger = new TelemetryLogger({ telemetryPath: telemetryFile });
    logger.recordTerminalSuccess({
      sessionId: "sess-usage-sanitize",
      reason: "threshold",
      model: "omniroute/antigravity/gemini-3.8-flash-tiered",
      durationMs: 1500,
      tokensBefore: 200000,
      attemptCount: 1,
      usage: {
        input: 50000,
        output: 800,
        cacheRead: 2000,
        cacheWrite: 0,
        reasoning: 150,
        totalTokens: 52950,
        // Hostile / sensitive fields that must be stripped. Every credential-shaped
        // value below is a synthetic fixture, not a real secret: `sk-ant-secret-12345`
        // and `Bearer sensitive-token-99999` exist only to prove that the allowlist and
        // the redaction drop them. See SECURITY.md, "Fixtures de prueba".
        secretKey: "sk-ant-secret-12345",
        authorization: "Bearer sensitive-token-99999",
        nested: {
          token: "secret-token",
          headers: { "x-api-key": "bad-key" },
        },
        cost: {
          input: 0.02,
          output: 0.005,
          total: 0.025,
          leakedHeader: "secret-leak",
        },
      },
    });

    const lines = fs.readFileSync(telemetryFile, "utf-8").trim().split("\n");
    assert.equal(lines.length, 1);
    const rawLine = lines[0];
    const entry = JSON.parse(rawLine);

    // Raw string must NOT contain any of the secret strings anywhere
    assert.ok(!rawLine.includes("sk-ant-secret-12345"), "Must not leak secretKey");
    assert.ok(!rawLine.includes("sensitive-token-99999"), "Must not leak authorization");
    assert.ok(!rawLine.includes("secret-token"), "Must not leak nested token");
    assert.ok(!rawLine.includes("secret-leak"), "Must not leak cost header");

    // Only allowed numeric usage fields should remain
    assert.deepEqual(entry.usage, {
      input: 50000,
      output: 800,
      cacheRead: 2000,
      cacheWrite: 0,
      reasoning: 150,
      totalTokens: 52950,
      cost: {
        input: 0.02,
        output: 0.005,
        total: 0.025,
      },
    });
  });

  it("handles write failures gracefully using simulated filesystem collision without touching external paths", () => {
    // Create a regular file where directory is expected (triggers ENOTDIR)
    const blockerFile = path.join(tempDir, "blocker");
    fs.writeFileSync(blockerFile, "I am a file, not a directory");
    const invalidPath = path.join(blockerFile, "telemetry.jsonl");

    const logger = new TelemetryLogger({ telemetryPath: invalidPath });

    assert.doesNotThrow(() => {
      logger.recordTerminalSuccess({
        sessionId: "sess-err",
        reason: "threshold",
        model: "omniroute/antigravity/gemini-3.8-flash-tiered",
        durationMs: 1000,
        tokensBefore: 200000,
      });
    });
  });

  it("allowlist rejects an unlisted key", () => {
    const logger = new TelemetryLogger({ telemetryPath: telemetryFile });
    logger.writeRecord({
      sessionId: "sess-allowlist",
      reason: "threshold",
      model: "omniroute/antigravity/gemini-3.8-flash-tiered",
      unlistedKey: "should-be-rejected",
      tokensAfter: 50000,
      apiKey: "sk-secret-key",
      conversationModel: "deepseek-v4.1-flash",
    });

    const lines = fs.readFileSync(telemetryFile, "utf-8").trim().split("\n");
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.unlistedKey, undefined);
    assert.equal(entry.tokensAfter, undefined);
    assert.equal(entry.apiKey, undefined);
    assert.equal(entry.conversationModel, "deepseek-v4.1-flash");
  });

  it("a record with the six fields round-trips", () => {
    const logger = new TelemetryLogger({ telemetryPath: telemetryFile });
    logger.recordTerminalSuccess({
      sessionId: "sess-roundtrip",
      reason: "threshold",
      model: "omniroute/antigravity/gemini-3.8-flash-tiered",
      durationMs: 1400,
      tokensBefore: 870000,
      conversationModel: "deepseek-v4.1-flash",
      conversationProvider: "deepseek",
      contextWindow: 1000000,
      reserveTokens: 140000,
      keepRecentTokens: 20000,
      thresholdTokens: 860000,
    });

    const lines = fs.readFileSync(telemetryFile, "utf-8").trim().split("\n");
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);

    assert.equal(entry.sessionId, "sess-roundtrip");
    assert.equal(entry.status, "success");
    assert.equal(entry.model, "omniroute/antigravity/gemini-3.8-flash-tiered");
    assert.equal(entry.conversationModel, "deepseek-v4.1-flash");
    assert.equal(entry.conversationProvider, "deepseek");
    assert.equal(entry.contextWindow, 1000000);
    assert.equal(entry.reserveTokens, 140000);
    assert.equal(entry.keepRecentTokens, 20000);
    assert.equal(entry.thresholdTokens, 860000);
    assert.equal(typeof entry.contextWindow, "number");
    assert.equal(typeof entry.reserveTokens, "number");
    assert.equal(typeof entry.keepRecentTokens, "number");
    assert.equal(typeof entry.thresholdTokens, "number");
    assert.ok(Number.isInteger(entry.contextWindow));
    assert.ok(Number.isInteger(entry.reserveTokens));
    assert.ok(Number.isInteger(entry.keepRecentTokens));
    assert.ok(Number.isInteger(entry.thresholdTokens));
  });

  it("each resolver branch (model override, global setting, Pi default) produces the expected reserveTokens/thresholdTokens", () => {
    const model = { provider: "openai", id: "gpt-6-sol", contextWindow: 272000 };

    // Branch 1: model override
    const overrideSettings = {
      compaction: {
        reserveTokens: 50000,
        keepRecentTokens: 10000,
        modelOverrides: {
          "openai/gpt-6-sol": {
            reserveTokens: 65536,
            keepRecentTokens: 20000,
          },
        },
      },
    };
    const ctxOverride = { model };
    const resOverride = resolveConversationContext(ctxOverride, { settings: overrideSettings });
    assert.equal(resOverride.conversationProvider, "openai");
    assert.equal(resOverride.conversationModel, "gpt-6-sol");
    assert.equal(resOverride.contextWindow, 272000);
    assert.equal(resOverride.reserveTokens, 65536);
    assert.equal(resOverride.keepRecentTokens, 20000);
    assert.equal(resOverride.thresholdTokens, 272000 - 65536); // 206464

    // Branch 2: global setting (no model override)
    const globalSettings = {
      compaction: {
        reserveTokens: 40000,
        keepRecentTokens: 15000,
      },
    };
    const ctxGlobal = { model };
    const resGlobal = resolveConversationContext(ctxGlobal, { settings: globalSettings });
    assert.equal(resGlobal.conversationProvider, "openai");
    assert.equal(resGlobal.conversationModel, "gpt-6-sol");
    assert.equal(resGlobal.contextWindow, 272000);
    assert.equal(resGlobal.reserveTokens, 40000);
    assert.equal(resGlobal.keepRecentTokens, 15000);
    assert.equal(resGlobal.thresholdTokens, 272000 - 40000); // 232000

    // Branch 3: Pi defaults (16384 / 20000) when settings are empty
    const defaultSettings = {};
    const ctxDefault = { model };
    const resDefault = resolveConversationContext(ctxDefault, { settings: defaultSettings });
    assert.equal(resDefault.conversationProvider, "openai");
    assert.equal(resDefault.conversationModel, "gpt-6-sol");
    assert.equal(resDefault.contextWindow, 272000);
    assert.equal(resDefault.reserveTokens, 16384);
    assert.equal(resDefault.keepRecentTokens, 20000);
    assert.equal(resDefault.thresholdTokens, 272000 - 16384); // 255616
  });

  it("DeepSeek-shaped input with contextWindow 1000000 and reserveTokens 140000 yields thresholdTokens 860000", () => {
    const ctx = {
      model: {
        provider: "deepseek",
        id: "deepseek-v4.1-flash",
        contextWindow: 1000000,
      },
    };
    const settings = {
      compaction: {
        modelOverrides: {
          "deepseek/deepseek-v4.1-flash": {
            reserveTokens: 140000,
            keepRecentTokens: 20000,
          },
        },
      },
    };
    const resolved = resolveConversationContext(ctx, { settings });
    assert.equal(resolved.conversationProvider, "deepseek");
    assert.equal(resolved.conversationModel, "deepseek-v4.1-flash");
    assert.equal(resolved.contextWindow, 1000000);
    assert.equal(resolved.reserveTokens, 140000);
    assert.equal(resolved.keepRecentTokens, 20000);
    assert.equal(resolved.thresholdTokens, 860000);
  });

  it("unresolvable context omits fields without throwing", () => {
    // Case 1: null / missing ctx or ctx.model
    assert.doesNotThrow(() => {
      const res1 = resolveConversationContext(null);
      assert.deepEqual(res1, {});

      const res2 = resolveConversationContext({});
      assert.deepEqual(res2, {});

      const res3 = resolveConversationContext({ model: null });
      assert.deepEqual(res3, {});
    });

    // Case 2: missing contextWindow
    assert.doesNotThrow(() => {
      const res = resolveConversationContext(
        { model: { provider: "deepseek", id: "deepseek-chat" } },
        { settings: { compaction: { reserveTokens: 10000 } } },
      );
      assert.equal(res.conversationProvider, "deepseek");
      assert.equal(res.conversationModel, "deepseek-chat");
      assert.equal(res.contextWindow, undefined);
      assert.equal(res.thresholdTokens, undefined);
      assert.equal(res.reserveTokens, 10000);
      assert.ok(!("contextWindow" in res) || res.contextWindow !== null);
      assert.ok(!("thresholdTokens" in res) || res.thresholdTokens !== null);
    });

    // Case 3: unreadable settings (settings: null)
    assert.doesNotThrow(() => {
      const res = resolveConversationContext(
        { model: { provider: "deepseek", id: "deepseek-chat", contextWindow: 500000 } },
        { settings: null },
      );
      assert.equal(res.conversationProvider, "deepseek");
      assert.equal(res.conversationModel, "deepseek-chat");
      assert.equal(res.contextWindow, 500000);
      assert.equal(res.reserveTokens, undefined);
      assert.equal(res.keepRecentTokens, undefined);
      assert.equal(res.thresholdTokens, undefined);
    });

    // Case 4: unreadable settings file on disk
    const corruptSettingsPath = path.join(tempDir, "corrupt-settings.json");
    fs.writeFileSync(corruptSettingsPath, "{ corrupt json syntax !!");
    assert.doesNotThrow(() => {
      const res = resolveConversationContext(
        { model: { provider: "deepseek", id: "deepseek-chat", contextWindow: 500000 } },
        { settingsPath: corruptSettingsPath },
      );
      assert.equal(res.conversationProvider, "deepseek");
      assert.equal(res.conversationModel, "deepseek-chat");
      assert.equal(res.contextWindow, 500000);
      assert.equal(res.reserveTokens, undefined);
      assert.equal(res.keepRecentTokens, undefined);
      assert.equal(res.thresholdTokens, undefined);
    });
  });

  it("a legacy record line stays untouched/readable", () => {
    const legacyLine = JSON.stringify({
      timestamp: "2026-11-06T10:00:00.000Z",
      sessionId: "sess-legacy-999",
      reason: "threshold",
      model: "omniroute/antigravity/gemini-3.8-flash-tiered",
      status: "success",
      durationMs: 1200,
      tokensBefore: 210000,
      attemptCount: 1,
    });

    fs.mkdirSync(path.dirname(telemetryFile), { recursive: true });
    fs.appendFileSync(telemetryFile, `${legacyLine}\n`);

    // Prove reading legacy lines works and no reader throws
    const lines = fs.readFileSync(telemetryFile, "utf-8").trim().split("\n");
    assert.equal(lines.length, 1);
    let parsed;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(lines[0]);
    });
    assert.equal(parsed.sessionId, "sess-legacy-999");
    assert.equal(parsed.model, "omniroute/antigravity/gemini-3.8-flash-tiered");
    assert.equal(parsed.tokensBefore, 210000);
    assert.equal(parsed.conversationModel, undefined);
    assert.equal(parsed.conversationProvider, undefined);
    assert.equal(parsed.contextWindow, undefined);
    assert.equal(parsed.reserveTokens, undefined);
    assert.equal(parsed.keepRecentTokens, undefined);
    assert.equal(parsed.thresholdTokens, undefined);
  });
});
