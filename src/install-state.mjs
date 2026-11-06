import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export const MANAGED_MODELS = Object.freeze([
  "openai-codex/gpt-6-sol",
  "openai-codex/gpt-6.1-sol",
  "openai/gpt-6-sol",
  "openai/gpt-6.1-sol",
]);

export const EXPECTED_MANAGED_VALUES = Object.freeze({
  reserveTokens: 65536,
  keepRecentTokens: 20000,
});

export const MANIFEST_FILENAME = ".pi-auto-compaction-manifest.json";
export const STATE_DIRNAME = ".pi-auto-compaction-state";
export const LOCK_FILENAME = ".pi-auto-compaction.lock";
export const JOURNAL_FILENAME = "recovery-journal.json";
export const EXPECTED_MANIFEST_VERSION = "1.0.0";

export const RECEIPT_KIND = "pi-auto-compaction-setup-receipt";
export const RECEIPT_VERSION = 1;
export const RECEIPT_DELIMITER_START = "---PI_AUTO_COMPACTION_SETUP_RECEIPT_START---";
export const RECEIPT_DELIMITER_END = "---PI_AUTO_COMPACTION_SETUP_RECEIPT_END---";

export function isPlainObject(val) {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

export function hashContent(content) {
  if (content === null || content === undefined) return null;
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function validatePlainObject(obj, label) {
  if (!isPlainObject(obj)) {
    throw new Error(`Invalid ${label}: root must be a non-null object`);
  }
}

export function validateSettings(settings) {
  validatePlainObject(settings, "settings.json");
  if (settings.compaction !== undefined) {
    validatePlainObject(settings.compaction, "compaction setting in settings.json");
    if (settings.compaction.modelOverrides !== undefined) {
      validatePlainObject(settings.compaction.modelOverrides, "compaction.modelOverrides in settings.json");
      for (const [k, v] of Object.entries(settings.compaction.modelOverrides)) {
        if (!isPlainObject(v)) {
          throw new Error(`Invalid model override for ${k}: override must be a non-null object`);
        }
      }
    }
  }
}

export function validateManifest(manifest, label = "manifest", expectedLoaderPath) {
  if (!isPlainObject(manifest)) {
    throw new Error(`Invalid or corrupt ${label}: must be a non-null object`);
  }
  if (manifest.version !== EXPECTED_MANIFEST_VERSION) {
    throw new Error(
      `Invalid or corrupt ${label}: unsupported version ${manifest.version} (expected ${EXPECTED_MANIFEST_VERSION})`,
    );
  }
  if (!Array.isArray(manifest.managedModels) || manifest.managedModels.length !== MANAGED_MODELS.length) {
    throw new Error(`Invalid or corrupt ${label}: managedModels schema mismatch`);
  }
  for (const m of MANAGED_MODELS) {
    if (!manifest.managedModels.includes(m)) {
      throw new Error(`Invalid or corrupt ${label}: managedModels missing managed model ${m}`);
    }
  }
  if (!isPlainObject(manifest.originalOverrides)) {
    throw new Error(`Invalid or corrupt ${label}: originalOverrides must be a non-null object`);
  }
  if (Object.keys(manifest.originalOverrides).length !== MANAGED_MODELS.length) {
    throw new Error(`Invalid or corrupt ${label}: originalOverrides must contain exactly four baselines`);
  }
  for (const m of MANAGED_MODELS) {
    if (!Object.prototype.hasOwnProperty.call(manifest.originalOverrides, m)) {
      throw new Error(`Invalid or corrupt ${label}: missing baseline for ${m}`);
    }
    const entry = manifest.originalOverrides[m];
    if (!isPlainObject(entry) || typeof entry.present !== "boolean") {
      throw new Error(`Invalid or corrupt ${label}: corrupt baseline for ${m}`);
    }
    if (entry.present ? !isPlainObject(entry.value) : entry.value !== null) {
      throw new Error(`Invalid or corrupt ${label}: corrupt baseline value for ${m}`);
    }
    const originallyEmpty = entry.present && Object.keys(entry.value).length === 0;
    if (typeof entry.originalEmpty !== "boolean" || entry.originalEmpty !== originallyEmpty) {
      throw new Error(`Invalid or corrupt ${label}: corrupt originalEmpty state for ${m}`);
    }

    for (const field of Object.keys(EXPECTED_MANAGED_VALUES)) {
      const record = entry[field];
      if (!isPlainObject(record) || typeof record.present !== "boolean") {
        throw new Error(`Invalid or corrupt ${label}: corrupt ${field} schema for ${m}`);
      }
      const valuePresent = entry.present && Object.prototype.hasOwnProperty.call(entry.value, field);
      if (record.present) {
        if (!Number.isSafeInteger(record.value) || record.value < 0) {
          throw new Error(`Invalid or corrupt ${label}: corrupt ${field} value for ${m}`);
        }
        if (!valuePresent || entry.value[field] !== record.value) {
          throw new Error(`Invalid or corrupt ${label}: ${field} contradicts baseline value for ${m}`);
        }
      } else if (record.value !== undefined || valuePresent) {
        throw new Error(`Invalid or corrupt ${label}: ${field} value present in absent baseline field for ${m}`);
      }
    }
  }

  if (typeof manifest.loaderHash !== "string" || !/^[0-9a-f]{64}$/i.test(manifest.loaderHash)) {
    throw new Error(`Invalid or corrupt ${label}: loaderHash is missing or invalid (expected 64-hex hash)`);
  }

  if (typeof manifest.packageSourceDir !== "string" || manifest.packageSourceDir.trim().length === 0) {
    throw new Error(`Invalid or corrupt ${label}: packageSourceDir is missing or invalid`);
  }

  if (typeof manifest.loaderPath !== "string" || manifest.loaderPath.trim().length === 0) {
    throw new Error(`Invalid or corrupt ${label}: loaderPath is missing or invalid`);
  }

  if (expectedLoaderPath && path.resolve(manifest.loaderPath) !== path.resolve(expectedLoaderPath)) {
    throw new Error(`Invalid or corrupt ${label}: loaderPath ownership mismatch`);
  }

  if (
    !isPlainObject(manifest.expectedManagedValues) ||
    manifest.expectedManagedValues.reserveTokens !== EXPECTED_MANAGED_VALUES.reserveTokens ||
    manifest.expectedManagedValues.keepRecentTokens !== EXPECTED_MANAGED_VALUES.keepRecentTokens
  ) {
    throw new Error(`Invalid or corrupt ${label}: expectedManagedValues mismatch`);
  }
}

export function ensureStateDir(agentDir) {
  const stateDir = path.join(agentDir, STATE_DIRNAME);
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  }
  try {
    fs.chmodSync(stateDir, 0o700);
  } catch {
    // Best effort
  }
  return stateDir;
}

export function acquireLock(agentDir) {
  fs.mkdirSync(agentDir, { recursive: true });
  const lockPath = path.join(agentDir, LOCK_FILENAME);
  try {
    const fd = fs.openSync(lockPath, "wx");
    const info = JSON.stringify({ pid: process.pid, timestamp: Date.now() });
    fs.writeFileSync(fd, info);
    fs.closeSync(fd);
    return lockPath;
  } catch (err) {
    if (err.code === "EEXIST") {
      throw new Error(`Installation lock active at ${lockPath}. Another installation may be in progress.`);
    }
    throw err;
  }
}

export function releaseLock(lockPath) {
  if (lockPath && fs.existsSync(lockPath)) {
    try {
      fs.rmSync(lockPath, { force: true });
    } catch {
      // Best effort cleanup
    }
  }
}

export function atomicWriteFile(filePath, content, mode = 0o600) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
  fs.writeFileSync(tempPath, content, { mode });
  try {
    fs.chmodSync(tempPath, mode);
  } catch {
    // Best effort
  }
  fs.renameSync(tempPath, filePath);
}

// Publish complete snapshot bytes without ever replacing a foreign file (including symlinks).
export function restoreDeletedFile(filePath, content) {
  const tempPath = `${filePath}.restore.${crypto.randomUUID()}`;
  const fd = fs.openSync(tempPath, "wx", 0o600);
  try {
    fs.writeFileSync(fd, content);
    fs.linkSync(tempPath, filePath);
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(tempPath);
  }
}

export function takeSnapshot(filePaths) {
  const snapshot = {};
  for (const [key, filePath] of Object.entries(filePaths)) {
    const exists = fs.existsSync(filePath);
    const content = exists ? fs.readFileSync(filePath, "utf-8") : null;
    const hash = exists ? hashContent(content) : null;
    snapshot[key] = { path: filePath, exists, content, hash };
  }
  return snapshot;
}

export function verifySnapshot(snapshot) {
  for (const [, item] of Object.entries(snapshot)) {
    const currentlyExists = fs.existsSync(item.path);
    if (item.exists !== currentlyExists) {
      if (!item.exists && currentlyExists) {
        throw new Error(`Conflict: ${path.basename(item.path)} appeared concurrently before commit.`);
      }
      throw new Error(`Conflict: ${path.basename(item.path)} was deleted concurrently before commit.`);
    }
    if (item.exists) {
      const currentContent = fs.readFileSync(item.path, "utf-8");
      if (currentContent !== item.content) {
        throw new Error(`Conflict: ${path.basename(item.path)} was modified concurrently before commit.`);
      }
    }
  }
}

export function checkDriftOnReinstall(currentSettings, manifest, loaderPath) {
  // 1. Loader drift
  if (fs.existsSync(loaderPath)) {
    const currentLoaderContent = fs.readFileSync(loaderPath, "utf-8");
    const currentHash = hashContent(currentLoaderContent);
    if (currentHash !== manifest.loaderHash) {
      throw new Error(`Conflict: Loader extension at ${loaderPath} was modified externally (drift detected).`);
    }
  } else {
    throw new Error(`Conflict: Loader extension at ${loaderPath} was removed externally (drift detected).`);
  }

  // 2. Settings drift
  const overrides = currentSettings?.compaction?.modelOverrides;
  if (!overrides || typeof overrides !== "object") {
    throw new Error("Conflict: compaction.modelOverrides was removed or modified externally (drift detected).");
  }

  for (const modelId of MANAGED_MODELS) {
    if (!Object.prototype.hasOwnProperty.call(overrides, modelId)) {
      throw new Error(`Conflict: Managed model ${modelId} was removed externally (drift detected).`);
    }
    const currentModel = overrides[modelId];
    if (!isPlainObject(currentModel)) {
      throw new Error(`Conflict: Managed model ${modelId} override is invalid (drift detected).`);
    }
    if (currentModel.reserveTokens !== EXPECTED_MANAGED_VALUES.reserveTokens) {
      throw new Error(
        `Conflict: Managed model ${modelId} reserveTokens was modified externally to ${currentModel.reserveTokens} (drift detected).`,
      );
    }
    if (currentModel.keepRecentTokens !== EXPECTED_MANAGED_VALUES.keepRecentTokens) {
      throw new Error(
        `Conflict: Managed model ${modelId} keepRecentTokens was modified externally to ${currentModel.keepRecentTokens} (drift detected).`,
      );
    }
  }
}

export function checkDriftOnRollback(currentSettings, manifest, loaderPath) {
  // 1. Loader drift: demand loader existence when manifest exists
  if (!fs.existsSync(loaderPath)) {
    throw new Error(
      `Conflict: Loader extension at ${loaderPath} was removed externally (drift detected). Rollback refused.`,
    );
  }
  const currentLoaderContent = fs.readFileSync(loaderPath, "utf-8");
  const currentHash = hashContent(currentLoaderContent);
  if (manifest.loaderHash && currentHash !== manifest.loaderHash) {
    throw new Error(
      `Conflict: Loader extension was modified externally at ${loaderPath} (drift detected). Rollback refused.`,
    );
  }

  // 2. Managed fields drift in settings
  const overrides = currentSettings?.compaction?.modelOverrides;
  if (!overrides || !isPlainObject(overrides)) {
    throw new Error(
      "Conflict: compaction.modelOverrides was removed or modified externally (drift detected). Rollback refused.",
    );
  }

  for (const modelId of MANAGED_MODELS) {
    if (!Object.prototype.hasOwnProperty.call(overrides, modelId)) {
      throw new Error(`Conflict: Managed model ${modelId} was removed externally (drift detected). Rollback refused.`);
    }
    const currentModel = overrides[modelId];
    if (!isPlainObject(currentModel)) {
      throw new Error(`Conflict: Managed model ${modelId} override is invalid (drift detected). Rollback refused.`);
    }
    if (currentModel.reserveTokens !== EXPECTED_MANAGED_VALUES.reserveTokens) {
      throw new Error(
        `Conflict: Managed model ${modelId} reserveTokens was modified externally to ${currentModel.reserveTokens} (drift detected). Rollback refused.`,
      );
    }
    if (currentModel.keepRecentTokens !== EXPECTED_MANAGED_VALUES.keepRecentTokens) {
      throw new Error(
        `Conflict: Managed model ${modelId} keepRecentTokens was modified externally to ${currentModel.keepRecentTokens} (drift detected). Rollback refused.`,
      );
    }
  }
}

export function expectedLoaderContent(packageSourceDir) {
  const entrySpecifier = JSON.stringify(path.join(packageSourceDir, "index.mjs"));
  return `// Managed loader for pi-auto-compaction
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function (pi: ExtensionAPI) {
  try {
    const ext = await import(${entrySpecifier});
    const factory = ext.default || ext.autoCompactionExtension;
    if (typeof factory === "function") {
      factory(pi);
    }
  } catch (err) {
    console.error("[pi-auto-compaction] Failed to load durable extension:", err);
  }
}
`;
}

export function applyManagedSettings(existingSettings = {}) {
  const currentCompaction = existingSettings.compaction || {};
  const currentOverrides = currentCompaction.modelOverrides || {};
  const updatedOverrides = { ...currentOverrides };
  for (const modelId of MANAGED_MODELS) {
    const existingModelObj = updatedOverrides[modelId] || {};
    updatedOverrides[modelId] = {
      ...existingModelObj,
      ...EXPECTED_MANAGED_VALUES,
    };
  }
  return {
    ...existingSettings,
    compaction: {
      ...currentCompaction,
      modelOverrides: updatedOverrides,
    },
  };
}

export function buildManifest({
  installedAt,
  packageSourceDir,
  originalOverrides,
  loaderPath,
  loaderHash,
}) {
  return {
    version: EXPECTED_MANIFEST_VERSION,
    installedAt,
    packageSourceDir,
    managedModels: [...MANAGED_MODELS],
    expectedManagedValues: { ...EXPECTED_MANAGED_VALUES },
    originalOverrides,
    loaderPath,
    loaderHash,
  };
}

export function createSetupReceipt({
  nonce,
  targetDir,
  packageSourceDir,
  installedAt,
  manifestHash,
  loaderHash,
  settingsHash,
}) {
  return {
    installedAt,
    kind: RECEIPT_KIND,
    loaderHash,
    manifestHash,
    nonce,
    packageSourceDir,
    settingsHash,
    targetDir,
    version: RECEIPT_VERSION,
  };
}

export function formatSetupReceipt(receipt) {
  return `${RECEIPT_DELIMITER_START}\n${JSON.stringify(receipt)}\n${RECEIPT_DELIMITER_END}\n`;
}

export function parseAndValidateReceipt(stdout, expected = {}) {
  if (typeof stdout !== "string") return null;
  const startIndex = stdout.indexOf(RECEIPT_DELIMITER_START);
  const endIndex = stdout.indexOf(RECEIPT_DELIMITER_END);

  if (startIndex === -1 && endIndex === -1) {
    return null;
  }

  const secondStart = stdout.indexOf(RECEIPT_DELIMITER_START, startIndex + RECEIPT_DELIMITER_START.length);
  const secondEnd = stdout.indexOf(RECEIPT_DELIMITER_END, endIndex + RECEIPT_DELIMITER_END.length);
  if (secondStart !== -1 || secondEnd !== -1) {
    throw new Error("Duplicate setup receipt detected in child output");
  }

  if (startIndex === -1 || endIndex === -1 || startIndex >= endIndex) {
    throw new Error("Malformed setup receipt delimiters in child output");
  }

  const rawJson = stdout.slice(startIndex + RECEIPT_DELIMITER_START.length, endIndex).trim();
  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    throw new Error(`Corrupt setup receipt JSON in child output: ${err.message}`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error("Invalid setup receipt: root must be a non-null object");
  }

  const expectedKeys = [
    "installedAt",
    "kind",
    "loaderHash",
    "manifestHash",
    "nonce",
    "packageSourceDir",
    "settingsHash",
    "targetDir",
    "version",
  ];
  const actualKeys = Object.keys(parsed).sort();
  if (actualKeys.join(",") !== expectedKeys.join(",")) {
    throw new Error(
      `Invalid setup receipt schema: expected keys [${expectedKeys.join(",")}], got [${actualKeys.join(",")}]`,
    );
  }

  if (parsed.kind !== RECEIPT_KIND) {
    throw new Error(`Invalid setup receipt kind: ${parsed.kind}`);
  }
  if (parsed.version !== RECEIPT_VERSION) {
    throw new Error(`Invalid setup receipt version: ${parsed.version}`);
  }
  if (typeof parsed.nonce !== "string" || !parsed.nonce) {
    throw new Error("Invalid setup receipt nonce");
  }
  if (expected.nonce && parsed.nonce !== expected.nonce) {
    throw new Error(`Setup receipt nonce mismatch: expected ${expected.nonce}, got ${parsed.nonce}`);
  }
  if (typeof parsed.targetDir !== "string" || !parsed.targetDir) {
    throw new Error("Invalid setup receipt targetDir");
  }
  if (expected.targetDir && path.resolve(parsed.targetDir) !== path.resolve(expected.targetDir)) {
    throw new Error(`Setup receipt targetDir mismatch: expected ${expected.targetDir}, got ${parsed.targetDir}`);
  }
  if (typeof parsed.packageSourceDir !== "string" || !parsed.packageSourceDir) {
    throw new Error("Invalid setup receipt packageSourceDir");
  }
  if (expected.packageSourceDir && path.resolve(parsed.packageSourceDir) !== path.resolve(expected.packageSourceDir)) {
    throw new Error(
      `Setup receipt packageSourceDir mismatch: expected ${expected.packageSourceDir}, got ${parsed.packageSourceDir}`,
    );
  }
  if (
    typeof parsed.installedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(parsed.installedAt)
  ) {
    throw new Error("Invalid setup receipt installedAt format (must be strict ISO 8601 with Z)");
  }
  for (const hashField of ["manifestHash", "loaderHash", "settingsHash"]) {
    if (typeof parsed[hashField] !== "string" || !/^[0-9a-f]{64}$/.test(parsed[hashField])) {
      throw new Error(`Invalid setup receipt ${hashField}: must be 64-character lowercase hex`);
    }
  }

  return parsed;
}

