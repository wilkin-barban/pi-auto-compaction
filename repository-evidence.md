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


