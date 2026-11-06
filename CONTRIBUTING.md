# Guía de Contribución

Este documento establece las directrices de desarrollo, pruebas y mantenimiento de **pi-auto-compaction**.

El repositorio es público como *source-available* bajo `UNLICENSED`: se aceptan reportes y parches por los canales habituales, pero no se publica en npm ni se otorga licencia de redistribución. Antes de abrir un issue con datos del entorno, eliminá credenciales, rutas personales y contenido de conversaciones.

---

## 1. Disciplina de desarrollo: TDD Estricto

Cualquier adición de comportamiento, corrección de errores o modificación de la lógica de distribución debe desarrollarse siguiendo la disciplina de **Desarrollo Guiado por Pruebas (TDD)** en cuatro fases obligatorias:

1. **RED**: Escribir la prueba más pequeña a nivel de comportamiento que capture la necesidad o el defecto observado y registrar su fallo con anterioridad a la implementación.
2. **GREEN**: Implementar la modificación mínima necesaria en el código de producción para que la prueba pase a verde.
3. **TRIANGULATE**: Incorporar casos negativos, entradas inválidas y escenarios de borde pertinentes que protejan el contrato de la interfaz.
4. **REFACTOR**: Mejorar la legibilidad, eliminar duplicación y consolidar estructuras asegurando que toda la suite permanezca en verde.

Para cambios estrictamente documentales o alias de comandos sin alteración funcional, se documenta la justificación y se verifica la coherencia global sin necesidad de un ciclo RED artificial.

---

## 2. Aislamiento y Fixtures Offline

Todas las pruebas del repositorio deben ser completamente deterministas y autónomas:

- **Sin credenciales de producción**: Las pruebas unitarias y de integración nunca deben leer archivos `auth.json` reales ni requerir claves de API del entorno.
- **Sin llamadas de red ni proveedores activos**: Todas las llamadas a `ctx.modelRegistry.complete` se simulan mediante fixtures locales y dobles de prueba (mocks/stubs).
- **Entornos temporales aislados**: Las pruebas que validan el comportamiento de `deploy.mjs`, `setup.mjs` y `rollback.mjs` deben crear directorios sintéticos temporales (mediante `fs.mkdtemp` o rutas en `node_modules/.tmp/`) y limpiar sus recursos al finalizar.

---

## 3. Mantenimiento de la Fijación del SDK de Pi

El paquete interactúa estrechamente con las interfaces internas del SDK de Pi. Para evitar incompatibilidades silenciosas:

1. **Fijación exacta (Exact Pinning)**:
   Las dos dependencias del SDK en `package.json` deben mantenerse fijadas en una versión exacta, sin rangos (`^` o `~`):
   ```json
   "devDependencies": {
     "@earendil-works/pi-coding-agent": "0.87.1",
     "@earendil-works/pi-ai": "0.87.1"
   }
   ```
2. **Actualización coordinada**:
   Al evaluar una nueva versión del SDK de Pi:
   - Modifique ambas dependencias a la nueva versión idéntica.
   - Ejecute `npm install --ignore-scripts` para regenerar `package-lock.json`.
   - Inspeccione las definiciones de tipos o la documentación interna de Pi para validar que los hooks del ciclo de vida sigan presentes:
     - `session_before_compact`
     - `session_compact`
     - `session_compact_failed`
   - Verifique que la firma de `_getSummarizationRequestAuth` y la estructura de `CompactionResult` no hayan cambiado.
   - Ejecute `npm test` y compruebe que la suite completa (referencia actual: 326 pruebas en 33 suites) apruebe al 100%.

---

## 4. Convenciones de Código y Arquitectura

- **Módulos estándar ECMAScript (ESM)**: Se utiliza `"type": "module"` en `package.json` y extensiones explícitas `.mjs`.
- **Prohibición de parches en productos instalados**: Ninguna funcionalidad debe parchear binarios globales, paquetes en `node_modules` globales ni archivos gestionados por el harness Pi/herdr.
- **Rutas y portabilidad**: No asumir rutas estáticas vinculadas a nombres de usuario locales; utilizar `os.homedir()` o las variables de entorno oficiales (`PI_CODING_AGENT_DIR`).
- **Verificación obligatoria previa al commit**:
  ```bash
  npm test
  ```
