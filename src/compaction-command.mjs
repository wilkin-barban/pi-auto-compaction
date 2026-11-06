/**
 * `/compaction` command: pick the summarizer models from the models the
 * harness already exposes, persist them, and publish the active one in the
 * footer status. It never changes the conversation model.
 */

export const MODEL_STATUS_KEY = "pi-auto-compaction-model";

const SMALL_CONTEXT_WINDOW = 32000;

import { describeModel, formatTokenCount, modelKey, modelRef, pickModel } from "./model-selector.mjs";

export { describeModel, formatTokenCount, modelKey, modelRef };

/**
 * Lists the chat models the user can actually run: those with configured
 * credentials. Never a hard-coded list.
 */
export async function listChatModels(registry) {
  if (!registry || typeof registry !== "object") {
    return [];
  }

  let models = [];
  try {
    if (typeof registry.getAvailableOfType === "function") {
      models = await registry.getAvailableOfType("chat");
    }
  } catch {
    models = [];
  }

  if (!Array.isArray(models) || models.length === 0) {
    try {
      const all = typeof registry.getModelsOfType === "function" ? registry.getModelsOfType("chat") : [];
      models = (Array.isArray(all) ? all : []).filter((model) =>
        typeof registry.hasConfiguredAuth === "function" ? registry.hasConfiguredAuth(model) : true,
      );
    } catch {
      models = [];
    }
  }

  return models
    .filter((model) => model && typeof model.provider === "string" && typeof (model.id ?? model.modelId) === "string")
    .slice()
    .sort((a, b) => modelKey(a).localeCompare(modelKey(b)));
}

export function statusText(config) {
  const model = config?.primaryModel;
  if (!model || !model.provider || !model.modelId) {
    return undefined;
  }
  return `Compaction: ${model.provider}/${model.modelId}`;
}

export function publishModelStatus(ui, config) {
  if (!ui || typeof ui.setStatus !== "function") {
    return;
  }
  try {
    ui.setStatus(MODEL_STATUS_KEY, statusText(config));
  } catch {
    // Status is cosmetic: never break compaction because the footer rejected it.
  }
}

function optionLabel(model, selected) {
  const marker = selected && modelKey(model) === selected ? "✓ " : "  ";
  return `${marker}${describeModel(model)}`;
}

/**
 * Selects one model. In TUI mode this opens the scrollable, searchable picker
 * built on `SelectList`; hosts without `ui.custom` fall back to the plain
 * `ui.select` dialog, which has no scroll.
 */
async function selectModel(ctx, models, { title, selected }) {
  const ui = ctx?.ui;
  const interactiveTui = (ctx?.mode === "tui" || ctx?.mode === "interactive") && typeof ui?.custom === "function";

  if (interactiveTui) {
    return pickModel(ctx, models, { title, selected });
  }

  if (!ui || typeof ui.select !== "function") {
    return undefined;
  }

  const labels = models.map((model) => optionLabel(model, selected));
  const choice = await ui.select(title, labels);
  if (choice === undefined || choice === null) {
    return undefined;
  }
  const index = labels.indexOf(choice);
  return index >= 0 ? models[index] : undefined;
}

export function registerCompactionCommand(pi, runtime) {
  if (!pi || typeof pi.registerCommand !== "function") {
    return;
  }

  pi.registerCommand("compaction", {
    description: "Configurar el modelo primario y de respaldo de la autocompactación",
    handler: async (_args, ctx) => runCompactionCommand(runtime, ctx),
  });
}

async function runCompactionCommand(runtime, ctx) {
  const ui = ctx?.ui;

  if (!ctx?.hasUI || ctx.mode === "print" || !ui) {
    ui?.notify?.(
      "/compaction requiere una interfaz interactiva; configurá el resumidor con el archivo de settings o las variables PI_AUTO_COMPACTION_*.",
      "warning",
    );
    return;
  }

  const models = await listChatModels(ctx.modelRegistry);
  if (models.length === 0) {
    ui.notify("No hay modelos de chat disponibles con credenciales configuradas.", "error");
    return;
  }

  const current = runtime.get();
  const currentKey = `${current.primaryModel.provider}/${current.primaryModel.modelId}`;

  const primary = await selectModel(ctx, models, {
    title: "Modelo primario de la autocompactación",
    selected: currentKey,
  });
  if (!primary) {
    ui.notify("Configuración cancelada: no se modificó el resumidor.", "info");
    return;
  }

  const currentFallbackKey = `${current.fallbackModel.provider}/${current.fallbackModel.modelId}`;
  const fallback = await selectModel(ctx, models, {
    title: "Modelo de respaldo de la autocompactación",
    selected: currentFallbackKey,
  });
  if (!fallback) {
    ui.notify("Configuración cancelada: no se modificó el resumidor.", "info");
    return;
  }

  if (modelKey(primary) === modelKey(fallback)) {
    ui.notify(
      "El respaldo debe ser un modelo distinto del primario: aporta resiliencia cuando el primario falla. No se guardó nada.",
      "warning",
    );
    return;
  }

  const small = [primary, fallback].filter(
    (model) => typeof model.contextWindow === "number" && model.contextWindow > 0 && model.contextWindow < SMALL_CONTEXT_WINDOW,
  );
  if (small.length > 0) {
    ui.notify(
      `Atención: ${small.map(modelKey).join(", ")} tiene ventana de contexto chica (< ${formatTokenCount(SMALL_CONTEXT_WINDOW)} tokens); las sesiones largas van a caer al respaldo o a la compactación nativa.`,
      "warning",
    );
  }

  const summary = [
    `Primario: ${modelKey(primary)}`,
    `Respaldo: ${modelKey(fallback)}`,
    "Solo cambia el modelo que resume la compactación, no el modelo de conversación.",
    "¿Guardar?",
  ].join("\n");

  const confirmed = await ui.confirm("Configurar autocompactación", summary);
  if (!confirmed) {
    ui.notify("Configuración cancelada: no se modificó el resumidor.", "info");
    return;
  }

  try {
    runtime.saveSummarizerSettings({
      version: 1,
      primary: modelRef(primary),
      fallback: modelRef(fallback),
    });
  } catch (error) {
    ui.notify(`No se pudo guardar la configuración del resumidor: ${error.message}`, "error");
    return;
  }

  const updated = runtime.get();
  publishModelStatus(ui, updated);
  ui.notify(
    `Autocompactación: ${modelKey(primary)} con respaldo ${modelKey(fallback)}. Se aplica en la próxima compactación.`,
    "info",
  );
  for (const warning of updated.summarizer?.warnings || []) {
    ui.notify(warning, "warning");
  }
}
