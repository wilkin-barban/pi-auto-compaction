import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  MANAGED_POLICIES,
  MANAGED_MODELS,
  MANIFEST_FILENAME,
  validateManifest,
} from "../src/install-state.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";

export const MARKER_FILENAME = ".pi-auto-compaction-deploy.json";
const PI_DEFAULT_RESERVE_TOKENS = 16384;
const PI_DEFAULT_KEEP_RECENT_TOKENS = 20000;

function sha256(content) {
  if (content === null || content === undefined) return null;
  return crypto.createHash("sha256").update(content).digest("hex");
}

function resolveContextWindow(modelKey, provider, modelId, agentDir) {
  // 1. Try resolving from local models.json in agentDir if present
  const modelsConfigFile = path.join(agentDir, "models.json");
  if (fs.existsSync(modelsConfigFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(modelsConfigFile, "utf8"));
      if (parsed && typeof parsed === "object" && parsed.providers && typeof parsed.providers === "object") {
        // Direct provider lookup
        const providerObj = parsed.providers[provider];
        if (providerObj && typeof providerObj === "object") {
          const overrideCw = providerObj.modelOverrides?.[modelId]?.contextWindow ??
            providerObj.modelOverrides?.[modelKey]?.contextWindow;
          if (typeof overrideCw === "number" && Number.isInteger(overrideCw) && overrideCw > 0) {
            return { contextWindow: overrideCw, origin: "models.json" };
          }
          if (Array.isArray(providerObj.models)) {
            const found = providerObj.models.find(
              (m) => m && (m.id === modelId || m.id === modelKey),
            );
            if (found && typeof found.contextWindow === "number" && Number.isInteger(found.contextWindow) && found.contextWindow > 0) {
              return { contextWindow: found.contextWindow, origin: "models.json" };
            }
          }
        }
        // Scan across all providers
        for (const [pKey, pObj] of Object.entries(parsed.providers)) {
          if (!pObj || typeof pObj !== "object") continue;
          const overrideCw = pObj.modelOverrides?.[modelId]?.contextWindow ??
            pObj.modelOverrides?.[modelKey]?.contextWindow;
          if (typeof overrideCw === "number" && Number.isInteger(overrideCw) && overrideCw > 0) {
            return { contextWindow: overrideCw, origin: "models.json" };
          }
          if (Array.isArray(pObj.models)) {
            const found = pObj.models.find(
              (m) => m && (m.id === modelId || m.id === modelKey),
            );
            if (found && typeof found.contextWindow === "number" && Number.isInteger(found.contextWindow) && found.contextWindow > 0) {
              return { contextWindow: found.contextWindow, origin: "models.json" };
            }
          }
        }
      }
    } catch {
      // Ignore unparseable models.json
    }
  }

  // 2. Fall back to known context windows of managed policies
  const lower = modelKey.toLowerCase();
  if (lower.includes("deepseek")) {
    return { contextWindow: 1000000, origin: "managed-policy-fallback" };
  }
  if (lower.includes("gemini")) {
    return { contextWindow: 1048576, origin: "managed-policy-fallback" };
  }
  if (lower.includes("openai") || lower.includes("gpt")) {
    return { contextWindow: 400000, origin: "managed-policy-fallback" };
  }

  return { contextWindow: null, origin: "unresolved" };
}

function analyzeModel(modelKey, settings, manifest, agentDir) {
  const slashIndex = modelKey.indexOf("/");
  const provider = slashIndex !== -1 ? modelKey.slice(0, slashIndex) : "unknown";
  const modelId = slashIndex !== -1 ? modelKey.slice(slashIndex + 1) : modelKey;

  const managedList = manifest?.managedModels || MANAGED_MODELS;
  const isManaged = managedList.includes(modelKey);

  const modelOverride = settings?.compaction?.modelOverrides?.[modelKey];

  let reserveTokens;
  let reserveTokensOrigin;
  if (typeof modelOverride?.reserveTokens === "number" && Number.isInteger(modelOverride.reserveTokens) && modelOverride.reserveTokens >= 0) {
    reserveTokens = modelOverride.reserveTokens;
    reserveTokensOrigin = "model-override";
  } else if (typeof settings?.compaction?.reserveTokens === "number" && Number.isInteger(settings.compaction.reserveTokens) && settings.compaction.reserveTokens >= 0) {
    reserveTokens = settings.compaction.reserveTokens;
    reserveTokensOrigin = "compaction-setting";
  } else {
    reserveTokens = PI_DEFAULT_RESERVE_TOKENS;
    reserveTokensOrigin = "pi-default";
  }

  let keepRecentTokens;
  let keepRecentTokensOrigin;
  if (typeof modelOverride?.keepRecentTokens === "number" && Number.isInteger(modelOverride.keepRecentTokens) && modelOverride.keepRecentTokens >= 0) {
    keepRecentTokens = modelOverride.keepRecentTokens;
    keepRecentTokensOrigin = "model-override";
  } else if (typeof settings?.compaction?.keepRecentTokens === "number" && Number.isInteger(settings.compaction.keepRecentTokens) && settings.compaction.keepRecentTokens >= 0) {
    keepRecentTokens = settings.compaction.keepRecentTokens;
    keepRecentTokensOrigin = "compaction-setting";
  } else {
    keepRecentTokens = PI_DEFAULT_KEEP_RECENT_TOKENS;
    keepRecentTokensOrigin = "pi-default";
  }

  const { contextWindow, origin: contextWindowOrigin } = resolveContextWindow(modelKey, provider, modelId, agentDir);

  let triggerAt = null;
  let triggerPercent = null;
  if (typeof contextWindow === "number" && contextWindow > 0) {
    triggerAt = contextWindow - reserveTokens;
    triggerPercent = Number(((triggerAt / contextWindow) * 100).toFixed(2));
  }

  const warnings = [];
  if (isManaged) {
    const expectedPolicy = MANAGED_POLICIES[modelKey] || manifest?.expectedManagedValues?.[modelKey];
    if (expectedPolicy && modelOverride) {
      if (
        modelOverride.reserveTokens !== expectedPolicy.reserveTokens ||
        modelOverride.keepRecentTokens !== expectedPolicy.keepRecentTokens
      ) {
        warnings.push(
          `Model "${modelKey}" is a managed model, but its override (reserveTokens: ${modelOverride.reserveTokens}, keepRecentTokens: ${modelOverride.keepRecentTokens}) does not match the managed policy (reserveTokens: ${expectedPolicy.reserveTokens}, keepRecentTokens: ${expectedPolicy.keepRecentTokens}). Trigger is at ~${triggerPercent !== null ? Math.round(triggerPercent) : "?"}% (${triggerAt} tokens).`,
        );
      }
    }
  } else {
    if (modelOverride) {
      warnings.push(
        `Model "${modelKey}" is an unmanaged model, but has an active override in settings.json (reserveTokens: ${modelOverride.reserveTokens}, keepRecentTokens: ${modelOverride.keepRecentTokens}).`,
      );
    }
  }

  if (triggerAt !== null && triggerAt <= 0) {
    warnings.push(`Model "${modelKey}" trigger threshold is non-positive (${triggerAt}). Compaction will trigger on every prompt.`);
  }

  return {
    model: modelKey,
    provider,
    modelId,
    contextWindow,
    contextWindowOrigin,
    reserveTokens,
    reserveTokensOrigin,
    keepRecentTokens,
    keepRecentTokensOrigin,
    triggerAt,
    triggerPercent,
    isManaged,
    warnings,
  };
}

export function runDoctor(options = {}, dependencies = {}) {
  const fsDep = dependencies.fs || fs;
  const envDep = dependencies.env || process.env;
  const osDep = dependencies.os || os;

  const agentDir =
    options.agentDir ||
    envDep.PI_CODING_AGENT_DIR ||
    path.join(osDep.homedir(), ".pi", "agent");

  let defaultInstallDir = path.join(osDep.homedir(), ".local", "share", "pi-auto-compaction-managed");
  if (!fsDep.existsSync(defaultInstallDir) && fsDep.existsSync(path.join(osDep.homedir(), ".local", "share", "pi-auto-compaction"))) {
    defaultInstallDir = path.join(osDep.homedir(), ".local", "share", "pi-auto-compaction");
  }

  const installDir =
    options.installDir ||
    envDep.PI_AUTO_COMPACTION_INSTALL_DIR ||
    defaultInstallDir;

  const telemetryPath = options.telemetryPath || DEFAULT_CONFIG.telemetryPath;

  const errors = [];
  const warnings = [];

  // Check agentDir
  if (!fsDep.existsSync(agentDir)) {
    errors.push(`Agent directory does not exist: ${agentDir}`);
  }

  // Read settings.json
  const settingsPath = path.join(agentDir, "settings.json");
  let settings = {};
  if (fsDep.existsSync(settingsPath)) {
    try {
      const raw = fsDep.readFileSync(settingsPath, "utf8");
      settings = JSON.parse(raw);
      if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
        errors.push(`Settings file is not a valid JSON object: ${settingsPath}`);
        settings = {};
      }
    } catch (err) {
      errors.push(`Failed to read or parse settings.json: ${err.message}`);
    }
  }

  // Loader state
  const loaderPath = path.join(agentDir, "extensions", "omniroute-compaction.ts");
  const loaderState = {
    path: loaderPath,
    exists: false,
    hash: null,
    matchesManifest: null,
  };

  if (fsDep.existsSync(loaderPath)) {
    loaderState.exists = true;
    try {
      const content = fsDep.readFileSync(loaderPath, "utf8");
      loaderState.hash = sha256(content);
    } catch (err) {
      errors.push(`Failed to read loader file: ${err.message}`);
    }
  }

  // Manifest state
  const manifestPath = path.join(agentDir, MANIFEST_FILENAME);
  const manifestState = {
    path: manifestPath,
    exists: false,
    hash: null,
    valid: false,
    version: null,
    managedModels: [],
  };

  let manifest = null;
  if (fsDep.existsSync(manifestPath)) {
    manifestState.exists = true;
    try {
      const content = fsDep.readFileSync(manifestPath, "utf8");
      manifestState.hash = sha256(content);
      manifest = JSON.parse(content);
      validateManifest(manifest, "manifest", loaderPath);
      manifestState.valid = true;
      manifestState.version = manifest.version;
      manifestState.managedModels = manifest.managedModels || Object.keys(manifest.expectedManagedValues || {});
    } catch (err) {
      errors.push(`Manifest invalid or corrupt: ${err.message}`);
    }
  }

  // Cross check loader and manifest
  if (loaderState.exists && manifestState.exists) {
    if (typeof manifest?.loaderHash === "string") {
      loaderState.matchesManifest = (loaderState.hash === manifest.loaderHash);
      if (!loaderState.matchesManifest) {
        errors.push(
          `Loader hash mismatch: disk hash ${loaderState.hash} does not match manifest loaderHash ${manifest.loaderHash}`,
        );
      }
    }
  } else if (loaderState.exists && !manifestState.exists) {
    errors.push("Loader exists but manifest is missing");
  } else if (!loaderState.exists && manifestState.exists) {
    errors.push("Manifest exists but loader is missing");
  }

  // Marker and Release state
  const markerPath = path.join(installDir, MARKER_FILENAME);
  const markerState = {
    path: markerPath,
    exists: false,
    valid: false,
    state: null,
    current: null,
    previous: null,
  };

  const releaseState = {
    exists: false,
    path: null,
    hash: null,
    matchesMarker: null,
  };

  if (fsDep.existsSync(installDir)) {
    if (fsDep.existsSync(markerPath)) {
      markerState.exists = true;
      try {
        const markerRaw = fsDep.readFileSync(markerPath, "utf8");
        const marker = JSON.parse(markerRaw);
        if (
          marker &&
          typeof marker === "object" &&
          marker.kind === "pi-auto-compaction-deploy" &&
          typeof marker.state === "string"
        ) {
          markerState.valid = true;
          markerState.state = marker.state;
          markerState.current = marker.current;
          markerState.previous = marker.previous;

          if (marker.state === "pending") {
            errors.push(`Deploy marker is in "pending" state at ${markerPath}. A previous transaction did not complete.`);
          }

          if (marker.current?.path) {
            releaseState.path = marker.current.path;
            releaseState.hash = marker.current.hash;
            if (fsDep.existsSync(marker.current.path)) {
              releaseState.exists = true;
              const relMarker = path.join(marker.current.path, ".release.json");
              if (fsDep.existsSync(relMarker)) {
                try {
                  const relData = JSON.parse(fsDep.readFileSync(relMarker, "utf8"));
                  releaseState.matchesMarker = relData.hash === marker.current.hash;
                  if (!releaseState.matchesMarker) {
                    errors.push(`Release marker hash ${relData.hash} does not match deploy marker hash ${marker.current.hash}`);
                  }
                } catch {
                  releaseState.matchesMarker = false;
                  errors.push(`Release metadata corrupt in ${relMarker}`);
                }
              }
            } else {
              errors.push(`Current release directory missing: ${marker.current.path}`);
            }
          }
        } else {
          errors.push(`Invalid marker schema at ${markerPath}`);
        }
      } catch (err) {
        errors.push(`Failed to read or parse deploy marker: ${err.message}`);
      }
    } else {
      warnings.push(`Deploy marker missing at ${markerPath}`);
    }
  } else {
    warnings.push(`Install directory does not exist: ${installDir}`);
  }

  // Telemetry state
  const telemetryState = {
    path: telemetryPath,
    exists: false,
    sizeBytes: 0,
    lastRecord: null,
  };

  if (fsDep.existsSync(telemetryPath)) {
    telemetryState.exists = true;
    try {
      const stat = fsDep.statSync(telemetryPath);
      telemetryState.sizeBytes = stat.size;

      if (stat.size > 0) {
        const content = fsDep.readFileSync(telemetryPath, "utf8");
        const lines = content.trim().split("\n").filter(Boolean);
        if (lines.length > 0) {
          const lastLine = lines[lines.length - 1];
          const rawRecord = JSON.parse(lastLine);
          // Allowlist only safe metadata
          const safeKeys = [
            "timestamp",
            "sessionId",
            "reason",
            "model",
            "status",
            "durationMs",
            "tokensBefore",
            "usage",
            "attemptCount",
            "errorCategory",
            "conversationModel",
            "conversationProvider",
            "contextWindow",
            "reserveTokens",
            "keepRecentTokens",
            "thresholdTokens",
          ];
          const safeRecord = {};
          for (const k of safeKeys) {
            if (rawRecord[k] !== undefined) {
              safeRecord[k] = rawRecord[k];
            }
          }
          telemetryState.lastRecord = safeRecord;
        }
      }
    } catch (err) {
      warnings.push(`Telemetry unreadable or invalid: ${err.message}`);
    }
  }

  // Model diagnostics
  const models = [];
  if (options.model) {
    const analysis = analyzeModel(options.model, settings, manifest, agentDir);
    models.push(analysis);
    warnings.push(...analysis.warnings);
  } else {
    const modelCandidates = new Set();
    if (settings.compaction?.modelOverrides) {
      for (const k of Object.keys(settings.compaction.modelOverrides)) {
        modelCandidates.add(k);
      }
    }
    const managedList = manifest?.managedModels || MANAGED_MODELS;
    for (const m of managedList) {
      modelCandidates.add(m);
    }
    for (const modelKey of modelCandidates) {
      const analysis = analyzeModel(modelKey, settings, manifest, agentDir);
      models.push(analysis);
      warnings.push(...analysis.warnings);
    }
  }

  const selectedModel = options.model ? models[0] : (models.length === 1 ? models[0] : null);

  let exitCode = 0;
  if (errors.length > 0) {
    exitCode = 2;
  } else if (warnings.length > 0) {
    exitCode = 1;
  }

  return {
    status: exitCode === 0 ? "healthy" : exitCode === 1 ? "warning" : "error",
    exitCode,
    healthy: exitCode === 0,
    agentDir,
    installDir,
    model: selectedModel,
    models,
    loader: loaderState,
    manifest: manifestState,
    marker: markerState,
    release: releaseState,
    telemetry: telemetryState,
    warnings,
    errors,
  };
}

function formatReport(result) {
  const lines = [];
  const statusLabel = result.exitCode === 0 ? "HEALTHY" : result.exitCode === 1 ? "WARNING" : "ERROR";
  lines.push(`pi-auto-compaction doctor: ${statusLabel} (exit code ${result.exitCode})`);
  lines.push(`Agent directory:   ${result.agentDir}`);
  lines.push(`Install directory: ${result.installDir}`);
  lines.push("");

  lines.push("Loader:");
  lines.push(`  Path:             ${result.loader.path}`);
  lines.push(`  Exists:           ${result.loader.exists ? "yes" : "no"}`);
  if (result.loader.exists) {
    lines.push(`  Hash:             ${result.loader.hash}`);
    lines.push(`  Matches manifest: ${result.loader.matchesManifest === null ? "n/a" : result.loader.matchesManifest ? "yes" : "NO"}`);
  }
  lines.push("");

  lines.push("Manifest:");
  lines.push(`  Path:             ${result.manifest.path}`);
  lines.push(`  Exists:           ${result.manifest.exists ? "yes" : "no"}`);
  if (result.manifest.exists) {
    lines.push(`  Valid:            ${result.manifest.valid ? "yes" : "no"}`);
    lines.push(`  Version:          ${result.manifest.version}`);
    lines.push(`  Managed models:   ${result.manifest.managedModels.length}`);
  }
  lines.push("");

  lines.push("Marker & Release:");
  lines.push(`  Marker exists:    ${result.marker.exists ? "yes" : "no"}`);
  if (result.marker.exists) {
    lines.push(`  State:            ${result.marker.state}`);
  }
  lines.push(`  Release exists:   ${result.release.exists ? "yes" : "no"}`);
  if (result.release.exists) {
    lines.push(`  Release path:     ${result.release.path}`);
    lines.push(`  Release hash:     ${result.release.hash}`);
  }
  lines.push("");

  lines.push("Telemetry:");
  lines.push(`  Path:             ${result.telemetry.path}`);
  lines.push(`  Exists:           ${result.telemetry.exists ? "yes" : "no"}`);
  lines.push(`  Size (bytes):     ${result.telemetry.sizeBytes}`);
  if (result.telemetry.lastRecord) {
    lines.push(`  Last session:     ${result.telemetry.lastRecord.sessionId || "unknown"}`);
    lines.push(`  Last status:      ${result.telemetry.lastRecord.status || "unknown"}`);
    lines.push(`  Tokens before:    ${result.telemetry.lastRecord.tokensBefore ?? "unknown"}`);
  }
  lines.push("");

  if (result.model) {
    lines.push("Selected Model Diagnostics:");
    lines.push(`  Model:            ${result.model.model}`);
    lines.push(`  Provider/ID:      ${result.model.provider} / ${result.model.modelId}`);
    lines.push(`  Managed:          ${result.model.isManaged ? "yes" : "no"}`);
    lines.push(`  Context window:   ${result.model.contextWindow?.toLocaleString() ?? "unresolved"} (${result.model.contextWindowOrigin})`);
    lines.push(`  Reserve tokens:   ${result.model.reserveTokens?.toLocaleString()} (${result.model.reserveTokensOrigin})`);
    lines.push(`  Keep recent:      ${result.model.keepRecentTokens?.toLocaleString()} (${result.model.keepRecentTokensOrigin})`);
    lines.push(`  Trigger at:       ${result.model.triggerAt?.toLocaleString() ?? "unresolved"} tokens`);
    lines.push(`  Trigger %:        ${result.model.triggerPercent !== null ? result.model.triggerPercent + "%" : "unresolved"}`);
    lines.push("");
  } else if (result.models.length > 0) {
    lines.push(`Evaluated Models (${result.models.length}):`);
    for (const m of result.models) {
      lines.push(
        `  - ${m.model}: trigger at ${m.triggerAt?.toLocaleString() ?? "?"} tokens (~${m.triggerPercent !== null ? Math.round(m.triggerPercent) : "?"}%), reserve: ${m.reserveTokens} (${m.reserveTokensOrigin})`,
      );
    }
    lines.push("");
  }

  if (result.warnings.length > 0) {
    lines.push(`Warnings (${result.warnings.length}):`);
    for (const w of result.warnings) {
      lines.push(`  [!] ${w}`);
    }
    lines.push("");
  }

  if (result.errors.length > 0) {
    lines.push(`Errors (${result.errors.length}):`);
    for (const e of result.errors) {
      lines.push(`  [ERROR] ${e}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function parseDoctorArgs(args) {
  const options = {
    agentDir: undefined,
    installDir: undefined,
    model: undefined,
    json: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--agent-dir") {
      const val = args[++i];
      if (!val || val.startsWith("--")) throw new Error("Missing value for --agent-dir");
      options.agentDir = val;
    } else if (arg === "--install-dir") {
      const val = args[++i];
      if (!val || val.startsWith("--")) throw new Error("Missing value for --install-dir");
      options.installDir = val;
    } else if (arg === "--model") {
      const val = args[++i];
      if (!val || val.startsWith("--")) throw new Error("Missing value for --model");
      options.model = val;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseDoctorArgs(process.argv.slice(2));
    if (options.help) {
      console.log(`pi-auto-compaction doctor

Usage:
  node scripts/doctor.mjs [options]
  npm run doctor -- [options]

Options:
  --agent-dir <DIR>    Agent directory (default: $PI_CODING_AGENT_DIR or $HOME/.pi/agent)
  --install-dir <DIR>  Install directory (default: $PI_AUTO_COMPACTION_INSTALL_DIR or managed dir)
  --model <id>         Model identifier to diagnose (e.g. commandcode/deepseek/deepseek-v4.1-flash)
  --json               Output JSON only
  --help, -h           Show this help message

Exit codes:
  0 Healthy
  1 Warnings
  2 Read / state errors
`);
      process.exit(0);
    }

    const result = runDoctor(options);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatReport(result));
    }
    process.exitCode = result.exitCode;
  } catch (err) {
    console.error(`Doctor failed: ${err.message}`);
    process.exitCode = 2;
  }
}
