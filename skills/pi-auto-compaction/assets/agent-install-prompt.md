# Agent Installation and Verification Prompt (English)

Copy and paste the prompt below to direct an automated coding agent (Pi, gentle-shell, Claude, etc.) to safely install, adopt, update, or verify `pi-auto-compaction`:

```markdown
You are tasked with safely deploying, configuring, and verifying `pi-auto-compaction` for Pi, gentle-shell, and herdr. Execute the following deterministic workflow step by step.

## Safety Guards (Strictly Non-Negotiable)

- NO SECRETS: Never read, display, log, or leak API keys, credentials, tokens, `auth.json`, or private environment variables.
- NO DESTRUCTIVE DELETES: Never execute `rm`, `git reset`, `git checkout`, `git clean`, or unmanaged filesystem deletions.
- NO MARKER OR JOURNAL DELETION: Never delete or alter `.pi-auto-compaction-deploy.json` or recovery journals under `$INSTALL_DIR/.pi-auto-compaction-state/`. If a pending journal exists, stop immediately and report it.
- NO GIT MUTATIONS: Do not execute `git add`, `git commit`, `git push`, force-push, or branch modification commands.
- NO NPM PUBLISHING: Never run `npm publish` or upload code to public package registries. This project is UNLICENSED and source-available for local deployment only.
- PRESERVE USER CONFIGURATION: Never overwrite existing user compaction settings in `$AGENT_DIR/settings.json` or `$AGENT_DIR/.pi-auto-compaction-settings.json`.
- ASK BEFORE IRREVERSIBLE ACTIONS: If an ambiguous state, foreign file collision, or conflict is detected, stop immediately and request user instructions.
- EXCLUSIVE ALLOWED COMMANDS: Use only the documented commands:
  - `npm ci --ignore-scripts`
  - `npm test`
  - `node scripts/deploy.mjs` (flags: `--dry-run`, `--update`, `--adopt-agent`, `--rollback-source`, `--agent-dir`, `--install-dir`)
  - `node scripts/rollback.mjs`
  - `node scripts/doctor.mjs`
  - `/reload`
  - `/compaction`

## Execution Steps

### 1. Read Documentation
Review the deployment documentation before initiating any filesystem modifications:
- `docs/en/installation.md`
- `docs/en/agent-install.md`
- `docs/en/troubleshooting.md`

### 2. Inspect Environment and Working Directories
Inspect host environment and configure standard directory placeholders:
- Verify Node.js version: `node -v` (must be `>=22.19.0`).
- Resolve target directories using environment variables or defaults:
  - `$AGENT_DIR`: Set to `$PI_CODING_AGENT_DIR` if defined, else `$HOME/.pi/agent`.
  - `$INSTALL_DIR`: Set to `$AGENT_DIR` (or a designated installation root if customized).
- Inspect existing files and runtime state:
  - Check for loader at `$AGENT_DIR/extensions/omniroute-compaction.ts`.
  - Check for manifest at `$AGENT_DIR/.pi-auto-compaction-manifest.json`.
  - Check for deployment marker at `$INSTALL_DIR/.pi-auto-compaction-deploy.json`.
  - Check for recovery journals under `$INSTALL_DIR/.pi-auto-compaction-state/`. If any journal has state `pending`, stop execution and report the error.

### 3. Run Tests
Verify repository integrity before running deployment scripts:
```bash
npm test
```
Confirm that all 326 tests pass across 33 suites.

### 4. Run Deployment Dry-Run
Simulate the deployment to verify expected operations without writing changes:
```bash
node scripts/deploy.mjs --dry-run --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
```

### 5. Select Deployment Mode and Deploy
Choose the appropriate mode based on the inspection in Step 2:
- **Fresh Deployment**: If no prior loader or manifest exists:
  ```bash
  node scripts/deploy.mjs --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
  ```
- **Adoption Mode (`--adopt-agent`)**: If an unmanaged or foreign loader already exists at `$AGENT_DIR/extensions/omniroute-compaction.ts` without an active deployment manifest:
  ```bash
  node scripts/deploy.mjs --adopt-agent --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
  ```
- **Update Mode (`--update`)**: If a managed deployment is already active (`.pi-auto-compaction-deploy.json` exists in `ready` state) and source code has changed:
  ```bash
  node scripts/deploy.mjs --update --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
  ```

Note: The deployment script automatically manages atomic backups and journals inside `$INSTALL_DIR/.pi-auto-compaction-state/` before touching any target file.

### 6. Reload Extension Runtime
Register the newly deployed extension in the current Pi session:
```text
/reload
```

### 7. Run Diagnostics
Run the read-only doctor command to verify deployment health:
```bash
node scripts/doctor.mjs --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
```
Verify exit code:
- `0`: Environment is healthy and all checks pass.
- `1`: Informational warnings present (e.g., small context window or unmanaged override).
- `2`: Fatal error (drift, hash mismatch, or pending recovery journal). Halt and report.

### 8. Verify and Configure Summarizer Models
Verify or adjust the active primary and fallback summarizer models:
```text
/compaction
```
Inspect current summarizer configuration and confirm models.

### 9. Deliver Verification Report
Return a structured completion report detailing:
- **Action Taken**: Fresh deploy, adoption, update, or diagnostic.
- **Commands and Results**: Complete list of executed commands with exit codes.
- **Doctor Diagnostic**: Health status, exit code, and any reported warnings.
- **Loader Status**: Path and verification state of `$AGENT_DIR/extensions/omniroute-compaction.ts`.
- **Summarizer Settings**: Active primary and fallback models.
- **Safety Status**: Confirmation that no secrets were accessed, no user settings clobbered, and no journals orphaned.
```
