# Installation and Deployment Guide

Install, verify, adopt, and manage **pi-auto-compaction** across fresh environments or existing agent configurations.

---

## Quick Path

For a clean, initial installation on a standard Linux workstation:

1. **Clone the repository**:
   ```bash
   git clone https://github.com/wilkin-barban/pi-auto-compaction.git "$HOME/proyectos/pi-auto-compaction"
   cd "$HOME/proyectos/pi-auto-compaction"
   ```

2. **Install dependencies and test**:
   ```bash
   npm ci --ignore-scripts
   npm test
   ```
   *Expected signal*: **326 passing tests across 33 suites**.

3. **Dry-run deployment**:
   ```bash
   node scripts/deploy.mjs --dry-run
   ```

4. **Deploy durable release**:
   ```bash
   node scripts/deploy.mjs
   ```

5. **Reload Pi session**:
   Inside an active Pi terminal session, run:
   ```text
   /reload
   ```

6. **Configure summarizers (Optional)**:
   ```text
   /compaction
   ```

7. **Verify health with doctor**:
   ```bash
   node scripts/doctor.mjs
   ```
   *Expected signal*: Exit code `0`, `healthy`.

---

## Prerequisites

Before deploying, verify that your host environment meets these operational requirements:

| Component | Requirement | Verification Command / Notes |
|---|---|---|
| **Operating System** | Linux | Validated platform. No formal support guarantees for macOS or native Windows. |
| **Node.js** | `>=22.19.0` | `node -v` (CI validates Node 22 and Node 24; local development on Node 22.23.2). |
| **Pi Coding Agent** | Active installation | Default agent directory: `$HOME/.pi/agent` (or `$PI_CODING_AGENT_DIR`). Compatible with Pi 1.5.0+. |
| **Summarizer Credentials** | Configured in Pi | Default: OmniRoute (`omniroute/antigravity/gemini-3.8-flash-tiered`). If configuring other providers in `/compaction`, valid auth must exist in Pi. |
| **Conversation Credentials** | Active in `auth.json` | Active chat model credentials must be valid in `$HOME/.pi/agent/auth.json`. Pi checks conversation auth *before* triggering compaction hooks. |
| **Git / GitHub** | Working tree access | Clone access to the repository. |

> **Gentle-Shell & SDK Resolution Note**: If gentle-shell is your sole Pi environment and the loader cannot locate the Pi SDK, export `PI_CODING_AGENT_PATH` pointing to the Pi package directory used by gentle-shell. The SDK resolver in `src/pi-sdk.mjs` checks the local SDK, `~/.local/lib/node_modules`, `/usr/local/lib/node_modules`, and `/usr/lib/node_modules`.

---

## Canonical Paths and Environment Variables

The installation wrapper manages four distinct layers:

1. **Source Directory (`$SOURCE_DIR`)**: Git repository checkout (default: current directory or `$HOME/proyectos/pi-auto-compaction`).
2. **Release Root (`$INSTALL_DIR`)**: Immutable versioned releases under `$INSTALL_DIR/releases/<sha256>` and transactional journals under `$INSTALL_DIR/journals/` (default: `$HOME/.local/share/pi-auto-compaction`).
3. **Agent Directory (`$AGENT_DIR`)**: Pi configuration home containing `settings.json`, manifest `.pi-auto-compaction-manifest.json`, and loader `extensions/omniroute-compaction.ts` (default: `$PI_CODING_AGENT_DIR` or `$HOME/.pi/agent`).
4. **Telemetry Directory**: `$HOME/.local/state/pi-auto-compaction/` exclusively storing `compaction.jsonl`.

### Supported Environment Variables

| Variable | Default Value | Purpose |
|---|---|---|
| `PI_CODING_AGENT_DIR` | `$HOME/.pi/agent` | Overrides the target Pi agent configuration directory. |
| `PI_CODING_AGENT_PATH` | Unset (auto-discovered) | Explicit path to `@earendil-works/pi-coding-agent` for standalone or gentle-shell hosts. |
| `PI_AUTO_COMPACTION_INSTALL_DIR` | `$HOME/.local/share/pi-auto-compaction` | Overrides the durable release root. |
| `PI_AUTO_COMPACTION_SETTINGS_PATH` | `$AGENT_DIR/.pi-auto-compaction-settings.json` | Explicit path to the summarizer preferences file. |
| `PI_AUTO_COMPACTION_PRIMARY_PROVIDER` | Unset | Headless override for primary summarizer provider. |
| `PI_AUTO_COMPACTION_PRIMARY_MODEL` | Unset | Headless override for primary summarizer model ID. |
| `PI_AUTO_COMPACTION_FALLBACK_PROVIDER` | Unset | Headless override for fallback summarizer provider. |
| `PI_AUTO_COMPACTION_FALLBACK_MODEL` | Unset | Headless override for fallback summarizer model ID. |
| `PI_AUTO_COMPACTION_SKIP_PROVIDERS` | Empty (`""`) | Comma-separated list of conversation providers to bypass external summarization. |

---

## Method 1: Fresh Installation

Use this method when installing into a clean Pi agent directory without pre-existing loaders or manifests.

### Step 1: Clone and Test

```bash
git clone https://github.com/wilkin-barban/pi-auto-compaction.git "$HOME/proyectos/pi-auto-compaction"
cd "$HOME/proyectos/pi-auto-compaction"
npm ci --ignore-scripts
npm test
```
*Expected test outcome*:
```text
# tests 326
# suites 33
# pass 326
# fail 0
```

### Step 2: Simulate with `--dry-run`

```bash
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
INSTALL_DIR="${PI_AUTO_COMPACTION_INSTALL_DIR:-$HOME/.local/share/pi-auto-compaction}"

node scripts/deploy.mjs --dry-run --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
```

The dry-run performs strict syntax verification on all modules using `vm.SourceTextModule`, validates file allowlists, checks for forbidden symlinks, and confirms ownership without writing any files.

### Step 3: Execute Deployment

```bash
node scripts/deploy.mjs --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
```

**Deployment Actions**:
1. Creates directory `$INSTALL_DIR` (must not exist beforehand; do not create with `mkdir`).
2. Copies source files into an immutable release directory: `$INSTALL_DIR/releases/<sha256>`.
3. Validates file integrity against `.release.json`.
4. Writes deploy marker `$INSTALL_DIR/.pi-auto-compaction-deploy.json` with `state: "pending"`.
5. Executes `setup.mjs`, creating loader `omniroute-compaction.ts` and manifest `.pi-auto-compaction-manifest.json` in `$AGENT_DIR`.
6. Commits deploy marker to `state: "ready"`.

### Step 4: Reload Pi and Configure

```text
/reload
/compaction
```

---

## Method 2: Adopting an Existing Managed Agent (`--adopt-agent`)

Use this method if the target agent directory already contains an official loader (`extensions/omniroute-compaction.ts`) and manifest (`.pi-auto-compaction-manifest.json`) from a previous flat installation, and you want to migrate it to managed immutable releases.

### Safety Invariants for Adoption
- **New Install Root Required**: You must specify a **new, non-existent** `--install-dir` (e.g., `$HOME/.local/share/pi-auto-compaction-managed`). Specifying an existing unmanaged root will be rejected fail-closed.
- **Old Source Preserved**: The source directory referenced in the previous manifest's `packageSourceDir` is kept intact on disk. It is never overwritten or deleted.
- **No Drift**: Token overrides in `settings.json` must match manifest `policies`.
- **Never Delete Markers or Journals**: Do not delete `.pi-auto-compaction-deploy.json` or recovery journals to bypass validation.

### Step 1: Create a Secure Pre-Adoption Snapshot

Before running adoption, capture a secure, isolated backup of the agent configuration. Do not create `.bak` files inside `$AGENT_DIR` (they risk permission leaks and pollute the agent tree).

Run this canonical snapshot procedure:

```python
   import os, sys, tempfile, stat, hashlib

   def get_current_uid():
       return os.getuid() if hasattr(os, "getuid") else None

   def verify_path_ancestors(target_path, home_path):
       current_uid = get_current_uid()
       absolute = os.path.abspath(target_path)
       real_home = os.path.abspath(home_path) if home_path else None
       cursor = os.path.splitdrive(absolute)[0] + os.sep
       parts = [p for p in absolute[len(cursor):].split(os.sep) if p]

       for part in parts:
           cursor = os.path.join(cursor, part)
           if not os.path.lexists(cursor):
               break
           st = os.lstat(cursor)
           if stat.S_ISLNK(st.st_mode):
               sys.exit(f"Error de seguridad: ancestro o ruta {cursor} es un enlace simbólico; abortando.")
           if current_uid is not None:
               is_under_home = real_home and (cursor == real_home or cursor.startswith(real_home + os.sep))
               if is_under_home:
                   if st.st_uid != current_uid:
                       sys.exit(f"Error de seguridad: {cursor} dentro de HOME pertenece a UID {st.st_uid} (se requiere UID actual {current_uid}); abortando.")
               else:
                   if st.st_uid != 0 and st.st_uid != current_uid:
                       sys.exit(f"Error de seguridad: ancestro del sistema {cursor} pertenece a UID {st.st_uid} (se permite root 0 o {current_uid}); abortando.")
       return absolute

   home_dir = os.environ.get("HOME") or os.path.expanduser("~")
   agent_dir = os.environ.get("AGENT_DIR") or os.environ.get("PI_CODING_AGENT_DIR") or os.path.join(home_dir, ".pi", "agent")
   base_backup_dir = os.path.join(home_dir, ".local", "state", "pi-auto-compaction-backups")

   # 1. Verificar ancestros antes de cualquier mkdir o chmod
   verify_path_ancestors(agent_dir, home_dir)
   verify_path_ancestors(os.path.dirname(base_backup_dir), home_dir)

   current_uid = get_current_uid()

   # 2. Asegurar directorio base privado (0700) bajo HOME; rehusar si pertenece a otro UID o es symlink
   if os.path.lexists(base_backup_dir):
       st = os.lstat(base_backup_dir)
       if stat.S_ISLNK(st.st_mode):
           sys.exit(f"Error de seguridad: directorio base {base_backup_dir} es un enlace simbólico; abortando.")
       if not stat.S_ISDIR(st.st_mode):
           sys.exit(f"Error de seguridad: directorio base {base_backup_dir} no es un directorio; abortando.")
       if current_uid is not None and st.st_uid != current_uid:
           sys.exit(f"Error de seguridad: directorio base {base_backup_dir} pertenece a otro usuario (UID {st.st_uid}); abortando sin alterar permisos.")
       if (st.st_mode & 0o777) != 0o700:
           os.chmod(base_backup_dir, 0o700)
   else:
       os.makedirs(base_backup_dir, mode=0o700, exist_ok=True)
       os.chmod(base_backup_dir, 0o700)

   verify_path_ancestors(base_backup_dir, home_dir)

   # 3. Crear directorio exclusivo e irrepetible para este snapshot pre-adopción
   backup_dir = tempfile.mkdtemp(prefix="pre-migration-", dir=base_backup_dir)
   os.chmod(backup_dir, 0o700)

   # 4. Snapshot de archivos gestionados (falla cerrado si falta cualquiera, symlink, hardlink o UID ajeno)
   targets = [
       ("settings.json", os.path.join(agent_dir, "settings.json")),
       (".pi-auto-compaction-manifest.json", os.path.join(agent_dir, ".pi-auto-compaction-manifest.json")),
       ("omniroute-compaction.ts", os.path.join(agent_dir, "extensions", "omniroute-compaction.ts")),
   ]

   metadata = []
   for name, src in targets:
       verify_path_ancestors(src, home_dir)
       if not os.path.lexists(src):
           sys.exit(f"Error: archivo requerido {src} no existe; abortando snapshot fail-closed.")
       st = os.lstat(src)
       if stat.S_ISLNK(st.st_mode):
           sys.exit(f"Error de seguridad: archivo requerido {src} es un enlace simbólico; abortando.")
       if not stat.S_ISREG(st.st_mode):
           sys.exit(f"Error de seguridad: archivo requerido {src} no es un archivo regular; abortando.")
       if current_uid is not None and st.st_uid != current_uid:
           sys.exit(f"Error de seguridad: archivo {src} pertenece a UID {st.st_uid} (se requiere UID actual {current_uid}); abortando.")
       if st.st_nlink != 1:
           sys.exit(f"Error de seguridad: archivo {src} tiene enlaces duros adicionales (nlink={st.st_nlink}); abortando.")

       dst = os.path.join(backup_dir, name)
       fd_dst = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
       hasher = hashlib.sha256()
       with open(src, "rb") as f_src, os.fdopen(fd_dst, "wb") as f_dst:
           while chunk := f_src.read(65536):
               hasher.update(chunk)
               f_dst.write(chunk)
       os.chmod(dst, 0o600)
       metadata.append(f"{name}: {hasher.hexdigest()} ({os.path.getsize(dst)} bytes)")

   print(f"BACKUP_DIR={backup_dir}")
   print("Snapshot privado completado exitosamente:")
   for item in metadata:
       print(f"  - {item}")
   ```

> **Confidentiality Notice**: Excluding `auth.json` prevents backing up stored credentials. However, `settings.json` is backed up in full and may contain sensitive user preferences. Keep the backup directory strictly private (`0700` directory, `0600` files).

### Step 2: Simulate Adoption with `--dry-run`

```bash
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
INSTALL_DIR="$HOME/.local/share/pi-auto-compaction-managed"

node scripts/deploy.mjs --adopt-agent --dry-run --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
```

### Step 3: Execute Adoption

```bash
node scripts/deploy.mjs --adopt-agent --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
```

### Step 4: Verify and Reload

```bash
node scripts/doctor.mjs --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
```
In Pi:
```text
/reload
```

---

## Method 3: Updating an Existing Managed Installation

When updates are pulled from upstream, upgrade the managed release safely:

1. **Verify working tree**:
   ```bash
   cd "$HOME/proyectos/pi-auto-compaction"
   git status
   ```

2. **Pull fast-forward changes**:
   ```bash
   git pull --ff-only origin main
   ```

3. **Install dependencies and test**:
   ```bash
   npm ci --ignore-scripts
   npm test
   ```

4. **Simulate update**:
   ```bash
   AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
   INSTALL_DIR="${PI_AUTO_COMPACTION_INSTALL_DIR:-$HOME/.local/share/pi-auto-compaction}"

   node scripts/deploy.mjs --update --dry-run --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
   ```

5. **Apply update**:
   ```bash
   node scripts/deploy.mjs --update --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
   ```
   *Note*: If the code hash is identical to the currently active release, the command reports `noop: true` and exits cleanly without modifying files.

6. **Reload and diagnose**:
   ```text
   /reload
   ```
   ```bash
   node scripts/doctor.mjs --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
   ```

---

## Rollback Procedures

Choose the appropriate rollback strategy based on whether you need to revert code or remove the extension:

| Type | Command | Effect | Preserved State |
|---|---|---|---|
| **Source Rollback** | `node scripts/deploy.mjs --rollback-source --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"` | Points loader to previous immutable release under `releases/`. Single-step idempotent operation. | Retains `settings.json` overrides, summarizer preferences, and manifest baseline. |
| **Configuration Uninstall** | `node scripts/rollback.mjs --target-dir "$AGENT_DIR"` | Uninstalls loader and manifest; restores original `settings.json` token baseline. | Keeps release root `$INSTALL_DIR` and historical release folders intact on disk. |

### Adoption Rollback Limitations
- On an installation created via `--adopt-agent`, the initial release has no previous managed release (`previous: null`). Running `--rollback-source` immediately after adoption is a clean no-op (`noop: true`).
- **Reverting to the Old Source**: Requires running setup from the old source directory:
  ```bash
  OLD_SOURCE_DIR="${OLD_SOURCE_DIR:-$HOME/.local/share/pi-auto-compaction}"
  node "$OLD_SOURCE_DIR/scripts/setup.mjs" --source-dir "$OLD_SOURCE_DIR" --target-dir "$AGENT_DIR"
  ```
  *Metadata Desync Notice*: Running setup from the old source reverts the agent's loader, but leaves `$INSTALL_DIR/.pi-auto-compaction-deploy.json` in `state: "ready"`. Subsequent `--update` calls will fail with `Agent manifest source ownership mismatch`. Reconcile manually; never delete markers or journals.

---

## Verification Checklist

Confirm that your deployment was completely successful by checking each signal:

- [ ] **Tests pass**: `npm test` reports 326 tests across 33 suites with 0 failures.
- [ ] **Deploy marker exists**: `$INSTALL_DIR/.pi-auto-compaction-deploy.json` contains `"state": "ready"`.
- [ ] **Release directory created**: `$INSTALL_DIR/releases/<sha256>/.release.json` contains `"version": 1`.
- [ ] **Loader installed**: `$AGENT_DIR/extensions/omniroute-compaction.ts` dynamically imports the active release.
- [ ] **Manifest v2 created**: `$AGENT_DIR/.pi-auto-compaction-manifest.json` contains `"version": "2.0.0"`.
- [ ] **Doctor healthy**: `npm run doctor` exits with `0` and reports `healthy`.
- [ ] **Command available**: Inside Pi, `/compaction` opens the model selector.
- [ ] **Status bar updated**: Pi footer shows `Compaction: <provider>/<modelId>`.

---

## Next Steps

- Review architecture and lifecycle details: [`docs/en/architecture.md`](architecture.md)
- Automate installation using an AI agent: [`docs/en/agent-install.md`](agent-install.md)
- Learn routine maintenance and journal recovery: [`docs/en/maintenance.md`](maintenance.md)
- Troubleshoot errors and warnings: [`docs/en/troubleshooting.md`](troubleshooting.md)
