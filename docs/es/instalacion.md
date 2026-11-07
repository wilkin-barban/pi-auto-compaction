# Guía de Instalación y Despliegue

Instala, verifica, adopta y gestiona **pi-auto-compaction** en entornos limpios o sobre configuraciones de agentes existentes.

---

## Ruta rápida (Quick Path)

Para una instalación limpia e inicial en una estación de trabajo Linux estándar:

1. **Clonar el repositorio**:
   ```bash
   git clone https://github.com/wilkin-barban/pi-auto-compaction.git "$HOME/proyectos/pi-auto-compaction"
   cd "$HOME/proyectos/pi-auto-compaction"
   ```

2. **Instalar dependencias y ejecutar pruebas**:
   ```bash
   npm ci --ignore-scripts
   npm test
   ```
   *Señal esperada*: **326 pruebas aprobadas en 33 suites**.

3. **Simular el despliegue con dry-run**:
   ```bash
   node scripts/deploy.mjs --dry-run
   ```

4. **Desplegar el release durable**:
   ```bash
   node scripts/deploy.mjs
   ```

5. **Recargar la sesión de Pi**:
   Dentro de una sesión activa de terminal en Pi, ejecuta:
   ```text
   /reload
   ```

6. **Configurar resumidores (Opcional)**:
   ```text
   /compaction
   ```

7. **Verificar estado de salud con doctor**:
   ```bash
   node scripts/doctor.mjs
   ```
   *Señal esperada*: Código de salida `0`, `healthy`.

---

## Requisitos previos (Prerequisites)

Antes de desplegar, compruebe que su entorno de ejecución cumple estos requisitos operativos:

| Componente | Requisito | Comando de verificación / Notas |
|---|---|---|
| **Sistema Operativo** | Linux | Plataforma validada. No se garantiza compatibilidad formal para macOS ni Windows nativo. |
| **Node.js** | `>=22.19.0` | `node -v` (CI valida en Node 22 y Node 24; desarrollo local en Node 22.23.2). |
| **Pi Coding Agent** | Instalación activa | Directorio predeterminado del agente: `$HOME/.pi/agent` (o `$PI_CODING_AGENT_DIR`). Compatible con Pi 1.5.0+. |
| **Credenciales del resumidor** | Configuradas en Pi | Predeterminado: OmniRoute (`omniroute/antigravity/gemini-3.8-flash-tiered`). Si se configuran otros proveedores en `/compaction`, deben tener autenticación válida en Pi. |
| **Credenciales de conversación** | Activas en `auth.json` | Las credenciales del modelo de chat activo deben ser válidas en `$HOME/.pi/agent/auth.json`. Pi comprueba la autenticación de la conversación *antes* de disparar los hooks de compactación. |
| **Git / GitHub** | Acceso al árbol de trabajo | Acceso de clonación al repositorio. |

> **Nota sobre Gentle-Shell y resolución del SDK**: Si gentle-shell es su único entorno de Pi y el loader no localiza el SDK de Pi, exporte `PI_CODING_AGENT_PATH` apuntando al directorio del paquete de Pi utilizado por gentle-shell. El resolvedor del SDK en `src/pi-sdk.mjs` comprueba el SDK local, `~/.local/lib/node_modules`, `/usr/local/lib/node_modules` y `/usr/lib/node_modules`.

---

## Rutas canónicas y variables de entorno

El wrapper de instalación gestiona cuatro capas diferenciadas:

1. **Directorio de código fuente (`$SOURCE_DIR`)**: Clon del repositorio Git (por defecto: directorio actual o `$HOME/proyectos/pi-auto-compaction`).
2. **Raíz de releases (`$INSTALL_DIR`)**: Releases inmutables versionadas bajo `$INSTALL_DIR/releases/<sha256>` y journals transaccionales bajo `$INSTALL_DIR/journals/` (por defecto: `$HOME/.local/share/pi-auto-compaction`).
3. **Directorio del agente (`$AGENT_DIR`)**: Carpeta de configuración de Pi que contiene `settings.json`, el manifiesto `.pi-auto-compaction-manifest.json` y el loader `extensions/omniroute-compaction.ts` (por defecto: `$PI_CODING_AGENT_DIR` o `$HOME/.pi/agent`).
4. **Directorio de telemetría**: `$HOME/.local/state/pi-auto-compaction/` que almacena exclusivamente `compaction.jsonl`.

### Variables de entorno soportadas

| Variable | Valor por defecto | Propósito |
|---|---|---|
| `PI_CODING_AGENT_DIR` | `$HOME/.pi/agent` | Invalida el directorio de configuración del agente Pi de destino. |
| `PI_CODING_AGENT_PATH` | No definida (autodescubrimiento) | Ruta explícita a `@earendil-works/pi-coding-agent` para hosts independientes o gentle-shell. |
| `PI_AUTO_COMPACTION_INSTALL_DIR` | `$HOME/.local/share/pi-auto-compaction` | Invalida la raíz durable de releases. |
| `PI_AUTO_COMPACTION_SETTINGS_PATH` | `$AGENT_DIR/.pi-auto-compaction-settings.json` | Ruta explícita al archivo de preferencias de resumidores. |
| `PI_AUTO_COMPACTION_PRIMARY_PROVIDER` | No definida | Invalida el proveedor del resumidor primario para entornos headless. |
| `PI_AUTO_COMPACTION_PRIMARY_MODEL` | No definida | Invalida el modelo del resumidor primario para entornos headless. |
| `PI_AUTO_COMPACTION_FALLBACK_PROVIDER` | No definida | Invalida el proveedor del resumidor de respaldo para entornos headless. |
| `PI_AUTO_COMPACTION_FALLBACK_MODEL` | No definida | Invalida el modelo del resumidor de respaldo para entornos headless. |
| `PI_AUTO_COMPACTION_SKIP_PROVIDERS` | Vacía (`""`) | Lista separada por comas de proveedores de conversación que omiten el resumen externo. |

---

## Método 1: Instalación limpia (Fresh Installation)

Utilice este método al instalar en un directorio de agente Pi limpio, sin loaders ni manifiestos preexistentes.

### Paso 1: Clonar y probar

```bash
git clone https://github.com/wilkin-barban/pi-auto-compaction.git "$HOME/proyectos/pi-auto-compaction"
cd "$HOME/proyectos/pi-auto-compaction"
npm ci --ignore-scripts
npm test
```
*Resultado esperado de las pruebas*:
```text
# tests 326
# suites 33
# pass 326
# fail 0
```

### Paso 2: Simular con `--dry-run`

```bash
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
INSTALL_DIR="${PI_AUTO_COMPACTION_INSTALL_DIR:-$HOME/.local/share/pi-auto-compaction}"

node scripts/deploy.mjs --dry-run --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
```

El dry-run realiza una verificación sintáctica estricta de todos los módulos mediante `vm.SourceTextModule`, valida las listas de archivos autorizados, comprueba la ausencia de enlaces simbólicos prohibidos y confirma ownership sin escribir ningún archivo.

### Paso 3: Ejecutar el despliegue

```bash
node scripts/deploy.mjs --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
```

**Acciones de despliegue**:
1. Crea el directorio `$INSTALL_DIR` (no debe existir previamente; no lo cree con `mkdir`).
2. Copia los archivos fuente en un directorio de release inmutable: `$INSTALL_DIR/releases/<sha256>`.
3. Valida la integridad de archivos frente a `.release.json`.
4. Escribe el marcador de despliegue `$INSTALL_DIR/.pi-auto-compaction-deploy.json` con `state: "pending"`.
5. Ejecuta `setup.mjs`, creando el loader `omniroute-compaction.ts` y el manifiesto `.pi-auto-compaction-manifest.json` en `$AGENT_DIR`.
6. Compromete el marcador de despliegue a `state: "ready"`.

### Paso 4: Recargar Pi y configurar

```text
/reload
/compaction
```

---

## Método 2: Adopción de un agente gestionado existente (`--adopt-agent`)

Utilice este método si el directorio de destino del agente ya contiene un loader oficial (`extensions/omniroute-compaction.ts`) y un manifiesto (`.pi-auto-compaction-manifest.json`) de una instalación plana anterior, y desea migrarlo a releases inmutables gestionadas.

### Invariantes de seguridad para la adopción
- **Nueva raíz de instalación obligatoria**: Debe especificar un `--install-dir` **nuevo y no existente** (por ejemplo, `$HOME/.local/share/pi-auto-compaction-managed`). Especificar una raíz no gestionada existente será rechazado fail-closed.
- **Fuente antigua preservada**: El directorio fuente referenciado en `packageSourceDir` del manifiesto anterior se mantiene intacto en disco. Nunca se sobrescribe ni se elimina.
- **Sin drift**: Los overrides de tokens en `settings.json` deben coincidir con `policies` del manifiesto.
- **Nunca borrar marcadores ni journals**: No elimine `.pi-auto-compaction-deploy.json` ni journals de recuperación para evadir la validación.

### Paso 1: Crear un snapshot seguro previo a la adopción

Antes de ejecutar la adopción, capture un respaldo seguro y aislado de la configuración del agente. No cree archivos `.bak` dentro de `$AGENT_DIR` (arriesgan fugas de permisos y contaminan el árbol del agente).

Ejecute este procedimiento de snapshot canónico:

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

> El script se conserva literal, con sus mensajes en inglés, porque es el procedimiento normativo que valida la prueba de integración del repositorio.


> **Aviso de confidencialidad**: Excluir `auth.json` evita respaldar credenciales almacenadas. No obstante, `settings.json` se respalda por completo y puede contener preferencias sensibles del usuario. Mantenga el directorio de respaldo estrictamente privado (`0700` directorio, `0600` archivos).

### Paso 2: Simular adopción con `--dry-run`

```bash
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
INSTALL_DIR="$HOME/.local/share/pi-auto-compaction-managed"

node scripts/deploy.mjs --adopt-agent --dry-run --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
```

### Paso 3: Ejecutar la adopción

```bash
node scripts/deploy.mjs --adopt-agent --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
```

### Paso 4: Verificar y recargar

```bash
node scripts/doctor.mjs --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
```
En Pi:
```text
/reload
```

---

## Método 3: Actualización de una instalación gestionada existente

Cuando se incorporan actualizaciones desde el repositorio remoto, actualice la release gestionada de forma segura:

1. **Verificar árbol de trabajo**:
   ```bash
   cd "$HOME/proyectos/pi-auto-compaction"
   git status
   ```

2. **Descargar cambios con avance rápido**:
   ```bash
   git pull --ff-only origin main
   ```

3. **Instalar dependencias y probar**:
   ```bash
   npm ci --ignore-scripts
   npm test
   ```

4. **Simular actualización**:
   ```bash
   AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
   INSTALL_DIR="${PI_AUTO_COMPACTION_INSTALL_DIR:-$HOME/.local/share/pi-auto-compaction}"

   node scripts/deploy.mjs --update --dry-run --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
   ```

5. **Aplicar actualización**:
   ```bash
   node scripts/deploy.mjs --update --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
   ```
   *Nota*: Si el hash del código es idéntico al de la release actualmente activa, el comando reporta `noop: true` y termina limpiamente sin modificar archivos.

6. **Recargar y diagnosticar**:
   ```text
   /reload
   ```
   ```bash
   node scripts/doctor.mjs --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
   ```

---

## Procedimientos de Rollback

Elija la estrategia de reversión apropiada según si necesita revertir código o remover la extensión:

| Tipo | Comando | Efecto | Estado preservado |
|---|---|---|---|
| **Rollback de fuentes** | `node scripts/deploy.mjs --rollback-source --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"` | Apunta el loader a la release inmutable previa bajo `releases/`. Operación unitaria idempotente. | Conserva los overrides en `settings.json`, preferencias de resumidores y la línea base del manifiesto. |
| **Desinstalación de configuración** | `node scripts/rollback.mjs --agent-dir "$AGENT_DIR"` | Desinstala el loader y el manifiesto; restaura la línea base original de tokens en `settings.json`. | Mantiene la raíz de releases `$INSTALL_DIR` y las carpetas históricas de release intactas en disco. |

### Límites del rollback tras adopción
- En una instalación creada mediante `--adopt-agent`, la release inicial no posee una release gestionada previa (`previous: null`). Ejecutar `--rollback-source` inmediatamente después de la adopción es un no-op limpio (`noop: true`).
- **Reversión a la fuente antigua**: Requiere ejecutar el setup desde el directorio de la fuente antigua:
  ```bash
  OLD_SOURCE_DIR="${OLD_SOURCE_DIR:-$HOME/.local/share/pi-auto-compaction}"
  node "$OLD_SOURCE_DIR/scripts/setup.mjs" --source-dir "$OLD_SOURCE_DIR" --target-dir "$AGENT_DIR"
  ```
  *Aviso de Metadata DESYNC*: Ejecutar el setup desde la fuente antigua revierte el loader del agente, pero deja `$INSTALL_DIR/.pi-auto-compaction-deploy.json` en `state: "ready"`. Las llamadas subsiguientes a `--update` fallarán con `Agent manifest source ownership mismatch`. Reconcilie manualmente; nunca borre marcadores ni journals.

---

## Lista de comprobación de verificación (Verification Checklist)

Confirme que su despliegue fue completamente exitoso verificando cada señal:

- [ ] **Pruebas aprobadas**: `npm test` reporta 326 pruebas en 33 suites con 0 fallos.
- [ ] **Marcador de despliegue creado**: `$INSTALL_DIR/.pi-auto-compaction-deploy.json` contiene `"state": "ready"`.
- [ ] **Directorio de release creado**: `$INSTALL_DIR/releases/<sha256>/.release.json` contiene `"version": 1`.
- [ ] **Loader instalado**: `$AGENT_DIR/extensions/omniroute-compaction.ts` importa dinámicamente el release activo.
- [ ] **Manifiesto v2 creado**: `$AGENT_DIR/.pi-auto-compaction-manifest.json` contiene `"version": "2.0.0"`.
- [ ] **Doctor saludable**: `npm run doctor` sale con código `0` y reporta `healthy`.
- [ ] **Comando disponible**: Dentro de Pi, `/compaction` abre el selector de modelos.
- [ ] **Barra de estado actualizada**: El pie de Pi muestra `Compaction: <provider>/<modelId>`.

---

## Próximos pasos

- Revisar la arquitectura y detalles del ciclo de vida: [`docs/es/arquitectura.md`](arquitectura.md)
- Automatizar la instalación usando un agente de IA: [`docs/es/instalacion-agente.md`](instalacion-agente.md)
- Aprender el mantenimiento rutinario y la recuperación de journals: [`docs/es/mantenimiento.md`](mantenimiento.md)
- Consultar procedimientos de resolución de problemas: [`docs/es/solucion-de-problemas.md`](solucion-de-problemas.md)
