# Arquitectura y Diseño Técnico

Este documento describe la arquitectura interna de **pi-auto-compaction**, el ciclo de vida de los hooks en el SDK de Pi, el mecanismo de delegación de resúmenes hacia OmniRoute, la preservación de contexto y el modelo de telemetría.

---

## 1. Visión general del flujo de ejecución

En una instalación estándar de Pi, la compactación de contexto utiliza el mismo modelo de conversación configurado por el usuario. Cuando el contexto alcanza un umbral crítico, Pi pausa la conversación y solicita al modelo de chat (por ejemplo, OpenAI GPT) que genere un resumen de los turnos antiguos. Esto genera dos inconvenientes: consume cuota costosa del modelo principal de conversación y puede generar bloqueos si dicho modelo experimenta latencia o restricciones de tasa.

**pi-auto-compaction** intercepta este proceso desacoplando el modelo de conversación del modelo de compactación:

```text
[Conversación activa en Pi] (ej. gpt-6-sol / gpt-6.1-sol)
              │
              ▼
   ¿Tokens > 206.464 (~76%)?
              │
              ├─ No ──► Continúa conversación normal
              │
              └─ Sí ──► Pi verifica autenticación de conversación en auth.json
                             │
                             ▼
                    Dispara hook `session_before_compact`
                             │
                             ▼
               ┌──────────────────────────────┐
               │     pi-auto-compaction       │
               │                              │
               │  1. Bloqueo UI (herdr opcional)
               │  2. Construir prompt seguro  │
               │  3. Consultar Primary Model  │
               │     (gemini-3.8-flash-tiered)│
               │     [Timeout: 60s]           │
               └──────────────┬───────────────┘
                              │
               ┌──────────────┴──────────────┐
               │                             │
          ¿Éxito?                       ¿Falló?
               │                             │
              Sí                             ▼
               │                ┌──────────────────────────────┐
               │                │   Reintento: Backup Model    │
               │                │   (gemini-3.6-flash-high)    │
               │                │   [Presupuesto total: 120s]  │
               │                └──────────────┬───────────────┘
               │                               │
               │                       ┌───────┴───────┐
               │                       │               │
               │                  ¿Éxito?          ¿Falló?
               │                       │               │
               │                      Sí               ▼
               │                       │    Retorna undefined:
               │                       │    Pi activa fallback nativo
               ▼                       ▼    (Éxito no garantizado)
   ┌───────────────────────────────────────┐
   │ Registra telemetría privada (0600)    │
   │ Retorna objeto CompactionResult a Pi │
   │ Libera bloqueo UI (herdr)            │
   └───────────────────┬───────────────────┘
                       │
                       ▼
       Pi actualiza entradas de sesión
```

---

## 2. Invariante crítica: Verificación de autenticación previa al hook

Un detalle arquitectónico fundamental del SDK de Pi (`AgentSession._runAutoCompaction`) es el orden de operaciones:

1. Antes de emitir el evento `session_before_compact`, Pi invoca internamente el método `_getSummarizationRequestAuth(model)` utilizando el **modelo de conversación activo**.
2. Pi comprueba que existan credenciales válidas y activas para ese modelo en `auth.json`. Si las credenciales faltan o están expiradas, **Pi aborta la operación antes de invocar la extensión**. Esta comprobación previa valida **autenticación** (presencia de clave o token válido), no cuota universal del proveedor. Los errores de cuota, saturación o cortes de red de los proveedores ocurren durante la fase posterior de ejecución de la solicitud y no impiden la invocación inicial del hook.
3. Por tanto, esta extensión **no puede ni intenta eludir la necesidad de credenciales válidas para el modelo de conversación**. Asegúrese siempre de mantener autenticado el modelo de chat principal en `auth.json`.

---

## 3. Resumidores de OmniRoute y política de fallback

La extensión utiliza la API `ctx.modelRegistry.complete` para despachar la tarea de resumen a través de la pasarela de OmniRoute:

### Modelos configurados

- **Modelo principal (Primary)**:
  `omniroute/antigravity/gemini-3.8-flash-tiered`
- **Modelo de respaldo (Fallback)**:
  `omniroute/antigravity/gemini-3.6-flash-high`

Ambos identificadores se configuran con parámetros de esfuerzo de razonamiento bajo (`reasoningEffort: "low"` y `reasoning: "low"`), **aplicados condicionalmente únicamente si el modelo cuenta con soporte de razonamiento (`model.reasoning` es verdadero)**; no se adjunta de forma incondicional a modelos que no lo soportan. Esto optimiza la velocidad de respuesta y el costo de generación del resumen.

### Presupuesto de tiempo y cancelación

- **Por intento**: Cada llamada a un resumidor tiene un límite estricto de **60 segundos**.
- **Presupuesto acumulado**: El tiempo total combinado de intentos no puede superar los **120 segundos**.
- **Cancelación inmediata**: Si el usuario aborta la operación en Pi o se interrumpe la sesión, la señal `AbortSignal` padre cancela de inmediato la petición en curso sin esperar a que concluya el timeout.

### Caída al resumen nativo de Pi

Si tanto el modelo principal como el de respaldo fallan, o si se agota el presupuesto de 120 segundos, la extensión no lanza una excepción no controlada:
- Devuelve `undefined`.
- Esto indica a Pi que debe intentar su procedimiento de resumen nativo predeterminado como último recurso.
- **Advertencia**: Si la falla se debió a un corte general de conectividad o infraestructura compartida, el resumen nativo también podría fallar; esta extensión no puede garantizar el éxito del fallback nativo.

---

## 4. Umbrales de activación y modelos soportados

La extensión gestiona exactamente cuatro identificadores de modelo de conversación con ventanas de 272.000 tokens:

1. `openai/gpt-6-sol`
2. `openai/gpt-6.1-sol`
3. `openai-codex/gpt-6-sol`
4. `openai-codex/gpt-6.1-sol`

### Cálculo de umbrales

Al ejecutarse `setup.mjs`, se configuran en `settings.json` los siguientes valores para cada uno de los cuatro modelos:

- `reserveTokens`: `65536`
- `keepRecentTokens`: `20000`

En una ventana de contexto de **272.000 tokens**, la fórmula de activación de Pi es:

$$\text{Umbral de activación} = \text{Ventana Total} - \text{reserveTokens} = 272.000 - 65.536 = 206.464 \text{ tokens}$$

Esto representa exactamente un punto de disparo del **~76% de la capacidad**. En observaciones empíricas reales (por ejemplo, en la sesión de prueba *Trindade*), la compactación se activó al 76,17% de la capacidad y completó el resumen en 20,8 segundos (evidencia de log, sin constituir un compromiso de SLO formal).

> **Soporte de nuevos modelos**: Si en el futuro se desea soportar identificadores adicionales, esto requiere modificar explícitamente la lista en `src/config.mjs`, actualizar las pruebas en `test/unit/config.test.mjs` y generar un nuevo release.

---

## 5. Integración con UI y coordinación con herdr

Durante la compactación, la extensión coordina el estado visual para evitar que el usuario o el harness interpreten la pausa como un bloqueo del sistema:

- Si `herdr` está disponible en el entorno, adquiere **exactamente un** bloqueo activo (`herdr:blocked`) al iniciar el ciclo.
- Actualiza las etiquetas de etapa en la interfaz (por ejemplo, indicando el intento con el resumidor principal o secundario).
- Libera de manera segura y determinista el bloqueo al concluir el ciclo, ya sea por éxito, error, cancelación o apagado de la sesión.
- No modifica archivos de producto de herdr ni altera código fuente ajeno.

---

## 6. Telemetría y privacidad

La extensión mantiene un registro de auditoría local para diagnosticar el comportamiento de las compactaciones:

- **Ubicación**: `$HOME/.local/state/pi-auto-compaction/compaction.jsonl`. (La carpeta `$HOME/.local/state/pi-auto-compaction/` está reservada exclusivamente para telemetría; los journals de recuperación y despliegue residen en sus directorios respectivos de instalación y agente).
- **Permisos de archivo**: Modo `0600` (lectura/escritura exclusiva del usuario) dentro de un directorio con permisos `0700`.
- **Lista blanca de metadatos**: Se registran únicamente métricas cuantitativas: marca de tiempo (`timestamp`), identificador de sesión (`sessionId`), motivo (`reason`), modelo (`model`), estado (`status`), duración en milisegundos (`durationMs`), tokens antes de compactar (`tokensBefore`), uso de tokens si está disponible (`usage`), conteo de intentos (`attemptCount`) y categoría de error (`errorCategory`). **No existe el campo `tokensAfter`**.
- **Datos no registrados**: Se excluyen estrictamente las transcripciones completas de los mensajes, claves de API, variables de entorno y rutas completas del sistema de archivos.
- **Claridad sobre transmisión de datos**: Para que los resumidores de OmniRoute puedan generar el resumen del contexto anterior, **el texto de los turnos antiguos de la conversación se transmite deliberadamente a la API de OmniRoute**. El cifrado en tránsito depende del protocolo del endpoint configurado (se recomienda enfáticamente HTTPS; la extensión no impone TLS a nivel de transporte). No debe afirmarse que ningún contenido conversacional abandona la máquina; lo que se garantiza es que la telemetría local persistida en disco no almacena transcripciones ni secretos.
