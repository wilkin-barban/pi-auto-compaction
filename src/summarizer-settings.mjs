import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Default frozen summarizer settings representing the "not configured" state.
 */
export const DEFAULT_SUMMARIZER_SETTINGS = Object.freeze({
  version: 1,
  primary: null,
  fallback: null,
});

/**
 * Default effective summarizer models when neither settings file,
 * environment overrides, nor options configure primary/fallback.
 * Modeled to match DEFAULT_CONFIG in src/config.mjs.
 */
export const DEFAULT_EFFECTIVE_SUMMARIZER = Object.freeze({
  primary: Object.freeze({
    provider: "omniroute",
    modelId: "antigravity/gemini-3.8-flash-tiered",
  }),
  fallback: Object.freeze({
    provider: "omniroute",
    modelId: "antigravity/gemini-3.6-flash-high",
  }),
});

/**
 * Resolves the path to the summarizer settings file.
 * Precedence:
 * 1. options.settingsPath
 * 2. env.PI_AUTO_COMPACTION_SETTINGS_PATH
 * 3. options.agentDir or env.PI_CODING_AGENT_DIR -> path.join(agentDir, ".pi-auto-compaction-settings.json")
 * 4. $HOME/.pi/agent/.pi-auto-compaction-settings.json
 */
export function resolveSettingsPath(options = {}) {
  const opts = typeof options === "string" ? { settingsPath: options } : options || {};
  const env = opts.env || process.env;

  if (typeof opts.settingsPath === "string" && opts.settingsPath.trim().length > 0) {
    return path.resolve(opts.settingsPath.trim());
  }

  if (typeof env.PI_AUTO_COMPACTION_SETTINGS_PATH === "string" && env.PI_AUTO_COMPACTION_SETTINGS_PATH.trim().length > 0) {
    return path.resolve(env.PI_AUTO_COMPACTION_SETTINGS_PATH.trim());
  }

  const agentDir =
    (typeof opts.agentDir === "string" && opts.agentDir.trim().length > 0 ? opts.agentDir.trim() : null) ||
    (typeof env.PI_CODING_AGENT_DIR === "string" && env.PI_CODING_AGENT_DIR.trim().length > 0 ? env.PI_CODING_AGENT_DIR.trim() : null) ||
    path.join(os.homedir(), ".pi", "agent");

  return path.resolve(agentDir, ".pi-auto-compaction-settings.json");
}

function validateModelEntry(entry, fieldName) {
  if (entry === undefined || entry === null) {
    return null;
  }

  if (typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`${fieldName} must be an object with provider and modelId`);
  }

  const allowedKeys = new Set(["provider", "modelId"]);
  for (const key of Object.keys(entry)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unknown key in ${fieldName}: "${key}"`);
    }
  }

  if (typeof entry.provider !== "string") {
    throw new Error(`${fieldName}.provider must be a string`);
  }
  if (entry.provider.trim().length === 0) {
    throw new Error(`${fieldName}.provider must be a non-empty string`);
  }

  if (typeof entry.modelId !== "string") {
    throw new Error(`${fieldName}.modelId must be a string`);
  }
  if (entry.modelId.trim().length === 0) {
    throw new Error(`${fieldName}.modelId must be a non-empty string`);
  }

  return {
    provider: entry.provider.trim(),
    modelId: entry.modelId.trim(),
  };
}

/**
 * Strict schema validation for summarizer settings.
 * Accepts a parsed object or a raw JSON string.
 * Throws with a specific message on invalid input.
 */
export function parseSettings(raw) {
  let parsed = raw;

  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Invalid JSON in summarizer settings: ${err.message}`);
    }
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Summarizer settings must be an object");
  }

  const allowedTopKeys = new Set(["version", "primary", "fallback"]);
  for (const key of Object.keys(parsed)) {
    if (!allowedTopKeys.has(key)) {
      throw new Error(`Unknown key in summarizer settings: "${key}"`);
    }
  }

  if (parsed.version !== 1) {
    throw new Error(
      `Invalid settings version: expected 1, got ${
        typeof parsed.version === "string" ? `"${parsed.version}"` : parsed.version
      }`
    );
  }

  const primary = validateModelEntry(parsed.primary, "primary");
  const fallback = validateModelEntry(parsed.fallback, "fallback");

  return {
    version: 1,
    primary,
    fallback,
  };
}

/**
 * Reads summarizer settings from disk.
 * Returns { settings, source, warnings, path }.
 * source is "file" or "default".
 * A missing file is not a warning. Corrupt/invalid file returns defaults with a warning.
 * Never rewrites the file on failure.
 */
export function readSettings(options = {}) {
  const filePath = resolveSettingsPath(options);

  if (!fs.existsSync(filePath)) {
    return {
      settings: { ...DEFAULT_SUMMARIZER_SETTINGS },
      source: "default",
      warnings: [],
      path: filePath,
    };
  }

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const settings = parseSettings(raw);
    return {
      settings,
      source: "file",
      warnings: [],
      path: filePath,
    };
  } catch (err) {
    return {
      settings: { ...DEFAULT_SUMMARIZER_SETTINGS },
      source: "default",
      warnings: [`Failed to load summarizer settings from ${filePath}: ${err.message}`],
      path: filePath,
    };
  }
}

/**
 * Atomically writes validated summarizer settings to disk.
 * Validates first.
 * Refuses if target is a symlink or named settings.json.
 * Parent directory created with mode 0700 if missing.
 * File created with mode 0600.
 * Leaves no temp files behind.
 * Returns the resolved target path.
 */
export function writeSettings(settings, options = {}) {
  const validated = parseSettings(settings);
  const targetPath = resolveSettingsPath(options);

  if (path.basename(targetPath) === "settings.json") {
    throw new Error(
      `Refusing to write to settings.json at ${targetPath}: summarizer settings must use an independent settings file`
    );
  }

  try {
    const stat = fs.lstatSync(targetPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to write settings: target path is a symlink: ${targetPath}`);
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw err;
    }
  }

  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // Best effort chmod
    }
  }

  const tempPath = path.join(
    dir,
    `.tmp-settings.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
  );
  const payload = JSON.stringify(validated, null, 2) + "\n";

  try {
    fs.writeFileSync(tempPath, payload, { mode: 0o600 });
    try {
      fs.chmodSync(tempPath, 0o600);
    } catch {
      // Best effort chmod
    }

    try {
      const stat = fs.lstatSync(targetPath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Refusing to write settings: target path is a symlink: ${targetPath}`);
      }
    } catch (err) {
      if (err.code !== "ENOENT") {
        throw err;
      }
    }

    fs.renameSync(tempPath, targetPath);
    try {
      fs.chmodSync(targetPath, 0o600);
    } catch {
      // Best effort chmod
    }
  } finally {
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {
      // Best effort cleanup
    }
  }

  return targetPath;
}

/**
 * Applies environment variable overrides on top of settings.
 * Incomplete pairs (provider without model or model without provider)
 * are ignored with a warning.
 * Returns { ...settings, settings, warnings, applied }.
 */
export function applyEnvOverrides(settings = DEFAULT_SUMMARIZER_SETTINGS, env = process.env) {
  const warnings = [];
  const applied = {
    primary: false,
    fallback: false,
  };

  const baseSettings = settings || DEFAULT_SUMMARIZER_SETTINGS;
  let primary = baseSettings.primary ? { ...baseSettings.primary } : null;
  let fallback = baseSettings.fallback ? { ...baseSettings.fallback } : null;

  // Primary env pair
  const primaryProviderRaw = env?.PI_AUTO_COMPACTION_PRIMARY_PROVIDER;
  const primaryModelRaw = env?.PI_AUTO_COMPACTION_PRIMARY_MODEL;
  const hasPrimaryProvider = typeof primaryProviderRaw === "string" && primaryProviderRaw.trim().length > 0;
  const hasPrimaryModel = typeof primaryModelRaw === "string" && primaryModelRaw.trim().length > 0;

  if (hasPrimaryProvider && hasPrimaryModel) {
    primary = {
      provider: primaryProviderRaw.trim(),
      modelId: primaryModelRaw.trim(),
    };
    applied.primary = true;
  } else if (hasPrimaryProvider && !hasPrimaryModel) {
    warnings.push(
      "PI_AUTO_COMPACTION_PRIMARY_PROVIDER is set without PI_AUTO_COMPACTION_PRIMARY_MODEL; ignoring primary env override"
    );
  } else if (!hasPrimaryProvider && hasPrimaryModel) {
    warnings.push(
      "PI_AUTO_COMPACTION_PRIMARY_MODEL is set without PI_AUTO_COMPACTION_PRIMARY_PROVIDER; ignoring primary env override"
    );
  }

  // Fallback env pair
  const fallbackProviderRaw = env?.PI_AUTO_COMPACTION_FALLBACK_PROVIDER;
  const fallbackModelRaw = env?.PI_AUTO_COMPACTION_FALLBACK_MODEL;
  const hasFallbackProvider = typeof fallbackProviderRaw === "string" && fallbackProviderRaw.trim().length > 0;
  const hasFallbackModel = typeof fallbackModelRaw === "string" && fallbackModelRaw.trim().length > 0;

  if (hasFallbackProvider && hasFallbackModel) {
    fallback = {
      provider: fallbackProviderRaw.trim(),
      modelId: fallbackModelRaw.trim(),
    };
    applied.fallback = true;
  } else if (hasFallbackProvider && !hasFallbackModel) {
    warnings.push(
      "PI_AUTO_COMPACTION_FALLBACK_PROVIDER is set without PI_AUTO_COMPACTION_FALLBACK_MODEL; ignoring fallback env override"
    );
  } else if (!hasFallbackProvider && hasFallbackModel) {
    warnings.push(
      "PI_AUTO_COMPACTION_FALLBACK_MODEL is set without PI_AUTO_COMPACTION_FALLBACK_PROVIDER; ignoring fallback env override"
    );
  }

  const nextSettings = {
    version: 1,
    primary,
    fallback,
  };

  return {
    ...nextSettings,
    settings: nextSettings,
    warnings,
    applied,
  };
}

/**
 * Resolves the effective summarizer settings following the full precedence chain:
 * options > env > file > defaults.
 * Returns effective primary and fallback models and the source of each.
 * Never mutates any default object.
 */
export function resolveSummarizerSettings(args = {}) {
  const opts = args.options !== undefined ? args.options : args;
  const targetEnv = args.env !== undefined ? args.env : (args.options?.env || process.env);
  const settingsPath = args.settingsPath || args.options?.settingsPath;
  const agentDir = args.agentDir || args.options?.agentDir;

  const fileResult = readSettings({ settingsPath, env: targetEnv, agentDir });
  const envResult = applyEnvOverrides(fileResult.settings, targetEnv);

  const optPrimary = opts.primary || opts.primaryModel;
  const optFallback = opts.fallback || opts.fallbackModel;

  let effectivePrimary;
  let sourcePrimary;

  if (
    optPrimary &&
    typeof optPrimary.provider === "string" &&
    optPrimary.provider.trim().length > 0 &&
    typeof optPrimary.modelId === "string" &&
    optPrimary.modelId.trim().length > 0
  ) {
    effectivePrimary = {
      provider: optPrimary.provider.trim(),
      modelId: optPrimary.modelId.trim(),
    };
    sourcePrimary = "options";
  } else if (envResult.applied.primary && envResult.primary) {
    effectivePrimary = { ...envResult.primary };
    sourcePrimary = "env";
  } else if (
    fileResult.settings.primary &&
    typeof fileResult.settings.primary.provider === "string" &&
    fileResult.settings.primary.provider.trim().length > 0 &&
    typeof fileResult.settings.primary.modelId === "string" &&
    fileResult.settings.primary.modelId.trim().length > 0
  ) {
    effectivePrimary = { ...fileResult.settings.primary };
    sourcePrimary = "file";
  } else {
    effectivePrimary = { ...DEFAULT_EFFECTIVE_SUMMARIZER.primary };
    sourcePrimary = "default";
  }

  let effectiveFallback;
  let sourceFallback;

  if (
    optFallback &&
    typeof optFallback.provider === "string" &&
    optFallback.provider.trim().length > 0 &&
    typeof optFallback.modelId === "string" &&
    optFallback.modelId.trim().length > 0
  ) {
    effectiveFallback = {
      provider: optFallback.provider.trim(),
      modelId: optFallback.modelId.trim(),
    };
    sourceFallback = "options";
  } else if (envResult.applied.fallback && envResult.fallback) {
    effectiveFallback = { ...envResult.fallback };
    sourceFallback = "env";
  } else if (
    fileResult.settings.fallback &&
    typeof fileResult.settings.fallback.provider === "string" &&
    fileResult.settings.fallback.provider.trim().length > 0 &&
    typeof fileResult.settings.fallback.modelId === "string" &&
    fileResult.settings.fallback.modelId.trim().length > 0
  ) {
    effectiveFallback = { ...fileResult.settings.fallback };
    sourceFallback = "file";
  } else {
    effectiveFallback = { ...DEFAULT_EFFECTIVE_SUMMARIZER.fallback };
    sourceFallback = "default";
  }

  const combinedSource = sourcePrimary === sourceFallback ? sourcePrimary : `${sourcePrimary}+${sourceFallback}`;
  const allWarnings = [...fileResult.warnings, ...envResult.warnings];

  const frozenPrimary = Object.freeze(effectivePrimary);
  const frozenFallback = Object.freeze(effectiveFallback);

  return {
    primary: frozenPrimary,
    fallback: frozenFallback,
    primaryModel: frozenPrimary,
    fallbackModel: frozenFallback,
    source: combinedSource,
    sources: Object.freeze({
      primary: sourcePrimary,
      fallback: sourceFallback,
    }),
    sourcePrimary,
    sourceFallback,
    warnings: allWarnings,
    path: fileResult.path,
  };
}
