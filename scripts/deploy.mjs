import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  MANIFEST_FILENAME, STATE_DIRNAME, JOURNAL_FILENAME, LOCK_FILENAME,
  validateManifest, validateSettings, checkDriftOnReinstall,
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
  if (fs.readdirSync(item.path).sort().join() !== top.join() ||
      fs.readdirSync(path.join(item.path, "scripts")).sort().join() !== "rollback.mjs,setup.mjs" ||
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
function agentState(agent, current) {
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
function childSetup(release, agent, run, rollback = false) {
  const script = path.join(release.path, "scripts", rollback ? "rollback.mjs" : "setup.mjs");
  const args = [script, "--target-dir", agent];
  if (!rollback) args.push("--source-dir", release.path);
  const result = run(process.execPath, args, { encoding: "utf8", env: {}, cwd: release.path });
  if (result.error || result.status !== 0) fail(`Official ${rollback ? "rollback" : "setup"} failed: ${result.stderr || result.error || result.status}`);
}

export function runDeploy(options = {}, dependencies = {}) {
  if (options.update && options.rollbackSource) fail("Update and rollback-source are mutually exclusive");
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
  if (!options.update && !options.rollbackSource && prior.current) fail("Managed install already exists; use --update");
  if (options.update && !prior.current) fail("Update requires a current managed release");
  const original = agentState(agent, prior.current);
  const copy = options.rollbackSource ? null : checkSource(source, run);
  const target = options.rollbackSource ? prior.previous || prior.current : descriptor(root, copy.hash);
  if (!target) fail("No managed release available for rollback");
  if (prior.current?.hash === target.hash) return { success: true, noop: true, dryRun: Boolean(options.dryRun), releaseDir: target.path };
  if (exists(target.path)) verifyRelease(target, root, run);
  if (options.dryRun) return { success: true, dryRun: true, releaseDir: target.path };

  if (!exists(root)) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.writeFileSync(markerPath, JSON.stringify(prior), { flag: "wx", mode: 0o600 });
  }
  const lockToken = crypto.randomUUID();
  fs.writeFileSync(lock, lockToken, { flag: "wx", mode: 0o600 });
  try {
    // Revalidate after acquiring the wrapper lock, before any release/agent writes.
    if (JSON.stringify(readJSON(markerPath)) !== JSON.stringify(prior)) fail("Deployment metadata changed concurrently");
    agentState(agent, prior.current);
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
    const pending = { ...prior, state: "pending", pending: { target, operation: options.rollbackSource ? "rollback-source" : "setup" } };
    const journalPath = path.join(root, "journals", `${lockToken}.json`);
    const journal = { version: 1, agentDir: agent, prior, target, state: "prepared" };
    atomicJSON(journalPath, journal);
    atomicJSON(markerPath, pending);
    const next = { ...prior, current: target, previous: options.rollbackSource ? null : prior.current };
    try {
      childSetup(target, agent, run);
      const installed = agentState(agent, target);
      if (original && JSON.stringify(installed.originalOverrides) !== JSON.stringify(original.originalOverrides)) fail("Setup changed original baseline");
      atomicJSON(journalPath, { ...journal, state: "setup-complete" });
      (dependencies.commit || atomicJSON)(markerPath, next);
    } catch (error) {
      try {
        const liveMarker = readJSON(markerPath);
        if (![JSON.stringify(pending), JSON.stringify(next)].includes(JSON.stringify(liveMarker))) fail("Metadata drift during compensation");
        if (JSON.stringify(snapshot(agent)) !== JSON.stringify(before)) {
          const installed = agentState(agent, target);
          if (original && JSON.stringify(installed.originalOverrides) !== JSON.stringify(original.originalOverrides)) fail("Baseline drift during compensation");
          if (prior.current) {
            verifyRelease(prior.current, root, run);
            childSetup(prior.current, agent, run);
            agentState(agent, prior.current);
          } else {
            childSetup(target, agent, run, true);
            agentState(agent, null);
          }
        }
        atomicJSON(journalPath, { ...journal, state: "compensated" });
        atomicJSON(markerPath, prior);
      } catch (compensation) {
        // Retain the pending ownership marker and journal; never guess recovery.
        atomicJSON(markerPath, pending);
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
  const flags = { "--update": "update", "--rollback-source": "rollbackSource", "--dry-run": "dryRun", "--help": "help" };
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
  if (options.update && options.rollbackSource) fail("--update and --rollback-source are mutually exclusive");
  return options;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseDeployArgs(process.argv.slice(2));
    if (options.help) console.log("Uso: node scripts/deploy.mjs [--update | --rollback-source] [--dry-run] [--agent-dir DIR] [--install-dir DIR] [--source-dir DIR]\nSin modo: instalación nueva. No adopta instalaciones existentes. Reiniciá/recargá Pi para cargar la nueva fuente.");
    else console.log(JSON.stringify(runDeploy(options), null, 2));
  } catch (error) {
    console.error(`Despliegue rechazado: ${error.message}`);
    process.exitCode = 1;
  }
}
