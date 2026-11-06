# pi-auto-compaction

Extensión privada y controlada por el usuario para la compactación automática de contexto en Pi, gentle-shell y herdr.

Descarga la tarea pesada de resumen desde los modelos de conversación de OpenAI hacia resumidores independientes de OmniRoute con respaldo de múltiples niveles, telemetría privada y coordinación de UI opcional con herdr.

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

- **Resumen desacoplado con OmniRoute**: Mantiene el modelo de conversación intacto (por ejemplo, OpenAI `gpt-6-sol` o `gpt-6.1-sol`) mientras delega la compactación a modelos dedicados (`omniroute/antigravity/gemini-3.8-flash-tiered` como principal y `omniroute/antigravity/gemini-3.6-flash-high` como respaldo).
- **Umbral estricto del ~76%**: Se activa automáticamente al superar los 206.464 tokens sobre una ventana de 272.000 tokens (`reserveTokens: 65536`, `keepRecentTokens: 20000`).
- **Límites de tiempo y cancelación**: 60 segundos por intento y 120 segundos de presupuesto total; cancelación inmediata cuando se dispara la señal de aborto (`AbortSignal`).
- **Respaldo nativo de Pi como último recurso**: Si ambos modelos de OmniRoute fallan o se agota el tiempo, el hook cede el control a la compactación nativa de Pi (el éxito de la compactación nativa no está garantizado si la cuota o infraestructura externa está agotada).
- **Telemetría privada**: Registra metadatos mínimos mediante lista blanca en `$HOME/.local/state/pi-auto-compaction/compaction.jsonl` (permisos 0600 en carpeta 0700). Registra tokens antes de compactar (`tokensBefore`), modelo, duración y estado; no guarda `tokensAfter`, transcripciones completas, claves ni rutas personales. El contexto de conversación es transmitido deliberadamente a la API de OmniRoute para generar el resumen; la telemetría local solo persiste metadatos.
- **Despliegue transaccional por releases**: Gestión de versiones inmutables bajo `$HOME/.local/share/pi-auto-compaction/releases/<sha256>` con verificación de integridad y reversión segura.
- **Sin parches en paquetes gestionados**: No modifica el código instalado de Pi, gentle-shell ni herdr; opera exclusivamente mediante hooks oficiales del SDK.

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
| `node scripts/setup.mjs` | `npm run setup` | Configura el loader en el agente y aplica overrides de modelos. |
| `node scripts/rollback.mjs` | `npm run rollback` | Desinstala el loader y restaura la configuración original de modelos. |
| `node --test` | `npm test` | Ejecuta la suite completa de pruebas unitarias y de integración. |

---

## Requisitos y compatibilidad

- **Sistema operativo**: Verificado y soportado en Linux. No se afirma compatibilidad formal en otros sistemas operativos.
- **Node.js**: Versión `>=22.19.0` (configurada matriz de CI para Node 22 y 24; validado localmente en Node 22.23.2 con SDK 0.87.1; ejecución remota de CI pendiente tras el primer push; no se garantiza compatibilidad con todas las versiones futuras no probadas).
- **Pi Coding Agent**: Versión local/global de Pi instalada. Dependencias de desarrollo fijadas en `@earendil-works/pi-coding-agent@0.87.1` y `@earendil-works/pi-ai@0.87.1`.
- **Proveedor OmniRoute**: Configuración activa del proveedor OmniRoute en Pi con acceso a los identificadores `omniroute/antigravity/gemini-3.8-flash-tiered` y `omniroute/antigravity/gemini-3.6-flash-high`.
- **Credenciales de conversación**: Credenciales válidas para el modelo de conversación activo en Pi (por ejemplo, OpenAI en `auth.json`), requeridas por Pi para validar autenticación antes de invocar cualquier hook de compactación (la verificación previa valida autenticación, no cuota universal del proveedor).
