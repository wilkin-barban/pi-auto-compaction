# Guía de Instalación

Esta guía describe el procedimiento de instalación, verificación y despliegue inicial de **pi-auto-compaction** en un entorno de desarrollo con Pi.

---

## 1. Requisitos previos

Antes de proceder con la instalación, verifique que su entorno cumple los siguientes requisitos:

| Componente | Requisito | Notas |
|---|---|---|
| **Sistema Operativo** | Linux | Entorno validado. No se garantiza soporte formal en macOS o Windows nativo. |
| **Node.js** | `>=22.19.0` | Requerido por el SDK de Pi y los temporizadores de prueba (`MockTimers`). Matriz de CI para Node 22 y 24; validado localmente en Node 22.23.2 con SDK 0.87.1 y smoke de Pi 1.5.0 en CI; se requiere Node >= 22.19 sin garantía para todas las versiones futuras no probadas. |
| **Pi Coding Agent** | Instalación activa | Directorio de configuración por defecto: `$HOME/.pi/agent` (o variable `PI_CODING_AGENT_DIR`). En gentle-shell, el home de Pi es el mismo y el loader se instala en `extensions/omniroute-compaction.ts`. |
| **Proveedor del resumidor** | Configurado en Pi | Por defecto OmniRoute con `omniroute/antigravity/gemini-3.8-flash-tiered` y `omniroute/antigravity/gemini-3.6-flash-high`; si elegís otro modelo en `/compaction`, alcanza con que ese provider tenga credenciales y el modelo esté disponible. |
| **Credenciales de conversación** | Activas en Pi | Credenciales válidas para el modelo de chat activo (OpenAI, DeepSeek/Command Code, Gemini, etc.) en `auth.json`, requeridas para validar autenticación previa al hook (la validación previa verifica credenciales de autenticación, no cuota universal del proveedor). |
| **GitHub CLI / Git** | Autenticación privada | Acceso concedido al repositorio privado `https://github.com/wilkinbarban/pi-auto-compaction`. |

> **Nota para gentle-shell**: si es la única instalación de Pi y el loader no resuelve el SDK, definí `PI_CODING_AGENT_PATH` apuntando al paquete de Pi que usa gentle-shell o instalá Pi global. El resolvedor de `src/pi-sdk.mjs` prueba el SDK local, `~/.local/lib/node_modules`, `/usr/local/lib/node_modules` y `/usr/lib/node_modules`.

---

## 2. Separación de credenciales y repositorio

El código fuente de este paquete es estrictamente privado (`UNLICENSED`).

- **Autenticación con GitHub**: Se realiza mediante `gh auth login` o claves SSH privadas asociadas a su cuenta de GitHub.
- **Credenciales de IA y modelos**: Las claves de API del proveedor del resumidor (OmniRoute por defecto) y del proveedor de conversación (OpenAI, DeepSeek/Command Code, Gemini, etc.) **nunca** deben residir en este repositorio ni copiarse en el árbol de trabajo. Permanecen bajo la gestión exclusiva de Pi en `$HOME/.pi/agent/auth.json`.
- **Telemetría y estado**: La telemetría operativa se registra en `$HOME/.local/state/pi-auto-compaction/compaction.jsonl` (metadatos mínimos cuantificables únicamente, sin `tokensAfter` ni transcripciones; el contexto de conversación se transmite deliberadamente a la API del proveedor del resumidor configurado (OmniRoute por defecto) para generar el resumen). Los journals transaccionales de despliegue residen en `<install-dir>/journals/`, y el journal de recuperación de agente en `<agent-dir>/.pi-auto-compaction-state/recovery-journal.json`. La carpeta `~/.local/state/pi-auto-compaction` es exclusiva para telemetría.

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
   - Registra el estado base previo de los **ocho modelos gestionados** en el campo `originalOverrides` (línea base original preservada de forma inmutable estrictamente para desinstalación, no para restaurar mientras la extensión esté instalada) y las **políticas por modelo** en `policies` (manifiesto v2) para la detección de drift. Los manifiestos v1 de cuatro modelos se migran a v2 preservando `originalOverrides`.
   - Registra el hash del loader (`loaderHash`) y coordina el journal transaccional temporal del agente en `$HOME/.pi/agent/.pi-auto-compaction-state/recovery-journal.json`.
5. **Configuración de modelos de compactación (Summarizer Settings)**:
   - Ruta por defecto: `$HOME/.pi/agent/.pi-auto-compaction-settings.json` (o `$AGENT_DIR/.pi-auto-compaction-settings.json`).
   - Archivo opcional e independiente que almacena las preferencias de modelos elegidos para la autocompactación. Es completamente independiente de `settings.json`, nunca lo modifica y no requiere intervención manual. Si no existe, la extensión opera con los modelos predeterminados.

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

> **Verificación esperada**: La suite debe ejecutar y aprobar todas las pruebas unitarias y de integración sin fallos ni cancelaciones. La referencia actual es **326 pruebas en 33 suites**; el número exacto lo imprime `npm test` y también queda registrado en `repository-evidence.md`.

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

> **Nota sobre `setup.mjs --dry-run`**: Tanto `deploy.mjs` como `setup.mjs` y `rollback.mjs` son de solo lectura en `--dry-run`; no crean el directorio de estado. Aun así, se recomienda usar `node scripts/deploy.mjs --dry-run` porque valida el paquete completo, la allowlist de archivos y el release antes de escribir.

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
6. Invoca `setup.mjs` sobre el nuevo release, registrando `originalOverrides` y `policies` en el manifiesto `$AGENT_DIR/.pi-auto-compaction-manifest.json`, creando un journal temporal en `$AGENT_DIR/.pi-auto-compaction-state/recovery-journal.json` e instalando el loader en `$AGENT_DIR/extensions/omniroute-compaction.ts`.
7. Tras verificar el setup, limpia el journal del agente, marca el journal de despliegue como comprometido, transiciona el marcador a `state: "ready"` y publica el release en el campo `current`.

### Verificación del estado efectivo

Ejecutá el diagnóstico de solo lectura antes de recargar:

```bash
npm run doctor -- --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
```

Debe reportar `healthy`, exit `0`, y el umbral efectivo de cada modelo. `doctor` muestra la ruta del archivo, el origen y los modelos efectivos del resumidor. Si aparece una advertencia con `DeepSeek 860000 → 14%`, el override viejo sigue presente y el deploy no aplicó la política nueva.

### Paso 5: Recargar Pi

Para que Pi detecte la nueva extensión y sus comandos sin reiniciar todo el entorno:

- Si tiene una sesión activa de Pi, ejecute el comando interno:
  ```text
  /reload
  ```
- Si está en la terminal, simplemente inicie Pi:
  ```bash
  pi
  ```

### Paso 6: Configurar el modelo de compactación (`/compaction`)

Una vez recargada la sesión, ejecutá el comando interactivo:

```text
/compaction
```

Este comando abre el panel para elegir el modelo primario y el modelo de respaldo de la autocompactación a partir de los modelos de chat autorizados en el harness.

- **Selector interactivo con búsqueda y scroll real**: En interfaces TUI, `/compaction` proporciona un selector con scroll dinámico (`SelectList`), navegación por teclado (`↑↓`, `PgUp/PgDn`, `Home/End`, `Enter`, `Esc`), rueda del ratón y búsqueda incremental instantánea para explorar con soltura catálogos de más de 100 modelos. En entornos sin UI interactiva se recurre al fallback plano `ui.select`.
- **Configuración manual (workaround)**: También podés definir los modelos de compactación sin usar la TUI editando directamente `$AGENT_DIR/.pi-auto-compaction-settings.json` o exportando las variables de entorno `PI_AUTO_COMPACTION_PRIMARY_PROVIDER`, `PI_AUTO_COMPACTION_PRIMARY_MODEL`, `PI_AUTO_COMPACTION_FALLBACK_PROVIDER`, `PI_AUTO_COMPACTION_FALLBACK_MODEL`, seguido de `/reload` y verificación con `doctor`.
- **Archivo de configuración separado y opcional**: La selección se guarda en `$AGENT_DIR/.pi-auto-compaction-settings.json` (o `$HOME/.pi/agent/.pi-auto-compaction-settings.json`, configurable mediante `PI_AUTO_COMPACTION_SETTINGS_PATH`). Este archivo es **completamente opcional e independiente de `settings.json`**. La extensión nunca escribe ni modifica `settings.json` al configurar o guardar resumidores.
- **Valores por defecto**: Si el archivo de configuración no existe, la extensión opera normalmente con los modelos por defecto sin advertencias ni interrupciones.
- **Diagnóstico con `doctor`**: Podés verificar en cualquier momento el estado de la configuración ejecutando `npm run doctor`, el cual muestra la ruta del archivo, el origen y los modelos efectivos.

---

## 5. Opciones avanzadas de la CLI de despliegue

El script `scripts/deploy.mjs` proporciona control detallado sobre las rutas y modos de operación:

```text
Uso: node scripts/deploy.mjs [opciones]

Modos de ejecución (mutuamente excluyentes):
  (por defecto)       Despliegue inicial exclusivo en una raíz inexistente y agente limpio (creada por el propio wrapper; cualquier raíz preexistente sin marcador es rechazada, incluso vacía; no ejecute mkdir primero; use --update).
  --update            Actualiza la instalación existente al hash del código fuente actual.
  --rollback-source   Revierte el release activo al release anterior registrado en `previous`. (Operación unitaria; repetirla es un no-op, no un error ni alternancia; no desinstala la extensión).
  --adopt-agent       Adopta un agente previamente gestionado con manifiesto y loader válidos en una raíz gestionada nueva inexistente, preservando la línea base original y la fuente antigua intacta.

Opciones generales:
  --dry-run           Simula la operación sin escribir en disco ni alterar configuraciones.
  --source-dir DIR    Directorio del código fuente (por defecto: raíz del paquete).
  --install-dir DIR   Directorio donde residen los releases (por defecto: ~/.local/share/pi-auto-compaction).
  --agent-dir DIR     Directorio del agente Pi (por defecto: $PI_CODING_AGENT_DIR o ~/.pi/agent).
  --help              Muestra la ayuda de la CLI.
```

---

## 6. Manejo de instalaciones existentes y adopción controlada (`--adopt-agent`)

Por diseño y seguridad del usuario, `deploy.mjs` nunca asume el control de un agente ni adopta directorios de forma desatendida o silenciosa:

1. **Rechazo por defecto de raíces no gestionadas y agentes ocupados**:
   - Si `$INSTALL_DIR` ya existe pero no contiene el marcador canónico `.pi-auto-compaction-deploy.json` (por ejemplo, una instalación plana previa), `deploy.mjs` rechazará la operación con `Unmanaged install root: ownership required; legacy adoption is deferred`.
   - Si el directorio del agente (`$AGENT_DIR`) ya contiene un loader (`extensions/omniroute-compaction.ts`) o un manifiesto (`.pi-auto-compaction-manifest.json`) y **no** se suministra la bandera explícita `--adopt-agent`, la operación es rechazada categóricamente (`Foreign agent manifest/loader: ownership refused`).

2. **Procedimiento de adopción mediante `--adopt-agent`**:
   Para migrar un agente existente previamente gestionado por `pi-auto-compaction` hacia la estructura de releases inmutables gestionadas, utilice `--adopt-agent`. A diferencia del despliegue inicial en raíz limpia (cuyo valor por defecto en la CLI es `$HOME/.local/share/pi-auto-compaction`), la adopción exige explícitamente una ruta gestionada nueva que no colisione con instalaciones planas existentes:

   ```bash
   AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
   INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/share/pi-auto-compaction-managed}"

   node scripts/deploy.mjs --adopt-agent --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
   ```

3. **Prerrequisitos y guardias de validación de adopción**:
   - **Agente previamente gestionado y válido**: Requiere que existan tanto el manifiesto `.pi-auto-compaction-manifest.json` como el loader oficial `extensions/omniroute-compaction.ts`. No se permite adoptar agentes con archivos desconocidos o sin manifiesto.
   - **Integridad de hash y esquema**: El hash del loader debe coincidir con `loaderHash` del manifiesto, aceptar la versión `1.0.0` (se migra a v2) o `2.0.0`, incluir la política de los ocho modelos gestionados y la estructura estricta de `originalOverrides`/`policies`.
   - **Ausencia de drift**: Los valores de tokens en `settings.json` deben coincidir con la política del modelo en `policies` (o con los valores v1 equivalentes). Si hubo modificaciones externas no registradas, la adopción es rechazada fail-closed.
   - **Sin bloqueos ni journals activos**: No debe haber `.pi-auto-compaction.lock` ni `recovery-journal.json` pendientes en el agente.
   - **Raíz de instalación nueva e inexistente**: El `--install-dir` destino debe ser una ruta **nueva que no exista previamente**. Si el directorio ya existe, se rechaza inmediatamente para evitar colisiones.
   - **Fuente antigua intacta y válida**: La fuente referenciada en `packageSourceDir` del manifiesto previo debe existir, tener metadatos válidos de paquete (`name: "pi-auto-compaction"`) y scripts de setup/rollback. Esta fuente antigua **se conserva intacta en disco y nunca se modifica ni elimina**, permitiendo que sesiones activas sigan operando y sirviendo de respaldo de seguridad.
   - **Rutas canónicas y libres de symlinks inseguros**: No se permiten enlaces simbólicos en las rutas del agente, instalación, fuente ni fuente adoptada, ni solapamientos entre ellas.

4. **Copia de seguridad previa recomendada (Snapshot seguro)**:
   Antes de ejecutar la adopción, es imperativo realizar un snapshot privado y seguro del agente. Crear copias superficiales reutilizables como `settings.json.bak` dentro de `$AGENT_DIR` es **inseguro**: nombres fijos provocan sobreescrituras accidentales de la línea base, la máscara de permisos (`umask`) por defecto puede filtrar datos a otros usuarios, no se rechazan symlinks y se contamina el directorio del agente.

   En su lugar, utilice un procedimiento canónico que cree un directorio exclusivo e irrepetible fuera de Git y del agente, con permisos restrictivos (0700 en directorios, 0600 en archivos), respete `$AGENT_DIR`, rechace enlaces simbólicos en toda la cadena de directorios ancestros, falle de forma cerrada si falta cualquiera de los archivos requeridos, y respalde los tres archivos de configuración gestionados.

   > **Aviso de confidencialidad y contenido de configuración**: Excluir `auth.json` previene respaldar los tokens de autenticación almacenados allí. No obstante, `settings.json` se respalda de forma completa y puede contener opciones privadas, claves de API personalizadas u otras configuraciones sensibles definidas por el usuario. Excluir `auth.json` **no equivale ni garantiza la ausencia total de secretos** en `settings.json`. Por ello, el directorio de respaldo debe mantenerse estrictamente privado (0700/0600) bajo `$HOME`.

   **Script canónico en Python (procedimiento de snapshot único)**:
   ```python
   import os, sys, tempfile, stat, hashlib

   def get_current_uid():
       return os.getuid() if hasattr(os, "getuid") else None

   def verify_path_ancestors(target_path, home_path):
       current_uid = get_current_uid()
       absolute = os.path.abspath(target_path)
       real_home = os.path.abspath(home_path) if home_path else None
       cursor = os.path.splitdrive(absolute)[0] + os.sep
       parts = [p for p in absolute[len(cursor):].split(os.sep) if p]

       for part in parts:
           cursor = os.path.join(cursor, part)
           if not os.path.lexists(cursor):
               break
           st = os.lstat(cursor)
           if stat.S_ISLNK(st.st_mode):
               sys.exit(f"Error de seguridad: ancestro o ruta {cursor} es un enlace simbólico; abortando.")
           if current_uid is not None:
               is_under_home = real_home and (cursor == real_home or cursor.startswith(real_home + os.sep))
               if is_under_home:
                   if st.st_uid != current_uid:
                       sys.exit(f"Error de seguridad: {cursor} dentro de HOME pertenece a UID {st.st_uid} (se requiere UID actual {current_uid}); abortando.")
               else:
                   if st.st_uid != 0 and st.st_uid != current_uid:
                       sys.exit(f"Error de seguridad: ancestro del sistema {cursor} pertenece a UID {st.st_uid} (se permite root 0 o {current_uid}); abortando.")
       return absolute

   home_dir = os.environ.get("HOME") or os.path.expanduser("~")
   agent_dir = os.environ.get("AGENT_DIR") or os.environ.get("PI_CODING_AGENT_DIR") or os.path.join(home_dir, ".pi", "agent")
   base_backup_dir = os.path.join(home_dir, ".local", "state", "pi-auto-compaction-backups")

   # 1. Verificar ancestros antes de cualquier mkdir o chmod
   verify_path_ancestors(agent_dir, home_dir)
   verify_path_ancestors(os.path.dirname(base_backup_dir), home_dir)

   current_uid = get_current_uid()

   # 2. Asegurar directorio base privado (0700) bajo HOME; rehusar si pertenece a otro UID o es symlink
   if os.path.lexists(base_backup_dir):
       st = os.lstat(base_backup_dir)
       if stat.S_ISLNK(st.st_mode):
           sys.exit(f"Error de seguridad: directorio base {base_backup_dir} es un enlace simbólico; abortando.")
       if not stat.S_ISDIR(st.st_mode):
           sys.exit(f"Error de seguridad: directorio base {base_backup_dir} no es un directorio; abortando.")
       if current_uid is not None and st.st_uid != current_uid:
           sys.exit(f"Error de seguridad: directorio base {base_backup_dir} pertenece a otro usuario (UID {st.st_uid}); abortando sin alterar permisos.")
       if (st.st_mode & 0o777) != 0o700:
           os.chmod(base_backup_dir, 0o700)
   else:
       os.makedirs(base_backup_dir, mode=0o700, exist_ok=True)
       os.chmod(base_backup_dir, 0o700)

   verify_path_ancestors(base_backup_dir, home_dir)

   # 3. Crear directorio exclusivo e irrepetible para este snapshot pre-adopción
   backup_dir = tempfile.mkdtemp(prefix="pre-migration-", dir=base_backup_dir)
   os.chmod(backup_dir, 0o700)

   # 4. Snapshot de archivos gestionados (falla cerrado si falta cualquiera, symlink, hardlink o UID ajeno)
   targets = [
       ("settings.json", os.path.join(agent_dir, "settings.json")),
       (".pi-auto-compaction-manifest.json", os.path.join(agent_dir, ".pi-auto-compaction-manifest.json")),
       ("omniroute-compaction.ts", os.path.join(agent_dir, "extensions", "omniroute-compaction.ts")),
   ]

   metadata = []
   for name, src in targets:
       verify_path_ancestors(src, home_dir)
       if not os.path.lexists(src):
           sys.exit(f"Error: archivo requerido {src} no existe; abortando snapshot fail-closed.")
       st = os.lstat(src)
       if stat.S_ISLNK(st.st_mode):
           sys.exit(f"Error de seguridad: archivo requerido {src} es un enlace simbólico; abortando.")
       if not stat.S_ISREG(st.st_mode):
           sys.exit(f"Error de seguridad: archivo requerido {src} no es un archivo regular; abortando.")
       if current_uid is not None and st.st_uid != current_uid:
           sys.exit(f"Error de seguridad: archivo {src} pertenece a UID {st.st_uid} (se requiere UID actual {current_uid}); abortando.")
       if st.st_nlink != 1:
           sys.exit(f"Error de seguridad: archivo {src} tiene enlaces duros adicionales (nlink={st.st_nlink}); abortando.")

       dst = os.path.join(backup_dir, name)
       fd_dst = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
       hasher = hashlib.sha256()
       with open(src, "rb") as f_src, os.fdopen(fd_dst, "wb") as f_dst:
           while chunk := f_src.read(65536):
               hasher.update(chunk)
               f_dst.write(chunk)
       os.chmod(dst, 0o600)
       metadata.append(f"{name}: {hasher.hexdigest()} ({os.path.getsize(dst)} bytes)")

   print(f"BACKUP_DIR={backup_dir}")
   print("Snapshot privado completado exitosamente:")
   for item in metadata:
       print(f"  - {item}")
   ```

   *Garantías*: No se realiza limpieza de la raíz del sistema ni del backup; el backup queda aislado y listo para contingencias.


5. **Límites de rollback tras adopción y reversión controlada**:
   - **No-op en el primer release adoptado**: En la primera release adoptada, el marcador se inicializa con `previous: null`. En consecuencia, ejecutar `node scripts/deploy.mjs --rollback-source --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"` sobre este release es un no-op limpio y documentado (`noop: true`), el cual requiere sus flags explícitos de ruta.
   - **Rollback operativo en actualizaciones subsiguientes**: Tras aplicar un nuevo despliegue con `--update` sobre el agente adoptado, `--rollback-source` opera normalmente permitiendo revertir al release gestionado previo.
   - **Compensación ante fallos de adopción**: Si la adopción falla antes de publicar el release, la lógica de compensación con guardas CAS restaura de forma byte-exacta el estado inicial del agente sin pisar mutaciones concurrentes de terceros. Sin embargo, estas guardas protegen la consistencia lógica y de concurrencia, sin prometer recuperación atómica universal ante cortes catastróficos del sistema operativo o terminación abrupta del proceso (`kill -9`).
   - **Procedimiento de reversión a la fuente antigua plana (Rollback de operador)**:
     Para revertir la adopción y volver al código plano original que utilizaba el agente:
     1. **Identificar la ruta real de la fuente previa**: Tenga en cuenta que *tras* una adopción exitosa, el campo `packageSourceDir` del manifiesto del agente apunta a la nueva release gestionada (`$INSTALL_DIR/releases/<sha256>`). El operador debe comprobar la ruta de la fuente previa antes de iniciar la reversión, consultando el snapshot de metadatos o definiendo la variable de entorno correspondiente:
        ```bash
        OLD_SOURCE_DIR="${OLD_SOURCE_DIR:-$HOME/.local/share/pi-auto-compaction}"
        ```
        (Ajustable para otros directorios personales; no se asume una ruta codificada de forma universal).
     2. **Ejecutar el instalador de la fuente antigua**:
        ```bash
        node "$OLD_SOURCE_DIR/scripts/setup.mjs" --source-dir "$OLD_SOURCE_DIR" --target-dir "$AGENT_DIR"
        ```
        **Requisitos**: Requiere propiedad gestionada válida, ausencia de drift en `settings.json`, ausencia de bloqueos o journals pendientes y contar con la copia de seguridad. **Si existe un journal pendiente, el instalador se detiene inmediatamente; nunca lo eluda ni fuerce**.
     3. **Advertencia crítica de desincronización de metadatos (Metadata DESYNC)**:
        La ejecución de `setup.mjs` de la fuente antigua restaura el loader y el manifiesto del agente para apuntar a `$OLD_SOURCE_DIR`. Sin embargo, el marcador del wrapper en `$INSTALL_DIR/.pi-auto-compaction-deploy.json` permanece en estado `"ready"` referenciando la release gestionada.
        Esto produce una **desincronización de metadatos**: futuros intentos de ejecutar `node scripts/deploy.mjs --update` rechazarán la operación (`Agent manifest source ownership mismatch`, no el error genérico `Foreign agent manifest/loader: ownership refused`) debido a que el agente ya no apunta a la release gestionada activa.
        **ALTO**: No intente resolver esta situación borrando marcadores a ciegas ni inventando banderas ficticias en disco. Un procedimiento de reconciliación automática posterior **NO está implementado** en la versión actual y requerirá una intervención manual explícita.
     4. **Retención de fuentes**: Tanto la fuente antigua plana como los releases gestionados deben conservarse intactos hasta que todas las sesiones de Pi hayan sido recargadas.
   - **Reinstalación tras rollback de configuración**: La reinstalación de la extensión tras ejecutar `rollback.mjs` (desinstalación completa de configuración) sigue sin estar implementada en este paquete y no forma parte del alcance de esta corrección.

6. **Recarga obligatoria de sesiones**:
   Tras la adopción exitosa, el loader oficial del agente apuntará al nuevo release bajo `$INSTALL_DIR/releases/<sha256>`. Para que las sesiones activas utilicen el nuevo código, ejecute `/reload` en cada sesión de Pi o inicie nuevas terminales.

7. **Retención de releases y fuentes antiguas**:
   Tanto los releases creados bajo `$INSTALL_DIR/releases/` como la fuente antigua plana permanecen indefinidamente en disco; no existe purga automática para no invalidar descriptores de archivos de procesos en curso.
