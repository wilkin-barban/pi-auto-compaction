# Guía de Mantenimiento y Actualizaciones

Mantenimiento, actualización, reversión (rollback) y recuperación de despliegues de **pi-auto-compaction** en estaciones de desarrollo y entornos gestionados de agentes.

---

## Ruta rápida: Secuencia de actualización rutinaria (Quick Path)

Para actualizar una instalación activa cuando se publican cambios en el repositorio remoto:

1. **Navegar a la fuente y verificar que el árbol esté limpio**:
   ```bash
   cd "$HOME/proyectos/pi-auto-compaction"
   git status
   ```

2. **Descargar actualizaciones y ejecutar pruebas**:
   ```bash
   git pull --ff-only origin main
   npm ci --ignore-scripts
   npm test
   ```
   *Señal esperada*: **326 pruebas aprobadas en 33 suites**.

3. **Simular la actualización (`--dry-run`)**:
   ```bash
   AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
   INSTALL_DIR="${PI_AUTO_COMPACTION_INSTALL_DIR:-$HOME/.local/share/pi-auto-compaction}"

   node scripts/deploy.mjs --update --dry-run --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
   ```

4. **Aplicar la actualización**:
   ```bash
   node scripts/deploy.mjs --update --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
   ```

5. **Recargar Pi y verificar**:
   Dentro de una sesión activa de Pi:
   ```text
   /reload
   ```
   En la terminal:
   ```bash
   node scripts/doctor.mjs --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
   ```
   *Señal esperada*: Código de salida `0`, `healthy`.

---

## 1. Rollback de fuentes vs. Desinstalación de configuración

Comprende las diferencias entre revertir el código en tiempo de ejecución y remover completamente la extensión:

| Aspecto | Rollback de fuentes (`--rollback-source`) | Desinstalación de configuración (`rollback.mjs`) |
|---|---|---|
| **Comando** | `node scripts/deploy.mjs --rollback-source --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"` | `node scripts/rollback.mjs --target-dir "$AGENT_DIR"` |
| **Propósito** | Revertir el código activo de la extensión al release inmutable previo tras detectar un error en tiempo de ejecución. | Desinstalar la extensión de Pi y restaurar la configuración original previa a la instalación. |
| **Impacto en el loader** | Vuelve a apuntar el loader al release anterior: `releases/<sha256-anterior>/index.mjs`. | Elimina el archivo loader: `$AGENT_DIR/extensions/omniroute-compaction.ts`. |
| **Impacto en el manifiesto** | Actualiza `loaderHash` y el directorio fuente en el manifiesto. Conserva `originalOverrides`. | Elimina el archivo manifiesto: `$AGENT_DIR/.pi-auto-compaction-manifest.json`. |
| **Impacto en settings** | Conserva intactos todos los overrides de tokens y preferencias de resumidores. | Restaura los valores originales de tokens en `$AGENT_DIR/settings.json` desde `originalOverrides`. |
| **Releases preservados** | Sí. Todas las carpetas de release se conservan en `$INSTALL_DIR/releases/`. | Sí. La raíz de instalación y las carpetas de release se mantienen intactas en disco. |
| **Idempotencia** | Operación unitaria de un solo paso. Ejecutarla dos veces resulta en un no-op limpio (`noop: true`). | Totalmente idempotente. Ejecutarla sin un manifiesto es un no-op seguro. |

### Detalles del Rollback de fuentes (`--rollback-source`)
- Revierte estrictamente a la versión registrada en `previous` dentro de `$INSTALL_DIR/.pi-auto-compaction-deploy.json`.
- Tras la ejecución, `current` pasa a ser el release anterior y `previous` se convierte en `null`.
- **Límite en adopciones**: En una instalación creada mediante `--adopt-agent`, el release inicial tiene `previous: null`. Ejecutar `--rollback-source` inmediatamente después de la adopción es un no-op limpio (`noop: true`). Para revertir un agente adoptado a su estado previo a la adopción, ejecute el setup desde el directorio de la fuente antigua preservada:
  ```bash
  OLD_SOURCE_DIR="${OLD_SOURCE_DIR:-$HOME/.local/share/pi-auto-compaction}"
  node "$OLD_SOURCE_DIR/scripts/setup.mjs" --source-dir "$OLD_SOURCE_DIR" --target-dir "$AGENT_DIR"
  ```
  *Aviso de Metadata DESYNC*: Ejecutar el setup desde la fuente antigua revierte el loader del agente, pero deja `$INSTALL_DIR/.pi-auto-compaction-deploy.json` apuntando al release gestionado. Futuros comandos `--update` fallarán con `Agent manifest source ownership mismatch`. Reconcilie manualmente; no elimine marcadores ni journals.

---

## 2. Journals de recuperación y restauración del estado pending

Si una transacción de despliegue o desinstalación se interrumpe (corte de energía, cierre forzado de terminal, `SIGKILL`), las guardas transaccionales bloquean la instalación para evitar inconsistencias.

### Síntomas de una transacción interrumpida
- `deploy.mjs` falla con: `Pending deployment journal: manual reconciliation required; do not delete marker/journals`.
- `doctor.mjs` falla con código de salida `2` reportando el marcador de despliegue en estado `pending`.
- Existen archivos de journal en `$INSTALL_DIR/journals/<lockToken>.json` o en `$AGENT_DIR/.pi-auto-compaction-state/recovery-journal.json`.

### Procedimiento seguro de recuperación

1. **No borre archivos a ciegas**: Nunca elimine `.pi-auto-compaction-deploy.json`, `.deploy.lock` ni archivos de journal. Eliminarlos destruye la línea base de recuperación.
2. **Inspeccionar el contenido de los journals**:
   ```bash
   cat "$INSTALL_DIR/journals/"*.json
   cat "$AGENT_DIR/.pi-auto-compaction-state/recovery-journal.json"
   ```
3. **Ejecutar una simulación no destructiva (`--dry-run`)**:
   ```bash
   node scripts/deploy.mjs --update --dry-run --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
   ```
4. **Inspeccionar el estado en disco**: Compruebe si `$AGENT_DIR/extensions/omniroute-compaction.ts` y `$AGENT_DIR/settings.json` reflejan el release deseado o el estado anterior.
5. **Reconciliar el estado del marcador**: Una vez que los archivos coinciden con el release esperado, restablezca `"state": "ready"` en `$INSTALL_DIR/.pi-auto-compaction-deploy.json`.

---

## 3. Detección y corrección de drift en la configuración

El drift ocurre cuando modificaciones externas alteran archivos gestionados mientras la extensión está activa:
- `settings.json`: Los overrides de tokens para los 8 modelos gestionados difieren de las políticas en `policies` del manifiesto.
- `omniroute-compaction.ts`: El archivo fue modificado manualmente (el hash no coincide con `loaderHash`).
- `.pi-auto-compaction-manifest.json`: El manifiesto fue eliminado o alterado.

### Identificar drift con doctor

```bash
node scripts/doctor.mjs --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
```

Si existe drift, `doctor` imprime mensajes de advertencia indicando los modelos desalineados o sale con código `2` ante archivos faltantes.

### Pasos de corrección

1. Revise las políticas requeridas en `$AGENT_DIR/.pi-auto-compaction-manifest.json` bajo la sección `policies`.
2. Abra `$AGENT_DIR/settings.json` y restaure los valores numéricos exactos de `reserveTokens` y `keepRecentTokens` para los modelos gestionados afectados.
3. Si el loader fue modificado, copie la plantilla oficial del loader o vuelva a ejecutar `deploy.mjs --update` una vez que la configuración coincida.
4. Verifique la resolución ejecutando `npm run doctor`.

---

## 4. Políticas de retención y limpieza de releases

Para asegurar la estabilidad de sesiones activas en segundo plano:

- **Retención inmutable**: Cada despliegue escribe en una nueva carpeta `$INSTALL_DIR/releases/<sha256>`.
- **Por qué se conservan los releases**: Los procesos activos de terminal en Pi mantienen descriptores de archivos y referencias en memoria hacia el directorio de release que cargaron al arrancar. Eliminar automáticamente releases anteriores podría hacer fallar las sesiones en ejecución.
- **Limpieza manual**: Puede depurar carpetas de releases antiguas que no figuren en `$INSTALL_DIR/.pi-auto-compaction-deploy.json` como `current` o `previous` **únicamente después** de que todas las sesiones activas de Pi hayan ejecutado `/reload` o se hayan reiniciado.

---

## 5. Gestión del archivo de configuración del resumidor

Las preferencias configuradas mediante `/compaction` residen en `$AGENT_DIR/.pi-auto-compaction-settings.json`.

### Respaldar la configuración (Backup)

```bash
SETTINGS_FILE="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/.pi-auto-compaction-settings.json"
cp "$SETTINGS_FILE" "$HOME/.pi-auto-compaction-settings.backup.json"
```

### Restablecer modelos a valores por defecto (Reset)

Para descartar elecciones personalizadas de resumidores y restablecer los modelos predeterminados (`omniroute/antigravity/gemini-3.8-flash-tiered` y `gemini-3.6-flash-high`):

```bash
rm "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/.pi-auto-compaction-settings.json"
```
Tras eliminar el archivo, ejecute `/reload` en las sesiones activas de Pi. Pi cargará limpiamente los modelos de resumen predeterminados sin emitir advertencias.

### Reconfiguración mediante variables de entorno

En entornos automatizados, omita el selector interactivo exportando las siguientes variables:

```bash
export PI_AUTO_COMPACTION_PRIMARY_PROVIDER="openai"
export PI_AUTO_COMPACTION_PRIMARY_MODEL="gpt-4o"
export PI_AUTO_COMPACTION_FALLBACK_PROVIDER="openai"
export PI_AUTO_COMPACTION_FALLBACK_MODEL="gpt-4o-mini"
```

---

## Lista de comprobación de mantenimiento (Maintenance Verification Checklist)

Antes de dar por concluida cualquier operación de mantenimiento, verifique:

- [ ] El árbol de trabajo está limpio en `origin/main`.
- [ ] `npm test` pasa completamente (326 pruebas en 33 suites).
- [ ] Se ejecutó `deploy.mjs --dry-run` antes de aplicar los cambios en disco.
- [ ] Las sesiones activas de Pi ejecutaron `/reload`.
- [ ] `npm run doctor` retorna código de salida `0` (`healthy`).
- [ ] El marcador de despliegue `$INSTALL_DIR/.pi-auto-compaction-deploy.json` se encuentra en `state: "ready"`.
- [ ] No existen archivos `.deploy.lock` ni journals de recuperación pendientes.

---

## Próximos pasos

- Consultar pasos de solución de problemas: [`docs/es/solucion-de-problemas.md`](solucion-de-problemas.md)
- Revisar la arquitectura del sistema: [`docs/es/arquitectura.md`](arquitectura.md)
- Automatizar operaciones con agentes de IA: [`docs/es/instalacion-agente.md`](instalacion-agente.md)
