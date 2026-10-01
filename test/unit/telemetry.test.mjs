import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { TelemetryLogger } from "../../src/telemetry.mjs";

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
      rawError: "Stack trace at /home/wilkin/private",
      unrelatedProjectFile: "/home/wilkin/secret/project/file.ts",
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
        // Hostile / sensitive fields that must be stripped:
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
});
