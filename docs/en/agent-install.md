# Automated Installation Protocol for AI Agents

Automate the inspection, snapshotting, deployment, and verification of **pi-auto-compaction** using autonomous AI coding agents.

This guide provides the operational contract, decision gates, safety invariants, and a complete copy-paste prompt for subagents, orchestrators, and automated harnesses.

---

## Quick Path for Agents

An agent executing an automated deployment must follow this six-stage contract:

1. **Inspect Environment**: Check Node.js version (`>=22.19.0`), resolve `$AGENT_DIR` and `$INSTALL_DIR`, and inspect existing manifests or markers.
2. **Capture Secure Snapshot**: Create a temporary, private backup directory (`0700` dir, `0600` files) holding pre-existing configuration. Never copy `auth.json`.
3. **Select Execution Gate**: Evaluate the Decision Table to choose between Fresh Deploy, Adoption (`--adopt-agent`), or Update (`--update`).
4. **Execute Transaction**: Always run `--dry-run` first. Execute the deployment command only when dry-run succeeds cleanly.
5. **Reload & Verify**: Issue `/reload` to active Pi sessions. Execute `doctor --json` and parse exit codes.
6. **Report Structured Handoff**: Return a concise receipt to the orchestrator with status, release hash, and effective thresholds.

---

## The Agent Contract

When delegated the task of installing or maintaining `pi-auto-compaction`, the agent operates under strict lifecycle guarantees:

| Stage | Responsibility | Failure Action |
|---|---|---|
| **1. Inspection** | Verify path safety, check for forbidden symlinks, and detect if an agent manifest or deployment marker already exists. | Halt immediately if symlinks are detected or paths overlap. |
| **2. Snapshot** | Back up `settings.json`, manifest, and loader into an isolated temporary folder under `$HOME`. Exclude `auth.json`. | Halt if backup directory cannot be created with `0700` permissions. |
| **3. Decision** | Match observed disk state to exactly one deployment flag. Never guess. | Halt if markers indicate `pending` state or active locks exist. |
| **4. Execution** | Run `--dry-run` to compile modules via `vm.SourceTextModule` and verify source hashes before disk mutation. | Fail-closed on child process errors. Do not delete markers or journals. |
| **5. Verification** | Trigger `/reload` in Pi, execute `doctor --json`, and verify exit code `0` (healthy). | Flag warnings (`exit 1`) or errors (`exit 2`) in the final handoff. |
| **6. Reporting** | Produce a deterministic summary with paths, release hash, and exit codes. | Never claim completion when validation fails. |

---

## Agent Decision Table

Before invoking any deployment script, evaluate this decision matrix against observed filesystem state:

| Condition on `$INSTALL_DIR` | Condition on `$AGENT_DIR` | Selected Mode | Action / Command |
|---|---|---|---|
| Does not exist (`!exists(root)`) | No loader, no manifest | **Fresh Install** | `node scripts/deploy.mjs --dry-run`<br>`node scripts/deploy.mjs` |
| Does not exist (`!exists(root)`) | Contains valid loader and manifest v1/v2 | **Agent Adoption** | `node scripts/deploy.mjs --adopt-agent --dry-run --install-dir <new-root>`<br>`node scripts/deploy.mjs --adopt-agent --install-dir <new-root>` |
| Exists with marker (`state: "ready"`) | Loader matches `current.path` | **Update** | `node scripts/deploy.mjs --update --dry-run`<br>`node scripts/deploy.mjs --update` |
| Exists with marker (`state: "ready"`) | Runtime regression observed | **Source Rollback** | `node scripts/deploy.mjs --rollback-source` |
| Exists without valid marker | Any state | **REJECT** | Halt: Unmanaged root. Require human review or distinct `$INSTALL_DIR`. |
| Exists with marker (`state: "pending"`) | Any state | **REJECT** | Halt: Interrupted transaction. Inspect journals; do not delete marker. |
| Any | Lock file or recovery journal exists | **REJECT** | Halt: Active lock or pending recovery. Manual reconciliation required. |

---

## Safety Invariants for Automated Agents

Agents must adhere to these hard safety rules:

1. **Never delete markers or journals**: Never remove `.pi-auto-compaction-deploy.json`, `.deploy.lock`, `recovery-journal.json`, or files under `journals/`. Their presence signals an interrupted state that requires compensation, not deletion.
2. **Never create `$INSTALL_DIR` with `mkdir`**: `deploy.mjs` requires creating its own root during initial deployment. If an empty directory exists without a deploy marker, the script will reject it as an unmanaged root.
3. **Never touch or back up `auth.json`**: Credentials remain under Pi's exclusive ownership. Never copy, inspect, or log the contents of `auth.json`.
4. **Never modify `settings.json` for summarizers**: Summarizer preferences belong exclusively in `.pi-auto-compaction-settings.json`. Never insert summarizer keys into `settings.json`.
5. **Reject all symbolic links**: Every path argument (`--agent-dir`, `--install-dir`, `--source-dir`) is checked for symlinks across all ancestor directories. Reject symlinks immediately.

---

## Complete Copy-Paste Agent Prompt

Provide this complete prompt to an autonomous agent to execute an end-to-end installation or update:

```markdown
You are an autonomous AI coding agent tasked with installing and configuring `pi-auto-compaction` for Pi and gentle-shell.

Follow the canonical agent contract and safety guards strictly.

### Environment Paths
- Repository Source: `$HOME/proyectos/pi-auto-compaction` (or define `$SOURCE_DIR`)
- Pi Agent Directory: `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}`
- Durable Release Directory: `${PI_AUTO_COMPACTION_INSTALL_DIR:-$HOME/.local/share/pi-auto-compaction}`

### Execution Steps

1. **Working Tree and Tests**:
   Navigate to the repository source and ensure dependencies are installed and tests pass:
   ```bash
   cd "$SOURCE_DIR"
   npm ci --ignore-scripts
   npm test
   ```
   Confirm all 326 tests across 33 suites pass. If any test fails, STOP and report the failure.

2. **Inspect Filesystem State**:
   Check if `$AGENT_DIR/extensions/omniroute-compaction.ts` and `$AGENT_DIR/.pi-auto-compaction-manifest.json` exist.
   Check if `$INSTALL_DIR/.pi-auto-compaction-deploy.json` exists.

3. **Secure Pre-Installation Snapshot**:
   If pre-existing agent files exist, capture a private snapshot:
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
   print(f"Snapshot created at: {backup_dir}")
   ```

4. **Select Mode & Dry-Run**:
   - If `$INSTALL_DIR` does NOT exist and agent is clean:
     ```bash
     node scripts/deploy.mjs --dry-run --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
     node scripts/deploy.mjs --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
     ```
   - If `$INSTALL_DIR` does NOT exist and agent already has a valid manifest/loader:
     ```bash
     ADOPT_DIR="$HOME/.local/share/pi-auto-compaction-managed"
     node scripts/deploy.mjs --adopt-agent --dry-run --agent-dir "$AGENT_DIR" --install-dir "$ADOPT_DIR"
     node scripts/deploy.mjs --adopt-agent --agent-dir "$AGENT_DIR" --install-dir "$ADOPT_DIR"
     ```
   - If `$INSTALL_DIR` already exists with marker (`state: "ready"`):
     ```bash
     node scripts/deploy.mjs --update --dry-run --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
     node scripts/deploy.mjs --update --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
     ```

5. **Verify Installation**:
   Execute the doctor diagnostic tool with JSON output:
   ```bash
   node scripts/doctor.mjs --json --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
   ```
   Verify that:
   - Exit code is `0` (or `1` if benign catalog warnings are noted).
   - Marker state is `"ready"`.
   - Loader and manifest hashes match.

6. **Return Structured Report**:
   Return a concise status summary containing:
   - `status`: completed | partial | blocked
   - `method`: fresh | adopt-agent | update
   - `release_hash`: <sha256>
   - `marker_state`: ready
   - `doctor_exit_code`: 0 | 1 | 2
   - `warnings`: list of warnings or none
```

---

## Agent Verification Checklist

Autonomous agents should verify the following conditions before reporting completion:

- [ ] Working tree clean and `npm test` passes (326/326 tests).
- [ ] Pre-execution snapshot captured in `0700` directory if agent was previously managed.
- [ ] `--dry-run` was executed and reported success before live deployment.
- [ ] Deployment marker `$INSTALL_DIR/.pi-auto-compaction-deploy.json` has `"state": "ready"`.
- [ ] Loader `$AGENT_DIR/extensions/omniroute-compaction.ts` exists and imports active release.
- [ ] Manifest v2 `$AGENT_DIR/.pi-auto-compaction-manifest.json` exists with `"version": "2.0.0"`.
- [ ] `node scripts/doctor.mjs --json` exits with code `0`.
- [ ] No temporary files, unhandled exceptions, or dangling journals remain.

---

## Next Steps

- Review the human installation guide: [`docs/en/installation.md`](installation.md)
- Inspect the agent skill definition: [`skills/pi-auto-compaction/SKILL.md`](../../skills/pi-auto-compaction/SKILL.md)
- Access the standalone prompt asset: [`skills/pi-auto-compaction/assets/agent-install-prompt.md`](../../skills/pi-auto-compaction/assets/agent-install-prompt.md)
