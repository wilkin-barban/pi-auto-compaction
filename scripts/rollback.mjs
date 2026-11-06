import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  MANAGED_MODELS,
  MANIFEST_FILENAME,
  LOCK_FILENAME,
  JOURNAL_FILENAME,
  STATE_DIRNAME,
  isPlainObject,
  validateSettings,
  validateManifest,
  ensureStateDir,
  acquireLock,
  releaseLock,
  atomicWriteFile,
  restoreDeletedFile,
  takeSnapshot,
  verifySnapshot,
  checkDriftOnRollback,
} from "../src/install-state.mjs";

export { MANAGED_MODELS as TARGET_MODELS };

export function runRollback(options = {}) {
  const agentDir =
    options.agentDir ||
    process.env.PI_CODING_AGENT_DIR ||
    path.join(os.homedir(), ".pi", "agent");

  const dryRun = Boolean(options.dryRun);
  const force = Boolean(options.force);

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
        `Pending recovery journal exists at ${journalPath}. Prior transaction was interrupted or unrecovered. Rollback refused fail-closed.`,
      );
    }

    // 1. Check manifest and loader ownership
    const manifestExists = fs.existsSync(manifestFile);
    const loaderExists = fs.existsSync(loaderPath);

    if (!manifestExists) {
      if (!loaderExists) {
        // No manifest and no loader: target settings are user-owned, return no-op preserving settings byte-for-byte
        return {
          success: true,
          dryRun,
          agentDir,
          modifiedSettings: false,
          loaderRemoved: false,
          manifestRemoved: false,
        };
      }

      // Loader exists without manifest: reject! Never delete unknown ownership, even with force
      if (force) {
        throw new Error("Cannot force rollback: unknown ownership without valid manifest.");
      }
      throw new Error(
        `Conflict: Loader exists at ${loaderPath} but manifest is missing. Rollback refused.`,
      );
    }

    // 2. Parse and validate manifest
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestFile, "utf-8"));
    } catch (err) {
      throw new Error(`Failed to parse manifest at ${manifestFile}: ${err.message}`);
    }
    validateManifest(manifest, "manifest", loaderPath);

    // 3. Read and validate settings
    let currentSettings = {};
    if (fs.existsSync(settingsFile)) {
      try {
        currentSettings = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
      } catch (err) {
        throw new Error(`Failed to parse settings.json at ${settingsFile}: ${err.message}`);
      }
      validateSettings(currentSettings);
    }

    // 4. Drift check before ANY writes
    checkDriftOnRollback(currentSettings, manifest, loaderPath);

    // 5. Restore baseline values for managed fields
    let modifiedSettings = false;
    let restoredSettingsContent = null;

    if (fs.existsSync(settingsFile) && currentSettings?.compaction?.modelOverrides) {
      const overrides = { ...currentSettings.compaction.modelOverrides };
      const originalOverrides = manifest.originalOverrides || {};

      const managedList = manifest.managedModels || MANAGED_MODELS;
      for (const modelId of managedList) {
        const baseline = originalOverrides[modelId];
        const currentModel = overrides[modelId];

        if (currentModel && isPlainObject(currentModel)) {
          if (baseline && baseline.present) {
            // Target was originally present
            const restoredModel = { ...currentModel };

            if (baseline.reserveTokens?.present) {
              restoredModel.reserveTokens = baseline.reserveTokens.value;

            } else {
              delete restoredModel.reserveTokens;
            }

            if (baseline.keepRecentTokens?.present) {
              restoredModel.keepRecentTokens = baseline.keepRecentTokens.value;

            } else {
              delete restoredModel.keepRecentTokens;
            }

            overrides[modelId] = restoredModel;
          } else {
            // Target was originally absent: remove ONLY managed fields
            const cleanedModel = { ...currentModel };
            delete cleanedModel.reserveTokens;
            delete cleanedModel.keepRecentTokens;

            // If other user keys remain on this model, keep the object!
            if (Object.keys(cleanedModel).length > 0) {
              overrides[modelId] = cleanedModel;
            } else {
              delete overrides[modelId];
            }
          }
        }
      }

      if (Object.keys(overrides).length === 0) {
        delete currentSettings.compaction.modelOverrides;
      } else {
        currentSettings.compaction.modelOverrides = overrides;
      }
      modifiedSettings = true;
      restoredSettingsContent = `${JSON.stringify(currentSettings, null, 2)}\n`;
    }

    // 6. Snapshot state before commit
    const snapshot = takeSnapshot({
      settings: settingsFile,
      loader: loaderPath,
      manifest: manifestFile,
    });

    if (typeof options.beforeCommit === "function") {
      options.beforeCommit();
    }

    // 7. Verify snapshot
    verifySnapshot(snapshot);

    if (dryRun) {
      return {
        success: true,
        dryRun: true,
        agentDir,
        modifiedSettings,
        loaderRemoved: false,
        manifestRemoved: false,
      };
    }

    // 8. Backup settings privately inside stateDir (0600)
    if (snapshot.settings.exists) {
      const backupFile = path.join(stateDir, `settings.bak.${Date.now()}`);
      fs.copyFileSync(settingsFile, backupFile);
      try {
        fs.chmodSync(backupFile, 0o600);
      } catch {
        // Best effort
      }
    }

    // 9. Transaction journal & writes
    const journal = {
      operation: "rollback",
      timestamp: Date.now(),
      snapshot,
      writtenFiles: [],
    };
    atomicWriteFile(journalPath, JSON.stringify(journal, null, 2), 0o600);

    let loaderRemoved = false;
    let manifestRemoved = false;

    try {
      // Step 1: Write restored settings
      if (modifiedSettings && restoredSettingsContent !== null) {
        atomicWriteFile(settingsFile, restoredSettingsContent, 0o600);
        journal.writtenFiles.push("settings");
        fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2), { mode: 0o600 });
      }

      if (options._testInjectFailureAt === "before-loader-removal") {
        throw new Error("Injected failure before-loader-removal");
      }

      // Step 2: Remove loader
      if (fs.existsSync(loaderPath)) {
        fs.rmSync(loaderPath, { force: true });
        loaderRemoved = true;
        journal.writtenFiles.push("loaderRemoved");
        fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2), { mode: 0o600 });
      }

      if (options._testInjectFailureAt === "after-loader-removal") {
        throw new Error("Injected failure after-loader-removal");
      }
      if (typeof options._testAfterOperation === "function") {
        options._testAfterOperation("loader-removal");
      } else if (
        options._testAfterOperation === "loader-removal" ||
        options._testAfterOperation === "loader" ||
        options._testAfterOperation === "after-loader-removal"
      ) {
        throw new Error("Injected failure after loader-removal");
      }

      // Step 3: Remove manifest
      if (fs.existsSync(manifestFile)) {
        fs.rmSync(manifestFile, { force: true });
        manifestRemoved = true;
        journal.writtenFiles.push("manifestRemoved");
        fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2), { mode: 0o600 });
      }

      if (options._testInjectFailureAt === "after-manifest-removal") {
        throw new Error("Injected failure after-manifest-removal");
      }
      if (typeof options._testAfterOperation === "function") {
        options._testAfterOperation("manifest-removal");
      } else if (
        options._testAfterOperation === "manifest-removal" ||
        options._testAfterOperation === "manifest" ||
        options._testAfterOperation === "after-manifest-removal"
      ) {
        throw new Error("Injected failure after manifest-removal");
      }

      // Successful rollback: clear recovery journal
      fs.rmSync(journalPath, { force: true });
    } catch (writeErr) {
      // Compensation in reverse sequence
      let compensationFailed = false;
      const ops = [...journal.writtenFiles].reverse();
      for (const op of ops) {
        try {
          if (op === "manifestRemoved") {
            if (fs.existsSync(manifestFile)) {
              // Foreign replacement appeared where manifest was deleted!
              compensationFailed = true;
            } else if (snapshot.manifest.exists) {
              restoreDeletedFile(manifestFile, snapshot.manifest.content);
            }
          } else if (op === "loaderRemoved") {
            if (fs.existsSync(loaderPath)) {
              // Foreign replacement appeared where loader was deleted!
              compensationFailed = true;
            } else if (snapshot.loader.exists) {
              restoreDeletedFile(loaderPath, snapshot.loader.content);
            }
          } else if (op === "settings") {
            if (
              snapshot.settings.exists &&
              fs.existsSync(settingsFile) &&
              fs.readFileSync(settingsFile, "utf-8") === restoredSettingsContent
            ) {
              atomicWriteFile(settingsFile, snapshot.settings.content, 0o600);
            } else {
              compensationFailed = true;
            }
          }
        } catch {
          // One unsafe or failed restoration must not prevent the remaining compensations.
          compensationFailed = true;
        }
      }
      try {
        verifySnapshot(snapshot);
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
      modifiedSettings,
      loaderRemoved,
      manifestRemoved,
    };
  } finally {
    releaseLock(lockPath);
  }
}

export function parseRollbackArgs(args) {
  const parsed = {
    dryRun: false,
    force: false,
    agentDir: undefined,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--force") {
      parsed.force = true;
    } else if (arg === "--target-dir") {
      const val = args[i + 1];
      if (!val || val.startsWith("--")) {
        throw new Error("Missing value for --target-dir");
      }
      parsed.agentDir = val;
      i++;
    }
  }
  return parsed;
}

if (process.argv[1] && process.argv[1].endsWith("rollback.mjs")) {
  try {
    const options = parseRollbackArgs(process.argv.slice(2));
    const result = runRollback(options);
    console.log("Rollback completed successfully:", result);
  } catch (err) {
    console.error("Rollback failed:", err.message);
    process.exit(1);
  }
}
