# Troubleshooting and Diagnostics Guide

Diagnose, recover, and resolve operational issues, error messages, and edge cases in **pi-auto-compaction**.

---

## Quick Diagnostic Matrix

Find your symptom below to identify the underlying cause and quick recovery action:

| Symptom | Likely Cause | Quick Recovery Action |
|---|---|---|
| Command `/compaction` not recognized in Pi. | Session running before installation or update. | Run `/reload` in active Pi session. |
| `"No chat models available with configured auth"` in `/compaction`. | No chat models authenticated in `auth.json`. | Run `/login` or add credentials in `$HOME/.pi/agent/auth.json`. |
| Compaction fails before hook; no telemetry logged. | Active conversation model credentials missing or expired. | Refresh credentials for conversation model in `auth.json`. |
| Configured summarizer model not found at runtime. | Model removed from catalog or provider credentials revoked. | Re-run `/compaction` or remove settings file to restore defaults. |
| Warning: Corrupt or invalid summarizer settings file. | JSON syntax error or invalid version in settings file. | Fix syntax or delete `.pi-auto-compaction-settings.json`. |
| Warning: Small context window (`< 32,000` tokens). | Summarizer model declared context window is under 32k. | Select model with larger context (e.g. 128k+) for primary role. |
| Both summarizers fail; fallback to native Pi compaction. | Shared network outage or upstream provider failure. | Inspect `compaction.jsonl`; verify connectivity to provider endpoints. |
| Deploy halted: Pending deployment journal or lock active. | Previous transaction interrupted (`SIGKILL`, terminal closed). | Inspect journals in `journals/`; run `--dry-run`; reconcile. |
| Deploy/Rollback rejected due to configuration drift. | `settings.json` token overrides modified outside policies. | Run `doctor`, match `settings.json` to manifest `policies`. |
| `--rollback-source` results in clean no-op after adoption. | Initial adopted release has `previous: null`. | Run setup from preserved old source directory if reverting adoption. |
| Gentle-shell fails to load SDK from extension loader. | Pi package located outside standard node lookup paths. | Set `PI_CODING_AGENT_PATH` pointing to Pi SDK package. |
| Local model (e.g., Ollama) hits 60-second attempt timeout. | Heavy model on CPU or large history exceeding time budget. | Use quantized/smaller model, enable GPU layers, or use cloud primary. |

---

## 1. Command `/compaction` Unrecognized or Missing

### Symptom
Typing `/compaction` in Pi returns `Unknown command: /compaction` or the command does not appear in autocomplete.

### Root Cause
Pi registers extension commands during session initialization or when `/reload` is executed. Installing or updating the extension while Pi is running does not automatically register new commands in active memory.

### Recovery
1. In your active Pi terminal session, execute:
   ```text
   /reload
   ```
2. Type `/compaction` again. Autocomplete should now display `"Configure auto-compaction primary and fallback models"`.

---

## 2. No Chat Models Available with Configured Auth

### Symptom
Running `/compaction` displays the notification:
`"No chat models available with configured credentials."` and the picker closes immediately.

### Root Cause
The model resolver (`listChatModels`) queries Pi's `ctx.modelRegistry` for models of type `"chat"` where `hasConfiguredAuth(model)` is true. If no providers are authenticated in `auth.json`, the list is empty.

### Recovery
1. Verify provider credentials in `$HOME/.pi/agent/auth.json`.
2. Authenticate your preferred providers by running `/login` within Pi.
3. Ensure at least one provider (OmniRoute, OpenAI, Anthropic, Gemini, or a local provider like Ollama) has valid credentials.
4. Run `/compaction` again once credentials are confirmed.

---

## 3. Configured Summarizer Model Not Found at Runtime

### Symptom
Running `doctor` warns that a configured summarizer model does not exist in any catalog (`models.json`, `models-store.json`, `commandcode-models.json`), or runtime compaction attempts immediately skip to fallback.

### Root Cause
The model was previously saved to `.pi-auto-compaction-settings.json`, but the provider was later removed, credentials expired, or the model ID changed.

### System Behavior
The extension handles missing models gracefully:
- If the primary model fails or cannot be resolved, it immediately attempts the fallback model.
- If both fail, it returns `undefined` to allow Pi's native compaction to handle context reduction.

### Recovery
1. Run `/compaction` in Pi and select an available, authenticated model.
2. Or reset to default models by removing the settings file:
   ```bash
   rm "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/.pi-auto-compaction-settings.json"
   ```

---

## 4. Corrupt or Invalid Settings File

### Symptom
At startup or during `doctor`, a warning appears:
`"Failed to load summarizer settings: Invalid JSON in summarizer settings"` or `"Invalid settings version: expected 1"`.

### Root Cause
Manual edits to `.pi-auto-compaction-settings.json` introduced invalid JSON syntax, unknown keys, non-string model identifiers, or an unsupported version number.

### Safety Behavior
The extension **never overwrites or clobbers a corrupt settings file automatically**. Instead:
- It issues a diagnostic warning in `doctor` and Pi notifications.
- It loads safe in-memory defaults (`omniroute/antigravity/gemini-3.8-flash-tiered`).

### Recovery
1. Correct the JSON syntax in `.pi-auto-compaction-settings.json`:
   ```json
   {
     "version": 1,
     "primary": {
       "provider": "antigravity",
       "modelId": "gemini-3.8-flash-tiered"
     },
     "fallback": {
       "provider": "antigravity",
       "modelId": "gemini-3.6-flash-high"
     }
   }
   ```
2. Or open `/compaction` in Pi and complete a selection; confirming writes a clean, atomic file.
3. Or remove the file to restore defaults.

---

## 5. Warning: Small Context Window (`< 32,000` Tokens)

### Symptom
During `/compaction` or in `doctor`, you see:
`"Warning: <model> has a small context window (< 32,000 tokens); long sessions may fall back."`

### Root Cause
The selected model declares a `contextWindow` under 32k tokens (common in compact local models like 8k or 16k variants).

### Operational Impact
Compaction submits the conversation history in a single prompt. If session tokens exceed the summarizer's window, the call fails capacity validation and cascades to the fallback model or native compaction.

### Recommendation
- Select a primary model with a generous context window (e.g., 128k, 400k, or 1M tokens) for long programming sessions.
- If using a small local model as primary, ensure your fallback model has a large window to act as a safety net.

---

## 6. Dual Failure of Both Summarizers (Native Fallback)

### Symptom
Compaction takes 60–120 seconds, and `compaction.jsonl` records failures for both primary and fallback models, triggering native Pi compaction.

### Root Cause
Both summarizers experienced timeout (60s per attempt), rate limits, or network disruption. If both share the same gateway or provider infrastructure, a shared outage will cause both to fail.

### System Behavior
The extension returns `undefined` to Pi, initiating native summarization using the conversation model. Note that if network access is completely down, native compaction may fail as well.

### Recovery
1. Inspect the last entries in local telemetry:
   ```bash
   tail -n 20 "$HOME/.local/state/pi-auto-compaction/compaction.jsonl"
   ```
2. Check `errorCategory` in the log: `timeout`, `rate_limit`, `auth`, or `capacity`.
3. If timeouts dominate, configure faster models or increase local GPU compute for local models.

---

## 7. Compaction Not Triggering Due to Pre-Hook Authentication

### Symptom
Token usage exceeds the trigger threshold (e.g., 334k for OpenAI, 860k for DeepSeek), but compaction does not start, and no new telemetry entries appear.

### Root Cause
Pi validates credentials for the **active conversation model** in `auth.json` *before* firing the `session_before_compact` hook. If credentials for the conversation model are expired, Pi halts before delegating to the extension.

### Recovery
1. Check credentials for your active conversation model in `$HOME/.pi/agent/auth.json`.
2. Confirm you can execute a normal prompt in Pi with that model.
3. Once conversation auth succeeds, Pi will trigger the hook normally.
4. Run `npm run doctor` to confirm effective trigger thresholds.

---

## 8. Interrupted Deploy, Pending Journal, or Active Lock

### Symptom
`deploy.mjs` fails with:
`"Pending deployment journal: manual reconciliation required; do not delete marker/journals"` or `"Deployment lock active"`.

### Root Cause
A previous deploy or rollback process was killed mid-execution (`SIGKILL`, power failure, closed terminal), leaving `.pi-auto-compaction-deploy.json` in `state: "pending"`.

### Recovery
1. **Do not delete marker or journals**: Deletion prevents deterministic recovery.
2. Inspect journals:
   ```bash
   cat "$INSTALL_DIR/journals/"*.json
   ```
3. Run a dry-run to check system state:
   ```bash
   node scripts/deploy.mjs --update --dry-run --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
   ```
4. Check if `$AGENT_DIR/extensions/omniroute-compaction.ts` matches the target release.
5. If consistent, restore `"state": "ready"` in `$INSTALL_DIR/.pi-auto-compaction-deploy.json`.

---

## 9. Configuration or Manifest Drift Rejection

### Symptom
`deploy.mjs`, `setup.mjs`, or `rollback.mjs` halts with a drift error.

### Root Cause
- Managed model token overrides in `settings.json` were modified externally.
- Loader `omniroute-compaction.ts` was edited (hash mismatch).
- Manifest was deleted while loader remained active.

### Recovery
1. Run `doctor` to locate the drift:
   ```bash
   node scripts/doctor.mjs --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"
   ```
2. Open `$AGENT_DIR/.pi-auto-compaction-manifest.json` and check `policies`.
3. Restore the matching `reserveTokens` and `keepRecentTokens` values in `$AGENT_DIR/settings.json`.
4. Run `deploy.mjs --update --dry-run` to verify that drift checks pass.

---

## 10. Adoption and Rollback Limits

### Symptom
- Running `deploy.mjs --rollback-source` after `--adopt-agent` reports `noop: true` without changing releases.
- Re-running `--update` after manually running old source setup fails with `Agent manifest source ownership mismatch`.

### Root Cause
1. In an adopted installation, the initial release has `previous: null`. There is no prior managed release in `$INSTALL_DIR/releases/` to roll back to.
2. Running setup from the old source reverts the agent, but leaves the wrapper marker pointing to the managed release, causing a metadata desync.

### Recovery
- To revert an adopted agent to its pre-adoption source, execute setup from the old source:
  ```bash
  OLD_SOURCE_DIR="${OLD_SOURCE_DIR:-$HOME/.local/share/pi-auto-compaction}"
  node "$OLD_SOURCE_DIR/scripts/setup.mjs" --source-dir "$OLD_SOURCE_DIR" --target-dir "$AGENT_DIR"
  ```
- If metadata desync occurs, manually reconcile manifest `packageSourceDir` with deploy marker `current.path`.

---

## 11. Gentle-Shell SDK Resolution Failure

### Symptom
Pi or gentle-shell logs:
`"[pi-auto-compaction] Failed to load durable extension: Cannot find module '@earendil-works/pi-coding-agent'"`

### Root Cause
In non-standard or bundled gentle-shell setups, the Pi SDK may be stored in a non-standard path that Node cannot locate from the extension loader.

### Recovery
Export `PI_CODING_AGENT_PATH` pointing to the exact directory where Pi or its SDK is installed:
```bash
export PI_CODING_AGENT_PATH="/home/user/.gentle-shell/versions/current/node_modules/@earendil-works/pi-coding-agent"
```
Restart gentle-shell or reload your session.

---

## 12. Local Model Timeout or Slow Inference

### Symptom
When using local models (such as Ollama or local llama.cpp), compaction consistently hits the 60-second attempt timeout and falls back to secondary or native compaction.

### Root Cause
The extension applies a strict **60-second per-attempt timeout** to prevent terminal freezes. If a large prompt is evaluated on CPU or an unoptimized GPU configuration, inference time can easily exceed 60 seconds.

### Recovery
1. **Quantization**: Use 4-bit or 8-bit quantized variants (e.g., `qwen2.5-coder:7b` instead of `32b`).
2. **GPU Offloading**: Ensure full GPU layer offloading is active in Ollama (`num_gpu` parameter).
3. **Invert Roles**: Use a fast remote model (e.g., `gemini-3.8-flash-tiered` or `gpt-4o-mini`) as primary, keeping the local model as secondary, or vice versa.

---

## Post-Recovery Health Checklist

After completing any troubleshooting recovery, confirm:

- [ ] `npm run doctor` exits with `0` (`healthy`).
- [ ] `$INSTALL_DIR/.pi-auto-compaction-deploy.json` has `"state": "ready"`.
- [ ] No unhandled `.deploy.lock` or recovery journals remain in state directories.
- [ ] `/reload` in Pi displays `Compaction: <provider>/<modelId>` in the footer.
- [ ] Test compaction succeeds without triggering dual-failure cascades.

---

## Next Steps

- Review routine maintenance: [`docs/en/maintenance.md`](maintenance.md)
- Explore system architecture: [`docs/en/architecture.md`](architecture.md)
- Re-read installation workflows: [`docs/en/installation.md`](installation.md)
