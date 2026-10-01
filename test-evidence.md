# Evidencia histórica de pruebas — Pi Auto-Compaction

Este documento resume las tandas de desarrollo previas al empaquetado portable. No sustituye la verificación actual: consultar [repository-evidence.md](repository-evidence.md). Los resultados fallidos se conservan como evidencia, no como fallos actuales ni excepciones ambientales autorizadas.

## Corrección final de temporización de pruebas (2026-10-01)

Alcance: `test/unit/summarizer.test.mjs` y este registro. No se modificaron producción, instaladores, dependencias, autenticación ni configuración activa; sin despliegue, staging o commits. Perfil observado: `openai-codex/gpt-6.1-sol`, razonamiento `high`.

### RED observado

Con `t.mock.timers` de Node para `Date` y `setTimeout`, se esperó el inicio del proveedor principal y se avanzó 200 ms con los antiguos límites de 30 ms por intento y 200 ms totales. Falló `assert.ok(result.summary)` con `Former success assertion assumes fallback despite an exhausted deadline`.

La ruta legítima de producción no entregó resumen porque había agotado el presupuesto total. Este RED demuestra una expectativa incorrecta de la prueba, **no un defecto de producción**; no se atribuye una corrección de producción a esta tanda.

### Cobertura conservada y mejorada

- `late delivery of primary timeout consumes overall deadline and skips fallback`: sin resumen, un solo intento, timeout y ninguna petición/transición al respaldo tras agotarse el plazo.
- `handles provider that hangs forever ignoring signal via bounded Promise.race attempt timeout`: reloj controlado, 1.000 ms por intento y 60.000 ms totales; sin respaldo a 999 ms y exactamente un intento principal y uno de respaldo a 1.000 ms.
- `safely ignores independent late provider resolution after timeout` y `handles independent late provider rejection after timeout without unhandled rejection`: promesas independientes que realmente resuelven/rechazan tarde. Listener acotado `unhandledRejection`, dos vueltas reales del bucle de eventos, lista de errores vacía y retirada del listener en `finally`; resumen/modelo/intentos/secuencia estables después.
- `does NOT attempt fallback if primary attempt consumed the overallTimeoutMs budget`: el límite total de 70 ms acota el intento configurado a 100 ms; una petición y ningún respaldo.
- `rejects immediately when parent aborts while provider hangs forever ignoring signal`: abortar a 15 ms virtuales rechaza con el motivo exacto, sin esperar proveedor o timeout; un intento y ninguna transición de respaldo. Se conserva el aborto previo síncrono.
- Se conservaron las pruebas de validación de respuesta, fallos de ambos modelos y capacidad. No se borraron ni omitieron pruebas, ni se solucionó el problema aumentando tolerancias reales.

Todos los comandos se ejecutaron dentro de la carpeta del proyecto; `cd <proyecto>` representa la ruta de desarrollo que entonces estaba en Desktop.

| Comando | Fase | Resultado | Duración |
|---|---|---|---:|
| `node --test test/unit/summarizer.test.mjs` | RED | 12/13; un fallo intencional | 7,001 s |
| `node --test test/unit/summarizer.test.mjs` | GREEN | 13/13 | 5,671 s |
| `node --test` | Completa | 146/146 en 10 suites; instalador 89/89 sin cambios | 26,481 s |
| `node --test test/unit/summarizer.test.mjs` | Repetición sin cambios | 13/13 | 10,989 s |

Los controles finales salieron con código 0, sin fallos, cancelaciones, omisiones ni tareas pendientes. Hubo tres ejecuciones enfocadas, contando RED; no una repetición indefinida hasta esconder un fallo. `ExperimentalWarning` de MockTimers no impidió simular `Date` y `setTimeout` en el runtime probado. El diagnóstico esperado de fuente ausente apareció durante su prueba negativa, que aprobó.

Esto no demuestra la demora exacta del host que causó el fallo histórico, la compatibilidad de futuras versiones de MockTimers ni la disponibilidad futura del proveedor.

## Verificación anterior del instalador (2026-10-01)

TDD estricto elegido explícitamente por el usuario; perfil observado `openai-codex/gpt-6.1-sol/high`. Sin despliegue, comprobación real de autenticación/API, cambios de dependencias, staging ni commits.

### Estado parcial recibido

La carpeta seguía sin seguimiento bajo el repositorio padre de Desktop. Se conservaron las correcciones previas de rechazo de drift por loader/campos ausentes y compensación inversa. Faltaban validaciones de baseline: valores presentes nulos/ausentes, registros de tokens opcionales, presencia/valor contradictorios y estados vacíos inconsistentes. La compensación dejaba de procesar operaciones si una restauración lanzaba un error. También se corrigió un mensaje de esquema: `managedModels` frente a `missing managed model`.

Comando de cada fila: `node --test`, desde la raíz del proyecto.

| Fase | Pruebas | Aprobadas | Fallidas | Suites | Duración | Código |
|---|---:|---:|---:|---:|---:|---:|
| RED, regresiones antes de implementar | 143 | 123 | 20 | 10 | 16,902 s | 1 |
| GREEN, implementación mínima | 143 | 143 | 0 | 10 | 22,714 s | 0 |
| Triangulación, publicación/orden | 145 | 144 | 1 | 10 | 13,900 s | 1 |
| Repetición completa sin cambios | 145 | 145 | 0 | 10 | 21,683 s | 0 |

Sin cancelaciones, omisiones ni tareas pendientes. Los dos últimos controles aprobaron las 89 pruebas del instalador.

### Evidencia y límites de cobertura

- Manifiestos producidos por el setup real en fixtures temporales se corrompieron campo por campo. RED observó `Missing expected exception` ante valores presentes nulos/ausentes, registros ausentes, contradicciones, `originalEmpty` inválido, valor ausente incorrecto, entradas extra, loader ajeno y tokens originales inválidos. El caso array y ciertos registros ya rechazados aprobaron RED; no se les atribuye un nuevo fallo.
- Una regresión eliminó realmente loader y manifiesto antes de fallar al restaurar el manifiesto. RED dejó settings sin restaurar; GREEN continuó las compensaciones restantes y retuvo el journal.
- La desaparición independiente de loader, overrides, modelo, `reserveTokens` o `keepRecentTokens` se rechazó sin cambiar bytes ni crear backups/journal; setup y rollback, incluso rutas force/dry-run. Eran correcciones recibidas: no se inventa RED nuevo para ellas.
- Se conservaron y reforzaron regresiones posteriores a la eliminación de loader/manifiesto; compensación completa restauró sus bytes exactos junto con settings, limpió el journal y liberó el lock.
- Reemplazos ajenos quedaron intactos y bloquearon siguientes operaciones mediante journal privado. Orden observado: `manifest -> loader -> settings`. La publicación exclusiva por hard link rechazó un loader ajeno sin sobrescribirlo, mientras las compensaciones restantes restauraron settings.
- Reinstalar conservó el baseline; sobrevivieron rollback valores de token cero, modelos originalmente vacíos, campos/modelos ausentes y claves personalizadas ajenas.
- Journal y backups: `0600`, directorio de estado: `0700`. Locks liberados en los fallos probados. Fixtures sintéticos, sin copiar credenciales ni el contenido del home real.

### Fallo intermitente observado entonces

La tercera ejecución falló en `safely ignores late resolve or reject after attempt timeout without unhandled rejection`, `test/unit/summarizer.test.mjs:119`, `assert.ok(result.summary)`. Había aprobado RED/GREEN y aprobó la repetición final sin cambios. En ese momento la causa no estaba verificada y no se aceptó como excepción ambiental; la entrega fue parcial aunque el instalador estuviera aprobado. La sección inicial documenta la corrección posterior de la expectativa de esta prueba.

## Tanda histórica inicial de correcciones

Estos resultados preceden a las tandas anteriores; **no representan la suite actual**. Comando: `node --test` desde el proyecto.

| Fase | Pruebas | Aprobadas | Fallidas | Suites | Canceladas | Duración |
|---|---:|---:|---:|---:|---:|---:|
| RED | 80 | 66 | 14 | 10 | 0 | ~9,99 s |
| GREEN | 81 | 81 | 0 | 10 | 0 | ~11,47 s |

### Fallos iniciales observados

- Diez casos del instalador: rollback sin manifiesto modificaba settings; loader sin manifiesto no se rechazaba; baseline corrupto no se validaba; faltaban drift/CAS/presencia de settings; faltaban journal/compensación de setup y rollback; faltaba directorio privado de estado; flags sin valor no se rechazaban.
- Resumidor: no se comprobaba `contextWindow` antes de pedir el modelo principal demasiado pequeño.
- Ciclo de extensión: `attemptCount` daba 1 en vez de 2 tanto para respaldo exitoso como para transición al compactor nativo.
- SDK público: fallaba la segunda compactación mediante `session.prompt` al conservar listas de archivos.

### Distribución GREEN histórica

| Suite | Pruebas aprobadas |
|---|---:|
| Durabilidad y simulación de actualización del loader | 2 |
| Ciclo de vida de la extensión | 5 |
| Integración con SDK público | 4 |
| Scripts de despliegue | 25 |
| Configuración | 4 |
| Construcción de contexto | 7 |
| Clasificación/sanitización de errores | 10 |
| Resumidor | 12 |
| Telemetría | 7 |
| UI y contador de herdr | 5 |

Cobertura histórica: descubrimiento por jiti y persistencia a disco; mensajes sintéticos de ~850.000 caracteres; ciclos múltiples y archivos acumulados; autenticación previa al hook; baseline/CAS/journal/rollback/propiedad; XML escapado y límites del prompt completo; timeout, aborto, respaldo y asentamientos tardíos; allowlist numérica profunda/rotación/permisos de telemetría; una adquisición balanceada de `herdr:blocked`, sin liberar bloqueos ajenos.

La prueba histórica de fuente ausente solo afirmaba una extensión descubierta; descubrir una extensión o ver cero errores no basta para demostrar que sus hooks están activos. La verificación independiente del empaquetado posterior comprobó explícitamente los cuatro hooks con `DefaultResourceLoader` en instalación, actualización y rollback de fuente. No se modifica retroactivamente la evidencia histórica.
