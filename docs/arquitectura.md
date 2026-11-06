# Arquitectura y Diseño Técnico

Este documento describe la arquitectura interna de **pi-auto-compaction**, el ciclo de vida de los hooks en el SDK de Pi, el mecanismo de delegación de resúmenes hacia OmniRoute, la preservación de contexto y el modelo de telemetría.

---

## 1. Visión general del flujo de ejecución

En una instalación estándar de Pi, la compactación de contexto utiliza el mismo modelo de conversación configurado por el usuario. Cuando el contexto alcanza un umbral crítico, Pi pausa la conversación y solicita al modelo de chat (por ejemplo, OpenAI GPT) que genere un resumen de los turnos antiguos. Esto genera dos inconvenientes: consume cuota costosa del modelo principal de conversación y puede generar bloqueos si dicho modelo experimenta latencia o restricciones de tasa.

**pi-auto-compaction** intercepta este proceso desacoplando el modelo de conversación del modelo de compactación:

```text
[Conversación activa en Pi] (ej. gpt-6-sol / gpt-6.1-sol)
              │
              ▼
   ¿Tokens > umbral efectivo (ventana − reserveTokens)?
              │
              ├─ No ──► Continúa conversación normal
              │
              └─ Sí ──► Pi verifica autenticación de conversación en auth.json
                             │
                             ▼
                    Dispara hook `session_before_compact`
                             │
                             ▼
               ┌──────────────────────────────┐
               │     pi-auto-compaction       │
               │                              │
               │  1. Bloqueo UI (herdr opcional)
               │  2. Construir prompt seguro  │
               │  3. Consultar Primary Model  │
               │     (gemini-3.8-flash-tiered)│
               │     [Timeout: 60s]           │
               └──────────────┬───────────────┘
                              │
               ┌──────────────┴──────────────┐
               │                             │
          ¿Éxito?                       ¿Falló?
               │                             │
              Sí                             ▼
               │                ┌──────────────────────────────┐
               │                │   Reintento: Backup Model    │
               │                │   (gemini-3.6-flash-high)    │
               │                │   [Presupuesto total: 120s]  │
               │                └──────────────┬───────────────┘
               │                               │
               │                       ┌───────┴───────┐
               │                       │               │
               │                  ¿Éxito?          ¿Falló?
               │                       │               │
               │                      Sí               ▼
               │                       │    Retorna undefined:
               │                       │    Pi activa fallback nativo
               ▼                       ▼    (Éxito no garantizado)
   ┌───────────────────────────────────────┐
   │ Registra telemetría privada (0600)    │
   │ Retorna objeto CompactionResult a Pi │
   │ Libera bloqueo UI (herdr)            │
   └───────────────────┬───────────────────┘
                       │
                       ▼
       Pi actualiza entradas de sesión
```

---

## 2. Invariante crítica: Verificación de autenticación previa al hook

Un detalle arquitectónico fundamental del SDK de Pi (`AgentSession._runAutoCompaction`) es el orden de operaciones:

1. Antes de emitir el evento `session_before_compact`, Pi invoca internamente el método `_getSummarizationRequestAuth(model)` utilizando el **modelo de conversación activo**.
2. Pi comprueba que existan credenciales válidas y activas para ese modelo en `auth.json`. Si las credenciales faltan o están expiradas, **Pi aborta la operación antes de invocar la extensión**. Esta comprobación previa valida **autenticación** (presencia de clave o token válido), no cuota universal del proveedor. Los errores de cuota, saturación o cortes de red de los proveedores ocurren durante la fase posterior de ejecución de la solicitud y no impiden la invocación inicial del hook.
3. Por tanto, esta extensión **no puede ni intenta eludir la necesidad de credenciales válidas para el modelo de conversación**. Asegúrese siempre de mantener autenticado el modelo de chat principal en `auth.json`.

---

## 3. Resumidores de OmniRoute y política de fallback

La extensión utiliza la API `ctx.modelRegistry.complete` para despachar la tarea de resumen a través de la pasarela de OmniRoute:

### Modelos configurados

Por defecto, la extensión utiliza los siguientes identificadores:
- **Modelo principal por defecto (Primary)**:
  `omniroute/antigravity/gemini-3.8-flash-tiered`
- **Modelo de respaldo por defecto (Fallback)**:
  `omniroute/antigravity/gemini-3.6-flash-high`

A partir de la versión 1.2.0, estos modelos son totalmente configurables por el usuario (mediante el comando `/compaction`, variables de entorno o archivo de configuración).

Cualquiera sea el modelo utilizado, si cuenta con soporte de razonamiento (`model.reasoning` es verdadero), se aplican condicionalmente parámetros de esfuerzo bajo (`reasoningEffort: "low"` y `reasoning: "low"`); no se adjuntan a modelos que no lo soportan. Esto optimiza la velocidad de respuesta y el costo de generación del resumen.

### Presupuesto de tiempo y cancelación

- **Por intento**: Cada llamada a un resumidor tiene un límite estricto de **60 segundos**.
- **Presupuesto acumulado**: El tiempo total combinado de intentos no puede superar los **120 segundos**.
- **Cancelación inmediata**: Si el usuario aborta la operación en Pi o se interrumpe la sesión, la señal `AbortSignal` padre cancela de inmediato la petición en curso sin esperar a que concluya el timeout.

### Caída al resumen nativo de Pi

Si tanto el modelo principal como el de respaldo fallan, o si se agota el presupuesto de 120 segundos, la extensión no lanza una excepción no controlada:
- Devuelve `undefined`.
- Esto indica a Pi que debe intentar su procedimiento de resumen nativo predeterminado como último recurso.
- **Advertencia**: Si la falla se debió a un corte general de conectividad o infraestructura compartida, el resumen nativo también podría fallar; esta extensión no puede garantizar el éxito del fallback nativo.

---

## 4. Umbrales de activación y modelos soportados

La extensión gestiona ocho identificadores de modelo de conversación, agrupados por ventana de contexto. La política vive en `src/install-state.mjs` (`MANAGED_POLICIES`) y el manifiesto v2 la congela:

| Modelos | Ventana | `reserveTokens` | `keepRecentTokens` | Dispara a |
|---|---|---|---|---|
| `openai/gpt-6-sol`, `openai/gpt-6.1-sol`, `openai-codex/gpt-6-sol`, `openai-codex/gpt-6.1-sol` | 400.000 | 65.536 | 20.000 | 334.464 (~83,6%) |
| `commandcode/deepseek/deepseek-v4.1-flash`, `deepseek/deepseek-v4.1-flash` | 1.000.000 | 140.000 | 20.000 | 860.000 (86%) |
| `omniroute/antigravity/gemini-3.8-flash-tiered`, `antigravity/gemini-3.8-flash-tiered` | 1.048.576 | 200.000 | 20.000 | 848.576 (~80,9%) |

### Cálculo de umbrales

La fórmula de activación de Pi es:

$$\text{Umbral de activación} = \text{Ventana Total} - \text{reserveTokens}$$

Con la política DeepSeek (`1.000.000 - 140.000 = 860.000`) la compactación se dispara recién al **86%** de la capacidad. El caso histórico que motivó esta corrección fue un override externo de `860000` reservados sobre el mismo modelo: disparaba a 140.000 tokens, es decir al **14%**, y produjo 105 compactaciones prematuras en una sola sesión. `npm run doctor` reporta ese escenario como advertencia con el porcentaje exacto.

### Modelos no gestionados

Cualquier identificador fuera de la tabla no se modifica: conserva el override del usuario o, si no tiene, los defaults de Pi (`reserveTokens` 16.384, `keepRecentTokens` 20.000). Un override externo sobre un modelo gestionado se detecta como drift en setup/rollback, y `npm run doctor` lo advierte sin bloquear ni escribir. Para gestionar un modelo nuevo hay que agregarlo a `MANAGED_POLICIES` en `src/install-state.mjs`, actualizar las pruebas de `test/integration/install-state.test.mjs` y publicar un release.

Para que un proveedor concreto use la compactación nativa de Pi sin pasar por OmniRoute, definí `PI_AUTO_COMPACTION_SKIP_PROVIDERS` (lista separada por comas, match exacto y sensible a mayúsculas) o pasá `skipProviders` al cargar la extensión. El loader gestionado usa la variable de entorno.

---

## 5. Integración con UI y coordinación con herdr

Durante la compactación, la extensión coordina el estado visual para evitar que el usuario o el harness interpreten la pausa como un bloqueo del sistema:

- Si `herdr` está disponible en el entorno, adquiere **exactamente un** bloqueo activo (`herdr:blocked`) al iniciar el ciclo.
- Actualiza las etiquetas de etapa en la interfaz (por ejemplo, indicando el intento con el resumidor principal o secundario).
- Libera de manera segura y determinista el bloqueo al concluir el ciclo, ya sea por éxito, error, cancelación o apagado de la sesión.
- No modifica archivos de producto de herdr ni altera código fuente ajeno.

---

## 6. Telemetría y privacidad

La extensión mantiene un registro de auditoría local para diagnosticar el comportamiento de las compactaciones:

- **Ubicación**: `$HOME/.local/state/pi-auto-compaction/compaction.jsonl`. (La carpeta `$HOME/.local/state/pi-auto-compaction/` está reservada exclusivamente para telemetría; los journals de recuperación y despliegue residen en sus directorios respectivos de instalación y agente).
- **Permisos de archivo**: Modo `0600` (lectura/escritura exclusiva del usuario) dentro de un directorio con permisos `0700`.
- **Lista blanca de metadatos**: Se registran únicamente métricas cuantitativas y metadatos de configuración: marca de tiempo (`timestamp`), identificador de sesión (`sessionId`), motivo (`reason`), modelo resumidor (`model`), estado (`status`), duración en milisegundos (`durationMs`), tokens antes de compactar (`tokensBefore`), uso de tokens si está disponible (`usage`), conteo de intentos (`attemptCount`), categoría de error (`errorCategory`), y los campos de contexto conversacional: modelo de conversación (`conversationModel`), proveedor de conversación (`conversationProvider`), ventana de contexto (`contextWindow`), tokens reservados (`reserveTokens`), tokens recientes retenidos (`keepRecentTokens`) y umbral de activación (`thresholdTokens`). **No existe el campo `tokensAfter`**.

### Campos del registro y distinción entre `model` y `conversationModel`

- **`model` vs. `conversationModel`**: El campo `model` identifica al **modelo resumidor** encargado de sintetizar el contexto histórico (por ejemplo, `omniroute/antigravity/gemini-3.8-flash-tiered`, `omniroute/antigravity/gemini-3.6-flash-high` o `native`). Por contraste, `conversationModel` y `conversationProvider` identifican el modelo y proveedor de la conversación activa que detonó la compactación (por ejemplo, `deepseek-v4.1-flash` con proveedor `deepseek`, o `gpt-6-sol` con proveedor `openai`).
- **Métricas numéricas de ventana y umbrales**:
  - `contextWindow`: Tamaño total de la ventana de contexto del modelo de conversación en tokens (entero positivo).
  - `reserveTokens`: Margen efectivo de tokens reservados para la respuesta del modelo (entero no negativo).
  - `keepRecentTokens`: Cantidad de tokens de turnos recientes que se preservan sin resumir (entero no negativo).
  - `thresholdTokens`: Umbral exacto en el que Pi detona la compactación, calculado como `contextWindow - reserveTokens`.
- **Regla de omisión y fallbacks**: Los valores de configuración de tokens se resuelven consultando en orden:
  1. El override específico del modelo (`compaction.modelOverrides["<provider>/<id>"]`).
  2. La configuración global de compactación (`compaction.reserveTokens` / `compaction.keepRecentTokens`).
  3. Los valores por defecto de Pi (`16384` para `reserveTokens`, `20000` para `keepRecentTokens`).
  Si cualquier dato de entrada no está disponible o es inválido (por ejemplo, ausencia de `ctx.model`, falta de `contextWindow` en el modelo, archivo de configuración corrupto o ilegible), los campos afectados se **omiten completamente** del registro JSONL. Nunca se escriben valores sustitutos como `null`, `NaN` o `0` arbitrario, y nunca se lanzan excepciones. La telemetría jamás interrumpe ni hace fallar el ciclo de compactación.
- **Compatibilidad con registros previos**: Los registros generados por versiones anteriores de la extensión que carecen de estos seis campos permanecen válidos, legibles e intactos en el archivo de telemetría; ningún lector ni analizador falla al encontrarlos.
- **Privacidad estricta**: No se almacenan transcripciones de mensajes, contenido de sesiones, claves de API, rutas personales de usuario ni `tokensAfter`. Únicamente se persisten los seis metadatos autorizados junto a las métricas del ciclo.
- **Datos no registrados**: Se excluyen estrictamente las transcripciones completas de los mensajes, claves de API, variables de entorno y rutas completas del sistema de archivos.
- **Claridad sobre transmisión de datos**: Para que los resumidores de OmniRoute puedan generar el resumen del contexto anterior, **el texto de los turnos antiguos de la conversación se transmite deliberadamente a la API de OmniRoute**. El cifrado en tránsito depende del protocolo del endpoint configurado (se recomienda enfáticamente HTTPS; la extensión no impone TLS a nivel de transporte). No debe afirmarse que ningún contenido conversacional abandona la máquina; lo que se garantiza es que la telemetría local persistida en disco no almacena transcripciones ni secretos.

---

## 7. Configuración del resumidor, precedencia y comando `/compaction`

La versión 1.2.0 introduce la capacidad de seleccionar y alternar los modelos de autocompactación de manera desacoplada.

### Cadena de precedencia de configuración

La resolución de los modelos activo y de respaldo sigue una cadena estricta de cuatro niveles:

$$\text{options} \succ \text{env} \succ \text{file} \succ \text{default}$$

1. **`options` (Prioridad máxima)**: Opciones pasadas explícitamente en código (`primaryModel`/`primary`, `fallbackModel`/`fallback`).
2. **`env`**: Variables de entorno para entornos automatizados o headless:
   - `PI_AUTO_COMPACTION_PRIMARY_PROVIDER` y `PI_AUTO_COMPACTION_PRIMARY_MODEL`.
   - `PI_AUTO_COMPACTION_FALLBACK_PROVIDER` y `PI_AUTO_COMPACTION_FALLBACK_MODEL`.
   *Regla de pares*: Un par incompleto (por ejemplo, definir el proveedor sin el modelo) se descarta con advertencia y no sobreescribe la capa inferior.
3. **`file`**: Archivo de persistencia de usuario `$AGENT_DIR/.pi-auto-compaction-settings.json` (o `$HOME/.pi/agent/...`, con override en `PI_AUTO_COMPACTION_SETTINGS_PATH`). Si el archivo no existe, no genera advertencia y cede el paso a los defaults. Si contiene JSON corrupto o esquema inválido, emite advertencia diagnóstica y no lo sobrescribe.
4. **`default` (Línea base)**: Los modelos predeterminados inmutables (`DEFAULT_EFFECTIVE_SUMMARIZER` / `DEFAULT_CONFIG`): `omniroute/antigravity/gemini-3.8-flash-tiered` como primario y `omniroute/antigravity/gemini-3.6-flash-high` como respaldo.

**Pureza arquitectónica**: `resolveConfig` se mantiene estrictamente como una función pura sin efectos secundarios ni operaciones de sistema de archivos. La función `resolveActiveConfig` es el único punto del sistema que lee el disco y genera el descriptor inmutable `summarizer` con `path`, `source` (por ejemplo `"file"`, `"env"`, `"default"` o fuentes combinadas como `"env+file"`), `sources` y `warnings`.

### Descubrimiento dinámico de modelos de chat

La lista de modelos seleccionables no se basa en un catálogo hard-codeado ni estático. En su lugar, consulta directamente el registro del harness de Pi (`ctx.modelRegistry`):

1. Invoca `ctx.modelRegistry.getAvailableOfType("chat")`.
2. Si la lista está vacía o el método no está disponible, consulta `ctx.modelRegistry.getModelsOfType("chat")` filtrando aquellos donde `ctx.modelRegistry.hasConfiguredAuth(model)` es verdadero.
3. Se descartan modelos sin proveedor o id válidos y se ordenan alfabéticamente por `provider/id`.

De esta forma, cualquier modelo que el usuario tenga configurado y autenticado en Pi (Antigravity, OpenAI, Command Code, Gemini, modelos locales en Ollama, etc.) queda inmediatamente disponible para resumir.

### Indicador de estado en UI y footer (`pi-auto-compaction-model`)

Para visibilidad operativa continua, la extensión registra una entrada en la barra de estado de Pi:

- **Clave de estado**: `pi-auto-compaction-model`.
- **Formato del texto**: `Compaction: <provider>/<modelId>` (reflejando el modelo primario activo).
- **Ciclo de vida**: Se publica en el evento `session_start` y se actualiza inmediatamente cuando el usuario guarda una nueva selección en `/compaction`.
- **Aislamiento**: La publicación es puramente cosmética. Cualquier rechazo o fallo en `ui.setStatus` es capturado silenciosamente para no interrumpir jamás el ciclo de compactación ni el trabajo del agente.

### Decisión de diseño: Por qué `/compaction` y no la página Extensions de Pi

Se evaluó la posibilidad de integrar la configuración dentro de la página nativa de extensiones de Pi (`/settings` → Extensions) o dentro del menú `/gentle:customize` de gentle-shell. Dicha alternativa fue descartada por los siguientes límites de API de Pi 1.5.0 y gentle-pi 4.6.0:

1. **Ausencia de API de configuración en `ExtensionAPI`**: El SDK de Pi expone `registerCommand`, `registerShortcut`, `ctx.ui.*`, `setStatus` y `setWidget`. No existe `registerSettings` ni ningún hook para registrar páginas o paneles interactivos personalizados dentro de la configuración central.
2. **Limitación de `ConfigSelectorComponent`**: La interfaz de `/settings` → Extensions utiliza internamente `ConfigSelectorComponent`, diseñado exclusivamente para activar o desactivar extensiones completas (interruptores on/off), sin soporte para campos, formularios o selectores arbitrarios.
3. **Estructura estática de `/gentle:customize`**: En gentle-shell, las categorías de personalización están codificadas de forma fija en `gentle-shell.ts`, sin permitir que extensiones de terceros registren elementos propios.
4. **Respeto a la política de No-Parches**: Intentar inyectar la configuración en esas páginas requeriría parches invasivos sobre `node_modules` o sobre binarios instalados globalmente, violando las directrices de integridad del repositorio.

Por consiguiente, la implementación de un comando interactivo propio (`/compaction`), combinado con el indicador en el footer (`pi-auto-compaction-model`) y persistencia atómica en `.pi-auto-compaction-settings.json`, ofrece una experiencia de usuario ergonómica, limpia y 100% compatible con las APIs oficiales del SDK.
