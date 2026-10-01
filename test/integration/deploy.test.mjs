import { test } from "node:test";
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
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deploy-test-"));
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

test("fresh copy, update, idempotency and source rollback preserve the original baseline", () => {
  const f = fixture();
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

test("dry run validates without creating any installation or agent directories", () => {
  const f = fixture();
  f.agentDir = path.join(f.base, "absent-agent");
  assert.equal(runDeploy({ ...f, dryRun: true }).dryRun, true);
  assert.equal(fs.existsSync(f.installDir), false);
  assert.equal(fs.existsSync(f.agentDir), false);
  change(f, "invalid javascript {{{\n");
  assert.throws(() => runDeploy({ ...f, dryRun: true }), /syntax|Syntax/i);
  assert.equal(fs.existsSync(f.installDir), false);
});

test("legacy flat and even empty unmanaged roots are rejected without adoption", () => {
  for (const legacy of [false, true]) {
    const f = fixture();
    fs.mkdirSync(f.installDir);
    if (legacy) fs.writeFileSync(path.join(f.installDir, "index.mjs"), "// legacy sentinel");
    const before = agentBytes(f);
    assert.throws(() => runDeploy(f), /unmanaged|ownership/i);
    assert.deepEqual(agentBytes(f), before);
    assert.deepEqual(fs.readdirSync(f.installDir), legacy ? ["index.mjs"] : []);
  }
  const f = fixture();
  assert.throws(() => runDeploy({ ...f, update: true }), /managed|update/i);
  assert.equal(fs.existsSync(f.installDir), false);
});

test("settings drift and foreign agent manifests reject updates before staging", () => {
  const f = fixture();
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

test("mutated previous release, corrupt metadata and symlink paths fail closed", () => {
  const f = fixture();
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
  const g = fixture();
  fs.symlinkSync(g.sourceDir, g.installDir, "dir");
  assert.throws(() => runDeploy(g), /symlink/i);
  assert.equal(fs.existsSync(path.join(g.sourceDir, MARKER_FILENAME)), false);
  const h = fixture();
  fs.symlinkSync(path.join(h.sourceDir, "index.mjs"), path.join(h.sourceDir, "src/unsafe.mjs"));
  assert.throws(() => runDeploy(h), /symlink/i);
  assert.equal(fs.existsSync(h.installDir), false);
});

test("literal imports outside the allowlist and unknown CLI flags are rejected", () => {
  const f = fixture();
  fs.appendFileSync(path.join(f.sourceDir, "index.mjs"), '\nimport "./outside.mjs";\n');
  assert.throws(() => runDeploy(f), /import|allowlist/i);
  assert.equal(fs.existsSync(f.installDir), false);
  assert.throws(() => parseDeployArgs(["--doctor"]), /Unknown|unknown/);
  assert.throws(() => parseDeployArgs(["--agent-dir"]), /value/i);
  assert.throws(() => parseDeployArgs(["--update", "--rollback-source"]), /exclusive|combine/i);
  assert.equal(parseDeployArgs(["--dry-run", "--agent-dir", f.agentDir]).agentDir, f.agentDir);
});

test("failed child setup keeps prior metadata and source, with a durable journal", () => {
  const f = fixture();
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

test("actual setup failure at manifest write restores prior agent bytes and marker", () => {
  const f = fixture();
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

test("managed dry run changes neither manifests nor source copies; foreign source and agent symlinks reject", () => {
  const f = fixture();
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
  const g = fixture();
  fs.symlinkSync(g.sourceDir, path.join(g.agentDir, "extensions"), "dir");
  assert.throws(() => runDeploy(g), /symlink/);
  assert.equal(fs.existsSync(g.installDir), false);
});

test("metadata publication failure compensates successful setup by reselecting prior release", () => {
  const f = fixture();
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

test("fresh metadata failure removes only its own setup and preserves baseline values", () => {
  const f = fixture();
  const baseline = read(path.join(f.agentDir, "settings.json"));
  const commit = () => { throw new Error("fixture fresh commit failure"); };
  assert.throws(() => runDeploy(f, { commit }), /fixture fresh commit failure/);
  assert.deepEqual(read(path.join(f.agentDir, "settings.json")), baseline);
  assert.equal(fs.existsSync(path.join(f.agentDir, manifestName)), false);
  assert.equal(marker(f).current, null);
  assert.ok(runDeploy(f).success);
});

test("failed compensation leaves pending marker and blocks all later calls including dry run", () => {
  const f = fixture();
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
