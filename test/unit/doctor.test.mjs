import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { runDoctor } from "../../scripts/doctor.mjs";
import {
  MANAGED_POLICIES,
  MANAGED_MODELS,
  MANIFEST_FILENAME,
  expectedLoaderContent,
  buildManifest,
  captureModelBaseline,
} from "../../src/install-state.mjs";

function hash(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function captureTreeSnapshot(dir) {
  if (!fs.existsSync(dir)) return {};
  const snapshot = {};
  function walk(current) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      const relPath = path.relative(dir, fullPath);
      const stat = fs.lstatSync(fullPath);
      if (entry.isDirectory()) {
        snapshot[relPath] = {
          type: "directory",
          mode: stat.mode,
          mtimeMs: stat.mtimeMs,
        };
        walk(fullPath);
      } else if (entry.isFile()) {
        const bytes = fs.readFileSync(fullPath);
        snapshot[relPath] = {
          type: "file",
          size: stat.size,
          mode: stat.mode,
          mtimeMs: stat.mtimeMs,
          sha256: hash(bytes),
        };
      }
    }
  }
  walk(dir);
  return snapshot;
}

describe("doctor module", () => {
  let tempRoot;
  let agentDir;
  let installDir;
  let telemetryDir;
  let telemetryFile;
  let loaderPath;
  let manifestPath;
  let markerPath;
  let settingsPath;
  let releaseDir;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-test-"));
    agentDir = path.join(tempRoot, "agent");
    installDir = path.join(tempRoot, "managed");
    telemetryDir = path.join(tempRoot, "telemetry-state");
    telemetryFile = path.join(telemetryDir, "compaction.jsonl");

    fs.mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
    fs.mkdirSync(installDir, { recursive: true });
    fs.mkdirSync(telemetryDir, { recursive: true });

    loaderPath = path.join(agentDir, "extensions", "omniroute-compaction.ts");
    manifestPath = path.join(agentDir, MANIFEST_FILENAME);
    markerPath = path.join(installDir, ".pi-auto-compaction-deploy.json");
    settingsPath = path.join(agentDir, "settings.json");

    const releaseHash = hash("dummy-release-content");
    releaseDir = path.join(installDir, "releases", releaseHash);
    fs.mkdirSync(releaseDir, { recursive: true });
    fs.writeFileSync(
      path.join(releaseDir, ".release.json"),
      JSON.stringify({ version: 1, hash: releaseHash, files: [] }),
    );

    const loaderContent = expectedLoaderContent(releaseDir);
    fs.writeFileSync(loaderPath, loaderContent);

    const originalOverrides = {};
    for (const m of MANAGED_MODELS) {
      originalOverrides[m] = captureModelBaseline({}, m);
    }
    const manifestData = buildManifest({
      installedAt: new Date().toISOString(),
      packageSourceDir: releaseDir,
      loaderPath,
      loaderHash: hash(loaderContent),
      originalOverrides,
    });
    fs.writeFileSync(manifestPath, JSON.stringify(manifestData, null, 2));

    const markerData = {
      kind: "pi-auto-compaction-deploy",
      version: 1,
      installDir,
      agentDir,
      state: "ready",
      current: { hash: releaseHash, path: releaseDir },
      previous: null,
      pending: null,
    };
    fs.writeFileSync(markerPath, JSON.stringify(markerData, null, 2));

    fs.writeFileSync(
      telemetryFile,
      JSON.stringify({
        timestamp: "2026-11-06T10:00:00.000Z",
        sessionId: "sess-abc-123",
        reason: "threshold",
        model: "omniroute/antigravity/gemini-3.8-flash-tiered",
        status: "success",
        durationMs: 1420,
        tokensBefore: 215000,
        usage: { inputTokens: 52000, outputTokens: 850 },
        attemptCount: 1,
        conversationModel: "deepseek-v4.1-flash",
        conversationProvider: "commandcode",
        contextWindow: 1000000,
        reserveTokens: 140000,
        keepRecentTokens: 20000,
        thresholdTokens: 860000,
      }) + "\n",
    );
  });

  afterEach(() => {
    if (tempRoot && fs.existsSync(tempRoot)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("DeepSeek with an 860000 override reports ~14% and warns", () => {
    const settings = {
      compaction: {
        modelOverrides: {
          "commandcode/deepseek/deepseek-v4.1-flash": {
            reserveTokens: 860000,
            keepRecentTokens: 20000,
          },
        },
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    const result = runDoctor({
      agentDir,
      installDir,
      telemetryPath: telemetryFile,
      model: "commandcode/deepseek/deepseek-v4.1-flash",
    });

    assert.equal(result.exitCode, 1, "Exit code must be 1 for warnings");
    assert.equal(result.healthy, false);
    assert.ok(result.model, "Must contain selected model diagnostics");
    assert.equal(result.model.model, "commandcode/deepseek/deepseek-v4.1-flash");
    assert.equal(result.model.contextWindow, 1000000);
    assert.equal(result.model.reserveTokens, 860000);
    assert.equal(result.model.keepRecentTokens, 20000);
    assert.equal(result.model.triggerAt, 140000);
    assert.equal(Math.round(result.model.triggerPercent), 14);
    assert.equal(result.model.reserveTokensOrigin, "model-override");
    assert.equal(result.model.isManaged, true);

    const warningFound = result.warnings.some(
      (w) => w.includes("commandcode/deepseek/deepseek-v4.1-flash") && w.includes("managed policy"),
    );
    assert.ok(warningFound, `Expected warning about DeepSeek policy mismatch, got: ${JSON.stringify(result.warnings)}`);
  });

  it("DeepSeek with the managed 140000 policy reports ~86% and is healthy", () => {
    const settings = {
      compaction: {
        modelOverrides: {
          "commandcode/deepseek/deepseek-v4.1-flash": {
            reserveTokens: 140000,
            keepRecentTokens: 20000,
          },
        },
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    const result = runDoctor({
      agentDir,
      installDir,
      telemetryPath: telemetryFile,
      model: "commandcode/deepseek/deepseek-v4.1-flash",
    });

    assert.equal(result.exitCode, 0, `Expected exit code 0, got ${result.exitCode} with warnings: ${JSON.stringify(result.warnings)}`);
    assert.equal(result.healthy, true);
    assert.ok(result.model);
    assert.equal(result.model.contextWindow, 1000000);
    assert.equal(result.model.reserveTokens, 140000);
    assert.equal(result.model.triggerAt, 860000);
    assert.equal(Math.round(result.model.triggerPercent), 86);
    assert.equal(result.warnings.length, 0);
  });

  it("an unmanaged model override warns", () => {
    const settings = {
      compaction: {
        modelOverrides: {
          "custom-provider/unmanaged-llm": {
            reserveTokens: 30000,
            keepRecentTokens: 10000,
          },
        },
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    const result = runDoctor({
      agentDir,
      installDir,
      telemetryPath: telemetryFile,
      model: "custom-provider/unmanaged-llm",
    });

    assert.equal(result.exitCode, 1, "Exit code must be 1 when unmanaged model override exists");
    assert.equal(result.healthy, false);
    assert.equal(result.model.isManaged, false);
    const unmanagedWarn = result.warnings.some(
      (w) => w.includes("custom-provider/unmanaged-llm") && w.includes("unmanaged"),
    );
    assert.ok(unmanagedWarn, `Expected unmanaged override warning, got: ${JSON.stringify(result.warnings)}`);
  });

  it("a loader whose hash does not match the manifest fails with exit 2", () => {
    fs.writeFileSync(loaderPath, "// Tampered loader content\nexport default function() {}");
    const settings = {};
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    const result = runDoctor({
      agentDir,
      installDir,
      telemetryPath: telemetryFile,
    });

    assert.equal(result.exitCode, 2, "Exit code must be 2 for state/hash errors");
    assert.equal(result.healthy, false);
    assert.equal(result.loader.matchesManifest, false);
    const hashError = result.errors.some(
      (e) => e.includes("hash mismatch") || e.includes("loaderHash"),
    );
    assert.ok(hashError, `Expected loader hash mismatch error, got: ${JSON.stringify(result.errors)}`);
  });

  it("assert the doctor wrote nothing (compare fixture tree hashes/mtimes before and after)", () => {
    const settings = {
      compaction: {
        modelOverrides: {
          "commandcode/deepseek/deepseek-v4.1-flash": {
            reserveTokens: 140000,
            keepRecentTokens: 20000,
          },
        },
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    const beforeSnapshot = captureTreeSnapshot(tempRoot);

    const result = runDoctor({
      agentDir,
      installDir,
      telemetryPath: telemetryFile,
      model: "commandcode/deepseek/deepseek-v4.1-flash",
    });

    assert.equal(result.exitCode, 0);

    const afterSnapshot = captureTreeSnapshot(tempRoot);
    assert.deepEqual(
      afterSnapshot,
      beforeSnapshot,
      "Doctor must not create, modify, or delete any files or directories (mtime, size, and hash identical)",
    );
  });

  it("CLI prints only JSON when invoked with --json", () => {
    const settings = {
      compaction: {
        modelOverrides: {
          "commandcode/deepseek/deepseek-v4.1-flash": {
            reserveTokens: 140000,
            keepRecentTokens: 20000,
          },
        },
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    const doctorScript = path.resolve("scripts/doctor.mjs");
    const proc = spawnSync(
      process.execPath,
      [
        doctorScript,
        "--agent-dir",
        agentDir,
        "--install-dir",
        installDir,
        "--model",
        "commandcode/deepseek/deepseek-v4.1-flash",
        "--json",
      ],
      { encoding: "utf8" },
    );

    assert.equal(proc.status, 0, `CLI failed with stderr: ${proc.stderr}`);
    assert.equal(proc.stderr, "", "No stderr should be emitted on success");

    let parsed;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(proc.stdout);
    }, `stdout must be pure JSON, received: ${proc.stdout}`);

    assert.equal(parsed.exitCode, 0);
    assert.equal(parsed.healthy, true);
    assert.equal(parsed.model.model, "commandcode/deepseek/deepseek-v4.1-flash");
  });

  it("resolves contextWindow from local models.json when present", () => {
    const modelsConfigFile = path.join(agentDir, "models.json");
    fs.writeFileSync(
      modelsConfigFile,
      JSON.stringify({
        providers: {
          mycustom: {
            models: [
              {
                id: "custom-model-x",
                contextWindow: 512000,
              },
            ],
          },
        },
      }),
    );

    const settings = {
      compaction: {
        modelOverrides: {
          "mycustom/custom-model-x": {
            reserveTokens: 50000,
            keepRecentTokens: 20000,
          },
        },
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    const result = runDoctor({
      agentDir,
      installDir,
      telemetryPath: telemetryFile,
      model: "mycustom/custom-model-x",
    });

    assert.equal(result.model.contextWindow, 512000);
    assert.equal(result.model.contextWindowOrigin, "models.json");
    assert.equal(result.model.triggerAt, 462000);
  });

  it("reports telemetry metadata without exposing private content", () => {
    const settings = {};
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    const result = runDoctor({
      agentDir,
      installDir,
      telemetryPath: telemetryFile,
    });

    assert.ok(result.telemetry);
    assert.equal(result.telemetry.exists, true);
    assert.ok(result.telemetry.sizeBytes > 0);
    assert.ok(result.telemetry.lastRecord);
    assert.equal(result.telemetry.lastRecord.sessionId, "sess-abc-123");
    assert.equal(result.telemetry.lastRecord.tokensBefore, 215000);
    assert.equal(result.telemetry.lastRecord.contextWindow, 1000000);
    // Ensure no sensitive fields
    assert.equal(result.telemetry.lastRecord.prompt, undefined);
    assert.equal(result.telemetry.lastRecord.conversation, undefined);
  });

  it("resolves token origins correctly across compaction-setting and pi-default", () => {
    // Case 1: compaction-setting
    const settingsGlobal = {
      compaction: {
        reserveTokens: 32000,
        keepRecentTokens: 15000,
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(settingsGlobal, null, 2));

    const resultGlobal = runDoctor({
      agentDir,
      installDir,
      telemetryPath: telemetryFile,
      model: "commandcode/deepseek/deepseek-v4.1-flash",
    });

    assert.equal(resultGlobal.model.reserveTokens, 32000);
    assert.equal(resultGlobal.model.reserveTokensOrigin, "compaction-setting");
    assert.equal(resultGlobal.model.keepRecentTokens, 15000);
    assert.equal(resultGlobal.model.keepRecentTokensOrigin, "compaction-setting");

    // Case 2: pi-default
    const settingsDefault = {};
    fs.writeFileSync(settingsPath, JSON.stringify(settingsDefault, null, 2));

    const resultDefault = runDoctor({
      agentDir,
      installDir,
      telemetryPath: telemetryFile,
      model: "commandcode/deepseek/deepseek-v4.1-flash",
    });

    assert.equal(resultDefault.model.reserveTokens, 16384);
    assert.equal(resultDefault.model.reserveTokensOrigin, "pi-default");
    assert.equal(resultDefault.model.keepRecentTokens, 20000);
    assert.equal(resultDefault.model.keepRecentTokensOrigin, "pi-default");
  });

  it("resolves Gemini and OpenAI fallbacks and evaluates trigger percent", () => {
    const settings = {
      compaction: {
        modelOverrides: {
          "omniroute/antigravity/gemini-3.8-flash-tiered": {
            reserveTokens: 200000,
            keepRecentTokens: 20000,
          },
          "openai-codex/gpt-6-sol": {
            reserveTokens: 65536,
            keepRecentTokens: 20000,
          },
        },
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    const gemini = runDoctor({
      agentDir,
      installDir,
      telemetryPath: telemetryFile,
      model: "omniroute/antigravity/gemini-3.8-flash-tiered",
    });
    assert.equal(gemini.model.contextWindow, 1048576);
    assert.equal(gemini.model.triggerAt, 848576);
    assert.equal(gemini.exitCode, 0);

    const openai = runDoctor({
      agentDir,
      installDir,
      telemetryPath: telemetryFile,
      model: "openai-codex/gpt-6-sol",
    });
    assert.equal(openai.model.contextWindow, 400000);
    assert.equal(openai.model.triggerAt, 334464);
    assert.equal(openai.exitCode, 0);
  });

  it("fails with exit 2 when deploy marker is in pending state", () => {
    const pendingMarker = {
      kind: "pi-auto-compaction-deploy",
      version: 1,
      installDir,
      agentDir,
      state: "pending",
      current: null,
      previous: null,
    };
    fs.writeFileSync(markerPath, JSON.stringify(pendingMarker, null, 2));

    const result = runDoctor({
      agentDir,
      installDir,
      telemetryPath: telemetryFile,
    });

    assert.equal(result.exitCode, 2);
    assert.equal(result.healthy, false);
    assert.ok(result.errors.some((e) => e.includes("pending")));
  });

  it("CLI returns exit code 1 with JSON when warnings are present", () => {
    const settings = {
      compaction: {
        modelOverrides: {
          "commandcode/deepseek/deepseek-v4.1-flash": {
            reserveTokens: 860000,
            keepRecentTokens: 20000,
          },
        },
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    const doctorScript = path.resolve("scripts/doctor.mjs");
    const proc = spawnSync(
      process.execPath,
      [
        doctorScript,
        "--agent-dir",
        agentDir,
        "--install-dir",
        installDir,
        "--model",
        "commandcode/deepseek/deepseek-v4.1-flash",
        "--json",
      ],
      { encoding: "utf8" },
    );

    assert.equal(proc.status, 1, "CLI must exit with code 1 when warnings exist");
    const parsed = JSON.parse(proc.stdout);
    assert.equal(parsed.exitCode, 1);
    assert.equal(parsed.healthy, false);
    assert.ok(parsed.warnings.length > 0);
  });

  it("deploy script allows and packages scripts/doctor.mjs in real repo source", async () => {
    const { runDeploy } = await import("../../scripts/deploy.mjs");
    const deployHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deploy-doctor-test-"));
    try {
      const deployAgent = path.join(deployHome, "agent");
      const deployInstall = path.join(deployHome, "managed");
      const result = runDeploy({
        agentDir: deployAgent,
        installDir: deployInstall,
        dryRun: true,
      });
      assert.equal(result.success, true);
      assert.equal(result.dryRun, true);
      assert.ok(result.releaseDir);
    } finally {
      fs.rmSync(deployHome, { recursive: true, force: true });
    }
  });
  describe("summarizer section", () => {
    const summarizerPath = () => path.join(agentDir, ".pi-auto-compaction-settings.json");

    function writeSummarizer(settings) {
      fs.writeFileSync(summarizerPath(), JSON.stringify(settings, null, 2), { mode: 0o600 });
    }

    function baseOptions() {
      return { agentDir, installDir, telemetryPath: telemetryFile, settingsPath: summarizerPath() };
    }

    it("reports defaults with no settings file", () => {
      const result = runDoctor(baseOptions());

      assert.equal(result.summarizer.exists, false);
      assert.equal(result.summarizer.valid, true);
      assert.equal(result.summarizer.source, "default");
      assert.deepEqual(
        { provider: result.summarizer.primary.provider, modelId: result.summarizer.primary.modelId },
        { provider: "omniroute", modelId: "antigravity/gemini-3.8-flash-tiered" },
      );
      assert.deepEqual(result.summarizer.warnings, []);
    });

    it("reports the configured models with their origin and catalog data", () => {
      fs.writeFileSync(
        path.join(agentDir, "models.json"),
        JSON.stringify({
          providers: {
            antigravity: {
              models: [
                { id: "gemini-3.8-flash-tiered", contextWindow: 1048576, maxTokens: 65536 },
                { id: "gemini-3.6-flash-high", contextWindow: 1048576, maxTokens: 65536 },
              ],
            },
          },
        }),
      );
      writeSummarizer({
        version: 1,
        primary: { provider: "antigravity", modelId: "gemini-3.8-flash-tiered" },
        fallback: { provider: "antigravity", modelId: "gemini-3.6-flash-high" },
      });

      const result = runDoctor(baseOptions());

      assert.equal(result.summarizer.exists, true);
      assert.equal(result.summarizer.valid, true);
      assert.equal(result.summarizer.source, "file");
      assert.equal(result.summarizer.primary.source, "file");
      assert.equal(result.summarizer.primary.catalog, "models.json");
      assert.equal(result.summarizer.primary.contextWindow, 1048576);
      assert.equal(result.summarizer.primary.maxTokens, 65536);
      assert.equal(result.summarizer.fallback.modelId, "gemini-3.6-flash-high");
      assert.deepEqual(result.summarizer.warnings, []);
    });

    it("warns about a corrupt settings file without throwing", () => {
      fs.writeFileSync(summarizerPath(), "{ roto", { mode: 0o600 });

      const result = runDoctor(baseOptions());

      assert.equal(result.summarizer.valid, false);
      assert.equal(result.summarizer.source, "default");
      assert.ok(
        result.summarizer.warnings.some((warning) => /Failed to load summarizer settings/.test(warning)),
      );
      assert.equal(result.exitCode, 1);
    });

    it("warns when a configured model is absent from every catalog", () => {
      writeSummarizer({ version: 1, primary: { provider: "ghost", modelId: "ghost-model" } });

      const result = runDoctor(baseOptions());

      assert.ok(result.summarizer.warnings.some((warning) => /was not found in/.test(warning)));
      assert.equal(result.exitCode, 1);
    });

    it("warns about a small context window", () => {
      fs.writeFileSync(
        path.join(agentDir, "models.json"),
        JSON.stringify({ providers: { local: { models: [{ id: "tiny", contextWindow: 16384 }] } } }),
      );
      writeSummarizer({
        version: 1,
        primary: { provider: "local", modelId: "tiny" },
        fallback: { provider: "local", modelId: "tiny-backup" },
      });

      const result = runDoctor(baseOptions());

      assert.ok(result.summarizer.warnings.some((warning) => /small context window/.test(warning)));
    });

    it("reports an env override as the effective origin", () => {
      const result = runDoctor(baseOptions(), {
        env: {
          PI_AUTO_COMPACTION_PRIMARY_PROVIDER: "commandcode",
          PI_AUTO_COMPACTION_PRIMARY_MODEL: "deepseek/deepseek-v4.1-flash",
        },
      });

      assert.equal(result.summarizer.primary.source, "env");
      assert.equal(result.summarizer.primary.modelId, "deepseek/deepseek-v4.1-flash");
    });

    it("stays read-only with a valid settings file", () => {
      writeSummarizer({
        version: 1,
        primary: { provider: "antigravity", modelId: "gemini-3.8-flash-tiered" },
      });

      const before = captureTreeSnapshot(agentDir);
      runDoctor(baseOptions());
      const after = captureTreeSnapshot(agentDir);

      assert.deepEqual(after, before);
    });
  });
});
