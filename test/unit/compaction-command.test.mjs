import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  MODEL_STATUS_KEY,
  describeModel,
  listChatModels,
  publishModelStatus,
  registerCompactionCommand,
  statusText,
} from "../../src/compaction-command.mjs";
import { createRuntimeConfig } from "../../src/runtime-config.mjs";

const tui = await import("@earendil-works/pi-tui");

const PRIMARY = {
  provider: "antigravity",
  id: "gemini-3.8-flash-tiered",
  name: "Gemini 3.8 Flash",
  contextWindow: 1048576,
  maxTokens: 65536,
  reasoning: true,
};
const FALLBACK = {
  provider: "antigravity",
  id: "gemini-3.6-flash-high",
  name: "Gemini 3.6 Flash",
  contextWindow: 1048576,
  maxTokens: 65536,
};
const TINY = {
  provider: "local",
  id: "qwen-small",
  name: "Qwen Small",
  contextWindow: 16384,
  maxTokens: 4096,
};

function fakeRegistry(models, { available = true } = {}) {
  return {
    getAvailableOfType: async () => (available ? models : []),
    getModelsOfType: () => models,
    hasConfiguredAuth: (model) => model !== TINY,
  };
}

function collectStatus() {
  const calls = [];
  return { calls, setStatus: (key, text) => calls.push([key, text]) };
}

function fakePi() {
  const commands = [];
  return {
    commands,
    registerCommand: (name, definition) => commands.push({ name, definition }),
    on: () => {},
  };
}

function fakeUi(answers) {
  const notifications = [];
  let index = 0;
  return {
    notifications,
    setStatus: () => {},
    notify: (message, type) => notifications.push({ message, type }),
    select: async () => answers[index++],
    confirm: async () => answers[index++],
  };
}

describe("compaction command helpers", () => {
  it("labels models with provider/id, name, context and max tokens", () => {
    assert.equal(
      describeModel(PRIMARY),
      "antigravity/gemini-3.8-flash-tiered · Gemini 3.8 Flash · ctx 1.048.576 · max 65.536",
    );
  });

  it("builds a short status text and ignores incomplete configs", () => {
    assert.equal(
      statusText({ primaryModel: { provider: "antigravity", modelId: "gemini-3.8-flash-tiered" } }),
      "Compaction: antigravity/gemini-3.8-flash-tiered",
    );
    assert.equal(statusText({ primaryModel: { provider: "" } }), undefined);
    assert.equal(statusText(undefined), undefined);
  });

  it("publishes the status under its own key and never throws", () => {
    const ui = collectStatus();
    publishModelStatus(ui, { primaryModel: { provider: "p", modelId: "m" } });
    assert.deepEqual(ui.calls, [[MODEL_STATUS_KEY, "Compaction: p/m"]]);

    publishModelStatus(
      {
        setStatus: () => {
          throw new Error("no footer");
        },
      },
      { primaryModel: { provider: "p", modelId: "m" } },
    );
  });

  it("lists chat models sorted by provider/id", async () => {
    const models = await listChatModels(fakeRegistry([PRIMARY, FALLBACK]));
    assert.deepEqual(
      models.map((model) => `${model.provider}/${model.id}`),
      ["antigravity/gemini-3.6-flash-high", "antigravity/gemini-3.8-flash-tiered"],
    );
  });

  it("falls back to authorized models when the available list is empty", async () => {
    const models = await listChatModels(fakeRegistry([PRIMARY, FALLBACK, TINY], { available: false }));
    assert.deepEqual(
      models.map((model) => model.id),
      ["gemini-3.6-flash-high", "gemini-3.8-flash-tiered"],
    );
  });

  it("returns an empty list for a missing or broken registry", async () => {
    assert.deepEqual(await listChatModels(undefined), []);
    assert.deepEqual(
      await listChatModels({
        getAvailableOfType: () => {
          throw new Error("boom");
        },
        getModelsOfType: () => {
          throw new Error("boom");
        },
      }),
      [],
    );
  });
});

describe("registerCompactionCommand", () => {
  let dir;
  let settingsPath;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pac-command-"));
    settingsPath = path.join(dir, ".pi-auto-compaction-settings.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("registers the command with its description", () => {
    const pi = fakePi();
    registerCompactionCommand(pi, createRuntimeConfig({ settingsPath, env: {} }));

    assert.equal(pi.commands.length, 1);
    assert.equal(pi.commands[0].name, "compaction");
    assert.equal(
      pi.commands[0].definition.description,
      "Configurar el modelo primario y de respaldo de la autocompactación",
    );
    assert.equal(typeof pi.commands[0].definition.handler, "function");
  });

  it("saves both models and updates the live config and status", async () => {
    const pi = fakePi();
    const runtime = createRuntimeConfig({ settingsPath, env: {} });
    registerCompactionCommand(pi, runtime);
    const handler = pi.commands[0].definition.handler;

    const ui = fakeUi([
      "  antigravity/gemini-3.8-flash-tiered · Gemini 3.8 Flash · ctx 1.048.576 · max 65.536",
      "  antigravity/gemini-3.6-flash-high · Gemini 3.6 Flash · ctx 1.048.576 · max 65.536",
      true,
    ]);
    const statuses = [];
    ui.setStatus = (key, text) => statuses.push([key, text]);

    await handler("", { hasUI: true, mode: "interactive", ui, modelRegistry: fakeRegistry([PRIMARY, FALLBACK]) });

    const saved = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert.deepEqual(saved, {
      version: 1,
      primary: { provider: "antigravity", modelId: "gemini-3.8-flash-tiered" },
      fallback: { provider: "antigravity", modelId: "gemini-3.6-flash-high" },
    });
    assert.equal(runtime.get().primaryModel.modelId, "gemini-3.8-flash-tiered");
    assert.deepEqual(statuses, [[MODEL_STATUS_KEY, "Compaction: antigravity/gemini-3.8-flash-tiered"]]);
    assert.match(ui.notifications.at(-1).message, /Se aplica en la próxima compactación/);
  });

  it("does not save when the user cancels the primary selection", async () => {
    const pi = fakePi();
    const runtime = createRuntimeConfig({ settingsPath, env: {} });
    registerCompactionCommand(pi, runtime);
    const before = runtime.get();

    const ui = fakeUi([undefined]);
    await pi.commands[0].definition.handler("", {
      hasUI: true,
      mode: "interactive",
      ui,
      modelRegistry: fakeRegistry([PRIMARY, FALLBACK]),
    });

    assert.equal(fs.existsSync(settingsPath), false);
    assert.equal(runtime.get(), before);
    assert.match(ui.notifications[0].message, /cancelada/);
  });

  it("does not save when the confirmation is declined", async () => {
    const pi = fakePi();
    const runtime = createRuntimeConfig({ settingsPath, env: {} });
    registerCompactionCommand(pi, runtime);

    const ui = fakeUi([
      "  antigravity/gemini-3.8-flash-tiered · Gemini 3.8 Flash · ctx 1.048.576 · max 65.536",
      "  antigravity/gemini-3.6-flash-high · Gemini 3.6 Flash · ctx 1.048.576 · max 65.536",
      false,
    ]);
    await pi.commands[0].definition.handler("", {
      hasUI: true,
      mode: "interactive",
      ui,
      modelRegistry: fakeRegistry([PRIMARY, FALLBACK]),
    });

    assert.equal(fs.existsSync(settingsPath), false);
  });

  it("refuses to save the same model twice", async () => {
    const pi = fakePi();
    const runtime = createRuntimeConfig({ settingsPath, env: {} });
    registerCompactionCommand(pi, runtime);

    const label = "  antigravity/gemini-3.8-flash-tiered · Gemini 3.8 Flash · ctx 1.048.576 · max 65.536";
    const ui = fakeUi([label, label]);
    await pi.commands[0].definition.handler("", {
      hasUI: true,
      mode: "interactive",
      ui,
      modelRegistry: fakeRegistry([PRIMARY, FALLBACK]),
    });

    assert.equal(fs.existsSync(settingsPath), false);
    assert.match(ui.notifications[0].message, /distinto del primario/);
  });

  it("warns about a small context window but still saves", async () => {
    const pi = fakePi();
    const runtime = createRuntimeConfig({ settingsPath, env: {} });
    registerCompactionCommand(pi, runtime);

    const ui = fakeUi([
      "  local/qwen-small · Qwen Small · ctx 16.384 · max 4.096",
      "  antigravity/gemini-3.6-flash-high · Gemini 3.6 Flash · ctx 1.048.576 · max 65.536",
      true,
    ]);
    await pi.commands[0].definition.handler("", {
      hasUI: true,
      mode: "interactive",
      ui,
      modelRegistry: fakeRegistry([PRIMARY, FALLBACK, TINY]),
    });

    assert.ok(ui.notifications.some((entry) => /contexto chica/.test(entry.message)));
    assert.equal(fs.existsSync(settingsPath), true);
  });

  it("reports the absence of chat models and writes nothing", async () => {
    const pi = fakePi();
    const runtime = createRuntimeConfig({ settingsPath, env: {} });
    registerCompactionCommand(pi, runtime);

    const ui = fakeUi([]);
    await pi.commands[0].definition.handler("", {
      hasUI: true,
      mode: "interactive",
      ui,
      modelRegistry: fakeRegistry([]),
    });

    assert.match(ui.notifications[0].message, /No hay modelos de chat disponibles/);
    assert.equal(ui.notifications[0].type, "error");
    assert.equal(fs.existsSync(settingsPath), false);
  });

  it("refuses to run without an interactive UI", async () => {
    const pi = fakePi();
    const runtime = createRuntimeConfig({ settingsPath, env: {} });
    registerCompactionCommand(pi, runtime);

    const ui = fakeUi([]);
    await pi.commands[0].definition.handler("", { hasUI: false, mode: "print", ui });
    await pi.commands[0].definition.handler("", { hasUI: true, mode: "print", ui });

    assert.equal(ui.notifications.length, 2);
    for (const entry of ui.notifications) {
      assert.match(entry.message, /requiere una interfaz interactiva/);
    }
    assert.equal(fs.existsSync(settingsPath), false);
  });

  it("keeps the previous config and reports the error when the write fails", async () => {
    const pi = fakePi();
    const runtime = createRuntimeConfig({ settingsPath, env: {} });
    const before = runtime.get();
    registerCompactionCommand(pi, {
      get: () => before,
      saveSummarizerSettings: () => {
        throw new Error("permiso denegado");
      },
    });

    const ui = fakeUi([
      "  antigravity/gemini-3.8-flash-tiered · Gemini 3.8 Flash · ctx 1.048.576 · max 65.536",
      "  antigravity/gemini-3.6-flash-high · Gemini 3.6 Flash · ctx 1.048.576 · max 65.536",
      true,
    ]);
    await pi.commands[0].definition.handler("", {
      hasUI: true,
      mode: "interactive",
      ui,
      modelRegistry: fakeRegistry([PRIMARY, FALLBACK]),
    });

    assert.match(ui.notifications[0].message, /No se pudo guardar.*permiso denegado/);
    assert.equal(fs.existsSync(settingsPath), false);
  });
  it("uses the custom scrollable picker in TUI mode", async () => {
    const pi = fakePi();
    const runtime = createRuntimeConfig({ settingsPath, env: {} });
    registerCompactionCommand(pi, runtime);

    const titles = [];
    const rowsSeen = [];
    const ui = {
      notifications: [],
      notify(message, type) {
        this.notifications.push({ message, type });
      },
      setStatus() {},
      confirm: async () => true,
      select: async () => {
        throw new Error("ui.select must not be used in TUI mode");
      },
      custom: async (factory) => {
        let resolveResult;
        const promise = new Promise((resolve) => {
          resolveResult = resolve;
        });
        const component = factory({ terminal: { rows: 24 } }, { fg: (color, text) => text }, {}, (value) => {
          resolveResult(value);
        });
        rowsSeen.push(component.render(100).length);
        const isPrimary = titles.length === 0;
        titles.push("picker");
        if (isPrimary) {
          component.handleInput("model-119");
          component.handleInput("\r");
        } else {
          component.handleInput("\x1b");
        }
        return promise;
      },
    };

    const models = Array.from({ length: 120 }, (_, index) => ({
      provider: `prov${index % 3}`,
      id: `model-${String(index).padStart(3, "0")}`,
      name: `Model ${index}`,
      contextWindow: 1000000,
      maxTokens: 8192,
    }));

    await pi.commands[0].definition.handler("", {
      hasUI: true,
      mode: "interactive",
      ui,
      modelRegistry: fakeRegistry(models),
    });

    assert.equal(ui.notifications[0].message, "Configuración cancelada: no se modificó el resumidor.");
    assert.equal(rowsSeen.length, 2);
    assert.ok(rowsSeen.every((rows) => rows <= 18));
  });

  it("saves through the custom picker when both selections are confirmed", async () => {
    const pi = fakePi();
    const runtime = createRuntimeConfig({ settingsPath, env: {} });
    registerCompactionCommand(pi, runtime);

    const selections = ["prov1/model-119", "prov2/model-118"];
    let call = 0;
    const ui = {
      notifications: [],
      notify(message, type) {
        this.notifications.push({ message, type });
      },
      setStatus() {},
      confirm: async () => true,
      custom: async (factory) => {
        let resolveResult;
        const promise = new Promise((resolve) => {
          resolveResult = resolve;
        });
        const component = factory({ terminal: { rows: 40 } }, { fg: (color, text) => text }, {}, (value) => {
          resolveResult(value);
        });
        const wanted = selections[call++];
        component.handleInput(wanted.slice(wanted.indexOf("/") + 1));
        component.handleInput("\r");
        return promise;
      },
    };

    const models = Array.from({ length: 120 }, (_, index) => ({
      provider: `prov${index % 3}`,
      id: `model-${String(index).padStart(3, "0")}`,
      name: `Model ${index}`,
      contextWindow: 1000000,
      maxTokens: 8192,
    }));

    await pi.commands[0].definition.handler("", {
      hasUI: true,
      mode: "interactive",
      ui,
      modelRegistry: fakeRegistry(models),
    });

    const saved = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert.equal(saved.primary.modelId, "model-119");
    assert.equal(saved.fallback.modelId, "model-118");
    assert.match(ui.notifications.at(-1).message, /Se aplica en la próxima compactación/);
  });
});
