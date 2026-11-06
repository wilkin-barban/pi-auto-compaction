import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { runDeploy, parseDeployArgs, MARKER_FILENAME } from "../../scripts/deploy.mjs";

const project = fileURLToPath(new URL("../../", import.meta.url));
const manifestName = ".pi-auto-compaction-manifest.json";
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));

const trackedDeployFixtures = new Set();

afterEach(() => {
  for (const base of trackedDeployFixtures) {
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
    trackedDeployFixtures.delete(base);
  }
});

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deploy-test-"));
  trackedDeployFixtures.add(base);
  if (t?.after) {
    t.after(() => {
      trackedDeployFixtures.delete(base);
      try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
    });
  }
  const sourceDir = path.join(base, "source");
  const agentDir = path.join(base, "agent");
  const installDir = path.join(base, "install");
  fs.mkdirSync(sourceDir);
  for (const name of ["index.mjs", "package.json", "README.md"]) {
    fs.copyFileSync(path.join(project, name), path.join(sourceDir, name));
  }
  for (const dir of ["src", "scripts"]) {
    fs.mkdirSync(path.join(sourceDir, dir));
    for (const name of fs.readdirSync(path.join(project, dir))) {
      if ((dir === "src" && name.endsWith(".mjs")) || ["setup.mjs", "rollback.mjs"].includes(name)) {
        fs.copyFileSync(path.join(project, dir, name), path.join(sourceDir, dir, name));
      }
    }
  }
  fs.mkdirSync(agentDir);
  write(path.join(agentDir, "settings.json"), { theme: "test", compaction: {
    modelOverrides: { "openai/gpt-6-sol": { reserveTokens: 123, custom: true } },
  } });
  return { sourceDir, agentDir, installDir, base };
}
const manifest = (f) => read(path.join(f.agentDir, manifestName));
const marker = (f) => read(path.join(f.installDir, MARKER_FILENAME));
function change(f, text = "// new release\n") {
  fs.appendFileSync(path.join(f.sourceDir, "src/config.mjs"), text);
}
function agentBytes(f) {
  return ["settings.json", manifestName, "extensions/omniroute-compaction.ts"].map((name) => {
    const file = path.join(f.agentDir, name);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  });
}

function createLegacySource(base) {
  const oldSource = path.join(base, "old-flat-source");
  fs.mkdirSync(oldSource);
  for (const name of ["index.mjs", "package.json", "README.md"]) {
    fs.copyFileSync(path.join(project, name), path.join(oldSource, name));
  }
  for (const dir of ["src", "scripts"]) {
    fs.mkdirSync(path.join(oldSource, dir));
    for (const name of fs.readdirSync(path.join(project, dir))) {
      if ((dir === "src" && name.endsWith(".mjs")) || ["setup.mjs", "rollback.mjs"].includes(name)) {
        fs.copyFileSync(path.join(project, dir, name), path.join(oldSource, dir, name));
      }
    }
  }
  return oldSource;
}

function setupOccupiedAgent(f) {
  const oldSource = createLegacySource(f.base);
  const setupScript = path.join(oldSource, "scripts", "setup.mjs");
  const result = spawnSync(process.execPath, [setupScript, "--target-dir", f.agentDir, "--source-dir", oldSource], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Occupied setup failed: ${result.stderr}`);
  return oldSource;
}

test("fresh copy, update, idempotency and source rollback preserve the original baseline", (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.sourceDir, "node_modules"));
  fs.mkdirSync(path.join(f.sourceDir, ".git"));
  fs.mkdirSync(path.join(f.sourceDir, "test"));
  fs.writeFileSync(path.join(f.sourceDir, "ignored-runtime.json"), "synthetic private fixture");
  const first = runDeploy(f);
  const baseline = manifest(f).originalOverrides;
  assert.equal(Object.keys(manifest(f).originalOverrides).length, 4);
  assert.equal(manifest(f).packageSourceDir, first.releaseDir);
  assert.deepEqual(fs.readdirSync(first.releaseDir).sort(), [".release.json", "README.md", "index.mjs", "package.json", "scripts", "src"]);
  const bytes = agentBytes(f);
  assert.equal(runDeploy({ ...f, update: true }).noop, true);
  assert.deepEqual(agentBytes(f), bytes);
  assert.equal(marker(f).previous, null);
  change(f);
  const second = runDeploy({ ...f, update: true });
  assert.notEqual(first.releaseDir, second.releaseDir);
  assert.equal(marker(f).previous.path, first.releaseDir);
  assert.deepEqual(manifest(f).originalOverrides, baseline);
  const rolled = runDeploy({ ...f, rollbackSource: true });
  assert.equal(rolled.releaseDir, first.releaseDir);
  assert.deepEqual(manifest(f).originalOverrides, baseline);
  assert.equal(manifest(f).originalOverrides["openai/gpt-6-sol"].reserveTokens.value, 123);
  assert.equal(marker(f).previous, null, "rollback is one step, not an alternating toggle");
  assert.equal(runDeploy({ ...f, rollbackSource: true }).noop, true);
  assert.ok(fs.existsSync(second.releaseDir), "old loaded files are never deleted");
});

test("dry run validates without creating any installation or agent directories", (t) => {
  const f = fixture(t);
  f.agentDir = path.join(f.base, "absent-agent");
  assert.equal(runDeploy({ ...f, dryRun: true }).dryRun, true);
  assert.equal(fs.existsSync(f.installDir), false);
  assert.equal(fs.existsSync(f.agentDir), false);
  change(f, "invalid javascript {{{\n");
  assert.throws(() => runDeploy({ ...f, dryRun: true }), /syntax|Syntax/i);
  assert.equal(fs.existsSync(f.installDir), false);
});

test("legacy flat and even empty unmanaged roots are rejected without adoption", (t) => {
  for (const legacy of [false, true]) {
    const f = fixture(t);
    fs.mkdirSync(f.installDir);
    if (legacy) fs.writeFileSync(path.join(f.installDir, "index.mjs"), "// legacy sentinel");
    const before = agentBytes(f);
    assert.throws(() => runDeploy(f), /unmanaged|ownership/i);
    assert.deepEqual(agentBytes(f), before);
    assert.deepEqual(fs.readdirSync(f.installDir), legacy ? ["index.mjs"] : []);
  }
  const f = fixture(t);
  assert.throws(() => runDeploy({ ...f, update: true }), /managed|update/i);
  assert.equal(fs.existsSync(f.installDir), false);
});

test("settings drift and foreign agent manifests reject updates before staging", (t) => {
  const f = fixture(t);
  runDeploy(f);
  const settings = read(path.join(f.agentDir, "settings.json"));
  settings.compaction.modelOverrides["openai/gpt-6-sol"].reserveTokens = 99;
  write(path.join(f.agentDir, "settings.json"), settings);
  change(f);
  const before = agentBytes(f);
  const owned = fs.readFileSync(path.join(f.installDir, MARKER_FILENAME), "utf8");
  assert.throws(() => runDeploy({ ...f, update: true }), /drift|Conflict/);
  assert.deepEqual(agentBytes(f), before);
  assert.equal(fs.readFileSync(path.join(f.installDir, MARKER_FILENAME), "utf8"), owned);
  const foreignAgent = path.join(f.base, "foreign-agent");
  assert.throws(() => runDeploy({ ...f, agentDir: foreignAgent, update: true }), /agent|ownership/i);
  assert.equal(fs.existsSync(foreignAgent), false);
});

test("mutated previous release, corrupt metadata and symlink paths fail closed", (t) => {
  const f = fixture(t);
  const first = runDeploy(f);
  change(f);
  runDeploy({ ...f, update: true });
  fs.appendFileSync(path.join(first.releaseDir, "index.mjs"), "// tampered\n");
  const before = agentBytes(f);
  assert.throws(() => runDeploy({ ...f, rollbackSource: true }), /hash|release/i);
  assert.deepEqual(agentBytes(f), before);
  const metadata = marker(f);
  metadata.current.path = f.sourceDir;
  write(path.join(f.installDir, MARKER_FILENAME), metadata);
  assert.throws(() => runDeploy({ ...f, update: true }), /metadata|path|release/i);
  const g = fixture(t);
  fs.symlinkSync(g.sourceDir, g.installDir, "dir");
  assert.throws(() => runDeploy(g), /symlink/i);
  assert.equal(fs.existsSync(path.join(g.sourceDir, MARKER_FILENAME)), false);
  const h = fixture(t);
  fs.symlinkSync(path.join(h.sourceDir, "index.mjs"), path.join(h.sourceDir, "src/unsafe.mjs"));
  assert.throws(() => runDeploy(h), /symlink/i);
  assert.equal(fs.existsSync(h.installDir), false);
});

test("literal imports outside the allowlist and unknown CLI flags are rejected", (t) => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.sourceDir, "index.mjs"), '\nimport "./outside.mjs";\n');
  assert.throws(() => runDeploy(f), /import|allowlist/i);
  assert.equal(fs.existsSync(f.installDir), false);
  assert.throws(() => parseDeployArgs(["--doctor"]), /Unknown|unknown/);
  assert.throws(() => parseDeployArgs(["--agent-dir"]), /value/i);
  assert.throws(() => parseDeployArgs(["--update", "--rollback-source"]), /exclusive|combine/i);
  assert.equal(parseDeployArgs(["--dry-run", "--agent-dir", f.agentDir]).agentDir, f.agentDir);
});

test("failed child setup keeps prior metadata and source, with a durable journal", (t) => {
  const f = fixture(t);
  runDeploy(f);
  change(f);
  const before = agentBytes(f);
  const prior = marker(f);
  const run = (node, args, options) => args[0].endsWith("setup.mjs")
    ? { status: 1, stderr: "fixture setup failure" } : spawnSync(node, args, options);
  assert.throws(() => runDeploy({ ...f, update: true }, { run }), /fixture setup failure/);
  assert.deepEqual(agentBytes(f), before);
  assert.deepEqual(marker(f), prior);
  assert.ok(fs.readdirSync(path.join(f.installDir, "journals")).length >= 2);
});

test("actual setup failure at manifest write restores prior agent bytes and marker", (t) => {
  const f = fixture(t);
  runDeploy(f);
  change(f);
  const before = agentBytes(f);
  const prior = marker(f);
  const run = (node, args, options) => {
    if (!args[0].endsWith("setup.mjs")) return spawnSync(node, args, options);
    const source = args[args.indexOf("--source-dir") + 1];
    const code = `import { runSetup } from ${JSON.stringify(pathToFileURL(args[0]).href)};
      runSetup(${JSON.stringify({ agentDir: f.agentDir, packageSourceDir: source, _testInjectFailureAt: "at-manifest-write" })});`;
    return spawnSync(node, ["--input-type=module", "-e", code], options);
  };
  assert.throws(() => runDeploy({ ...f, update: true }, { run }), /Injected failure at-manifest-write/);
  assert.deepEqual(agentBytes(f), before);
  assert.deepEqual(marker(f), prior);
});

test("managed dry run changes neither manifests nor source copies; foreign source and agent symlinks reject", (t) => {
  const f = fixture(t);
  runDeploy(f);
  change(f);
  const before = agentBytes(f);
  const prior = marker(f);
  const releases = fs.readdirSync(path.join(f.installDir, "releases"));
  assert.equal(runDeploy({ ...f, update: true, dryRun: true }).dryRun, true);
  assert.deepEqual(agentBytes(f), before);
  assert.deepEqual(marker(f), prior);
  assert.deepEqual(fs.readdirSync(path.join(f.installDir, "releases")), releases);
  const foreign = manifest(f);
  foreign.packageSourceDir = f.sourceDir;
  write(path.join(f.agentDir, manifestName), foreign);
  assert.throws(() => runDeploy({ ...f, update: true }), /source ownership mismatch/);
  const g = fixture(t);
  fs.symlinkSync(g.sourceDir, path.join(g.agentDir, "extensions"), "dir");
  assert.throws(() => runDeploy(g), /symlink/);
  assert.equal(fs.existsSync(g.installDir), false);
});

test("metadata publication failure compensates successful setup by reselecting prior release", (t) => {
  const f = fixture(t);
  const first = runDeploy(f);
  change(f);
  const baseline = manifest(f).originalOverrides;
  const prior = marker(f);
  const commit = () => { throw new Error("fixture metadata failure"); };
  assert.throws(() => runDeploy({ ...f, update: true }, { commit }), /fixture metadata failure/);
  assert.equal(manifest(f).packageSourceDir, first.releaseDir);
  assert.deepEqual(manifest(f).originalOverrides, baseline);
  assert.deepEqual(marker(f), prior);
  assert.ok(runDeploy({ ...f, update: true }).success);
});

test("fresh metadata failure removes only its own setup and preserves baseline values", (t) => {
  const f = fixture(t);
  const baseline = read(path.join(f.agentDir, "settings.json"));
  const commit = () => { throw new Error("fixture fresh commit failure"); };
  assert.throws(() => runDeploy(f, { commit }), /fixture fresh commit failure/);
  assert.deepEqual(read(path.join(f.agentDir, "settings.json")), baseline);
  assert.equal(fs.existsSync(path.join(f.agentDir, manifestName)), false);
  assert.equal(marker(f).current, null);
  assert.ok(runDeploy(f).success);
});

test("failed compensation leaves pending marker and blocks all later calls including dry run", (t) => {
  const f = fixture(t);
  runDeploy(f);
  change(f);
  let setups = 0;
  const run = (node, args, options) => {
    if (args[0].endsWith("setup.mjs") && ++setups === 2) return { status: 1, stderr: "compensation unavailable" };
    return spawnSync(node, args, options);
  };
  assert.throws(() => runDeploy({ ...f, update: true }, {
    run, commit() { throw new Error("commit unavailable"); },
  }), /reconcil|pending|compensation/i);
  assert.equal(marker(f).state, "pending");
  const before = agentBytes(f);
  assert.throws(() => runDeploy({ ...f, update: true, dryRun: true }), /pending|reconcil/i);
  assert.deepEqual(agentBytes(f), before);
});

test("successful adopt occupied valid agent preserves baseline/nonmanaged settings and old source unchanged loader/new marker ready", (t) => {
  const f = fixture(t);
  const oldSource = setupOccupiedAgent(f);
  const baseline = manifest(f).originalOverrides;
  const initialSettings = read(path.join(f.agentDir, "settings.json"));
  assert.equal(initialSettings.theme, "test");
  assert.equal(manifest(f).packageSourceDir, oldSource);
  assert.equal(fs.existsSync(f.installDir), false);

  const res = runDeploy({ ...f, adoptAgent: true });
  assert.equal(res.success, true);
  assert.equal(res.releaseDir, path.join(f.installDir, "releases", marker(f).current.hash));
  assert.equal(marker(f).state, "ready");
  assert.equal(marker(f).previous, null);
  assert.equal(marker(f).current.path, res.releaseDir);
  assert.equal(manifest(f).packageSourceDir, res.releaseDir);
  assert.deepEqual(manifest(f).originalOverrides, baseline);
  assert.equal(manifest(f).originalOverrides["openai/gpt-6-sol"].reserveTokens.value, 123);
  assert.equal(read(path.join(f.agentDir, "settings.json")).theme, "test");
  assert.ok(fs.existsSync(path.join(oldSource, "index.mjs")));
  assert.ok(fs.existsSync(path.join(f.agentDir, "extensions", "omniroute-compaction.ts")));
});

test("--update later works and original baseline preserved on adopted agent", (t) => {
  const f = fixture(t);
  const oldSource = setupOccupiedAgent(f);
  const baseline = manifest(f).originalOverrides;
  const first = runDeploy({ ...f, adoptAgent: true });
  assert.equal(first.success, true);

  // rollbackSource on adopted agent with no previous release is a no-op
  const rolled = runDeploy({ ...f, rollbackSource: true });
  assert.equal(rolled.noop, true);
  assert.equal(rolled.releaseDir, first.releaseDir);

  change(f);
  const second = runDeploy({ ...f, update: true });
  assert.notEqual(first.releaseDir, second.releaseDir);
  assert.equal(marker(f).previous.path, first.releaseDir);
  assert.equal(marker(f).current.path, second.releaseDir);
  assert.deepEqual(manifest(f).originalOverrides, baseline);
  assert.equal(manifest(f).packageSourceDir, second.releaseDir);
  assert.equal(read(path.join(f.agentDir, "settings.json")).theme, "test");
});

test("dry run read only for adoption", (t) => {
  const f = fixture(t);
  const oldSource = setupOccupiedAgent(f);
  const res = runDeploy({ ...f, adoptAgent: true, dryRun: true });
  assert.equal(res.dryRun, true);
  assert.equal(fs.existsSync(f.installDir), false);
  assert.equal(manifest(f).packageSourceDir, oldSource);
});

test("adopt missing manifest/foreign loader/bad hash/settings drift/lock/journal/symlinks/root collision invalid schema source invalid args rejects BEFORE writes", (t) => {
  // 1. Missing manifest
  {
    const f = fixture(t);
    setupOccupiedAgent(f);
    fs.rmSync(path.join(f.agentDir, manifestName));
    assert.throws(() => runDeploy({ ...f, adoptAgent: true }), /manifest|ownership|adoption/i);
    assert.equal(fs.existsSync(f.installDir), false);
  }
  // 2. Foreign loader
  {
    const f = fixture(t);
    setupOccupiedAgent(f);
    fs.writeFileSync(path.join(f.agentDir, "extensions", "omniroute-compaction.ts"), "// tampered loader\n");
    assert.throws(() => runDeploy({ ...f, adoptAgent: true }), /drift|modified|hash/i);
    assert.equal(fs.existsSync(f.installDir), false);
  }
  // 3. Settings drift
  {
    const f = fixture(t);
    setupOccupiedAgent(f);
    const settings = read(path.join(f.agentDir, "settings.json"));
    settings.compaction.modelOverrides["openai/gpt-6-sol"].reserveTokens = 99999;
    write(path.join(f.agentDir, "settings.json"), settings);
    assert.throws(() => runDeploy({ ...f, adoptAgent: true }), /drift|Conflict/i);
    assert.equal(fs.existsSync(f.installDir), false);
  }
  // 4. Agent lock active
  {
    const f = fixture(t);
    setupOccupiedAgent(f);
    fs.writeFileSync(path.join(f.agentDir, ".pi-auto-compaction.lock"), "active-lock");
    assert.throws(() => runDeploy({ ...f, adoptAgent: true }), /lock|journal/i);
    assert.equal(fs.existsSync(f.installDir), false);
  }
  // 5. Recovery journal active
  {
    const f = fixture(t);
    setupOccupiedAgent(f);
    fs.mkdirSync(path.join(f.agentDir, ".pi-auto-compaction-state"), { recursive: true });
    fs.writeFileSync(path.join(f.agentDir, ".pi-auto-compaction-state", "recovery-journal.json"), "{}");
    assert.throws(() => runDeploy({ ...f, adoptAgent: true }), /journal|lock/i);
    assert.equal(fs.existsSync(f.installDir), false);
  }
  // 6. Root collision: installDir already exists
  {
    const f = fixture(t);
    setupOccupiedAgent(f);
    fs.mkdirSync(f.installDir);
    assert.throws(() => runDeploy({ ...f, adoptAgent: true }), /inexistent|non-existent|managed|already exists/i);
  }
  // 7. Symlink in installDir
  {
    const f = fixture(t);
    setupOccupiedAgent(f);
    fs.symlinkSync(f.sourceDir, f.installDir, "dir");
    assert.throws(() => runDeploy({ ...f, adoptAgent: true }), /symlink/i);
  }
  // 8. Invalid schema in manifest
  {
    const f = fixture(t);
    setupOccupiedAgent(f);
    const m = manifest(f);
    delete m.originalOverrides;
    write(path.join(f.agentDir, manifestName), m);
    assert.throws(() => runDeploy({ ...f, adoptAgent: true }), /schema|originalOverrides|manifest/i);
    assert.equal(fs.existsSync(f.installDir), false);
  }
  // 9. Mutually exclusive CLI args
  assert.throws(() => parseDeployArgs(["--adopt-agent", "--update"]), /exclusive/i);
  assert.throws(() => parseDeployArgs(["--adopt-agent", "--rollback-source"]), /exclusive/i);
});

test("failed setup/adoption post validation failure compensate old source", (t) => {
  const f = fixture(t);
  const oldSource = setupOccupiedAgent(f);
  const before = agentBytes(f);
  const run = (node, args, options) => {
    if (args[0].endsWith("setup.mjs")) {
      return { status: 1, stderr: "simulated target setup failure" };
    }
    return spawnSync(node, args, options);
  };
  assert.throws(() => runDeploy({ ...f, adoptAgent: true }, { run }), /simulated target setup failure/);
  assert.deepEqual(agentBytes(f), before);
  assert.equal(manifest(f).packageSourceDir, oldSource);
});

test("concurrent foreign state at publication never overwrite/retain journal", (t) => {
  const f = fixture(t);
  const oldSource = setupOccupiedAgent(f);
  const commit = () => {
    // Foreign process writes a foreign property to settings.json concurrently
    const settings = read(path.join(f.agentDir, "settings.json"));
    settings.foreignField = "unauthorized concurrent mutation";
    write(path.join(f.agentDir, "settings.json"), settings);
    throw new Error("simulated publication failure");
  };
  assert.throws(() => runDeploy({ ...f, adoptAgent: true }, { commit }), /simulated publication failure|foreign|reconcil/i);
  // Assert foreign change was preserved and not overwritten
  const liveSettings = read(path.join(f.agentDir, "settings.json"));
  assert.equal(liveSettings.foreignField, "unauthorized concurrent mutation");
  // Journal is retained and marker is pending, blocking subsequent operations
  assert.equal(marker(f).state, "pending");
  assert.throws(() => runDeploy({ ...f, adoptAgent: true }), /pending|reconcil/i);
});

test("fixture teardown removes exact created temp directory even on simulated failure", () => {
  let createdBase;
  const cleanupHooks = [];
  const fakeContext = {
    after(fn) { cleanupHooks.push(fn); },
  };
  const f = fixture(fakeContext);
  createdBase = f.base;
  assert.ok(fs.existsSync(createdBase), "fixture directory must exist after creation");
  for (const hook of cleanupHooks) hook();
  assert.equal(fs.existsSync(createdBase), false, "fixture directory must be removed by teardown");
});

test("compensation preserves concurrent modifications within compaction settings byte-identical and retains journal", (t) => {
  const f = fixture(t);
  const oldSource = setupOccupiedAgent(f);
  const beforeBytes = agentBytes(f);
  let foreignSettingsBytes;

  const run = (node, args, options) => {
    if (args[0].endsWith("setup.mjs")) {
      const res = spawnSync(node, args, options);
      if (res.status !== 0) return res;
      const settingsPath = path.join(f.agentDir, "settings.json");
      const s = read(settingsPath);
      s.compaction.foreignCompactionKey = "concurrent-foreign-compaction-value";
      write(settingsPath, s);
      foreignSettingsBytes = fs.readFileSync(settingsPath, "utf8");
      return { status: 1, stdout: res.stdout, stderr: "synthetic after-setup failure" };
    }
    return spawnSync(node, args, options);
  };

  assert.throws(
    () => runDeploy({ ...f, adoptAgent: true }, { run }),
    /Foreign modification|reconcil|synthetic after-setup/i,
  );

  assert.equal(fs.readFileSync(path.join(f.agentDir, "settings.json"), "utf8"), foreignSettingsBytes);
  assert.equal(fs.readFileSync(path.join(f.agentDir, "extensions", "omniroute-compaction.ts"), "utf8"), beforeBytes[2]);
  assert.equal(fs.readFileSync(path.join(f.agentDir, manifestName), "utf8"), beforeBytes[1]);
  assert.equal(marker(f).state, "pending");
  assert.ok(fs.readdirSync(path.join(f.installDir, "journals")).length >= 1);
});

test("compensation preserves concurrent foreign loader containing target path byte-identical and retains journal", (t) => {
  const f = fixture(t);
  const oldSource = setupOccupiedAgent(f);
  const beforeBytes = agentBytes(f);
  let foreignLoaderBytes;

  const run = (node, args, options) => {
    if (args[0].endsWith("setup.mjs")) {
      const res = spawnSync(node, args, options);
      if (res.status !== 0) return res;
      const targetPath = args[args.indexOf("--source-dir") + 1];
      const loaderPath = path.join(f.agentDir, "extensions", "omniroute-compaction.ts");
      const foreignLoader = `// Foreign concurrent extension referencing ${targetPath}\nconsole.log("foreign injection");\n`;
      fs.writeFileSync(loaderPath, foreignLoader, "utf8");
      foreignLoaderBytes = foreignLoader;
      return { status: 1, stdout: res.stdout, stderr: "synthetic after-setup failure" };
    }
    return spawnSync(node, args, options);
  };

  assert.throws(
    () => runDeploy({ ...f, adoptAgent: true }, { run }),
    /Foreign modification|reconcil|synthetic after-setup/i,
  );

  assert.equal(fs.readFileSync(path.join(f.agentDir, "extensions", "omniroute-compaction.ts"), "utf8"), foreignLoaderBytes);
  assert.equal(fs.readFileSync(path.join(f.agentDir, "settings.json"), "utf8"), beforeBytes[0]);
  assert.equal(fs.readFileSync(path.join(f.agentDir, manifestName), "utf8"), beforeBytes[1]);
  assert.equal(marker(f).state, "pending");
  assert.ok(fs.readdirSync(path.join(f.installDir, "journals")).length >= 1);
});

test("compensation preserves concurrent foreign manifest baseline byte-identical and retains journal", (t) => {
  const f = fixture(t);
  const oldSource = setupOccupiedAgent(f);
  const beforeBytes = agentBytes(f);
  let foreignManifestBytes;

  const run = (node, args, options) => {
    if (args[0].endsWith("setup.mjs")) {
      const res = spawnSync(node, args, options);
      if (res.status !== 0) return res;
      const manifestPath = path.join(f.agentDir, manifestName);
      const m = read(manifestPath);
      m.originalOverrides["openai/gpt-6-sol"].reserveTokens.value = 999999;
      write(manifestPath, m);
      foreignManifestBytes = fs.readFileSync(manifestPath, "utf8");
      return { status: 1, stdout: res.stdout, stderr: "synthetic after-setup failure" };
    }
    return spawnSync(node, args, options);
  };

  assert.throws(
    () => runDeploy({ ...f, adoptAgent: true }, { run }),
    /Foreign modification|reconcil|synthetic after-setup/i,
  );

  assert.equal(fs.readFileSync(path.join(f.agentDir, manifestName), "utf8"), foreignManifestBytes);
  assert.equal(fs.readFileSync(path.join(f.agentDir, "settings.json"), "utf8"), beforeBytes[0]);
  assert.equal(fs.readFileSync(path.join(f.agentDir, "extensions", "omniroute-compaction.ts"), "utf8"), beforeBytes[2]);
  assert.equal(marker(f).state, "pending");
  assert.ok(fs.readdirSync(path.join(f.installDir, "journals")).length >= 1);
});

test("foreign marker is preserved byte-exact and catch does not overwrite with pending", (t) => {
  const f = fixture(t);
  const oldSource = setupOccupiedAgent(f);
  const beforeBytes = agentBytes(f);
  let foreignMarkerBytes;

  const run = (node, args, options) => {
    if (args[0].endsWith("setup.mjs")) {
      const res = spawnSync(node, args, options);
      if (res.status !== 0) return res;
      const markerPath = path.join(f.installDir, MARKER_FILENAME);
      const m = read(markerPath);
      m.foreignField = "concurrent-foreign-marker-value";
      m.state = "custom-foreign-state";
      write(markerPath, m);
      foreignMarkerBytes = fs.readFileSync(markerPath, "utf8");
      return { status: 1, stdout: res.stdout, stderr: "synthetic after-setup failure" };
    }
    return spawnSync(node, args, options);
  };

  assert.throws(
    () => runDeploy({ ...f, adoptAgent: true }, { run }),
    /Metadata drift|reconcil|synthetic after-setup/i,
  );

  assert.equal(fs.readFileSync(path.join(f.installDir, MARKER_FILENAME), "utf8"), foreignMarkerBytes);
  assert.equal(fs.readFileSync(path.join(f.agentDir, "settings.json"), "utf8"), beforeBytes[0]);
  assert.equal(fs.readFileSync(path.join(f.agentDir, "extensions", "omniroute-compaction.ts"), "utf8"), beforeBytes[2]);
  assert.equal(fs.readFileSync(path.join(f.agentDir, manifestName), "utf8"), beforeBytes[1]);
  assert.ok(fs.readdirSync(path.join(f.installDir, "journals")).length >= 1);
});

test("post-publication mutation of baseline fails closed, preserves foreign manifest and retains pending journal", (t) => {
  const f = fixture(t);
  setupOccupiedAgent(f);
  let foreignManifestBytes;

  const commit = (markerPath, next) => {
    fs.writeFileSync(markerPath, JSON.stringify(next, null, 2));
    const manifestPath = path.join(f.agentDir, manifestName);
    const m = read(manifestPath);
    m.originalOverrides["openai/gpt-6-sol"].reserveTokens.value = 888888;
    write(manifestPath, m);
    foreignManifestBytes = fs.readFileSync(manifestPath, "utf8");
  };

  assert.throws(
    () => runDeploy({ ...f, adoptAgent: true }, { commit }),
    /baseline|drift|reconcil|corrupt/i,
  );

  assert.equal(fs.readFileSync(path.join(f.agentDir, manifestName), "utf8"), foreignManifestBytes);
  assert.equal(marker(f).state, "pending");
  assert.ok(fs.readdirSync(path.join(f.installDir, "journals")).length >= 1);
});

test("compensation preserves concurrent foreign manifest timestamp mutation within window, byte-identical and retains journal", (t) => {
  const f = fixture(t);
  const oldSource = setupOccupiedAgent(f);
  const beforeBytes = agentBytes(f);
  let foreignManifestBytes;

  const run = (node, args, options) => {
    if (args[0].endsWith("setup.mjs")) {
      const res = spawnSync(node, args, options);
      if (res.status !== 0) return res;
      const manifestPath = path.join(f.agentDir, manifestName);
      const m = read(manifestPath);
      m.installedAt = new Date(Date.parse(m.installedAt) + 1000).toISOString();
      write(manifestPath, m);
      foreignManifestBytes = fs.readFileSync(manifestPath, "utf8");
      return { status: 1, stdout: res.stdout, stderr: "synthetic after-setup failure" };
    }
    return spawnSync(node, args, options);
  };

  assert.throws(
    () => runDeploy({ ...f, adoptAgent: true }, { run }),
    /Foreign modification|reconcil|synthetic after-setup/i,
  );

  assert.equal(fs.readFileSync(path.join(f.agentDir, manifestName), "utf8"), foreignManifestBytes);
  assert.equal(fs.readFileSync(path.join(f.agentDir, "settings.json"), "utf8"), beforeBytes[0]);
  assert.equal(fs.readFileSync(path.join(f.agentDir, "extensions", "omniroute-compaction.ts"), "utf8"), beforeBytes[2]);
  assert.equal(marker(f).state, "pending");
  assert.ok(fs.readdirSync(path.join(f.installDir, "journals")).length >= 1);
});

test("postcommit unknown manifest field fails closed, preserves foreign manifest and retains pending journal", (t) => {
  const f = fixture(t);
  setupOccupiedAgent(f);
  let foreignManifestBytes;

  const commit = (markerPath, next) => {
    fs.writeFileSync(markerPath, JSON.stringify(next, null, 2));
    const manifestPath = path.join(f.agentDir, manifestName);
    const m = read(manifestPath);
    m.unauthorizedField = "foreign-metadata-addition";
    write(manifestPath, m);
    foreignManifestBytes = fs.readFileSync(manifestPath, "utf8");
  };

  assert.throws(
    () => runDeploy({ ...f, adoptAgent: true }, { commit }),
    /schema|unknown|drift|corrupt|reconcil/i,
  );

  assert.equal(fs.readFileSync(path.join(f.agentDir, manifestName), "utf8"), foreignManifestBytes);
  assert.equal(marker(f).state, "pending");
  assert.ok(fs.readdirSync(path.join(f.installDir, "journals")).length >= 1);
});

test("postcommit foreign marker mutation fails closed, preserves foreign marker byte-identical and retains pending journal", (t) => {
  const f = fixture(t);
  setupOccupiedAgent(f);
  let foreignMarkerBytes;

  const commit = (markerPath, next) => {
    const tampered = { ...next, foreignField: "unauthorized-marker-mutation", state: "foreign-state" };
    fs.writeFileSync(markerPath, JSON.stringify(tampered, null, 2));
    foreignMarkerBytes = fs.readFileSync(markerPath, "utf8");
  };

  assert.throws(
    () => runDeploy({ ...f, adoptAgent: true }, { commit }),
    /marker|drift|corrupt|schema|reconcil/i,
  );

  assert.equal(fs.readFileSync(path.join(f.installDir, MARKER_FILENAME), "utf8"), foreignMarkerBytes);
  assert.ok(fs.readdirSync(path.join(f.installDir, "journals")).length >= 1);
});

test("compensation preserves equivalent ISO timestamp format foreign manifest mutation, byte-identical and retains journal", (t) => {
  const f = fixture(t);
  const oldSource = setupOccupiedAgent(f);
  const beforeBytes = agentBytes(f);
  let foreignManifestBytes;

  const run = (node, args, options) => {
    if (args[0].endsWith("setup.mjs")) {
      const res = spawnSync(node, args, options);
      if (res.status !== 0) return res;
      const manifestPath = path.join(f.agentDir, manifestName);
      const m = read(manifestPath);
      m.installedAt = m.installedAt.replace("Z", "+00:00");
      write(manifestPath, m);
      foreignManifestBytes = fs.readFileSync(manifestPath, "utf8");
      return { status: 1, stdout: res.stdout, stderr: "synthetic after-setup failure" };
    }
    return spawnSync(node, args, options);
  };

  assert.throws(
    () => runDeploy({ ...f, adoptAgent: true }, { run }),
    /Foreign modification|reconcil|synthetic after-setup/i,
  );

  assert.equal(fs.readFileSync(path.join(f.agentDir, manifestName), "utf8"), foreignManifestBytes);
  assert.equal(fs.readFileSync(path.join(f.agentDir, "settings.json"), "utf8"), beforeBytes[0]);
  assert.equal(fs.readFileSync(path.join(f.agentDir, "extensions", "omniroute-compaction.ts"), "utf8"), beforeBytes[2]);
  assert.equal(marker(f).state, "pending");
  assert.ok(fs.readdirSync(path.join(f.installDir, "journals")).length >= 1);
});

test("successful setup return status 0 preserves foreign unknown manifest field, byte-identical and retains pending journal", (t) => {
  const f = fixture(t);
  const oldSource = setupOccupiedAgent(f);
  const beforeBytes = agentBytes(f);
  let foreignManifestBytes;

  const run = (node, args, options) => {
    if (args[0].endsWith("setup.mjs")) {
      const res = spawnSync(node, args, options);
      if (res.status !== 0) return res;
      const manifestPath = path.join(f.agentDir, manifestName);
      const m = read(manifestPath);
      m.unauthorizedField = "foreign-unknown-manifest-value";
      write(manifestPath, m);
      foreignManifestBytes = fs.readFileSync(manifestPath, "utf8");
      return res;
    }
    return spawnSync(node, args, options);
  };

  assert.throws(
    () => runDeploy({ ...f, adoptAgent: true }, { run }),
    /schema|unknown|corrupt|reconcil/i,
  );

  assert.equal(fs.readFileSync(path.join(f.agentDir, manifestName), "utf8"), foreignManifestBytes);
  assert.equal(fs.readFileSync(path.join(f.agentDir, "settings.json"), "utf8"), beforeBytes[0]);
  assert.equal(fs.readFileSync(path.join(f.agentDir, "extensions", "omniroute-compaction.ts"), "utf8"), beforeBytes[2]);
  assert.equal(marker(f).state, "pending");
  assert.ok(fs.readdirSync(path.join(f.installDir, "journals")).length >= 1);
});

test("successful setup return status 0 preserves foreign valid baseline mutation, byte-identical and retains pending journal", (t) => {
  const f = fixture(t);
  const oldSource = setupOccupiedAgent(f);
  const beforeBytes = agentBytes(f);
  let foreignManifestBytes;

  const run = (node, args, options) => {
    if (args[0].endsWith("setup.mjs")) {
      const res = spawnSync(node, args, options);
      if (res.status !== 0) return res;
      const manifestPath = path.join(f.agentDir, manifestName);
      const m = read(manifestPath);
      m.originalOverrides["openai/gpt-6-sol"].reserveTokens.value = 999999;
      write(manifestPath, m);
      foreignManifestBytes = fs.readFileSync(manifestPath, "utf8");
      return res;
    }
    return spawnSync(node, args, options);
  };

  assert.throws(
    () => runDeploy({ ...f, adoptAgent: true }, { run }),
    /baseline|drift|reconcil|changed/i,
  );

  assert.equal(fs.readFileSync(path.join(f.agentDir, manifestName), "utf8"), foreignManifestBytes);
  assert.equal(fs.readFileSync(path.join(f.agentDir, "settings.json"), "utf8"), beforeBytes[0]);
  assert.equal(fs.readFileSync(path.join(f.agentDir, "extensions", "omniroute-compaction.ts"), "utf8"), beforeBytes[2]);
  assert.equal(marker(f).state, "pending");
  assert.ok(fs.readdirSync(path.join(f.installDir, "journals")).length >= 1);
});

test("postcommit equivalent ISO timestamp manifest mutation fails closed, preserves foreign manifest and retains pending journal", (t) => {
  const f = fixture(t);
  setupOccupiedAgent(f);
  let foreignManifestBytes;

  const commit = (markerPath, next) => {
    fs.writeFileSync(markerPath, JSON.stringify(next, null, 2));
    const manifestPath = path.join(f.agentDir, manifestName);
    const m = read(manifestPath);
    m.installedAt = m.installedAt.replace("Z", "+00:00");
    write(manifestPath, m);
    foreignManifestBytes = fs.readFileSync(manifestPath, "utf8");
  };

  assert.throws(
    () => runDeploy({ ...f, adoptAgent: true }, { commit }),
    /receipt|hash|drift|corrupt|reconcil/i,
  );

  assert.equal(fs.readFileSync(path.join(f.agentDir, manifestName), "utf8"), foreignManifestBytes);
  assert.equal(marker(f).state, "pending");
  assert.ok(fs.readdirSync(path.join(f.installDir, "journals")).length >= 1);
});

test("child setup returning status 0 without receipt fails closed", (t) => {
  const f = fixture(t);
  setupOccupiedAgent(f);

  const run = (node, args, options) => {
    if (args[0].endsWith("setup.mjs")) {
      const res = spawnSync(node, args, options);
      if (res.status !== 0) return res;
      // Strip receipt delimiters from stdout
      const strippedStdout = res.stdout
        .replace(/---PI_AUTO_COMPACTION_SETUP_RECEIPT_START---[\s\S]*?---PI_AUTO_COMPACTION_SETUP_RECEIPT_END---/, "");
      return { status: 0, stdout: strippedStdout, stderr: res.stderr };
    }
    return spawnSync(node, args, options);
  };

  assert.throws(
    () => runDeploy({ ...f, adoptAgent: true }, { run }),
    /receipt|reconcil/i,
  );
  assert.equal(marker(f).state, "pending");
});

test("child setup with duplicate receipt delimiters fails closed", (t) => {
  const f = fixture(t);
  setupOccupiedAgent(f);

  const run = (node, args, options) => {
    if (args[0].endsWith("setup.mjs")) {
      const res = spawnSync(node, args, options);
      if (res.status !== 0) return res;
      // Duplicate the receipt in stdout
      const match = res.stdout.match(/---PI_AUTO_COMPACTION_SETUP_RECEIPT_START---[\s\S]*?---PI_AUTO_COMPACTION_SETUP_RECEIPT_END---/);
      const duplicatedStdout = res.stdout + "\n" + (match ? match[0] : "");
      return { status: 0, stdout: duplicatedStdout, stderr: res.stderr };
    }
    return spawnSync(node, args, options);
  };

  assert.throws(
    () => runDeploy({ ...f, adoptAgent: true }, { run }),
    /Duplicate|receipt|reconcil/i,
  );
  assert.equal(marker(f).state, "pending");
});

test("child setup with wrong correlation nonce fails closed", (t) => {
  const f = fixture(t);
  setupOccupiedAgent(f);

  const run = (node, args, options) => {
    if (args[0].endsWith("setup.mjs")) {
      const res = spawnSync(node, args, options);
      if (res.status !== 0) return res;
      // Tamper nonce in receipt
      const tamperedStdout = res.stdout.replace(/"nonce":"[^"]+"/, '"nonce":"forged-stale-nonce"');
      return { status: 0, stdout: tamperedStdout, stderr: res.stderr };
    }
    return spawnSync(node, args, options);
  };

  assert.throws(
    () => runDeploy({ ...f, adoptAgent: true }, { run }),
    /nonce|mismatch|receipt|reconcil/i,
  );
  assert.equal(marker(f).state, "pending");
});

test("child setup with corrupt receipt schema fails closed", (t) => {
  const f = fixture(t);
  setupOccupiedAgent(f);

  const run = (node, args, options) => {
    if (args[0].endsWith("setup.mjs")) {
      const res = spawnSync(node, args, options);
      if (res.status !== 0) return res;
      // Inject corrupt field into receipt
      const tamperedStdout = res.stdout.replace(/"version":1/, '"version":1,"unauthorizedReceiptField":"evil"');
      return { status: 0, stdout: tamperedStdout, stderr: res.stderr };
    }
    return spawnSync(node, args, options);
  };

  assert.throws(
    () => runDeploy({ ...f, adoptAgent: true }, { run }),
    /schema|receipt|reconcil/i,
  );
  assert.equal(marker(f).state, "pending");
});

test("unmutated failure after actual setup completes clean compensation and restores prior agent bytes without pending journal", (t) => {
  const f = fixture(t);
  setupOccupiedAgent(f);
  const beforeBytes = agentBytes(f);

  const run = (node, args, options) => {
    if (args[0].endsWith("setup.mjs")) {
      const res = spawnSync(node, args, options);
      if (res.status !== 0) return res;
      // Real setup succeeded and files are unmutated, but simulate an after-setup failure
      return { status: 1, stdout: res.stdout, stderr: "synthetic after-setup failure with intact files" };
    }
    return spawnSync(node, args, options);
  };

  assert.throws(
    () => runDeploy({ ...f, adoptAgent: true }, { run }),
    /synthetic after-setup failure with intact files/,
  );

  // Since files were unmutated and matched trusted writer receipt, compensation succeeded cleanly!
  assert.deepEqual(agentBytes(f), beforeBytes);
  assert.equal(marker(f).current, null);
  assert.equal(marker(f).state, "ready");
});

test("fresh deployment without settings succeeds via actual CLI on entirely absent agent", (t) => {
  for (const agentPreExists of [false, true]) {
    const f = fixture(t);
    // Create agent dir without settings.json to trigger the null snapshot path
    if (agentPreExists) {
      // Agent dir exists (from fixture) but remove settings.json
      fs.rmSync(path.join(f.agentDir, "settings.json"));
    } else {
      // Entirely absent agent directory
      fs.rmSync(f.agentDir, { recursive: true, force: true });
      f.agentDir = path.join(f.base, "absent-agent");
    }
    const result = spawnSync(process.execPath, [
      path.join(project, "scripts", "deploy.mjs"),
      "--agent-dir", f.agentDir,
      "--install-dir", f.installDir,
      "--source-dir", f.sourceDir,
    ], { encoding: "utf8", timeout: 30000 });
    assert.equal(result.status, 0, `CLI must exit 0 (agentPreExists=${agentPreExists}): ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.success, true);
    assert.equal(output.dryRun, false);
    // Marker must be ready with a current release and no pending
    const m = read(path.join(f.installDir, MARKER_FILENAME));
    assert.equal(m.state, "ready");
    assert.notEqual(m.current, null);
    assert.equal(m.pending, null);
    // All 4 original overrides absent: present=false, reserve+keep present=false
    const mf = read(path.join(f.agentDir, manifestName));
    assert.equal(Object.keys(mf.originalOverrides).length, 4);
    for (const modelId of Object.keys(mf.originalOverrides)) {
      assert.equal(mf.originalOverrides[modelId].present, false);
      assert.equal(mf.originalOverrides[modelId].reserveTokens.present, false);
      assert.equal(mf.originalOverrides[modelId].keepRecentTokens.present, false);
    }
    // settings.json must exist with managed overrides created
    const settings = read(path.join(f.agentDir, "settings.json"));
    assert.ok(settings.compaction?.modelOverrides, "managed overrides must be created");
    // Loader and manifest must point to the versioned release
    assert.equal(mf.packageSourceDir, output.releaseDir);
    assert.ok(fs.existsSync(path.join(f.agentDir, "extensions", "omniroute-compaction.ts")));
    // Clean up installDir for the next iteration
    fs.rmSync(f.installDir, { recursive: true, force: true });
  }
});

test("canonical python backup snippet executes safely against controlled temporary fixture", (t) => {
  const docsPath = path.join(project, "docs", "instalacion.md");
  const docsContent = fs.readFileSync(docsPath, "utf8");
  const snippetMatch = docsContent.match(/```python\n([\s\S]*?)```/);
  assert.ok(snippetMatch, "Canonical Python backup snippet must exist in docs/instalacion.md");
  const pythonScript = snippetMatch[1];

  const tempFixture = fs.mkdtempSync(path.join(os.tmpdir(), "pi-backup-test-"));
  trackedDeployFixtures.add(tempFixture);
  if (t?.after) {
    t.after(() => {
      trackedDeployFixtures.delete(tempFixture);
      try { fs.rmSync(tempFixture, { recursive: true, force: true }); } catch {}
    });
  }

  const fakeHome = path.join(tempFixture, "home");
  const fakeAgent = path.join(fakeHome, ".pi", "agent");
  fs.mkdirSync(path.join(fakeAgent, "extensions"), { recursive: true });

  fs.writeFileSync(path.join(fakeAgent, "settings.json"), JSON.stringify({ test: "settings" }));
  fs.writeFileSync(path.join(fakeAgent, ".pi-auto-compaction-manifest.json"), JSON.stringify({ test: "manifest" }));
  fs.writeFileSync(path.join(fakeAgent, "extensions", "omniroute-compaction.ts"), "// test loader");

  // 1. Successful backup execution
  const res = spawnSync("python3", ["-c", pythonScript], {
    env: { HOME: fakeHome, AGENT_DIR: fakeAgent, PATH: process.env.PATH },
    encoding: "utf8",
  });

  assert.equal(res.status, 0, `Python backup script failed: ${res.stderr}`);
  assert.ok(res.stdout.includes("Snapshot privado completado exitosamente:"));

  const baseBackupDir = path.join(fakeHome, ".local", "state", "pi-auto-compaction-backups");
  assert.ok(fs.existsSync(baseBackupDir));
  assert.equal(fs.statSync(baseBackupDir).mode & 0o777, 0o700);

  const backupDirs = fs.readdirSync(baseBackupDir);
  assert.equal(backupDirs.length, 1);
  const backupFolder = path.join(baseBackupDir, backupDirs[0]);
  assert.equal(fs.statSync(backupFolder).mode & 0o777, 0o700);

  for (const name of ["settings.json", ".pi-auto-compaction-manifest.json", "omniroute-compaction.ts"]) {
    const backupFile = path.join(backupFolder, name);
    assert.ok(fs.existsSync(backupFile), `Backup file ${name} must exist`);
    assert.equal(fs.statSync(backupFile).mode & 0o777, 0o600);
  }

  // 2. Reject missing required file fail-closed
  const missingAgent = path.join(fakeHome, "missing-agent");
  fs.mkdirSync(missingAgent, { recursive: true });
  const resMissing = spawnSync("python3", ["-c", pythonScript], {
    env: { HOME: fakeHome, AGENT_DIR: missingAgent, PATH: process.env.PATH },
    encoding: "utf8",
  });
  assert.notEqual(resMissing.status, 0, "Must fail when required files are missing");

  // 3. Reject symlink target file fail-closed
  const symlinkAgent = path.join(fakeHome, "symlink-agent");
  fs.mkdirSync(path.join(symlinkAgent, "extensions"), { recursive: true });
  fs.writeFileSync(path.join(symlinkAgent, "settings.json"), "{}");
  fs.writeFileSync(path.join(symlinkAgent, ".pi-auto-compaction-manifest.json"), "{}");
  const targetLoader = path.join(fakeAgent, "extensions", "omniroute-compaction.ts");
  fs.symlinkSync(targetLoader, path.join(symlinkAgent, "extensions", "omniroute-compaction.ts"));

  const resSymlinkFile = spawnSync("python3", ["-c", pythonScript], {
    env: { HOME: fakeHome, AGENT_DIR: symlinkAgent, PATH: process.env.PATH },
    encoding: "utf8",
  });
  assert.notEqual(resSymlinkFile.status, 0, "Must fail when managed file is a symlink");
  assert.ok(resSymlinkFile.stderr.includes("enlace simbólico"));

  // 4. Reject symlink ancestor fail-closed
  const symlinkBase = path.join(tempFixture, "symlink-base");
  fs.symlinkSync(fakeAgent, symlinkBase);
  const resSymlinkAncestor = spawnSync("python3", ["-c", pythonScript], {
    env: { HOME: fakeHome, AGENT_DIR: symlinkBase, PATH: process.env.PATH },
    encoding: "utf8",
  });
  assert.notEqual(resSymlinkAncestor.status, 0, "Must fail when ancestor is a symlink");
  assert.ok(resSymlinkAncestor.stderr.includes("enlace simbólico"));
});




