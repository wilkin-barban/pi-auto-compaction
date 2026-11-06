# Protocolo de Instalación Automatizada para Agentes de IA

Automatiza la inspección, respaldo seguro (snapshot), despliegue y verificación de **pi-auto-compaction** utilizando agentes autónomos de codificación basados en IA.

Esta guía proporciona el contrato operacional, la tabla de decisión de modos, las invariantes de seguridad y un prompt completo para copiar y pegar dirigido a subagentes, orquestadores y entornos automatizados.

---

## Ruta rápida para agentes (Quick Path)

Un agente que ejecute un despliegue automatizado debe seguir este contrato de seis etapas:

1. **Inspeccionar el entorno**: Comprobar versión de Node.js (`>=22.19.0`), resolver `$AGENT_DIR` e `$INSTALL_DIR`, e inspeccionar manifiestos o marcadores existentes.
2. **Capturar snapshot seguro**: Crear un directorio de respaldo temporal y privado (`0700` directorio, `0600` archivos) con la configuración previa. Nunca copiar `auth.json`.
3. **Seleccionar puerta de decisión**: Evaluar la Tabla de Decisión para elegir entre Instalación limpia, Adopción (`--adopt-agent`) o Actualización (`--update`).
4. **Ejecutar transacción**: Ejecutar siempre `--dry-run` primero. Aplicar el comando de despliegue en caliente únicamente cuando el dry-run concluya con éxito.
5. **Recargar y verificar**: Solicitar `/reload` en las sesiones activas de Pi. Ejecutar `doctor --json` y verificar los códigos de salida.
6. **Reportar handoff estructurado**: Retornar un recibo conciso al orquestador con el estado, el hash del release y los umbrales efectivos confirmados.

---

## El Contrato del Agente

Cuando se delega la tarea de instalar o mantener `pi-auto-compaction`, el agente opera bajo estrictas garantías de ciclo de vida:

| Etapa | Responsabilidad | Acción ante fallo |
|---|---|---|
| **1. Inspección** | Verificar seguridad de rutas, comprobar ausencia de enlaces simbólicos prohibidos y detectar si ya existen manifiestos o marcadores. | Detenerse inmediatamente si se detectan enlaces simbólicos o solapamiento de rutas. |
| **2. Snapshot** | Respaldar `settings.json`, manifiesto y loader en una carpeta temporal aislada bajo `$HOME`. Excluir `auth.json`. | Detenerse si el directorio de respaldo no puede crearse con permisos `0700`. |
| **3. Decisión** | Emparejar el estado del sistema con exactamente un modo de despliegue. Nunca adivinar. | Detenerse si el marcador indica estado `pending` o si existen bloqueos activos. |
| **4. Ejecución** | Ejecutar `--dry-run` para compilar módulos con `vm.SourceTextModule` y verificar hashes antes de mutar el disco. | Fail-closed ante errores en subprocesos. No borrar marcadores ni journals. |
| **5. Verificación** | Solicitar `/reload` en Pi, ejecutar `doctor --json` y comprobar código de salida `0` (`healthy`). | Reportar advertencias (`exit 1`) o errores (`exit 2`) en el reporte final. |
| **6. Reporte** | Producir un resumen determinista con rutas canónicas, hash del release y códigos de salida. | Nunca reportar éxito cuando una verificación obligatoria esté fallando. |

---

## Tabla de Decisión para Agentes

Antes de invocar cualquier script de despliegue, evalúe esta matriz de decisión frente al estado observado del sistema de archivos:

| Condición en `$INSTALL_DIR` | Condición en `$AGENT_DIR` | Modo seleccionado | Acción / Comando |
|---|---|---|---|
| No existe (`!exists(root)`) | Sin loader ni manifiesto | **Instalación limpia** | `node scripts/deploy.mjs --dry-run`<br>`node scripts/deploy.mjs` |
| No existe (`!exists(root)`) | Contiene loader y manifiesto v1/v2 válidos | **Adopción de agente** | `node scripts/deploy.mjs --adopt-agent --dry-run --install-dir <nueva-raíz>`<br>`node scripts/deploy.mjs --adopt-agent --install-dir <nueva-raíz>` |
| Existe con marcador (`state: "ready"`) | El loader apunta a `current.path` | **Actualización** | `node scripts/deploy.mjs --update --dry-run`<br>`node scripts/deploy.mjs --update` |
| Existe con marcador (`state: "ready"`) | Se observa regresión en runtime | **Rollback de fuentes** | `node scripts/deploy.mjs --rollback-source` |
| Existe sin marcador válido | Cualquier estado | **RECHAZAR** | Detenerse: Raíz no gestionada. Requiere revisión humana o un `$INSTALL_DIR` distinto. |
| Existe con marcador (`state: "pending"`) | Cualquier estado | **RECHAZAR** | Detenerse: Transacción interrumpida. Inspeccionar journals; no borrar el marcador. |
| Cualquier estado | Existe archivo lock o journal de recuperación | **RECHAZAR** | Detenerse: Bloqueo activo o recuperación pendiente. Requiere reconciliación manual. |

---

## Invariantes de Seguridad para Agentes Automatizados

Los agentes deben acatar estrictamente estas reglas duras de seguridad:

1. **Nunca borrar marcadores ni journals**: Jamás elimine `.pi-auto-compaction-deploy.json`, `.deploy.lock`, `recovery-journal.json` ni archivos bajo `journals/`. Su presencia señala un estado interrumpido que exige compensación, no eliminación.
2. **Nunca crear `$INSTALL_DIR` con `mkdir`**: `deploy.mjs` exige crear su propio directorio raíz durante la instalación inicial. Si existe una carpeta vacía sin marcador de despliegue, el script la rechazará como raíz no gestionada.
3. **Nunca tocar ni respaldar `auth.json`**: Las credenciales permanecen bajo la custodia exclusiva de Pi. Nunca copie, inspeccione ni registre el contenido de `auth.json`.
4. **Nunca modificar `settings.json` para resumidores**: Las preferencias de resumidores pertenecen exclusivamente a `.pi-auto-compaction-settings.json`. Nunca inserte claves de resumidores en `settings.json`.
5. **Rechazar todos los enlaces simbólicos**: Cada argumento de ruta (`--agent-dir`, `--install-dir`, `--source-dir`) se comprueba contra symlinks en todos sus directorios ancestros. Rechace enlaces simbólicos inmediatamente.

---

## Prompt Completo para Copiar y Pegar (Agent Prompt)

Suministre este prompt completo a un agente autónomo para ejecutar la instalación o actualización de extremo a extremo:

```markdown
Eres un agente autónomo de codificación con IA encargado de instalar y configurar `pi-auto-compaction` para Pi y gentle-shell.

Sigue estrictamente el contrato del agente y las guardas de seguridad.

### Rutas del entorno
- Código del repositorio: `$HOME/proyectos/pi-auto-compaction` (o define `$SOURCE_DIR`)
- Directorio del agente Pi: `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}`
- Directorio de releases durables: `${PI_AUTO_COMPACTION_INSTALL_DIR:-$HOME/.local/share/pi-auto-compaction}`

### Pasos de ejecución

1. **Árbol de trabajo y pruebas**:
   Navega a la fuente del repositorio y verifica dependencias y pruebas:
   ```bash
   cd "$SOURCE_DIR"
   npm ci --ignore-scripts
   npm test
   ```
   Confirma que se aprueban las 326 pruebas en 33 suites. Si alguna prueba falla, DETENTE y reporta el fallo.

2. **Inspeccionar estado del sistema de archivos**:
   Comprueba si existen `$AGENT_DIR/extensions/omniroute-compaction.ts` y `$AGENT_DIR/.pi-auto-compaction-manifest.json`.
   Comprueba si existe `$INSTALL_DIR/.pi-auto-compaction-deploy.json`.

3. **Snapshot seguro previo a la instalación**:
   Si ya existen archivos previos en el agente, captura una instantánea privada:
   ```python
   import os, sys, tempfile, hashlib
   agent = os.path.expanduser(os.environ.get("PI_CODING_AGENT_DIR", "~/.pi/agent"))
   files = ["settings.json", ".pi-auto-compaction-manifest.json", "extensions/omniroute-compaction.ts"]
   backup_dir = tempfile.mkdtemp(prefix="agent-snapshot-", dir=os.path.expanduser("~"))
   os.chmod(backup_dir, 0o700)
   for f in files:
       src = os.path.join(agent, f)
       if os.path.exists(src):
           dest = os.path.join(backup_dir, f.replace("/", "__"))
           with open(src, "rb") as s, open(dest, "wb") as d:
               d.write(s.read())
           os.chmod(dest, 0o600)
   print(f"Snapshot creado en: {backup_dir}")
   ```

4. **Seleccionar modo y ejecutar `--dry-run`**:
   - Si `$INSTALL_DIR` NO existe y el agente está limpio:
     ```bash
     node scripts/deploy.mjs --dry-run --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
     node scripts/deploy.mjs --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
     ```
   - Si `$INSTALL_DIR` NO existe y el agente ya posee un manifiesto/loader válido:
     ```bash
     ADOPT_DIR="$HOME/.local/share/pi-auto-compaction-managed"
     node scripts/deploy.mjs --adopt-agent --dry-run --agent-dir "$AGENT_DIR" --install-dir "$ADOPT_DIR"
     node scripts/deploy.mjs --adopt-agent --agent-dir "$AGENT_DIR" --install-dir "$ADOPT_DIR"
     ```
   - Si `$INSTALL_DIR` ya existe con marcador (`state: "ready"`):
     ```bash
     node scripts/deploy.mjs --update --dry-run --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
     node scripts/deploy.mjs --update --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
     ```

5. **Verificar la instalación**:
   Ejecuta la herramienta de diagnóstico doctor con salida en JSON:
   ```bash
   node scripts/doctor.mjs --json --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
   ```
   Verifica que:
   - El código de salida sea `0` (o `1` si hay advertencias benignas de catálogo).
   - El estado del marcador sea `"ready"`.
   - Los hashes del loader y del manifiesto coincidan.

6. **Retornar reporte estructurado**:
   Retorna un resumen de estado conciso que contenga:
   - `status`: completed | partial | blocked
   - `method`: fresh | adopt-agent | update
   - `release_hash`: <sha256>
   - `marker_state`: ready
   - `doctor_exit_code`: 0 | 1 | 2
   - `warnings`: lista de advertencias o none
```

---

## Lista de Comprobación para Agentes (Verification Checklist)

Los agentes autónomos deben validar las siguientes condiciones antes de reportar la finalización del trabajo:

- [ ] Árbol de trabajo limpio y `npm test` aprobado (326/326 pruebas en 33 suites).
- [ ] Snapshot previo a la ejecución capturado en directorio `0700` si el agente ya estaba gestionado.
- [ ] `--dry-run` fue ejecutado y reportó éxito antes del despliegue en vivo.
- [ ] El marcador de despliegue `$INSTALL_DIR/.pi-auto-compaction-deploy.json` tiene `"state": "ready"`.
- [ ] El loader `$AGENT_DIR/extensions/omniroute-compaction.ts` existe e importa el release activo.
- [ ] El manifiesto v2 `$AGENT_DIR/.pi-auto-compaction-manifest.json` existe con `"version": "2.0.0"`.
- [ ] `node scripts/doctor.mjs --json` finaliza con código `0`.
- [ ] No quedan archivos temporales, excepciones no capturadas ni journals huérfanos.

---

## Próximos pasos

- Revisar la guía de instalación manual: [`docs/es/instalacion.md`](instalacion.md)
- Inspeccionar la definición formal de skill: [`skills/pi-auto-compaction/SKILL.md`](../../skills/pi-auto-compaction/SKILL.md)
- Consultar el asset de prompt independiente: [`skills/pi-auto-compaction/assets/agent-install-prompt.es.md`](../../skills/pi-auto-compaction/assets/agent-install-prompt.es.md)
