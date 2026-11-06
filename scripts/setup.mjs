import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  MANAGED_MODELS,
  MANAGED_POLICIES,
  MANIFEST_FILENAME,
  LOCK_FILENAME,
  JOURNAL_FILENAME,
  STATE_DIRNAME,
  MANIFEST_VERSION_V1,
  MANIFEST_VERSION_V2,
  EXPECTED_MANIFEST_VERSION,
  isPlainObject,
  hashContent,
  validateSettings,
  validateManifest,
  migrateManifestV1ToV2,
  captureModelBaseline,
  ensureStateDir,
  acquireLock,
  releaseLock,
  atomicWriteFile,
  takeSnapshot,
  verifySnapshot,
  checkDriftOnReinstall,
  expectedLoaderContent,
  applyManagedSettings,
  buildManifest,
  createSetupReceipt,
  formatSetupReceipt,
} from "../src/install-state.mjs";

export {
  MANAGED_MODELS as TARGET_MODELS,
  MANAGED_POLICIES as MANAGED_OVERRIDE,
  MANIFEST_FILENAME,
  LOCK_FILENAME,
  EXPECTED_MANIFEST_VERSION as MANIFEST_VERSION,
};

export function runSetup(options = {}) {
  const agentDir =
    options.agentDir ||
    process.env.PI_CODING_AGENT_DIR ||
    path.join(os.homedir(), ".pi", "agent");

  let packageSourceDir =
    options.packageSourceDir ||
    path.join(os.homedir(), ".local", "share", "pi-auto-compaction");

  if (!path.isAbsolute(packageSourceDir)) {
    packageSourceDir = path.resolve(packageSourceDir);
  }

  const dryRun = Boolean(options.dryRun);
  const allowDisabled = Boolean(options.allowDisabled);

  // Validate package source exists
  const sourceIndexFile = path.join(packageSourceDir, "index.mjs");
  if (!fs.existsSync(sourceIndexFile)) {
    throw new Error(
      `Package source index does not exist at ${sourceIndexFile}. Setup requires an existing absolute source directory.`,
    );
  }

  const extensionsDir = path.join(agentDir, "extensions");
  const settingsFile = path.join(agentDir, "settings.json");
  const manifestFile = path.join(agentDir, MANIFEST_FILENAME);
  const loaderPath = path.join(extensionsDir, "omniroute-compaction.ts");

  const stateDir = path.join(agentDir, STATE_DIRNAME);
  const journalPath = path.join(stateDir, JOURNAL_FILENAME);

  let lockPath = null;
  if (!dryRun) {
    ensureStateDir(agentDir);
    lockPath = acquireLock(agentDir);
  }

  try {
    // 0. Check for unrecovered recovery journal
    if (fs.existsSync(journalPath)) {
      throw new Error(
        `Pending recovery journal exists at ${journalPath}. Prior transaction was interrupted or unrecovered. Setup refused fail-closed.`,
      );
    }

    // 1. Read and validate existing settings
    let existingSettings = {};
    if (fs.existsSync(settingsFile)) {
      const raw = fs.readFileSync(settingsFile, "utf-8");
      try {
        existingSettings = JSON.parse(raw);
      } catch (err) {
        throw new Error(`Failed to parse existing settings.json at ${settingsFile}: ${err.message}`);
      }
      validateSettings(existingSettings);
    }

    // 2. Validate compaction is not disabled unless explicitly allowed
    if (existingSettings?.compaction?.enabled === false && !allowDisabled) {
      throw new Error(
        "Compaction is disabled in settings.json (compaction.enabled = false). Setup refused without --allow-disabled.",
      );
    }

    // 3. Load and validate manifest
    let manifest = null;
    if (fs.existsSync(manifestFile)) {
      try {
        manifest = JSON.parse(fs.readFileSync(manifestFile, "utf-8"));
      } catch (err) {
        throw new Error(`Invalid or corrupt manifest at ${manifestFile}: ${err.message}`);
      }
      validateManifest(manifest, "manifest", loaderPath);
    }

    // 4. Verify existing loader ownership and drift
    if (manifest) {
      checkDriftOnReinstall(existingSettings, manifest, loaderPath);
    } else if (fs.existsSync(loaderPath)) {
      throw new Error(
        `Conflict: Loader extension already exists without valid manifest at ${loaderPath}. Setup refused.`,
      );
    }

    const currentCompaction = existingSettings.compaction || {};
    const currentOverrides = currentCompaction.modelOverrides || {};

    // 5. Establish original baseline: NEVER recapture baseline on reinstall!
    // Migrate v1 manifest to v2 BEFORE applying settings so new baselines describe pre-policy state.
    let originalOverrides;
    if (manifest) {
      if (manifest.version === MANIFEST_VERSION_V1) {
        manifest = migrateManifestV1ToV2(manifest, existingSettings);
      }
      originalOverrides = manifest.originalOverrides;
    } else {
      originalOverrides = {};
      for (const modelId of MANAGED_MODELS) {
        originalOverrides[modelId] = captureModelBaseline(currentOverrides, modelId);
      }
    }

    // 6. Generate loader content
    const loaderContent = expectedLoaderContent(packageSourceDir);
    const loaderHash = hashContent(loaderContent);

    // 7. Merge model overrides preserving custom extra keys
    const updatedSettings = applyManagedSettings(existingSettings);
    const updatedSettingsContent = `${JSON.stringify(updatedSettings, null, 2)}\n`;

    // 7b. Intended manifest and receipt computed BEFORE any file writes
    const installedAt = new Date().toISOString();
    const newManifest = buildManifest({
      installedAt,
      packageSourceDir,
      originalOverrides,
      loaderPath,
      loaderHash,
    });
    validateManifest(newManifest, "manifest", loaderPath);
    const newManifestContent = `${JSON.stringify(newManifest, null, 2)}\n`;
    const manifestHash = hashContent(newManifestContent);
    const settingsHash = hashContent(updatedSettingsContent);

    let receipt = null;
    if (options.receiptNonce) {
      receipt = createSetupReceipt({
        nonce: options.receiptNonce,
        targetDir: agentDir,
        packageSourceDir,
        installedAt,
        manifestHash,
        loaderHash,
        settingsHash,
      });
    }

    if (typeof options.onReceipt === "function" && receipt) {
      options.onReceipt(receipt);
    }
    if (receipt) {
      process.stdout.write(formatSetupReceipt(receipt));
    }

    // 8. Snapshot state before commit
    const snapshot = takeSnapshot({
      settings: settingsFile,
      loader: loaderPath,
      manifest: manifestFile,
    });

    // Test hooks for concurrency simulation
    if (typeof options.beforeCommit === "function") {
      options.beforeCommit();
    }
    if (typeof options._testInjectConcurrentSettingsMutation === "function") {
      options._testInjectConcurrentSettingsMutation();
    }

    // 9. CAS verification of presence and exact bytes
    verifySnapshot(snapshot);

    if (dryRun) {
      return {
        success: true,
        dryRun: true,
        agentDir,
        settingsFile,
        backupCreated: false,
        modelsUpdated: [...MANAGED_MODELS],
      };
    }

    // 10. Backup settings privately inside dedicated stateDir (0600)
    let backupFile = null;
    if (snapshot.settings.exists) {
      backupFile = path.join(stateDir, `settings.bak.${Date.now()}`);
      fs.copyFileSync(settingsFile, backupFile);
      try {
        fs.chmodSync(backupFile, 0o600);
      } catch {
        // Best effort
      }
    }

    // 11. Transaction Journal
    const journal = {
      operation: "setup",
      timestamp: Date.now(),
      snapshot,
      writtenFiles: [],
    };
    atomicWriteFile(journalPath, JSON.stringify(journal, null, 2), 0o600);

    try {
      // Step 1: Write settings
      atomicWriteFile(settingsFile, updatedSettingsContent, 0o600);
      journal.writtenFiles.push("settings");
      fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2), { mode: 0o600 });

      if (options._testInjectFailureAt === "at-loader-write") {
        throw new Error("Injected failure at-loader-write");
      }

      // Step 2: Write loader
      atomicWriteFile(loaderPath, loaderContent, 0o600);
      journal.writtenFiles.push("loader");
      fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2), { mode: 0o600 });

      if (options._testInjectFailureAt === "at-manifest-write") {
        throw new Error("Injected failure at-manifest-write");
      }

      // Step 3: Write manifest
      atomicWriteFile(manifestFile, newManifestContent, 0o600);
      journal.writtenFiles.push("manifest");

      // Successful commit: clear recovery journal
      fs.rmSync(journalPath, { force: true });
    } catch (writeErr) {
      // Compensate ONLY files that still equal our installed bytes
      let compensationFailed = false;
      try {
        if (journal.writtenFiles.includes("manifest")) {
          if (
            fs.existsSync(manifestFile) &&
            hashContent(fs.readFileSync(manifestFile, "utf-8")) === hashContent(newManifestContent)
          ) {
            if (snapshot.manifest.exists) {
              atomicWriteFile(manifestFile, snapshot.manifest.content, 0o600);
            } else {
              fs.rmSync(manifestFile, { force: true });
            }
          } else {
            compensationFailed = true;
          }
        }

        if (journal.writtenFiles.includes("loader")) {
          if (
            fs.existsSync(loaderPath) &&
            hashContent(fs.readFileSync(loaderPath, "utf-8")) === loaderHash
          ) {
            if (snapshot.loader.exists) {
              atomicWriteFile(loaderPath, snapshot.loader.content, 0o600);
            } else {
              fs.rmSync(loaderPath, { force: true });
            }
          } else {
            compensationFailed = true;
          }
        }

        if (journal.writtenFiles.includes("settings")) {
          if (
            fs.existsSync(settingsFile) &&
            hashContent(fs.readFileSync(settingsFile, "utf-8")) === hashContent(updatedSettingsContent)
          ) {
            if (snapshot.settings.exists) {
              atomicWriteFile(settingsFile, snapshot.settings.content, 0o600);
            } else {
              fs.rmSync(settingsFile, { force: true });
            }
          } else {
            compensationFailed = true;
          }
        }
      } catch {
        compensationFailed = true;
      }

      if (!compensationFailed && !options._retainJournalOnError) {
        fs.rmSync(journalPath, { force: true });
      }

      throw writeErr;
    }

    return {
      success: true,
      dryRun: false,
      agentDir,
      settingsFile,
      backupCreated: Boolean(backupFile),
      backupFile,
      modelsUpdated: [...MANAGED_MODELS],
      receipt,
    };
  } finally {
    releaseLock(lockPath);
  }
}

export function parseSetupArgs(args) {
  const parsed = {
    dryRun: false,
    allowDisabled: false,
    agentDir: undefined,
    packageSourceDir: undefined,
    receiptNonce: undefined,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--allow-disabled") {
      parsed.allowDisabled = true;
    } else if (arg === "--target-dir") {
      const val = args[i + 1];
      if (!val || val.startsWith("--")) {
        throw new Error("Missing value for --target-dir");
      }
      parsed.agentDir = val;
      i++;
    } else if (arg === "--source-dir") {
      const val = args[i + 1];
      if (!val || val.startsWith("--")) {
        throw new Error("Missing value for --source-dir");
      }
      parsed.packageSourceDir = val;
      i++;
    } else if (arg === "--receipt-nonce") {
      const val = args[i + 1];
      if (!val || val.startsWith("--")) {
        throw new Error("Missing value for --receipt-nonce");
      }
      parsed.receiptNonce = val;
      i++;
    }
  }
  return parsed;
}

if (process.argv[1] && process.argv[1].endsWith("setup.mjs")) {
  try {
    const options = parseSetupArgs(process.argv.slice(2));
    const result = runSetup(options);
    console.log("Setup completed successfully:", result);
  } catch (err) {
    console.error("Setup failed:", err.message);
    process.exit(1);
  }
}
