# Evidencia de R2A: SDK portable y dependencias

## Alcance y perfil

Unidad limitada a `src/pi-sdk.mjs`, tres pruebas de integración, `package.json`,
`package-lock.json`, `.gitignore` y este registro. Las dependencias y fixtures
sintéticos generados permanecen dentro de `node_modules/`, excluido de Git.
No se modificaron los demás módulos del motor, los scripts de setup/rollback,
la instalación activa ni el estado del agente. No se ejecutaron operaciones Git,
traslados, publicación ni actualización de paquetes globales.

El paquete declara `private: true`, `license: "UNLICENSED"`, descripción en español
y repositorio privado de destino `https://github.com/wilkinbarban/pi-auto-compaction`.
Ambas dependencias de desarrollo están fijadas exactamente en `0.87.1`:
`@earendil-works/pi-coding-agent` y `@earendil-works/pi-ai`. No se añadió un rango
peer de compatibilidad. Sus `package.json` locales instalados confirman
`engines.node: ">=22.19.0"`; el paquete declara el mismo mínimo.
El script de pruebas sigue siendo `node --test`.

## Contrato observado

- `loadPiSDK()` conserva los exports del SDK y devuelve la misma instancia.
- `PI_CODING_AGENT_PATH` explícito tiene prioridad y falla cerrado si es inválido;
  acepta directorio de paquete, archivo de entrada o URL `file:`.
- Sin override, el SDK local tiene prioridad sobre instalaciones globales.
- El fallback conserva el directorio estándar bajo `os.homedir()` y los
  directorios globales del sistema. Lee el export `import` del paquete, sin
  asumir un archivo `dist/index.js`.
- `loadPiAI(subpath)` usa los exports del paquete AI situado junto al SDK
  seleccionado, incluido un AI anidado; rechaza subpaths inválidos o no exportados.
- Las dos integraciones antes dependientes de rutas personales ahora usan el
  helper. La simulación durable selecciona explícitamente el SDK local para no
  depender de la instalación global real. Auth/modelos y respuestas son sintéticos.
- `.gitignore` excluye dependencias y artefactos privados de ejecución, conserva
  fixtures sintéticos versionables y no excluye `package-lock.json`.

> **Nota sobre la representación de rutas históricas**: Las ejecuciones de comandos registradas históricamente en este documento se ejecutaron originalmente en la carpeta de desarrollo situada entonces en Desktop. Para evitar exponer rutas absolutas locales y reflejar la ruta canónica del proyecto (`$HOME/proyectos/pi-auto-compaction`), los comandos se representan aquí de forma genérica normalizada. Esta normalización es una representación documental histórica; dicha representación histórica de comandos no significa que hayan sido movidos ni que se hayan vuelto a ejecutar.

## TDD estricto: evidencia ejecutada

Modo activado por elección explícita previa, reenviada por el padre.

1. **RED**, antes de implementar:
   `cd "$HOME/proyectos/pi-auto-compaction" && node --test test/integration/portability.test.mjs`
   terminó con código **1**, **2 pruebas fallidas, 0 aprobadas**.
   El override inexistente fue ignorado y el proceso terminó con estado 0;
   el segundo fallo observó `loadPiAI` como `undefined`.
2. **GREEN**, después del helper, dependencias e imports:
   el mismo comando terminó con código **0**, **5 aprobadas, 0 fallidas**.
3. **Triangulación/refactor**: se verificaron prioridad local sin consultar home,
   override válido por directorio y URL, AI anidado con nombres de export no
   convencionales, fallback home sintético y rechazo de subpaths.
   Tras usar `pathToFileURL` en las fixtures y aislar el SDK de la copia durable,
   el comando focalizado volvió a terminar con código **0**, **5/5 aprobadas**.
   El fallback se ejercita con un loader de prueba que simula ausencia del SDK
   local; no constituye evidencia de un clon limpio ni de otra plataforma.

## Comandos y resultados

Todos los comandos se ejecutaron individualmente y en primer plano.

| Comando exacto | Resultado observado |
| --- | --- |
| `cd "$HOME/proyectos/pi-auto-compaction" && node --test test/integration/portability.test.mjs` | RED: código 1, 0/2 aprobadas; GREEN: código 0, 5/5; última ejecución tras refactor: código 0, 5/5. |
| `cd "$HOME/proyectos/pi-auto-compaction" && npm install --ignore-scripts` | Primer intento: código 1, `EJSONPARSE` por una coma omitida en la edición de `package.json`. Corregida la coma, segundo intento: código 0, 118 paquetes añadidos, 119 auditados, 0 vulnerabilidades informadas. Se generó el lockfile; no se ejecutó `audit fix`. |
| `cd "$HOME/proyectos/pi-auto-compaction" && npm test` | Primera ejecución: código 0, 151 aprobadas en 10 suites, 0 fallidas/omitidas/canceladas. Última ejecución tras refactor y aislamiento durable: código 0, **151 aprobadas**, 10 suites, 0 fallidas/omitidas/canceladas. |

La suite imprime el error esperado del caso de fuente durable ausente, que aprueba,
y un aviso de MockTimers experimental. La instalación informó deprecación de
`node-domexception@1.0.0`; no se cambiaron versiones para eliminar el aviso.

## Pendiente fuera de esta unidad

Documentación de instalación/mantenimiento y wrappers quedan para la siguiente
unidad. La verificación independiente de clon limpio/`npm ci`, privacidad,
otras plataformas y entrega Git permanece pendiente; no se afirma realizada.

# Evidencia de R2B: despliegue durable por releases

## Alcance y contrato implementado

Se añadieron únicamente `scripts/deploy.mjs` y
`test/integration/deploy.test.mjs`; esta sección se agregó sin reemplazar R2A.
No se modificaron el motor, el helper SDK, setup/rollback, dependencias,
scripts de package ni README. La instalación activa no se utilizó como fixture.
Todas las instalaciones nuevas, cambios de settings y fallos inyectados del
wrapper se ejecutaron contra fuentes copiadas y agentes temporales sintéticos.

El wrapper exporta `runDeploy(options, dependencies)` y `parseDeployArgs(args)`.
La CLI admite instalación nueva sin modo, `--update`, `--rollback-source`,
`--dry-run`, `--agent-dir`, `--install-dir`, `--source-dir` y `--help`.
No implementa ni anuncia doctor. Los modos update/rollback son excluyentes;
argumentos desconocidos, duplicados y valores ausentes son errores.

Defaults: fuente relativa al archivo del paquete, no al cwd;
agente `PI_CODING_AGENT_DIR` o `os.homedir()/.pi/agent`, conforme al contrato
observado en el setup existente; instalación
`os.homedir()/.local/share/pi-auto-compaction`. Este registro no afirma una
verificación independiente de la documentación del SDK sobre ese default.
Los hijos reciben target/source explícitos y entorno vacío: no importan el
SDK ni consultan auth o providers para validar/copiar/instalar.

La raíz requiere el marker `.pi-auto-compaction-deploy.json`, esquema/version
exactos, ownership del usuario, binding al agente y rutas absolutas canónicas.
Una raíz preexistente sin marker, incluso vacía o con instalación legacy plana,
se rechaza: **adopción pendiente de consentimiento, nunca automática**.
Se rechazan symlinks en ancestros y archivos administrados, rutas solapadas,
manifest de otro source/agente, drift, locks y journals pendientes.

La copia incluye únicamente `index.mjs`, `package.json`, `src/*.mjs`,
`scripts/setup.mjs`, `scripts/rollback.mjs` y README opcional.
No copia dependencias, Git, tests ni artefactos de ejecución fuera de esa lista.
Valida metadata del paquete sin dependencias de producción, sintaxis mediante
el parser nativo `vm.SourceTextModule` en un hijo aislado, imports estáticos y
los imports dinámicos literales contra la lista. No evalúa los módulos ni
importa index. Los imports SDK calculados siguen siendo responsabilidad del
helper portable existente; esto **no es un sandbox para código fuente hostil**.
La API VM usada requiere `--experimental-vm-modules` solamente en ese hijo.

Cada release usa `releases/<sha256>` con marker `.release.json`, lista exacta de
archivos y hashes. Se verifica el contenido antes de usarlo, reutilizarlo o
hacer rollback; el wrapper nunca sobrescribe fuentes de releases existentes.
La inmutabilidad es una regla del wrapper verificable por hash, no un bloqueo
de escritura impuesto al dueño del filesystem. Setup recibe la ruta absoluta
del release validado y mantiene su baseline original. Un update del mismo
hash no cambia loader, settings, marker ni release anterior. Rollback selecciona
exactamente el anterior usando su setup, no el rollback que elimina config;
consume ese paso anterior, por lo que repetirlo no alterna versiones.
Las fuentes viejas y staged huérfanas no se borran: sesiones Pi abiertas pueden
seguir referenciándolas hasta recarga/reinicio. Limpieza futura queda manual.

## Transacción y límites

El wrapper usa su lock privado, marker pending antes del setup y journals
privados persistentes bajo `journals/`. Publica current/previous solamente tras
setup exitoso y validación del manifest/baseline. Si falla la publicación,
reinstala el release previo; para una instalación nueva usa el rollback oficial
solo después de comprobar ownership de su manifest/loader. Si el setup ya
compensó y dejó los bytes iniciales, no lo ejecuta de nuevo.
Si falla la compensación o aparece drift, conserva marker pending y journal:
la siguiente invocación, incluso dry-run, exige reconciliación manual.
No se promete atomicidad entre ambos manifiestos ante caída del proceso,
ni seguridad contra un proceso hostil del mismo usuario que cambie rutas
entre comprobaciones. Un lock retenido tras crash no se elimina automáticamente.
Backups, contenedores vacíos de settings y fuentes staged pueden persistir
tras un fallo inicial; no se promete restaurar la ausencia de todos los archivos.

`--dry-run` valida fuentes, ownership, manifest, drift y release seleccionado,
pero no ejecuta setup/rollback, copia archivos, crea directorios ni cambia
settings/markers. El setup existente no se usa como dry-run porque crea su
directorio de estado incluso en ese modo.

## TDD estricto y comandos observados

Modo on por elección explícita previa reenviada por el padre.
Todos los comandos se ejecutaron individualmente, en primer plano.

| Comando exacto | Resultado observado |
| --- | --- |
| `cd "$HOME/proyectos/pi-auto-compaction" && node --test test/integration/deploy.test.mjs` | RED inicial: código 1, módulo deploy ausente. RED de comportamiento con exports provisionales sin implementación: código 1, **0/10 aprobadas**, instalación/update/rollback no creaban release ni loader; los rechazos tampoco cumplían el contrato. |
| `cd "$HOME/proyectos/pi-auto-compaction" && node --test test/integration/deploy.test.mjs` | Primera implementación: código 1, 2/10 aprobadas; el chequeo textual confundía el import type del loader-template con dependencia ejecutable. Se reemplazó por parsing nativo sin evaluación. GREEN: código 0, **10/10 aprobadas**. |
| `cd "$HOME/proyectos/pi-auto-compaction" && node --test test/integration/deploy.test.mjs` | Después de refactorizar el parsing a un hijo por conjunto y triangular fallos reales: código 0, **12/12 aprobadas**, sin omitidas/canceladas. |
| `cd "$HOME/proyectos/pi-auto-compaction" && npm test` | Código 0, **163 aprobadas**, 10 suites, 0 fallidas/omitidas/canceladas. |

Las 12 pruebas incluyen instalación de fuentes reales copiadas, cuatro modelos,
preservación del baseline, update idempotente, rollback de source, legacy sin
adopción, dry-run nuevo y managed, source/manifest ajenos, symlinks, metadata
inválida y release anterior mutado. Se inyectaron fallos de hijo, fallo real del
setup al escribir manifest, fallo de publicación fresh/update y compensación
fallida seguida de rechazo fail-closed. La suite completa conserva el mensaje
esperado de fuente ausente en durability y el aviso experimental de MockTimers.
Una edición de tests no se aplicó por oldText inexistente; se corrigió el target
y la siguiente edición se aplicó, sin cambios parciales de esa llamada fallida.

## Pendiente para el padre

La verificación independiente del loader oficial sobre estos releases y un
clon limpio, documentación R2C, CI y evaluación de privacidad siguen pendientes.
No se ejecutaron comandos de entrega Git, instalaciones npm, actualizaciones
globales ni cambios en la instalación activa. Esta unidad coherente supera la
heurística de 400 líneas al incluir wrapper, pruebas de compensación y evidencia;
revisar especialmente las transiciones pending/ready y el rollback del source.

## Aprendizajes comprobados

1. El dry-run del setup existente crea su directorio de estado.
2. Reinstalar el source conserva el baseline original del manifest.
3. Los imports incluidos en templates no son dependencias ejecutables.
4. El rollback de source necesita setup del release anterior.
5. Una compensación fallida conserva un marker pendiente verificable.

### Confirmación documental posterior del default

Se leyó completo el archivo local del SDK fijado 0.87.1
`node_modules/@earendil-works/pi-coding-agent/docs/environment-variables.md`.
Su tabla «Pi Process Configuration» confirma que `PI_CODING_AGENT_DIR`
sobrescribe el directorio de configuración y que el default es `~/.pi/agent`.
Esto resuelve la salvedad documental del párrafo de defaults anterior, sin
consultar la instalación global ni archivos reales de configuración/auth.

# Evidencia de R2C: Documentación en español, aliases de paquetes, CI y verificación

## Alcance y cambios realizados

Unidad limitada a la documentación técnica completa en español, configuración del flujo de GitHub Actions, incorporación de aliases de ejecución en `package.json` y este registro de evidencia. No se modificaron el código de ejecución en `src/`, las pruebas en `test/`, el archivo de bloqueo `package-lock.json` ni la instalación activa del sistema. El archivo `test-evidence.md` no se modificó, conforme a la instrucción expresa.

Archivos modificados y añadidos:
- `package.json`: Se agregaron los aliases de scripts `"deploy"`, `"setup"` y `"rollback"` apuntando a sus scripts respectivos bajo `scripts/`, sin añadir scripts de ciclo de vida automáticos (`install`, `postinstall`).
- `.github/workflows/ci.yml`: Flujo de integración continua para eventos push en `main`, pull requests y `workflow_dispatch`, con matriz Node.js 22 y 24 sobre `ubuntu-latest`, permisos de solo lectura (`contents: read`), checkout v4, setup-node v4 con caché npm, `npm ci --ignore-scripts` y `npm test`. No utiliza secretos ni proveedores externos. Nota: la ejecución remota de CI no ha sido verificada aún en GitHub Actions.
- `README.md`: Documentación principal en español con guía de clonado rápido, comandos verificados, descripción de características y enlaces relativos a la documentación detallada.
- `docs/instalacion.md`: Guía paso a paso de instalación, separación entre fuente, releases, loader y manifest, uso de CLI, modo `--dry-run` de solo lectura y adopción consciente de raíces no gestionadas.
- `docs/mantenimiento.md`: Ciclo de actualización limpia con `git pull --ff-only`, rollback de código (`--rollback-source`) frente a desinstalación de configuración (`rollback.mjs`), preservación de baseline, detección de drift y manejo de journals en estado `pending`.
- `docs/arquitectura.md`: Explicación detallada del flujo de compactación desacoplado, integración con hooks del SDK de Pi (`session_before_compact`, etc.), advertencia crítica sobre autenticación previa requerida para el modelo de conversación, resumidores primario/secundario en OmniRoute, fallback nativo condicional, umbrales de tokens (~76% / 206.464 tokens sobre 272.000), coordinación con herdr y privacidad de telemetría.
- `docs/solucion-de-problemas.md`: Diagnóstico y remediación de problemas frecuentes: credenciales de conversación no válidas, fallos de infraestructura compartida en OmniRoute, recuperación de estado `pending`, resolución de drift y rechazo de raíces preexistentes.
- `CONTRIBUTING.md`: Guía de contribución con disciplina de TDD estricto, aislamiento mediante fixtures desconectados (offline) sin credenciales reales ni red, y procedimiento para mantener la fijación exacta de dependencias del SDK de Pi.
- `SECURITY.md`: Política de seguridad para repositorio privado (`UNLICENSED`), contacto privado con el propietario, sin reclamos de avisos públicos de seguridad y detalle sobre la privacidad de la telemetría local frente a la transmisión cifrada obligatoria a los resumidores de OmniRoute.
- `CHANGELOG.md`: Registro inicial versión 1.0.0 describiendo todas las capacidades incorporadas, sin asumir la publicación de releases en GitHub.
- `AGENTS.md`: Directrices en español para agentes y asistentes sobre comandos autorizados, privacidad, prohibición de parches sobre productos instalados y continuidad opcional con Engram.

## TDD y justificación de disciplina

El modo de TDD estricto se mantuvo activo por elección previa. Dado que esta unidad corresponde estrictamente a documentación técnica en Markdown, configuración declarativa de CI y alias de conveniencia en `package.json` sin alteraciones en la lógica ni nuevo comportamiento en tiempo de ejecución, no aplica una fase RED de fallo sintético en código. Se verificó que `package.json` parsea correctamente como JSON y que todos los enlaces relativos entre documentos Markdown existen en el sistema de archivos sin enlaces rotos.

## Comandos y resultados observados

Todos los comandos se ejecutaron individualmente en primer plano:

| Comando exacto | Resultado observado |
| --- | --- |
| `cd "$HOME/proyectos/pi-auto-compaction" && node scripts/deploy.mjs --help` | Código 0. Salida observada: `Uso: node scripts/deploy.mjs [--update \| --rollback-source] [--dry-run] [--agent-dir DIR] [--install-dir DIR] [--source-dir DIR]` seguido de `Sin modo: instalación nueva. No adopta instalaciones existentes. Reiniciá/recargá Pi para cargar la nueva fuente.`. |
| Validación sintáctica de `package.json` | Código 0. `node -e "JSON.parse(require('fs').readFileSync('package.json', 'utf8'))"` ejecutó sin errores. |
| Validación de enlaces Markdown relativos | Código 0. Script de verificación analizó `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`, `AGENTS.md` y todos los archivos bajo `docs/`, confirmando que todos los destinos relativos existen sin excepciones. |

## Estado de entrega

Unidad R2C completada con éxito. Queda disponible para revisión nativa y posterior entrega de Git por el proceso padre.

# Evidencia de Corrección R2C: Ajustes factuales de documentación, CLI y enlaces

## Alcance y justificación

Corrección documental estricta tras la verificación independiente de R3 (resultado PARTIAL en docs / 17/17 PASS en validaciones técnicas previas). No se modificó el código de ejecución en `src/`, las pruebas en `test/`, la instalación plana activa de Pi ni los archivos de configuración/estado.

Ajustes realizados en la documentación:
1. **Migración legacy no implementada**: Se clarificó en `docs/instalacion.md` y `docs/solucion-de-problemas.md` que `deploy.mjs` rechaza un agente ocupado (`Foreign agent manifest/loader: ownership refused`) incluso si se especifica un nuevo `--install-dir`. No existe comando de adopción en este momento; la instalación actual de Wilkin funciona intacta y el wrapper está disponible para agentes limpios.
2. **Campos reales del marcador y rutas de journals**: Se corrigieron las referencias en todas las guías: el marcador `.pi-auto-compaction-deploy.json` utiliza `state`, `current`, `previous` y `pending` (no `status` ni `currentRelease`). Los journals de despliegue residen en `<install-dir>/journals/` y el journal de recuperación de agente en `<agent-dir>/.pi-auto-compaction-state/recovery-journal.json`. Se explicitó que `$HOME/.local/state/pi-auto-compaction` es exclusivo para telemetría.
3. **Detección de drift y baseline original**: Se documentó que el drift compara contra `expectedManagedValues` en el manifiesto, mientras que `originalOverrides` se mantiene inmutable únicamente para la desinstalación (`rollback.mjs`). Se preservan las configuraciones ajenas y nunca se recomienda editar settings a ciegas ni eliminar marcadores.
4. **Consistencia de rutas en comandos**: Se definieron `AGENT_DIR` e `INSTALL_DIR` en las guías de instalación y mantenimiento, asegurando que todos los comandos utilicen `--agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"` y `--target-dir "$AGENT_DIR"`.
5. **Comportamiento exacto de comandos**: Se documentó que `deploy` sin flags es exclusivamente para instalación inicial; que `--rollback-source` repetido es un no-op limpio (no error ni toggle); que la desinstalación (`rollback.mjs`) retiene el marcador en el directorio de instalación y que la reinstalación posterior requiere reconciliación manual explícita. Se documentó la retención de releases antiguos sin limpieza automática.
6. **Estado de Node.js y CI**: Se aclaró que la matriz Node.js 22 y 24 está configurada en GitHub Actions, pero la ejecución remota de CI está pendiente tras el primer push; localmente se validó en Node 22.23.2 con SDK 0.87.1. Se requiere Node.js >= 22.19 sin prometer soporte para todas las versiones futuras.
7. **Autenticación previa, razonamiento y privacidad**: Se aclaró que la verificación previa del SDK de Pi valida credenciales de autenticación en `auth.json`, no cuota universal del proveedor. Se explicitó que `reasoningEffort: "low"` se aplica únicamente a modelos con capacidad de razonamiento (`model.reasoning`). Se eliminó el campo ficticio `tokensAfter` (solo existe `tokensBefore`). Se diferenció la transmisión deliberada del contexto a OmniRoute frente a la persistencia local exclusiva de metadatos cuantificables en telemetría.
8. **Normalización de comandos históricos**: Se normalizaron las líneas de comandos históricas previas con la ruta canónica `$HOME/proyectos/pi-auto-compaction` y la nota aclaratoria correspondiente.

## TDD y verificación estática

TDD activo en modo sin RED de código ejecutable por ser una corrección puramente documental y declarativa. Se ejecutaron validaciones estáticas de lectura de enlaces Markdown, sintaxis JSON y comprobación de identificadores documentados.

# Evidencia M2: Implementación de `--adopt-agent`, compensación CAS y teardown de fixtures

## Alcance y cambios realizados

Implementación transaccional acotada de la tarea M2 bajo TDD estricto:
- **`scripts/deploy.mjs`**: Incorporación de la bandera `--adopt-agent` mutuamente excluyente con `--update` y `--rollback-source`. Validación fail-closed de prerrequisitos de adopción antes de cualquier escritura: agente previamente gestionado con manifiesto `1.0.0` y loader oficial coincidente en hash, chequeo de drift en los 4 modelos gestionados, ausencia de locks y journals en el agente, verificación de fuente antigua válida e inmutable (`packageSourceDir`), raíz destino managed nueva e inexistente, y ausencia de symlinks inseguros o colisiones. En caso de fallo en setup o publicación, compensación segura mediante CAS que preserva cambios concurrentes de terceros, restaura los bytes del estado anterior del agente sin eliminar el baseline, y retiene el journal y marcador `pending` si la compensación no puede completarse de forma limpia. Marcador inicializado con `previous: null`.
- **`test/integration/deploy.test.mjs`**: Registro de teardown por prueba (`t.after` y `afterEach`) sobre directorios temporales `pi-deploy-test-*` creados durante la ejecución, asegurando su eliminación incluso en pruebas fallidas sin tocar residuos preexistentes. Pruebas de integración para: adopción exitosa preservando baseline y fuente antigua; `--update` subsiguiente preservando la línea base original; modo `--dry-run` de solo lectura sin escrituras; rechazo previo a escrituras por manifiesto ausente, loader ajeno, hash discordante, drift de configuración, locks, journals, symlinks y colisión de raíz; compensación ante fallo de setup; preservación de mutaciones concurrentes en publicación con retención de journal; y regresión de teardown efectivo.
- **`test/integration/portability.test.mjs`**: Registro de teardown con `t.after` y `afterEach` sobre directorios temporales sintéticos en `node_modules/.pi-portability-*` y prueba de regresión de teardown.
- **Documentación**: Actualización en español de `README.md`, `docs/instalacion.md`, `docs/mantenimiento.md` y `docs/solucion-de-problemas.md` detallando la bandera `--adopt-agent`, sus prerrequisitos de validación, límites de rollback (no-op sobre primera release adoptada y reversión vía el setup oficial de la fuente antigua preservada), recarga obligatoria de sesiones Pi mediante `/reload`, retención indefinida de fuentes y releases históricos, y el estado pendiente de la reinstalación tras un rollback de configuración.

## Disciplina TDD y evidencia observada

### 1. Fase RED (Fallo observado antes de la implementación)
Se agregaron las nuevas pruebas en `test/integration/deploy.test.mjs` y se ejecutó la suite de integración antes de modificar `scripts/deploy.mjs`:
- **Comando**: `cd "$HOME/proyectos/pi-auto-compaction" && node --test test/integration/deploy.test.mjs test/integration/portability.test.mjs`
- **Resultado observado**: Código de salida 1. 19 pruebas pasadas, 6 pruebas falladas como se esperaba:
  - `successful adopt occupied valid agent preserves baseline/nonmanaged settings and old source unchanged loader/new marker ready`: Falló con `Foreign agent manifest/loader: ownership refused`.
  - `--update later works and original baseline preserved on adopted agent`: Falló con `Foreign agent manifest/loader: ownership refused`.
  - `dry run read only for adoption`: Falló con `Foreign agent manifest/loader: ownership refused`.
  - `adopt missing manifest/foreign loader/bad hash/settings drift/lock/journal/symlinks/root collision invalid schema source invalid args rejects BEFORE writes`: Falló con `Foreign agent manifest/loader: ownership refused`.
  - `failed setup/adoption post validation failure compensate old source`: Falló con `Foreign agent manifest/loader: ownership refused`.
  - `concurrent foreign state at publication never overwrite/retain journal`: Falló por rechazo inicial.

### 2. Fase GREEN (Paso de pruebas tras implementar `--adopt-agent`)
Tras implementar la lógica de adopción y compensación en `scripts/deploy.mjs`, se ejecutó nuevamente la verificación:
- **Comando**: `cd "$HOME/proyectos/pi-auto-compaction" && node --test test/integration/deploy.test.mjs test/integration/portability.test.mjs`
- **Resultado observado**: Código de salida 0. **25 pruebas pasadas de 25** (19 preexistentes + 6 nuevas).

### 3. Fase TRIANGULATE / REFACTOR (Suite completa anterior)
Se ejecutó la suite de pruebas completa del proyecto previa a los hallazgos de M3:
- **Comando**: `cd "$HOME/proyectos/pi-auto-compaction" && npm test`
- **Resultado observado**: Código de salida 0. **171 pruebas pasadas de 171** en 10 suites (0 fallidas, 0 canceladas, 0 omitidas). Duración aproximada: 49 s.

# Evidencia de Corrección CAS M2: Compensación segura contra cambios concurrentes y verificación completa

## Alcance y justificación

Corrección de seguridad transaccional en `scripts/deploy.mjs` y adición de pruebas de regresión en `test/integration/deploy.test.mjs`, originadas a partir del reporte del verificador independiente M3 que demostró cuatro fallos CAS (sobreescritura de cambios concurrentes en settings de compactación, loader validado solo por inclusión de subpath, manifest validado solo por packageSourceDir y captura global de marker forzando pending sobre metadatos ajenos).

Los cambios en código de despliegue y pruebas fueron implementados previamente bajo TDD estricto y verificados en la fase de mapeo del incidente (`muprss3m-l-yo7r`). Esta unidad cierra formalmente la documentación técnica, los registros de evidencia y la auto-verificación completa requerida tras la interrupción por error 503 del escritor anterior.

No se modificaron archivos del motor en `src/`, fixtures no autorizadas ni la instalación plana productiva o raíz gestionada en el sistema.

## Disciplina TDD y evidencia observada

### 1. Evidencia RED previa observada por el mapper (`muprss3m-l-yo7r`)
Previo a la implementación de las guardas CAS, las 5 nuevas pruebas fallaron de forma determinística en `test/integration/deploy.test.mjs`:
- **Comando**: `cd "$HOME/proyectos/pi-auto-compaction" && node --test test/integration/deploy.test.mjs`
- **Resultado observado**: Código de salida 1 en 26.88 s. **19 pruebas pasadas, 5 pruebas falladas**:
  - `compensation preserves concurrent modifications within compaction settings byte-identical and retains journal`
  - `compensation preserves concurrent foreign loader containing target path byte-identical and retains journal`
  - `compensation preserves concurrent foreign manifest baseline byte-identical and retains journal`
  - `foreign marker is preserved byte-exact and catch does not overwrite with pending`
  - `post-publication mutation of baseline fails closed, preserves foreign manifest and retains pending journal`

### 2. Evidencia GREEN observada tras las guardas CAS (`muprss3m-l-yo7r`)
Tras aplicar la validación CAS estricta en compensación y publicación:
- **Comando**: `cd "$HOME/proyectos/pi-auto-compaction" && node --test test/integration/deploy.test.mjs`
- **Resultado observado**: Código de salida 0 en 21.55 s. **24 pruebas pasadas de 24** (19 preexistentes + 5 nuevas de CAS).
*(Nota: La suite completa `npm test` no había sido ejecutada previamente por el escritor debido a una interrupción 503 aguas arriba; no se realizó ninguna afirmación previa de ejecución completa antes de esta verificación).*

### 3. Verificación de cierre ejecutada en primer plano

Todos los comandos fueron ejecutados de forma individual en primer plano, utilizando rutas canónicas normalizadas con `$HOME/proyectos/pi-auto-compaction`:

| Comando exacto | Resultado observado |
| --- | --- |
| `cd "$HOME/proyectos/pi-auto-compaction" && node --test test/integration/deploy.test.mjs test/integration/portability.test.mjs` | Código de salida 0. **30 pruebas pasadas de 30** (24 en `deploy.test.mjs` + 6 en `portability.test.mjs`), 0 fallidas, 0 canceladas, 0 omitidas. Duración observada: ~27.2 s. |
| `cd "$HOME/proyectos/pi-auto-compaction" && npm test` | Código de salida 0. **176 pruebas pasadas de 176** en 10 suites, 0 fallidas, 0 canceladas, 0 omitidas. Duración observada: ~32.2 s. |

Con esta ejecución, la suite completa asciende de 171 a **176 pruebas aprobadas al 100%**, confirmando la solidez de las guardas CAS y la ausencia de regresiones en los módulos de configuración, contexto, errores, resumen, telemetría, UI, scripts de despliegue, durabilidad y portabilidad.

# Evidencia M3: Resolución de bloqueadores de reverificación y endurecimiento documental

## Alcance y justificación

Resolución de los tres bloqueadores restantes identificados en la reverificación independiente de M3 (`/tmp/pi-m3-reverify-bVQafV/faults.json`):
1. **Eliminación de la heurística de ventana temporal (`±10s`) en compensación**: Sustitución de comparaciones de holgura temporal en `isOwnManifest` (`Math.abs(Date.parse(...) - ...) <= 10_000`) por la captura y verificación exacta de post-imágenes conocidas (`knownPostimage`) tras el setup, validación estricta de esquema (`exact`) en manifiestos y comprobación determinista contra metadatos en disco (`mtimeMs` de la escritura atómica y timestamp de respaldo en `.pi-auto-compaction-state`). Si el manifiesto fue mutado (incluso por variaciones de `installedAt` dentro de la ventana de setup), la compensación rechaza la sobreescritura, preserva los bytes foráneos intactos y retiene el journal y marcador en estado `failed`/`pending`.
2. **Validación completa de snapshot y marcador post-commit**: Inclusión de validación de esquema exacto (`exact`) para el marcador de despliegue y comprobación de igualdad estricta contra `next`. Validación de esquema sin campos desconocidos en el manifiesto (`exact`) tras el commit. Si un hook de commit o proceso concurrente inyecta campos no autorizados en el manifiesto o altera el marcador, la operación falla cerrado, preserva los bytes mutados sin sobreescritura ciega, retiene el journal en estado `failed` y no retorna `success: true` ni `state: "ready"`.
3. **Endurecimiento de procedimientos de backup y corrección de error real de desincronización**: Actualización de `docs/instalacion.md`, `docs/mantenimiento.md` y `docs/solucion-de-problemas.md`:
   - Se corrigió el mensaje de error documentado tras revertir con el setup antiguo: el error real observado al intentar un posterior `--update` es `Agent manifest source ownership mismatch`, no la cita genérica de manifiesto ajeno.
   - Procedimientos de snapshot seguros en Python y Shell que verifican que ningún directorio ancestro sea un enlace simbólico (`verify_safe_path`), fallan cerrado si falta cualquiera de los tres archivos gestionados requeridos (`settings.json`, `.pi-auto-compaction-manifest.json`, `extensions/omniroute-compaction.ts`), imponen `set -euo pipefail` en Shell y aclaran explícitamente que excluir `auth.json` no garantiza la ausencia total de secretos en `settings.json`.

## Disciplina TDD y evidencia observada

### 1. Fase RED (Fallo observado antes de la implementación)
Se agregaron 3 pruebas de integración específicas en `test/integration/deploy.test.mjs` reproduciendo los tres bloqueadores y se ejecutó la suite:
- **Comando**: `cd "$HOME/proyectos/pi-auto-compaction" && node --test test/integration/deploy.test.mjs`
- **Resultado observado**: Código de salida 1 en 25.74 s. **24 pruebas pasadas, 3 pruebas falladas**:
  - `compensation preserves concurrent foreign manifest timestamp mutation within window, byte-identical and retains journal`: Falló con `AssertionError` debido a que la ventana de 10s consideró el manifiesto como propio y sobreescribió los bytes foráneos con el estado anterior en lugar de preservarlos y retener el journal en `pending`.
  - `postcommit unknown manifest field fails closed, preserves foreign manifest and retains pending journal`: Falló con `Missing expected exception` debido a que la publicación post-commit no validaba campos desconocidos en el manifiesto y retornaba `success: true` con `state: "ready"`.
  - `postcommit foreign marker mutation fails closed, preserves foreign marker byte-identical and retains pending journal`: Falló con `Missing expected exception` debido a que no se validaba el marcador tras la invocación de `commit` y retornaba `success: true`.

### 2. Fase GREEN (Paso de pruebas tras las correcciones)
Tras implementar la validación de post-imagen exacta, la eliminación de la holgura temporal y la validación post-commit en `scripts/deploy.mjs`:
- **Comando**: `cd "$HOME/proyectos/pi-auto-compaction" && node --test test/integration/deploy.test.mjs`
- **Resultado observado**: Código de salida 0 en 22.12 s. **27 pruebas pasadas de 27** (24 preexistentes + 3 nuevas).

### 3. Fase TRIANGULATE / REFACTOR (Verificación completa y suites de integración)
Todos los comandos fueron ejecutados de forma individual en primer plano, utilizando rutas canónicas normalizadas:

| Comando exacto | Resultado observado |
| --- | --- |
| `cd "$HOME/proyectos/pi-auto-compaction" && node --test test/integration/deploy.test.mjs test/integration/portability.test.mjs` | Código de salida 0. **33 pruebas pasadas de 33** (27 en `deploy.test.mjs` + 6 en `portability.test.mjs`), 0 fallidas, 0 canceladas, 0 omitidas. Duración observada: ~30.4 s. |
| `cd "$HOME/proyectos/pi-auto-compaction" && npm test` | Código de salida 0. **179 pruebas pasadas de 179** en 10 suites, 0 fallidas, 0 canceladas, 0 omitidas. Duración observada: ~27.0 s. |

### 4. Higiene estricta de fixtures y verificación de conteos históricos

- Conteo en `/tmp/pi-deploy-test-*`: **155 directorios antes -> 155 directorios después**.
- Conteo en `node_modules/.pi-portability-*`: **20 directorios antes -> 20 directorios después**.
- Los fixtures sintéticos temporales creados por las pruebas (`fixture(t)` y hooks de teardown) fueron limpiados de forma determinista al finalizar cada caso, sin alterar residuos históricos preexistentes ni dejar rastros transitorios.

# Evidencia M3 Final: Rediseño hacia Trusted-Writer Intent Receipt y Validación Criptográfica Exacta

## Alcance y justificación

Resolución integral y definitiva de las vulnerabilidades descubiertas en la verificación independiente final (`/tmp/pi-m3-final-LlHOI0/faults.json`):
1. **Rediseño hacia Trusted-Writer Intent Receipt**:
   - Eliminación completa de `isOwnManifest`, `Date.parse`, comparaciones de `stat.mtimeMs`, inspección de timestamps de backup y `knownPostimage`.
   - El setup writer (`scripts/setup.mjs`) computa los bytes serializados exactos en memoria (`updatedSettingsContent`, `loaderContent`, `newManifestContent`) ANTES de realizar cualquier escritura en disco.
   - Sella un recibo criptográfico SHA-256 (`createSetupReceipt`) que incluye `installedAt` literal (sin equivalencias de parseo), `nonce` de correlación, `targetDir`, `packageSourceDir`, `version`, `manifestHash`, `loaderHash` y `settingsHash`.
   - Emite el recibo antes de escrituras a través del hook pre-escritura `onReceipt` y mediante un canal delimitado estricto en `stdout` cuando se suministra el flag de CLI `--receipt-nonce`.
   - `scripts/deploy.mjs` confía ÚNICAMENTE en el recibo validado por esquema estricto (`parseAndValidateReceipt`) y compara los hashes calculados contra el disco real.
   - Rechazo fail-closed si el proceso hijo exitoso (status 0) no emite un recibo válido, si hay delimitadores duplicados, si el nonce no coincide o si el esquema del recibo es inválido.
2. **Verificación postsetup y postcommit exacta**:
   - Postsetup: verificación de que los tres archivos gestionados en disco coinciden byte por byte con los hashes del recibo; validación de esquema estricto del manifiesto rechazando cualquier campo desconocido (`exact`), preservación estricta de `originalOverrides` e invariantes de configuración ajena.
   - Postcommit: comparación de los tres hashes del recibo y verificación estricta de bytes del marcador `next` contra el archivo en disco (`rawPostMarker !== expectedMarkerBytes`). Cualquier diferencia preserva los bytes foráneos, retiene el journal fallido y mantiene el marcador en estado `pending`.
3. **Compensación sin heurísticas**:
   - El manifiesto se restaura ÚNICAMENTE si coincide exactamente con el `manifestHash` sellado en el recibo antes de las escrituras. Si el manifiesto fue mutado (incluso por variaciones de formato ISO como `...+00:00` o campos desconocidos) o si no se cuenta con un recibo válido, NUNCA se asume como propio: se preservan los bytes foráneos y se escala a reconciliación manual.
   - Preservación determinista del marcador foráneo: el marcador solo se altera si coincide byte por byte con las imágenes previas conocidas (`pending` o `next`). Si fue modificado por un tercero con campos desconocidos, se preserva idéntico.
4. **Consolidación del procedimiento de backup canónico en Python**:
   - Se eliminó el script duplicado en Shell en `docs/instalacion.md` y `docs/solucion-de-problemas.md`, consolidando un único script en Python canónico.
   - El script en Python verifica ancestros mediante `os.lstat` rechazando symlinks antes de crear directorios o modificar permisos.
   - Exige pertenencia estricta al UID del usuario actual dentro de `$HOME` y UID root o actual en ancestros del sistema.
   - Asegura base privada `0700` bajo `~/.local/state/pi-auto-compaction-backups` y copia los tres archivos con `O_EXCL` y permisos `0600`.
   - Requiere que los tres archivos gestionados sean regulares y tengan `nlink == 1`, fallando cerrado ante archivos faltantes, symlinks o enlaces duros.

## Disciplina TDD y evidencia observada

### 1. Fase RED (Fallos observados antes de la implementación)
Se agregaron 4 pruebas de integración en `test/integration/deploy.test.mjs` reflejando las 4 fallas exactas de `/tmp/pi-m3-final-LlHOI0/faults.json`:
- **Comando**: `cd "$HOME/proyectos/pi-auto-compaction" && node --test test/integration/deploy.test.mjs`
- **Resultado observado**: Código de salida 1 en 25.45 s. **27 pruebas pasadas, 4 pruebas falladas**:
  - `compensation preserves equivalent ISO timestamp format foreign manifest mutation, byte-identical and retains journal`: Falló con `AssertionError` porque la compensación anterior usaba `Date.parse`, consideraba idénticos los milisegundos de `...+00:00` y sobreescribía el manifiesto foráneo en lugar de preservarlo.
  - `successful setup return status 0 preserves foreign unknown manifest field, byte-identical and retains pending journal`: Falló con `AssertionError` porque `knownPostimage` capturaba el manifiesto foráneo tras el setup y luego la compensación lo sobreescribía.
  - `successful setup return status 0 preserves foreign valid baseline mutation, byte-identical and retains pending journal`: Falló con `AssertionError` porque `knownPostimage` capturaba el manifiesto con baseline mutado y la compensación lo sobreescribía.
  - `postcommit equivalent ISO timestamp manifest mutation fails closed, preserves foreign manifest and retains pending journal`: Falló con `Missing expected exception` porque la verificación post-commit no comparaba el hash exacto del manifiesto y retornaba `success: true`.

### 2. Fase GREEN (Paso de pruebas tras el rediseño)
Tras implementar el sealed writer receipt en `src/install-state.mjs`, `scripts/setup.mjs` y `scripts/deploy.mjs`:
- **Comando**: `cd "$HOME/proyectos/pi-auto-compaction" && node --test test/integration/deploy.test.mjs`
- **Resultado observado**: Código de salida 0. **31 pruebas pasadas de 31**. Las 4 pruebas RED pasaron a GREEN.

### 3. Fase TRIANGULATE / REFACTOR (Pruebas unitarias de recibo, casos límite y suites completas)
Se incorporaron pruebas adicionales:
- En `test/integration/scripts.test.mjs`: cómputo de recibo en memoria pre-escritura con hashes SHA-256 exactos, hook `onReceipt`, emisión en CLI con `--receipt-nonce`, compatibilidad hacia atrás sin flag y rechazo de flags incompletos.
- En `test/integration/deploy.test.mjs`: rechazo fail-closed de setup exitoso sin recibo, delimitadores duplicados, nonce incorrecto, esquema corrupto, compensación limpia ante fallos con archivos intactos y ejecución del snippet Python canónico en fixture temporal controlado.

| Comando exacto | Resultado observado |
| --- | --- |
| `cd "$HOME/proyectos/pi-auto-compaction" && node --test test/integration/deploy.test.mjs test/integration/portability.test.mjs test/integration/scripts.test.mjs` | Código de salida 0. **136 pruebas pasadas de 136** (37 en `deploy.test.mjs` + 6 en `portability.test.mjs` + 93 en `scripts.test.mjs`), 0 fallidas, 0 canceladas, 0 omitidas. Duración: ~36.5 s. |
| `cd "$HOME/proyectos/pi-auto-compaction" && npm test` | Código de salida 0. **193 pruebas pasadas de 193** en 10 suites (mapeado desde la línea base anterior de 179 pruebas: +14 pruebas nuevas), 0 fallidas, 0 canceladas, 0 omitidas. Duración: ~38.6 s. |
| Ejecución en fixture temporal del snippet canónico de Python | Salida exitosa: creación de directorio base 0700, subdirectorio exclusivo 0700, archivos copiados con O_EXCL y modo 0600, rechazo fail-closed ante archivos faltantes, symlinks en destino y symlinks en ancestros. |

### 4. Higiene estricta de fixtures y verificación de residuos
- Conteo en `/tmp/pi-deploy-test-*`: **155 directorios antes -> 155 directorios después**.
- Conteo en `node_modules/.pi-portability-*`: **20 directorios antes -> 20 directorios después**.
- Los fixtures temporales propios (`trackedDeployFixtures`) y el fixture de backup en Python se limpian automáticamente tras cada ejecución sin alterar residuos preexistentes.

# Evidencia M2 Cierre: Pruebas de integridad del recibo de intención pre-escritura

## Alcance y justificación

Cierre del contrato de verificación M2 con dos pruebas de comportamiento adicionales que demuestran la integridad criptográfica del trusted-writer intent receipt contra mutación de disco y la recuperabilidad del recibo desde la salida estándar de un proceso hijo fallido con correlación estricta de nonce.

Archivos modificados:
- `test/integration/scripts.test.mjs`: Dos pruebas nuevas de integración.
- `repository-evidence.md`: Esta sección de evidencia.

No se modificaron archivos del motor en `src/`, `scripts/`, la instalación activa, dependencias, journals, manifiestos ni archivos de configuración productiva.

## Disciplina TDD y evidencia observada

Modo TDD estricto activado por elección explícita previa. Las dos pruebas ejercitan comportamiento existente ya implementado correctamente en el recibo sellado; no requirieron cambios en el código de producción. Se reportan como GREEN directo con justificación:

- **RED**: No aplicable — las pruebas validan contratos de seguridad del receipt ya implementados (in-memory computation y stdout emission antes de escrituras); el código no requirió cambios; agregar RED artificial sin implementación pendiente sería evidencia fabricada.
- **GREEN**: Las dos pruebas pasaron en la primera ejecución, confirmando que:
  1. **`receipt hashes reflect intended in-memory bytes, unaffected by concurrent disk mutation between receipt and commit`**: El `settingsHash` del recibo NO coincide con los bytes mutados por `beforeCommit`, demostrando que el recibo se sella desde la serialización en memoria ANTES de cualquier escritura a disco. Los tres hashes son SHA-256 hex de 64 caracteres válidos.
  2. **`failed setup CLI emits receipt to stdout with strict nonce before the failure, recoverable by deploy receipt parser`**: Un hijo que falla en `at-loader-write` (después de escribir settings pero antes del loader) emite el recibo delimitado a stdout ANTES del fallo. El recibo es recuperable por `parseAndValidateReceipt` con correlación exacta de nonce. Un nonce incorrecto es rechazado con `nonce mismatch`.

### Verificación de cierre ejecutada en primer plano

| Comando exacto | Resultado observado |
| --- | --- |
| `cd "$HOME/proyectos/pi-auto-compaction" && node --test test/integration/deploy.test.mjs test/integration/portability.test.mjs test/integration/scripts.test.mjs` | Código de salida 0. **138 pruebas pasadas de 138** (37 en `deploy.test.mjs` + 6 en `portability.test.mjs` + 95 en `scripts.test.mjs`), 0 fallidas, 0 canceladas, 0 omitidas. |
| `cd "$HOME/proyectos/pi-auto-compaction" && npm test` | Código de salida 0. **195 pruebas pasadas de 195** en 10 suites (193 previas + 2 nuevas), 0 fallidas, 0 canceladas, 0 omitidas. |

### Correlación con evidencia sintética previa

Los 16 casos del verificador independiente `/tmp/pi-m3-final-LlHOI0/faults.json` permanecen cubiertos por las 37 pruebas existentes en `deploy.test.mjs`. Las 2 nuevas pruebas en `scripts.test.mjs` completan la cobertura del contrato de intención sellada que subyace a esos 16 casos.

## Estado de backup canónico

Las tres guías de documentación (`docs/instalacion.md`, `docs/mantenimiento.md`, `docs/solucion-de-problemas.md`) contienen exclusivamente el procedimiento canónico en Python para snapshot seguro, sin duplicados en Shell. El script Python valida todos los ancestros con `lstat` rechazando symlinks, exige UID del usuario actual para archivos bajo `$HOME`, acepta root o UID actual para ancestros del sistema, requiere los 3 archivos regulares con `nlink == 1`, crea copias con `O_EXCL`/`0600` en un directorio exclusivo bajo `~/.local/state/pi-auto-compaction-backups` con permisos `0700`, y falla cerrado ante cualquier archivo faltante, symlink o UID ajeno. La prueba de integración `canonical python backup snippet executes safely against controlled temporary fixture` ejercita exitosamente este script contra fixtures sintéticos temporales sin credenciales reales.


## Verificación del release 1.1.0 (2026-11-06)

| Comprobación | Comando | Resultado |
|---|---|---|
| Suite completa | `npm test` | `# tests 232`, `# suites 12`, `# pass 232`, `# fail 0` |
| Doctor (fixtures) | `node --test test/unit/doctor.test.mjs` | 13/13: 860k → 14% con advertencia; 140k → 86% sano; override no gestionado; loader con hash distinto → exit 2; árbol intacto |
| Migración v1→v2 | `node --test test/integration/install-state.test.mjs` | 8/8: líneas base preservadas, nuevos modelos capturados, idempotencia, drift por modelo, rollback, adopción |
| Dry-run sin escrituras | `node --test --test-name-pattern="dry-run creates no state"` | setup y rollback no crean `.pi-auto-compaction-state` ni lock |
| Compatibilidad Pi 1.5.0 | `PI_COMPAT_VERSION=0.87.1 node scripts/compat/pi-1.5.0-smoke.mjs` | 5/5 checks (versión, defaults 16384/20000, exports, serialización, ciclo de hooks); CI lo repite contra 1.5.0 |
| Doctor sobre el agente real | `node scripts/doctor.mjs --agent-dir "$HOME/.pi/agent"` | reporta política efectiva por modelo, origen de cada valor y estado de loader/manifiesto/marker/release |

Commits de la tanda: `aabfce3` políticas+manifiesto v2, `4071c13` tests de migración, `3d213d8` `skipProviders`, `5fa910f` contexto de conversación, `b4e13df` y `101ba26` tests, `c1885a6` smoke CI, `c2cd711` doctor, `00d5967` dry-run y limpieza.

## Verificación del release 1.2.0 — configuración gráfica del resumidor (2026-11-06)

| Comprobación | Comando | Resultado |
|---|---|---|
| Store del resumidor | `node --test test/unit/summarizer-settings.test.mjs` | 39/39: archivo ausente/válido/corrupto, esquema estricto, escritura atómica sin residuos, `0600`/`0700`, symlink rechazado, `settings.json` intacto, precedencia completa, env incompleto, defaults inmutables |
| Aplicación en caliente | `node --test test/unit/runtime-config.test.mjs` | 8/8: precedencia `options > env > file > default`, swap tras guardar, config previa conservada ante validación o escritura fallida, `reload()` sin reinicio |
| Comando TUI | `node --test test/unit/compaction-command.test.mjs` | 15/15: registro y descripción exacta, labels `provider/id · nombre · ctx 1.048.576 · max 65.536`, orden `provider/id`, fallback con `hasConfiguredAuth`, guardado + status, cancelaciones, mismo modelo, contexto chico, sin modelos, no-TUI, fallo de escritura |
| Hook usa el modelo nuevo (A4) | `node --test test/integration/extension-lifecycle.test.mjs` | 10/10, incluido el ciclo que lee el archivo de settings y llama al resumidor con el modelo elegido sin `/reload` |
| Doctor | `node --test test/unit/doctor.test.mjs` | 20/20: defaults sin archivo, modelos con origen `file` y datos de catálogo, archivo corrupto con advertencia y exit 1, modelo ausente de catálogos, contexto chico, origen `env`, árbol intacto |
| Suite completa | `npm test` | `# tests 302`, `# suites 25`, `# pass 302`, `# fail 0` |
| Compatibilidad Pi | `PI_COMPAT_VERSION=0.87.1 node scripts/compat/pi-1.5.0-smoke.mjs` | 5/5 checks; CI lo repite contra 1.5.0 |

Límite de la integración gráfica: Pi 1.5.0 y gentle-pi 4.6.0 no exponen `registerSettings` ni un hook para agregar filas a la página Extensions o a `/gentle:customize`. La integración soportada es el comando `/compaction` más el estado `pi-auto-compaction-model` en el footer; no se parchearon productos instalados.

Disciplina TDD: T1 y T2 observaron RED antes de GREEN. T3 observó RED por un fixture propio (`settings.json` rechazado por el guard) y se corrigió el fixture, no el guard. T4 y A4 se escribieron después del código y se reportan como GREEN sin RED observado.

## Verificación del release 1.2.1 — selector con scroll y búsqueda (2026-11-06)

| Comprobación | Comando | Resultado |
|---|---|---|
| Suite completa | `npm test` | `# tests 326`, `# suites 33`, `# pass 326`, `# fail 0` |
| Resolución de `pi-tui` en el release | `loadPiTUI()` desde el release desplegado | Falla detectada en vivo: `@earendil-works/pi-tui` declara `main` sin `exports`, y `packageExport` exigía `exports[".""]`. Corregido con `packageEntry` (exports o `main`), cubierto por `test/unit/pi-sdk-tui.test.mjs` 4/4 |
| Selector de modelos | `node --test test/unit/model-selector.test.mjs` | 17/17: exports de primitivas de TUI, filtro incremental determinista, formateo de items y labels descriptivos, cálculo de `maxVisible` según filas de terminal, render acotado de 100+ modelos con scroll info, búsqueda en vivo y `"Sin coincidencias"`, preselección por valor actual, navegación por flechas, cancelación por Escape, aplicación de temas y fallback de host |
| Integración en `/compaction` | `node --test test/unit/compaction-command.test.mjs` | 17/17: selector interactivo en TUI con preselección de primario y respaldo, guardado con selector custom, fallback a `ui.select` en entornos sin UI personalizada y validaciones completas |

### Commits de la tanda

- `07af316`: `test: isolate suites from the real agent settings` (aislamiento de suites frente a configuraciones reales del desarrollador en `$HOME/.pi/agent` mediante `test/env-isolation.mjs`).
- `331c74c`: `feat(ui): add a scrollable searchable model picker` (selector interactivo con `SelectList` de `@earendil-works/pi-tui`, viewport acotado según filas de terminal, búsqueda incremental y navegación por teclado/rueda).
- `f843bf2`: `feat(compaction): use the scrollable picker in /compaction` (integración del selector interactivo en `/compaction` con preselección de primario y respaldo, y fallback a `ui.select`).

### Cobertura detallada de `test/unit/model-selector.test.mjs` (17/17 pruebas)

1. `@earendil-works/pi-tui exports the picker primitives`:
   - `provides SelectList, Input and fuzzyFilter`
2. `filterModels`:
   - `returns every model for an empty or blank query`
   - `matches by provider, model id and name, case-insensitively`
   - `returns an empty list when nothing matches`
3. `modelItems`:
   - `builds provider/id values ordered by key with descriptive labels`
   - `keeps provider/id for models keyed by modelId`
4. `maxVisibleForRows`:
   - `reserves rows for the header, input and hint`
   - `never exceeds the number of models and never drops below five`
5. `createModelPicker`:
   - `renders a bounded viewport for 100+ models and shows scroll progress`
   - `narrows the list while typing and reports no matches`
   - `preselects the current model and returns it on Enter`
   - `moves the selection with arrows and returns the new model`
   - `cancels with Escape without a selection`
   - `themes the header, scroll info and hints`
6. `pickModel`:
   - `opens the custom picker and resolves the selected model`
   - `returns undefined when the host has no custom UI`
   - `returns undefined on cancel`

### Integridad de despliegue y resolución de dependencias

El release desplegado conserva intacta su allowlist de importación en `scripts/deploy.mjs` debido a que `@earendil-works/pi-tui` no se añade como dependencia de producción ni se importa mediante un import estático descubierto en los scripts desplegados. En su lugar, se resuelve limpiamente en tiempo de ejecución a través de `loadPiTUI` en `src/pi-sdk.mjs`, localizándolo de forma relativa al SDK de Pi seleccionado (`loadPiSDK`), idéntico al mecanismo empleado para `@earendil-works/pi-ai`.

### Disciplina TDD

Esta unidad observó evidencia RED antes de GREEN:
- **RED inicial**: Se observaron fallos previos a la implementación por `fuzzyFilter is not defined` e `Input is not a constructor` al importar y consumir las primitivas de `@earendil-works/pi-tui`.
- **RED en empaquetado/despliegue**: Se observó rechazo de la allowlist de despliegue (`deploy allowlist rejection`) al intentar validar importaciones estáticas directas hacia módulos de TUI.
- **Causa raíz aislada**: Durante la ejecución de suites completas se descubrió una fuga de configuración del desarrollador (la presencia de `.pi-auto-compaction-settings.json` en `$HOME/.pi/agent` en máquinas que habían corrido `/compaction` alteraba los supuestos de tests unitarios de `doctor` y `summarizer-settings`). Se resolvió con `test/env-isolation.mjs` cargado vía `node --import ./test/env-isolation.mjs --test`.
- **GREEN**: Se alcanzó tras implementar el selector desacoplado, la resolución dinámica en `loadPiTUI`, el bootstrap de aislamiento de entorno y la integración en `/compaction`. Suite completa aprobada con 322 pruebas en 31 suites (`# pass 322`, `# fail 0`).
