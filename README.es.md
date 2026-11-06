[English](README.md) | [Español](README.es.md)

# pi-auto-compaction

Compactación automática de contexto desacoplada y controlada por el usuario para Pi, gentle-shell y herdr.

Descarga la costosa síntesis de contexto desde tu modelo de conversación activo (OpenAI, DeepSeek, Gemini, Claude, etc.) hacia resumidores independientes y configurables (OmniRoute por defecto, o cualquier modelo disponible en tu harness de Pi), incorporando tolerancia a fallos en cascada, telemetría local privada y cero parches sobre código ajeno (*zero monkey-patching*).

> **Aviso de código disponible (Source-Available)**: Este repositorio es público como código disponible (*source-available*) bajo licencia `UNLICENSED` (todos los derechos reservados, `private: true` en `package.json`). No está publicado en npm y se prohíbe su redistribución o publicación no autorizada como paquete.

---

## ¿Qué es y para quién es?

**pi-auto-compaction** es una extensión para el agente de codificación [Pi](https://github.com/earendil-works/pi-coding-agent), [gentle-shell](https://github.com/gentleman-programming/gentle-shell) y [herdr](https://github.com/gentleman-programming/herdr).

Está diseñada para desarrolladores y agentes de IA que sostienen sesiones de programación largas y complejas, y necesitan:
- **Preservación de cuota**: Evitar que los modelos conversacionales de alta gama gasten tokens en extensos resúmenes de conversación.
- **Fiabilidad**: Proteger las sesiones frente a límites de tasa (*rate limits*), saturación de contexto e interrupciones del proveedor durante la compactación.
- **Seguridad y auditabilidad**: Mantener la configuración aislada, verificar los despliegues mediante transacciones deterministas y prescindir por completo de parches sobre paquetes de terceros.

---

## El problema que resuelve

| Desafío en Pi estándar | Solución en pi-auto-compaction |
|---|---|
| **Resumen acoplado**: Pi solicita al modelo de conversación que resuma su propio historial, agotando cuota costosa y provocando límites de tasa. | **Compactación desacoplada**: La síntesis se ejecuta en modelos independientes y livianos sin tocar el modelo de chat activo. |
| **Resumidor fijo**: No se puede configurar ni alternar con facilidad qué modelo sintetiza el historial de conversación. | **Resumidor configurable**: Elige modelos primario y de respaldo interactivamente mediante `/compaction`, variables de entorno o un archivo de configuración propio. |
| **Punto único de fallo**: Si la solicitud de resumen falla, el agotamiento del contexto detiene la sesión de trabajo. | **Tolerancia a fallos multinivel**: Prueba el modelo primario (límite 60s), pasa al modelo secundario dentro de un presupuesto de 120s y cede el control a la compactación nativa de Pi si ambos fallan. |
| **Umbrales opacos**: En configuraciones estándar, overrides incorrectos de tokens pueden detonar compactaciones prematuras (por ejemplo, disparar al 14% de la capacidad). | **Políticas adaptativas y diagnóstico con doctor**: Políticas gestionadas para 8 modelos conversacionales y herramienta diagnóstica `doctor` de solo lectura que reporta umbrales efectivos exactos y su origen. |
| **Preocupaciones de privacidad**: La telemetría podría registrar transcripciones completas, prompts o secretos en disco. | **Telemetría local por lista blanca**: Registra métricas estrictamente cuantitativas (permisos 0600) sin transcripciones, sin secretos y sin `tokensAfter`. |

---

## Ruta rápida

Sigue estos pasos para realizar una instalación manual completa:

1. **Clonar el repositorio**:
   ```bash
   git clone https://github.com/wilkinbarban/pi-auto-compaction.git "$HOME/proyectos/pi-auto-compaction"
   cd "$HOME/proyectos/pi-auto-compaction"
   ```

2. **Instalar dependencias y verificar la suite de pruebas**:
   Requiere Node.js `>=22.19.0`. Comprueba que pasen exactamente **326 pruebas en 33 suites**:
   ```bash
   npm ci --ignore-scripts
   npm test
   ```

3. **Simular el despliegue (`--dry-run`)**:
   Valida la sintaxis, ownership de archivos, listas de archivos autorizados y permisos en modo de solo lectura sin escribir en disco:
   ```bash
   npm run deploy -- --dry-run
   ```

4. **Desplegar el release durable**:
   Instala un release inmutable en `$HOME/.local/share/pi-auto-compaction/releases/<sha256>` y configura el loader oficial en `$HOME/.pi/agent/extensions/omniroute-compaction.ts`:
   ```bash
   npm run deploy
   ```

5. **Recargar tu sesión de Pi**:
   Dentro de una sesión activa de terminal en Pi, ejecuta:
   ```text
   /reload
   ```

6. **Configurar modelos resumidores (Opcional)**:
   Abre el selector interactivo para elegir los resumidores primario y de respaldo:
   ```text
   /compaction
   ```

7. **Ejecutar diagnóstico de salud**:
   Verifica los umbrales efectivos, la integridad del manifiesto y el estado del resumidor:
   ```bash
   npm run doctor
   ```

---

## Para agentes de IA

Los agentes autónomos de codificación (subagentes en Pi, orquestadores en gentle-shell o harnesses externos) pueden instalar, adoptar o actualizar este paquete sin intervención humana siguiendo nuestro estricto contrato de agentes.

- **Guía de instalación para agentes**: [`docs/es/instalacion-agente.md`](docs/es/instalacion-agente.md) — Protocolo completo que abarca inspección de entorno, snapshots previos a la instalación, puertas de ejecución y compensación de fallos.
- **Skill del agente**: [`skills/pi-auto-compaction/SKILL.md`](skills/pi-auto-compaction/SKILL.md) — Definición de habilidad orientada a LLMs con triggers, reglas de activación y contratos de salida.
- **Prompt ejecutable para agentes**: [`skills/pi-auto-compaction/assets/agent-install-prompt.es.md`](skills/pi-auto-compaction/assets/agent-install-prompt.es.md) — Instrucciones listas para copiar y pegar destinadas a delegar la configuración a un agente autónomo.

### Flujo general para agentes

```text
[Inspeccionar rutas y estado] ──► [Tomar snapshot seguro (0700/0600)] ──► [Seleccionar método]
                                                                                │
                 ┌──────────────────────────────────────────────────────────────┴─────────────────────────────────┐
                 ▼                                                              ▼                                 ▼
       [Instalación limpia]                                            [Modo de adopción]               [Modo actualización]
       deploy.mjs --dry-run                                            deploy.mjs --adopt-agent           deploy.mjs --update
       deploy.mjs                                                      (nueva raíz inexistente)
                 │                                                              │                                 │
                 └──────────────────────────────────────────────────────────────┼─────────────────────────────────┘
                                                                                ▼
                                                                  [/reload y doctor diagnósticos]
                                                                                ▼
                                                                   [Reporte de estado estructurado]
```

---

## Métodos de despliegue y ciclo de vida

| Método | Comando | Escenario objetivo | Cambios realizados | Datos preservados |
|---|---|---|---|---|
| **Instalación limpia** | `node scripts/deploy.mjs` (o `npm run deploy`) | Directorio del agente limpio y nueva raíz de instalación inexistente. | Crea release inmutable bajo `$INSTALL_DIR/releases/<sha256>`, escribe marcador de despliegue e instala loader y manifiesto v2 en el agente. | Preserva configuraciones no gestionadas del usuario en `settings.json`. |
| **Adopción de agente** | `node scripts/deploy.mjs --adopt-agent --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"` | Migración de un agente previamente gestionado hacia una nueva raíz de releases. | Valida loader/manifiesto existentes, copia fuente a la nueva raíz, apunta el loader al nuevo release y actualiza el marcador a `ready`. | Mantiene la fuente antigua intacta en disco; preserva la línea base original de tokens en el manifiesto. |
| **Actualización** | `node scripts/deploy.mjs --update` (o `npm run deploy -- --update`) | Actualizar una instalación gestionada existente con código fuente más reciente. | Crea nueva carpeta de release, apunta el loader al nuevo hash y actualiza el marcador (`previous` se convierte en el release anterior). | Preserva líneas base de tokens, ajustes del usuario y preferencias de resumidores. No-op si el hash coincide. |
| **Rollback de fuentes** | `node scripts/deploy.mjs --rollback-source` (o `npm run deploy -- --rollback-source`) | Revertir el código activo al release anterior tras detectar una regresión. | Vuelve a apuntar el loader al release anterior en `releases/<sha256>`, y establece `previous` en null en el marcador. Operación unitaria idempotente. | Conserva overrides de `settings.json` y la línea base del manifiesto. NO desinstala la extensión. |
| **Desinstalación de configuración** | `node scripts/rollback.mjs` (o `npm run rollback`) | Remover completamente la extensión y restaurar el estado previo a la instalación. | Elimina el loader `omniroute-compaction.ts` y el manifiesto; restaura la línea base original en `settings.json`. | Deja la raíz de instalación `$INSTALL_DIR` y las carpetas históricas de releases intactas en disco. |

---

## Modelos y configuración

### Comando interactivo: `/compaction`

Configura tus modelos resumidores interactivamente sin reiniciar Pi ni alterar tu modelo de conversación:

```text
/compaction
```

1. **Selección del modelo primario**: Lista todos los modelos de chat con credenciales válidas en Pi (`auth.json`), ordenados por `provider/id`, con `✓` indicando la selección actual.
2. **Selección del modelo de respaldo (Fallback)**: Solicita un modelo alternativo distinto para responder ante tiempos de espera agotados, límites de tasa o errores de contexto del modelo primario.

#### Características del selector (v1.2.1+)
- **Scroll dinámico para listas extensas (100+ modelos)**: Desarrollado con `SelectList` de `@earendil-works/pi-tui`. La ventana visible (`maxVisible`) se adapta a la altura del terminal (`terminal.rows`), garantizando que todos los modelos sean accesibles.
- **Búsqueda incremental**: Escribe directamente para filtrar modelos en tiempo real por proveedor, ID de modelo o nombre descriptivo.
- **Navegación por teclado y ratón**: `↑`/`↓` (o `j`/`k`), `PgUp`/`PgDn`, `Home`/`End`, rueda del ratón, `Enter` para seleccionar, `Esc` para cancelar.
- **Degradación headless**: Recurre automáticamente a `ui.select` plano en entornos sin soporte de interfaz personalizada.
- **Aplicación en caliente**: Los ajustes se aplican de inmediato en memoria (`runtimeConfig`) para las siguientes compactaciones y actualizan el indicador en el pie (`pi-auto-compaction-model`).

### Modelos y proveedores predeterminados

- **Primario predeterminado**: `omniroute/antigravity/gemini-3.8-flash-tiered`
- **Respaldo predeterminado**: `omniroute/antigravity/gemini-3.6-flash-high`

Puedes emparejar cualquier modelo de chat autorizado disponible en tu harness:
- **Antigravity / Gemini directo**: `antigravity/gemini-3.8-flash-tiered` + `antigravity/gemini-3.6-flash-high`
- **OpenAI / Codex**: `openai/gpt-4o` + `openai/gpt-4o-mini`
- **Command Code / DeepSeek**: `commandcode/deepseek/deepseek-v4.1-flash` + `commandcode/deepseek/deepseek-v3.1-lite`
- **Ollama local**: `ollama/qwen2.5-coder:14b` + `ollama/llama3.2:3b`

### Lista de omisión de proveedores (`PI_AUTO_COMPACTION_SKIP_PROVIDERS`)

Para evitar que las sesiones de conversación de proveedores específicos sean resumidas externamente, define `PI_AUTO_COMPACTION_SKIP_PROVIDERS`. Cuando el modelo de conversación activo coincide con una entrada de esta lista, la compactación omite la extensión y delega directamente en la síntesis nativa de Pi:

```bash
export PI_AUTO_COMPACTION_SKIP_PROVIDERS="deepseek,commandcode"
```

### Almacén de configuración y precedencia

Las preferencias de los resumidores se resuelven mediante una jerarquía estricta de 4 niveles:

$$\text{options} \succ \text{env} \succ \text{file} \succ \text{default}$$

1. **`options`**: Argumentos programáticos pasados a `autoCompactionExtension(pi, options)`.
2. **`env`**: Variables de entorno `PI_AUTO_COMPACTION_PRIMARY_PROVIDER`, `PI_AUTO_COMPACTION_PRIMARY_MODEL`, `PI_AUTO_COMPACTION_FALLBACK_PROVIDER` y `PI_AUTO_COMPACTION_FALLBACK_MODEL`.
3. **`file`**: Preferencias guardadas en `$AGENT_DIR/.pi-auto-compaction-settings.json` (o la ruta fijada en `PI_AUTO_COMPACTION_SETTINGS_PATH`). Creado con permisos `0600` mediante escritura atómica. Nunca modifica `settings.json`.
4. **`default`**: Modelos predeterminados inmutables (`omniroute/antigravity/gemini-3.8-flash-tiered` + `gemini-3.6-flash-high`).

---

## Operaciones y diagnóstico

### Herramienta de diagnóstico de solo lectura (`doctor`)

Inspecciona el estado del despliegue, la coherencia del manifiesto, los umbrales efectivos y la configuración del resumidor:

```bash
# Reporte legible para humanos
npm run doctor

# Salida en formato JSON para automatización
npm run doctor -- --json

# Diagnóstico de un modelo específico
npm run doctor -- --model commandcode/deepseek/deepseek-v4.1-flash
```

**Códigos de salida de doctor**:
- `0`: Saludable (`healthy`). La configuración y los umbrales coinciden con las políticas gestionadas.
- `1`: Advertencias (`warning`). Overrides no gestionados, modelos ausentes en catálogos o ventanas de contexto reducidas.
- `2`: Errores críticos (`error`). Manifiesto ausente, marcador de despliegue en estado `pending` o drift irrecuperable.

### Políticas gestionadas de conversación

Pi detona la compactación cuando el consumo de tokens alcanza:
$$\text{Umbral de activación} = \text{Ventana de contexto} - \text{reserveTokens}$$

La extensión gestiona políticas para ocho modelos de conversación:

| Modelos | Ventana de contexto | `reserveTokens` | `keepRecentTokens` | Umbral de activación | % de capacidad |
|---|---|---|---|---|---|
| `openai/gpt-6-sol`<br>`openai/gpt-6.1-sol`<br>`openai-codex/gpt-6-sol`<br>`openai-codex/gpt-6.1-sol` | 400.000 | 65.536 | 20.000 | 334.464 | ~83,6% |
| `commandcode/deepseek/deepseek-v4.1-flash`<br>`deepseek/deepseek-v4.1-flash` | 1.000.000 | 140.000 | 20.000 | 860.000 | 86,0% |
| `omniroute/antigravity/gemini-3.8-flash-tiered`<br>`antigravity/gemini-3.8-flash-tiered` | 1.048.576 | 200.000 | 20.000 | 848.576 | ~80,9% |

*Contexto del defecto histórico*: Configuraciones no gestionadas previas establecían erróneamente `reserveTokens: 860000` para DeepSeek, provocando que la compactación se disparara a los 140.000 tokens (al 14% de la capacidad) y detonando 105 compactaciones prematuras en una sola sesión. Las políticas gestionadas aplican la reserva correcta de 140.000 tokens (disparando a los 860.000 tokens / 86%).

### Integración Continua (CI)

La validación automatizada se ejecuta en cada commit y solicitud de extracción (PR):
- **Matriz de versiones**: Node.js 22 y Node.js 24 en Ubuntu.
- **Suite de pruebas**: Ejecución integral de las 326 pruebas unitarias y de integración.
- **Prueba de humo de compatibilidad con Pi**: Valida el enlace de hooks y el ciclo de vida frente a `@earendil-works/pi-coding-agent@1.5.0` y `@earendil-works/pi-ai@1.5.0`.

---

## Seguridad, privacidad y licenciamiento

### Lista blanca de telemetría local

Los registros operativos se escriben en `$HOME/.local/state/pi-auto-compaction/compaction.jsonl` (permisos `0600`, carpeta contenedora `0700`):
- **Incluido**: `timestamp`, `sessionId`, `reason`, `model` (resumidor), `durationMs`, `status`, `tokensBefore`, `usage`, `attemptCount`, `errorCategory`, y métricas de contexto conversacional (`conversationModel`, `conversationProvider`, `contextWindow`, `reserveTokens`, `keepRecentTokens`, `thresholdTokens`).
- **Excluido**: Sin transcripciones de mensajes, sin contenido de prompts, sin `tokensAfter`, sin claves de API y sin rutas personales del usuario.

### Datos en tránsito

Para generar el resumen del historial, **los turnos de conversación antiguos se transmiten a la API del endpoint de tu proveedor resumidor configurado** (OmniRoute por defecto). Utiliza siempre endpoints HTTPS seguros para todos los proveedores remotos. La telemetría local almacena únicamente metadatos cuantitativos.

### Separación de credenciales

Este repositorio y sus archivos de configuración **nunca almacenan credenciales**. Todas las claves de API permanecen bajo el almacén nativo de credenciales de Pi (`$HOME/.pi/agent/auth.json`).

> **Invariante de autenticación previa al hook**: Pi verifica que tu *modelo de conversación activo* cuente con credenciales válidas en `auth.json` *antes* de invocar el hook `session_before_compact`. Si las credenciales de conversación caducaron o faltan, Pi se detiene antes de delegar el control en la extensión.

---

## Índice de documentación

### Documentación en inglés (Principal)
- [**Installation Guide**](docs/en/installation.md): Requisitos previos, instalación limpia, migración con `--adopt-agent`, variables de entorno y checklist de verificación.
- [**Agent Installation Guide**](docs/en/agent-install.md): Contrato para agentes autónomos, guardas de seguridad, matriz de decisión y prompt copiable.
- [**Architecture & Design**](docs/en/architecture.md): Ciclo de vida de hooks, manifiestos transaccionales, políticas gestionadas, diseño interno del selector y seguridad.
- [**Maintenance & Upgrades**](docs/en/maintenance.md): Rutinas de actualización, rollback de código vs. desinstalación, journals de recuperación, resolución de drift y retención de releases.
- [**Troubleshooting Guide**](docs/en/troubleshooting.md): Diagnóstico y recuperación paso a paso para comprobaciones de autenticación, doble fallo de resumidores, configuraciones corruptas, ventanas reducidas y journals pendientes.

### Documentación en español
- [**Guía de Instalación**](docs/es/instalacion.md)
- [**Guía de Instalación para Agentes**](docs/es/instalacion-agente.md)
- [**Arquitectura y Diseño Técnico**](docs/es/arquitectura.md)
- [**Mantenimiento y Actualizaciones**](docs/es/mantenimiento.md)
- [**Solución de Problemas**](docs/es/solucion-de-problemas.md)

### Políticas del proyecto
- [**Registro de cambios (Changelog)**](CHANGELOG.md): Registro histórico de versiones y cambios.
- [**Política de Seguridad**](SECURITY.md): Procedimiento de reporte de vulnerabilidades y garantías de privacidad.
- [**Guía de Contribución**](CONTRIBUTING.md): Directrices estrictas de desarrollo guiado por pruebas (TDD), convenciones de test y fijación del SDK.
