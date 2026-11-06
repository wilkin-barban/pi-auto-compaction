# Maintenance and Upgrades Guide

Maintain, update, roll back, and recover **pi-auto-compaction** deployments across development workstations and managed agent environments.

---

## Quick Path: Routine Update Sequence

To update an active installation when upstream changes are released:

1. **Navigate to source and verify clean tree**:
   ```bash
   cd "$HOME/proyectos/pi-auto-compaction"
   git status
   ```

2. **Pull updates and test**:
   ```bash
   git pull --ff-only origin main
   npm ci --ignore-scripts
   npm test
   ```
   *Expected signal*: **326 passing tests across 33 suites**.

3. **Simulate update (`--dry-run`)**:
   ```bash
   AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
   INSTALL_DIR="${PI_AUTO_COMPACTION_INSTALL_DIR:-$HOME/.local/share/pi-auto-compaction}"

   node scripts/deploy.mjs --update --dry-run --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
   ```

4. **Apply update**:
   ```bash
   node scripts/deploy.mjs --update --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
   ```

5. **Reload Pi and verify**:
   Inside active Pi session:
   ```text
   /reload
   ```
   In terminal:
   ```bash
   node scripts/doctor.mjs --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
   ```
   *Expected signal*: Exit code `0`, `healthy`.

---

## 1. Source Rollback vs. Configuration Uninstall

Understand the differences between rolling back runtime code and completely removing the extension:

| Aspect | Source Rollback (`--rollback-source`) | Configuration Uninstall (`rollback.mjs`) |
|---|---|---|
| **Command** | `node scripts/deploy.mjs --rollback-source --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"` | `node scripts/rollback.mjs --target-dir "$AGENT_DIR"` |
| **Purpose** | Revert active extension code to the previous release after encountering a runtime defect. | Uninstall the extension from Pi and restore original pre-installation settings. |
| **Loader Impact** | Repoints loader to previous release: `releases/<sha256-previous>/index.mjs`. | Deletes loader file: `$AGENT_DIR/extensions/omniroute-compaction.ts`. |
| **Manifest Impact** | Updates `loaderHash` and source directory in manifest. Retains `originalOverrides`. | Deletes manifest file: `$AGENT_DIR/.pi-auto-compaction-manifest.json`. |
| **Settings Impact** | Retains all token overrides and summarizer settings intact. | Restores original token values in `$AGENT_DIR/settings.json` from `originalOverrides`. |
| **Releases Preserved** | Yes. All release folders remain in `$INSTALL_DIR/releases/`. | Yes. Release root and release folders remain intact on disk. |
| **Idempotence** | Single-step unit operation. Running twice results in a clean no-op (`noop: true`). | Fully idempotent. Running without a manifest is a safe no-op. |

### Source Rollback Details (`--rollback-source`)
- Reverts strictly to the version recorded in `previous` within `$INSTALL_DIR/.pi-auto-compaction-deploy.json`.
- After execution, `current` is set to the prior release and `previous` becomes `null`.
- **Adoption Limitation**: On an installation created via `--adopt-agent`, the initial release has `previous: null`. Executing `--rollback-source` immediately is a clean no-op (`noop: true`). To revert an adopted agent to its pre-adoption state, execute setup from the preserved old source directory:
  ```bash
  OLD_SOURCE_DIR="${OLD_SOURCE_DIR:-$HOME/.local/share/pi-auto-compaction}"
  node "$OLD_SOURCE_DIR/scripts/setup.mjs" --source-dir "$OLD_SOURCE_DIR" --target-dir "$AGENT_DIR"
  ```
  *Metadata Desync Notice*: Running setup from the old source reverts the agent's loader, but leaves `$INSTALL_DIR/.pi-auto-compaction-deploy.json` pointing to the managed release. Subsequent `--update` commands will fail with `Agent manifest source ownership mismatch`. Reconcile manually; do not delete markers or journals.

---

## 2. Recovery Journals and Pending State Recovery

If a deployment or rollback transaction is interrupted (power loss, terminal closed, `SIGKILL`), transactional guardrails lock the installation to prevent corruption.

### Symptoms of an Interrupted Transaction
- `deploy.mjs` fails with: `Pending deployment journal: manual reconciliation required; do not delete marker/journals`.
- `doctor.mjs` fails with exit code `2` reporting deploy marker in `pending` state.
- Journal files exist under `$INSTALL_DIR/journals/<lockToken>.json` or `$AGENT_DIR/.pi-auto-compaction-state/recovery-journal.json`.

### Safe Recovery Procedure

1. **Do not delete files blindly**: Never delete `.pi-auto-compaction-deploy.json`, `.deploy.lock`, or journal files. Deleting them destroys the recovery baseline.
2. **Inspect journal content**:
   ```bash
   cat "$INSTALL_DIR/journals/"*.json
   cat "$AGENT_DIR/.pi-auto-compaction-state/recovery-journal.json"
   ```
3. **Execute a non-destructive dry-run**:
   ```bash
   node scripts/deploy.mjs --update --dry-run --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
   ```
4. **Inspect disk state**: Verify whether `$AGENT_DIR/extensions/omniroute-compaction.ts` and `$AGENT_DIR/settings.json` reflect the intended release or the previous state.
5. **Reconcile marker state**: Once the files match the expected release, update `$INSTALL_DIR/.pi-auto-compaction-deploy.json` back to `"state": "ready"`.

---

## 3. Configuration Drift Detection and Remediation

Drift occurs when external edits alter managed files while the extension is active:
- `settings.json`: Token overrides for the 8 managed models differ from manifest `policies`.
- `omniroute-compaction.ts`: File modified manually (hash does not match `loaderHash`).
- `.pi-auto-compaction-manifest.json`: Manifest removed or edited.

### Identifying Drift with Doctor

```bash
node scripts/doctor.mjs --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
```

If drift exists, `doctor` prints warning messages indicating the mismatched models or exit code `2` for missing files.

### Remediation Steps

1. Review the required policies in `$AGENT_DIR/.pi-auto-compaction-manifest.json` under `policies`.
2. Open `$AGENT_DIR/settings.json` and restore the exact `reserveTokens` and `keepRecentTokens` values for the affected managed models.
3. If the loader was modified, copy the official loader template or re-run `deploy.mjs --update` once settings match.
4. Verify resolution with `npm run doctor`.

---

## 4. Release Retention and Cleanup Policies

To ensure stability across long-running background sessions:

- **Immutable Retention**: Every deployment writes to a new `$INSTALL_DIR/releases/<sha256>` directory.
- **Why Releases Are Kept**: Open Pi terminal processes hold active memory references and file descriptors to the release directory they loaded at startup. Automatically deleting old releases could crash running sessions.
- **Manual Cleanup**: You can prune older release directories that are not listed in `$INSTALL_DIR/.pi-auto-compaction-deploy.json` as `current` or `previous` **only after** all active Pi sessions have executed `/reload` or restarted.

---

## 5. Summarizer Settings Management

The preferences configured via `/compaction` reside in `$AGENT_DIR/.pi-auto-compaction-settings.json`.

### Backup Settings

```bash
SETTINGS_FILE="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/.pi-auto-compaction-settings.json"
cp "$SETTINGS_FILE" "$HOME/.pi-auto-compaction-settings.backup.json"
```

### Reset to Default Models

To discard customized summarizer choices and restore the default models (`omniroute/antigravity/gemini-3.8-flash-tiered` and `gemini-3.6-flash-high`):

```bash
rm "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/.pi-auto-compaction-settings.json"
```
After removing the file, run `/reload` in active Pi sessions. Pi will cleanly load the default summarizer models without warnings.

### Reconfiguring via Environment Variables

For automated environments, bypass the interactive selector by exporting:

```bash
export PI_AUTO_COMPACTION_PRIMARY_PROVIDER="openai"
export PI_AUTO_COMPACTION_PRIMARY_MODEL="gpt-4o"
export PI_AUTO_COMPACTION_FALLBACK_PROVIDER="openai"
export PI_AUTO_COMPACTION_FALLBACK_MODEL="gpt-4o-mini"
```

---

## Maintenance Verification Checklist

Before completing any maintenance operation, verify:

- [ ] Working tree is clean on `origin/main`.
- [ ] `npm test` passes completely (326 tests across 33 suites).
- [ ] `deploy.mjs --dry-run` was executed prior to applying changes.
- [ ] Active Pi sessions executed `/reload`.
- [ ] `npm run doctor` returns exit code `0` (`healthy`).
- [ ] Deploy marker `$INSTALL_DIR/.pi-auto-compaction-deploy.json` is in `state: "ready"`.
- [ ] No `.deploy.lock` or pending recovery journals exist.

---

## Next Steps

- Consult troubleshooting steps: [`docs/en/troubleshooting.md`](troubleshooting.md)
- Review system architecture: [`docs/en/architecture.md`](architecture.md)
- Automate operations with AI agents: [`docs/en/agent-install.md`](agent-install.md)
