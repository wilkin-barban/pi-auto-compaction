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

---

## 6. El comando `/compaction` no aparece o no es reconocido

### Síntoma
Al escribir `/compaction` dentro de una sesión de Pi, la consola indica que el comando no existe o no aparece en la paleta de autocompletado de comandos.

### Causa raíz
Pi inicializa y registra los comandos de las extensiones al arrancar la sesión o al invocar `/reload`. Si se instaló o actualizó la extensión mientras Pi ya estaba en ejecución, el nuevo comando no estará disponible en memoria hasta recargar.

### Solución
1. En la sesión activa de Pi, ejecutá:
   ```text
   /reload
   ```
2. Tras la recarga, escribí `/compaction` en la línea de entrada; el comando aparecerá con la descripción `"Configurar el modelo primario y de respaldo de la autocompactación"`.

---

## 7. Sin modelos de chat disponibles al ejecutar `/compaction`

### Síntoma
Al ejecutar `/compaction`, aparece la notificación de error:
`"No hay modelos de chat disponibles con credenciales configuradas."`
y el comando finaliza sin abrir el selector.

### Causa raíz
El resolvedor de modelos (`listChatModels`) consulta dinámicamente `ctx.modelRegistry` buscando modelos de tipo `"chat"` que tengan credenciales configuradas (`hasConfiguredAuth`). Si no hay proveedores autenticados en `auth.json` o si ningún modelo de chat supera el filtro de autenticación, la lista resulta vacía.

### Solución
1. Verificá que tus credenciales de modelos de chat estén configuradas en `$HOME/.pi/agent/auth.json` o ejecutá el comando `/login` dentro de Pi para autenticar tus proveedores habituales.
2. Comprobá que al menos un proveedor (por ejemplo OmniRoute, OpenAI, Anthropic, Gemini o proveedores locales compatibles) disponga de credenciales válidas y modelos de chat accesibles.
3. Volvé a ejecutar `/compaction` una vez confirmadas las credenciales.

---

## 8. Modelo de resumen configurado no encontrado en tiempo de ejecución

### Síntoma
Durante el inicio de sesión o al dispararse una compactación, `doctor` o la consola advierten que el modelo primario o de respaldo configurado en `.pi-auto-compaction-settings.json` no se encuentra en el registro de modelos.

### Causa raíz
El modelo fue guardado previamente en el archivo de settings, pero posteriormente se desconfiguró el proveedor, se revocaron las credenciales en `auth.json`, o el modelo fue retirado de `models.json`.

### Comportamiento del sistema
- Si el modelo primario no está disponible, la extensión intenta automáticamente el modelo de respaldo.
- Si el modelo de respaldo tampoco está disponible o falla, la extensión retorna `undefined` para que Pi active su compactación nativa, garantizando que la conversación no se interrumpa.

### Solución
1. Ejecutá `/compaction` para seleccionar un modelo activo y disponible en el harness.
2. Si deseás restaurar los modelos originales de OmniRoute, eliminá el archivo `.pi-auto-compaction-settings.json` o reconfigurá las credenciales del proveedor ausente en `auth.json`.

---

## 9. Archivo de configuración corrupto o con versión inválida

### Síntoma
Al iniciar Pi o al ejecutar `npm run doctor`, aparece una advertencia como:
`"Failed to load summarizer settings from ...: Invalid JSON in summarizer settings: ..."` o `"Invalid settings version: expected 1, got ..."`

### Causa raíz
El archivo `.pi-auto-compaction-settings.json` fue editado manualmente introduciendo errores de sintaxis JSON, campos no reconocidos, tipos de datos inválidos (como `null` o números donde se esperan strings) o una versión distinta de `1`.

### Comportamiento de protección
Por seguridad de los datos del usuario, **la extensión nunca sobrescribe ni borra un archivo corrupto automáticamente**. En su lugar:
- Emite una advertencia diagnóstica visible en `doctor` y en las notificaciones de Pi.
- Carga de forma segura los modelos predeterminados inmutables (`DEFAULT_EFFECTIVE_SUMMARIZER`).

### Solución
1. Podés corregir la sintaxis JSON del archivo directamente respetando el esquema estricto (campos `version: 1`, `primary: { provider, modelId }`, `fallback: { provider, modelId }`).
2. O bien, ejecutá `/compaction` dentro de Pi y completá la selección: al confirmar, se escribirá un nuevo archivo atómico válido.
3. Si preferís restablecer a los valores predeterminados limpios, simplemente borrá el archivo:
   ```bash
   rm "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/.pi-auto-compaction-settings.json"
   ```

---

## 10. Advertencia por ventana de contexto reducida (`< 32.000` tokens)

### Síntoma
Al seleccionar un modelo en `/compaction` o en el reporte de `doctor`, aparece la advertencia:
`"Atención: <provider>/<modelId> tiene ventana de contexto chica (< 32.000 tokens); las sesiones largas van a caer al respaldo o a la compactación nativa."`

### Causa raíz
El modelo seleccionado declara una ventana de contexto (`contextWindow`) inferior a 32.000 tokens (común en modelos locales pequeños de 8k o 16k).

### Impacto operativo
La compactación debe enviar los turnos históricos de la conversación dentro de un solo prompt. Si la sesión activa acumula una cantidad de tokens que excede la ventana del resumidor, el intento fallará inmediatamente por límite de capacidad y el sistema intentará el modelo de respaldo o la compactación nativa de Pi.

### Recomendación
- Para sesiones de desarrollo complejas o prolongadas, elegí modelos primarios con ventanas amplias (por ejemplo, 128k, 400k o 1.000.000 de tokens).
- Si deseás utilizar un modelo con ventana reducida como primario, asegurate de que el modelo de respaldo cuente con una ventana suficientemente grande como red de protección.

---

## 11. El modelo de respaldo es idéntico al primario

### Síntoma
Al completar la selección en `/compaction`, el panel muestra la advertencia:
`"El respaldo debe ser un modelo distinto del primario: aporta resiliencia cuando el primario falla. No se guardó nada."`
y la configuración previa se mantiene intacta.

### Causa raíz
Se seleccionó exactamente el mismo `provider/modelId` para el rol primario y para el rol de respaldo.

### Justificación de diseño
El propósito arquitectónico del modelo de respaldo es ofrecer tolerancia a fallos cuando el primario experimenta caídas de red, saturación, errores de cuota o límites de contexto. Asignar el mismo modelo anula la redundancia y duplicaría las llamadas fallidas al mismo endpoint.

### Solución
Volvé a ejecutar `/compaction` y asegurate de elegir un modelo de respaldo distinto (por ejemplo, un modelo más liviano del mismo proveedor o un proveedor alternativo de respaldo).

---

## 12. Modelo local lento o timeout por rendimiento

### Síntoma
Al emplear un modelo local (como Ollama) como resumidor primario, la compactación se demora 60 segundos y se cancela con error de timeout, pasando al modelo de respaldo o a la compactación nativa.

### Causa raíz
La extensión aplica un límite estricto de **60 segundos por intento** para evitar que la interfaz de Pi permanezca congelada indefinidamente. Si el modelo local se ejecuta en una máquina sin aceleración suficiente por GPU o si el contexto histórico es grande, el procesamiento puede superar los 60 segundos permitidos.

### Solución
1. **Modelos más livianos**: Utilizá versiones cuantizadas más ligeras (por ejemplo `qwen2.5-coder:7b` en lugar de versiones de `14b` o `32b`).
2. **Inversión de roles**: Configurá un modelo rápido en la nube (como `antigravity/gemini-3.8-flash-tiered` o `openai/gpt-4o-mini`) como primario y dejá el modelo local como respaldo (o viceversa según tu preferencia de costos).
3. **Optimización de inferencia local**: Verificá que Ollama tenga habilitada la descarga completa de capas en GPU (`num_gpu`) para reducir los tiempos de generación.
