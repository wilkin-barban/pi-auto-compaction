# Guía de Instalación

Esta guía describe el procedimiento de instalación, verificación y despliegue inicial de **pi-auto-compaction** en un entorno de desarrollo con Pi.

---

## 1. Requisitos previos

Antes de proceder con la instalación, verifique que su entorno cumple los siguientes requisitos:

| Componente | Requisito | Notas |
|---|---|---|
| **Sistema Operativo** | Linux | Entorno validado. No se garantiza soporte formal en macOS o Windows nativo. |
| **Node.js** | `>=22.19.0` | Requerido por el SDK de Pi y los temporizadores de prueba (`MockTimers`). Matriz de CI configurada para Node 22 y 24; verificado localmente en Node 22.23.2 con SDK 0.87.1 (ejecución remota en CI pendiente del primer push; se requiere Node >= 22.19 sin garantía para todas las versiones futuras no probadas). |
| **Pi Coding Agent** | Instalación activa | Directorio de configuración por defecto: `$HOME/.pi/agent` (o variable `PI_CODING_AGENT_DIR`). |
| **Proveedor OmniRoute** | Configurado en Pi | Se requieren credenciales activas y acceso a los modelos de resumen definidos. |
| **Credenciales de conversación** | Activas en Pi | Credenciales válidas para OpenAI (o el modelo de chat activo) en `auth.json`, requeridas para validar autenticación previa al hook (la validación previa verifica credenciales de autenticación, no cuota universal del proveedor). |
| **GitHub CLI / Git** | Autenticación privada | Acceso concedido al repositorio privado `https://github.com/wilkinbarban/pi-auto-compaction`. |

---

## 2. Separación de credenciales y repositorio

El código fuente de este paquete es estrictamente privado (`UNLICENSED`).

- **Autenticación con GitHub**: Se realiza mediante `gh auth login` o claves SSH privadas asociadas a su cuenta de GitHub.
- **Credenciales de IA y modelos**: Las claves de API de OmniRoute y OpenAI **nunca** deben residir en este repositorio ni copiarse en el árbol de trabajo. Permanecen bajo la gestión exclusiva de Pi en `$HOME/.pi/agent/auth.json`.
- **Telemetría y estado**: La telemetría operativa se registra en `$HOME/.local/state/pi-auto-compaction/compaction.jsonl` (metadatos mínimos cuantificables únicamente, sin `tokensAfter` ni transcripciones; el contexto de conversación se transmite deliberadamente a la API de OmniRoute para generar el resumen). Los journals transaccionales de despliegue residen en `<install-dir>/journals/`, y el journal de recuperación de agente en `<agent-dir>/.pi-auto-compaction-state/recovery-journal.json`. La carpeta `~/.local/state/pi-auto-compaction` es exclusiva para telemetría.

---

## 3. Modelo de separación: Fuente, Releases, Loader y Manifiesto

Para garantizar que las sesiones de Pi no queden corruptas durante actualizaciones o cambios en Git, el sistema opera con cuatro capas claramente diferenciadas:

1. **Directorio de código fuente (Source Checkout)**:
   - Ruta recomendada: `$HOME/proyectos/pi-auto-compaction`.
   - Es el clon de Git donde se desarrollan cambios, se ejecutan pruebas y se gestionan dependencias.
2. **Directorio de instalación durable (Installed Releases Root)**:
   - Ruta por defecto: `$HOME/.local/share/pi-auto-compaction`.
   - Contiene releases inmutables estructurados por hash: `releases/<sha256>/`.
   - Contiene los journals transaccionales de despliegue en `journals/<lockToken>.json`.
   - Contiene el marcador de propiedad `.pi-auto-compaction-deploy.json` que registra los campos canónicos `current` (descriptor del release activo), `previous` (descriptor del release previo) y `state` (`"ready"` o `"pending"`), junto con `installDir`, `agentDir`, `kind` y `version`. (No utiliza campos como `status`, `currentRelease` ni `previousRelease`).
3. **Loader de extensión (Extension Loader)**:
   - Ruta por defecto: `$HOME/.pi/agent/extensions/omniroute-compaction.ts`.
   - Archivo TypeScript generado automáticamente que Pi carga al inicio. Importa dinámicamente el `index.mjs` del release activo actual.
4. **Manifiesto de configuración (Manifest)**:
   - Ruta por defecto: `$HOME/.pi/agent/.pi-auto-compaction-manifest.json`.
   - Registra el estado base previo a la instalación de los cuatro modelos gestionados (`gpt-6-sol` y `gpt-6.1-sol` bajo `openai` y `openai-codex`) en el campo `originalOverrides` (línea base original preservada de forma inmutable estrictamente para desinstalación, no para restaurar mientras la extensión esté instalada) y los valores gestionados esperados en `expectedManagedValues` para la detección de drift.
   - Registra el hash del loader (`loaderHash`) y coordina el journal transaccional temporal del agente en `$HOME/.pi/agent/.pi-auto-compaction-state/recovery-journal.json`.

---

## 4. Procedimiento de instalación paso a paso

### Paso 1: Clonar el repositorio privado

```bash
gh repo clone wilkinbarban/pi-auto-compaction "$HOME/proyectos/pi-auto-compaction"
cd "$HOME/proyectos/pi-auto-compaction"
```

### Paso 2: Instalar dependencias locales y ejecutar pruebas

Instale las dependencias de desarrollo sin ejecutar scripts arbitrarios de paquetes (`--ignore-scripts`) y ejecute la suite de pruebas:

```bash
npm ci --ignore-scripts
npm test
```

> **Verificación esperada**: La suite debe ejecutar y aprobar todas las pruebas unitarias y de integración (163 pruebas en el entorno de referencia) sin fallos ni cancelaciones.

### Paso 3: Simular el despliegue con `--dry-run`

Antes de realizar cambios en el sistema, verifique la validez del paquete y la compatibilidad del entorno:

```bash
node scripts/deploy.mjs --dry-run
```

El modo `--dry-run` de `deploy.mjs` es **estrictamente de solo lectura**:
- Valida la sintaxis de todos los módulos mediante `vm.SourceTextModule`.
- Comprueba que no existen dependencias no declaradas.
- Verifica permisos de usuario, ownership y ausencia de symlinks peligrosos.
- **No crea directorios, no copia archivos ni modifica archivos de configuración.**

> **Nota técnica sobre `setup.mjs --dry-run`**: Tenga en cuenta que el script directo de configuración (`setup.mjs`) crea su directorio de estado incluso cuando se ejecuta en modo dry-run. Por esta razón, se recomienda usar siempre `node scripts/deploy.mjs --dry-run`.

### Paso 4: Ejecutar el despliegue durable

Defina las rutas canónicas del agente e instalación y ejecute el despliegue inicial:

```bash
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
INSTALL_DIR="$HOME/.local/share/pi-auto-compaction"

node scripts/deploy.mjs --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
```

> **Regla de consistencia de rutas**: Si especifica un `AGENT_DIR` o `INSTALL_DIR` personalizado, asegúrese de usar esas mismas variables o rutas explícitas en todos los comandos subsiguientes (`--agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"`).

Este comando ejecuta las siguientes acciones de forma coordinada:
1. Valida que el agente no contenga loaders ni manifiestos ajenos u ocupados (si el agente ya contiene un loader o manifiesto, la instalación inicial es rechazada fail-closed).
2. Calcula el hash SHA-256 del código fuente elegible (`index.mjs`, `package.json`, `src/*.mjs`, `scripts/setup.mjs`, `scripts/rollback.mjs`).
3. Crea el directorio de release `$INSTALL_DIR/releases/<sha256>`.
4. Copia los archivos del paquete de forma atómica y verifica sus hashes con `.release.json`.
5. Registra el estado `state: "pending"` en `$INSTALL_DIR/.pi-auto-compaction-deploy.json` y escribe un journal en `$INSTALL_DIR/journals/<lockToken>.json`.
6. Invoca `setup.mjs` sobre el nuevo release, registrando `originalOverrides` y `expectedManagedValues` en el manifiesto `$AGENT_DIR/.pi-auto-compaction-manifest.json`, creando un journal temporal en `$AGENT_DIR/.pi-auto-compaction-state/recovery-journal.json` e instalando el loader en `$AGENT_DIR/extensions/omniroute-compaction.ts`.
7. Tras verificar el setup, limpia el journal del agente, marca el journal de despliegue como comprometido, transiciona el marcador a `state: "ready"` y publica el release en el campo `current`.

### Paso 5: Recargar Pi

Para que Pi detecte la nueva extensión sin reiniciar todo el entorno:

- Si tiene una sesión activa de Pi, ejecute el comando interno:
  ```text
  /reload
  ```
- Si está en la terminal, simplemente inicie Pi:
  ```bash
  pi
  ```

---

## 5. Opciones avanzadas de la CLI de despliegue

El script `scripts/deploy.mjs` proporciona control detallado sobre las rutas y modos de operación:

```text
Uso: node scripts/deploy.mjs [opciones]

Modos de ejecución (excluyentes):
  (por defecto)       Despliegue inicial exclusivo en una raíz inexistente (creada por el propio wrapper; cualquier raíz preexistente sin marcador es rechazada, incluso vacía; no ejecute mkdir primero; use --update).
  --update            Actualiza la instalación existente al hash del código fuente actual.
  --rollback-source   Revierte el release activo al release anterior registrado en `previous`. (Operación unitaria; repetirla es un no-op, no un error ni alternancia; no desinstala la extensión).

Opciones generales:
  --dry-run           Simula la operación sin escribir en disco ni alterar configuraciones.
  --source-dir DIR    Directorio del código fuente (por defecto: raíz del paquete).
  --install-dir DIR   Directorio donde residen los releases (por defecto: ~/.local/share/pi-auto-compaction).
  --agent-dir DIR     Directorio del agente Pi (por defecto: $PI_CODING_AGENT_DIR o ~/.pi/agent).
  --help              Muestra la ayuda de la CLI.
```

---

## 6. Manejo de instalaciones existentes y limitaciones de migración legacy

Por diseño y seguridad del usuario, `deploy.mjs` **nunca adopta automáticamente** un directorio preexistente ni asume el control de un agente ocupado:

1. **Raíz de instalación no gestionada rechazada**: Si `$INSTALL_DIR` ya existe pero no contiene el marcador canónico `.pi-auto-compaction-deploy.json` (por ejemplo, una instalación manual previa), `deploy.mjs` rechazará la operación con `Unmanaged install root: ownership required; legacy adoption is deferred`.
2. **Agente ocupado rechazado (`Foreign agent manifest/loader: ownership refused`)**: Si el directorio del agente (`$AGENT_DIR`) ya contiene un loader (`extensions/omniroute-compaction.ts`) o un manifiesto (`.pi-auto-compaction-manifest.json`) que no corresponde a una release activa gestionada por este wrapper (`deploy.mjs` líneas 153–154), **la operación es rechazada categóricamente, incluso si se especifica un `--install-dir` completamente nuevo**.
3. **Migración legacy NO implementada**:
   - Actualmente **no existe un procedimiento automatizado de adopción ni migración** de instalaciones planas preexistentes (como la instalación activa que opera en el entorno de desarrollo de Wilkin).
   - La instalación plana actual de Wilkin continúa funcionando intacta sin tocarse.
   - El nuevo wrapper transaccional está disponible para instalaciones en agentes limpios/vacíos (por ejemplo, en otra máquina o en un nuevo perfil de agente).
   - Cualquier migración futura requiere una decisión explícita, planificada y reconciliada de mantenimiento, acompañada de copias de seguridad manuales de la configuración y del loader existente.
   - **No elimine a ciegas el loader existente ni los archivos de estado**, y no borre marcadores ni journals para intentar forzar la adopción. No existe en este momento ningún comando CLI para adoptar la instalación activa.
4. **Retención de releases antiguos**: Durante el ciclo de vida, los releases anteriores bajo `$INSTALL_DIR/releases/` se conservan en disco de forma indefinida para permitir reversión instantánea (`--rollback-source`) y no romper procesos o subagentes de Pi que mantengan descriptores abiertos. No existe limpieza automática de releases obsoletos.
