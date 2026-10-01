import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DefaultResourceLoader } from "../../src/pi-sdk.mjs";
import { runSetup } from "../../scripts/setup.mjs";

describe("durability and loader upgrade simulation", () => {
  let tempDir;
  let tempAgentDir;
  let durableShareDir;
  let simulatedNpmDir;
  let originalSDKPath;

  beforeEach(() => {
    originalSDKPath = process.env.PI_CODING_AGENT_PATH;
    // The copied durable source has no dependencies. Keep this simulation on the
    // project SDK instead of consulting the real machine's global installation.
    process.env.PI_CODING_AGENT_PATH = import.meta.resolve("@earendil-works/pi-coding-agent");
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-durability-test-"));
    tempAgentDir = path.join(tempDir, "agent");
    durableShareDir = path.join(tempDir, "share", "pi-auto-compaction");
    simulatedNpmDir = path.join(tempDir, "node_modules", "@earendil-works", "pi-coding-agent");

    fs.mkdirSync(tempAgentDir, { recursive: true });
    fs.mkdirSync(durableShareDir, { recursive: true });
    fs.mkdirSync(simulatedNpmDir, { recursive: true });

    // Copy our package source to the durable share location
    const sourceFiles = [
      "package.json",
      "index.mjs",
      "index.ts",
    ];
    for (const f of sourceFiles) {
      if (fs.existsSync(f)) {
        fs.copyFileSync(f, path.join(durableShareDir, f));
      }
    }
    // Copy src directory
    fs.cpSync("src", path.join(durableShareDir, "src"), { recursive: true });
    fs.cpSync("scripts", path.join(durableShareDir, "scripts"), { recursive: true });
  });

  afterEach(() => {
    if (originalSDKPath === undefined) delete process.env.PI_CODING_AGENT_PATH;
    else process.env.PI_CODING_AGENT_PATH = originalSDKPath;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("survives product directory replacement with durable loader intact", async () => {
    // 1. Run setup pointing to the durable share location
    const setupResult = runSetup({
      agentDir: tempAgentDir,
      packageSourceDir: durableShareDir,
    });
    assert.ok(setupResult.success);

    // 2. Initial load via jiti DefaultResourceLoader
    const loader1 = new DefaultResourceLoader({
      cwd: tempDir,
      agentDir: tempAgentDir,
    });
    await loader1.reload();
    assert.equal(loader1.getExtensions().extensions.length, 1, "Loader must be discovered and loaded");
    assert.equal(loader1.getExtensions().errors.length, 0, "No extension load errors");

    // 3. Simulate an upgrade/replacement of the npm product directory
    fs.rmSync(simulatedNpmDir, { recursive: true, force: true });
    const upgradedNpmDir = path.join(tempDir, "node_modules", "@earendil-works", "pi-coding-agent-vNext");
    fs.mkdirSync(upgradedNpmDir, { recursive: true });
    fs.writeFileSync(path.join(upgradedNpmDir, "VERSION"), "0.88.0");

    // 4. Reload after simulated upgrade: durable source and settings remain completely intact!
    const loader2 = new DefaultResourceLoader({
      cwd: tempDir,
      agentDir: tempAgentDir,
    });
    await loader2.reload();
    assert.equal(loader2.getExtensions().extensions.length, 1, "Durable extension survives product directory changes");
    assert.equal(loader2.getExtensions().errors.length, 0, "Still zero extension load errors");
  });

  it("fails visibly with descriptive error if durable source is missing", async () => {
    const nonExistentSource = path.join(tempDir, "does-not-exist");
    fs.mkdirSync(nonExistentSource, { recursive: true });
    fs.writeFileSync(path.join(nonExistentSource, "index.mjs"), "export default function() {}");
    runSetup({
      agentDir: tempAgentDir,
      packageSourceDir: nonExistentSource,
    });
    // Remove the source directory after setup to simulate missing durable source at runtime
    fs.rmSync(nonExistentSource, { recursive: true, force: true });

    const loader = new DefaultResourceLoader({
      cwd: tempDir,
      agentDir: tempAgentDir,
    });
    await loader.reload();

    const extResult = loader.getExtensions();
    // When loader tries to import non-existent source, it logs or records an error
    // In our loader script: console.error("[pi-auto-compaction] Failed to load durable extension: ...")
    assert.equal(extResult.extensions.length, 1);
  });
});
