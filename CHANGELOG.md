# Registro de Cambios (Changelog)

Todos los cambios notables en este proyecto serán documentados en este archivo.

El formato se basa en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y este proyecto se adhiere a [Semantic Versioning](https://semver.org/lang/es/).

> **Nota de versión**: Este repositorio es privado. La mención de versiones describe hitos del código fuente y no implica la publicación formal de releases en GitHub Releases ni en registros públicos de paquetes.

---

## [1.2.1] - 2026-11-06

### Corregido

- Selector de modelos en `/compaction`: scroll real, búsqueda incremental y `maxVisible` derivado de las filas del terminal mediante `SelectList` de `@earendil-works/pi-tui`. Permite que los últimos modelos de una lista larga de más de 100 opciones sean plenamente alcanzables y seleccionables, con soporte de navegación por teclado (`↑↓`, `PgUp/PgDn`, `Home/End`, `j/k`, `Enter`, `Esc`), rueda del ratón y fallback plano a `ui.select` en hosts sin UI personalizada.

### Documentación

- Documentado el workaround manual de configuración mediante edición directa de `$PI_CODING_AGENT_DIR/.pi-auto-compaction-settings.json` o uso de variables de entorno `PI_AUTO_COMPACTION_*`, seguido de `/reload` y verificación con `doctor`.

---

## [1.2.0] - 2026-11-06

### Agregado

- Comando `/compaction`: selector TUI que lista los modelos de chat disponibles en el harness (`ctx.modelRegistry`) con `provider/id`, nombre, `contextWindow` y `maxTokens`, permite elegir primario y respaldo, avisa si el contexto es chico y rechaza un respaldo idéntico al primario. No cambia el modelo de conversación.
- Archivo propio del resumidor `$PI_CODING_AGENT_DIR/.pi-auto-compaction-settings.json` (o `$HOME/.pi/agent/...`), separado de `settings.json`, con escritura atómica, permisos `0600`/`0700`, rechazo de symlinks y esquema validado (`version: 1`).
- Precedencia de configuración `options > env > archivo > defaults`, con variables `PI_AUTO_COMPACTION_PRIMARY_PROVIDER`, `PI_AUTO_COMPACTION_PRIMARY_MODEL`, `PI_AUTO_COMPACTION_FALLBACK_PROVIDER`, `PI_AUTO_COMPACTION_FALLBACK_MODEL` y override de ruta `PI_AUTO_COMPACTION_SETTINGS_PATH`.
- Indicador de estado `pi-auto-compaction-model` en el footer, publicado en `session_start` y actualizado al guardar.
- Sección de resumidor en `doctor`: ruta y validez del archivo, modelos efectivos con su origen, búsqueda en catálogos y advertencias por archivo corrupto, modelo ausente o contexto chico.

### Cambiado

- La configuración del resumidor se aplica en caliente: la próxima compactación usa los modelos nuevos sin `/reload`.
- Un archivo de settings corrupto o inválido no rompe la extensión: se usan los defaults seguros y se conserva el archivo para diagnóstico.

---

## [1.1.0] - 2026-11-06

### Agregado

- `--adopt-agent`: adopta una instalación previa válida del agente en una raíz gestionada nueva, con transacción, recibo y compensación CAS.
- `npm run doctor`: diagnóstico de solo lectura con umbral efectivo por modelo, origen de cada valor, estado de loader/manifiesto/marker/release y último registro de telemetría; `--json` y códigos de salida 0/1/2.
- Telemetría con contexto de conversación (`conversationModel`, `conversationProvider`, `contextWindow`, `reserveTokens`, `keepRecentTokens`, `thresholdTokens`), sin transcripciones ni credenciales.
- `skipProviders` / `PI_AUTO_COMPACTION_SKIP_PROVIDERS` para que un proveedor concreto use la compactación nativa de Pi en lugar del resumidor.
- Job de CI que instala Pi 1.5.0 y corre un smoke de exports, defaults y hooks.

### Cambiado

- Políticas de compactación por modelo en lugar de un valor global, con manifiesto v2 y migración idempotente desde v1 que preserva las líneas base originales.
- DeepSeek `reserveTokens` 140.000 (dispara a 860k, 86%) y Gemini 200.000 (848.576, ~80,9%); OpenAI conserva 65.536/20.000. Corrige el override externo de 860k que compactaba DeepSeek al 14%.
- `setup` y `rollback` ya no crean el directorio de estado en `--dry-run`.
- Documentación alineada con manifiesto v2, ocho modelos, `skipProviders` por entorno, `npm run doctor`, dry-run read-only y conteos actuales de la suite.

### Eliminado

- `isOwnManifest` en `deploy.mjs` (definido y nunca llamado).

---

## [1.0.0] - 2026-10-01

### Añadido
- **Mecanismo de compactación desacoplado con OmniRoute**:
  - Intercepción mediante el hook oficial `session_before_compact` de Pi.
  - Modelo principal: `omniroute/antigravity/gemini-3.8-flash-tiered` con `reasoningEffort: "low"` condicional a modelos con soporte de razonamiento (`model.reasoning`).
  - Modelo de respaldo: `omniroute/antigravity/gemini-3.6-flash-high` con `reasoningEffort: "low"` condicional a modelos con soporte de razonamiento (`model.reasoning`).
  - Fallback limpio hacia la compactación nativa de Pi si ambos modelos de OmniRoute fallan o se agota el tiempo límite.
- **Límites estrictos de ejecución**:
  - Límite de 60 segundos por intento de resumen.
  - Presupuesto total acumulado de 120 segundos por ciclo de compactación.
  - Cancelación inmediata ante activación de la señal de aborto (`AbortSignal`).
- **Configuración precisa de umbrales de tokens**:
  - Parámetros `reserveTokens: 65536` y `keepRecentTokens: 20000` sobre ventanas de 272.000 tokens (umbral de activación al ~76% / 206.464 tokens).
  - Soporte para cuatro modelos de conversación: `openai/gpt-6-sol`, `openai/gpt-6.1-sol`, `openai-codex/gpt-6-sol` y `openai-codex/gpt-6.1-sol`.
- **Despliegue transaccional por releases (`scripts/deploy.mjs`)**:
  - Creación de releases inmutables bajo `releases/<sha256>` con verificación de hash mediante `.release.json`.
  - Marcador de estado `.pi-auto-compaction-deploy.json` con campos canónicos `current`, `previous` y ciclo transaccional `state: "pending"` -> `state: "ready"`.
  - Despliegue inicial sin modo (falla si ya existe instalación gestionada; actualización explícita con `--update`).
  - Actualización idempotente con detección de no-op por coincidencia de hash.
  - Reversión de fuentes (`--rollback-source`) hacia el release anterior registrado (operación unitaria; repetirla es un no-op y no alterna versiones; no es una desinstalación).
  - Modo `--dry-run` estrictamente de solo lectura con verificación estática y sintáctica mediante `vm.SourceTextModule`.
- **Scripts de configuración y rollback de agente**:
  - `scripts/setup.mjs`: Registro del baseline original en `originalOverrides` y valores esperados en `expectedManagedValues` dentro de `.pi-auto-compaction-manifest.json`, e instalación del loader TypeScript en `$AGENT_DIR/extensions/omniroute-compaction.ts`.
  - `scripts/rollback.mjs`: Desinstalación del loader y restauración exacta de los valores originales de `settings.json` a partir de `originalOverrides`, con compensación transaccional en reversa (la desinstalación retiene el marcador y releases en el directorio de instalación).
  - Detección de drift contra `expectedManagedValues` y política estricta de rechazo fail-closed sin elusión mediante `--force`.
- **Telemetría privada**:
  - Registro local en formato JSON Lines (`~/.local/state/pi-auto-compaction/compaction.jsonl`) con permisos `0600` en directorio `0700`.
  - Filtrado por lista blanca de métricas cuantitativas (`tokensBefore`, duración, modelo, estado; sin campo `tokensAfter`), sin inclusión de transcripciones de chat, claves ni rutas personales. El contexto de conversación se transmite deliberadamente a la API de OmniRoute para generar el resumen.
- **Integración con interfaz y herdr**:
  - Adquisición y liberación determinista de un único bloqueo `herdr:blocked` por ciclo de compactación.
  - Actualización de etiquetas de etapa en UI sin fugas de contadores.
- **Suite de pruebas automatizadas**:
  - 163 pruebas unitarias y de integración pasando al 100% bajo `node --test` y Node.js `>=22.19.0`.
  - Fixtures completamente desconectados (offline) sin requerimiento de credenciales reales ni acceso a red.
- **Flujo de Integración Continua (CI)**:
  - Flujo de GitHub Actions configurado con matriz para Node.js 22 y 24 con permisos de solo lectura (`contents: read`); validación local observada en Node 22.23.2 con SDK 0.87.1 (ejecución remota de CI pendiente tras el primer push; no se afirma que ambos hayan corrido remotamente aún). Se requiere Node.js >= 22.19.
