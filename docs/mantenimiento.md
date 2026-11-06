# Guía de Mantenimiento y Actualizaciones

Esta guía detalla las operaciones rutinarias de mantenimiento, el ciclo seguro de actualización de código, las estrategias de reversión (rollback) y la resolución de incidentes de sincronización o drift.

---

## 1. Ciclo seguro de actualización

Para actualizar **pi-auto-compaction** cuando se incorporan cambios en el repositorio remoto, siga estrictamente esta secuencia en el directorio de trabajo del código fuente:

### Paso 1: Verificar que el árbol de trabajo esté limpio

```bash
cd "$HOME/proyectos/pi-auto-compaction"
git status
```

No proceda si existen modificaciones sin confirmar o archivos sin seguimiento que puedan interferir con la actualización.

Para todas las operaciones de despliegue y mantenimiento, defina las variables canónicas de entorno para su agente e instalación (especificando la raíz gestionada elegida, por ejemplo `$HOME/.local/share/pi-auto-compaction` o `$HOME/.local/share/pi-auto-compaction-managed`):

```bash
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
INSTALL_DIR="${PI_AUTO_COMPACTION_INSTALL_DIR:-$HOME/.local/share/pi-auto-compaction}"
```

Asegúrese de mantener estas mismas variables o rutas consistentes en todos los comandos subsiguientes (`--agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"`).

### Paso 2: Descargar cambios sin merges divergentes

```bash
git pull --ff-only origin main
```

El uso de `--ff-only` previene la creación accidental de commits de merge que ensucien el historial del árbol de desarrollo.

### Paso 3: Sincronizar dependencias locales

```bash
npm ci --ignore-scripts
```

Garantiza que el árbol `node_modules/` coincida exactamente con el archivo de bloqueo `package-lock.json` sin ejecutar scripts de terceros.

### Paso 4: Ejecutar la suite de pruebas completa

```bash
npm test
```

> **Regla de oro**: Si alguna prueba falla, **no continúe con el despliegue**. El entorno actual no debe actualizarse hasta que la causa raíz sea diagnosticada y resuelta en un entorno controlado.

### Paso 5: Validar la actualización con `--dry-run`

```bash
node scripts/deploy.mjs --update --dry-run --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
# o:
npm run deploy -- --update --dry-run --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
```

Este comando verifica:
- La integridad sintáctica de todos los módulos bajo `src/`.
- Que el hash del nuevo código difiere de la versión instalada (o confirma un no-op limpio).
- Que el directorio de releases destino y el agente Pi conservan el ownership y manifest correctos.

### Paso 6: Aplicar la actualización

```bash
node scripts/deploy.mjs --update --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
# o:
npm run deploy -- --update --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
```

**Comportamiento de optimización (No-op por hash)**:
Si el código fuente actual no presenta cambios respecto al release actualmente activo, `deploy.mjs` informa que la versión ya está instalada y termina sin modificar el loader, los manifiestos ni los archivos de configuración.

Tras aplicar la actualización, verificá el estado efectivo:

```bash
npm run doctor -- --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
```

Debe reportar `healthy`, exit `0`, con la política de los ocho modelos y sin advertencias.

### Paso 7: Recargar Pi

Dentro de cualquier sesión activa de Pi:

```text
/reload
```

---

## 2. Estrategias de Rollback: Código vs. Configuración

Existen dos tipos fundamentales de reversión en el sistema. Es crucial entender su diferencia:

| Tipo | Comando | Propósito | Qué modifica | Qué preserva |
|---|---|---|---|---|
| **Rollback de Código (Source Rollback)** | `node scripts/deploy.mjs --rollback-source --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"` | Revertir el código de la extensión al release inmutable previo si se detecta un error en runtime. | Actualiza el loader para apuntar a `releases/<sha256-anterior>`. En el marcador, `current` pasa a ser el anterior y `previous` queda en null. | Preserva intactos los overrides de tokens en `settings.json` y la línea base `originalOverrides` en el manifiesto (setup actualiza los metadatos de fuente y `loaderHash`). NO es una desinstalación. |
| **Rollback de Configuración (Uninstall)** | `node scripts/rollback.mjs --target-dir "$AGENT_DIR"` | Desinstalar la extensión del agente Pi y restaurar la configuración original de los modelos desde `originalOverrides`. | Elimina el loader `omniroute-compaction.ts` y el manifiesto `.pi-auto-compaction-manifest.json` del agente; restaura los valores base de `settings.json`. | Conserva el directorio de instalación `$INSTALL_DIR`, los releases históricos bajo `releases/` y el marcador `.pi-auto-compaction-deploy.json`. |

### Detalle del Rollback de Código (`--rollback-source`)

- **Operación unitaria idempotente (no basculante)**: Revierte estrictamente a la versión registrada en el campo `previous`. Si se ejecuta una segunda vez consecutiva, el comando detecta que `target.hash === current.hash` y concluye como un **no-op limpio exitoso** (`noop: true`); no genera error ni actúa como un interruptor de vaivén.
- **Inmutabilidad y retención de releases**: No reconstruye ni recompila archivos. Apunta el loader al directorio del release anterior cuya validez ya fue verificada. Los releases anteriores en `$INSTALL_DIR/releases/` se conservan en disco; no existe limpieza automática de código fuente antiguo para no romper procesos activos con descriptores abiertos.
- **Preservación del baseline y configuración**: Preserva la línea base `originalOverrides` en el manifiesto y los overrides de tokens en `settings.json` (el subproceso setup actualiza los metadatos de la fuente y `loaderHash` para la release activa, sin alterar la configuración de modelos ni eliminar la línea base). El rollback de código NO es una desinstalación.
- **Límites de rollback tras adopción (`--adopt-agent`)**: En una instalación originada por adopción de un agente preexistente en una nueva raíz gestionada, el release inicial adoptado no posee una release gestionada previa registrada (`previous: null`). En consecuencia, ejecutar `--rollback-source --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"` resulta en un **no-op limpio** (`noop: true`) con sus rutas explícitas requeridas; no ejecute comandos sin flags de ruta si usó una raíz gestionada personalizada.
  - **Reversión a fuente antigua mediante setup oficial**: Para revertir la adopción y volver al código plano previo, se debe ejecutar directamente el instalador oficial de la fuente antigua preservada:
    ```bash
    OLD_SOURCE_DIR="${OLD_SOURCE_DIR:-$HOME/.local/share/pi-auto-compaction}"
    node "$OLD_SOURCE_DIR/scripts/setup.mjs" --source-dir "$OLD_SOURCE_DIR" --target-dir "$AGENT_DIR"
    ```
    *Comprobación previa obligatoria*: Tenga en cuenta que tras la adopción, el manifiesto del agente apunta a la release nueva (`$INSTALL_DIR/releases/...`); verifique la ruta real de la fuente antigua en su registro de respaldo antes de invocar la reversión. Este comando requiere que el agente no presente drift en campos gestionados, no existan bloqueos ni journals pendientes y se cuente con un snapshot seguro previo. **Si existe un journal pendiente, el comando se detiene por seguridad; nunca lo eluda ni fuerce**.
  - **Aviso de desincronización de metadatos (Metadata DESYNC)**: Restaurar el agente con el setup de la fuente antigua deja el loader y manifiesto del agente apuntando a `$OLD_SOURCE_DIR`, pero el marcador del wrapper `$INSTALL_DIR/.pi-auto-compaction-deploy.json` permanece en estado `"ready"` apuntando a la release gestionada. Esto produce una desincronización que hará que cualquier futuro `node scripts/deploy.mjs --update` rechace la ejecución (`Agent manifest source ownership mismatch`, no el error genérico `Foreign agent manifest/loader: ownership refused`). **ALTO**: No borre el marcador ni intente trucos manuales; la reconciliación automatizada no está implementada y requiere atención manual explícita. Ambas raíces (antigua y gestionada) deben conservarse intactas hasta recargar todas las sesiones de Pi.
  - **Rollback en actualizaciones posteriores**: Si tras la adopción se aplicó una nueva actualización (`--update`), `--rollback-source` funciona normalmente permitiendo regresar al release inicial adoptado.
  - **Compensación ante fallos de adopción y semántica de recibos**: Durante la adopción, si falla el setup o la publicación, la compensación valida estrictamente los hashes del recibo de intención del escritor (`trusted-writer intent receipt`) emitido antes de cualquier escritura. Si el manifiesto o los archivos del agente difieren de los hashes sellados en el recibo o sufrieron mutaciones concurrentes foráneas, la compensación rehúsa sobreescribirlos, preserva los bytes foráneos de forma determinista y retiene el journal y marcador en estado `pending`, sin prometer atomicidad universal ante caídas catastróficas del sistema operativo (`kill -9`).

### Detalle de la Desinstalación de Configuración (`rollback.mjs`)

- **Restauración exacta desde `originalOverrides`**: Lee `.pi-auto-compaction-manifest.json` y restaura los campos `reserveTokens` y `keepRecentTokens` de los modelos gestionados exactamente al valor numérico o estado ausente que tenían originalmente en la línea base capturada al instalar.
- **Preservación de configuraciones ajenas**: Todos los demás campos de `settings.json` modificados por el usuario o por otras extensiones permanecen completamente intactos.
- **Compensación transaccional**: Si la desinstalación experimenta un error a mitad del proceso, compensa en orden inverso para dejar el sistema en un estado coherente.
- **Advertencia crítica sobre reinstalación posterior**: Al ejecutar `rollback.mjs`, se eliminan el loader y el manifiesto del agente (`$AGENT_DIR`), pero **se conserva el marcador `.pi-auto-compaction-deploy.json` y las releases en `$INSTALL_DIR`**. Si posteriormente intenta ejecutar `node scripts/deploy.mjs`, la instalación inicial fallará cerrado porque el marcador ya existe en `$INSTALL_DIR` (`Managed install already exists; use --update`), y `deploy.mjs --update` fallará porque el agente ya no posee el manifiesto esperado. **La reinstalación tras una desinstalación de configuración es un problema separado que sigue pendiente y NO está resuelto actualmente en este paquete; no asuma ni simule que está resuelto, ni elimine el marcador manualmente a ciegas.**

---

## 3. Detección de Drift y Rechazo Fail-Closed

El sistema aplica una política estricta de seguridad ante modificaciones no autorizadas (drift):

1. **Definición de Drift**:
   - Se comparan los valores gestionados actuales en `$AGENT_DIR/settings.json` (`reserveTokens` y `keepRecentTokens` para los ocho modelos gestionados) contra la política correspondiente en `policies` del manifiesto (o los valores v1 equivalentes en un manifiesto migrado).
   - Si el loader `$AGENT_DIR/extensions/omniroute-compaction.ts` fue editado manualmente o reemplazado por un archivo ajeno (su hash difiere de `loaderHash`).
   - Si el manifiesto `.pi-auto-compaction-manifest.json` fue modificado o eliminado mientras el loader sigue presente.
2. **Inmutabilidad de la línea base original**: La línea base original (`originalOverrides`) capturada en la instalación se mantiene inmutable exclusivamente para restaurar el estado en la desinstalación (`rollback.mjs`); **nunca se utiliza para sobrescribir configuraciones durante la ejecución activa de la extensión**.
3. **Preservación de cambios ajenos**: Configuraciones de otros modelos o campos de usuario en `settings.json` son respetados y preservados estrictamente.
4. **Rechazo automático y diagnóstico sin secretos**: Ante cualquier discrepancia en campos gestionados, tanto `setup.mjs`, `rollback.mjs` como `deploy.mjs` rechazan continuar (`fail-closed`). Deténgase y diagnostique los campos, tipos y hashes afectados sin exponer secretos, adoptando una decisión de reconciliación controlada.
5. **Prohibido alterar o eliminar marcadores de propiedad**: **Nunca edite configuraciones gestionadas a ciegas ni borre marcadores o manifiestos** para silenciar el drift.
6. **Invariante de `--force`**: El modificador `--force` solo existe en `rollback.mjs` para casos donde faltan archivos gestionados, pero **nunca elude las comprobaciones de drift ni de ownership**.

---

## 4. Gestión de Journals de Recuperación y Estado `pending`

Durante cualquier operación de despliegue o desinstalación, el sistema registra su progreso en journals transaccionales privados:

- **Estructura y campos del marcador**: El marcador `$INSTALL_DIR/.pi-auto-compaction-deploy.json` utiliza los campos canónicos `kind`, `version`, `installDir`, `agentDir`, `state` (`"ready"` o `"pending"`), `current`, `previous` y `pending`. (No utiliza campos inventados como `status`, `currentRelease` ni `previousRelease`).
- **Ubicación de journals transaccionales**:
  1. **Journals de despliegue**: `$INSTALL_DIR/journals/<lockToken>.json` (creados por `deploy.mjs` durante la transacción de release).
  2. **Journal de recuperación del agente**: `$AGENT_DIR/.pi-auto-compaction-state/recovery-journal.json` (creado temporalmente por `setup.mjs` y `rollback.mjs` durante las modificaciones en el agente).
  3. **Directorio de telemetría**: `$HOME/.local/state/pi-auto-compaction/` es **exclusivo para telemetría operativa** (`compaction.jsonl`), **no almacena journals ni estado de despliegue**.
- **Qué hacer tras una caída abrupta (crash)**: Si el proceso de despliegue se interrumpe (corte de energía, terminación forzada con `kill -9`), el marcador quedará con `state: "pending"` y el journal persistirá para registrar los pasos completados.
- **Prohibido eliminar journals o marcadores a ciegas**: **Nunca borre manualmente los archivos de journal ni fuerce la edición del marcador** para esquivar el bloqueo. La presencia de un journal pendiente es la garantía contra corrupciones silenciosas.
- **Resolución**: Ejecute la inspección en modo dry-run indicando las rutas canónicas:
  ```bash
  AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
  INSTALL_DIR="$HOME/.local/share/pi-auto-compaction"

  node scripts/deploy.mjs --update --dry-run --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
  ```
  Examine el diagnóstico del verificador y el contenido de `$INSTALL_DIR/journals/` y `$AGENT_DIR/.pi-auto-compaction-state/recovery-journal.json` para reconciliar manualmente el estado antes de un nuevo despliegue.

---

## 5. Compatibilidad y Actualizaciones Mayores del SDK de Pi

- **Fijación de versiones (Pinning)**: Las dependencias `@earendil-works/pi-coding-agent` y `@earendil-works/pi-ai` están fijadas con versión exacta `0.87.1` en `package.json`. No se utilizan comodines de rango (`^` o `~`).
- **Compatibilidad con Pi 1.5.0**: El job de CI `compat-pi-1-5` instala `@earendil-works/pi-coding-agent@1.5.0` y ejecuta `scripts/compat/pi-1.5.0-smoke.mjs` (versión, defaults 16384/20000, exports, serialización y hooks). El pin de desarrollo `0.87.1` se mantiene para no alterar el lockfile.
- **Verificación previa a la actualización del SDK**: Si se planea actualizar el paquete global de Pi en el sistema, clone primero los cambios en este repositorio, actualice el pin local, ejecute `npm test` y compruebe que los hooks del ciclo de vida (`session_before_compact`, `session_compact`, `session_compact_failed`) sigan manteniendo el mismo contrato antes de desplegar en producción.

---

## 6. Mantenimiento y persistencia de `.pi-auto-compaction-settings.json`

El archivo `.pi-auto-compaction-settings.json` almacena las preferencias de los modelos de autocompactación elegidos por el usuario (mediante `/compaction` o edición directa).

### Supervivencia frente a actualizaciones (`--update`) y rollbacks (`--rollback-source`)

- **Persistencia garantizada**: El archivo de settings reside en `$AGENT_DIR/.pi-auto-compaction-settings.json` (o `$HOME/.pi/agent/.pi-auto-compaction-settings.json`), de forma totalmente independiente del árbol de releases gestionados bajo `$INSTALL_DIR/releases/`.
- **Inalterado durante actualizaciones**: Las operaciones de actualización (`deploy.mjs --update`) y de reversión de código (`deploy.mjs --rollback-source`) únicamente gestionan los directorios inmutables de release y el loader `omniroute-compaction.ts`. **El archivo `.pi-auto-compaction-settings.json` sobrevive intacto a cualquier actualización de versión**. Tus modelos primario y de respaldo seleccionados se mantienen activos sin necesidad de reconfigurarlos tras actualizar.

### Respaldo de la configuración (Backup)

Para respaldar tu configuración de resumidores, copiá el archivo conservando los permisos restrictivos de lectura y escritura (`0600`):

```bash
SETTINGS_FILE="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/.pi-auto-compaction-settings.json"
if [ -f "$SETTINGS_FILE" ]; then
  cp -p "$SETTINGS_FILE" "$SETTINGS_FILE.bak"
  chmod 0600 "$SETTINGS_FILE.bak"
fi
```

### Restablecimiento a valores por defecto (Reset)

Si deseás descartar la configuración personalizada y restablecer los modelos de resumen a los valores predeterminados (`omniroute/antigravity/gemini-3.8-flash-tiered` y `gemini-3.6-flash-high`), basta con eliminar el archivo de settings:

```bash
rm "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/.pi-auto-compaction-settings.json"
```

- La eliminación es limpia y segura: la ausencia del archivo no se considera un error ni una advertencia.
- En el próximo ciclo de compactación, la extensión detectará la ausencia del archivo y utilizará de forma automática los modelos por defecto.
- También podés reconfigurar los modelos en caliente en cualquier momento ejecutando `/compaction` dentro de Pi, cuyo selector TUI incluye búsqueda incremental y scroll real (`SelectList`) para navegar catálogos de más de 100 modelos.
- Si preferís configurar el resumidor sin usar la interfaz interactiva, se admite plenamente el workaround manual: editar directamente `.pi-auto-compaction-settings.json` o definir variables de entorno `PI_AUTO_COMPACTION_*`, seguido de `/reload` y verificación con `npm run doctor`.

### Diagnóstico con `doctor`

Para verificar el estado actual del archivo de configuración, ejecutá el comando de diagnóstico:

```bash
npm run doctor -- --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
```

`doctor` muestra la ruta del archivo, el origen y los modelos efectivos. Si el archivo no existe, reportará origen predeterminado (`default`); si existe y es válido, reportará origen de archivo (`file`); y si el archivo contiene JSON mal formado o un esquema inválido, emitirá una advertencia diagnóstica clara sin bloquear la ejecución.
