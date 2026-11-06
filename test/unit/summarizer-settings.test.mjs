import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  DEFAULT_SUMMARIZER_SETTINGS,
  DEFAULT_EFFECTIVE_SUMMARIZER,
  resolveSettingsPath,
  parseSettings,
  readSettings,
  writeSettings,
  applyEnvOverrides,
  resolveSummarizerSettings,
} from "../../src/summarizer-settings.mjs";

describe("summarizer-settings module", () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-settings-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("DEFAULT_SUMMARIZER_SETTINGS and DEFAULT_EFFECTIVE_SUMMARIZER", () => {
    it("exports frozen default settings representing not configured", () => {
      assert.ok(Object.isFrozen(DEFAULT_SUMMARIZER_SETTINGS));
      assert.deepEqual(DEFAULT_SUMMARIZER_SETTINGS, {
        version: 1,
        primary: null,
        fallback: null,
      });
    });

    it("exports frozen default effective summarizer matching config primary/fallback shape", () => {
      assert.ok(Object.isFrozen(DEFAULT_EFFECTIVE_SUMMARIZER));
      assert.ok(Object.isFrozen(DEFAULT_EFFECTIVE_SUMMARIZER.primary));
      assert.ok(Object.isFrozen(DEFAULT_EFFECTIVE_SUMMARIZER.fallback));
      assert.deepEqual(DEFAULT_EFFECTIVE_SUMMARIZER.primary, {
        provider: "omniroute",
        modelId: "antigravity/gemini-3.8-flash-tiered",
      });
      assert.deepEqual(DEFAULT_EFFECTIVE_SUMMARIZER.fallback, {
        provider: "omniroute",
        modelId: "antigravity/gemini-3.6-flash-high",
      });
    });
  });

  describe("resolveSettingsPath", () => {
    it("respects explicit options.settingsPath as highest priority", () => {
      const explicit = path.join(tempDir, "custom.json");
      const resolved = resolveSettingsPath({
        settingsPath: explicit,
        env: {
          PI_AUTO_COMPACTION_SETTINGS_PATH: "/env/path.json",
          PI_CODING_AGENT_DIR: "/env/agent",
        },
      });
      assert.equal(resolved, path.resolve(explicit));
    });

    it("respects env PI_AUTO_COMPACTION_SETTINGS_PATH when option is not provided", () => {
      const envPath = path.join(tempDir, "env-compaction.json");
      const resolved = resolveSettingsPath({
        env: {
          PI_AUTO_COMPACTION_SETTINGS_PATH: envPath,
          PI_CODING_AGENT_DIR: "/env/agent",
        },
      });
      assert.equal(resolved, path.resolve(envPath));
    });

    it("resolves to PI_CODING_AGENT_DIR/.pi-auto-compaction-settings.json when set", () => {
      const agentDir = path.join(tempDir, "agent-dir");
      const resolved = resolveSettingsPath({
        env: {
          PI_CODING_AGENT_DIR: agentDir,
        },
      });
      assert.equal(resolved, path.resolve(agentDir, ".pi-auto-compaction-settings.json"));
    });

    it("resolves to agentDir option when provided", () => {
      const agentDir = path.join(tempDir, "custom-agent");
      const resolved = resolveSettingsPath({
        agentDir,
        env: {},
      });
      assert.equal(resolved, path.resolve(agentDir, ".pi-auto-compaction-settings.json"));
    });

    it("falls back to $HOME/.pi/agent/.pi-auto-compaction-settings.json by default", () => {
      const resolved = resolveSettingsPath({ env: {} });
      const expected = path.resolve(os.homedir(), ".pi", "agent", ".pi-auto-compaction-settings.json");
      assert.equal(resolved, expected);
    });
  });

  describe("parseSettings", () => {
    it("parses a valid settings object with primary and fallback", () => {
      const valid = {
        version: 1,
        primary: { provider: "antigravity", modelId: "gemini-3.8-flash-tiered" },
        fallback: { provider: "antigravity", modelId: "gemini-3.6-flash-high" },
      };
      const parsed = parseSettings(valid);
      assert.deepEqual(parsed, valid);
    });

    it("parses valid JSON string input", () => {
      const jsonStr = JSON.stringify({
        version: 1,
        primary: { provider: "openai", modelId: "gpt-4o" },
      });
      const parsed = parseSettings(jsonStr);
      assert.equal(parsed.version, 1);
      assert.deepEqual(parsed.primary, { provider: "openai", modelId: "gpt-4o" });
      assert.equal(parsed.fallback, null);
    });

    it("accepts absent primary or fallback (null or omitted)", () => {
      assert.deepEqual(parseSettings({ version: 1 }), {
        version: 1,
        primary: null,
        fallback: null,
      });
      assert.deepEqual(parseSettings({ version: 1, primary: null, fallback: null }), {
        version: 1,
        primary: null,
        fallback: null,
      });
    });

    it("rejects corrupt JSON", () => {
      assert.throws(
        () => parseSettings("{ not valid json:"),
        /Invalid JSON in summarizer settings/
      );
    });

    it("rejects non-object settings input", () => {
      assert.throws(() => parseSettings(null), /must be an object/);
      assert.throws(() => parseSettings([]), /must be an object/);
      assert.throws(() => parseSettings(42), /must be an object/);
    });

    it("rejects wrong version numbers or non-number versions", () => {
      assert.throws(
        () => parseSettings({ version: 2 }),
        /Invalid settings version: expected 1, got 2/
      );
      assert.throws(
        () => parseSettings({ version: "1" }),
        /Invalid settings version: expected 1, got "1"/
      );
      assert.throws(
        () => parseSettings({}),
        /Invalid settings version: expected 1, got undefined/
      );
    });

    it("rejects unknown top-level keys", () => {
      assert.throws(
        () => parseSettings({ version: 1, extraKey: true }),
        /Unknown key in summarizer settings: "extraKey"/
      );
    });

    it("rejects unknown keys inside primary or fallback", () => {
      assert.throws(
        () =>
          parseSettings({
            version: 1,
            primary: { provider: "p", modelId: "m", unknownField: 123 },
          }),
        /Unknown key in primary: "unknownField"/
      );
      assert.throws(
        () =>
          parseSettings({
            version: 1,
            fallback: { provider: "p", modelId: "m", bogus: "yes" },
          }),
        /Unknown key in fallback: "bogus"/
      );
    });

    it("rejects empty strings for provider or modelId", () => {
      assert.throws(
        () =>
          parseSettings({
            version: 1,
            primary: { provider: "", modelId: "m" },
          }),
        /primary\.provider must be a non-empty string/
      );
      assert.throws(
        () =>
          parseSettings({
            version: 1,
            primary: { provider: "   ", modelId: "m" },
          }),
        /primary\.provider must be a non-empty string/
      );
      assert.throws(
        () =>
          parseSettings({
            version: 1,
            fallback: { provider: "p", modelId: "" },
          }),
        /fallback\.modelId must be a non-empty string/
      );
    });

    it("rejects a modelId or provider that is not a string", () => {
      assert.throws(
        () =>
          parseSettings({
            version: 1,
            primary: { provider: "p", modelId: 12345 },
          }),
        /primary\.modelId must be a string/
      );
      assert.throws(
        () =>
          parseSettings({
            version: 1,
            primary: { provider: 99, modelId: "m" },
          }),
        /primary\.provider must be a string/
      );
      assert.throws(
        () =>
          parseSettings({
            version: 1,
            fallback: { provider: "p", modelId: null },
          }),
        /fallback\.modelId must be a string/
      );
    });
  });

  describe("readSettings", () => {
    it("returns default settings without warning when file is missing", () => {
      const missingPath = path.join(tempDir, "missing.json");
      const result = readSettings({ settingsPath: missingPath });

      assert.equal(result.source, "default");
      assert.deepEqual(result.settings, DEFAULT_SUMMARIZER_SETTINGS);
      assert.deepEqual(result.warnings, []);
      assert.equal(result.path, missingPath);
    });

    it("reads and parses a valid settings file", () => {
      const filePath = path.join(tempDir, "valid.json");
      const content = {
        version: 1,
        primary: { provider: "antigravity", modelId: "gemini-3.8-flash-tiered" },
        fallback: { provider: "antigravity", modelId: "gemini-3.6-flash-high" },
      };
      fs.writeFileSync(filePath, JSON.stringify(content, null, 2));

      const result = readSettings({ settingsPath: filePath });
      assert.equal(result.source, "file");
      assert.deepEqual(result.settings, content);
      assert.deepEqual(result.warnings, []);
      assert.equal(result.path, filePath);
    });

    it("returns defaults with warning for corrupt JSON and never rewrites file", () => {
      const filePath = path.join(tempDir, "corrupt.json");
      const corruptContent = "{ not json at all !!!";
      fs.writeFileSync(filePath, corruptContent);

      const result = readSettings({ settingsPath: filePath });
      assert.equal(result.source, "default");
      assert.deepEqual(result.settings, DEFAULT_SUMMARIZER_SETTINGS);
      assert.equal(result.warnings.length, 1);
      assert.ok(result.warnings[0].includes(filePath));
      assert.ok(result.warnings[0].includes("Invalid JSON"));

      // Ensure file content was never rewritten
      assert.equal(fs.readFileSync(filePath, "utf-8"), corruptContent);
    });

    it("returns defaults with warning for invalid schema and never rewrites file", () => {
      const filePath = path.join(tempDir, "invalid-schema.json");
      const invalidContent = JSON.stringify({ version: 99, unknownField: true });
      fs.writeFileSync(filePath, invalidContent);

      const result = readSettings({ settingsPath: filePath });
      assert.equal(result.source, "default");
      assert.deepEqual(result.settings, DEFAULT_SUMMARIZER_SETTINGS);
      assert.equal(result.warnings.length, 1);
      assert.ok(result.warnings[0].includes(filePath));
      assert.ok(result.warnings[0].includes("Unknown key") || result.warnings[0].includes("version"));

      // Ensure file content was never rewritten
      assert.equal(fs.readFileSync(filePath, "utf-8"), invalidContent);
    });
  });

  describe("writeSettings", () => {
    it("validates first and throws on invalid settings before touching filesystem", () => {
      const targetPath = path.join(tempDir, "never-created", "settings.json.custom");
      assert.throws(
        () => writeSettings({ version: 2 }, { settingsPath: targetPath }),
        /Invalid settings version/
      );
      assert.equal(fs.existsSync(targetPath), false);
      assert.equal(fs.existsSync(path.dirname(targetPath)), false);
    });

    it("writes atomically leaving no temp files behind", () => {
      const targetDir = path.join(tempDir, "sub");
      const targetPath = path.join(targetDir, ".pi-auto-compaction-settings.json");
      const settings = {
        version: 1,
        primary: { provider: "omniroute", modelId: "test-model" },
      };

      const returnedPath = writeSettings(settings, { settingsPath: targetPath });
      assert.equal(returnedPath, targetPath);
      assert.equal(fs.existsSync(targetPath), true);

      // Verify no temporary files remain in directory
      const files = fs.readdirSync(targetDir);
      assert.deepEqual(files, [".pi-auto-compaction-settings.json"]);
    });

    it("creates target file with mode 0600 and parent directory with mode 0700", () => {
      const targetDir = path.join(tempDir, "private-dir");
      const targetPath = path.join(targetDir, ".pi-auto-compaction-settings.json");
      const settings = { version: 1 };

      writeSettings(settings, { settingsPath: targetPath });

      const dirStat = fs.statSync(targetDir);
      const dirMode = dirStat.mode & 0o777;
      assert.equal(dirMode, 0o700, `Directory mode should be 0700, got ${dirMode.toString(8)}`);

      const fileStat = fs.statSync(targetPath);
      const fileMode = fileStat.mode & 0o777;
      assert.equal(fileMode, 0o600, `File mode should be 0600, got ${fileMode.toString(8)}`);
    });

    it("refuses to write if target path is a symlink", () => {
      const realTarget = path.join(tempDir, "real-target.json");
      fs.writeFileSync(realTarget, "original");
      const symlinkPath = path.join(tempDir, "symlink-target.json");
      fs.symlinkSync(realTarget, symlinkPath);

      assert.throws(
        () => writeSettings({ version: 1 }, { settingsPath: symlinkPath }),
        /target path is a symlink/
      );

      // Verify real target was not overwritten
      assert.equal(fs.readFileSync(realTarget, "utf-8"), "original");
    });

    it("refuses to write to settings.json and never touches it", () => {
      const agentSettingsPath = path.join(tempDir, "settings.json");
      fs.writeFileSync(agentSettingsPath, JSON.stringify({ existing: "pi settings" }));

      assert.throws(
        () => writeSettings({ version: 1 }, { settingsPath: agentSettingsPath }),
        /Refusing to write to settings\.json/
      );

      // Verify settings.json was not modified
      assert.equal(
        fs.readFileSync(agentSettingsPath, "utf-8"),
        JSON.stringify({ existing: "pi settings" })
      );
    });
  });

  describe("applyEnvOverrides", () => {
    it("applies full primary and fallback env pairs when provided", () => {
      const initial = {
        version: 1,
        primary: { provider: "antigravity", modelId: "gemini-3.8" },
        fallback: null,
      };
      const env = {
        PI_AUTO_COMPACTION_PRIMARY_PROVIDER: "openai",
        PI_AUTO_COMPACTION_PRIMARY_MODEL: "gpt-4o",
        PI_AUTO_COMPACTION_FALLBACK_PROVIDER: "anthropic",
        PI_AUTO_COMPACTION_FALLBACK_MODEL: "claude-3-5-sonnet",
      };

      const result = applyEnvOverrides(initial, env);
      assert.deepEqual(result.settings.primary, { provider: "openai", modelId: "gpt-4o" });
      assert.deepEqual(result.settings.fallback, { provider: "anthropic", modelId: "claude-3-5-sonnet" });
      assert.deepEqual(result.warnings, []);
      assert.equal(result.applied.primary, true);
      assert.equal(result.applied.fallback, true);
    });

    it("ignores incomplete primary pair (provider only) with a warning", () => {
      const initial = {
        version: 1,
        primary: { provider: "original-provider", modelId: "original-model" },
        fallback: null,
      };
      const env = {
        PI_AUTO_COMPACTION_PRIMARY_PROVIDER: "openai",
      };

      const result = applyEnvOverrides(initial, env);
      assert.deepEqual(result.settings.primary, initial.primary);
      assert.equal(result.applied.primary, false);
      assert.equal(result.warnings.length, 1);
      assert.ok(result.warnings[0].includes("PI_AUTO_COMPACTION_PRIMARY_PROVIDER"));
    });

    it("ignores incomplete primary pair (model only) with a warning", () => {
      const initial = {
        version: 1,
        primary: { provider: "original-provider", modelId: "original-model" },
        fallback: null,
      };
      const env = {
        PI_AUTO_COMPACTION_PRIMARY_MODEL: "gpt-4o",
      };

      const result = applyEnvOverrides(initial, env);
      assert.deepEqual(result.settings.primary, initial.primary);
      assert.equal(result.applied.primary, false);
      assert.equal(result.warnings.length, 1);
      assert.ok(result.warnings[0].includes("PI_AUTO_COMPACTION_PRIMARY_MODEL"));
    });

    it("ignores incomplete fallback pair (provider only) with a warning", () => {
      const initial = { version: 1, primary: null, fallback: null };
      const env = {
        PI_AUTO_COMPACTION_FALLBACK_PROVIDER: "anthropic",
      };

      const result = applyEnvOverrides(initial, env);
      assert.equal(result.settings.fallback, null);
      assert.equal(result.applied.fallback, false);
      assert.equal(result.warnings.length, 1);
      assert.ok(result.warnings[0].includes("PI_AUTO_COMPACTION_FALLBACK_PROVIDER"));
    });

    it("ignores incomplete fallback pair (model only) with a warning", () => {
      const initial = { version: 1, primary: null, fallback: null };
      const env = {
        PI_AUTO_COMPACTION_FALLBACK_MODEL: "claude-3-5-sonnet",
      };

      const result = applyEnvOverrides(initial, env);
      assert.equal(result.settings.fallback, null);
      assert.equal(result.applied.fallback, false);
      assert.equal(result.warnings.length, 1);
      assert.ok(result.warnings[0].includes("PI_AUTO_COMPACTION_FALLBACK_MODEL"));
    });

    it("does not mutate the input settings object", () => {
      const initial = Object.freeze({
        version: 1,
        primary: Object.freeze({ provider: "p", modelId: "m" }),
        fallback: null,
      });
      const env = {
        PI_AUTO_COMPACTION_PRIMARY_PROVIDER: "new-p",
        PI_AUTO_COMPACTION_PRIMARY_MODEL: "new-m",
      };

      const result = applyEnvOverrides(initial, env);
      assert.notEqual(result.settings, initial);
      assert.equal(initial.primary.provider, "p");
    });
  });

  describe("resolveSummarizerSettings precedence and source resolution", () => {
    it("returns defaults when no file, env, or options are present", () => {
      const missingPath = path.join(tempDir, "none.json");
      const result = resolveSummarizerSettings({
        settingsPath: missingPath,
        env: {},
        options: {},
      });

      assert.deepEqual(result.primary, DEFAULT_EFFECTIVE_SUMMARIZER.primary);
      assert.deepEqual(result.fallback, DEFAULT_EFFECTIVE_SUMMARIZER.fallback);
      assert.equal(result.source, "default");
      assert.deepEqual(result.sources, { primary: "default", fallback: "default" });
      assert.deepEqual(result.warnings, []);
    });

    it("file overrides defaults for configured models", () => {
      const filePath = path.join(tempDir, "file.json");
      const fileContent = {
        version: 1,
        primary: { provider: "file-prov", modelId: "file-prim" },
        fallback: { provider: "file-prov", modelId: "file-fall" },
      };
      fs.writeFileSync(filePath, JSON.stringify(fileContent));

      const result = resolveSummarizerSettings({
        settingsPath: filePath,
        env: {},
        options: {},
      });

      assert.deepEqual(result.primary, fileContent.primary);
      assert.deepEqual(result.fallback, fileContent.fallback);
      assert.equal(result.source, "file");
      assert.deepEqual(result.sources, { primary: "file", fallback: "file" });
    });

    it("env overrides file settings", () => {
      const filePath = path.join(tempDir, "file.json");
      const fileContent = {
        version: 1,
        primary: { provider: "file-prov", modelId: "file-prim" },
        fallback: { provider: "file-prov", modelId: "file-fall" },
      };
      fs.writeFileSync(filePath, JSON.stringify(fileContent));

      const env = {
        PI_AUTO_COMPACTION_PRIMARY_PROVIDER: "env-prov",
        PI_AUTO_COMPACTION_PRIMARY_MODEL: "env-prim",
        PI_AUTO_COMPACTION_FALLBACK_PROVIDER: "env-prov",
        PI_AUTO_COMPACTION_FALLBACK_MODEL: "env-fall",
      };

      const result = resolveSummarizerSettings({
        settingsPath: filePath,
        env,
        options: {},
      });

      assert.deepEqual(result.primary, { provider: "env-prov", modelId: "env-prim" });
      assert.deepEqual(result.fallback, { provider: "env-prov", modelId: "env-fall" });
      assert.equal(result.source, "env");
      assert.deepEqual(result.sources, { primary: "env", fallback: "env" });
    });

    it("options accept primaryModel and fallbackModel aliases matching resolveConfig shape", () => {
      const options = {
        primaryModel: { provider: "alias-p", modelId: "alias-m" },
        fallbackModel: { provider: "alias-fp", modelId: "alias-fm" },
      };

      const result = resolveSummarizerSettings({
        options,
        env: {},
      });

      assert.deepEqual(result.primary, { provider: "alias-p", modelId: "alias-m" });
      assert.deepEqual(result.fallback, { provider: "alias-fp", modelId: "alias-fm" });
      assert.deepEqual(result.primaryModel, result.primary);
      assert.deepEqual(result.fallbackModel, result.fallback);
      assert.equal(result.source, "options");
    });

    it("options passed directly as top-level arguments are supported", () => {
      const result = resolveSummarizerSettings({
        primary: { provider: "direct-p", modelId: "direct-m" },
        env: {},
      });

      assert.deepEqual(result.primary, { provider: "direct-p", modelId: "direct-m" });
      assert.equal(result.sources.primary, "options");
      assert.equal(result.sources.fallback, "default");
      assert.equal(result.source, "options+default");
    });

    it("expresses mixed sources accurately (e.g. env+file, file+default)", () => {
      const filePath = path.join(tempDir, "file.json");
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          version: 1,
          fallback: { provider: "file-p", modelId: "file-fall" },
        })
      );

      const env = {
        PI_AUTO_COMPACTION_PRIMARY_PROVIDER: "env-p",
        PI_AUTO_COMPACTION_PRIMARY_MODEL: "env-prim",
      };

      const result = resolveSummarizerSettings({
        settingsPath: filePath,
        env,
      });

      assert.deepEqual(result.primary, { provider: "env-p", modelId: "env-prim" });
      assert.deepEqual(result.fallback, { provider: "file-p", modelId: "file-fall" });
      assert.equal(result.source, "env+file");
      assert.deepEqual(result.sources, { primary: "env", fallback: "file" });
    });

    it("resolving twice does not mutate defaults", () => {
      const first = resolveSummarizerSettings({ env: {} });
      const second = resolveSummarizerSettings({ env: {} });

      assert.deepEqual(first.primary, DEFAULT_EFFECTIVE_SUMMARIZER.primary);
      assert.deepEqual(second.primary, DEFAULT_EFFECTIVE_SUMMARIZER.primary);

      // Verify that mutating a property on returned objects throws or does not affect defaults
      assert.throws(() => {
        first.primary.modelId = "mutated-model";
      }, TypeError);

      assert.deepEqual(DEFAULT_EFFECTIVE_SUMMARIZER.primary, {
        provider: "omniroute",
        modelId: "antigravity/gemini-3.8-flash-tiered",
      });
      assert.deepEqual(DEFAULT_SUMMARIZER_SETTINGS, {
        version: 1,
        primary: null,
        fallback: null,
      });
    });
  });
});
