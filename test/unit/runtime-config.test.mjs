import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { DEFAULT_CONFIG, resolveActiveConfig, resolveConfig } from "../../src/config.mjs";
import { createRuntimeConfig } from "../../src/runtime-config.mjs";

const ENV_KEYS = [
  "PI_AUTO_COMPACTION_PRIMARY_PROVIDER",
  "PI_AUTO_COMPACTION_PRIMARY_MODEL",
  "PI_AUTO_COMPACTION_FALLBACK_PROVIDER",
  "PI_AUTO_COMPACTION_FALLBACK_MODEL",
];

function withEnv(overrides) {
  const env = {};
  for (const key of ENV_KEYS) {
    if (overrides[key] !== undefined) env[key] = overrides[key];
  }
  return env;
}

describe("resolveActiveConfig", () => {
  let dir;
  let settingsPath;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pac-runtime-"));
    settingsPath = path.join(dir, ".pi-auto-compaction-settings.json");
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to the built-in summarizer models without a settings file", () => {
    const config = resolveActiveConfig({ settingsPath, env: {} });

    assert.deepEqual(config.primaryModel, DEFAULT_CONFIG.primaryModel);
    assert.deepEqual(config.fallbackModel, DEFAULT_CONFIG.fallbackModel);
    assert.equal(config.summarizer.source, "default");
    assert.equal(config.summarizer.path, path.resolve(settingsPath));
    assert.deepEqual(config.summarizer.warnings, []);
  });

  it("keeps resolveConfig pure: it never reads the settings file", () => {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ version: 1, primary: { provider: "p", modelId: "file-model" } }),
      { mode: 0o600 },
    );

    const pure = resolveConfig({});
    assert.deepEqual(pure.primaryModel, DEFAULT_CONFIG.primaryModel);
    assert.equal(pure.summarizer, undefined);

    fs.rmSync(settingsPath);
  });

  it("applies precedence options > env > file > default", () => {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        version: 1,
        primary: { provider: "file", modelId: "file-primary" },
        fallback: { provider: "file", modelId: "file-fallback" },
      }),
      { mode: 0o600 },
    );

    const fromFile = resolveActiveConfig({ settingsPath, env: {} });
    assert.deepEqual(fromFile.primaryModel, { provider: "file", modelId: "file-primary" });
    assert.equal(fromFile.summarizer.sources.primary, "file");

    const fromEnv = resolveActiveConfig({
      settingsPath,
      env: withEnv({
        PI_AUTO_COMPACTION_PRIMARY_PROVIDER: "envp",
        PI_AUTO_COMPACTION_PRIMARY_MODEL: "env-model",
      }),
    });
    assert.deepEqual(fromEnv.primaryModel, { provider: "envp", modelId: "env-model" });
    assert.deepEqual(fromEnv.fallbackModel, { provider: "file", modelId: "file-fallback" });
    assert.equal(fromEnv.summarizer.source, "env+file");

    const fromOptions = resolveActiveConfig({
      settingsPath,
      env: withEnv({
        PI_AUTO_COMPACTION_PRIMARY_PROVIDER: "envp",
        PI_AUTO_COMPACTION_PRIMARY_MODEL: "env-model",
      }),
      primaryModel: { provider: "opt", modelId: "opt-model" },
    });
    assert.deepEqual(fromOptions.primaryModel, { provider: "opt", modelId: "opt-model" });
    assert.equal(fromOptions.summarizer.sources.primary, "options");

    fs.rmSync(settingsPath);
  });

  it("surfaces warnings from a corrupt settings file without throwing", () => {
    fs.writeFileSync(settingsPath, "{ not json", { mode: 0o600 });

    const config = resolveActiveConfig({ settingsPath, env: {} });
    assert.deepEqual(config.primaryModel, DEFAULT_CONFIG.primaryModel);
    assert.equal(config.summarizer.warnings.length, 1);
    assert.match(config.summarizer.warnings[0], /Failed to load summarizer settings/);

    fs.rmSync(settingsPath);
  });
});

describe("createRuntimeConfig", () => {
  let dir;
  let settingsPath;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pac-runtime-live-"));
    settingsPath = path.join(dir, ".pi-auto-compaction-settings.json");
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("swaps the live configuration after a successful save", () => {
    const runtime = createRuntimeConfig({ settingsPath, env: {} });
    assert.deepEqual(runtime.get().primaryModel, DEFAULT_CONFIG.primaryModel);

    const { path: written } = runtime.saveSummarizerSettings({
      version: 1,
      primary: { provider: "antigravity", modelId: "gemini-3.8-flash-tiered" },
      fallback: { provider: "antigravity", modelId: "gemini-3.6-flash-high" },
    });

    assert.equal(written, path.resolve(settingsPath));
    const live = runtime.get();
    assert.deepEqual(live.primaryModel, { provider: "antigravity", modelId: "gemini-3.8-flash-tiered" });
    assert.deepEqual(live.fallbackModel, { provider: "antigravity", modelId: "gemini-3.6-flash-high" });
    assert.equal(live.summarizer.sources.primary, "file");

    fs.rmSync(settingsPath);
  });

  it("keeps the previous configuration when validation rejects the save", () => {
    const runtime = createRuntimeConfig({ settingsPath, env: {} });
    runtime.saveSummarizerSettings({
      version: 1,
      primary: { provider: "keep", modelId: "keep-model" },
      fallback: { provider: "keep", modelId: "keep-fallback" },
    });
    const before = runtime.get();

    assert.throws(
      () => runtime.saveSummarizerSettings({ version: 2, primary: null }),
      /Invalid settings version/,
    );
    assert.equal(runtime.get(), before);

    fs.rmSync(settingsPath);
  });

  it("keeps the previous configuration when the write itself fails", () => {
    const before = resolveActiveConfig({ settingsPath, env: {} });
    const runtime = createRuntimeConfig(
      { settingsPath, env: {} },
      {
        resolveActiveConfig: () => before,
        writeSettings: () => {
          throw new Error("disk full");
        },
      },
    );

    assert.throws(
      () =>
        runtime.saveSummarizerSettings({
          version: 1,
          primary: { provider: "a", modelId: "a" },
          fallback: { provider: "b", modelId: "b" },
        }),
      /disk full/,
    );
    assert.equal(runtime.get(), before);
  });

  it("reloads from the file without a restart", () => {
    const runtime = createRuntimeConfig({ settingsPath, env: {} });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ version: 1, primary: { provider: "late", modelId: "late-model" } }),
      { mode: 0o600 },
    );

    assert.equal(runtime.get().primaryModel.modelId, DEFAULT_CONFIG.primaryModel.modelId);
    runtime.reload();
    assert.equal(runtime.get().primaryModel.modelId, "late-model");

    fs.rmSync(settingsPath);
  });
});
