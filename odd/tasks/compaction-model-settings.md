# Configuración gráfica del modelo de compactación

Objetivo: elegir desde la consola el modelo primario y de respaldo que usa la autocompactación, saliendo de los modelos disponibles en el harness (`ctx.modelRegistry`), con persistencia propia, aplicación en caliente y visibilidad en status y `doctor`.

Alcance: extensión Pi en este repo; comando `/compaction`; store de settings; integración en `src/config.mjs` y `src/extension.mjs`; sección de resumidor en `scripts/doctor.mjs`; documentación y release 1.2.0.

No-objetivos: no parchear Pi, gentle-shell, herdr ni `node_modules`; no prometer una fila dentro de la página Extensions ni de `/gentle:customize` (no hay API); no cambiar el modelo de conversación ni `MANAGED_POLICIES` ni el manifiesto v2; no editar `~/.pi/agent/settings.json` a mano.

## Hallazgos de API y decisión de diseño

- `ExtensionAPI` expone `registerCommand`, `registerShortcut`, `ctx.ui.select/confirm/input/custom`, `setStatus`, `setWidget`, `getSettings`. No existe `registerSettings` ni inyección de páginas de settings.
- `/settings` → Extensions es `ConfigSelectorComponent`: solo habilita/deshabilita recursos, sin acciones por extensión.
- `/gentle:customize` tiene categorías hard-codeadas en `gentle-shell.ts`, sin hook de extensión.
- Decisión: comando TUI propio `/compaction` + status `pi-auto-compaction-model`. La extensión ya aparece en INTEGRATIONS; el comando aparece en el palette tras `/reload`.
- Modelos: `ctx.modelRegistry.getAvailableOfType("chat")`; fallback `getModelsOfType("chat")` filtrado por `hasConfiguredAuth`.

## Specs

- **S1 (store del resumidor)**: `src/summarizer-settings.mjs`. Ruta `$PI_CODING_AGENT_DIR/.pi-auto-compaction-settings.json` o `$HOME/.pi/agent/.pi-auto-compaction-settings.json`; override `PI_AUTO_COMPACTION_SETTINGS_PATH` u opción `settingsPath`. Esquema exacto:

```json
{
  "version": 1,
  "primary": { "provider": "antigravity", "modelId": "gemini-3.8-flash-tiered" },
  "fallback": { "provider": "antigravity", "modelId": "gemini-3.6-flash-high" }
}
```

Validación estricta (`version === 1`, `provider`/`modelId` strings no vacíos, sin campos desconocidos). Archivo ausente → defaults; inválido → warning y defaults sin sobreescribir. Escritura atómica (temp + rename), archivo `0600`, directorio `0700`, sin seguir symlinks del target, nunca escribe `settings.json`. Precedencia: `options` > env > archivo > `DEFAULT_CONFIG`. Env headless: `PI_AUTO_COMPACTION_PRIMARY_PROVIDER`, `PI_AUTO_COMPACTION_PRIMARY_MODEL`, `PI_AUTO_COMPACTION_FALLBACK_PROVIDER`, `PI_AUTO_COMPACTION_FALLBACK_MODEL`; la UI y `doctor` muestran el origen efectivo.

- **S2 (resolución y aplicación en caliente)**: `src/config.mjs` integra el store al resolver `primaryModel`/`fallbackModel` sin mutar `DEFAULT_CONFIG`; `src/extension.mjs` pasa a `let activeConfig = resolveConfig(options)` y `session_before_compact` lo lee en cada ciclo. Guardar re-resuelve, actualiza `activeConfig`, status y notifica; la próxima compactación usa el modelo nuevo sin `/reload`. Se conserva el fallback nativo de Pi, los timeouts, la telemetría y `skipProviders`. Un fallo de guardado conserva la config anterior.

- **S3 (comando `/compaction` y TUI)**: `pi.registerCommand("compaction", { description: "Configurar el modelo primario y de respaldo de la autocompactación", handler })`. Sin UI o `mode === "print"`: notificar y salir sin escribir. Lista desde `getAvailableOfType("chat")` con fallback; orden `provider/id`; label `provider/id · nombre · ctx 1.048.576 · max 65.536`; preselección con `✓`; elegir primario y respaldo; mismo modelo → avisar y no guardar; `contextWindow < 32000` → avisar; confirmar antes de guardar; guardar vía S1, actualizar `activeConfig`, notificar y status. `ctx.ui.select` dos veces es aceptable; `ctx.ui.custom` con `SelectList`/`SettingsList` de `@earendil-works/pi-tui` solo si el contexto alcanza, sin dependencias nuevas. Status en clave `pi-auto-compaction-model` con texto corto `Compaction: <provider>/<modelId>`, en `session_start` y tras guardar. El comando no cambia el modelo de conversación.

- **S4 (`doctor`)**: sección de resumidor con ruta, existencia y validez del archivo; primario/respaldo efectivos y origen (options/env/file/default); búsqueda en `models.json`, `models-store.json`, `commandcode-models.json` con `contextWindow`/`maxTokens` si están; warnings por archivo corrupto, modelo no encontrado o contexto chico; incluida en `--json`; read-only estricto.

- **S5 (documentación y release)**: `README.md` con “Configurar el modelo de compactación” (`/compaction`, archivo, ejemplos Antigravity/OpenAI-Codex/Command Code/Ollama local, modelos del harness, fallback, privacidad, límites de contexto); `docs/instalacion.md` (tras deploy/`/reload`/`/compaction`, `doctor`, archivo separado); `docs/mantenimiento.md` (sobrevive a `--update`, backup, reset, `doctor`); `docs/arquitectura.md` (precedencia, lista, UI, status, fallback nativo, por qué no está en Extensions); `docs/solucion-de-problemas.md` (comando no visible hasta `/reload`, sin modelos, modelo no encontrado, archivo corrupto, contexto chico, primario == respaldo, modelo local lento); `CHANGELOG.md` 1.2.0; bump de `package.json`; `repository-evidence.md`; ODD con hashes. No reescribir 1.0.0/1.1.0.

- **S6 (verificación, deploy y publicación)**: `npm test` verde sobre baseline 232; `PI_COMPAT_VERSION=0.87.1 node scripts/compat/pi-1.5.0-smoke.mjs`; todo a `main`, Conventional Commits atómicos ≤400 líneas si es razonable, sin `Co-Authored-By`; push y `HEAD == origin/main`; CI verde (Node 22, Node 24, Pi 1.5.0 smoke); deploy live con `--update --dry-run` y luego real sobre `$HOME/.pi/agent` y `$HOME/.local/share/pi-auto-compaction-managed`; verificar marker `ready`, release nuevo, loader, sin journals/locks. No ejecutar `/reload`; reportarlo. herdr abierto.

## Tareas

- T1 — S1 store + tests. Writer/worker. Commit propio.
- T2 — S2 integración en `config.mjs`/`extension.mjs` + tests de precedencia y caliente. Inline. Commit propio.
- T3 — S3 comando `/compaction` + TUI + status + tests. Inline. Commit propio.
- T4 — S4 sección de resumidor en `doctor` + tests. Writer. Commit propio.
- T5 — S5 docs, CHANGELOG 1.2.0, bump y evidencia. Inline. Commit propio.
- T6 — S6 suite, smoke, push, CI y deploy live. Inline. Cierre.

## Criterios de aceptación

- A1: `/compaction` registrado y visible en el palette tras `/reload`.
- A2: lista solo modelos de chat disponibles, con provider/id y contexto; sin lista hard-codeada.
- A3: guarda primario/respaldo en archivo propio con 0600/0700 y escritura atómica; no toca `settings.json`.
- A4: la próxima compactación usa la selección sin reiniciar y el status muestra el modelo activo.
- A5: `doctor` muestra settings, origen, primario/respaldo y warnings; `--json` los incluye.
- A6: archivo ausente/corrupto no rompe la extensión; defaults seguros y warning visible.
- A7: tests cubren store, precedencia, UI, guardado/cancelación, modelos ausentes, mismo modelo y no-TUI.
- A8: docs/CHANGELOG/versión/evidencia/ODD alineados; CI verde; push y deploy live verificados; `/reload` reportado.

## Evidencia RED/GREEN

- Pendiente al iniciar T1.

## Log

- L1 (usuario): «Quiero que construyas una configuración gráfica en la consola para elegir el modelo que hace la autocompactación… No quiero parchear Pi, gentle-shell, herdr ni `node_modules`.» Specs S1–S6 y criterios A1–A8 transcriptos arriba con los valores exactos (rutas, esquema JSON, variables de entorno, descripción del comando y claves de status). Estado inicial: `HEAD == origin/main == 712ac54`, `npm test` 232/232 en 12 suites, CI verde en Node 22, Node 24 y Pi 1.5.0 smoke, sesión al 13% de contexto con la política nueva aún no recargada.
