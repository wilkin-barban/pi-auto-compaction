import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const SDK_PACKAGE = "@earendil-works/pi-coding-agent";
const AI_PACKAGE = "@earendil-works/pi-ai";
const TUI_PACKAGE = "@earendil-works/pi-tui";
let sdkPromise;
let sdkEntry;

// Global installations cannot use this module's bare-import search path. Honor
// their import exports instead of assuming that every package ships dist/index.js.
function packageExport(packageRoot, subpath = "") {
  const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  const key = subpath ? `./${subpath}` : ".";
  let entry = metadata.exports?.[key];
  let wildcard;
  if (entry === undefined) {
    for (const [pattern, target] of Object.entries(metadata.exports ?? {})) {
      const star = pattern.indexOf("*");
      if (star < 0) continue;
      const prefix = pattern.slice(0, star);
      const suffix = pattern.slice(star + 1);
      if (key.startsWith(prefix) && key.endsWith(suffix)) {
        wildcard = key.slice(prefix.length, suffix ? -suffix.length : undefined);
        entry = target;
        break;
      }
    }
  }
  while (entry && typeof entry === "object") {
    entry = entry.node ?? entry.import ?? entry.default;
  }
  if (typeof entry !== "string" || !entry.startsWith("./")) {
    throw new Error(`No import export ${key} in ${metadata.name}`);
  }
  if (wildcard !== undefined) entry = entry.replaceAll("*", wildcard);
  const target = path.resolve(packageRoot, entry);
  if (!target.startsWith(`${path.resolve(packageRoot)}${path.sep}`)) {
    throw new Error(`Invalid import export ${key} in ${metadata.name}`);
  }
  return pathToFileURL(target).href;
}

async function importSDK(entry) {
  const loaded = await import(entry);
  if (typeof loaded.createAgentSession !== "function") {
    throw new Error("Pi SDK must export createAgentSession");
  }
  sdkEntry = entry;
  return loaded;
}

async function resolveSDK() {
  // An explicit override is authoritative, including when it is invalid.
  if (Object.hasOwn(process.env, "PI_CODING_AGENT_PATH")) {
    try {
      const override = process.env.PI_CODING_AGENT_PATH;
      if (!override) throw new Error("empty override");
      const target = override.startsWith("file:") ? fileURLToPath(override) : path.resolve(override);
      const entry = fs.statSync(target).isDirectory()
        ? packageExport(target)
        : pathToFileURL(target).href;
      return await importSDK(entry);
    } catch (cause) {
      throw new Error("Failed to load Pi SDK from PI_CODING_AGENT_PATH", { cause });
    }
  }

  // Prefer project dependencies; a broken local SDK must not silently fall back.
  let localEntry;
  try {
    localEntry = import.meta.resolve(SDK_PACKAGE);
  } catch (error) {
    if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  }
  if (localEntry) return importSDK(localEntry);

  const candidates = [
    path.join(os.homedir(), ".local", "lib", "node_modules", SDK_PACKAGE),
    path.join("/usr/local/lib/node_modules", SDK_PACKAGE),
    path.join("/usr/lib/node_modules", SDK_PACKAGE),
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(path.join(candidate, "package.json"))) continue;
    try {
      return await importSDK(packageExport(candidate));
    } catch {
      // Another standard installation may still be usable.
    }
  }
  throw new Error(`Failed to resolve Pi SDK (${SDK_PACKAGE}). Install Pi or set PI_CODING_AGENT_PATH.`);
}

export function loadPiSDK() {
  return sdkPromise ??= resolveSDK();
}

export async function loadPiAI(subpath = "") {
  if (typeof subpath !== "string" || (subpath && !/^[\w-]+(?:\/[\w-]+)*$/.test(subpath))) {
    throw new Error("Invalid Pi AI export subpath");
  }
  await loadPiSDK();
  // Resolve beside the selected SDK, not beside this extension: deployed copies
  // have no node_modules and explicit overrides may select another installation.
  let directory = path.dirname(fileURLToPath(sdkEntry));
  while (true) {
    const candidate = path.join(directory, "node_modules", AI_PACKAGE);
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      return import(packageExport(candidate, subpath));
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`Failed to resolve ${AI_PACKAGE} beside the selected Pi SDK`);
}

// Packages such as @earendil-works/pi-tui ship `main` without `exports`, so the
// SDK helper cannot resolve them. Keep both shapes working.
export function packageEntry(packageRoot) {
  const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  if (metadata.exports !== undefined) {
    return import(packageExport(packageRoot));
  }
  if (typeof metadata.main !== "string") {
    throw new Error(`No entry point in ${metadata.name}`);
  }
  const target = path.resolve(packageRoot, metadata.main);
  if (!target.startsWith(`${path.resolve(packageRoot)}${path.sep}`)) {
    throw new Error(`Invalid entry point in ${metadata.name}`);
  }
  return import(pathToFileURL(target).href);
}

export async function loadPiTUI() {
  // Deployed releases have no node_modules: resolve beside the selected SDK the
  // same way the AI helpers do, after trying the extension's own search path.
  const specifier = ["@earendil-works", "pi-tui"].join("/");
  try {
    return await import(specifier);
  } catch {
    // Fall through to the SDK-relative resolution.
  }

  await loadPiSDK();
  let directory = path.dirname(fileURLToPath(sdkEntry));
  while (true) {
    const candidate = path.join(directory, "node_modules", TUI_PACKAGE);
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      return await packageEntry(candidate);
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`Failed to resolve ${TUI_PACKAGE} beside the selected Pi SDK`);
}

const sdk = await loadPiSDK();
export const {
  serializeConversation,
  convertToLlm,
  createAgentSession,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
  estimateTokens,
} = sdk;

export default sdk;
