import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { runSetup } from "../../scripts/setup.mjs";
import { runRollback } from "../../scripts/rollback.mjs";
import { runDeploy } from "../../scripts/deploy.mjs";
import {
  MANAGED_POLICIES,
  MANAGED_MODELS,
  MANIFEST_VERSION_V1,
  MANIFEST_VERSION_V2,
  EXPECTED_MANIFEST_VERSION,
  validateManifest,
  migrateManifestV1ToV2,
  checkDriftOnReinstall,
  checkDriftOnRollback,
  applyManagedSettings,
  buildManifest,
} from "../../src/install-state.mjs";

describe("install-state and manifest v2 migration", () => {
  let tempHome;
  let targetAgentDir;
  let settingsFile;
  let mockPkgSourceDir;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-install-state-test-"));
    targetAgentDir = path.join(tempHome, ".pi", "agent");
    fs.mkdirSync(targetAgentDir, { recursive: true });
    settingsFile = path.join(targetAgentDir, "settings.json");

    mockPkgSourceDir = path.join(tempHome, "pkg-source");
    fs.mkdirSync(mockPkgSourceDir, { recursive: true });
    fs.writeFileSync(path.join(mockPkgSourceDir, "index.mjs"), "export default function() {}");
    fs.writeFileSync(
      path.join(mockPkgSourceDir, "package.json"),
      JSON.stringify({ name: "pi-auto-compaction", type: "module", private: true, license: "UNLICENSED" }),
    );
    const scriptsDir = path.join(mockPkgSourceDir, "scripts");
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.copyFileSync(path.resolve("scripts/setup.mjs"), path.join(scriptsDir, "setup.mjs"));
    fs.copyFileSync(path.resolve("scripts/rollback.mjs"), path.join(scriptsDir, "rollback.mjs"));
    const srcDir = path.join(mockPkgSourceDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    for (const f of fs.readdirSync(path.resolve("src"))) {
      if (f.endsWith(".mjs")) {
        fs.copyFileSync(path.resolve("src", f), path.join(srcDir, f));
      }
    }
  });

  afterEach(() => {
    if (tempHome && fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("MANAGED_POLICIES defines exact frozen policies for all eight models and MANAGED_MODELS derives from it", () => {
    assert.ok(MANAGED_POLICIES, "MANAGED_POLICIES must be exported");
    assert.ok(Object.isFrozen(MANAGED_POLICIES), "MANAGED_POLICIES must be frozen");
    assert.equal(MANAGED_MODELS.length, 8, "MANAGED_MODELS must have 8 models");
    assert.ok(Object.isFrozen(MANAGED_MODELS), "MANAGED_MODELS must be frozen");

    const expected = {
      "openai-codex/gpt-6-sol": { reserveTokens: 65536, keepRecentTokens: 20000 },
      "openai-codex/gpt-6.1-sol": { reserveTokens: 65536, keepRecentTokens: 20000 },
      "openai/gpt-6-sol": { reserveTokens: 65536, keepRecentTokens: 20000 },
      "openai/gpt-6.1-sol": { reserveTokens: 65536, keepRecentTokens: 20000 },
      "commandcode/deepseek/deepseek-v4.1-flash": { reserveTokens: 140000, keepRecentTokens: 20000 },
      "deepseek/deepseek-v4.1-flash": { reserveTokens: 140000, keepRecentTokens: 20000 },
      "omniroute/antigravity/gemini-3.8-flash-tiered": { reserveTokens: 200000, keepRecentTokens: 20000 },
      "antigravity/gemini-3.8-flash-tiered": { reserveTokens: 200000, keepRecentTokens: 20000 },
    };

    for (const [model, pol] of Object.entries(expected)) {
      assert.deepEqual(MANAGED_POLICIES[model], pol, `Policy for ${model} must match expected`);
    }
  });

  it("v1→v2 migration preserves the four originalOverrides and captures DeepSeek 860000 / Gemini 848576 as new baselines", () => {
    const v1OriginalOverrides = {
      "openai-codex/gpt-6-sol": {
        present: true,
        reserveTokens: { present: true, value: 30000 },
        keepRecentTokens: { present: false, value: undefined },
        originalEmpty: false,
        value: { reserveTokens: 30000 },
      },
      "openai-codex/gpt-6.1-sol": {
        present: false,
        reserveTokens: { present: false, value: undefined },
        keepRecentTokens: { present: false, value: undefined },
        originalEmpty: false,
        value: null,
      },
      "openai/gpt-6-sol": {
        present: true,
        reserveTokens: { present: true, value: 45000 },
        keepRecentTokens: { present: true, value: 15000 },
        originalEmpty: false,
        value: { reserveTokens: 45000, keepRecentTokens: 15000 },
      },
      "openai/gpt-6.1-sol": {
        present: false,
        reserveTokens: { present: false, value: undefined },
        keepRecentTokens: { present: false, value: undefined },
        originalEmpty: false,
        value: null,
      },
    };

    const v1Manifest = {
      version: MANIFEST_VERSION_V1,
      installedAt: "2026-11-06T10:00:00.000Z",
      packageSourceDir: mockPkgSourceDir,
      managedModels: Object.keys(v1OriginalOverrides),
      expectedManagedValues: { reserveTokens: 65536, keepRecentTokens: 20000 },
      originalOverrides: v1OriginalOverrides,
      loaderPath: path.join(targetAgentDir, "extensions", "omniroute-compaction.ts"),
      loaderHash: "a".repeat(64),
    };

    const currentSettings = {
      compaction: {
        modelOverrides: {
          "commandcode/deepseek/deepseek-v4.1-flash": { reserveTokens: 860000, keepRecentTokens: 20000 },
          "deepseek/deepseek-v4.1-flash": { reserveTokens: 860000, keepRecentTokens: 20000 },
          "omniroute/antigravity/gemini-3.8-flash-tiered": { reserveTokens: 848576, keepRecentTokens: 20000 },
          "antigravity/gemini-3.8-flash-tiered": { reserveTokens: 848576, keepRecentTokens: 20000 },
          // and existing openai models with managed values
          "openai-codex/gpt-6-sol": { reserveTokens: 65536, keepRecentTokens: 20000 },
          "openai-codex/gpt-6.1-sol": { reserveTokens: 65536, keepRecentTokens: 20000 },
          "openai/gpt-6-sol": { reserveTokens: 65536, keepRecentTokens: 20000 },
          "openai/gpt-6.1-sol": { reserveTokens: 65536, keepRecentTokens: 20000 },
        },
      },
    };

    const v2Manifest = migrateManifestV1ToV2(v1Manifest, currentSettings);

    assert.equal(v2Manifest.version, MANIFEST_VERSION_V2);
    assert.equal(v2Manifest.version, "2.0.0");
    assert.deepEqual(v2Manifest.managedModels, [...MANAGED_MODELS]);
    assert.equal(v2Manifest.expectedManagedValues, undefined);
    assert.deepEqual(v2Manifest.policies, MANAGED_POLICIES);

    // Byte-for-byte preservation of the 4 originalOverrides
    for (const model of Object.keys(v1OriginalOverrides)) {
      assert.deepEqual(
        v2Manifest.originalOverrides[model],
        v1OriginalOverrides[model],
        `Original baseline for ${model} must be preserved byte-for-byte`,
      );
    }

    // Baselines captured for new DeepSeek and Gemini models
    assert.deepEqual(v2Manifest.originalOverrides["commandcode/deepseek/deepseek-v4.1-flash"], {
      present: true,
      reserveTokens: { present: true, value: 860000 },
      keepRecentTokens: { present: true, value: 20000 },
      originalEmpty: false,
      value: { reserveTokens: 860000, keepRecentTokens: 20000 },
    });
    assert.deepEqual(v2Manifest.originalOverrides["deepseek/deepseek-v4.1-flash"], {
      present: true,
      reserveTokens: { present: true, value: 860000 },
      keepRecentTokens: { present: true, value: 20000 },
      originalEmpty: false,
      value: { reserveTokens: 860000, keepRecentTokens: 20000 },
    });
    assert.deepEqual(v2Manifest.originalOverrides["omniroute/antigravity/gemini-3.8-flash-tiered"], {
      present: true,
      reserveTokens: { present: true, value: 848576 },
      keepRecentTokens: { present: true, value: 20000 },
      originalEmpty: false,
      value: { reserveTokens: 848576, keepRecentTokens: 20000 },
    });
    assert.deepEqual(v2Manifest.originalOverrides["antigravity/gemini-3.8-flash-tiered"], {
      present: true,
      reserveTokens: { present: true, value: 848576 },
      keepRecentTokens: { present: true, value: 20000 },
      originalEmpty: false,
      value: { reserveTokens: 848576, keepRecentTokens: 20000 },
    });

    // Validate that the migrated manifest passes validateManifest
    assert.doesNotThrow(() => validateManifest(v2Manifest));
  });

  it("migration is idempotent", () => {
    const v1OriginalOverrides = {
      "openai-codex/gpt-6-sol": {
        present: false,
        reserveTokens: { present: false, value: undefined },
        keepRecentTokens: { present: false, value: undefined },
        originalEmpty: false,
        value: null,
      },
      "openai-codex/gpt-6.1-sol": {
        present: false,
        reserveTokens: { present: false, value: undefined },
        keepRecentTokens: { present: false, value: undefined },
        originalEmpty: false,
        value: null,
      },
      "openai/gpt-6-sol": {
        present: false,
        reserveTokens: { present: false, value: undefined },
        keepRecentTokens: { present: false, value: undefined },
        originalEmpty: false,
        value: null,
      },
      "openai/gpt-6.1-sol": {
        present: false,
        reserveTokens: { present: false, value: undefined },
        keepRecentTokens: { present: false, value: undefined },
        originalEmpty: false,
        value: null,
      },
    };

    const v1Manifest = {
      version: MANIFEST_VERSION_V1,
      installedAt: "2026-11-06T10:00:00.000Z",
      packageSourceDir: mockPkgSourceDir,
      managedModels: Object.keys(v1OriginalOverrides),
      expectedManagedValues: { reserveTokens: 65536, keepRecentTokens: 20000 },
      originalOverrides: v1OriginalOverrides,
      loaderPath: path.join(targetAgentDir, "extensions", "omniroute-compaction.ts"),
      loaderHash: "b".repeat(64),
    };

    const v2ManifestFirst = migrateManifestV1ToV2(v1Manifest, {});
    const v2ManifestSecond = migrateManifestV1ToV2(v2ManifestFirst, {});
    assert.deepEqual(v2ManifestSecond, v2ManifestFirst, "Migrating a v2 manifest must be idempotent");
  });

  it("v2 validation rejects a policy mismatch", () => {
    const originalOverrides = {};
    for (const m of MANAGED_MODELS) {
      originalOverrides[m] = {
        present: false,
        reserveTokens: { present: false, value: undefined },
        keepRecentTokens: { present: false, value: undefined },
        originalEmpty: false,
        value: null,
      };
    }

    const validV2Manifest = buildManifest({
      installedAt: new Date().toISOString(),
      packageSourceDir: mockPkgSourceDir,
      originalOverrides,
      loaderPath: path.join(targetAgentDir, "extensions", "omniroute-compaction.ts"),
      loaderHash: "c".repeat(64),
    });

    assert.doesNotThrow(() => validateManifest(validV2Manifest));

    // Tampering with policy reserveTokens
    const tamperedTokens = JSON.parse(JSON.stringify(validV2Manifest));
    tamperedTokens.policies["commandcode/deepseek/deepseek-v4.1-flash"].reserveTokens = 999999;
    assert.throws(() => validateManifest(tamperedTokens), /policy mismatch|policies/i);

    // Tampering with policy keepRecentTokens
    const tamperedKeep = JSON.parse(JSON.stringify(validV2Manifest));
    tamperedKeep.policies["omniroute/antigravity/gemini-3.8-flash-tiered"].keepRecentTokens = 50000;
    assert.throws(() => validateManifest(tamperedKeep), /policy mismatch|policies/i);

    // Missing model in policies
    const missingModel = JSON.parse(JSON.stringify(validV2Manifest));
    delete missingModel.policies["openai-codex/gpt-6-sol"];
    assert.throws(() => validateManifest(missingModel), /policies/i);

    // Having expectedManagedValues in v2 is rejected
    const withOldKey = JSON.parse(JSON.stringify(validV2Manifest));
    withOldKey.expectedManagedValues = { reserveTokens: 65536, keepRecentTokens: 20000 };
    assert.throws(() => validateManifest(withOldKey), /schema mismatch/i);
  });

  it("drift rejection names the offending model", () => {
    const originalOverrides = {};
    for (const m of MANAGED_MODELS) {
      originalOverrides[m] = {
        present: false,
        reserveTokens: { present: false, value: undefined },
        keepRecentTokens: { present: false, value: undefined },
        originalEmpty: false,
        value: null,
      };
    }
    const loaderPath = path.join(targetAgentDir, "extensions", "omniroute-compaction.ts");
    fs.mkdirSync(path.dirname(loaderPath), { recursive: true });
    const loaderContent = "loader content";
    fs.writeFileSync(loaderPath, loaderContent);
    const loaderHash = crypto.createHash("sha256").update(loaderContent).digest("hex");

    const v2Manifest = {
      version: MANIFEST_VERSION_V2,
      installedAt: new Date().toISOString(),
      packageSourceDir: mockPkgSourceDir,
      managedModels: [...MANAGED_MODELS],
      policies: MANAGED_POLICIES,
      originalOverrides,
      loaderPath,
      loaderHash,
    };

    // Correct settings matching all policies
    const goodSettings = applyManagedSettings({});

    // Tamper DeepSeek reserveTokens
    const badDeepSeek = JSON.parse(JSON.stringify(goodSettings));
    badDeepSeek.compaction.modelOverrides["commandcode/deepseek/deepseek-v4.1-flash"].reserveTokens = 860000;

    assert.throws(
      () => checkDriftOnReinstall(badDeepSeek, v2Manifest, loaderPath),
      /commandcode\/deepseek\/deepseek-v4\.1-flash.*reserveTokens.*drift/i,
    );

    assert.throws(
      () => checkDriftOnRollback(badDeepSeek, v2Manifest, loaderPath),
      /commandcode\/deepseek\/deepseek-v4\.1-flash.*reserveTokens.*drift/i,
    );

    // Tamper Gemini keepRecentTokens
    const badGemini = JSON.parse(JSON.stringify(goodSettings));
    badGemini.compaction.modelOverrides["omniroute/antigravity/gemini-3.8-flash-tiered"].keepRecentTokens = 9999;

    assert.throws(
      () => checkDriftOnReinstall(badGemini, v2Manifest, loaderPath),
      /omniroute\/antigravity\/gemini-3\.8-flash-tiered.*keepRecentTokens.*drift/i,
    );

    assert.throws(
      () => checkDriftOnRollback(badGemini, v2Manifest, loaderPath),
      /omniroute\/antigravity\/gemini-3\.8-flash-tiered.*keepRecentTokens.*drift/i,
    );
  });

  it("rollback per model restores its exact baseline", () => {
    // Initial settings with DeepSeek at 860000 and Gemini at 848576, OpenAI at 50000
    const initialSettings = {
      compaction: {
        modelOverrides: {
          "commandcode/deepseek/deepseek-v4.1-flash": { reserveTokens: 860000, keepRecentTokens: 20000 },
          "deepseek/deepseek-v4.1-flash": { reserveTokens: 860000, keepRecentTokens: 20000 },
          "omniroute/antigravity/gemini-3.8-flash-tiered": { reserveTokens: 848576, keepRecentTokens: 20000 },
          "antigravity/gemini-3.8-flash-tiered": { reserveTokens: 848576, keepRecentTokens: 20000 },
          "openai-codex/gpt-6-sol": { reserveTokens: 50000, keepRecentTokens: 18000, userTag: "custom" },
        },
      },
    };
    fs.writeFileSync(settingsFile, JSON.stringify(initialSettings, null, 2));

    // Run setup: applies new policies
    runSetup({ agentDir: targetAgentDir, packageSourceDir: mockPkgSourceDir });

    const appliedSettings = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
    assert.equal(
      appliedSettings.compaction.modelOverrides["commandcode/deepseek/deepseek-v4.1-flash"].reserveTokens,
      140000,
    );
    assert.equal(
      appliedSettings.compaction.modelOverrides["omniroute/antigravity/gemini-3.8-flash-tiered"].reserveTokens,
      200000,
    );
    assert.equal(
      appliedSettings.compaction.modelOverrides["openai-codex/gpt-6-sol"].reserveTokens,
      65536,
    );
    assert.equal(
      appliedSettings.compaction.modelOverrides["openai-codex/gpt-6-sol"].userTag,
      "custom",
    );

    // Run rollback: restores exact baselines
    runRollback({ agentDir: targetAgentDir });

    const rolledBackSettings = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
    assert.equal(
      rolledBackSettings.compaction.modelOverrides["commandcode/deepseek/deepseek-v4.1-flash"].reserveTokens,
      860000,
      "DeepSeek reserveTokens must be restored to 860000",
    );
    assert.equal(
      rolledBackSettings.compaction.modelOverrides["omniroute/antigravity/gemini-3.8-flash-tiered"].reserveTokens,
      848576,
      "Gemini reserveTokens must be restored to 848576",
    );
    assert.equal(
      rolledBackSettings.compaction.modelOverrides["openai-codex/gpt-6-sol"].reserveTokens,
      50000,
      "OpenAI reserveTokens must be restored to 50000",
    );
    assert.equal(
      rolledBackSettings.compaction.modelOverrides["openai-codex/gpt-6-sol"].userTag,
      "custom",
    );
    // Models that were originally absent must have managed fields removed
    assert.equal(
      rolledBackSettings.compaction.modelOverrides["openai-codex/gpt-6.1-sol"],
      undefined,
      "Originally absent model must be removed",
    );
  });

  it("reinstall is idempotent (second run writes identical manifest/settings apart from installedAt)", () => {
    runSetup({ agentDir: targetAgentDir, packageSourceDir: mockPkgSourceDir });

    const manifestFile = path.join(targetAgentDir, ".pi-auto-compaction-manifest.json");
    const manifest1 = JSON.parse(fs.readFileSync(manifestFile, "utf-8"));
    const settings1 = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));

    // Reinstall
    runSetup({ agentDir: targetAgentDir, packageSourceDir: mockPkgSourceDir });

    const manifest2 = JSON.parse(fs.readFileSync(manifestFile, "utf-8"));
    const settings2 = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));

    assert.deepEqual(settings2, settings1, "Settings must be byte-identical on reinstall");
    assert.deepEqual(
      { ...manifest2, installedAt: manifest1.installedAt },
      manifest1,
      "Manifest must be identical on reinstall apart from installedAt",
    );
  });

  it("adoption still works: migrating v1 agent manifest to v2 via deploy --adopt-agent", () => {
    // Create an adopted source directory
    const oldSource = path.join(tempHome, "adopted-legacy-source");
    fs.mkdirSync(oldSource, { recursive: true });
    for (const name of ["index.mjs", "package.json", "README.md"]) {
      fs.copyFileSync(path.resolve(name), path.join(oldSource, name));
    }
    for (const dir of ["src", "scripts"]) {
      fs.mkdirSync(path.join(oldSource, dir), { recursive: true });
      for (const name of fs.readdirSync(path.resolve(dir))) {
        if ((dir === "src" && name.endsWith(".mjs")) || ["setup.mjs", "rollback.mjs"].includes(name)) {
          fs.copyFileSync(path.resolve(dir, name), path.join(oldSource, dir, name));
        }
      }
    }

    // Set up a v1 agent manually
    const initialSettings = {
      compaction: {
        modelOverrides: {
          "openai-codex/gpt-6-sol": { reserveTokens: 65536, keepRecentTokens: 20000 },
          "openai-codex/gpt-6.1-sol": { reserveTokens: 65536, keepRecentTokens: 20000 },
          "openai/gpt-6-sol": { reserveTokens: 65536, keepRecentTokens: 20000 },
          "openai/gpt-6.1-sol": { reserveTokens: 65536, keepRecentTokens: 20000 },
          "commandcode/deepseek/deepseek-v4.1-flash": { reserveTokens: 860000, keepRecentTokens: 20000 },
        },
      },
    };
    fs.writeFileSync(settingsFile, JSON.stringify(initialSettings, null, 2));

    const v1OriginalOverrides = {
      "openai-codex/gpt-6-sol": {
        present: false,
        reserveTokens: { present: false, value: undefined },
        keepRecentTokens: { present: false, value: undefined },
        originalEmpty: false,
        value: null,
      },
      "openai-codex/gpt-6.1-sol": {
        present: false,
        reserveTokens: { present: false, value: undefined },
        keepRecentTokens: { present: false, value: undefined },
        originalEmpty: false,
        value: null,
      },
      "openai/gpt-6-sol": {
        present: false,
        reserveTokens: { present: false, value: undefined },
        keepRecentTokens: { present: false, value: undefined },
        originalEmpty: false,
        value: null,
      },
      "openai/gpt-6.1-sol": {
        present: false,
        reserveTokens: { present: false, value: undefined },
        keepRecentTokens: { present: false, value: undefined },
        originalEmpty: false,
        value: null,
      },
    };

    const loaderPath = path.join(targetAgentDir, "extensions", "omniroute-compaction.ts");
    fs.mkdirSync(path.dirname(loaderPath), { recursive: true });
    // Expected loader for oldSource
    const entrySpecifier = JSON.stringify(path.join(oldSource, "index.mjs"));
    const legacyLoaderContent = `// Managed loader for pi-auto-compaction\nimport type { ExtensionAPI } from "@earendil-works/pi-coding-agent";\n\nexport default async function (pi: ExtensionAPI) {\n  try {\n    const ext = await import(${entrySpecifier});\n    const factory = ext.default || ext.autoCompactionExtension;\n    if (typeof factory === "function") {\n      factory(pi);\n    }\n  } catch (err) {\n    console.error("[pi-auto-compaction] Failed to load durable extension:", err);\n  }\n}\n`;
    fs.writeFileSync(loaderPath, legacyLoaderContent);
    const legacyLoaderHash = crypto.createHash("sha256").update(legacyLoaderContent).digest("hex");

    const v1Manifest = {
      version: MANIFEST_VERSION_V1,
      installedAt: "2026-11-06T09:00:00.000Z",
      packageSourceDir: oldSource,
      managedModels: Object.keys(v1OriginalOverrides),
      expectedManagedValues: { reserveTokens: 65536, keepRecentTokens: 20000 },
      originalOverrides: v1OriginalOverrides,
      loaderPath,
      loaderHash: legacyLoaderHash,
    };
    const manifestFile = path.join(targetAgentDir, ".pi-auto-compaction-manifest.json");
    fs.writeFileSync(manifestFile, JSON.stringify(v1Manifest, null, 2));

    const installDir = path.join(tempHome, "managed-install");

    // Run deploy --adopt-agent
    const result = runDeploy({
      agentDir: targetAgentDir,
      installDir,
      sourceDir: path.resolve("."),
      adoptAgent: true,
    });

    assert.equal(result.success, true);
    assert.equal(result.dryRun, false);

    // Verify manifest was migrated to v2
    const adoptedManifest = JSON.parse(fs.readFileSync(manifestFile, "utf-8"));
    assert.equal(adoptedManifest.version, MANIFEST_VERSION_V2);
    assert.equal(adoptedManifest.managedModels.length, 8);
    // DeepSeek baseline was captured at migration time (860000)
    assert.equal(
      adoptedManifest.originalOverrides["commandcode/deepseek/deepseek-v4.1-flash"].reserveTokens.value,
      860000,
    );
    // Settings now have managed policies (140000 for deepseek)
    const deployedSettings = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
    assert.equal(
      deployedSettings.compaction.modelOverrides["commandcode/deepseek/deepseek-v4.1-flash"].reserveTokens,
      140000,
    );
  });
});
