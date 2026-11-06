import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { loadPiTUI, packageEntry } from "../../src/pi-sdk.mjs";

describe("loadPiTUI", () => {
  it("exposes the TUI primitives the picker needs", async () => {
    const tui = await loadPiTUI();
    for (const name of ["SelectList", "Input", "fuzzyFilter", "matchesKey"]) {
      assert.equal(typeof tui[name], "function", `${name} must be exported`);
    }
    assert.ok(tui.Key.enter);
  });
});

describe("packageEntry", () => {
  let root;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pac-package-entry-"));
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function fixture(name, metadata) {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(dir, "dist", "index.js"), "export const marker = 'ok';\n");
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, ...metadata }));
    return dir;
  }

  it("resolves packages that only declare main", async () => {
    const dir = fixture("main-only", { main: "dist/index.js" });
    const loaded = await packageEntry(dir);
    assert.equal(loaded.marker, "ok");
  });

  it("resolves packages that declare an exports map", async () => {
    const dir = fixture("with-exports", { exports: { ".": "./dist/index.js" } });
    const loaded = await packageEntry(dir);
    assert.equal(loaded.marker, "ok");
  });

  it("refuses a package with neither exports nor main", () => {
    const dir = fixture("no-entry", {});
    assert.throws(() => packageEntry(dir), /No entry point/);
  });
});
