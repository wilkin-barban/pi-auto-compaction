# pi-auto-compaction

Extensión privada y controlada por el usuario para la compactación automática de contexto en Pi, gentle-shell y herdr.

Descarga la tarea pesada de resumen desde el modelo de conversación activo (OpenAI, DeepSeek, Gemini y otros) hacia resumidores independientes de OmniRoute con respaldo de múltiples niveles, telemetría privada y coordinación de UI opcional con herdr.

> **Aviso de licencia y distribución**: Este paquete es de uso privado (`license: "UNLICENSED"`, `private: true`). No se autoriza su publicación en npm ni su distribución pública. El repositorio oficial es privado: `https://github.com/wilkinbarban/pi-auto-compaction`.

---

## Inicio rápido

### 1. Clonar el repositorio

```bash
gh repo clone wilkinbarban/pi-auto-compaction "$HOME/proyectos/pi-auto-compaction"
cd "$HOME/proyectos/pi-auto-compaction"
```

### 2. Instalar dependencias y verificar el entorno

Se requiere Node.js `>=22.19.0` y dependencias fijadas exactas de Pi SDK / AI `0.87.1`.

```bash
npm ci --ignore-scripts
npm test
```

### 3. Simular la instalación (dry-run)

Valida sintaxis, ownership y estructura de archivos sin realizar escrituras en el disco:

```bash
node scripts/deploy.mjs --dry-run
# o mediante alias:
npm run deploy -- --dry-run
```

### 4. Desplegar

Instala el paquete en el directorio durable del usuario (`$HOME/.local/share/pi-auto-compaction`) y configura el loader oficial en Pi para una instalación inicial limpia:

```bash
node scripts/deploy.mjs
# o mediante alias:
npm run deploy
```

> **Definición de rutas**: Por defecto se asume `AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"` e `INSTALL_DIR="$HOME/.local/share/pi-auto-compaction"`. Si utiliza ubicaciones personalizadas, pase explícitamente `--agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"`.

### 5. Recargar Pi

Dentro de una sesión activa de Pi, ejecuta:

```text
/reload
```

O inicia una nueva terminal/sesión de Pi para activar la extensión.

---

## Características principales

- **Resumen desacoplado con OmniRoute**: Mantiene el modelo de conversación intacto (por ejemplo, `openai-codex/gpt-6.1-sol` o `commandcode/deepseek/deepseek-v4.1-flash`) mientras delega la compactación a modelos dedicados (`omniroute/antigravity/gemini-3.8-flash-tiered` como principal y `omniroute/antigravity/gemini-3.6-flash-high` como respaldo).
- **Umbrales por modelo**: políticas gestionadas para ocho identificadores. OpenAI: ventana 400.000, reserva 65.536, disparo 334.464 (~83,6%); DeepSeek: 1.000.000, reserva 140.000, disparo 860.000 (86%); Gemini: 1.048.576, reserva 200.000, disparo 848.576 (~80,9%). `npm run doctor` muestra el umbral efectivo y el origen de cada valor.
- **Límites de tiempo y cancelación**: 60 segundos por intento y 120 segundos de presupuesto total; cancelación inmediata cuando se dispara la señal de aborto (`AbortSignal`).
- **Respaldo nativo de Pi como último recurso**: Si ambos modelos de OmniRoute fallan o se agota el tiempo, el hook cede el control a la compactación nativa de Pi (el éxito de la compactación nativa no está garantizado si la cuota o infraestructura externa está agotada).
- **Telemetría privada**: Registra metadatos mínimos mediante lista blanca en `$HOME/.local/state/pi-auto-compaction/compaction.jsonl` (permisos 0600 en carpeta 0700). Registra tokens antes de compactar (`tokensBefore`), modelo resumidor, duración, estado y contexto de conversación (`conversationModel`, `conversationProvider`, `contextWindow`, `reserveTokens`, `keepRecentTokens`, `thresholdTokens`); no guarda `tokensAfter`, transcripciones completas, claves ni rutas personales. El contexto de conversación es transmitido deliberadamente a la API de OmniRoute para generar el resumen; la telemetría local solo persiste metadatos.
- **Despliegue transaccional por releases**: Gestión de versiones inmutables bajo `$HOME/.local/share/pi-auto-compaction/releases/<sha256>` con verificación de integridad y reversión segura.
- **Sin parches en paquetes gestionados**: No modifica el código instalado de Pi, gentle-shell ni herdr; opera exclusivamente mediante hooks oficiales del SDK.

---

## Configurar el modelo de compactación

A partir de la versión 1.2.0, podés configurar interactivamente qué modelos asumen la compactación automática sin reiniciar Pi ni alterar tu modelo de conversación.

### Comando interactivo `/compaction`

Ejecutá dentro de una sesión activa de Pi:

```text
/compaction
```

El panel interactivo te guía en dos pasos:

1. **Selección del modelo primario**: Muestra todos los modelos de chat disponibles en el harness con credenciales configuradas, ordenados alfabéticamente por `provider/id`, indicando con `✓` el modelo seleccionado actualmente.
2. **Selección del modelo de respaldo (fallback)**: Permite elegir un modelo alternativo para tolerar fallos del primario. Debe ser distinto del primario.

Cada opción muestra la información clave del modelo:
```text
provider/id · Nombre descriptivo · ctx <ventana_tokens> · max <max_tokens>
```

#### Reglas de validación y límites en el panel:
- **Modelos dinámicos del harness**: La lista no está hard-codeada; se consulta en tiempo real desde el registro de modelos de Pi (`ctx.modelRegistry`). Si un modelo no tiene credenciales válidas en `auth.json`, no aparece en la lista.
- **Respaldo distinto**: El modelo de respaldo debe ser diferente del primario; si se elige el mismo, el panel avisa y rechaza guardar para garantizar redundancia efectiva.
- **Advertencia por ventana de contexto reducida**: Si algún modelo seleccionado tiene una ventana de contexto inferior a **32.000 tokens** (`< 32.000`), el panel emite una advertencia (`warning`): en sesiones extensas el prompt de compactación podría exceder dicha ventana y requerir la caída al respaldo o al fallback nativo.
- **Confirmación y aplicación en caliente**: Antes de escribir, se solicita confirmación explícita. Al confirmar, los cambios se aplican **en caliente en memoria** (`runtimeConfig`) para la siguiente compactación sin requerir `/reload`, y se actualiza el indicador en la barra de estado inferior (`pi-auto-compaction-model`).

### Archivo de configuración independiente

La selección se persiste en un archivo JSON propio, aislado y seguro:

- **Ruta estándar**: `$PI_CODING_AGENT_DIR/.pi-auto-compaction-settings.json` (por defecto `$HOME/.pi/agent/.pi-auto-compaction-settings.json`).
- **Override de ruta**: Variable de entorno `PI_AUTO_COMPACTION_SETTINGS_PATH`.
- **Permisos estrictos**: Archivo creado con permisos `0600` (lectura/escritura exclusiva del usuario) y directorio padre con `0700`.
- **Escritura atómica**: Utiliza un archivo temporal y renombramiento atómico (`renameSync`). Si el destino es un enlace simbólico (symlink), la escritura es rechazada inmediatamente.
- **Aislamiento total de `settings.json`**: **Nunca escribe ni modifica `settings.json`**. Si el archivo `.pi-auto-compaction-settings.json` no existe, se emplean los valores predeterminados sin emitir advertencias. Si está corrupto o mal formado, se cargan los defaults seguros con una advertencia visible en `doctor`, sin sobrescribir el archivo dañado.

**Esquema JSON**:

```json
{
  "version": 1,
  "primary": {
    "provider": "antigravity",
    "modelId": "gemini-3.8-flash-tiered"
  },
  "fallback": {
    "provider": "antigravity",
    "modelId": "gemini-3.6-flash-high"
  }
}
```

### Ejemplos de emparejamiento de modelos

Podés configurar cualquier combinación de modelos de chat autorizados en tu instalación de Pi:

- **Antigravity directo**:
  - Primario: `antigravity/gemini-3.8-flash-tiered`
  - Respaldo: `antigravity/gemini-3.6-flash-high`
- **OpenAI / Codex**:
  - Primario: `openai/gpt-4o` (o `openai-codex/gpt-5.2-preview`)
  - Respaldo: `openai/gpt-4o-mini`
- **Command Code**:
  - Primario: `commandcode/deepseek/deepseek-v4.1-flash`
  - Respaldo: `commandcode/deepseek/deepseek-v3.1-lite`
- **Ollama local**:
  - Primario: `ollama/qwen2.5-coder:14b`
  - Respaldo: `ollama/llama3.2:3b`

### Semántica de fallback

El ciclo de autocompactación opera con una jerarquía de tolerancia a fallos:

1. **Intento primario**: Ejecuta el resumen con el modelo primario (límite: 60 segundos).
2. **Intento de respaldo**: Si el primario falla por timeout, saturación, error de tasa o contenido rechazado, se invoca de inmediato el modelo de respaldo (dentro del presupuesto acumulado de 120 segundos).
3. **Respaldo nativo de Pi**: Si el respaldo también falla o el tiempo total se agota, la extensión retorna `undefined` para que Pi ejecute su compactación nativa habitual con el modelo de conversación activo.

### Privacidad y relación con `skipProviders`

La configuración del modelo de compactación y la lista de omisión de proveedores (`PI_AUTO_COMPACTION_SKIP_PROVIDERS`) son ortogonales e independientes:

- Si el modelo de conversación activo pertenece a un proveedor listado en `PI_AUTO_COMPACTION_SKIP_PROVIDERS`, la extensión **no interviene** y cede el control a la compactación nativa de Pi, independientemente de los modelos configurados en `/compaction`.
- Si el proveedor no está en `skipProviders`, el resumen se delega a los modelos configurados en `.pi-auto-compaction-settings.json`.

---

## Documentación detallada

La documentación técnica completa está organizada en guías modulares:

1. [**Guía de Instalación**](docs/instalacion.md):
   Requisitos del sistema, autenticación privada en GitHub, credenciales de proveedores, despliegue transaccional, opciones de CLI y adopción consciente de raíces existentes.
2. [**Guía de Mantenimiento y Actualizaciones**](docs/mantenimiento.md):
   Flujo de actualización con `git pull --ff-only`, rollback de código vs. desinstalación de configuración, manejo de journals de recuperación y resolución de drift.
3. [**Arquitectura y Diseño**](docs/arquitectura.md):
   Ciclo de vida de hooks en Pi, arquitectura multi-tier de OmniRoute, modelos soportados, estructura de releases inmutables, telemetría y límites del sistema.
4. [**Solución de Problemas**](docs/solucion-de-problemas.md):
   Diagnóstico de autenticación previa al hook, fallos de infraestructura compartida, estado `pending`, errores de drift y recuperación paso a paso.

---

## Comandos disponibles del paquete

| Comando | Equivalente npm | Descripción |
|---|---|---|
| `node scripts/deploy.mjs` | `npm run deploy` | Despliegue inicial exclusivo en una raíz inexistente (creada por el wrapper; cualquier raíz preexistente sin marcador es rechazada, incluso vacía; no ejecute `mkdir` primero; use `--update`). |
| `node scripts/deploy.mjs --adopt-agent` | `npm run deploy -- --adopt-agent` | Adopta una instalación previa válida del agente en una nueva raíz gestionada inexistente preservando la línea base original. |
| `node scripts/deploy.mjs --dry-run` | `npm run deploy -- --dry-run` | Simula el despliegue sin modificar archivos ni configuración. |
| `node scripts/deploy.mjs --update` | `npm run deploy -- --update` | Actualiza la instalación a partir de las fuentes actuales. |
| `node scripts/deploy.mjs --rollback-source` | `npm run deploy -- --rollback-source` | Revierte el código activo al release anterior registrado (operación unitaria, repetirla es no-op). |
| `node scripts/doctor.mjs` | `npm run doctor` | Diagnóstico de solo lectura: umbral efectivo por modelo, origen de cada valor, estado de loader/manifiesto/marker/release y último registro de telemetría. `--json` para consumo programático; sale 0 sano, 1 advertencias, 2 error. |
| `node scripts/setup.mjs` | `npm run setup` | Configura el loader en el agente y aplica overrides de modelos. |
| `node scripts/rollback.mjs` | `npm run rollback` | Desinstala el loader y restaura la configuración original de modelos. |
| `node --test` | `npm test` | Ejecuta la suite completa de pruebas unitarias y de integración. |

### Privacidad y omisión de proveedores

La extensión resume la conversación con OmniRoute **para cualquier modelo de conversación**, incluidos DeepSeek y Gemini. Si un proveedor no debe salir del entorno local, definí `PI_AUTO_COMPACTION_SKIP_PROVIDERS` en el entorno que lanza Pi/gentle-shell para que ese modelo use la compactación nativa de Pi sin llamar al resumidor:

```bash
export PI_AUTO_COMPACTION_SKIP_PROVIDERS="deepseek,commandcode"
```

La comparación es exacta y sensible a mayúsculas contra el proveedor, el id completo del modelo o el prefijo antes de `/`; una entrada vacía o desconocida se ignora. También podés pasar `skipProviders` al cargar la extensión programáticamente (`autoCompactionExtension(pi, { skipProviders: [...] })`); el loader gestionado usa la variable de entorno. `npm run doctor` no necesita esta configuración y nunca escribe.


---

## Requisitos y compatibilidad

- **Sistema operativo**: Verificado y soportado en Linux. No se afirma compatibilidad formal en otros sistemas operativos.
- **Node.js**: Versión `>=22.19.0` (matriz de CI para Node 22 y 24; validado localmente en Node 22.23.2 con SDK 0.87.1; smoke de Pi 1.5.0 en CI; no se garantiza compatibilidad con todas las versiones futuras no probadas).
- **Pi Coding Agent**: Versión local/global de Pi instalada (probado con Pi 1.5.0). Dependencias de desarrollo fijadas en `@earendil-works/pi-coding-agent@0.87.1` y `@earendil-works/pi-ai@0.87.1`.
- **Proveedor OmniRoute**: Configuración activa del proveedor OmniRoute en Pi con acceso a los identificadores `omniroute/antigravity/gemini-3.8-flash-tiered` y `omniroute/antigravity/gemini-3.6-flash-high`.
- **Credenciales de conversación**: Credenciales válidas para el modelo de conversación activo en Pi (por ejemplo, OpenAI, DeepSeek/Command Code o Gemini en `auth.json`), requeridas por Pi para validar autenticación antes de invocar cualquier hook de compactación (la verificación previa valida autenticación, no cuota universal del proveedor).
