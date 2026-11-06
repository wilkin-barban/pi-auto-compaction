# Contribuir a pi-auto-compaction

Gracias por ayudar. Este repositorio es **público source-available** bajo `UNLICENSED`: el código se puede leer y auditar, pero todos los derechos están reservados y no se publica en npm. Se aceptan reportes, documentación, tests y parches.

- Idiomas: issues y pull requests en **inglés o español**. La documentación existe en los dos árboles (`docs/en`, `docs/es`).
- Punto de partida: [README](README.md) · [Docs EN](docs/en/installation.md) · [Docs ES](docs/es/instalacion.md) · [Seguridad](SECURITY.md) · [Código de Conducta](CODE_OF_CONDUCT.es.md)
- English version: [CONTRIBUTING.md](CONTRIBUTING.md)

---

## Ruta rápida

| Paso | Comando / acción |
|---|---|
| 1 | Hacé fork y creá una rama descriptiva, por ejemplo `docs/guia-colaboracion` |
| 2 | `npm ci --ignore-scripts` |
| 3 | Aplicá el cambio, con tests si cambia comportamiento |
| 4 | `npm test` — esperado: `326` pruebas en `33` suites, `0` fallos |
| 5 | Actualizá la documentación en inglés **y** español si el cambio es visible para el usuario |
| 6 | Abrí un pull request usando la plantilla |

Los contribuyentes externos abren pull requests; solo los mantenedores y los agentes del repositorio hacen push a `main`. Sin force-push y sin ramas huérfanas.

**Siguiente paso:** leé [Desarrollo y pruebas](#desarrollo-y-pruebas) y abrí tu PR.

---

## Desarrollo y pruebas

- Node `>= 22.19` y Pi o gentle-shell disponible para verificaciones manuales.
- Instalación exacta: `npm ci --ignore-scripts`.
- Suite completa: `npm test`. Ejecución enfocada: `node --test --test-name-pattern="<nombre>" <archivo>`.
- Disciplina: RED (una prueba que falla y captura el comportamiento), GREEN (implementación mínima), TRIANGULATE (los bordes que la regla nombra), REFACTOR.
- Los tests son offline: **sin credenciales, sin red, sin el directorio real del agente**. Usá fixtures temporales y limpialos. `test/env-isolation.mjs` es preload de `npm test` exactamente para eso.
- La CI corre Node 22, Node 24 y el smoke de compatibilidad con Pi 1.5.0. Una CI roja no se mergea.

## Código y arquitectura

- Solo ESM (`.mjs`), módulos chicos y enfocados.
- Nunca parchear Pi, gentle-shell, herdr ni `node_modules`. La integración va por hooks y APIs públicas.
- Solo rutas portables: `$HOME`, `$PI_CODING_AGENT_DIR`, `$AGENT_DIR`, `$INSTALL_DIR`. Sin rutas personales.
- Sin credenciales, `auth.json`, sesiones, telemetría real ni contenido de conversaciones en el repositorio ni en los tests.

## Documentación

- El inglés es el idioma por defecto; el español debe ser completo, no un resumen. Actualizá ambos árboles en el mismo PR.
- Los enlaces relativos deben resolver, los conteos deben coincidir con la realidad (hoy `326` pruebas en `33` suites) y no se afirma como hecho nada sin verificar.
- Si cambia el comportamiento, actualizá `README.md`, `README.es.md`, `docs/en/*`, `docs/es/*`, `CHANGELOG.md` y — cuando aplique — la evidencia y los archivos ODD.

## Cambios de modelos o políticas

- Las políticas de conversación viven en `MANAGED_POLICIES` (`src/install-state.mjs`) y están cubiertas por `test/integration/install-state.test.mjs`.
- Cualquier cambio ahí debe mantener correctos el manifiesto v2 y la migración v1→v2, mantener exacto `doctor` y actualizar la documentación en ambos idiomas.
- Nunca cambies defaults, licencia ni visibilidad del repositorio sin decisión del dueño.

## Commits y pull requests

- [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`, `chore:`.
- Commits atómicos: una unidad revisable por commit.
- Sin trailers `Co-Authored-By` y sin atribución a IA.
- La plantilla de PR pide resumen, issue relacionado, tipo, pruebas, docs EN/ES, changelog, riesgo y rollback, más una checklist.
- El mantenedor revisa, la CI debe estar verde y el PR se mergea con squash o merge. Nunca se mergea con secretos, tests rojos o documentación desalineada.

## Issues y seguridad

- Bug report: sistema operativo, versión de Node, versión de Pi o gentle-shell, versión de la extensión, pasos de reproducción, esperado vs actual y salida de `doctor --json` sanitizada.
- Feature request: el problema, la propuesta, alternativas y el alcance previsto.
- **Vulnerabilidades:** no abras un issue público. Seguí [SECURITY.md](SECURITY.md).
- Los reportes de Código de Conducta van en privado al mantenedor por su perfil de GitHub; no se toleran represalias.

## Definición de terminado

- Tests y CI verdes.
- Documentación en inglés y español actualizada.
- Entrada en `CHANGELOG.md` cuando el cambio es visible para el usuario.
- Sin secretos y sin rutas personales.
- Compatibilidad y rollback considerados y explicitados.
- PR revisado y aprobado.

## Licencia de las contribuciones

- El repositorio es público source-available, `UNLICENSED`: **no** es open source. No se concede licencia de redistribución.
- Las contribuciones se aceptan a discreción del mantenedor. Al abrir un pull request confirmás que tenés derecho a enviar el cambio y aceptás que se distribuya bajo los términos actuales del repositorio.
- Si necesitás otra licencia o un CLA, contactá primero al mantenedor. Nunca cambies la licencia por tu cuenta.

## Buenas primeras contribuciones

- Traducciones entre inglés y español.
- Tests para ramas sin cobertura y mensajes de error.
- Correcciones de documentación: enlaces roscos, conteos viejos, pasos confusos.
- Mejoras en la salida de `doctor` y mensajes de error más claros.
- Soporte de modelos locales y documentación de proveedores.

Buscá issues etiquetados `good first issue` cuando existan.

**Siguiente paso:** elegí o abrí un issue, creá la rama y corré `npm test` antes de tu primer commit.
