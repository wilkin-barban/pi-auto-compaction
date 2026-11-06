# Arquitectura y Diseño Técnico

Explora la arquitectura interna de **pi-auto-compaction**, incluyendo el ciclo de vida de los hooks del SDK de Pi, los releases transaccionales, las políticas gestionadas, la precedencia de configuración de los resumidores y las garantías de privacidad.

---

## Visión general de la arquitectura (Architecture at a Glance)

En una configuración estándar del agente de codificación Pi, la compactación de contexto es gestionada por el mismo modelo de conversación activo. Cuando los tokens de la conversación exceden la capacidad, Pi solicita al modelo de chat activo (por ejemplo, GPT-4o o Claude) que resuma los mensajes anteriores. Esto consume cuota de alta gama y genera riesgos de límites de tasa (*rate limits*).

**pi-auto-compaction** desacopla el modelo de conversación respecto al motor de síntesis de contexto:

```text
[Conversación activa en Pi] (ej. gpt-6.1-sol / deepseek-v4.1-flash)
              │
              ▼
   ¿Tokens > Umbral de disparo (Ventana - reserveTokens)?
              │
              ├─ No ──► La conversación normal continúa
              │
              └─ Sí ──► Pi verifica credenciales de conversación en auth.json
                             │
                             ▼
                    Dispara hook `session_before_compact`
                             │
                             ▼
               ┌──────────────────────────────┐
               │     pi-auto-compaction       │
               │                              │
               │  1. Adquiere bloqueo herdr   │
               │     (`herdr:blocked`)        │
               │  2. Construye prompt seguro  │
               │  3. Invoca Primary Model     │
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
   │ Registra telemetría local (0600)      │
   │ Retorna objeto CompactionResult a Pi │
   │ Libera bloqueo UI en herdr           │
   └───────────────────┬───────────────────┘
                       │
                       ▼
       Pi consolida las entradas compactadas de sesión
```

---

## 1. Ciclo de vida de los hooks en el SDK de Pi

La extensión se integra limpiamente con el agente de codificación Pi utilizando hooks oficiales del SDK sin modificar binarios ni paquetes de terceros:

| Evento de hook | Condición de disparo | Acciones de la extensión |
|---|---|---|
| `session_start` | Comienza una sesión nueva o restaurada. | Registra el indicador en la barra de estado `pi-auto-compaction-model` mostrando `Compaction: <provider>/<modelId>`. |
| `session_before_compact` | El conteo de tokens alcanza `contextWindow - reserveTokens`. | Intercepta la compactación. Emite `herdr:blocked`, serializa el historial de conversación, valida la capacidad de entrada y despacha el prompt al resumidor primario (límite de 60s). |
| `session_compact` | La compactación concluye exitosamente. | Escribe metadatos operativos autorizados en `compaction.jsonl` y libera el bloqueo `herdr:blocked`. |
| `session_compact_failed` | La compactación falla o el usuario la cancela. | Clasifica la categoría del error, registra la telemetría del fallo, libera los bloqueos de UI y cede el control al fallback nativo de Pi. |

---

## 2. Verificación de autenticación previa al hook

Un invariante arquitectónico crítico en el SDK de Pi (`AgentSession._runAutoCompaction`) es el orden de las comprobaciones de autenticación:

1. Antes de emitir `session_before_compact`, Pi invoca `_getSummarizationRequestAuth(model)` evaluando el **modelo de conversación activo**.
2. Pi comprueba que existan credenciales válidas y activas en `auth.json` para dicho proveedor de conversación.
3. Si las credenciales faltan o están expiradas, **Pi detiene el ciclo de compactación antes de invocar el hook de la extensión**.
4. **Implicación**: Esta comprobación previa valida la *presencia de credenciales*, no la cuota disponible del proveedor ni la salud universal del endpoint. `pi-auto-compaction` no puede eludir ni elude el requisito de contar con credenciales válidas para el modelo de conversación en `auth.json`.

---

## 3. Arquitectura de releases transaccionales y Manifiesto v2

Para asegurar que las sesiones prolongadas de Pi nunca se vean interrumpidas durante actualizaciones de código o cambios en ramas de Git, la extensión aísla el código en cuatro capas desacopladas:

### Las cuatro capas
1. **Directorio de código fuente (`$SOURCE_DIR`)**: El clon local de Git donde se ejecutan las pruebas y se descargan las actualizaciones (por ejemplo, `$HOME/proyectos/pi-auto-compaction`).
2. **Raíz de releases (`$INSTALL_DIR`)**: Contiene carpetas de release inmutables identificadas por contenido:
   - `releases/<sha256>/`: Archivos fuente verificados contra `.release.json`.
   - `journals/<lockToken>.json`: Journals transaccionales de despliegue.
   - `.pi-auto-compaction-deploy.json`: Marcador de despliegue autoritativo (`current`, `previous`, `state: "ready"|"pending"`).
3. **Loader de la extensión**: Envoltorio TypeScript generado en `$AGENT_DIR/extensions/omniroute-compaction.ts`. Realiza importaciones dinámicas del archivo `index.mjs` de la release activa.
4. **Manifiesto de configuración v2**: Persistido en `$AGENT_DIR/.pi-auto-compaction-manifest.json`:
   - `version: "2.0.0"`
   - `originalOverrides`: Línea base inmutable pre-instalación de los overrides de tokens (preservada estrictamente para la desinstalación).
   - `policies`: Políticas de modelos gestionados utilizadas para la detección de drift.
   - `loaderHash`: Firma SHA-256 del archivo loader.

---

## 4. Políticas gestionadas de conversación y cálculo de umbrales

Pi calcula el punto de activación de la compactación mediante la siguiente fórmula:

$$\text{Umbral de activación} = \text{Ventana de contexto} - \text{reserveTokens}$$

La extensión gestiona políticas explícitas para ocho modelos de conversación en `src/install-state.mjs` (`MANAGED_POLICIES`):

| Modelos | Ventana de contexto | `reserveTokens` | `keepRecentTokens` | Umbral de disparo | % de capacidad |
|---|---|---|---|---|---|
| `openai/gpt-6-sol`<br>`openai/gpt-6.1-sol`<br>`openai-codex/gpt-6-sol`<br>`openai-codex/gpt-6.1-sol` | 400.000 | 65.536 | 20.000 | 334.464 | ~83,6% |
| `commandcode/deepseek/deepseek-v4.1-flash`<br>`deepseek/deepseek-v4.1-flash` | 1.000.000 | 140.000 | 20.000 | 860.000 | 86,0% |
| `omniroute/antigravity/gemini-3.8-flash-tiered`<br>`antigravity/gemini-3.8-flash-tiered` | 1.048.576 | 200.000 | 20.000 | 848.576 | ~80,9% |

### Análisis del defecto histórico
En entornos anteriores no gestionados, una configuración externa asignaba `reserveTokens: 860000` para DeepSeek. Debido a que Pi resta los tokens reservados de la ventana total (`1.000.000 - 860.000 = 140.000`), la compactación se disparaba con tan solo **el 14% de la capacidad**, detonando 105 compactaciones prematuras en una sola sesión. La política gestionada impone `reserveTokens: 140000`, postergando la compactación hasta alcanzar los 860.000 tokens (86% de capacidad). `doctor` identifica cualquier discrepancia e informa el porcentaje exacto de disparo.

### Modelos no gestionados
Cualquier identificador de modelo no enumerado en la tabla permanece como no gestionado: conserva los overrides configurados por el usuario o adopta los valores por defecto de Pi (`reserveTokens: 16384`, `keepRecentTokens: 20000`).

---

## 5. Almacén de configuración de resumidores y precedencia

Los modelos resumidores se resuelven en tiempo de ejecución a través de una jerarquía estricta de 4 niveles de precedencia:

$$\text{options} \succ \text{env} \succ \text{file} \succ \text{default}$$

1. **`options`**: Argumentos explícitos pasados a `autoCompactionExtension(pi, options)`.
2. **`env`**: Variables de entorno de anulación:
   - `PI_AUTO_COMPACTION_PRIMARY_PROVIDER` + `PI_AUTO_COMPACTION_PRIMARY_MODEL`
   - `PI_AUTO_COMPACTION_FALLBACK_PROVIDER` + `PI_AUTO_COMPACTION_FALLBACK_MODEL`
   *Nota*: Los pares incompletos (proveedor sin modelo) se descartan con una advertencia.
3. **`file`**: Archivo de configuración dedicado `$AGENT_DIR/.pi-auto-compaction-settings.json` (o la ruta en `PI_AUTO_COMPACTION_SETTINGS_PATH`). Escrito de forma atómica con modo `0600`.
4. **`default`**: Modelos predeterminados inmutables: `omniroute/antigravity/gemini-3.8-flash-tiered` (primario) y `omniroute/antigravity/gemini-3.6-flash-high` (respaldo).

### Pureza arquitectónica
`resolveConfig()` en `src/config.mjs` es una función pura sin operaciones de E/S. Las lecturas de disco están aisladas en `resolveActiveConfig()` en `src/summarizer-settings.mjs`, la cual retorna un descriptor inmutable que incluye `path`, `source` (por ejemplo, `"file"`, `"env"`, `"default"`), y advertencias diagnósticas (`warnings`).

---

## 6. Selector interactivo de modelos (`/compaction`)

El comando `/compaction` proporciona una interfaz interactiva de terminal para seleccionar los modelos resumidores:

- **Descubrimiento dinámico de modelos**: Consulta `ctx.modelRegistry` buscando modelos de tipo `"chat"` donde `hasConfiguredAuth(model)` es verdadero. Solo los modelos autenticados y utilizables aparecen en la lista.
- **Implementación TUI (v1.2.1+)**: Construido con `SelectList` de `@earendil-works/pi-tui`.
  - **Viewport dinámico**: Calcula `maxVisible` a partir de `terminal.rows`, permitiendo renderizar con seguridad listas de más de 100 modelos.
  - **Búsqueda incremental**: Filtra dinámicamente entre proveedor, ID de modelo y nombre descriptivo.
  - **Controles**: Flechas (`↑`/`↓`), teclas Vim (`j`/`k`), `PgUp`/`PgDn`, `Home`/`End`, rueda del ratón, `Enter` (seleccionar), `Esc` (cancelar).
  - **Degradación elegante**: Recurre al selector plano `ui.select` en entornos headless o sin soporte de UI personalizada.

### Justificación de diseño: Por qué `/compaction` y no la configuración de Pi

La configuración de resumidores mediante `/compaction` fue elegida en lugar de integrarse en el menú `/settings` → Extensions de Pi o en `/gentle:customize` de gentle-shell por motivos técnicos concretos:
1. **Límites del SDK**: `ExtensionAPI` de Pi expone `registerCommand`, `setStatus` y `ctx.ui.*`, pero carece de una API para inyectar campos de formulario personalizados en `/settings`.
2. **Restricción de interruptores binarios**: El componente interno `ConfigSelectorComponent` de Pi solo soporta activar o desactivar extensiones completas.
3. **Menús estáticos**: En gentle-shell, los menús de `/gentle:customize` están codificados de forma fija en `gentle-shell.ts`.
4. **Política de No-Parches**: Eludir estas fronteras requeriría modificar archivos instalados en `node_modules`, violando frontalmente el contrato de integridad arquitectónica del repositorio.

---

## 7. Diagnóstico de solo lectura (`doctor`)

`scripts/doctor.mjs` inspecciona la instalación activa sin modificar archivos ni configuraciones:

- **Códigos de salida**:
  - `0`: Saludable (`healthy`).
  - `1`: Advertencias (overrides no gestionados, modelos ausentes en catálogo, ventanas de contexto pequeñas `<32.000`).
  - `2`: Errores críticos (manifiestos faltantes, marcador de despliegue en estado `pending`, drift irrecuperable).
- **Salida programática JSON (`--json`)**: Emite JSON estructurado idóneo para agentes de IA y monitores automatizados.
- **Evaluaciones**: Valida coincidencia de hash del loader, estado del marcador de despliegue, umbrales efectivos de activación, permisos de telemetría y definiciones de modelos en catálogos.

---

## 8. Lista blanca de telemetría y garantías de privacidad

La telemetría local se registra en `$HOME/.local/state/pi-auto-compaction/compaction.jsonl` (modo `0600`, carpeta contenedora `0700`):

### Campos estrictamente autorizados en lista blanca
- `timestamp`, `sessionId`, `reason`, `model` (modelo resumidor), `status`, `durationMs`, `tokensBefore`, `usage`, `attemptCount`, `errorCategory`.
- Métricas de contexto conversacional: `conversationModel`, `conversationProvider`, `contextWindow`, `reserveTokens`, `keepRecentTokens`, `thresholdTokens`.

### Exclusiones explícitas
- **Sin transcripciones**: Los cuerpos de mensajes, prompts y contenidos de archivos nunca se escriben en disco.
- **Sin `tokensAfter`**: El recuento de tokens posterior a la compactación no se cuantifica ni se almacena.
- **Sin credenciales**: Las claves de API, tokens de autenticación y secretos de sesión están completamente excluidos.
- **Sin rutas de usuario**: Los prefijos de directorios personales se sanitizan y omiten.

> **Datos en tránsito**: Para sintetizar el historial de conversación, el texto de los turnos de conversación antiguos se transmite al endpoint de la API del resumidor configurado (OmniRoute por defecto). La telemetría local registra únicamente metadatos cuantitativos.

---

## 9. Licenciamiento y política de código disponible

- **Licenciamiento**: Licenciado como `UNLICENSED` (todos los derechos reservados, `private: true` en `package.json`).
- **Código disponible (Source-Available)**: El repositorio es público en GitHub para facilitar la transparencia, la auditoría de código y el reporte de incidentes.
- **Sin distribución en npm**: Este paquete no se publica en el registro de npm. La instalación y distribución ocurren exclusivamente mediante clones de Git y despliegues transaccionales gestionados.

---

## Próximos pasos

- Conocer los procedimientos de despliegue: [`docs/es/instalacion.md`](instalacion.md)
- Aprender los protocolos para agentes automatizados: [`docs/es/instalacion-agente.md`](instalacion-agente.md)
- Revisar las tareas de mantenimiento rutinario: [`docs/es/mantenimiento.md`](mantenimiento.md)
- Consultar los procedimientos de solución de problemas: [`docs/es/solucion-de-problemas.md`](solucion-de-problemas.md)
