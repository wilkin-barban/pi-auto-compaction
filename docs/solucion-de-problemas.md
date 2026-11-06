# Guía de Solución de Problemas

Este documento reúne los diagnósticos más comunes, las causas subyacentes y los procedimientos de recuperación paso a paso para **pi-auto-compaction**.

---

## 1. La compactación no se ejecuta o falla por autenticación antes del hook

### Síntoma
El contexto supera el umbral efectivo del modelo (por ejemplo, 334.464 en OpenAI, 860.000 en DeepSeek o 848.576 en Gemini), pero la compactación automática no se inicia, o Pi muestra un error de autenticación inmediatamente antes de intentar compactar. En los registros de telemetría de la extensión no aparece ningún evento nuevo.

### Causa raíz
En la arquitectura del SDK de Pi (`AgentSession._runAutoCompaction`), el sistema verifica la autenticación del **modelo de conversación activo** (por ejemplo, `openai-codex/gpt-6.1-sol` o `commandcode/deepseek/deepseek-v4.1-flash`) mediante `_getSummarizationRequestAuth(model)` **antes** de emitir el hook `session_before_compact`. Si las credenciales del proveedor de conversación en `auth.json` están expiradas o faltan, Pi aborta la operación antes de invocar la extensión. Esta comprobación previa valida **autenticación** (presencia de credenciales válidas), no cuota universal del proveedor. Los errores de cuota o indisponibilidad de proveedores ocurren durante la fase de petición del modelo y no impiden la invocación del hook.

### Solución
1. Compruebe la validez de las credenciales de su modelo de conversación en `$HOME/.pi/agent/auth.json`.
2. Verifique que puede ejecutar una interacción normal con el modelo principal en Pi.
3. Una vez restablecida la autenticación de conversación, Pi alcanzará el hook y la extensión tomará el control del resumen.
4. Para confirmar el umbral efectivo y el origen de cada valor, ejecutá:

   ```bash
   npm run doctor -- --agent-dir "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}" --install-dir "${PI_AUTO_COMPACTION_INSTALL_DIR:-$HOME/.local/share/pi-auto-compaction}"
   ```

---

## 2. Fallo de ambos modelos de OmniRoute (Dual Fail) y caída al fallback nativo

### Síntoma
La compactación tarda más tiempo del habitual (cerca de 60–120 segundos) y en el registro de telemetría se observa que tanto el modelo principal (`gemini-3.8-flash-tiered`) como el de respaldo (`gemini-3.6-flash-high`) fallaron, produciendo una llamada al fallback nativo de Pi.

### Causa raíz
Ambos modelos de resumen se sirven a través de la infraestructura de OmniRoute. Si la pasarela de OmniRoute experimenta indisponibilidad, saturación o corte de red, ambos intentos pueden agotar su tiempo de espera (60 s cada uno) o retornar error de servicio.

### Comportamiento del sistema
La extensión retorna `undefined` a Pi para que este intente compactar usando su motor nativo (el modelo de conversación activo). Sin embargo, tenga en cuenta:
- **El éxito del fallback nativo no está garantizado**: Si la causa raíz es un corte general de conexión a Internet, el modelo de conversación también fallará.
- La extensión no genera fallos fatales no controlados; registra el evento en telemetría y cede el control limpiamente.

### Diagnóstico
Revise las últimas entradas de telemetría para confirmar los códigos de error devueltos por OmniRoute:
```bash
tail -n 20 "$HOME/.local/state/pi-auto-compaction/compaction.jsonl"
```

---

## 3. Estado `pending` y bloqueo por Journal de Recuperación

### Síntoma
Al ejecutar `node scripts/deploy.mjs` o `npm run deploy`, el comando finaliza con un error indicando que existe una transacción pendiente o un journal no reconciliado en el directorio de estado.

### Causa raíz
Una ejecución previa de despliegue o desinstalación fue interrumpida abruptamente (corte de energía, cierre forzado de terminal, señal `SIGKILL`) mientras modificaba archivos del agente Pi. Por seguridad transaccional, el marcador `$INSTALL_DIR/.pi-auto-compaction-deploy.json` quedó con `state: "pending"`. Los journals de despliegue residen en `$INSTALL_DIR/journals/<lockToken>.json` y el journal de recuperación del agente en `$AGENT_DIR/.pi-auto-compaction-state/recovery-journal.json`. (Nota: `$HOME/.local/state/pi-auto-compaction/` es exclusivo para telemetría `compaction.jsonl`, no almacena journals).

### Procedimiento seguro de recuperación
1. **No borre el journal ni el marcador a ciegas**: La presencia del journal y del marcador `pending` previene que el sistema opere sobre una configuración inconsistente o corrupta.
2. Defina las rutas correspondientes y ejecute una inspección en modo solo lectura (`--dry-run`):
   ```bash
   AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
   INSTALL_DIR="$HOME/.local/share/pi-auto-compaction"

   node scripts/deploy.mjs --update --dry-run --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
   ```
3. Inspeccione el contenido del journal correspondiente en `$INSTALL_DIR/journals/` y `$AGENT_DIR/.pi-auto-compaction-state/recovery-journal.json` para identificar qué paso quedó incompleto (por ejemplo, escritura del loader o actualización de `settings.json`).
4. Una vez verificado manualmente el estado de `$AGENT_DIR/extensions/omniroute-compaction.ts` y `$AGENT_DIR/settings.json`, reconcilie el estado y proceda a reejecutar el despliegue con las mismas rutas.

---

## 4. Rechazo por Drift en la configuración o en el Manifiesto

### Síntoma
`setup.mjs`, `rollback.mjs` o `deploy.mjs` reportan un error de discrepancia de estado base (drift) y se niegan a continuar.

### Causa raíz
El sistema detectó que:
- Los campos gestionados (`reserveTokens` o `keepRecentTokens`) de los ocho modelos en `settings.json` difieren de la política correspondiente en `policies` del manifiesto.
- El loader oficial `omniroute-compaction.ts` fue editado o reemplazado por un archivo no reconocido (su hash difiere de `loaderHash`).
- El archivo `.pi-auto-compaction-manifest.json` fue modificado o eliminado mientras el loader seguía activo.

### Regla de seguridad
La línea base original (`originalOverrides`) capturada en el manifiesto es inmutable y está destinada exclusivamente para la desinstalación (`rollback.mjs`), no para sobreescribir configuraciones durante la ejecución activa. Las configuraciones de otros modelos o del usuario se preservan intactas. El modificador `--force` solo existe en `rollback.mjs` (para casos de archivos faltantes) y **nunca elude las comprobaciones de drift ni de ownership**. Si el estado base no es coherente, el sistema aplica la política *fail-closed*.

### Solución
1. Defina las rutas del agente e instalación:
   ```bash
   AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
   INSTALL_DIR="$HOME/.local/share/pi-auto-compaction"
   ```
2. Ejecutá el diagnóstico de solo lectura para identificar el modelo y el umbral fuera de política:
   ```bash
   npm run doctor -- --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
   ```
3. Abra `$AGENT_DIR/.pi-auto-compaction-manifest.json` y compare la política del modelo en `policies` (o los valores v1 equivalentes) con los valores actuales en `$AGENT_DIR/settings.json`.
4. Restaure manualmente la coherencia en `settings.json` para que coincida con la política del modelo en `policies`, preservando las configuraciones ajenas y sin exponer secretos.
5. Nunca elimine marcadores ni manifiestos de propiedad para ocultar el drift.
6. Vuelva a ejecutar la validación con:
   ```bash
   node scripts/deploy.mjs --update --dry-run --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
   ```

---

## 5. Rechazo de agente ocupado o raíz no gestionada y adopción con `--adopt-agent`

### Síntoma
Al ejecutar el despliegue, el comando finaliza con errores como:
- `Foreign agent manifest/loader: ownership refused`
- `Unmanaged install root: ownership required; legacy adoption is deferred`
- `Adoption requires an existing valid agent manifest and loader`
- `Adoption requires a new, non-existent install root`

### Causa raíz
`deploy.mjs` valida tanto la raíz de instalación como el directorio del agente de destino:
- Si el directorio de instalación ya existe pero no contiene el marcador canónico `.pi-auto-compaction-deploy.json`, la operación se rechaza para evitar sobreescribir archivos desconocidos.
- Si el directorio del agente (`$AGENT_DIR`) ya contiene un loader o un manifiesto sin una release activa gestionada, y se invoca `deploy.mjs` sin bandera, se rechaza categóricamente (`Foreign agent manifest/loader: ownership refused`).
- Si se invoca `--adopt-agent` pero la raíz de instalación ya existe en disco, se rechaza con `Adoption requires a new, non-existent install root`.
- Si se invoca `--adopt-agent` pero el agente no cuenta con manifiesto o loader oficial válidos, o se detecta drift en los ocho modelos gestionados, se rechaza fail-closed antes de cualquier escritura.

### Procedimiento de adopción mediante `--adopt-agent`
Para adoptar de forma segura un agente con una instalación previa válida hacia una nueva raíz gestionada:

1. **Definir variables canónicas con la nueva raíz gestionada inexistente**:
   ```bash
   AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
   INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/share/pi-auto-compaction-managed}"
   ```
   > **Importante**: `$INSTALL_DIR` debe ser una ruta que **no exista previamente** (creada por el propio wrapper; no ejecute `mkdir` antes). La raíz por defecto de la CLI para despliegues limpios es `$HOME/.local/share/pi-auto-compaction`, pero para adopción manual se recomienda explícitamente una ruta no colisionante.

2. **Realizar snapshot seguro previo con el script canónico en Python (privado, exclusivo y con permisos 0700/0600)**:
   Nunca utilice copias superficiales fijas como `cp ... settings.json.bak` dentro del agente ni scripts en shell con permisos laxos: sobreescriben respaldos anteriores, arriesgan permisos abiertos por umask y pueden seguir symlinks.

   > **Aviso de confidencialidad y enlace canónico**: Excluir `auth.json` evita respaldar los tokens de autenticación almacenados allí. No obstante, `settings.json` se respalda completamente y puede contener configuraciones sensibles o claves definidas por el usuario. Excluir `auth.json` **no garantiza la ausencia total de secretos** en `settings.json`. El directorio de respaldo debe conservarse con permisos restrictivos (0700/0600).
   >
   > Para realizar el snapshot, ejecute exclusivamente el **script canónico en Python documentado en `docs/instalacion.md` (sección 6, paso 4)**. Dicho script valida ancestros mediante `lstat`, rechaza symlinks antes de crear carpetas o aplicar `chmod`, asegura ownership estricto de usuario actual bajo `$HOME`, restringe el directorio base a `0700`, exige que los tres archivos gestionados (`settings.json`, `.pi-auto-compaction-manifest.json`, `extensions/omniroute-compaction.ts`) sean archivos regulares con `nlink == 1` del usuario actual, los copia de forma atómica y exclusiva con `O_EXCL` y modo `0600`, y falla cerrado ante cualquier archivo faltante, symlink o UID ajeno.


3. **Verificar en modo dry-run sin escrituras**:
   ```bash
   node scripts/deploy.mjs --adopt-agent --dry-run --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
   ```

4. **Ejecutar la adopción definitiva**:
   ```bash
   node scripts/deploy.mjs --adopt-agent --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
   ```

5. **Prerrequisitos, comportamiento observado y límites de reversión**:
   - El agente debe contar con manifiesto `1.0.0` (se migra a v2) o `2.0.0` y loader oficial cuyo hash coincida exactamente con `loaderHash`.
   - Los ocho modelos gestionados no deben presentar drift respecto a la política correspondiente en `policies`.
   - La fuente antigua referenciada en el manifiesto previo debe existir, ser válida y se conserva intacta en disco como respaldo inmutable (nunca se borra ni se modifica).
   - El nuevo release inmutable se copia a `$INSTALL_DIR/releases/<sha256>`, el marcador se establece en `state: "ready"` con `previous: null`, y el loader se actualiza para apuntar al nuevo release preservando la línea base `originalOverrides`.
   - **Límites de rollback**:
     - Sobre la primera release adoptada, ejecutar `node scripts/deploy.mjs --rollback-source --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"` es un **no-op limpio** (`noop: true`) debido a que `previous` es `null`.
     - Tras una actualización subsiguiente (`--update`), `--rollback-source` funciona con normalidad hacia el release adoptado original.
     - **Reversión de operador a la fuente antigua plana**: Requiere comprobar la ruta real de la fuente previa (guardada en el snapshot o ajustada vía variable de entorno) antes de ejecutar el setup:
       ```bash
       OLD_SOURCE_DIR="${OLD_SOURCE_DIR:-$HOME/.local/share/pi-auto-compaction}"
       node "$OLD_SOURCE_DIR/scripts/setup.mjs" --source-dir "$OLD_SOURCE_DIR" --target-dir "$AGENT_DIR"
       ```
       *Requisitos*: Requiere ausencia de drift, ausencia de bloqueos o journals pendientes y haber generado el snapshot. Si hay un journal pendiente, el comando se detiene inmediatamente.
       *Desincronización de metadatos (Metadata DESYNC)*: Este comando restaura el agente hacia la fuente plana, pero el marcador `$INSTALL_DIR/.pi-auto-compaction-deploy.json` queda en estado `"ready"` apuntando a la release gestionada. Futuros intentos de `--update` fallarán por propiedad (`Agent manifest source ownership mismatch`, no el error genérico `Foreign agent manifest/loader: ownership refused`). **ALTO**: No borre el marcador ni invente flags; la reconciliación automatizada no está implementada y requiere atención manual explícita.
     - **Compensación de fallos en adopción**: Posee guardas CAS exactas que restauran los bytes previos sin pisar modificaciones concurrentes ajenas; no obstante, no constituye recuperación atómica absoluta ante una caída total del proceso (`kill -9`).
     - **Reinstalación tras desinstalación de configuración**: Sigue sin estar implementada si se ejecutó `rollback.mjs`.
   - **Recarga de sesiones obligatoria**: Ejecute `/reload` en las sesiones activas de Pi para cargar el nuevo release.
