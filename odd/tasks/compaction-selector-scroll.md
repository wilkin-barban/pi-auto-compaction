# Selector de modelos con scroll y búsqueda para `/compaction`

Objetivo: reemplazar el `ctx.ui.select` de `/compaction` por un selector propio construido con `SelectList` de `@earendil-works/pi-tui`, con scroll real, `maxVisible`, búsqueda incremental y soporte de teclado y rueda, para listas de 100+ modelos. Release 1.2.1.

No-objetivos: no cambiar el esquema del archivo de settings, la precedencia, el modelo de conversación ni las políticas v2 del manifiesto; no parchear Pi, gentle-shell, herdr ni `node_modules`; no agregar dependencias.

## Causa raíz y decisión

`ctx.ui.select` en Pi 1.5.0 se implementa con `ExtensionSelectorComponent`, que renderiza todas las opciones como filas `Text` sin `maxVisible`, viewport, scroll ni búsqueda: el índice se mueve con flechas/`j`/`k` pero la vista no lo sigue, así que los últimos modelos de una lista larga quedan inalcanzables visualmente.

Decisión: `ctx.ui.custom` con `SelectList` + `Input` + `fuzzyFilter` de `@earendil-works/pi-tui`, `maxVisible` derivado de `tui.terminal.rows`, hint de teclas y contador `(n/total)`. Fallback a `ui.select` fuera de TUI o cuando `ctx.ui.custom` no exista, avisando que ese modo no tiene scroll.

## Specs

- **S1 (selector)**: `src/model-selector.mjs` con `filterModels(models, query)` (provider, `id`/`modelId`, `name`, case-insensitive, vía `fuzzyFilter`, query vacía = todos), `modelItems(models)` (`value: provider/id`, `label: describeModel`), `maxVisibleForRows(rows, count)` = `Math.max(5, Math.min(count, (rows ?? 24) - 10))`, y `pickModel(ctx, models, { title, selected })` que usa `ctx.ui.custom`: `SelectList` con `maxVisible`, `Input` de búsqueda que filtra y reconstruye, "Sin coincidencias" cuando no hay, preselección por `value`, Enter selecciona, Esc cancela, hints visibles, `SelectListTheme` construido desde el `theme` recibido (`theme.fg`), componente `Component` + `Focusable`, retorno del modelo o `undefined`. Imports estáticos de `@earendil-works/pi-tui`; sin dependencias nuevas.
- **S2 (integración)**: `src/compaction-command.mjs` usa `pickModel` para primario y respaldo en TUI, preselecciona ambos valores actuales y mantiene fallback `ui.select`; se conservan todas las validaciones (mismo modelo, contexto < 32.000, confirmación, guardado atómico, `activeConfig`, status `pi-auto-compaction-model`). Sin cambios de esquema ni precedencia.
- **S3 (tests)**: `test/unit/model-selector.test.mjs` para filtro (provider, id, nombre, case-insensitive, vacía, sin coincidencias), `modelItems`, `maxVisibleForRows` (filas chicas/grandes/count menor), render con 100+ modelos y `maxVisible` 10 (≤ ~12 líneas, con info de scroll), filtro que reduce, preselección, import real de `@earendil-works/pi-tui`; `test/unit/compaction-command.test.mjs` actualizado para picker custom en TUI y fallback fuera de TUI, sin debilitar los casos existentes.
- **S4 (docs y release)**: README (búsqueda y scroll, teclas, workaround JSON/env), `docs/solucion-de-problemas.md` (limitación reemplazada por el comportamiento nuevo), `docs/arquitectura.md` (`SelectList`, `maxVisible`, búsqueda, fallback, por qué no se parchea Pi), `docs/instalacion.md` y `docs/mantenimiento.md` (mención breve), `CHANGELOG.md` 1.2.1, `repository-evidence.md`, ODD y bump de `package.json` a 1.2.1. Manifiesto v2 sin cambios.
- **S5 (verificación y publicación)**: `npm test` verde sobre baseline 302; smoke `PI_COMPAT_VERSION=0.87.1`; commits atómicos a `main`; push y `HEAD == origin/main`; CI verde (Node 22, Node 24, Pi 1.5.0); deploy live con dry-run previo; verificar marker `ready`, release nuevo, loader y que `.pi-auto-compaction-settings.json` (Haiku/Sonnet) quede intacto. Sin `/reload`; reportarlo.

## Tareas

- T1 — S1 selector + tests. Inline. Commit propio.
- T2 — S2 integración en `/compaction` + tests. Inline. Commit propio.
- T3 — S3 completar tests de render/preselección/fallback. Inline. Commit propio.
- T4 — S4 docs, CHANGELOG 1.2.1, bump y evidencia. Inline. Commit propio.
- T5 — S5 suite, smoke, push, CI y deploy live. Inline. Cierre.

## Criterios de aceptación

- A1: `/compaction` usa selector custom con `SelectList` en TUI y permite ver y elegir los últimos modelos de una lista de 100+.
- A2: búsqueda por provider/id/nombre, scroll con flechas, PageUp/PageDown, Home/End y rueda, contador `(n/total)`.
- A3: primario y respaldo preseleccionados con los valores actuales; mismo modelo rechazado; validaciones y guardado intactos.
- A4: fallback a `ui.select` si `ctx.ui.custom` no está disponible; RPC/no-TUI no se rompe.
- A5: tests nuevos de filtro, `maxVisible`, render, preselección, handler custom y fallback; suite ≥ 302 sin debilitar.
- A6: docs, CHANGELOG 1.2.1, workaround, evidencia y ODD alineados.
- A7: push verificado, CI verde, deploy live verificado y archivo de settings existente intacto.
- A8: `/reload` reportado; herdr abierto; agente idle.

## Evidencia RED/GREEN

- Pendiente al iniciar T1.

## Log

- L1 (usuario): «Quiero implementar la **opción B**: un selector propio con `ctx.ui.custom` y `SelectList` de `@earendil-works/pi-tui`, con scroll real, `maxVisible`, búsqueda/filtro y soporte de teclado/rueda. Release **1.2.1**, directo a `main`, publicado, desplegado y con el workaround documentado.» Estado inicial: `main == origin/main == 2668205`, suite 302/302 en 25 suites, CI verde, release live `60712d39…`, `doctor` HEALTHY, settings con `commandcode/claude-haiku-5-5` y `commandcode/claude-sonnet-5-5`.
