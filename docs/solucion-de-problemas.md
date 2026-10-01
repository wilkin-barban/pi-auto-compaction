# Guía de Solución de Problemas

Este documento reúne los diagnósticos más comunes, las causas subyacentes y los procedimientos de recuperación paso a paso para **pi-auto-compaction**.

---

## 1. La compactación no se ejecuta o falla por autenticación antes del hook

### Síntoma
El contexto supera los 206.464 tokens, pero la compactación automática no se inicia, o Pi muestra un error de autenticación inmediatamente antes de intentar compactar. En los registros de telemetría de la extensión no aparece ningún evento nuevo.

### Causa raíz
En la arquitectura del SDK de Pi (`AgentSession._runAutoCompaction`), el sistema verifica la autenticación del **modelo de conversación activo** (por ejemplo, OpenAI `gpt-6-sol` o `gpt-6.1-sol`) mediante `_getSummarizationRequestAuth(model)` **antes** de emitir el hook `session_before_compact`. Si las credenciales de OpenAI en `auth.json` están expiradas o faltan, Pi aborta la operación antes de invocar la extensión. Esta comprobación previa valida **autenticación** (presencia de credenciales válidas), no cuota universal del proveedor. Los errores de cuota o indisponibilidad de proveedores ocurren durante la fase de petición del modelo y no impiden la invocación del hook.

### Solución
1. Compruebe la validez de las credenciales de su modelo de conversación en `$HOME/.pi/agent/auth.json`.
2. Verifique que puede ejecutar una interacción normal con el modelo principal en Pi.
3. Una vez restablecida la autenticación de conversación, Pi alcanzará el hook y la extensión tomará el control del resumen.

---

## 2. Fallo de ambos modelos de OmniRoute (Dual Fail) y caída al fallback nativo

### Síntoma
La compactación tarda más tiempo del habitual (cerca de 60–120 segundos) y en el registro de telemetría se observa que tanto el modelo principal (`gemini-3.8-flash-tiered`) como el de respaldo (`gemini-3.6-flash-high`) fallaron, produciendo una llamada al fallback nativo de Pi.

### Causa raíz
Ambos modelos de resumen se sirven a través de la infraestructura de OmniRoute. Si la pasarela de OmniRoute experimenta indisponibilidad, saturación o corte de red, ambos intentos pueden agotar su tiempo de espera (60 s cada uno) o retornar error de servicio.

### Comportamiento del sistema
La extensión retorna `undefined` a Pi para que este intente compactar usando su motor nativo (OpenAI). Sin embargo, tenga en cuenta:
- **El éxito del fallback nativo no está garantizado**: Si la causa raíz es un corte general de conexión a Internet, el modelo nativo de OpenAI también fallará.
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
- Los campos gestionados (`reserveTokens` o `keepRecentTokens`) de los cuatro modelos en `settings.json` difieren de los valores esperados (`expectedManagedValues`) registrados en el manifiesto.
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
2. Abra `$AGENT_DIR/.pi-auto-compaction-manifest.json` y compare los valores esperados (`expectedManagedValues`) con los valores actuales en `$AGENT_DIR/settings.json`.
3. Restaure manualmente la coherencia en `settings.json` para que coincida con `expectedManagedValues`, preservando las configuraciones ajenas y sin exponer secretos.
4. Nunca elimine marcadores ni manifiestos de propiedad para ocultar el drift.
5. Vuelva a ejecutar la validación con:
   ```bash
   node scripts/deploy.mjs --update --dry-run --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
   ```

---

## 5. Rechazo de agente ocupado o raíz no gestionada (Limitaciones de migración legacy)

### Síntoma
Al ejecutar el despliegue, el comando finaliza con errores como:
- `Foreign agent manifest/loader: ownership refused`
- `Unmanaged install root: ownership required; legacy adoption is deferred`

### Causa raíz
`deploy.mjs` valida tanto la raíz de instalación como el directorio del agente de destino (`scripts/deploy.mjs` líneas 153–154):
- Si el directorio de instalación ya existe pero no contiene el marcador canónico `.pi-auto-compaction-deploy.json`, la operación se rechaza para evitar sobreescribir archivos desconocidos.
- Si el directorio del agente (`$AGENT_DIR`) ya contiene un loader (`extensions/omniroute-compaction.ts`) o un manifiesto (`.pi-auto-compaction-manifest.json`) que no corresponde a una release activa gestionada por este wrapper, **`deploy.mjs` rechaza la operación categóricamente, incluso si se especifica un `--install-dir` completamente nuevo**.

### Estado de migración legacy y recomendaciones
1. **La migración legacy NO está implementada actualmente**: No existe un procedimiento automatizado de adopción ni migración de instalaciones planas previas hacia el nuevo esquema por releases.
2. **La instalación actual permanece intacta**: La instalación plana existente de Wilkin continúa funcionando normalmente sin ser alterada.
3. **Uso del wrapper en agentes limpios**: El nuevo instalador por releases está disponible para entornos limpios o perfiles de agente vacíos (por ejemplo, en otra máquina o perfil nuevo).
4. **Decisión planificada de mantenimiento**: Cualquier migración o reemplazo futuro requiere una decisión explícita, planificada y reconciliada de mantenimiento, acompañada de copias de seguridad completas previas del agente y del loader existente.
5. **No eliminar archivos a ciegas**: No elimine a ciegas el loader existente, ni borre marcadores o journals para intentar forzar la adopción. No existe en este momento ningún comando CLI para adoptar la instalación activa.
