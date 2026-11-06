import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const sdkFile = new URL("../../src/pi-sdk.mjs", import.meta.url);

test("explicit SDK override fails closed instead of using another machine's installation", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(sdkFile.href)})`], {
    env: { ...process.env, PI_CODING_AGENT_PATH: path.join(os.tmpdir(), "missing-pi-sdk", "index.js") },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PI_CODING_AGENT_PATH/);
});

test("portable SDK exposes matching official AI modules without personal imports", async () => {
  const sdk = await import(sdkFile);
  assert.equal(typeof sdk.loadPiSDK, "function");
  assert.equal(await sdk.loadPiSDK(), await import("@earendil-works/pi-coding-agent"));
  assert.equal(typeof sdk.loadPiAI, "function");
  const ai = await sdk.loadPiAI();
  assert.equal(ai, await import("@earendil-works/pi-ai"));
  const compat = await sdk.loadPiAI("compat");
  assert.equal(typeof ai.AssistantMessageEventStream, "function");
  assert.equal(typeof compat.streamSimple, "function");
  for (const file of ["durability.test.mjs", "pi-sdk-runtime.test.mjs"]) {
    const text = fs.readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(text, /\/home\/[^/]+\/|\.local\/lib\/node_modules/);
  }
  await assert.rejects(sdk.loadPiAI("../compat"), /Invalid Pi AI export subpath/);
  await assert.rejects(sdk.loadPiAI("unexported"), /No import export/);
});

test("local development SDK wins even when no home installation is available", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import os from 'node:os';
    os.homedir = () => { throw new Error('Home fallback must not be consulted'); };
    delete process.env.PI_CODING_AGENT_PATH;
    const sdk = await import(${JSON.stringify(sdkFile.href)});
    const local = await import('@earendil-works/pi-coding-agent');
    if (await sdk.loadPiSDK() !== local) throw new Error('Not the local SDK');
  `], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

const trackedPortabilityRoots = new Set();

afterEach(() => {
  for (const root of trackedPortabilityRoots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    trackedPortabilityRoots.delete(root);
  }
});

function syntheticInstallation(t) {
  // All generated package fixtures stay inside the ignored project dependencies.
  const root = fs.mkdtempSync(new URL("../../node_modules/.pi-portability-", import.meta.url));
  trackedPortabilityRoots.add(root);
  if (t?.after) {
    t.after(() => {
      trackedPortabilityRoots.delete(root);
      try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    });
  }
  const globalRoot = path.join(root, ".local", "lib", "node_modules");
  const sdkRoot = path.join(globalRoot, "@earendil-works", "pi-coding-agent");
  const aiRoot = path.join(sdkRoot, "node_modules", "@earendil-works", "pi-ai");
  fs.mkdirSync(aiRoot, { recursive: true });
  fs.writeFileSync(path.join(sdkRoot, "package.json"), JSON.stringify({
    name: "@earendil-works/pi-coding-agent", type: "module",
    exports: { ".": { import: "./public-entry.mjs" } },
  }));
  fs.writeFileSync(path.join(sdkRoot, "public-entry.mjs"), "export function createAgentSession() {}\nexport const synthetic = true;\n");
  fs.writeFileSync(path.join(aiRoot, "package.json"), JSON.stringify({
    name: "@earendil-works/pi-ai", type: "module",
    exports: {
      ".": { import: "./public-ai.mjs" },
      "./compat": { import: "./public-compat.mjs" },
    },
  }));
  fs.writeFileSync(path.join(aiRoot, "public-ai.mjs"), "export const synthetic = 'ai';\n");
  fs.writeFileSync(path.join(aiRoot, "public-compat.mjs"), "export const synthetic = 'compat';\n");
  return { root, sdkRoot };
}

function checkSyntheticSelection(prefix, options = {}) {
  return spawnSync(process.execPath, [...(options.flags ?? []), "--input-type=module", "-e", `
    ${prefix}
    const sdk = await import(${JSON.stringify(sdkFile.href)});
    if (!(await sdk.loadPiSDK()).synthetic) throw new Error('Wrong SDK');
    if ((await sdk.loadPiAI()).synthetic !== 'ai') throw new Error('Wrong AI root');
    if ((await sdk.loadPiAI('compat')).synthetic !== 'compat') throw new Error('Wrong compat export');
  `], { env: options.env ?? process.env, encoding: "utf8" });
}

test("explicit SDK directory and file URL select its AI dependency through package exports", (t) => {
  const { sdkRoot } = syntheticInstallation(t);
  for (const override of [sdkRoot, pathToFileURL(path.join(sdkRoot, "public-entry.mjs")).href]) {
    const result = checkSyntheticSelection("", {
      env: { ...process.env, PI_CODING_AGENT_PATH: override },
    });
    assert.equal(result.status, 0, result.stderr);
  }
});

test("standard home fallback works without local SDK resolution or assumed dist exports", (t) => {
  const { root } = syntheticInstallation(t);
  const loader = path.join(root, "missing-local-sdk.mjs");
  fs.writeFileSync(loader, `
    export async function resolve(specifier, context, nextResolve) {
      if (specifier === '@earendil-works/pi-coding-agent') {
        const error = new Error('Synthetic absent project dependency');
        error.code = 'ERR_MODULE_NOT_FOUND';
        throw error;
      }
      return nextResolve(specifier, context);
    }
  `);
  const result = checkSyntheticSelection(`
    import os from 'node:os';
    os.homedir = () => ${JSON.stringify(root)};
    delete process.env.PI_CODING_AGENT_PATH;
  `, { flags: ["--experimental-loader", pathToFileURL(loader).href] });
  assert.equal(result.status, 0, result.stderr);
});

test("fixture teardown removes exact created portability directory", () => {
  let createdRoot;
  const cleanupHooks = [];
  const fakeContext = {
    after(fn) { cleanupHooks.push(fn); },
  };
  const { root } = syntheticInstallation(fakeContext);
  createdRoot = root;
  assert.ok(fs.existsSync(createdRoot), "fixture directory must exist before teardown");
  for (const hook of cleanupHooks) hook();
  assert.equal(fs.existsSync(createdRoot), false, "fixture directory must be removed by teardown");
});
