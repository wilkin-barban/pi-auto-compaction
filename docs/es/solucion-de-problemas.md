# Guía de Solución de Problemas y Diagnóstico

Diagnostica, recupera y resuelve problemas operativos, mensajes de error y casos extremos en **pi-auto-compaction**.

---

## Matriz de diagnóstico rápido (Quick Diagnostic Matrix)

Encuentra tu síntoma a continuación para identificar la causa técnica y la acción rápida de recuperación:

| Síntoma | Causa probable | Acción rápida de recuperación |
|---|---|---|
| Comando `/compaction` no reconocido en Pi. | Sesión abierta antes de la instalación o actualización. | Ejecutar `/reload` en la sesión activa de Pi. |
| `"No chat models available with configured credentials"` en `/compaction`. | Sin modelos de chat autenticados en `auth.json`. | Ejecutar `/login` o añadir credenciales en `$HOME/.pi/agent/auth.json`. |
| La compactación falla antes del hook; sin telemetría registrada. | Credenciales del modelo de conversación activas faltantes o expiradas. | Renovar credenciales para el modelo de conversación en `auth.json`. |
| Modelo resumidor configurado no encontrado en tiempo de ejecución. | Modelo retirado de catálogo o credenciales del proveedor revocadas. | Reejecutar `/compaction` o eliminar archivo de settings para restaurar defaults. |
| Advertencia: Archivo de configuración corrupto o inválido. | Error de sintaxis JSON o versión inválida en el archivo de settings. | Corregir sintaxis o eliminar `.pi-auto-compaction-settings.json`. |
| Advertencia: Ventana de contexto reducida (`< 32.000` tokens). | El modelo resumidor declara una ventana menor a 32k. | Seleccionar un modelo con ventana más grande (ej. 128k+) como primario. |
| Ambos resumidores fallan; caída a compactación nativa de Pi. | Corte de red compartido o fallo del proveedor aguas arriba. | Inspeccionar `compaction.jsonl`; verificar conectividad con los endpoints. |
| Despliegue detenido: Journal de despliegue pendiente o bloqueo activo. | Transacción anterior interrumpida (`SIGKILL`, terminal cerrada). | Inspeccionar journals en `journals/`; ejecutar `--dry-run`; reconciliar. |
| Despliegue/Rollback rechazado por drift de configuración. | Overrides de tokens en `settings.json` modificados fuera de política. | Ejecutar `doctor`, alinear `settings.json` con `policies` del manifiesto. |
| `--rollback-source` resulta en no-op limpio tras adopción. | El release adoptado inicial tiene `previous: null`. | Ejecutar setup desde la fuente antigua preservada si se revierte adopción. |
| gentle-shell no carga el SDK desde el loader de la extensión. | Paquete de Pi ubicado fuera de las rutas estándar de búsqueda de Node. | Configurar `PI_CODING_AGENT_PATH` apuntando al paquete del SDK de Pi. |
| Modelo local (ej. Ollama) agota el timeout de 60s por intento. | Modelo pesado en CPU o historial extenso que excede el presupuesto. | Usar modelo cuantizado/más pequeño, habilitar capas en GPU o usar primario en nube. |

---

## 1. Comando `/compaction` no reconocido o ausente

### Síntoma
Al escribir `/compaction` en Pi se muestra `Comando desconocido: /compaction` o el comando no aparece en el autocompletado.

### Causa raíz
Pi registra los comandos de las extensiones al arrancar la sesión o al ejecutar `/reload`. Instalar o actualizar la extensión mientras Pi está en ejecución no registra automáticamente los nuevos comandos en la memoria activa.

### Recuperación
1. En tu sesión activa de terminal en Pi, ejecuta:
   ```text
   /reload
   ```
2. Escribe `/compaction` de nuevo. El autocompletado mostrará ahora `"Configurar el modelo primario y de respaldo de la autocompactación"`.

---

## 2. Sin modelos de chat disponibles con autenticación configurada

### Síntoma
Al ejecutar `/compaction` aparece la notificación:
`"No hay modelos de chat disponibles con credenciales configuradas."` y el selector se cierra de inmediato.

### Causa raíz
El resolvedor de modelos (`listChatModels`) consulta `ctx.modelRegistry` de Pi buscando modelos de tipo `"chat"` donde `hasConfiguredAuth(model)` es verdadero. Si ningún proveedor está autenticado en `auth.json`, la lista resulta vacía.

### Recuperación
1. Verifica las credenciales de proveedores en `$HOME/.pi/agent/auth.json`.
2. Autentica tus proveedores habituales ejecutando `/login` dentro de Pi.
3. Asegúrate de que al menos un proveedor (OmniRoute, OpenAI, Anthropic, Gemini o un proveedor local como Ollama) cuente con credenciales válidas.
4. Ejecuta `/compaction` de nuevo una vez confirmadas las credenciales.

---

## 3. Modelo resumidor configurado no encontrado en tiempo de ejecución

### Síntoma
Al ejecutar `doctor` se advierte que un modelo resumidor configurado no existe en ningún catálogo (`models.json`, `models-store.json`, `commandcode-models.json`), o los intentos de compactación en runtime saltan de inmediato al respaldo.

### Causa raíz
El modelo fue guardado previamente en `.pi-auto-compaction-settings.json`, pero posteriormente el proveedor fue retirado, las credenciales expiraron o el ID del modelo cambió.

### Comportamiento del sistema
La extensión maneja modelos ausentes de forma elegante:
- Si el modelo primario falla o no puede resolverse, intenta de inmediato el modelo de respaldo.
- Si ambos fallan, retorna `undefined` para permitir que la compactación nativa de Pi gestione la reducción de contexto.

### Recuperación
1. Ejecuta `/compaction` en Pi y selecciona un modelo disponible y autenticado.
2. O restablece los modelos por defecto eliminando el archivo de settings:
   ```bash
   rm "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/.pi-auto-compaction-settings.json"
   ```

---

## 4. Archivo de configuración corrupto o inválido

### Síntoma
Al arrancar Pi o durante la ejecución de `doctor`, aparece la advertencia:
`"Failed to load summarizer settings: Invalid JSON in summarizer settings"` o `"Invalid settings version: expected 1"`.

### Causa raíz
Modificaciones manuales en `.pi-auto-compaction-settings.json` introdujeron errores de sintaxis JSON, claves desconocidas, identificadores de modelo que no son cadenas de texto o un número de versión no soportado.

### Comportamiento de seguridad
La extensión **nunca sobrescribe ni destruye un archivo de settings corrupto automáticamente**. En su lugar:
- Emite una advertencia diagnóstica en `doctor` y en las notificaciones de Pi.
- Carga valores seguros predeterminados en memoria (`omniroute/antigravity/gemini-3.8-flash-tiered`).

### Recuperación
1. Corrige la sintaxis JSON en `.pi-auto-compaction-settings.json`:
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
2. O abre `/compaction` en Pi y completa la selección; al confirmar se escribe un archivo atómico y limpio.
3. O elimina el archivo para restaurar los valores predeterminados.

---

## 5. Advertencia: Ventana de contexto reducida (`< 32.000` Tokens)

### Síntoma
Durante `/compaction` o en el reporte de `doctor`, aparece:
`"Atención: <modelo> tiene ventana de contexto chica (< 32.000 tokens); las sesiones largas van a caer al respaldo o a la compactación nativa."`

### Causa raíz
El modelo seleccionado declara un `contextWindow` inferior a 32.000 tokens (habitual en modelos locales compactos como variantes de 8k o 16k).

### Impacto operativo
La compactación envía el historial de la conversación en un único prompt. Si los tokens de la sesión superan la ventana del resumidor, la llamada falla en la validación de capacidad y salta en cascada al modelo de respaldo o a la compactación nativa.

### Recomendación
- Selecciona un modelo primario con una ventana de contexto amplia (por ejemplo, 128k, 400k o 1M de tokens) para sesiones largas de desarrollo.
- Si utilizas un modelo local pequeño como primario, asegúrate de que tu modelo de respaldo cuente con una ventana grande para que actúe como red de seguridad.

---

## 6. Fallo doble de ambos resumidores (Fallback nativo)

### Síntoma
La compactación demora 60–120 segundos y `compaction.jsonl` registra fallos tanto para el modelo primario como para el de respaldo, detonando la compactación nativa de Pi.

### Causa raíz
Ambos resumidores experimentaron timeout (límite de 60s por intento), límites de tasa o cortes de red. Si ambos comparten la misma pasarela o infraestructura de proveedor, una caída compartida provocará el fallo de ambos.

### Comportamiento del sistema
La extensión retorna `undefined` a Pi, iniciando el resumen nativo con el modelo de conversación activo. Ten en cuenta que si el acceso a la red está totalmente caído, la compactación nativa también podría fallar.

### Recuperación
1. Inspecciona las últimas entradas en la telemetría local:
   ```bash
   tail -n 20 "$HOME/.local/state/pi-auto-compaction/compaction.jsonl"
   ```
2. Revisa `errorCategory` en el registro: `timeout`, `rate_limit`, `auth` o `capacity`.
3. Si predominan los timeouts, configura modelos más veloces o incrementa la aceleración por GPU para modelos locales.

---

## 7. La compactación no se dispara debido a la autenticación previa al hook

### Síntoma
El consumo de tokens supera el umbral de activación (por ejemplo, 334k para OpenAI, 860k para DeepSeek), pero la compactación no se inicia y no aparecen nuevos registros de telemetría.

### Causa raíz
Pi valida las credenciales del **modelo de conversación activo** en `auth.json` *antes* de emitir el hook `session_before_compact`. Si las credenciales del modelo de conversación están vencidas o faltan, Pi se detiene antes de delegar el control en la extensión.

### Recuperación
1. Comprueba las credenciales de tu modelo de conversación activo en `$HOME/.pi/agent/auth.json`.
2. Confirma que puedes ejecutar un prompt normal en Pi con dicho modelo.
3. Una vez restablecida la autenticación de la conversación, Pi disparará el hook normalmente.
4. Ejecuta `npm run doctor` para confirmar los umbrales efectivos de activación.

---

## 8. Despliegue interrumpido, journal pendiente o bloqueo activo

### Síntoma
`deploy.mjs` falla con:
`"Pending deployment journal: manual reconciliation required; do not delete marker/journals"` o `"Deployment lock active"`.

### Causa raíz
Un proceso anterior de despliegue o rollback fue terminado abruptamente (`SIGKILL`, corte de energía, terminal cerrada), dejando `.pi-auto-compaction-deploy.json` en `state: "pending"`.

### Recuperación
1. **No borres el marcador ni los journals**: La eliminación impide una recuperación determinista.
2. Inspecciona los journals:
   ```bash
   cat "$INSTALL_DIR/journals/"*.json
   ```
3. Ejecuta una simulación con dry-run para evaluar el estado del sistema:
   ```bash
   node scripts/deploy.mjs --update --dry-run --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
   ```
4. Comprueba si `$AGENT_DIR/extensions/omniroute-compaction.ts` coincide con el release deseado.
5. Si es coherente, restablece `"state": "ready"` en `$INSTALL_DIR/.pi-auto-compaction-deploy.json`.

---

## 9. Rechazo por drift en la configuración o manifiesto

### Síntoma
`deploy.mjs`, `setup.mjs` o `rollback.mjs` se detienen con un error de drift.

### Causa raíz
- Los overrides de tokens de los modelos gestionados en `settings.json` fueron alterados externamente.
- El loader `omniroute-compaction.ts` fue editado (desalineación de hash).
- El manifiesto fue eliminado mientras el loader seguía activo.

### Recuperación
1. Ejecuta `doctor` para localizar el drift:
   ```bash
   node scripts/doctor.mjs --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
   ```
2. Abre `$AGENT_DIR/.pi-auto-compaction-manifest.json` y revisa la sección `policies`.
3. Restaura los valores exactos de `reserveTokens` y `keepRecentTokens` en `$AGENT_DIR/settings.json`.
4. Ejecuta `deploy.mjs --update --dry-run` para verificar que las comprobaciones de drift pasen cleanly.

---

## 10. Límites de adopción y rollback

### Síntoma
- Ejecutar `deploy.mjs --rollback-source` tras `--adopt-agent` reporta `noop: true` sin alternar releases.
- Volver a ejecutar `--update` tras invocar manualmente el setup de la fuente antigua falla con `Agent manifest source ownership mismatch`.

### Causa raíz
1. En una instalación adoptada, el release inicial tiene `previous: null`. No existe un release gestionado previo en `$INSTALL_DIR/releases/` al que retroceder.
2. Ejecutar el setup desde la fuente antigua revierte el agente, pero deja el marcador del wrapper apuntando al release gestionado, causando una desincronización de metadatos (*Metadata DESYNC*).

### Recuperación
- Para revertir un agente adoptado a su fuente anterior, ejecuta el setup desde la fuente antigua:
  ```bash
  OLD_SOURCE_DIR="${OLD_SOURCE_DIR:-$HOME/.local/share/pi-auto-compaction}"
  node "$OLD_SOURCE_DIR/scripts/setup.mjs" --source-dir "$OLD_SOURCE_DIR" --target-dir "$AGENT_DIR"
  ```
- Si ocurre una desincronización de metadatos, reconcilia manualmente `packageSourceDir` del manifiesto con `current.path` del marcador de despliegue.

---

## 11. Fallo de resolución del SDK en gentle-shell

### Síntoma
Pi o gentle-shell registran:
`"[pi-auto-compaction] Failed to load durable extension: Cannot find module '@earendil-works/pi-coding-agent'"`

### Causa raíz
En configuraciones no estándar o aisladas de gentle-shell, el SDK de Pi puede encontrarse en una ruta no estándar que Node no localiza desde el loader de la extensión.

### Recuperación
Exporta `PI_CODING_AGENT_PATH` apuntando al directorio exacto donde está instalado Pi o su SDK:
```bash
export PI_CODING_AGENT_PATH="/home/usuario/.gentle-shell/versions/current/node_modules/@earendil-works/pi-coding-agent"
```
Reinicia gentle-shell o recarga tu sesión.

---

## 12. Timeout por modelo local o inferencia lenta

### Síntoma
Al utilizar modelos locales (como Ollama o llama.cpp local), la compactación agota de forma sistemática el timeout de 60 segundos por intento y recurre al modelo secundario o a la compactación nativa.

### Causa raíz
La extensión aplica un **timeout estricto de 60 segundos por intento** para evitar bloqueos del terminal. Si un prompt extenso se evalúa en CPU o en una configuración de GPU sin optimizar, el tiempo de inferencia puede superar fácilmente los 60 segundos.

### Recuperación
1. **Cuantización**: Utiliza variantes cuantizadas a 4 u 8 bits (por ejemplo `qwen2.5-coder:7b` en lugar de `32b`).
2. **Descarga en GPU**: Asegúrate de habilitar la descarga completa de capas en GPU en Ollama (parámetro `num_gpu`).
3. **Invertir roles**: Usa un modelo remoto rápido (ej. `gemini-3.8-flash-tiered` o `gpt-4o-mini`) como primario, manteniendo el modelo local como secundario, o viceversa.

---

## Lista de comprobación de salud post-recuperación (Post-Recovery Health Checklist)

Tras completar cualquier procedimiento de recuperación, confirma:

- [ ] `npm run doctor` finaliza con código `0` (`healthy`).
- [ ] `$INSTALL_DIR/.pi-auto-compaction-deploy.json` tiene `"state": "ready"`.
- [ ] No quedan archivos `.deploy.lock` ni journals de recuperación huérfanos en las carpetas de estado.
- [ ] `/reload` en Pi muestra `Compaction: <provider>/<modelId>` en el pie de página.
- [ ] La compactación de prueba concluye con éxito sin detonar cascadas de doble fallo.

---

## Próximos pasos

- Revisar el mantenimiento rutinario: [`docs/es/mantenimiento.md`](mantenimiento.md)
- Explorar la arquitectura del sistema: [`docs/es/arquitectura.md`](arquitectura.md)
- Releer los flujos de instalación: [`docs/es/instalacion.md`](instalacion.md)
