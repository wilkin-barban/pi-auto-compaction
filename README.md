[English](README.md) | [Español](README.es.md)

# pi-auto-compaction

Decoupled, user-controlled automatic context compaction for Pi, gentle-shell, and herdr.

Offloads expensive context summarization from your active conversation model (OpenAI, DeepSeek, Gemini, Claude, etc.) to dedicated, configurable summarizers (OmniRoute by default or any model available in your Pi harness), featuring multi-tier fallback, private local telemetry, and zero monkey-patching.

> **Source-Available Notice**: This repository is public as *source-available* under `UNLICENSED` (all rights reserved, `private: true` in `package.json`). It is not published on npm and unauthorized redistribution or package publishing is prohibited.

---

## What It Is and Who It Is For

**pi-auto-compaction** is an extension for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent), [gentle-shell](https://github.com/gentleman-programming/gentle-shell), and [herdr](https://github.com/gentleman-programming/herdr).

It is designed for developers and AI agents running long, complex coding sessions who need:
- **Quota preservation**: Prevent expensive conversation models from wasting tokens on large conversation summaries.
- **Reliability**: Protect sessions against rate limits, token saturation, and provider outages during compaction.
- **Safety and auditability**: Keep configuration isolated, verify deployments through deterministic transactions, and avoid patching third-party packages.

---

## The Problem It Solves

| Challenge in Standard Pi | Solution in pi-auto-compaction |
|---|---|
| **Coupled Summarization**: Pi asks the conversation model to summarize its own history, consuming expensive quota and triggering rate limits. | **Decoupled Compaction**: Summarization runs on independent, lightweight models without touching your active chat model. |
| **Fixed Summarizer**: You cannot easily configure or switch which model summarizes conversation history. | **Configurable Summarizer**: Choose primary and fallback models interactively via `/compaction`, environment variables, or a dedicated settings file. |
| **Single Point of Failure**: If the summarization request fails, context exhaustion breaks the workflow. | **Multi-Tier Fallback**: Tries the primary model (60s limit), falls back to the secondary model within a 120s budget, and cascades to native Pi compaction if both fail. |
| **Opaque Thresholds**: In standard configurations, incorrect token overrides can trigger premature compactions (e.g., compaction triggering at only 14% of capacity). | **Model-Aware Policies & Doctor**: Pre-tuned policies for 8 conversation models and a read-only `doctor` diagnostic tool reporting exact effective thresholds and origins. |
| **Privacy Concerns**: Telemetry might log full prompts, transcripts, or secrets to disk. | **Allowlisted Local Telemetry**: Logs strictly quantitative metadata (0600 mode) without message transcripts, secrets, or `tokensAfter`. |

---

## Quick Path

Follow these steps for a complete manual installation:

1. **Clone the repository**:
   ```bash
   git clone https://github.com/wilkin-barban/pi-auto-compaction.git "$HOME/proyectos/pi-auto-compaction"
   cd "$HOME/proyectos/pi-auto-compaction"
   ```

   > Alternatively, download the source archive from the [latest GitHub release](https://github.com/wilkin-barban/pi-auto-compaction/releases/latest).

2. **Install dependencies and verify the test suite**:
   Requires Node.js `>=22.19.0`. Expect exactly **326 passing tests across 33 suites**.
   ```bash
   npm ci --ignore-scripts
   npm test
   ```

3. **Simulate deployment (`--dry-run`)**:
   Validates syntax, file ownership, allowlists, and permissions in read-only mode without writing to disk:
   ```bash
   npm run deploy -- --dry-run
   ```

4. **Deploy the durable release**:
   Deploys an immutable release to `$HOME/.local/share/pi-auto-compaction/releases/<sha256>` and configures the loader in `$HOME/.pi/agent/extensions/omniroute-compaction.ts`:
   ```bash
   npm run deploy
   ```

5. **Reload your Pi session**:
   Inside an active Pi terminal session, execute:
   ```text
   /reload
   ```

6. **Configure summarizer models (Optional)**:
   Launch the interactive picker to select primary and fallback summarizers:
   ```text
   /compaction
   ```

7. **Run health diagnostics**:
   Verify effective thresholds, manifest integrity, and summarizer status:
   ```bash
   npm run doctor
   ```

---

## For AI Agents

Automated coding agents (subagents in Pi, gentle-shell orchestrators, or external harnesses) can install, adopt, or update this package without human intervention by following our strict agent contract.

- **Agent Installation Guide**: [`docs/en/agent-install.md`](docs/en/agent-install.md) — Complete protocol covering environment inspection, pre-installation snapshots, execution gates, and error compensation.
- **Agent Skill**: [`skills/pi-auto-compaction/SKILL.md`](skills/pi-auto-compaction/SKILL.md) — LLM-oriented skill definition with triggers, activation rules, and output contracts.
- **Copyable Agent Prompt**: [`skills/pi-auto-compaction/assets/agent-install-prompt.md`](skills/pi-auto-compaction/assets/agent-install-prompt.md) — Ready-to-paste instructions for delegating setup to an autonomous agent.

### Agent Workflow Overview

```text
[Inspect Paths & State] ──► [Take Secure Snapshot (0700/0600)] ──► [Select Method]
                                                                        │
                 ┌──────────────────────────────────────────────────────┴─────────────────────────────────┐
                 ▼                                                      ▼                                 ▼
         [Fresh Install]                                        [Adoption Mode]                    [Update Mode]
       deploy.mjs --dry-run                                  deploy.mjs --adopt-agent           deploy.mjs --update
         deploy.mjs                                           (new non-existent root)
                 │                                                      │                                 │
                 └──────────────────────────────────────────────────────┼─────────────────────────────────┘
                                                                        ▼
                                                        [/reload & doctor Diagnostics]
                                                                        ▼
                                                         [Structured Status Report]
```

---

## Deployment & Lifecycle Methods

| Method | Command | Target Scenario | Changes Made | Preserved Data |
|---|---|---|---|---|
| **Fresh Install** | `node scripts/deploy.mjs` (or `npm run deploy`) | Clean agent directory and new, non-existent install root. | Creates immutable release under `$INSTALL_DIR/releases/<sha256>`, writes deploy marker, installs loader and manifest v2 in agent. | Preserves existing unmanaged user settings in `settings.json`. |
| **Agent Adoption** | `node scripts/deploy.mjs --adopt-agent --agent-dir "$AGENT_DIR" --install-dir "$INSTALL_DIR"` | Migrating a previously managed agent to a new managed release root. | Validates existing loader/manifest, copies source to new release root, points loader to new release, updates marker to `ready`. | Keeps old package source intact on disk; preserves original token baseline in manifest. |
| **Update** | `node scripts/deploy.mjs --update` (or `npm run deploy -- --update`) | Upgrading an existing managed install to newer source code. | Creates new release directory, points loader to new hash, updates deploy marker (`previous` becomes prior release). | Preserves token baselines, custom user settings, and summarizer preferences. No-op if hash matches. |
| **Source Rollback** | `node scripts/deploy.mjs --rollback-source` (or `npm run deploy -- --rollback-source`) | Reverting the active runtime code to the previous release after a regression. | Repoints loader to previous release in `releases/<sha256>`, sets `previous` to null in marker. Single-step idempotent operation. | Retains `settings.json` overrides and manifest baseline. Does NOT uninstall the extension. |
| **Configuration Uninstall** | `node scripts/rollback.mjs` (or `npm run rollback`) | Fully removing the extension and restoring pre-installation state. | Removes loader `omniroute-compaction.ts` and manifest; restores original baseline in `settings.json`. | Leaves release root `$INSTALL_DIR` and historical release folders intact on disk. |

---

## Models and Configuration

### Interactive Command: `/compaction`

Configure your summarizer models interactively without restarting Pi or modifying your conversation model:

```text
/compaction
```

1. **Primary Model Selection**: Lists all chat models with valid credentials in Pi (`auth.json`), sorted by `provider/id`, with `✓` marking the current selection.
2. **Fallback Model Selection**: Prompts for a distinct backup model to handle timeouts, rate limits, or context errors from the primary model.

#### Picker Features (v1.2.1+)
- **Scroll & Large Lists (100+ models)**: Powered by `SelectList` from `@earendil-works/pi-tui`. The visible window (`maxVisible`) dynamically adapts to terminal height (`terminal.rows`), making all models fully accessible.
- **Incremental Search**: Type directly to filter models in real time by provider, model ID, or display name.
- **Keyboard & Mouse Navigation**: `↑`/`↓` (or `j`/`k`), `PgUp`/`PgDn`, `Home`/`End`, Mouse Wheel, `Enter` to select, `Esc` to cancel.
- **Headless Fallback**: Automatically degrades to standard `ui.select` when running in environments without custom UI support.
- **Hot Reloading**: Settings apply immediately in memory (`runtimeConfig`) for subsequent compactions and update the footer status (`pi-auto-compaction-model`).

### Default Models & Providers

- **Default Primary**: `omniroute/antigravity/gemini-3.8-flash-tiered`
- **Default Fallback**: `omniroute/antigravity/gemini-3.6-flash-high`

You can pair any authorized chat model available in your harness:
- **Direct Antigravity / Gemini**: `antigravity/gemini-3.8-flash-tiered` + `antigravity/gemini-3.6-flash-high`
- **OpenAI / Codex**: `openai/gpt-4o` + `openai/gpt-4o-mini`
- **Command Code / DeepSeek**: `commandcode/deepseek/deepseek-v4.1-flash` + `commandcode/deepseek/deepseek-v3.1-lite`
- **Local Ollama**: `ollama/qwen2.5-coder:14b` + `ollama/llama3.2:3b`

### Provider Skip List (`PI_AUTO_COMPACTION_SKIP_PROVIDERS`)

To prevent conversation sessions from specific providers from being summarized externally, define `PI_AUTO_COMPACTION_SKIP_PROVIDERS`. When an active conversation model matches an entry in this list, compaction bypasses the extension and delegates directly to native Pi summarization:

```bash
export PI_AUTO_COMPACTION_SKIP_PROVIDERS="deepseek,commandcode"
```

### Settings Store and Precedence

Summarizer preferences are resolved using a 4-tier hierarchy:

$$\text{options} \succ \text{env} \succ \text{file} \succ \text{default}$$

1. **`options`**: Programmatic arguments passed to `autoCompactionExtension(pi, options)`.
2. **`env`**: Environment variables `PI_AUTO_COMPACTION_PRIMARY_PROVIDER`, `PI_AUTO_COMPACTION_PRIMARY_MODEL`, `PI_AUTO_COMPACTION_FALLBACK_PROVIDER`, and `PI_AUTO_COMPACTION_FALLBACK_MODEL`.
3. **`file`**: Saved preferences in `$AGENT_DIR/.pi-auto-compaction-settings.json` (or path from `PI_AUTO_COMPACTION_SETTINGS_PATH`). Created with `0600` permissions via atomic write. Never alters `settings.json`.
4. **`default`**: Immutable defaults (`omniroute/antigravity/gemini-3.8-flash-tiered` + `gemini-3.6-flash-high`).

---

## Operations & Diagnostics

### Read-Only Diagnostic Tool (`doctor`)

Inspect deployment status, manifest state, effective thresholds, and summarizer configuration:

```bash
# Human-readable report
npm run doctor

# Programmatic JSON output
npm run doctor -- --json

# Targeted model diagnosis
npm run doctor -- --model commandcode/deepseek/deepseek-v4.1-flash
```

**Doctor Exit Codes**:
- `0`: Healthy. Configuration and thresholds align with managed policies.
- `1`: Warnings. Unmanaged overrides, models missing from catalog, or small context windows detected.
- `2`: Critical errors. Manifest missing, deploy marker in `pending` state, or unrecoverable drift.

### Managed Conversation Policies

Pi triggers compaction when token usage reaches:
$$\text{Trigger Threshold} = \text{Context Window} - \text{reserveTokens}$$

The extension manages policies for eight conversation models:

| Models | Context Window | `reserveTokens` | `keepRecentTokens` | Trigger Threshold | Capacity % |
|---|---|---|---|---|---|
| `openai/gpt-6-sol`<br>`openai/gpt-6.1-sol`<br>`openai-codex/gpt-6-sol`<br>`openai-codex/gpt-6.1-sol` | 400,000 | 65,536 | 20,000 | 334,464 | ~83.6% |
| `commandcode/deepseek/deepseek-v4.1-flash`<br>`deepseek/deepseek-v4.1-flash` | 1,000,000 | 140,000 | 20,000 | 860,000 | 86.0% |
| `omniroute/antigravity/gemini-3.8-flash-tiered`<br>`antigravity/gemini-3.8-flash-tiered` | 1,048,576 | 200,000 | 20,000 | 848,576 | ~80.9% |

*Historical Defect Context*: Prior unmanaged configurations mistakenly set `reserveTokens: 860000` for DeepSeek, causing compaction to fire at 140,000 tokens (14% capacity) and producing 105 premature compactions in a single session. Managed policies enforce the correct 140,000 reserve (triggering at 860,000 tokens / 86%).

### Continuous Integration (CI)

Automated validation runs on every commit and PR:
- **Matrix Testing**: Node.js 22 and Node.js 24 on Ubuntu.
- **Test Suite**: Complete execution of 326 unit and integration tests.
- **Pi Compatibility Smoke**: Validates hook binding and lifecycle execution against `@earendil-works/pi-coding-agent@1.5.0` and `@earendil-works/pi-ai@1.5.0`.

---

## Security, Privacy, and Licensing

### Local Telemetry Allowlist

Operational logs are written to `$HOME/.local/state/pi-auto-compaction/compaction.jsonl` (permissions `0600`, parent directory `0700`):
- **Included**: `timestamp`, `sessionId`, `reason`, `model` (summarizer), `durationMs`, `status`, `tokensBefore`, `usage`, `attemptCount`, `errorCategory`, and conversation context metrics (`conversationModel`, `conversationProvider`, `contextWindow`, `reserveTokens`, `keepRecentTokens`, `thresholdTokens`).
- **Excluded**: No message transcripts, no prompt content, no `tokensAfter`, no API keys, and no user home paths.

### Data in Transit

To generate summaries of conversation history, **older conversation turns are transmitted to the API endpoint of your configured summarizer provider** (OmniRoute by default). Use HTTPS endpoints for all remote providers. Local telemetry persists only quantitative metadata.

### Credential Separation

This repository and its configuration files **never store credentials**. All API keys remain under Pi's native credential store (`$HOME/.pi/agent/auth.json`).

> **Pre-Hook Authentication Invariant**: Pi verifies that your *active conversation model* has valid credentials in `auth.json` *before* invoking the `session_before_compact` hook. If conversation credentials expire or are missing, Pi halts before delegating to the extension.

---

## Documentation Index

### English Documentation (Primary)
- [**Installation Guide**](docs/en/installation.md): Prerequisites, clean setup, `--adopt-agent` migration, environment variables, and verification checklist.
- [**Agent Installation Guide**](docs/en/agent-install.md): Autonomous agent contract, safety gates, decision matrix, and copyable prompt.
- [**Architecture & Design**](docs/en/architecture.md): Hook lifecycle, transactional manifests, managed policies, picker internals, and security design.
- [**Maintenance & Upgrades**](docs/en/maintenance.md): Update routines, source rollback vs. uninstall, recovery journals, drift resolution, and release retention.
- [**Troubleshooting Guide**](docs/en/troubleshooting.md): Diagnosis and recovery steps for auth pre-checks, dual summarizer failures, corrupt settings, small context windows, and pending journals.

### Spanish Documentation (Documentación en Español)
- [**Guía de Instalación**](docs/es/instalacion.md)
- [**Guía de Instalación para Agentes**](docs/es/instalacion-agente.md)
- [**Arquitectura y Diseño Técnico**](docs/es/arquitectura.md)
- [**Mantenimiento y Actualizaciones**](docs/es/mantenimiento.md)
- [**Solución de Problemas**](docs/es/solucion-de-problemas.md)

### Project Policies
- [**Changelog**](CHANGELOG.md): Historical record of versions and changes.
- [**Releases**](https://github.com/wilkin-barban/pi-auto-compaction/releases): Source snapshots and release notes. Current: [v1.2.1](docs/releases/v1.2.1.md).
- [**Security Policy**](SECURITY.md): Vulnerability reporting procedures and privacy guarantees.
- [**Contributing Guide**](CONTRIBUTING.md) / [Guía en español](CONTRIBUTING.es.md): fork/PR flow, TDD discipline, tests, docs and contribution license.
- [**Code of Conduct**](CODE_OF_CONDUCT.md) / [Código de Conducta](CODE_OF_CONDUCT.es.md): community standards and private reporting.
- [**Pull request template**](.github/PULL_REQUEST_TEMPLATE.md) and [issue templates](.github/ISSUE_TEMPLATE/): what a reviewable contribution contains.
