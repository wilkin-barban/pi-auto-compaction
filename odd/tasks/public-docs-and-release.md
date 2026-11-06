# Documentación profesional bilingüe y publicación pública (1.2.1)

Objetivo: convertir la documentación en un manual técnico bilingüe (inglés default, español completo), orientado a agentes, con una skill registrada, y publicar el repositorio como fuente disponible bajo `UNLICENSED`, después de un escaneo de privacidad limpio.

Alcance: `README.md` en inglés y `README.es.md`; `docs/en/*` (5 documentos) y `docs/es/*` (5 documentos, movidos desde `docs/*.md`); `skills/pi-auto-compaction/**`; actualización de `AGENTS.md`, `SECURITY.md`, `CONTRIBUTING.md`, `package.json` y avisos de política; escaneo de secretos; metadata de GitHub y cambio de visibilidad.

No-objetivos: no cambiar código, tests, esquema de settings, políticas v2 ni el resumidor vivo; no parchear Pi, gentle-shell, herdr ni `node_modules`; no publicar en npm; no cambiar la licencia; no tocar credenciales, sesiones, telemetría ni `auth.json`.

## Hechos verificados que la documentación debe reflejar

- Versión 1.2.1; `npm test` 326/326 en 33 suites; CI Node 22, Node 24 y Pi 1.5.0 smoke.
- Deploy transaccional con release por hash bajo `$INSTALL_DIR/releases/<sha256>`, loader en `$AGENT_DIR/extensions/omniroute-compaction.ts`, manifiesto v2 `.pi-auto-compaction-manifest.json`, marker `.pi-auto-compaction-deploy.json` con estado `ready`, journals transaccionales y bloqueo de compensation pendiente.
- Modos: instalación limpia (`deploy`), adopción (`--adopt-agent`), actualización (`--update`), dry-run (`--dry-run`), rollback de fuentes (`--rollback-source`), desinstalación de configuración (`rollback.mjs`).
- Resumidor: `src/summarizer-settings.mjs`, archivo `$AGENT_DIR/.pi-auto-compaction-settings.json`, precedencia `options > env > file > default`, variables `PI_AUTO_COMPACTION_PRIMARY_PROVIDER|PRIMARY_MODEL|FALLBACK_PROVIDER|FALLBACK_MODEL|SETTINGS_PATH`, `skipProviders` (`PI_AUTO_COMPACTION_SKIP_PROVIDERS`), selector `/compaction` con búsqueda y scroll, status `pi-auto-compaction-model`.
- `doctor` de solo lectura con códigos 0/1/2, `--json`, sección de resumidor y umbral efectivo por modelo.
- Telemetría local en `$HOME/.local/state/pi-auto-compaction/compaction.jsonl` (metadatos por lista blanca, `0600`/`0700`).
- Política: repositorio público *source-available*, `UNLICENSED`, todos los derechos reservados; npm no autorizado.

## Specs

- **S1 (estructura)**: crear `docs/en/{installation,agent-install,architecture,maintenance,troubleshooting}.md` y `docs/es/{instalacion,instalacion-agente,arquitectura,mantenimiento,solucion-de-problemas}.md`; mover el contenido español actual sin duplicados obsoletos; actualizar todos los enlaces internos, incluidos `README`, `AGENTS.md`, `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG` y scripts si referencian rutas viejas.
- **S2 (README)**: `README.md` en inglés como landing default y `README.es.md` completo; selector `English | Español` arriba; qué es, para quién, problema y diferenciales, quick path de 5–7 pasos, “For AI agents”, tabla de métodos (manual, agente, `--adopt-agent`, update, rollback), configuración de modelos, operaciones (`doctor`, deploy, `/reload`, rollback, CI), seguridad/privacidad/licencia, enlaces.
- **S3 (docs EN, fuente principal)**: instalación manual con prerequisites, instalación limpia, agente gestionado con `--adopt-agent`, actualización, rollback (fuentes vs configuración y límites), rutas y variables, notas de Pi/gentle-shell, checklist de verificación con señales exactas; `agent-install.md` con contrato del agente, tabla de decisión, guardas de seguridad y prompt copiable en bloque; arquitectura (hooks, release/loader/manifiesto v2, políticas, store del resumidor, selector, `doctor`, telemetría, privacidad, `UNLICENSED`); mantenimiento (update, rollbacks, journals, drift, retención, backup/reset de settings); troubleshooting (sin `/reload`, sin modelos, modelo ausente, settings corrupto, contexto chico, doble fallo, journal pendiente, límites de adopción/rollback, resolución del SDK).
- **S4 (docs ES)**: traducciones completas de S3, mismo orden y comandos, sin resumir.
- **S5 (skill y prompts)**: `skills/pi-auto-compaction/SKILL.md` con frontmatter `name`, `description` en inglés ≤250 caracteres con triggers primero, `license: UNLICENSED`, `metadata.author` y `metadata.version`; cuerpo 180–450 tokens con Activation Contract, Hard Rules, Decision Gates, Execution Steps, Output Contract y References; prompts completos en `assets/agent-install-prompt.md` y `.es.md`; registro en `AGENTS.md` y enlace desde el README.
- **S6 (metadata y política)**: `package.json` `description` en inglés manteniendo `private: true` y `license: "UNLICENSED"`; actualizar avisos de “repositorio privado / no publicar” en `SECURITY.md`, `CONTRIBUTING.md`, `AGENTS.md` y docs para reflejar la nueva política pública source-available, sin prometer npm ni licencia OSI.
- **S7 (privacidad antes de publicar)**: `git ls-files`, búsqueda de `sk-`, `ghp_`, `Bearer`, `PRIVATE KEY`, `api_key`, `password`, correos y `/home/<usuario>` en árbol e historial; fixtures sintéticos rotulados; sanitizar rutas personales sin romper tests; si aparece un secreto real, detener la publicación y reportar sin exponer el valor.
- **S8 (publicación)**: commits atómicos a `main`, push, `HEAD == origin/main`, CI verde; `gh repo edit` con descripción inglesa y topics `pi`, `gentle-shell`, `herdr`, `context-compaction`, `ai-agents`, `llm`; cambio a público solo con escaneo limpio y CI verde; verificar `gh repo view --json visibility,description,url`; no tocar releases, markers, journals, ramas ni historial.

## Tareas

- T1 — ODD y hechos verificados. Inline. Commit propio.
- T2 — README EN + `docs/en/*` (5 documentos). Writer. Commit propio.
- T3 — README ES + `docs/es/*` (5 documentos) y retiro de `docs/*.md`. Writer. Commit propio.
- T4 — Skill, prompts y registro en `AGENTS.md`. Writer. Commit propio.
- T5 — Metadata y política (`package.json`, `SECURITY.md`, `CONTRIBUTING.md`, avisos). Inline. Commit propio.
- T6 — Escaneo de privacidad, verificación de enlaces, `npm test`. Inline.
- T7 — Push, CI, `gh repo edit` y visibilidad. Inline. **Hecho**: push `11140d1`, CI `42293130534` verde (Node 22, Node 24, Pi 1.5.0), descripción inglesa y topics `pi`, `gentle-shell`, `herdr`, `context-compaction`, `ai-agents`, `llm`; visibilidad cambiada a `PUBLIC` y verificada con `gh repo view`.

## Criterios de aceptación

- A1: README inglés default y `README.es.md` completo con selector de idioma; docs EN/ES con enlaces válidos.
- A2: instalación manual, adopción, actualización y rollback documentados con comandos verificables.
- A3: método de agente con prompt copiable EN/ES y skill válida registrada.
- A4: `/compaction`, modelos del harness, precedencia, `skipProviders`, `doctor`, telemetría y privacidad documentados con precisión.
- A5: sin rutas personales, secretos ni datos de la máquina; escaneo documentado.
- A6: 326/326, CI verde, `HEAD == origin/main`, árbol limpio, sin ramas nuevas.
- A7: repositorio público, descripción inglesa y topics; licencia `UNLICENSED` explícita.
- A8: reporte final con archivos, comandos, tests, CI, visibilidad, descripción, licencia y riesgos.

## Resultado

Repositorio público en https://github.com/wilkinbarban/pi-auto-compaction, `UNLICENSED` y `private: true` en `package.json`, sin publicación en npm. Documentación bilingüe: `README.md` (EN, default) + `README.es.md`, `docs/en/*` (5) y `docs/es/*` (5), skill `skills/pi-auto-compaction/SKILL.md` con prompts EN/ES. Escaneo de privacidad limpio y CI verde antes del cambio de visibilidad.

## Evidencia RED/GREEN

- No aplica TDD: unidad documental y de metadata. Verificación por `npm test` (**326/326 en 33 suites**), comprobación automática de enlaces Markdown en 31 archivos (sin enlaces relativos roscos), CI y `gh repo view`.
- **Escaneo de privacidad**: `git ls-files` (59 archivos) sin `auth.json`, `settings.json`, sesiones, telemetría, `.env`, backups, journals ni claves; `git log -p --all` solo contiene fixtures sintéticos (`sk-ant-api03-abcdef…`, `sk-ant-secret-12345`, `Bearer sensitive-token-99999`); las cuatro rutas `/home/wilkin` de tests se sanitizaron a `/home/example` y la suite siguió verde. Árbol final sin rutas personales ni credenciales.
- **Script canónico de backup**: la prueba de integración de deploy lee el bloque Python de `docs/es/instalacion.md`; la traducción lo había reescrito con mensajes en español y rompía la aserción. Se restauró el script literal (mensajes en inglés) en ambas guías y se movió la ruta del test a `docs/es/`, sin debilitar la prueba.

## Log

- L1 (usuario): «Quiero lanzar la extensión al mundo. Necesito que construyas una documentación **profesional, técnica y orientada a agentes**, en **inglés por defecto y español**… Al final, el repo debe quedar **público** (si sigue privado), con descripción en inglés, todo commiteado y pusheado a `main`, sin ramas.» Estado inicial: `main == origin/main == bab25cb`, árbol limpio, 1.2.1 publicada, repo `PRIVATE` con descripción en español.

- Commits: `368b990` ODD, `f21a93e` documentación bilingüe, skill, prompts y política. Base `bab25cb`.
