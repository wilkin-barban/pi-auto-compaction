/**
 * Scrollable, searchable model selector for `/compaction`.
 *
 * `ctx.ui.select` in Pi 1.5.0 renders every option as a plain row with no
 * viewport, so long model lists cannot be reached visually. This module builds
 * a `SelectList` based picker with a real viewport, a search input and a
 * `ui.select` fallback for hosts without `ui.custom`.
 */
import { loadPiTUI } from "./pi-sdk.mjs";

export function formatTokenCount(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return "?";
  }
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

export function modelRef(model) {
  return { provider: model.provider, modelId: model.id ?? model.modelId };
}

export function modelKey(model) {
  const { provider, modelId } = modelRef(model);
  return `${provider}/${modelId}`;
}

export function describeModel(model) {
  const { provider, modelId } = modelRef(model);
  const name = typeof model.name === "string" && model.name.trim() ? model.name.trim() : modelId;
  return `${provider}/${modelId} · ${name} · ctx ${formatTokenCount(model.contextWindow)} · max ${formatTokenCount(model.maxTokens)}`;
}

export function modelItems(models = [], { sort = true } = {}) {
  const valid = models.filter((model) => model && typeof model.provider === "string").slice();
  if (sort) {
    valid.sort((a, b) => modelKey(a).localeCompare(modelKey(b)));
  }
  return valid.map((model) => ({ value: modelKey(model), label: describeModel(model) }));
}

function searchText(model) {
  const { provider, modelId } = modelRef(model);
  const name = typeof model.name === "string" ? model.name : "";
  return `${provider} ${modelId} ${name}`;
}

export function filterModels(models = [], query = "") {
  const trimmed = typeof query === "string" ? query.trim() : "";
  if (!trimmed) {
    return models.slice();
  }
  // Deterministic equivalent of a fuzzy filter: every whitespace- or
  // slash-separated token must appear in provider, model id or name.
  const lower = trimmed.toLowerCase();
  const tokens = lower.split(/[\s/]+/).filter(Boolean);
  const rank = (model) => {
    const key = modelKey(model).toLowerCase();
    if (key === lower) return 0;
    if (key.includes(lower)) return 1;
    const name = typeof model.name === "string" ? model.name.toLowerCase() : "";
    return name.includes(lower) ? 2 : 3;
  };

  return models
    .filter((model) => tokens.every((token) => searchText(model).toLowerCase().includes(token)))
    .sort((a, b) => rank(a) - rank(b));
}

export function maxVisibleForRows(rows, count) {
  const total = Number.isInteger(count) && count > 0 ? count : 0;
  const terminalRows = Number.isInteger(rows) && rows > 0 ? rows : 24;
  return Math.max(5, Math.min(total, terminalRows - 10));
}

export const PICKER_HINTS = "↑↓ navegar · PgUp/PgDn · Enter elegir · Esc cancelar · escribir para buscar";

function selectListTheme(theme) {
  const style = (color, fallback) => (text) =>
    theme && typeof theme.fg === "function" ? theme.fg(color, text) : fallback(text);

  return {
    selectedPrefix: (text) => style("accent", (value) => value)(text),
    selectedText: (text) => style("accent", (value) => value)(text),
    description: (text) => style("muted", (value) => value)(text),
    scrollInfo: (text) => style("dim", (value) => value)(text),
    noMatch: (text) => style("dim", (value) => value)(text),
  };
}

/**
 * Builds the picker component. Exposed separately from `pickModel` so tests can
 * render it with a fake TUI and theme without a terminal.
 */
export function createModelPicker(models, options = {}) {
  const {
    title = "Modelo",
    selected = null,
    rows = 24,
    theme = null,
    done = () => {},
    initialQuery = "",
    tui = null,
  } = options;

  const { Input, Key, SelectList, matchesKey } = tui ?? {};

  let query = initialQuery;
  const search = new Input({ placeholder: "Buscar por provider, id o nombre…" });
  if (initialQuery) {
    search.setValue(initialQuery);
  }

  const toItems = (list, sort) => modelItems(list, { sort });
  let listItems = toItems(filterModels(models, query), !query);
  let list = new SelectList(listItems, maxVisibleForRows(rows, listItems.length), selectListTheme(theme));

  const preselect = (target) => {
    if (!target) return;
    const index = listItems.findIndex((item) => item.value === target);
    if (index >= 0) {
      list.setSelectedIndex(index);
    }
  };
  preselect(selected);

  let finished = false;
  const finish = () => {
    if (finished) return;
    const item = list.getSelectedItem();
    if (!item) return;
    finished = true;
    done(item.value);
  };

  const rebuild = () => {
    listItems = toItems(filterModels(models, query), !query);
    list = new SelectList(listItems, maxVisibleForRows(rows, listItems.length), selectListTheme(theme));
    list.onSelect = () => finish();
    preselect(selected);
    if (listItems.length > 0) {
      list.setSelectedIndex(0);
    }
  };

  function render(width) {
    const lines = [];
    const titleStyle = theme && typeof theme.fg === "function" ? (text) => theme.fg("accent", text) : (text) => text;
    lines.push(titleStyle(title));
    lines.push(...search.render(width));
    if (listItems.length === 0) {
      lines.push("  Sin coincidencias");
    } else {
      lines.push(...list.render(width));
    }
    const hintStyle = theme && typeof theme.fg === "function" ? (text) => theme.fg("dim", text) : (text) => text;
    lines.push(hintStyle(PICKER_HINTS));
    return lines;
  }

  const component = {
    focused: true,
    render,
    invalidate() {
      list.invalidate();
    },
    handleInput(data) {
      if (matchesKey(data, Key.escape)) {
        finished = true;
        done(undefined);
        return;
      }
      if (matchesKey(data, Key.enter)) {
        finish();
        return;
      }
      if (
        matchesKey(data, Key.up) ||
        matchesKey(data, Key.down) ||
        matchesKey(data, Key.pageUp) ||
        matchesKey(data, Key.pageDown) ||
        matchesKey(data, Key.home) ||
        matchesKey(data, Key.end) ||
        data === "j" ||
        data === "k"
      ) {
        list.handleInput(data);
        return;
      }

      const before = query;
      search.handleInput(data);
      query = search.getValue();
      if (query !== before) {
        rebuild();
      }
    },
    handleMouse(event) {
      return list.handleMouse(event);
    },
  };

  return component;
}

/**
 * Opens the picker through `ctx.ui.custom` and resolves the chosen model, or
 * `undefined` when the user cancels.
 */
export async function pickModel(ctx, models, options = {}) {
  const ui = ctx?.ui;
  if (!ui || typeof ui.custom !== "function") {
    return undefined;
  }

  let primitives;
  try {
    primitives = await loadPiTUI();
  } catch {
    // Without the TUI primitives the caller keeps its plain select fallback.
    return undefined;
  }

  const chosen = await ui.custom((tui, theme, _keybindings, done) =>
    createModelPicker(models, {
      ...options,
      tui: primitives,
      rows: tui?.terminal?.rows ?? 24,
      theme,
      done,
    }),
  );

  if (!chosen) {
    return undefined;
  }
  return models.find((model) => modelKey(model) === chosen);
}
