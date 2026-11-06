import assert from "node:assert/strict";
import { describe, it } from "node:test";

const tui = await import("@earendil-works/pi-tui");

import {
  PICKER_HINTS,
  createModelPicker,
  describeModel,
  filterModels,
  maxVisibleForRows,
  modelItems,
  modelKey,
  pickModel,
} from "../../src/model-selector.mjs";

const ANSI = /\x1b\[[0-9;]*m/g;
const plain = (lines) => lines.map((line) => line.replace(ANSI, ""));

function buildModels(count = 120) {
  return Array.from({ length: count }, (_, index) => ({
    provider: `prov${index % 3}`,
    id: `model-${String(index).padStart(3, "0")}`,
    name: `Model ${index}`,
    contextWindow: 1000000,
    maxTokens: 8192,
  }));
}

function fakeTheme() {
  return { fg: (color, text) => `[${color}]${text}[/${color}]` };
}

describe("@earendil-works/pi-tui exports the picker primitives", () => {
  it("provides SelectList, Input and fuzzyFilter", () => {
    assert.equal(typeof tui.SelectList, "function");
    assert.equal(typeof tui.Input, "function");
    assert.equal(typeof tui.fuzzyFilter, "function");
    assert.equal(typeof tui.matchesKey, "function");
    assert.ok(tui.Key.enter);
  });
});

describe("filterModels", () => {
  const models = buildModels(30);

  it("returns every model for an empty or blank query", () => {
    assert.equal(filterModels(models, "").length, 30);
    assert.equal(filterModels(models, "   ").length, 30);
    assert.equal(filterModels(models).length, 30);
  });

  it("matches by provider, model id and name, case-insensitively", () => {
    assert.ok(filterModels(models, "PROV1").some((model) => model.provider === "prov1"));
    assert.deepEqual(
      filterModels(models, "model-007").map((model) => model.id),
      ["model-007"],
    );
    assert.ok(filterModels(models, "model 12").some((model) => model.id === "model-012"));
  });

  it("returns an empty list when nothing matches", () => {
    assert.deepEqual(filterModels(models, "zzz-no-such-model"), []);
  });
});

describe("modelItems", () => {
  it("builds provider/id values ordered by key with descriptive labels", () => {
    const items = modelItems([
      { provider: "b", id: "z", name: "Zeta", contextWindow: 1000, maxTokens: 10 },
      { provider: "a", id: "y", name: "Y", contextWindow: 2000000, maxTokens: 65536 },
    ]);

    assert.deepEqual(
      items.map((item) => item.value),
      ["a/y", "b/z"],
    );
    assert.equal(items[0].label, "a/y · Y · ctx 2.000.000 · max 65.536");
  });

  it("keeps provider/id for models keyed by modelId", () => {
    assert.equal(modelKey({ provider: "p", modelId: "m" }), "p/m");
    assert.equal(describeModel({ provider: "p", modelId: "m" }), "p/m · m · ctx ? · max ?");
  });
});

describe("maxVisibleForRows", () => {
  it("reserves rows for the header, input and hint", () => {
    assert.equal(maxVisibleForRows(24, 120), 14);
    assert.equal(maxVisibleForRows(40, 120), 30);
  });

  it("never exceeds the number of models and never drops below five", () => {
    assert.equal(maxVisibleForRows(40, 3), 5);
    assert.equal(maxVisibleForRows(12, 120), 5);
    assert.equal(maxVisibleForRows(undefined, 120), 14);
    assert.equal(maxVisibleForRows(24, 0), 5);
  });
});

describe("createModelPicker", () => {
  it("renders a bounded viewport for 100+ models and shows scroll progress", () => {
    const picker = createModelPicker(buildModels(120), { tui, rows: 20, done: () => {} });
    const lines = plain(picker.render(120));

    assert.ok(lines.length <= 4 + maxVisibleForRows(20, 120), `rendered ${lines.length} lines`);
    assert.ok(lines.some((line) => /\d+\/\d+/.test(line)), "expected scroll progress such as 1/120");
    assert.equal(lines.at(-1), PICKER_HINTS);
  });

  it("narrows the list while typing and reports no matches", () => {
    const picker = createModelPicker(buildModels(120), { tui, rows: 20, done: () => {} });

    for (const char of "model-119") {
      picker.handleInput(char);
    }
    const filtered = plain(picker.render(120)).slice(2, -1);
    assert.ok(filtered[0].includes("model-119"), `first row was ${filtered[0]}`);
    assert.ok(filtered.length < maxVisibleForRows(20, 120));

    picker.handleInput("z");
    picker.handleInput("z");
    const empty = plain(picker.render(120));
    assert.ok(empty.some((line) => line.includes("Sin coincidencias")));
  });

  it("preselects the current model and returns it on Enter", () => {
    let result;
    const picker = createModelPicker(buildModels(120), {
      tui,
      rows: 20,
      selected: "prov2/model-119",
      done: (value) => {
        result = value;
      },
    });

    picker.handleInput("\r");
    assert.equal(result, "prov2/model-119");
  });

  it("moves the selection with arrows and returns the new model", () => {
    let result;
    const picker = createModelPicker(buildModels(20), {
      tui,
      rows: 20,
      done: (value) => {
        result = value;
      },
    });

    picker.handleInput("\x1b[B");
    picker.handleInput("\r");
    assert.equal(result, "prov0/model-003");
  });

  it("cancels with Escape without a selection", () => {
    let result = "untouched";
    const picker = createModelPicker(buildModels(20), {
      tui,
      rows: 20,
      done: (value) => {
        result = value;
      },
    });

    picker.handleInput("\x1b");
    assert.equal(result, undefined);
  });

  it("themes the header, scroll info and hints", () => {
    const picker = createModelPicker(buildModels(120), { tui, rows: 20, theme: fakeTheme(), done: () => {} });
    const lines = picker.render(120);

    assert.ok(lines[0].startsWith("[accent]"));
    assert.ok(lines.at(-1).startsWith("[dim]"));
  });
});

describe("pickModel", () => {
  const models = buildModels(12);

  it("opens the custom picker and resolves the selected model", async () => {
    let seenRows;
    const ui = {
      custom: async (factory) => {
        let resolveResult;
        const promise = new Promise((resolve) => {
          resolveResult = resolve;
        });
        const component = factory(
          { terminal: { rows: 30 } },
          fakeTheme(),
          {},
          (value) => {
            resolveResult(value);
          },
        );
        component.handleInput("\r");
        seenRows = component.render(80).length;
        return promise;
      },
    };

    const chosen = await pickModel({ ui }, models, { selected: "prov0/model-000" });
    assert.equal(chosen.id, "model-000");
    assert.ok(seenRows > 0);
  });

  it("returns undefined when the host has no custom UI", async () => {
    assert.equal(await pickModel({ ui: {} }, models), undefined);
    assert.equal(await pickModel({}, models), undefined);
  });

  it("returns undefined on cancel", async () => {
    const ui = {
      custom: async (factory) => {
        let resolveResult;
        const promise = new Promise((resolve) => {
          resolveResult = resolve;
        });
        const component = factory({ terminal: { rows: 30 } }, fakeTheme(), {}, (value) => {
          resolveResult(value);
        });
        component.handleInput("\x1b");
        return promise;
      },
    };

    assert.equal(await pickModel({ ui }, models), undefined);
  });
});
