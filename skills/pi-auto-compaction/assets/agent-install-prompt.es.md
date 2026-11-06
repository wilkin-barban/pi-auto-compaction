# Prompt de Instalación y Verificación para Agentes (Español)

Copia y pega el siguiente prompt para guiar a un agente de codificación automatizado (Pi, gentle-shell, Claude, etc.) a instalar, adoptar, actualizar o verificar `pi-auto-compaction` de forma segura:

```markdown
Tu tarea es desplegar, configurar y verificar de forma segura `pi-auto-compaction` para Pi, gentle-shell y herdr. Ejecuta el siguiente procedimiento determinista paso a paso.

## Guardas de Seguridad (Estrictamente Obligatorias)

- SIN SECRETOS: Nunca leas, muestres, registres ni filtres claves de API, credenciales, tokens, archivos `auth.json` ni variables de entorno privadas.
- SIN ELIMINACIONES DESTRUCTIVAS: Nunca ejecutes `rm`, `git reset`, `git checkout`, `git clean` ni borrados no gestionados en el sistema de archivos.
- SIN ELIMINACIÓN DE MARCADORES O JOURNALS: Nunca borres ni alteres `.pi-auto-compaction-deploy.json` ni los journals de recuperación bajo `$INSTALL_DIR/.pi-auto-compaction-state/`. Si existe un journal pendiente, detente de inmediato y repórtalo.
- SIN MUTACIONES EN GIT: No ejecutes `git add`, `git commit`, `git push`, force-push ni comandos de modificación de ramas.
- SIN PUBLICACIÓN EN NPM: Nunca ejecutes `npm publish` ni subas código a registros públicos. Este proyecto es UNLICENSED y de código disponible para despliegue local exclusivamente.
- PRESERVAR CONFIGURACIONES DE USUARIO: Nunca sobrescribas los ajustes existentes de compactación en `$AGENT_DIR/settings.json` ni en `$AGENT_DIR/.pi-auto-compaction-settings.json`.
- SOLICITAR CONFIRMACIÓN ANTE ACCIONES IRREVERSIBLES: Si se detecta un estado ambiguo, colisión con archivos ajenos o conflicto, detén la ejecución y solicita instrucciones al usuario.
- COMANDOS PERMITIDOS EXCLUSIVOS: Utiliza únicamente los comandos documentados:
  - `npm ci --ignore-scripts`
  - `npm test`
  - `node scripts/deploy.mjs` (opciones: `--dry-run`, `--update`, `--adopt-agent`, `--rollback-source`, `--agent-dir`, `--install-dir`)
  - `node scripts/rollback.mjs`
  - `node scripts/doctor.mjs`
  - `/reload`
  - `/compaction`

## Pasos de Ejecución

### 1. Leer la Documentación
Revisa la documentación de despliegue antes de iniciar modificaciones en el sistema de archivos:
- `docs/en/installation.md` (o `docs/es/instalacion.md`)
- `docs/en/agent-install.md` (o `docs/es/instalacion-agente.md`)
- `docs/en/troubleshooting.md` (o `docs/es/solucion-de-problemas.md`)

### 2. Inspeccionar el Entorno y los Directorios de Trabajo
Inspecciona el entorno del anfitrión y define las rutas estándar:
- Verificar versión de Node.js: `node -v` (debe ser `>=22.19.0`).
- Resolver directorios destino mediante variables de entorno o valores predeterminados:
  - `$AGENT_DIR`: Definido por `$PI_CODING_AGENT_DIR` si existe, o `$HOME/.pi/agent`.
  - `$INSTALL_DIR`: Definido como `$AGENT_DIR` (o una raíz personalizada de instalación si se especifica).
- Inspeccionar archivos existentes y el estado del entorno:
  - Comprobar existencia del loader en `$AGENT_DIR/extensions/omniroute-compaction.ts`.
  - Comprobar existencia del manifiesto en `$AGENT_DIR/.pi-auto-compaction-manifest.json`.
  - Comprobar existencia del marcador de despliegue en `$INSTALL_DIR/.pi-auto-compaction-deploy.json`.
  - Comprobar si existen journals de recuperación bajo `$INSTALL_DIR/.pi-auto-compaction-state/`. Si algún journal tiene estado `pending`, detén la ejecución y reporta el error.

### 3. Ejecutar Pruebas
Verifica la integridad del repositorio antes de ejecutar scripts de despliegue:
```bash
npm test
```
Confirma que las 326 pruebas pasen en las 33 suites.

### 4. Ejecutar Simulación de Despliegue (Dry-Run)
Simula el despliegue para comprobar las operaciones previstas sin escribir cambios:
```bash
node scripts/deploy.mjs --dry-run --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
```

### 5. Seleccionar Modo de Despliegue y Desplegar
Elige el modo adecuado según la inspección del Paso 2:
- **Despliegue Limpio**: Si no existen loader ni manifiesto previos:
  ```bash
  node scripts/deploy.mjs --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
  ```
- **Modo de Adopción (`--adopt-agent`)**: Si ya existe un loader no gestionado o externo en `$AGENT_DIR/extensions/omniroute-compaction.ts` sin un manifiesto activo:
  ```bash
  node scripts/deploy.mjs --adopt-agent --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
  ```
- **Modo de Actualización (`--update`)**: Si ya existe un despliegue gestionado activo (`.pi-auto-compaction-deploy.json` en estado `ready`) y el código fuente ha cambiado:
  ```bash
  node scripts/deploy.mjs --update --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
  ```

Nota: El script de despliegue administra automáticamente respaldos atómicos y journals dentro de `$INSTALL_DIR/.pi-auto-compaction-state/` antes de modificar cualquier archivo destino.

### 6. Recargar el Entorno de Extensiones
Registra la extensión recién desplegada en la sesión activa de Pi:
```text
/reload
```

### 7. Ejecutar Diagnósticos
Ejecuta el comando no destructivo doctor para verificar la salud del despliegue:
```bash
node scripts/doctor.mjs --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
```
Verificar código de salida:
- `0`: Entorno saludable y todas las comprobaciones aprobadas.
- `1`: Advertencias informativas presentes (ej. ventana de contexto reducida o anulación no gestionada).
- `2`: Error fatal (deriva, discrepancia de hash o journal pendiente). Detener y reportar.

### 8. Verificar y Configurar Modelos Resumidores
Verifica o ajusta los modelos resumidores activo primario y de respaldo:
```text
/compaction
```
Inspecciona la configuración actual del resumidor y confirma los modelos.

### 9. Entregar Reporte de Verificación
Devuelve un reporte estructurado de finalización que detalle:
- **Acción Realizada**: Despliegue limpio, adopción, actualización o diagnóstico.
- **Comandos y Resultados**: Lista completa de comandos ejecutados con códigos de salida.
- **Diagnóstico de Doctor**: Estado de salud, código de salida y cualquier advertencia detectada.
- **Estado del Loader**: Ruta y estado de verificación de `$AGENT_DIR/extensions/omniroute-compaction.ts`.
- **Configuración de Resumidor**: Modelos activo primario y de respaldo.
- **Estado de Seguridad**: Confirmación de que no se accedió a secretos, no se sobrescribieron configuraciones de usuario y no quedaron journals huérfanos.
```
