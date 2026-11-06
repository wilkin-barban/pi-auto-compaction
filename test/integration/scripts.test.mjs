import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runSetup } from "../../scripts/setup.mjs";
import { runRollback } from "../../scripts/rollback.mjs";
import {
  validateManifest,
  checkDriftOnRollback,
  MANAGED_MODELS,
  MANAGED_POLICIES,
  EXPECTED_MANIFEST_VERSION,
  hashContent,
  parseAndValidateReceipt,
} from "../../src/install-state.mjs";

describe("deployment scripts module", () => {
  let tempHome;
  let targetAgentDir;
  let settingsFile;
  let mockPkgSourceDir;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-setup-test-"));
    targetAgentDir = path.join(tempHome, ".pi", "agent");
    fs.mkdirSync(targetAgentDir, { recursive: true });
    settingsFile = path.join(targetAgentDir, "settings.json");

    mockPkgSourceDir = path.join(tempHome, "pkg-source");
    fs.mkdirSync(mockPkgSourceDir, { recursive: true });
    fs.writeFileSync(path.join(mockPkgSourceDir, "index.mjs"), "export default function() {}");

    // Write initial settings with an existing override that has a custom property
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          defaultProvider: "openai",
          theme: "dark",
          compaction: {
            enabled: true,
            reserveTokens: 16384,
            modelOverrides: {
              "openai-codex/gpt-6-sol": {
                reserveTokens: 30000, // Pre-existing original value
                customUserField: "keep-me",
              },
              "other-provider/other-model": { reserveTokens: 50000 },
            },
          },
        },
        null,
        2,
      ),
    );
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  function managedSnapshot() {
    return Object.fromEntries([
      settingsFile,
      path.join(targetAgentDir, "extensions", "omniroute-compaction.ts"),
      path.join(targetAgentDir, ".pi-auto-compaction-manifest.json"),
    ].map((file) => [file, fs.existsSync(file) ? fs.readFileSync(file) : null]));
  }

  function assertRefusedUnchanged(pattern) {
    const before = managedSnapshot();
    const stateDir = path.join(targetAgentDir, ".pi-auto-compaction-state");
    const stateBefore = fs.readdirSync(stateDir);
    for (const operation of [
      () => runSetup({ agentDir: targetAgentDir, packageSourceDir: mockPkgSourceDir }),
      () => runRollback({ agentDir: targetAgentDir }),
      () => runRollback({ agentDir: targetAgentDir, force: true }),
      () => runSetup({ agentDir: targetAgentDir, packageSourceDir: mockPkgSourceDir, dryRun: true }),
      () => runRollback({ agentDir: targetAgentDir, dryRun: true }),
    ]) {
      assert.throws(operation, pattern);
      assert.deepEqual(managedSnapshot(), before);
      assert.deepEqual(fs.readdirSync(stateDir), stateBefore, "No backup or journal written");
      assert.equal(fs.existsSync(path.join(targetAgentDir, ".pi-auto-compaction.lock")), false);
    }
  }

  const baselineCorruptions = [
    ["present value null", (e) => { e.value = null; }],
    ["present value missing", (e) => { delete e.value; }],
    ["present value array", (e) => { e.value = []; }],
    ["presence missing", (e) => { delete e.present; }],
    ["originalEmpty missing", (e) => { delete e.originalEmpty; }],
    ["originalEmpty inconsistent", (e) => { e.originalEmpty = true; }],
    ...["reserveTokens", "keepRecentTokens"].flatMap((field) => [
      [`${field} record missing`, (e) => { delete e[field]; }],
      [`${field} record null`, (e) => { e[field] = null; }],
      [`${field} record array`, (e) => { e[field] = []; }],
      [`${field} presence missing`, (e) => { delete e[field].present; }],
      [`${field} presence invalid`, (e) => { e[field].present = "yes"; }],
      [`${field} present value missing`, (e) => { e[field] = { present: true }; }],
      ...[null, [], -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1].map((value) => [
        `${field} invalid value ${JSON.stringify(value)}`,
        (e) => { e[field] = { present: true, value }; },
      ]),
      [`${field} false with value`, (e) => { e[field] = { present: false, value: 1 }; }],
      [`${field} presence contradicts value`, (e) => {
        e[field] = { present: false };
        e.value[field] = 1;
      }],
      [`${field} value contradicts record`, (e) => {
        e[field] = { present: true, value: 1 };
        e.value[field] = 2;
      }],
    ]),
  ];

  for (const [name, corrupt] of baselineCorruptions) {
    it(`valid installed manifest rejects isolated baseline corruption: ${name}`, () => {
      runSetup({ agentDir: targetAgentDir, packageSourceDir: mockPkgSourceDir });
      const file = path.join(targetAgentDir, ".pi-auto-compaction-manifest.json");
      const manifest = JSON.parse(fs.readFileSync(file, "utf-8"));
      assert.doesNotThrow(() => validateManifest(manifest));
      corrupt(manifest.originalOverrides[MANAGED_MODELS[0]]);
      fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
      assertRefusedUnchanged(/invalid|corrupt/i);
    });
  }

  for (const [name, corrupt] of [
    ["absent value missing", (m) => { delete m.originalOverrides[MANAGED_MODELS[1]].value; }],
    ["absent value object", (m) => { m.originalOverrides[MANAGED_MODELS[1]].value = {}; }],
    ["absent originalEmpty true", (m) => { m.originalOverrides[MANAGED_MODELS[1]].originalEmpty = true; }],
    ["extra baseline model", (m) => { m.originalOverrides["foreign/model"] = {}; }],
    ["duplicate managed model", (m) => { m.managedModels[1] = m.managedModels[0]; }],
    ["unsupported version", (m) => { m.version = "9.9.9"; }],
    ["invalid ownership hash", (m) => { m.loaderHash = "bad"; }],
    ["foreign ownership path", (m) => { m.loaderPath = path.join(tempHome, "foreign-loader.ts"); }],
  ]) {
    it(`valid installed manifest rejects isolated schema corruption: ${name}`, () => {
      runSetup({ agentDir: targetAgentDir, packageSourceDir: mockPkgSourceDir });
      const file = path.join(targetAgentDir, ".pi-auto-compaction-manifest.json");
      const manifest = JSON.parse(fs.readFileSync(file, "utf-8"));
      assert.doesNotThrow(() => validateManifest(manifest));
      corrupt(manifest);
      fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
      assertRefusedUnchanged(/invalid|corrupt/i);
    });
  }

  for (const removed of ["loader", "overrides", "model", "reserveTokens", "keepRecentTokens"]) {
    it(`both operations reject deleted managed ${removed} without writes or force bypass`, () => {
      runSetup({ agentDir: targetAgentDir, packageSourceDir: mockPkgSourceDir });
      if (removed === "loader") {
        fs.unlinkSync(path.join(targetAgentDir, "extensions", "omniroute-compaction.ts"));
      } else {
        const settings = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
        if (removed === "overrides") delete settings.compaction.modelOverrides;
        else if (removed === "model") delete settings.compaction.modelOverrides[MANAGED_MODELS[0]];
        else delete settings.compaction.modelOverrides[MANAGED_MODELS[0]][removed];
        fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
      }
      assertRefusedUnchanged(/drift/i);
    });
  }

  for (const field of ["reserveTokens", "keepRecentTokens"]) {
    it(`setup refuses invalid original ${field} before creating installed state`, () => {
      const settings = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
      settings.compaction.modelOverrides[MANAGED_MODELS[0]][field] = null;
      fs.writeFileSync(settingsFile, JSON.stringify(settings));
      const before = managedSnapshot();
      assert.throws(() => runSetup({ agentDir: targetAgentDir, packageSourceDir: mockPkgSourceDir }), /invalid|corrupt/i);
      assert.deepEqual(managedSnapshot(), before);
      assert.deepEqual(fs.readdirSync(path.join(targetAgentDir, ".pi-auto-compaction-state")), []);
    });
  }

  it("zero token baselines and empty or absent entries survive repeated setup and rollback", () => {
    const original = { compaction: { modelOverrides: {
      [MANAGED_MODELS[0]]: { reserveTokens: 0, keepRecentTokens: 0, custom: "preserve" },
      [MANAGED_MODELS[1]]: {},
      [MANAGED_MODELS[2]]: { custom: "no original managed values" },
    } } };
    fs.writeFileSync(settingsFile, JSON.stringify(original));
    runSetup({ agentDir: targetAgentDir, packageSourceDir: mockPkgSourceDir });
    const manifestFile = path.join(targetAgentDir, ".pi-auto-compaction-manifest.json");
    const baseline = JSON.parse(fs.readFileSync(manifestFile)).originalOverrides;
    runSetup({ agentDir: targetAgentDir, packageSourceDir: mockPkgSourceDir });
    assert.deepEqual(JSON.parse(fs.readFileSync(manifestFile)).originalOverrides, baseline);
    runRollback({ agentDir: targetAgentDir });
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile)), original);
  });

  it("compensation continues restoring loader and settings if manifest restoration fails", () => {
    runSetup({ agentDir: targetAgentDir, packageSourceDir: mockPkgSourceDir });
    const before = managedSnapshot();
    const manifestFile = path.join(targetAgentDir, ".pi-auto-compaction-manifest.json");
    const originalWrite = fs.writeFileSync;
    try {
      assert.throws(() => runRollback({
        agentDir: targetAgentDir,
        _testAfterOperation: (op) => {
          if (op !== "manifest-removal") return;
          fs.writeFileSync = (file, content, ...args) => {
            if (content === before[manifestFile].toString()) throw new Error("Cannot restore manifest");
            return originalWrite(file, content, ...args);
          };
          throw new Error("Injected failure after both deletions");
        },
      }), /Injected failure after both deletions/);
    } finally {
      fs.writeFileSync = originalWrite;
    }
    const after = managedSnapshot();
    assert.equal(after[manifestFile], null);
    for (const file of Object.keys(before).filter((f) => f !== manifestFile)) {
      assert.deepEqual(after[file], before[file], "Other completed operations must still be compensated");
    }
    assertRefusedUnchanged(/Pending recovery journal/i);
  });

  it("compensation publishes removed files in reverse order before restoring settings", () => {
    runSetup({ agentDir: targetAgentDir, packageSourceDir: mockPkgSourceDir });
    const before = managedSnapshot();
    const restored = [];
    const originalLink = fs.linkSync;
    const originalRename = fs.renameSync;
    try {
      assert.throws(() => runRollback({
        agentDir: targetAgentDir,
        _testAfterOperation: (op) => {
          if (op !== "manifest-removal") return;
          assert.equal(fs.existsSync(path.join(targetAgentDir, ".pi-auto-compaction-manifest.json")), false);
          assert.equal(fs.existsSync(path.join(targetAgentDir, "extensions", "omniroute-compaction.ts")), false);
          fs.linkSync = (source, target) => {
            restored.push(path.basename(target));
            return originalLink(source, target);
          };
          fs.renameSync = (source, target) => {
            if (target === settingsFile) restored.push(path.basename(target));
            return originalRename(source, target);
          };
          throw new Error("Injected post-deletion failure");
        },
      }), /Injected post-deletion failure/);
    } finally {
      fs.linkSync = originalLink;
      fs.renameSync = originalRename;
    }
    assert.deepEqual(restored, [".pi-auto-compaction-manifest.json", "omniroute-compaction.ts", "settings.json"]);
    assert.deepEqual(managedSnapshot(), before);
    assert.equal(fs.existsSync(path.join(targetAgentDir, ".pi-auto-compaction-state", "recovery-journal.json")), false);
    assert.equal(fs.existsSync(path.join(targetAgentDir, ".pi-auto-compaction.lock")), false);
  });

  it("foreign loader appearing during compensation publication is never overwritten", () => {
    runSetup({ agentDir: targetAgentDir, packageSourceDir: mockPkgSourceDir });
    const before = managedSnapshot();
    const loader = path.join(targetAgentDir, "extensions", "omniroute-compaction.ts");
    const originalLink = fs.linkSync;
    try {
      assert.throws(() => runRollback({
        agentDir: targetAgentDir,
        _testAfterOperation: (op) => {
          if (op !== "loader-removal") return;
          fs.linkSync = (source, target) => {
            if (target === loader) fs.writeFileSync(loader, "// foreign concurrent loader");
            return originalLink(source, target);
          };
          throw new Error("Injected post-loader deletion failure");
        },
      }), /Injected post-loader deletion failure/);
    } finally {
      fs.linkSync = originalLink;
    }
    assert.equal(fs.readFileSync(loader, "utf-8"), "// foreign concurrent loader");
    assert.deepEqual(fs.readFileSync(settingsFile), before[settingsFile]);
    assert.equal(fs.readdirSync(path.dirname(loader)).some((file) => file.includes(".restore.")), false);
    assertRefusedUnchanged(/Pending recovery journal/i);
  });

  it("runSetup creates backup, writes manifest, merges overrides preserving extra keys", () => {
    const result = runSetup({
      agentDir: targetAgentDir,
      packageSourceDir: mockPkgSourceDir,
    });

    assert.ok(result.success);
    assert.ok(result.backupCreated);

    // Verify manifest was created
    const manifestPath = path.join(targetAgentDir, ".pi-auto-compaction-manifest.json");
    assert.ok(fs.existsSync(manifestPath), "Manifest file must exist");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    assert.equal(manifest.originalOverrides["openai-codex/gpt-6-sol"].present, true);
    assert.equal(manifest.originalOverrides["openai-codex/gpt-6-sol"].value.reserveTokens, 30000);
    assert.ok(manifest.loaderHash, "Manifest must record loader hash");

    // Check settings.json
    const updatedSettings = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
    assert.equal(updatedSettings.compaction.modelOverrides["openai-codex/gpt-6-sol"].reserveTokens, 65536);
    assert.equal(
      updatedSettings.compaction.modelOverrides["openai-codex/gpt-6-sol"].customUserField,
      "keep-me",
      "Must preserve custom extra keys under target model",
    );
  });

  it("refuses setup when compaction.enabled is false unless explicitly allowed", () => {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({ compaction: { enabled: false } }, null, 2),
    );

    assert.throws(
      () =>
        runSetup({
          agentDir: targetAgentDir,
          packageSourceDir: mockPkgSourceDir,
        }),
      /Compaction is disabled in settings.json/,
    );

    // Succeeds with explicit allowDisabled flag
    const res = runSetup({
      agentDir: targetAgentDir,
      packageSourceDir: mockPkgSourceDir,
      allowDisabled: true,
    });
    assert.ok(res.success);
  });

  it("refuses setup on malformed JSON without corrupting settings", () => {
    fs.writeFileSync(settingsFile, "{ invalid json content !!!");
    assert.throws(
      () =>
        runSetup({
          agentDir: targetAgentDir,
          packageSourceDir: mockPkgSourceDir,
        }),
      /Failed to parse existing settings.json/,
    );
    // Content left unchanged
    assert.equal(fs.readFileSync(settingsFile, "utf-8"), "{ invalid json content !!!");
  });

  it("runRollback restores original baseline values from manifest and preserves user edits", () => {
    // 1. Run setup
    runSetup({
      agentDir: targetAgentDir,
      packageSourceDir: mockPkgSourceDir,
    });

    // 2. Simulate user modifying unrelated settings afterward
    const midSettings = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
    midSettings.newUnrelatedSetting = "important";
    fs.writeFileSync(settingsFile, JSON.stringify(midSettings, null, 2));

    // 3. Run rollback
    const rollbackRes = runRollback({ agentDir: targetAgentDir });
    assert.ok(rollbackRes.success);

    const revertedSettings = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
    assert.equal(revertedSettings.newUnrelatedSetting, "important", "User settings must be preserved");

    // Pre-existing model was restored to its original value (30000) rather than being deleted!
    assert.equal(
      revertedSettings.compaction.modelOverrides["openai-codex/gpt-6-sol"].reserveTokens,
      30000,
      "Original reserveTokens must be restored",
    );
    assert.equal(
      revertedSettings.compaction.modelOverrides["openai-codex/gpt-6-sol"].customUserField,
      "keep-me",
      "Original customUserField must be preserved",
    );

    // Newly added model overrides (which were not originally present) are removed
    assert.equal(revertedSettings.compaction.modelOverrides["openai/gpt-6-sol"], undefined);

    // Loader and manifest removed
    assert.equal(fs.existsSync(path.join(targetAgentDir, "extensions", "omniroute-compaction.ts")), false);
    assert.equal(fs.existsSync(path.join(targetAgentDir, ".pi-auto-compaction-manifest.json")), false);
  });

  it("fails rollback closed when loader extension was modified by user without force", () => {
    runSetup({
      agentDir: targetAgentDir,
      packageSourceDir: mockPkgSourceDir,
    });

    // Tamper with loader extension
    const loaderPath = path.join(targetAgentDir, "extensions", "omniroute-compaction.ts");
    fs.writeFileSync(loaderPath, "// User modified content");

    assert.throws(
      () => runRollback({ agentDir: targetAgentDir }),
      /Loader extension was modified externally/,
    );
  });

  it("fails setup closed when existing settings root is an array or invalid shape", () => {
    fs.writeFileSync(settingsFile, JSON.stringify(["not", "an", "object"]));
    assert.throws(
      () =>
        runSetup({
          agentDir: targetAgentDir,
          packageSourceDir: mockPkgSourceDir,
        }),
      /Invalid settings.json: root must be a non-null object/,
    );
  });

  it("fails setup closed when existing manifest is malformed, never resetting baseline", () => {
    const manifestPath = path.join(targetAgentDir, ".pi-auto-compaction-manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify({ malformed: "no managedModels" }));

    assert.throws(
      () =>
        runSetup({
          agentDir: targetAgentDir,
          packageSourceDir: mockPkgSourceDir,
        }),
      /Invalid or corrupt manifest/,
    );
  });

  it("fails setup closed before any writes if an unmanaged loader exists without manifest", () => {
    const extDir = path.join(targetAgentDir, "extensions");
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(path.join(extDir, "omniroute-compaction.ts"), "// Unrelated loader by user");

    assert.throws(
      () =>
        runSetup({
          agentDir: targetAgentDir,
          packageSourceDir: mockPkgSourceDir,
        }),
      /Loader extension already exists without valid manifest/,
    );
  });

  it("fails setup closed with lock error when concurrent installation is in progress", () => {
    const lockFile = path.join(targetAgentDir, ".pi-auto-compaction.lock");
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, timestamp: Date.now() }));

    assert.throws(
      () =>
        runSetup({
          agentDir: targetAgentDir,
          packageSourceDir: mockPkgSourceDir,
        }),
      /Installation lock active/,
    );
  });

  it("detects concurrent settings mutation before commit and refuses to clobber external changes", () => {
    assert.throws(
      () =>
        runSetup({
          agentDir: targetAgentDir,
          packageSourceDir: mockPkgSourceDir,
          _testInjectConcurrentSettingsMutation: () => {
            fs.writeFileSync(
              settingsFile,
              JSON.stringify({ concurrentUserEdit: true }),
            );
          },
        }),
      /Conflict: settings.json was modified concurrently/,
    );
  });

  it("rollback preserves originally absent target entry that user later added extra keys to", () => {
    // 1. Run setup with clean baseline
    runSetup({
      agentDir: targetAgentDir,
      packageSourceDir: mockPkgSourceDir,
    });

    // 2. User added a custom key to a model that was originally absent (e.g. openai/gpt-6-sol)
    const midSettings = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
    midSettings.compaction.modelOverrides["openai/gpt-6-sol"].userCustomKey = "keep-me";
    fs.writeFileSync(settingsFile, JSON.stringify(midSettings, null, 2));

    // 3. Rollback
    runRollback({ agentDir: targetAgentDir });

    const reverted = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
    // Managed fields reserveTokens and keepRecentTokens removed, but userCustomKey retained!
    assert.equal(reverted.compaction.modelOverrides["openai/gpt-6-sol"]?.userCustomKey, "keep-me");
    assert.equal(reverted.compaction.modelOverrides["openai/gpt-6-sol"]?.reserveTokens, undefined);
    assert.equal(reverted.compaction.modelOverrides["openai/gpt-6-sol"]?.keepRecentTokens, undefined);
  });

  it("escapes package source path using JSON.stringify in generated loader preventing code injection", () => {
    const specialSourceDir = path.join(tempHome, 'test"dir;console.log(1)');
    fs.mkdirSync(specialSourceDir, { recursive: true });
    fs.writeFileSync(path.join(specialSourceDir, "index.mjs"), "export default function() {}");

    runSetup({
      agentDir: targetAgentDir,
      packageSourceDir: specialSourceDir,
    });

    const loaderContent = fs.readFileSync(path.join(targetAgentDir, "extensions", "omniroute-compaction.ts"), "utf-8");
    // Path must be safely quoted as a JSON string literal
    assert.ok(loaderContent.includes(JSON.stringify(path.join(specialSourceDir, "index.mjs"))));
  });

  it("rollback absent manifest / no loader preserves existing target config byte-for-byte", () => {
    const rawBefore = fs.readFileSync(settingsFile, "utf-8");
    const result = runRollback({ agentDir: targetAgentDir });
    assert.ok(result.success);
    assert.equal(result.modifiedSettings, false);
    const rawAfter = fs.readFileSync(settingsFile, "utf-8");
    assert.equal(rawAfter, rawBefore, "settings.json must remain byte-for-byte identical");
  });

  it("absent manifest with loader rejects rollback and never deletes unknown ownership", () => {
    const extDir = path.join(targetAgentDir, "extensions");
    fs.mkdirSync(extDir, { recursive: true });
    const loaderPath = path.join(extDir, "omniroute-compaction.ts");
    fs.writeFileSync(loaderPath, "// Unmanaged loader");

    assert.throws(
      () => runRollback({ agentDir: targetAgentDir }),
      /Loader exists at .* but manifest is missing|unmanaged/i,
    );
    assert.throws(
      () => runRollback({ agentDir: targetAgentDir, force: true }),
      /force|unknown ownership|refused/i,
    );
    assert.ok(fs.existsSync(loaderPath), "Loader must not be deleted");
  });

  it("corrupt baseline null/array/missing/version reject and never recapture baseline", () => {
    const manifestPath = path.join(targetAgentDir, ".pi-auto-compaction-manifest.json");

    // Case a: baseline is null
    fs.writeFileSync(manifestPath, JSON.stringify({ version: "1.0.0", managedModels: ["openai/gpt-6-sol"], originalOverrides: null, loaderHash: "abc" }));
    assert.throws(() => runSetup({ agentDir: targetAgentDir, packageSourceDir: mockPkgSourceDir }), /manifest/i);

    // Case b: baseline is array
    fs.writeFileSync(manifestPath, JSON.stringify({ version: "1.0.0", managedModels: ["openai/gpt-6-sol"], originalOverrides: [], loaderHash: "abc" }));
    assert.throws(() => runSetup({ agentDir: targetAgentDir, packageSourceDir: mockPkgSourceDir }), /manifest/i);

    // Case c: baseline missing managed model entry
    fs.writeFileSync(manifestPath, JSON.stringify({ version: "1.0.0", managedModels: ["openai/gpt-6-sol", "openai/gpt-6.1-sol", "openai-codex/gpt-6-sol", "openai-codex/gpt-6.1-sol"], originalOverrides: {}, loaderHash: "abc" }));
    assert.throws(() => runSetup({ agentDir: targetAgentDir, packageSourceDir: mockPkgSourceDir }), /manifest/i);

    // Case d: unknown version
    fs.writeFileSync(manifestPath, JSON.stringify({ version: "9.9.9", managedModels: ["openai/gpt-6-sol"], originalOverrides: {}, loaderHash: "abc" }));
    assert.throws(() => runSetup({ agentDir: targetAgentDir, packageSourceDir: mockPkgSourceDir }), /manifest|version/i);
  });

  it("settings target drift refuses setup & rollback unchanged", () => {
    const pkgDir = path.join(tempHome, "src-pkg");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "index.mjs"), "export default function() {}");

    // 1. Initial setup
    runSetup({ agentDir: targetAgentDir, packageSourceDir: pkgDir });

    // 2. Introduce drift in target model managed values (e.g. user manually changed reserveTokens to 50000)
    const settings = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
    settings.compaction.modelOverrides["openai-codex/gpt-6-sol"].reserveTokens = 50000;
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
    const snapshotBefore = fs.readFileSync(settingsFile, "utf-8");

    // Reinstall should refuse due to drift
    assert.throws(() => runSetup({ agentDir: targetAgentDir, packageSourceDir: pkgDir }), /drift/i);
    assert.equal(fs.readFileSync(settingsFile, "utf-8"), snapshotBefore);

    // Rollback should also refuse due to drift
    assert.throws(() => runRollback({ agentDir: targetAgentDir }), /drift/i);
    assert.equal(fs.readFileSync(settingsFile, "utf-8"), snapshotBefore);
  });

  it("loader+manifest changed or removed in beforeCommit refuses", () => {
    const pkgDir = path.join(tempHome, "src-pkg");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "index.mjs"), "export default function() {}");

    // Setup first
    runSetup({ agentDir: targetAgentDir, packageSourceDir: pkgDir });
    const loaderPath = path.join(targetAgentDir, "extensions", "omniroute-compaction.ts");
    const manifestPath = path.join(targetAgentDir, ".pi-auto-compaction-manifest.json");

    // Reinstall with beforeCommit tampering loader
    assert.throws(
      () =>
        runSetup({
          agentDir: targetAgentDir,
          packageSourceDir: pkgDir,
          beforeCommit: () => {
            fs.writeFileSync(loaderPath, "// tampered in hook");
          },
        }),
      /concurrent|conflict/i,
    );

    // Reinstall with beforeCommit removing manifest
    assert.throws(
      () =>
        runSetup({
          agentDir: targetAgentDir,
          packageSourceDir: pkgDir,
          beforeCommit: () => {
            fs.rmSync(manifestPath);
          },
        }),
      /concurrent|conflict/i,
    );
  });

  it("initially absent settings appears or deleted existing detected in beforeCommit", () => {
    const pkgDir = path.join(tempHome, "src-pkg");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "index.mjs"), "export default function() {}");

    // Case 1: settings existed initially, deleted during beforeCommit
    assert.throws(
      () =>
        runSetup({
          agentDir: targetAgentDir,
          packageSourceDir: pkgDir,
          beforeCommit: () => {
            fs.rmSync(settingsFile);
          },
        }),
      /concurrent|conflict/i,
    );

    // Case 2: fresh agentDir where settings.json did NOT exist initially
    const freshAgentDir = path.join(tempHome, "fresh-agent");
    fs.mkdirSync(freshAgentDir, { recursive: true });
    const freshSettings = path.join(freshAgentDir, "settings.json");

    assert.throws(
      () =>
        runSetup({
          agentDir: freshAgentDir,
          packageSourceDir: pkgDir,
          beforeCommit: () => {
            fs.writeFileSync(freshSettings, JSON.stringify({ appearedConcurrently: true }));
          },
        }),
      /concurrent|conflict/i,
    );
  });

  it("rollback keeps new extra keys and preserves originally present empty object", () => {
    const pkgDir = path.join(tempHome, "src-pkg");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "index.mjs"), "export default function() {}");

    // Pre-create settings where openai/gpt-6-sol is present and empty {}
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          compaction: {
            enabled: true,
            modelOverrides: {
              "openai/gpt-6-sol": {}, // originally present and empty
            },
          },
        },
        null,
        2,
      ),
    );

    runSetup({ agentDir: targetAgentDir, packageSourceDir: pkgDir });
    runRollback({ agentDir: targetAgentDir });

    const restored = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
    assert.ok(
      Object.prototype.hasOwnProperty.call(restored.compaction.modelOverrides, "openai/gpt-6-sol"),
      "Originally present empty model override must remain present and empty",
    );
    assert.deepEqual(restored.compaction.modelOverrides["openai/gpt-6-sol"], {});
  });

  it("reinstall preserves original baseline across repeated setups", () => {
    const pkgDir = path.join(tempHome, "src-pkg");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "index.mjs"), "export default function() {}");

    // 1. Initial setup
    runSetup({ agentDir: targetAgentDir, packageSourceDir: pkgDir });

    // 2. Reinstall (setup again)
    runSetup({ agentDir: targetAgentDir, packageSourceDir: pkgDir });

    // 3. Rollback
    runRollback({ agentDir: targetAgentDir });

    const restored = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
    assert.equal(
      restored.compaction.modelOverrides["openai-codex/gpt-6-sol"].reserveTokens,
      30000,
      "Original baseline (30000) must survive reinstallation intact",
    );
  });

  it("failure mid setup compensated or journal retained safely", () => {
    const pkgDir = path.join(tempHome, "src-pkg");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "index.mjs"), "export default function() {}");

    const settingsSnapshot = fs.readFileSync(settingsFile, "utf-8");

    // Injected failure at loader write (after settings write)
    assert.throws(
      () =>
        runSetup({
          agentDir: targetAgentDir,
          packageSourceDir: pkgDir,
          _testInjectFailureAt: "at-loader-write",
        }),
      /injected failure/i,
    );

    // Settings must be restored back to snapshot or journal retained fail-closed
    assert.equal(fs.readFileSync(settingsFile, "utf-8"), settingsSnapshot);

    // Injected failure at manifest write (after loader write)
    assert.throws(
      () =>
        runSetup({
          agentDir: targetAgentDir,
          packageSourceDir: pkgDir,
          _testInjectFailureAt: "at-manifest-write",
        }),
      /injected failure/i,
    );
    assert.equal(fs.readFileSync(settingsFile, "utf-8"), settingsSnapshot);
    assert.equal(fs.existsSync(path.join(targetAgentDir, "extensions", "omniroute-compaction.ts")), false);
  });

  it("failure rollback preserves baseline", () => {
    const pkgDir = path.join(tempHome, "src-pkg");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "index.mjs"), "export default function() {}");

    runSetup({ agentDir: targetAgentDir, packageSourceDir: pkgDir });

    const manifestPath = path.join(targetAgentDir, ".pi-auto-compaction-manifest.json");
    const manifestSnapshot = fs.readFileSync(manifestPath, "utf-8");

    assert.throws(
      () =>
        runRollback({
          agentDir: targetAgentDir,
          _testInjectFailureAt: "before-loader-removal",
        }),
      /injected failure/i,
    );

    // Manifest and baseline must not be lost
    assert.ok(fs.existsSync(manifestPath), "Manifest must be preserved on rollback failure");
    assert.equal(fs.readFileSync(manifestPath, "utf-8"), manifestSnapshot);
  });

  it("backup and journal permissions assert stateDir 0700 and files 0600 without touching agentDir", () => {
    const pkgDir = path.join(tempHome, "src-pkg");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "index.mjs"), "export default function() {}");

    // Make agentDir with permissions 0755
    fs.chmodSync(targetAgentDir, 0o755);

    runSetup({ agentDir: targetAgentDir, packageSourceDir: pkgDir });

    // Pre-existing agentDir permissions must remain untouched (0755)
    const agentStat = fs.statSync(targetAgentDir);
    assert.equal(agentStat.mode & 0o777, 0o755, "Preexisting agentDir mode must not be changed");

    // State dir must exist and have 0700 permissions
    const stateDir = path.join(targetAgentDir, ".pi-auto-compaction-state");
    assert.ok(fs.existsSync(stateDir), "Dedicated stateDir must exist");
    const stateStat = fs.statSync(stateDir);
    assert.equal(stateStat.mode & 0o777, 0o700, "State dir mode must be 0700");

    // Backups inside stateDir must have 0600 permissions
    const backupFiles = fs.readdirSync(stateDir).filter((f) => f.startsWith("settings.bak"));
    assert.ok(backupFiles.length > 0, "Private backup must exist inside stateDir");
    for (const b of backupFiles) {
      const bStat = fs.statSync(path.join(stateDir, b));
      assert.equal(bStat.mode & 0o777, 0o600, "Backup file mode must be 0600");
    }

    // No world-readable settings.bak.* in root agentDir
    const agentFiles = fs.readdirSync(targetAgentDir);
    assert.ok(!agentFiles.some((f) => f.includes("settings.bak")), "No backup files allowed in root agentDir");
  });

  it("fails when CLI arguments are missing required values", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    const setupScript = path.resolve("scripts/setup.mjs");
    const rollbackScript = path.resolve("scripts/rollback.mjs");

    await assert.rejects(
      execFileAsync(process.execPath, [setupScript, "--target-dir"]),
      /Missing value for --target-dir/,
    );
    await assert.rejects(
      execFileAsync(process.execPath, [setupScript, "--source-dir"]),
      /Missing value for --source-dir/,
    );
    await assert.rejects(
      execFileAsync(process.execPath, [rollbackScript, "--target-dir"]),
      /Missing value for --target-dir/,
    );
  });

  it("rejects subsequent setup and rollback fail-closed when pending recovery journal exists", () => {
    const stateDir = path.join(targetAgentDir, ".pi-auto-compaction-state");
    fs.mkdirSync(stateDir, { recursive: true });
    const journalFile = path.join(stateDir, "recovery-journal.json");
    fs.writeFileSync(journalFile, JSON.stringify({ operation: "interrupted" }));

    assert.throws(
      () =>
        runSetup({
          agentDir: targetAgentDir,
          packageSourceDir: mockPkgSourceDir,
        }),
      /Pending recovery journal exists.*Setup refused fail-closed/i,
    );

    assert.throws(
      () =>
        runRollback({
          agentDir: targetAgentDir,
        }),
      /Pending recovery journal exists.*Rollback refused fail-closed/i,
    );
  });

  it("manifest validation enforces complete strict baseline schema rejecting invalid hashes, paths, targets and token values", () => {
    const validLoaderHash = "a".repeat(64);
    const policies = {};
    const originalOverrides = {};
    for (const m of MANAGED_MODELS) {
      policies[m] = { ...MANAGED_POLICIES[m] };
      originalOverrides[m] = {
        present: false,
        reserveTokens: { present: false, value: undefined },
        keepRecentTokens: { present: false, value: undefined },
        originalEmpty: false,
        value: null,
      };
    }
    originalOverrides["openai-codex/gpt-6-sol"] = {
      present: true,
      reserveTokens: { present: true, value: 30000 },
      keepRecentTokens: { present: false, value: undefined },
      originalEmpty: false,
      value: { reserveTokens: 30000 },
    };

    const validManifest = {
      version: EXPECTED_MANIFEST_VERSION,
      installedAt: new Date().toISOString(),
      packageSourceDir: mockPkgSourceDir,
      loaderPath: path.join(targetAgentDir, "extensions", "omniroute-compaction.ts"),
      loaderHash: validLoaderHash,
      managedModels: [...MANAGED_MODELS],
      policies,
      originalOverrides,
    };

    // Valid manifest must not throw
    assert.doesNotThrow(() => validateManifest(validManifest));

    // Invalid loaderHash (not 64-hex SHA-256)
    assert.throws(() => validateManifest({ ...validManifest, loaderHash: "abc" }), /loaderHash/i);
    assert.throws(() => validateManifest({ ...validManifest, loaderHash: "z".repeat(64) }), /loaderHash/i);
    assert.throws(() => validateManifest({ ...validManifest, loaderHash: "a".repeat(63) }), /loaderHash/i);
    assert.throws(() => validateManifest({ ...validManifest, loaderHash: "a".repeat(65) }), /loaderHash/i);

    // Missing or invalid packageSourceDir or loaderPath
    assert.throws(() => validateManifest({ ...validManifest, packageSourceDir: "" }), /packageSourceDir/i);
    assert.throws(() => validateManifest({ ...validManifest, packageSourceDir: 123 }), /packageSourceDir/i);
    assert.throws(() => validateManifest({ ...validManifest, loaderPath: "" }), /loaderPath/i);
    assert.throws(() => validateManifest({ ...validManifest, loaderPath: null }), /loaderPath/i);

    // Invalid managedModels identity
    assert.throws(() => validateManifest({ ...validManifest, managedModels: ["openai/gpt-6-sol"] }), /managedModels/i);
    assert.throws(() => validateManifest({ ...validManifest, managedModels: [...MANAGED_MODELS, "extra/model"] }), /managedModels/i);
    assert.throws(() => validateManifest({ ...validManifest, managedModels: ["bad/1", "bad/2", "bad/3", "bad/4"] }), /managedModels/i);

    // Corrupt baseline originalOverrides
    assert.throws(() => validateManifest({ ...validManifest, originalOverrides: null }), /originalOverrides/i);
    assert.throws(() => validateManifest({ ...validManifest, originalOverrides: {} }), /missing baseline|originalOverrides/i);

    // Corrupt target present field
    const corruptPresent = JSON.parse(JSON.stringify(validManifest));
    corruptPresent.originalOverrides["openai-codex/gpt-6-sol"].present = "yes";
    assert.throws(() => validateManifest(corruptPresent), /corrupt baseline/i);

    // Corrupt negative or non-integer token values
    const negativeTokens = JSON.parse(JSON.stringify(validManifest));
    negativeTokens.originalOverrides["openai-codex/gpt-6-sol"].reserveTokens.value = -1;
    assert.throws(() => validateManifest(negativeTokens), /reserveTokens/i);

    const floatTokens = JSON.parse(JSON.stringify(validManifest));
    floatTokens.originalOverrides["openai-codex/gpt-6-sol"].reserveTokens.value = 16384.5;
    assert.throws(() => validateManifest(floatTokens), /reserveTokens/i);

    const stringTokens = JSON.parse(JSON.stringify(validManifest));
    stringTokens.originalOverrides["openai-codex/gpt-6-sol"].reserveTokens.value = "30000";
    assert.throws(() => validateManifest(stringTokens), /reserveTokens/i);

    const negativeKeepRecent = JSON.parse(JSON.stringify(validManifest));
    negativeKeepRecent.originalOverrides["openai-codex/gpt-6-sol"].keepRecentTokens = { present: true, value: -10 };
    assert.throws(() => validateManifest(negativeKeepRecent), /keepRecentTokens/i);

    // Absent target with tokens present
    const absentWithTokens = JSON.parse(JSON.stringify(validManifest));
    absentWithTokens.originalOverrides["openai/gpt-6-sol"].reserveTokens = { present: true, value: 5000 };
    assert.throws(() => validateManifest(absentWithTokens), /tokens|absent/i);
  });

  it("both setup and rollback refuse corrupt baselines keeping all files byte-identical", () => {
    runSetup({ agentDir: targetAgentDir, packageSourceDir: mockPkgSourceDir });

    const manifestFile = path.join(targetAgentDir, ".pi-auto-compaction-manifest.json");
    const loaderPath = path.join(targetAgentDir, "extensions", "omniroute-compaction.ts");

    // Introduce corruption into manifest baseline: negative token value
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf-8"));
    manifest.originalOverrides["openai-codex/gpt-6-sol"].reserveTokens.value = -999;
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));

    const manifestBefore = fs.readFileSync(manifestFile, "utf-8");
    const settingsBefore = fs.readFileSync(settingsFile, "utf-8");
    const loaderBefore = fs.readFileSync(loaderPath, "utf-8");

    // Setup reinstall must refuse corrupt baseline fail-closed
    assert.throws(
      () => runSetup({ agentDir: targetAgentDir, packageSourceDir: mockPkgSourceDir }),
      /corrupt|invalid|reserveTokens/i,
    );
    assert.equal(fs.readFileSync(manifestFile, "utf-8"), manifestBefore);
    assert.equal(fs.readFileSync(settingsFile, "utf-8"), settingsBefore);
    assert.equal(fs.readFileSync(loaderPath, "utf-8"), loaderBefore);

    // Rollback must also refuse corrupt baseline fail-closed
    assert.throws(
      () => runRollback({ agentDir: targetAgentDir }),
      /corrupt|invalid|reserveTokens/i,
    );
    assert.equal(fs.readFileSync(manifestFile, "utf-8"), manifestBefore);
    assert.equal(fs.readFileSync(settingsFile, "utf-8"), settingsBefore);
    assert.equal(fs.readFileSync(loaderPath, "utf-8"), loaderBefore);
  });

  it("rollback detects drift and refuses when loader is missing externally", () => {
    runSetup({ agentDir: targetAgentDir, packageSourceDir: mockPkgSourceDir });

    const loaderPath = path.join(targetAgentDir, "extensions", "omniroute-compaction.ts");
    fs.rmSync(loaderPath);

    const settingsBefore = fs.readFileSync(settingsFile, "utf-8");
    assert.throws(
      () => runRollback({ agentDir: targetAgentDir }),
      /drift|removed externally/i,
    );
    assert.equal(fs.readFileSync(settingsFile, "utf-8"), settingsBefore);
  });

  it("rollback detects drift and refuses when compaction overrides or managed models are removed or fields are undefined", () => {
    runSetup({ agentDir: targetAgentDir, packageSourceDir: mockPkgSourceDir });

    // Case a: compaction.modelOverrides removed
    const s1 = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
    delete s1.compaction.modelOverrides;
    fs.writeFileSync(settingsFile, JSON.stringify(s1, null, 2));
    assert.throws(() => runRollback({ agentDir: targetAgentDir }), /drift/i);

    // Restore and Case b: managed model removed
    const s2 = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
    s2.compaction.modelOverrides = {};
    for (const m of MANAGED_MODELS) {
      s2.compaction.modelOverrides[m] = { ...MANAGED_POLICIES[m] };
    }
    delete s2.compaction.modelOverrides["openai-codex/gpt-6-sol"];
    fs.writeFileSync(settingsFile, JSON.stringify(s2, null, 2));
    assert.throws(() => runRollback({ agentDir: targetAgentDir }), /drift|removed externally/i);

    // Restore and Case c: owned field reserveTokens removed (undefined)
    const s3 = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
    s3.compaction.modelOverrides["openai-codex/gpt-6-sol"] = { ...MANAGED_POLICIES["openai-codex/gpt-6-sol"] };
    delete s3.compaction.modelOverrides["openai-codex/gpt-6-sol"].reserveTokens;
    fs.writeFileSync(settingsFile, JSON.stringify(s3, null, 2));
    assert.throws(() => runRollback({ agentDir: targetAgentDir }), /drift|reserveTokens/i);

    // Restore and Case d: owned field keepRecentTokens removed (undefined)
    const s4 = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
    s4.compaction.modelOverrides["openai-codex/gpt-6-sol"].reserveTokens = MANAGED_POLICIES["openai-codex/gpt-6-sol"].reserveTokens;
    delete s4.compaction.modelOverrides["openai-codex/gpt-6-sol"].keepRecentTokens;
    fs.writeFileSync(settingsFile, JSON.stringify(s4, null, 2));
    assert.throws(() => runRollback({ agentDir: targetAgentDir }), /drift|keepRecentTokens/i);
  });

  it("setup reinstall detects drift and refuses when loader is missing externally even with manifest present", () => {
    runSetup({ agentDir: targetAgentDir, packageSourceDir: mockPkgSourceDir });

    const loaderPath = path.join(targetAgentDir, "extensions", "omniroute-compaction.ts");
    fs.rmSync(loaderPath);

    const settingsBefore = fs.readFileSync(settingsFile, "utf-8");
    assert.throws(
      () => runSetup({ agentDir: targetAgentDir, packageSourceDir: mockPkgSourceDir }),
      /drift|removed externally/i,
    );
    assert.equal(fs.readFileSync(settingsFile, "utf-8"), settingsBefore);
  });

  it("rollback restores completed operations in reverse sequence on failure after loader removal with journal cleanliness and lock release", () => {
    runSetup({ agentDir: targetAgentDir, packageSourceDir: mockPkgSourceDir });

    const loaderPath = path.join(targetAgentDir, "extensions", "omniroute-compaction.ts");
    const manifestFile = path.join(targetAgentDir, ".pi-auto-compaction-manifest.json");
    const stateDir = path.join(targetAgentDir, ".pi-auto-compaction-state");
    const journalPath = path.join(stateDir, "recovery-journal.json");
    const lockPath = path.join(targetAgentDir, ".pi-auto-compaction.lock");

    const loaderSnapshot = fs.readFileSync(loaderPath, "utf-8");
    const manifestSnapshot = fs.readFileSync(manifestFile, "utf-8");
    const settingsSnapshot = fs.readFileSync(settingsFile, "utf-8");

    assert.throws(
      () =>
        runRollback({
          agentDir: targetAgentDir,
          _testAfterOperation: (op) => {
            if (op === "loader-removal") {
              assert.equal(fs.existsSync(loaderPath), false, "Failure must follow actual deletion");
              throw new Error("injected failure after loader deletion");
            }
          },
        }),
      /injected failure after loader deletion/i,
    );

    // Loader must be restored from pre-operation snapshot
    assert.ok(fs.existsSync(loaderPath), "Loader must be restored on rollback failure");
    assert.equal(fs.readFileSync(loaderPath, "utf-8"), loaderSnapshot);

    // Settings must be restored from pre-operation snapshot
    assert.equal(fs.readFileSync(settingsFile, "utf-8"), settingsSnapshot);

    // Manifest was not deleted, must match snapshot
    assert.ok(fs.existsSync(manifestFile), "Manifest must be preserved");
    assert.equal(fs.readFileSync(manifestFile, "utf-8"), manifestSnapshot);

    // Recovery journal must be clean
    assert.equal(fs.existsSync(journalPath), false, "Journal must be deleted on clean compensation");

    // Lock must be released
    assert.equal(fs.existsSync(lockPath), false, "Lock must be released on failure");
  });

  it("rollback preserves foreign replacement at loader path and retains recovery journal on failure", () => {
    runSetup({ agentDir: targetAgentDir, packageSourceDir: mockPkgSourceDir });

    const loaderPath = path.join(targetAgentDir, "extensions", "omniroute-compaction.ts");
    const stateDir = path.join(targetAgentDir, ".pi-auto-compaction-state");
    const journalPath = path.join(stateDir, "recovery-journal.json");
    const lockPath = path.join(targetAgentDir, ".pi-auto-compaction.lock");

    assert.throws(
      () =>
        runRollback({
          agentDir: targetAgentDir,
          _testAfterOperation: (op) => {
            if (op === "loader-removal") {
              fs.writeFileSync(loaderPath, "// foreign loader content");
              throw new Error("injected failure after foreign loader creation");
            }
          },
        }),
      /injected failure after foreign loader creation/i,
    );

    // Foreign replacement at loaderPath must be preserved
    assert.ok(fs.existsSync(loaderPath));
    assert.equal(fs.readFileSync(loaderPath, "utf-8"), "// foreign loader content");

    // Recovery journal must be retained because foreign replacement appeared
    assert.ok(fs.existsSync(journalPath), "Recovery journal must be retained when foreign file appears");

    // Lock must still be released
    assert.equal(fs.existsSync(lockPath), false, "Lock must be released");
    assert.equal(fs.statSync(stateDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(journalPath).mode & 0o777, 0o600);
    assertRefusedUnchanged(/Pending recovery journal/i);
  });

  it("rollback restores completed operations in reverse sequence on failure after manifest removal", () => {
    runSetup({ agentDir: targetAgentDir, packageSourceDir: mockPkgSourceDir });

    const loaderPath = path.join(targetAgentDir, "extensions", "omniroute-compaction.ts");
    const manifestFile = path.join(targetAgentDir, ".pi-auto-compaction-manifest.json");
    const stateDir = path.join(targetAgentDir, ".pi-auto-compaction-state");
    const journalPath = path.join(stateDir, "recovery-journal.json");
    const lockPath = path.join(targetAgentDir, ".pi-auto-compaction.lock");

    const loaderSnapshot = fs.readFileSync(loaderPath, "utf-8");
    const manifestSnapshot = fs.readFileSync(manifestFile, "utf-8");
    const settingsSnapshot = fs.readFileSync(settingsFile, "utf-8");

    assert.throws(
      () =>
        runRollback({
          agentDir: targetAgentDir,
          _testAfterOperation: (op) => {
            if (op === "manifest-removal") {
              assert.equal(fs.existsSync(manifestFile), false, "Failure must follow actual deletion");
              assert.equal(fs.existsSync(loaderPath), false);
              throw new Error("injected failure after manifest deletion");
            }
          },
        }),
      /injected failure after manifest deletion/i,
    );

    // Manifest must be restored
    assert.ok(fs.existsSync(manifestFile), "Manifest must be restored on rollback failure");
    assert.equal(fs.readFileSync(manifestFile, "utf-8"), manifestSnapshot);

    // Loader must be restored
    assert.ok(fs.existsSync(loaderPath), "Loader must be restored on rollback failure");
    assert.equal(fs.readFileSync(loaderPath, "utf-8"), loaderSnapshot);

    // Settings must be restored
    assert.equal(fs.readFileSync(settingsFile, "utf-8"), settingsSnapshot);

    // Journal must be cleaned up
    assert.equal(fs.existsSync(journalPath), false, "Journal must be deleted on clean compensation");

    // Lock must be released
    assert.equal(fs.existsSync(lockPath), false, "Lock must be released");
  });

  it("rollback preserves foreign replacement at manifest path and retains recovery journal on failure", () => {
    runSetup({ agentDir: targetAgentDir, packageSourceDir: mockPkgSourceDir });

    const manifestFile = path.join(targetAgentDir, ".pi-auto-compaction-manifest.json");
    const stateDir = path.join(targetAgentDir, ".pi-auto-compaction-state");
    const journalPath = path.join(stateDir, "recovery-journal.json");
    const lockPath = path.join(targetAgentDir, ".pi-auto-compaction.lock");

    assert.throws(
      () =>
        runRollback({
          agentDir: targetAgentDir,
          _testAfterOperation: (op) => {
            if (op === "manifest-removal") {
              fs.writeFileSync(manifestFile, JSON.stringify({ foreign: "manifest" }));
              throw new Error("injected failure after foreign manifest creation");
            }
          },
        }),
      /injected failure after foreign manifest creation/i,
    );

    // Foreign replacement at manifestFile must be preserved
    assertRefusedUnchanged(/Pending recovery journal/i);
    assert.ok(fs.existsSync(manifestFile));
    assert.equal(fs.readFileSync(manifestFile, "utf-8"), JSON.stringify({ foreign: "manifest" }));

    // Recovery journal must be retained because foreign replacement appeared
    assert.ok(fs.existsSync(journalPath), "Recovery journal must be retained when foreign file appears");

    // Lock must still be released
    assert.equal(fs.existsSync(lockPath), false, "Lock must be released");
  });

  it("setup computes trusted writer receipt before writes matching exact in-memory serialized hashes", () => {
    const result = runSetup({
      agentDir: targetAgentDir,
      packageSourceDir: mockPkgSourceDir,
      receiptNonce: "nonce-12345",
    });

    assert.ok(result.receipt, "Setup result must expose receipt");
    assert.equal(result.receipt.nonce, "nonce-12345");
    assert.equal(result.receipt.targetDir, targetAgentDir);
    assert.equal(result.receipt.packageSourceDir, mockPkgSourceDir);

    const manifestFile = path.join(targetAgentDir, ".pi-auto-compaction-manifest.json");
    const loaderFile = path.join(targetAgentDir, "extensions", "omniroute-compaction.ts");

    const manifestBytes = fs.readFileSync(manifestFile, "utf-8");
    const loaderBytes = fs.readFileSync(loaderFile, "utf-8");
    const settingsBytes = fs.readFileSync(settingsFile, "utf-8");

    assert.equal(result.receipt.manifestHash, hashContent(manifestBytes));
    assert.equal(result.receipt.loaderHash, hashContent(loaderBytes));
    assert.equal(result.receipt.settingsHash, hashContent(settingsBytes));
    assert.equal(result.receipt.installedAt, JSON.parse(manifestBytes).installedAt);
  });

  it("onReceipt prewrite hook receives sealed receipt before any file or journal writes", () => {
    let capturedReceipt = null;
    let manifestExistedAtReceipt = null;
    let journalExistedAtReceipt = null;

    runSetup({
      agentDir: targetAgentDir,
      packageSourceDir: mockPkgSourceDir,
      receiptNonce: "nonce-prewrite-hook",
      onReceipt: (receipt) => {
        capturedReceipt = receipt;
        const manifestFile = path.join(targetAgentDir, ".pi-auto-compaction-manifest.json");
        const journalFile = path.join(targetAgentDir, ".pi-auto-compaction-state", "recovery-journal.json");
        manifestExistedAtReceipt = fs.existsSync(manifestFile);
        journalExistedAtReceipt = fs.existsSync(journalFile);
      },
    });

    assert.ok(capturedReceipt, "onReceipt must be invoked with sealed receipt");
    assert.equal(capturedReceipt.nonce, "nonce-prewrite-hook");
    assert.equal(manifestExistedAtReceipt, false, "Manifest must not exist when onReceipt is invoked");
    assert.equal(journalExistedAtReceipt, false, "Journal must not exist when onReceipt is invoked");
  });

  it("setup.mjs CLI with --receipt-nonce emits delimited receipt to stdout before writes and remains backwards compatible without flag", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const setupScript = path.resolve("scripts/setup.mjs");

    const resWithNonce = await execFileAsync(process.execPath, [
      setupScript,
      "--target-dir",
      targetAgentDir,
      "--source-dir",
      mockPkgSourceDir,
      "--receipt-nonce",
      "cli-nonce-test",
    ]);

    assert.ok(
      resWithNonce.stdout.includes("---PI_AUTO_COMPACTION_SETUP_RECEIPT_START---"),
      "Stdout must include setup receipt start delimiter",
    );
    assert.ok(
      resWithNonce.stdout.includes("---PI_AUTO_COMPACTION_SETUP_RECEIPT_END---"),
      "Stdout must include setup receipt end delimiter",
    );

    const parsed = parseAndValidateReceipt(resWithNonce.stdout, {
      nonce: "cli-nonce-test",
      targetDir: targetAgentDir,
      packageSourceDir: mockPkgSourceDir,
    });
    assert.ok(parsed, "Parsed receipt must be valid");
    assert.equal(parsed.nonce, "cli-nonce-test");

    // Clean agent dir for backward compatibility test
    fs.rmSync(targetAgentDir, { recursive: true, force: true });
    fs.mkdirSync(targetAgentDir, { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify({ compaction: { enabled: true } }));

    const resWithoutNonce = await execFileAsync(process.execPath, [
      setupScript,
      "--target-dir",
      targetAgentDir,
      "--source-dir",
      mockPkgSourceDir,
    ]);

    assert.ok(
      !resWithoutNonce.stdout.includes("---PI_AUTO_COMPACTION_SETUP_RECEIPT_START---"),
      "Stdout without --receipt-nonce must not include receipt delimiter",
    );
    assert.ok(
      resWithoutNonce.stdout.includes("Setup completed successfully"),
      "Setup without --receipt-nonce must complete successfully",
    );
  });

  it("setup.mjs CLI fails when --receipt-nonce is missing a required value", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const setupScript = path.resolve("scripts/setup.mjs");

    await assert.rejects(
      execFileAsync(process.execPath, [setupScript, "--receipt-nonce"]),
      /Missing value for --receipt-nonce/,
    );
  });

  it("receipt hashes reflect intended in-memory bytes, unaffected by concurrent disk mutation between receipt and commit", () => {
    let receiptAtHook = null;
    let settingsBeforeCommit = null;
    let settingsAfterMutation = null;

    // Use beforeCommit to mutate settings AFTER receipt has been sealed and emitted
    // but BEFORE CAS verify runs. This should cause CAS to reject (Conflict),
    // but the receipt captured by onReceipt must still have the INTENDED hash.
    assert.throws(
      () =>
        runSetup({
          agentDir: targetAgentDir,
          packageSourceDir: mockPkgSourceDir,
          receiptNonce: "nonce-inmemory-proof",
          onReceipt: (receipt) => {
            receiptAtHook = receipt;
            // At this point: receipt is sealed, NO manifest/journal on disk yet
            settingsBeforeCommit = fs.existsSync(settingsFile)
              ? fs.readFileSync(settingsFile, "utf-8")
              : null;
          },
          beforeCommit: () => {
            // Mutate settings on disk AFTER receipt was sealed
            fs.writeFileSync(
              settingsFile,
              JSON.stringify({ concurrentMutation: true, tampered: Date.now() }),
            );
            settingsAfterMutation = fs.readFileSync(settingsFile, "utf-8");
          },
        }),
      /concurrent|conflict/i,
    );

    // Receipt MUST have been captured before disk mutation
    assert.ok(receiptAtHook, "onReceipt must have been invoked before beforeCommit");
    assert.equal(receiptAtHook.nonce, "nonce-inmemory-proof");

    // Receipt settingsHash must match the INTENDED in-memory bytes, NOT the mutated disk
    assert.notEqual(settingsBeforeCommit, settingsAfterMutation);
    assert.notEqual(
      receiptAtHook.settingsHash,
      hashContent(settingsAfterMutation),
      "Receipt must NOT reflect concurrent disk mutation",
    );

    // Receipt's three hashes must be valid 64-hex strings computed from in-memory serialization
    for (const field of ["manifestHash", "loaderHash", "settingsHash"]) {
      assert.match(receiptAtHook[field], /^[0-9a-f]{64}$/, `Receipt ${field} must be valid SHA-256 hex`);
    }
  });

  it("failed setup CLI emits receipt to stdout with strict nonce before the failure, recoverable by deploy receipt parser", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    // Create a fresh agent dir for injection test
    const freshAgent = path.join(tempHome, "fresh-agent-for-failure");
    fs.mkdirSync(freshAgent, { recursive: true });
    fs.writeFileSync(
      path.join(freshAgent, "settings.json"),
      JSON.stringify({ compaction: { enabled: true } }),
    );

    // Build setup script inline that uses _testInjectFailureAt to fail at loader write
    // This causes the child to throw AFTER receipt is emitted but DURING writes
    const setupScript = path.resolve("scripts/setup.mjs");
    const inlineCode = `import { runSetup } from ${JSON.stringify(new URL("file://" + setupScript).href)};
      runSetup(${JSON.stringify({
        agentDir: freshAgent,
        packageSourceDir: mockPkgSourceDir,
        receiptNonce: "nonce-failure-recovery",
        _testInjectFailureAt: "at-loader-write",
      })});`;

    let childResult;
    try {
      await execFileAsync(process.execPath, ["--input-type=module", "-e", inlineCode]);
      assert.fail("Child should have failed");
    } catch (err) {
      childResult = err;
    }

    // Child MUST have failed
    assert.ok(childResult, "Child must have thrown");

    // Stdout should contain the receipt delimiters because receipt is emitted BEFORE writes
    const stdout = childResult.stdout || "";
    assert.ok(
      stdout.includes("---PI_AUTO_COMPACTION_SETUP_RECEIPT_START---"),
      "Failed child stdout must include receipt start delimiter",
    );
    assert.ok(
      stdout.includes("---PI_AUTO_COMPACTION_SETUP_RECEIPT_END---"),
      "Failed child stdout must include receipt end delimiter",
    );

    // Parse and validate the receipt from the failed child's stdout
    const recovered = parseAndValidateReceipt(stdout, {
      nonce: "nonce-failure-recovery",
      targetDir: freshAgent,
      packageSourceDir: mockPkgSourceDir,
    });

    assert.ok(recovered, "Receipt must be recoverable from failed child stdout");
    assert.equal(recovered.nonce, "nonce-failure-recovery");
    assert.equal(recovered.targetDir, freshAgent);
    assert.equal(recovered.packageSourceDir, mockPkgSourceDir);

    // All three hashes must be valid 64-hex SHA-256
    for (const field of ["manifestHash", "loaderHash", "settingsHash"]) {
      assert.match(recovered[field], /^[0-9a-f]{64}$/, `Recovered receipt ${field} must be valid SHA-256 hex`);
    }

    // Strict nonce: different nonce must fail
    assert.throws(
      () => parseAndValidateReceipt(stdout, { nonce: "wrong-nonce" }),
      /nonce mismatch/i,
    );
  });
});

