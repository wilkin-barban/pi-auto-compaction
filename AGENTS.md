# Directrices para Asistentes y Agentes (AGENTS.md)

Este repositorio contiene la extensión privada de compactación automática para Pi, gentle-shell y herdr. Todos los asistentes automatizados (Pi, subagentes o harnesses externos) deben acatar estrictamente las siguientes directrices al operar en este proyecto.

---

## 1. Comandos de trabajo y verificación

| Operación | Comando recomendado |
|---|---|
| **Verificación de pruebas** | `npm test` (o `node --test`) |
| **Instalación de dependencias** | `npm ci --ignore-scripts` |
| **Simulación de despliegue** | `npm run deploy -- --dry-run` |
| **Despliegue durable** | `npm run deploy` |
| **Reversión de fuentes** | `npm run deploy -- --rollback-source` |
| **Desinstalación de configuración** | `npm run rollback` |

- **No modificar `package-lock.json` arbitrariamente**: Cualquier cambio en dependencias debe justificarse y sincronizarse con `npm install --ignore-scripts`.
- **No añadir scripts de ciclo de vida automáticos**: No añadir hooks `postinstall` ni ejecuciones automáticas al instalar paquetes.

---

## 2. Privacidad y Seguridad

- **Repositorio privado (`UNLICENSED`)**: Este código es de uso exclusivo del propietario. No publicar en npm, no alterar la visibilidad a pública y no enviar datos sensibles fuera del entorno local.
- **Sin secretos en el código ni en las pruebas**: Nunca incluir tokens de autenticación, claves de API, archivos `auth.json` reales ni volcados de conversaciones privadas.
- **Rutas portables**: Utilizar siempre variables de entorno (`PI_CODING_AGENT_DIR`), parámetros configurables o comodines portables como `$HOME`. No codificar rutas estáticas basadas en usuarios específicos.

---

## 3. Política de No-Parches sobre Productos Instalados

- **Prohibición de parches invasivos**: Está terminantemente prohibido modificar binarios instalados globalmente, módulos en `node_modules` globales o archivos internos de Pi/herdr.
- **Integración limpia mediante hooks**: La extensión interactúa con Pi únicamente mediante el loader oficial en `$HOME/.pi/agent/extensions/omniroute-compaction.ts` y los hooks documentados en el SDK (`session_before_compact`, `session_compact`, `session_compact_failed`).
- **Respeto a instalaciones existentes**: Nunca sobrescribir ni borrar directorios sin confirmación ni alterar la raíz de releases sin verificar el marcador `.pi-auto-compaction-deploy.json`.

---

## 4. Continuidad y Memoria con Engram (Opcional)

- Si el entorno dispone de herramientas de memoria persistente de Engram (`mem_save`, `mem_search`, `mem_context`), los agentes pueden registrar hitos relevantes, aprendizajes comprobados y resúmenes de sesión bajo el proyecto correspondiente.
- El uso de Engram es un mecanismo de apoyo y continuidad opcional; no sustituye la documentación técnica en Markdown, los commits atómicos ni los registros de evidencia del repositorio.
