---
name: pi-auto-compaction
description: "Trigger: install, update, adopt, verify, diagnose, compaction summarizer, Pi, gentle-shell, herdr. Manage deployment, configuration, verification, and diagnostics for pi-auto-compaction."
license: UNLICENSED
metadata:
  author: wilkinbarban
  version: "1.2.1"
---

## Activation Contract

Activate this skill when:
- Installing, adopting, updating, configuring, verifying, or diagnosing `pi-auto-compaction`.
- Running environment health checks or diagnostics across Pi, gentle-shell, or herdr.
- Selecting, inspecting, or tuning summarizer models or provider skip lists.
- Troubleshooting compaction failures, loader mismatches, or deployment drift.

Do not activate this skill for:
- Internal development or test authoring for the `pi-auto-compaction` repository.

## Hard Rules

- Run only approved repository commands: `npm ci --ignore-scripts`, `npm test`, `node scripts/deploy.mjs` (`--dry-run`, `--update`, `--adopt-agent`, `--rollback-source`, `--agent-dir`, `--install-dir`), `node scripts/rollback.mjs`, `node scripts/doctor.mjs`, `/reload`, and `/compaction`.
- Never execute arbitrary package scripts, `npm publish`, Git staging/commit/push/branch commands, or destructive deletes (`rm`, `git reset`, `git checkout`).
- Never delete or tamper with `.pi-auto-compaction-deploy.json`, recovery journals, or locks. Fail closed on pending journals.
- Never inspect, log, or expose secrets, `auth.json`, tokens, or personal file paths. Use `$HOME`, `$AGENT_DIR`, and `$INSTALL_DIR` placeholders.
- Preserve existing configurations in `settings.json` and `.pi-auto-compaction-settings.json`. Never overwrite unmanaged loaders without explicit `--adopt-agent`.
- Run `npm test` and `node scripts/deploy.mjs --dry-run` before applying changes. Stop and ask confirmation before irreversible actions.

## Decision Gates

| Current State / Goal | Action | Command |
|---|---|---|
| Fresh environment (no loader or manifest) | Clean deployment | `node scripts/deploy.mjs` |
| Unmanaged loader exists, adoption approved | Adopt configuration | `node scripts/deploy.mjs --adopt-agent` |
| Managed release deployed, updating source | Update release | `node scripts/deploy.mjs --update` |
| Preflight simulation | Dry-run verification | `node scripts/deploy.mjs --dry-run` |
| Health, policy, or config check | Run diagnostic | `node scripts/doctor.mjs` |
| Interactive summarizer model selection | Open TUI picker | `/compaction` |
| Activate newly deployed loader in Pi | Reload extensions | `/reload` |
| Revert release to previous hash | Roll back release | `node scripts/deploy.mjs --rollback-source` |
| Uninstall extension and restore baseline | Remove extension | `node scripts/rollback.mjs` |

## Execution Steps

1. Inspect environment: check Node version (`>=22.19.0`), `$AGENT_DIR`, `$INSTALL_DIR`, loader (`$AGENT_DIR/extensions/omniroute-compaction.ts`), and manifest.
2. Verify source: run `npm test` and confirm all 326 tests pass.
3. Preflight deploy: run `node scripts/deploy.mjs --dry-run` with target directory flags.
4. Select deployment mode from Decision Gates: clean deploy, `--adopt-agent`, or `--update`.
5. Execute deploy: run `node scripts/deploy.mjs` with selected flags.
6. Reload harness: execute `/reload` to load the extension into the active Pi session.
7. Run diagnostics: execute `node scripts/doctor.mjs` (code 0: healthy, 1: warnings, 2: fatal drift/pending journal).
8. Verify runtime: run `/compaction` to review or choose primary and fallback summarizer models.
9. Deliver report following the Output Contract.

## Output Contract

Return structured summary with:
- `action`: Deployment, update, or diagnostic action performed.
- `commands`: Exact commands executed with exit codes.
- `doctor`: Doctor diagnostic status and warnings.
- `loader`: Verification status and path of loader extension.
- `models`: Effective primary and fallback summarizer models.
- `guards_triggered`: Any safety blocks, pending journals, or required user confirmations.

## References

- `docs/en/agent-install.md` — Agent deployment contract, safety guards, and decision rules.
- `docs/en/installation.md` — Prerequisites, clean install, flags, and verification signals.
- `assets/agent-install-prompt.md` — Complete agent install prompt (English).
- `assets/agent-install-prompt.es.md` — Complete agent install prompt (Spanish).
- `docs/en/troubleshooting.md` — Diagnostics, doctor codes, and failure recovery.
