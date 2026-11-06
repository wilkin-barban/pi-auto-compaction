import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  MANAGED_MODELS, MANAGED_POLICIES, MANIFEST_VERSION_V1, MANIFEST_VERSION_V2, EXPECTED_MANIFEST_VERSION,
  MANIFEST_FILENAME, STATE_DIRNAME, JOURNAL_FILENAME, LOCK_FILENAME,
  validateManifest, validateSettings, checkDriftOnReinstall,
  parseAndValidateReceipt,
} from "../src/install-state.mjs";

export const MARKER_FILENAME = ".pi-auto-compaction-deploy.json";
const sourceDefault = fileURLToPath(new URL("../", import.meta.url));
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const exists = (file) => { try { fs.lstatSync(file); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; } };
const readJSON = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const fail = (message) => { throw new Error(message); };

// Reject symlinks in every existing ancestor, including dangling links. No realpath
// normalization is allowed to silently turn an untrusted link into an owned path.
function safePath(input) {
  const absolute = path.resolve(input);
  let cursor = path.parse(absolute).root;
  for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (exists(cursor) && fs.lstatSync(cursor).isSymbolicLink()) fail(`Unsafe symlink path: ${cursor}`);
  }
  return absolute;
}
function owned(file, directory = false) {
  safePath(file);
  const stat = fs.lstatSync(file);
  if (!(directory ? stat.isDirectory() : stat.isFile())) fail(`Invalid file type: ${file}`);
  if (process.getuid && stat.uid !== process.getuid()) fail(`User ownership mismatch: ${file}`);
}
function exact(object, keys, label) {
  if (!object || Array.isArray(object) || typeof object !== "object" ||
      Object.keys(object).sort().join() !== [...keys].sort().join()) fail(`Invalid ${label} schema`);
}
function expectedLoader(targetPath) {
  const entrySpecifier = JSON.stringify(path.join(targetPath, "index.mjs"));
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
function expectedSettings(beforeSettings) {
  if (!beforeSettings) return null;
  const currentCompaction = beforeSettings.compaction || {};
  const currentOverrides = currentCompaction.modelOverrides || {};
  const updatedOverrides = { ...currentOverrides };
  for (const [modelId, policy] of Object.entries(MANAGED_POLICIES)) {
    const existingModelObj = updatedOverrides[modelId] || {};
    updatedOverrides[modelId] = {
      ...existingModelObj,
      reserveTokens: policy.reserveTokens,
      keepRecentTokens: policy.keepRecentTokens,
    };
  }
  return {
    ...beforeSettings,
    compaction: {
      ...currentCompaction,
      modelOverrides: updatedOverrides,
    },
  };
}
function baselinesMatch(originalManifest, installedManifest) {
  if (!originalManifest || !installedManifest) return true;
  if (originalManifest.version === installedManifest.version) {
    return JSON.stringify(installedManifest.originalOverrides) === JSON.stringify(originalManifest.originalOverrides);
  }
  if (originalManifest.version === MANIFEST_VERSION_V1 && installedManifest.version === MANIFEST_VERSION_V2) {
    for (const [model, baseline] of Object.entries(originalManifest.originalOverrides)) {
      if (JSON.stringify(installedManifest.originalOverrides[model]) !== JSON.stringify(baseline)) {
        return false;
      }
    }
    return true;
  }
  return false;
}
function isOwnManifest(liveManifest, targetPath, expectedLoaderPath, expectedOriginalOverrides, agentDir, setupStartTime) {
  if (!liveManifest || typeof liveManifest !== "object" || Array.isArray(liveManifest)) return false;
  try {
    validateManifest(liveManifest, "manifest", expectedLoaderPath);
  } catch {
    return false;
  }
  if (liveManifest.packageSourceDir !== targetPath) return false;
  if (liveManifest.loaderPath !== expectedLoaderPath) return false;
  if (liveManifest.loaderHash !== hash(expectedLoader(targetPath))) return false;
  if (expectedOriginalOverrides && !baselinesMatch({ originalOverrides: expectedOriginalOverrides, version: liveManifest.version }, liveManifest)) return false;
  if (typeof liveManifest.installedAt !== "string" || isNaN(Date.parse(liveManifest.installedAt))) return false;

  const parsedInstalledAt = Date.parse(liveManifest.installedAt);
  if (parsedInstalledAt > Date.now()) return false;
  if (setupStartTime && parsedInstalledAt < setupStartTime - 50) return false;

  if (agentDir) {
    const manifestPath = path.join(agentDir, MANIFEST_FILENAME);
    if (exists(manifestPath)) {
      const stat = fs.statSync(manifestPath);
      if (parsedInstalledAt > stat.mtimeMs + 5 || Math.abs(stat.mtimeMs - parsedInstalledAt) > 100) return false;
    }
    const stateDir = path.join(agentDir, STATE_DIRNAME);
    if (exists(stateDir)) {
      const backups = fs.readdirSync(stateDir).filter((f) => /^settings\.bak\.\d+$/.test(f));
      const matching = backups.map((f) => Number(f.slice("settings.bak.".length))).filter((ts) => ts >= (setupStartTime ? setupStartTime - 100 : 0));
      if (matching.length > 0) {
        const closest = Math.min(...matching.map((ts) => Math.abs(parsedInstalledAt - ts)));
        if (closest > 50) return false;
      }
    }
  }
  return true;
}
function atomicJSON(file, value) {
  safePath(file);
  const temporary = `${file}.tmp.${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  fs.renameSync(temporary, file);
}
const overlaps = (a, b) => a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);
function sourceFiles(source) {
  owned(source, true);
  owned(path.join(source, "src"), true);
  owned(path.join(source, "scripts"), true);
  const files = ["index.mjs", "package.json", "scripts/setup.mjs", "scripts/rollback.mjs",
    ...fs.readdirSync(path.join(source, "src")).filter((name) => /^[\w-]+\.mjs$/.test(name)).map((name) => `src/${name}`)];
  if (exists(path.join(source, "scripts/doctor.mjs"))) files.push("scripts/doctor.mjs");
  if (exists(path.join(source, "README.md"))) files.push("README.md");
  return files.sort().map((name) => {
    const file = path.join(source, name);
    owned(file);
    return { path: name, bytes: fs.readFileSync(file) };
  });
}
function fingerprint(files) {
  return hash(JSON.stringify(files.map(({ path: name, bytes }) => ({ path: name, hash: hash(bytes) }))));
}
function checkSource(source, run) {
  const files = sourceFiles(source);
  const metadata = JSON.parse(files.find((file) => file.path === "package.json").bytes.toString());
  if (metadata.name !== "pi-auto-compaction" || metadata.type !== "module" || metadata.private !== true ||
      metadata.license !== "UNLICENSED" || Object.keys(metadata.dependencies ?? {}).length) {
    fail("Unsupported package metadata or production dependencies");
  }
  const names = new Set(files.map((file) => path.join(source, file.path)));
  const modules = files.filter((item) => item.path.endsWith(".mjs"));
  // Compile the complete set in one isolated child, but never link/evaluate.
  // The native parser distinguishes imports from setup's loader template.
  const parser = `
    import fs from "node:fs";
    import vm from "node:vm";
    const files = JSON.parse(fs.readFileSync(0, "utf8"));
    const imports = files.map(file => new vm.SourceTextModule(file.text, {
      identifier: file.path,
    }).dependencySpecifiers);
    console.log(JSON.stringify(imports));
  `;
  const result = run(process.execPath, ["--experimental-vm-modules", "--input-type=module", "-e", parser], {
    input: JSON.stringify(modules.map((file) => ({ path: file.path, text: file.bytes.toString("utf8") }))),
    encoding: "utf8", env: {},
  });
  if (result.error || result.status !== 0) fail(`Source syntax validation failed: ${result.stderr || result.error}`);
  const staticImports = JSON.parse(result.stdout);
  for (const [index, file] of modules.entries()) {
    const text = file.bytes.toString("utf8");
    // Computed SDK imports remain the existing helper's responsibility. Literal
    // dynamic imports are checked too, without loading the SDK or entry point.
    const imports = [...staticImports[index], ...Array.from(text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g), (match) => match[1])];
    for (const specifier of imports) {
      if (specifier.startsWith("node:")) continue;
      if (!specifier.startsWith(".") || !names.has(path.resolve(source, path.dirname(file.path), specifier))) {
        fail(`Import outside source allowlist in ${file.path}: ${specifier}`);
      }
    }
  }
  return { files, hash: fingerprint(files) };
}
function descriptor(root, digest) { return { hash: digest, path: path.join(root, "releases", digest) }; }
function validateDescriptor(item, root) {
  exact(item, ["hash", "path"], "release metadata");
  if (typeof item.hash !== "string" || !/^[a-f0-9]{64}$/.test(item.hash) ||
      item.path !== descriptor(root, item.hash).path) fail("Invalid release metadata path/hash");
  safePath(item.path);
}
function verifyRelease(item, root, run) {
  validateDescriptor(item, root);
  owned(item.path, true);
  const markerPath = path.join(item.path, ".release.json");
  owned(markerPath);
  const release = readJSON(markerPath);
  exact(release, ["version", "hash", "files"], "release marker");
  const source = checkSource(item.path, run);
  const expected = source.files.map((file) => ({ path: file.path, hash: hash(file.bytes) }));
  if (release.version !== 1 || release.hash !== item.hash || source.hash !== item.hash ||
      JSON.stringify(release.files) !== JSON.stringify(expected)) fail("Release content hash mismatch");
  const top = [...new Set(source.files.map((file) => file.path.split("/")[0])), ".release.json"].sort();
  const expectedScripts = source.files.some((f) => f.path === "scripts/doctor.mjs")
    ? "doctor.mjs,rollback.mjs,setup.mjs"
    : "rollback.mjs,setup.mjs";
  if (fs.readdirSync(item.path).sort().join() !== top.join() ||
      fs.readdirSync(path.join(item.path, "scripts")).sort().join() !== expectedScripts ||
      fs.readdirSync(path.join(item.path, "src")).sort().join() !== source.files.filter((file) => file.path.startsWith("src/")).map((file) => path.basename(file.path)).sort().join()) {
    fail("Unexpected files in immutable release");
  }
}
function validateMarker(marker, root, agent) {
  exact(marker, ["kind", "version", "installDir", "agentDir", "state", "current", "previous", "pending"], "deployment metadata");
  if (marker.kind !== "pi-auto-compaction-deploy" || marker.version !== 1 ||
      marker.installDir !== root || marker.agentDir !== agent) fail("Deployment ownership/agent metadata mismatch");
  for (const item of [marker.current, marker.previous]) if (item !== null) validateDescriptor(item, root);
  if (marker.state === "pending") fail("Pending deployment journal: manual reconciliation required; do not delete marker/journals");
  if (marker.state !== "ready" || marker.pending !== null || (!marker.current && marker.previous) ||
      (marker.previous && marker.current.hash === marker.previous.hash)) fail("Invalid deployment metadata state");
}
function agentState(agent, current, options = {}) {
  const loader = path.join(agent, "extensions", "omniroute-compaction.ts");
  const manifestPath = path.join(agent, MANIFEST_FILENAME);
  for (const file of [agent, loader, manifestPath, path.join(agent, "settings.json"),
    path.join(agent, STATE_DIRNAME), path.join(agent, STATE_DIRNAME, JOURNAL_FILENAME), path.join(agent, LOCK_FILENAME)]) safePath(file);
  for (const lock of [path.join(agent, LOCK_FILENAME), path.join(agent, STATE_DIRNAME, JOURNAL_FILENAME)]) {
    if (exists(lock)) fail("Agent lock or pending recovery journal: reconciliation required");
  }
  if (exists(agent)) owned(agent, true);
  if (exists(path.join(agent, "extensions"))) owned(path.join(agent, "extensions"), true);
  if (exists(path.join(agent, STATE_DIRNAME))) owned(path.join(agent, STATE_DIRNAME), true);
  const settingsPath = path.join(agent, "settings.json");
  if (exists(settingsPath)) owned(settingsPath);
  const settings = exists(settingsPath) ? readJSON(settingsPath) : {};
  validateSettings(settings);
  if (settings.compaction?.enabled === false) fail("Compaction is disabled; setup refused");
  if (!current) {
    if (options.adoptAgent) {
      if (!exists(manifestPath) || !exists(loader)) fail("Adoption requires an existing valid agent manifest and loader");
      owned(manifestPath);
      owned(loader);
      const manifest = readJSON(manifestPath);
      validateManifest(manifest, "agent manifest", loader);
      const oldSource = safePath(manifest.packageSourceDir);
      owned(oldSource, true);
      owned(path.join(oldSource, "index.mjs"));
      owned(path.join(oldSource, "package.json"));
      const oldMeta = readJSON(path.join(oldSource, "package.json"));
      if (oldMeta.name !== "pi-auto-compaction" || oldMeta.type !== "module") fail("Invalid package metadata in adopted source");
      owned(path.join(oldSource, "scripts", "setup.mjs"));
      owned(path.join(oldSource, "scripts", "rollback.mjs"));
      checkDriftOnReinstall(settings, manifest, loader);
      return manifest;
    }
    if (exists(manifestPath) || exists(loader)) fail("Foreign agent manifest/loader: ownership refused");
    return null;
  }
  owned(manifestPath);
  owned(loader);
  const manifest = readJSON(manifestPath);
  validateManifest(manifest, "agent manifest", loader);
  if (manifest.packageSourceDir !== current.path) fail("Agent manifest source ownership mismatch");
  checkDriftOnReinstall(settings, manifest, loader);
  return manifest;
}
function snapshot(agent) {
  return ["settings.json", MANIFEST_FILENAME, "extensions/omniroute-compaction.ts"].map((name) => {
    const file = path.join(agent, name);
    safePath(file);
    return exists(file) ? fs.readFileSync(file, "utf8") : null;
  });
}
function childSetup(release, agent, run, rollback = false, receiptNonce = null) {
  const script = path.join(release.path, "scripts", rollback ? "rollback.mjs" : "setup.mjs");
  const args = [script, "--target-dir", agent];
  if (!rollback) {
    args.push("--source-dir", release.path);
    if (receiptNonce) args.push("--receipt-nonce", receiptNonce);
  }
  const result = run(process.execPath, args, { encoding: "utf8", env: {}, cwd: release.path });
  if (result.error || result.status !== 0) {
    const error = new Error(`Official ${rollback ? "rollback" : "setup"} failed: ${result.stderr || result.error || result.status}`);
    error.childResult = result;
    throw error;
  }
  return result;
}

export function runDeploy(options = {}, dependencies = {}) {
  const modes = [options.update, options.rollbackSource, options.adoptAgent].filter(Boolean);
  if (modes.length > 1) fail("Update, rollback-source, and adopt-agent are mutually exclusive");
  const root = safePath(options.installDir || path.join(os.homedir(), ".local", "share", "pi-auto-compaction"));
  const agent = safePath(options.agentDir || process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"));
  const source = safePath(options.sourceDir || sourceDefault);
  if (root === path.parse(root).root || root === os.homedir() || overlaps(root, agent) || overlaps(root, source) || overlaps(source, agent)) {
    fail("Unsafe overlapping source/install/agent paths");
  }
  const run = dependencies.run || spawnSync;
  const markerPath = path.join(root, MARKER_FILENAME);
  const lock = path.join(root, ".deploy.lock");
  let prior;
  if (exists(root)) {
    owned(root, true);
    if (!exists(markerPath)) fail("Unmanaged install root: ownership required; legacy adoption is deferred");
    owned(markerPath);
    prior = readJSON(markerPath);
    validateMarker(prior, root, agent);
    if (options.adoptAgent) fail("Adoption requires a new, non-existent install root");
    if (exists(lock)) fail("Deployment lock active: manual reconciliation required");
    for (const dir of ["releases", "journals"]) {
      safePath(path.join(root, dir));
      if (exists(path.join(root, dir))) owned(path.join(root, dir), true);
    }
    for (const item of [prior.current, prior.previous]) if (item) verifyRelease(item, root, run);
  } else {
    if (options.update || options.rollbackSource) fail("Update/rollback requires a managed install root");
    prior = { kind: "pi-auto-compaction-deploy", version: 1, installDir: root, agentDir: agent,
      state: "ready", current: null, previous: null, pending: null };
  }
  if (!options.update && !options.rollbackSource && !options.adoptAgent && prior.current) fail("Managed install already exists; use --update");
  if (options.update && !prior.current) fail("Update requires a current managed release");
  const original = agentState(agent, prior.current, { adoptAgent: Boolean(options.adoptAgent) });
  if (options.adoptAgent && original?.packageSourceDir) {
    const oldSource = safePath(original.packageSourceDir);
    if (oldSource === path.parse(oldSource).root || oldSource === os.homedir() ||
        overlaps(root, oldSource) || overlaps(agent, oldSource) || overlaps(source, oldSource)) {
      fail("Unsafe overlapping paths with adopted source");
    }
  }
  const copy = options.rollbackSource ? null : checkSource(source, run);
  const target = options.rollbackSource ? prior.previous || prior.current : descriptor(root, copy.hash);
  if (!target) fail("No managed release available for rollback");
  if (prior.current?.hash === target.hash) return { success: true, noop: true, dryRun: Boolean(options.dryRun), releaseDir: target.path };
  if (exists(target.path)) verifyRelease(target, root, run);
  if (options.dryRun) return { success: true, dryRun: true, releaseDir: target.path, adopted: Boolean(options.adoptAgent) };

  if (!exists(root)) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.writeFileSync(markerPath, JSON.stringify(prior), { flag: "wx", mode: 0o600 });
  }
  const lockToken = crypto.randomUUID();
  fs.writeFileSync(lock, lockToken, { flag: "wx", mode: 0o600 });
  try {
    // Revalidate after acquiring the wrapper lock, before any release/agent writes.
    if (JSON.stringify(readJSON(markerPath)) !== JSON.stringify(prior)) fail("Deployment metadata changed concurrently");
    agentState(agent, prior.current, { adoptAgent: Boolean(options.adoptAgent) });
    fs.mkdirSync(path.join(root, "releases"), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(root, "journals"), { recursive: true, mode: 0o700 });
    if (!exists(target.path)) {
      fs.mkdirSync(target.path, { mode: 0o700 });
      for (const file of copy.files) {
        const destination = path.join(target.path, file.path);
        fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
        fs.writeFileSync(destination, file.bytes, { flag: "wx", mode: 0o600 });
      }
      atomicJSON(path.join(target.path, ".release.json"), { version: 1, hash: target.hash,
        files: copy.files.map((file) => ({ path: file.path, hash: hash(file.bytes) })) });
    }
    verifyRelease(target, root, run);
    const before = snapshot(agent);
    if (JSON.stringify(snapshot(agent)) !== JSON.stringify(before)) fail("Agent files modified concurrently before setup");
    const pending = { ...prior, state: "pending", pending: { target, operation: options.rollbackSource ? "rollback-source" : options.adoptAgent ? "adopt-agent" : "setup" } };
    const journalPath = path.join(root, "journals", `${lockToken}.json`);
    const journal = {
      version: 1,
      agentDir: agent,
      prior,
      target,
      operation: options.rollbackSource ? "rollback-source" : options.adoptAgent ? "adopt-agent" : "setup",
      adoptedSource: options.adoptAgent ? original.packageSourceDir : null,
      state: "prepared"
    };
    atomicJSON(journalPath, journal);
    atomicJSON(markerPath, pending);
    const next = { ...prior, current: target, previous: (options.rollbackSource || options.adoptAgent) ? null : prior.current };
    const setupReceiptNonce = crypto.randomUUID();
    let validatedReceipt = null;
    let expectedPostHashes = null;
    let childError = null;
    try {
      let setupResult;
      try {
        setupResult = childSetup(target, agent, run, false, setupReceiptNonce);
      } catch (err) {
        childError = err;
        if (err.childResult && typeof err.childResult.stdout === "string") {
          try {
            validatedReceipt = parseAndValidateReceipt(err.childResult.stdout, {
              nonce: setupReceiptNonce,
              targetDir: agent,
              packageSourceDir: target.path,
            });
          } catch {}
        }
        throw err;
      }

      validatedReceipt = parseAndValidateReceipt(setupResult?.stdout, {
        nonce: setupReceiptNonce,
        targetDir: agent,
        packageSourceDir: target.path,
      });
      if (!validatedReceipt) {
        fail("Official setup did not emit a valid setup intent receipt");
      }

      expectedPostHashes = {
        settings: validatedReceipt.settingsHash,
        loader: validatedReceipt.loaderHash,
        manifest: validatedReceipt.manifestHash,
      };

      // Verify all 3 files match exact receipt hashes on disk immediately after setup
      const currentSnapshot = snapshot(agent);
      const actualSettingsHash = hash(currentSnapshot[0] ?? "");
      const actualManifestHash = hash(currentSnapshot[1] ?? "");
      const actualLoaderHash = hash(currentSnapshot[2] ?? "");

      if (
        actualSettingsHash !== expectedPostHashes.settings ||
        actualManifestHash !== expectedPostHashes.manifest ||
        actualLoaderHash !== expectedPostHashes.loader
      ) {
        fail("Post-setup agent file hashes do not match trusted writer receipt");
      }

      const installed = agentState(agent, target);
      if (original && !baselinesMatch(original, installed)) fail("Setup changed original baseline");
      const currentSettings = readJSON(path.join(agent, "settings.json"));
      const beforeSettings = before[0] === null ? {} : JSON.parse(before[0]);
      for (const [k, v] of Object.entries(beforeSettings)) {
        if (k !== "compaction" && JSON.stringify(currentSettings[k]) !== JSON.stringify(v)) {
          fail(`Setup modified unrelated setting ${k}`);
        }
      }
      atomicJSON(journalPath, { ...journal, state: "setup-complete" });
      (dependencies.commit || atomicJSON)(markerPath, next);

      // Post-commit: check raw marker bytes first to reject unknown fields / format drift
      const rawPostMarker = fs.readFileSync(markerPath, "utf8");
      const expectedMarkerBytes = `${JSON.stringify(next, null, 2)}\n`;
      if (rawPostMarker !== expectedMarkerBytes && rawPostMarker !== JSON.stringify(next, null, 2)) {
        fail("Deployment marker drift detected during metadata publication");
      }

      // Post-commit: verify all 3 files still match exact receipt hashes
      const postSnapshot = snapshot(agent);
      if (
        hash(postSnapshot[0] ?? "") !== expectedPostHashes.settings ||
        hash(postSnapshot[1] ?? "") !== expectedPostHashes.manifest ||
        hash(postSnapshot[2] ?? "") !== expectedPostHashes.loader
      ) {
        fail("Post-commit agent file hashes do not match trusted writer receipt");
      }

      const postMarker = readJSON(markerPath);
      exact(postMarker, ["kind", "version", "installDir", "agentDir", "state", "current", "previous", "pending"], "deployment metadata");
      validateMarker(postMarker, root, agent);

      const postInstall = agentState(agent, target);
      if (original && !baselinesMatch(original, postInstall)) {
        fail("Baseline drift detected during metadata publication");
      }
      if (before[0]) {
        const postSettings = readJSON(path.join(agent, "settings.json"));
        for (const [k, v] of Object.entries(beforeSettings)) {
          if (k !== "compaction" && JSON.stringify(postSettings[k]) !== JSON.stringify(v)) {
            fail(`Unrelated setting ${k} modified during metadata publication`);
          }
        }
      }
    } catch (error) {
      let markerIsOurs = false;
      try {
        if (exists(markerPath)) {
          const liveMarkerRaw = fs.readFileSync(markerPath, "utf8");
          const expectedPending = JSON.stringify(pending, null, 2);
          const expectedNext = JSON.stringify(next, null, 2);
          if (
            liveMarkerRaw === `${expectedPending}\n` ||
            liveMarkerRaw === expectedPending ||
            liveMarkerRaw === `${expectedNext}\n` ||
            liveMarkerRaw === expectedNext
          ) {
            markerIsOurs = true;
          }
        }
        if (JSON.stringify(snapshot(agent)) !== JSON.stringify(before)) {
          if (prior.current) {
            const installed = agentState(agent, target);
            if (original && !baselinesMatch(original, installed)) fail("Baseline drift during compensation");
            verifyRelease(prior.current, root, run);
            childSetup(prior.current, agent, run);
            agentState(agent, prior.current);
          } else if (options.adoptAgent) {
            let compensationFailed = false;
            const settingsPath = path.join(agent, "settings.json");
            const manifestFilePath = path.join(agent, MANIFEST_FILENAME);
            const loaderFilePath = path.join(agent, "extensions", "omniroute-compaction.ts");

            // Compensate settings: must be before bytes or exact receipt settingsHash (or expectedSettings if no receipt)
            if (exists(settingsPath)) {
              const rawSettings = fs.readFileSync(settingsPath, "utf8");
              if (before[0] !== null && rawSettings === before[0]) {
                // Preserved pre-setup bytes
              } else {
                const currentSettingsHash = hash(rawSettings);
                const isOurs = (validatedReceipt && currentSettingsHash === validatedReceipt.settingsHash) ||
                  (!validatedReceipt && before[0] && (() => {
                    let liveSettings = null;
                    try { liveSettings = JSON.parse(rawSettings); } catch {}
                    const expected = expectedSettings(JSON.parse(before[0]));
                    return liveSettings && expected && JSON.stringify(liveSettings) === JSON.stringify(expected);
                  })());
                if (isOurs) {
                  if (before[0] !== null) fs.writeFileSync(settingsPath, before[0], { mode: 0o600 });
                  else fs.rmSync(settingsPath, { force: true });
                } else {
                  compensationFailed = true;
                }
              }
            } else if (before[0] !== null) compensationFailed = true;

            // Compensate loader: must be before bytes or exact expected loader / receipt loaderHash
            if (exists(loaderFilePath)) {
              const rawLoader = fs.readFileSync(loaderFilePath, "utf8");
              if (before[2] !== null && rawLoader === before[2]) {
                // Preserved pre-setup bytes
              } else {
                const currentLoaderHash = hash(rawLoader);
                const isOurs = (validatedReceipt && currentLoaderHash === validatedReceipt.loaderHash) ||
                  (!validatedReceipt && rawLoader === expectedLoader(target.path));
                if (isOurs) {
                  if (before[2] !== null) fs.writeFileSync(loaderFilePath, before[2], { mode: 0o600 });
                  else fs.rmSync(loaderFilePath, { force: true });
                } else {
                  compensationFailed = true;
                }
              }
            } else if (before[2] !== null) compensationFailed = true;

            // Compensate manifest: ONLY exact trusted receipt manifestHash is owned!
            if (exists(manifestFilePath)) {
              const rawManifest = fs.readFileSync(manifestFilePath, "utf8");
              let isBefore = false;
              if (before[1] !== null) {
                isBefore = rawManifest === before[1];
              }
              if (isBefore) {
                // Preserved pre-setup bytes
              } else {
                const currentManifestHash = hash(rawManifest);
                const isOurs = Boolean(validatedReceipt && currentManifestHash === validatedReceipt.manifestHash);
                if (isOurs) {
                  if (before[1] !== null) fs.writeFileSync(manifestFilePath, before[1], { mode: 0o600 });
                  else fs.rmSync(manifestFilePath, { force: true });
                } else {
                  compensationFailed = true;
                }
              }
            } else if (before[1] !== null) compensationFailed = true;

            if (compensationFailed) fail("Foreign modification detected during compensation; agent files preserved; manual reconciliation required");
            agentState(agent, null, { adoptAgent: true });
          } else {
            childSetup(target, agent, run, true);
            agentState(agent, null);
          }
        }
        if (!markerIsOurs) fail("Metadata drift during compensation");
        atomicJSON(journalPath, { ...journal, state: "compensated" });
        atomicJSON(markerPath, prior);
      } catch (compensation) {
        if (markerIsOurs) {
          try {
            atomicJSON(markerPath, pending);
          } catch {}
        }
        try {
          atomicJSON(journalPath, {
            ...journal,
            state: "failed",
            error: error.message,
            compensationError: compensation.message
          });
        } catch {}
        fail(`Pending deployment requires manual reconciliation: ${error.message}; compensation: ${compensation.message}`);
      }
      throw error;
    }

    // Marker is authoritative once published. A journal failure cannot undo an
    // already committed release: setup-complete is sufficient recovery evidence.
    try { atomicJSON(journalPath, { ...journal, state: "committed" }); } catch { /* retained setup-complete journal */ }
    return { success: true, dryRun: false, releaseDir: target.path };
  } finally {
    if (exists(lock) && !fs.lstatSync(lock).isSymbolicLink() && fs.readFileSync(lock, "utf8") === lockToken) fs.unlinkSync(lock);
  }
}

export function parseDeployArgs(args) {
  const options = {};
  const values = { "--agent-dir": "agentDir", "--install-dir": "installDir", "--source-dir": "sourceDir" };
  const flags = {
    "--update": "update",
    "--rollback-source": "rollbackSource",
    "--adopt-agent": "adoptAgent",
    "--dry-run": "dryRun",
    "--help": "help"
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const key = values[arg] || flags[arg];
    if (!key) fail(`Unknown argument: ${arg}. Use --help.`);
    if (Object.hasOwn(options, key)) fail(`Duplicate argument: ${arg}`);
    if (values[arg]) {
      if (!args[i + 1] || args[i + 1].startsWith("--")) fail(`Missing value for ${arg}`);
      options[key] = args[++i];
    } else options[key] = true;
  }
  const modes = [options.update, options.rollbackSource, options.adoptAgent].filter(Boolean);
  if (modes.length > 1) fail("--update, --rollback-source, and --adopt-agent are mutually exclusive");
  return options;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseDeployArgs(process.argv.slice(2));
    if (options.help) console.log("Uso: node scripts/deploy.mjs [--update | --rollback-source | --adopt-agent] [--dry-run] [--agent-dir DIR] [--install-dir DIR] [--source-dir DIR]\nSin modo: instalación nueva. Con --adopt-agent: adopta una instalación existente previa válida en una raíz managed nueva inexistente. Reiniciá/recargá Pi para cargar la nueva fuente.");
    else console.log(JSON.stringify(runDeploy(options), null, 2));
  } catch (error) {
    console.error(`Despliegue rechazado: ${error.message}`);
    process.exitCode = 1;
  }
}
