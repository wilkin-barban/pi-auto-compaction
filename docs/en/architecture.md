# Architecture and Technical Design

Explore the internal architecture of **pi-auto-compaction**, including Pi SDK hook lifecycles, transactional releases, managed policies, summarizer settings precedence, and privacy guarantees.

---

## Architecture at a Glance

In a standard Pi coding agent setup, context compaction is handled by the active conversation model. When conversation tokens exceed capacity, Pi prompts the active chat model (e.g., GPT-4o or Claude) to summarize past messages. This consumes high-tier quota and creates rate-limit risks.

**pi-auto-compaction** decouples the conversation model from the summarization engine:

```text
[Active Pi Conversation] (e.g. gpt-6.1-sol / deepseek-v4.1-flash)
              │
              ▼
   Tokens > Trigger Threshold (Window - reserveTokens)?
              │
              ├─ No ──► Normal conversation continues
              │
              └─ Yes ──► Pi verifies conversation credentials in auth.json
                             │
                             ▼
                    Fires `session_before_compact` hook
                             │
                             ▼
               ┌──────────────────────────────┐
               │     pi-auto-compaction       │
               │                              │
               │  1. Acquire herdr UI block   │
               │  2. Build sanitized context  │
               │  3. Call Primary Summarizer  │
               │     [Timeout: 60s]           │
               └──────────────┬───────────────┘
                              │
               ┌──────────────┴──────────────┐
               │                             │
          Succeeded?                      Failed?
               │                             │
              Yes                            ▼
               │                ┌──────────────────────────────┐
               │                │  Retry: Fallback Summarizer  │
               │                │  [Overall budget: 120s]      │
               │                └──────────────┬───────────────┘
               │                               │
               │                       ┌───────┴───────┐
               │                       │               │
               │                  Succeeded?        Failed?
               │                       │               │
               │                      Yes              ▼
               │                       │    Returns undefined:
               │                       │    Pi triggers native fallback
               ▼                       ▼    (Success not guaranteed)
   ┌───────────────────────────────────────┐
   │ Log allowlisted local telemetry (0600)│
   │ Return CompactionResult object to Pi  │
   │ Release herdr UI lock                │
   └───────────────────┬───────────────────┘
                       │
                       ▼
       Pi commits compacted session entries
```

---

## 1. Pi SDK Hook Lifecycle

The extension integrates cleanly with the Pi coding agent using official SDK hooks without modifying third-party binaries or packages:

| Hook Event | Trigger Condition | Extension Actions |
|---|---|---|
| `session_start` | A new or restored session begins. | Registers the status bar indicator `pi-auto-compaction-model` displaying `Compaction: <provider>/<modelId>`. |
| `session_before_compact` | Token count reaches `contextWindow - reserveTokens`. | Intercepts compaction. Emits `herdr:blocked`, serializes conversation history, validates input capacity, and dispatches the prompt to the primary summarizer (60s timeout). |
| `session_compact` | Compaction completes successfully. | Writes allowlisted operational metadata to `compaction.jsonl` and releases the `herdr:blocked` lock. |
| `session_compact_failed` | Compaction fails or user aborts. | Classifies error category, logs failure telemetry, releases UI locks, and cedes control to Pi native fallback. |

---

## 2. Pre-Hook Authentication Check

A critical architectural invariant in the Pi SDK (`AgentSession._runAutoCompaction`) is the order of authentication checks:

1. Before emitting `session_before_compact`, Pi invokes `_getSummarizationRequestAuth(model)` against the **active conversation model**.
2. Pi verifies that active, valid credentials exist in `auth.json` for that conversation provider.
3. If credentials are missing or expired, **Pi halts the compaction cycle before invoking the extension hook**.
4. **Implication**: This pre-hook check validates *credential presence*, not provider quota or universal endpoint health. `pi-auto-compaction` does not and cannot bypass the requirement for valid conversation model credentials in `auth.json`.

---

## 3. Transactional Release Architecture and Manifest v2

To ensure long-running Pi sessions are never disrupted during code updates or git checkouts, the extension isolates code across four decoupled layers:

### The Four Layers
1. **Source Checkout (`$SOURCE_DIR`)**: The local git clone where tests run and updates are fetched (e.g., `$HOME/proyectos/pi-auto-compaction`).
2. **Release Root (`$INSTALL_DIR`)**: Contains immutable, content-addressed release folders:
   - `releases/<sha256>/`: Source files verified against `.release.json`.
   - `journals/<lockToken>.json`: Transactional deployment journals.
   - `.pi-auto-compaction-deploy.json`: Authoritative deployment marker (`current`, `previous`, `state: "ready"|"pending"`).
3. **Extension Loader**: Generated TypeScript wrapper at `$AGENT_DIR/extensions/omniroute-compaction.ts`. It performs dynamic imports of the active release's `index.mjs`.
4. **Configuration Manifest v2**: Persisted at `$AGENT_DIR/.pi-auto-compaction-manifest.json`:
   - `version: "2.0.0"`
   - `originalOverrides`: Immutable pre-installation baseline of model token overrides (strictly preserved for uninstallation).
   - `policies`: Managed model policies used for drift detection.
   - `loaderHash`: SHA-256 fingerprint of the loader file.

---

## 4. Managed Conversation Policies & Threshold Calculus

Pi computes the compaction trigger point using this formula:

$$\text{Trigger Threshold} = \text{Context Window} - \text{reserveTokens}$$

The extension manages explicit policies for eight conversation models in `src/install-state.mjs` (`MANAGED_POLICIES`):

| Models | Context Window | `reserveTokens` | `keepRecentTokens` | Trigger Threshold | Capacity % |
|---|---|---|---|---|---|
| `openai/gpt-6-sol`<br>`openai/gpt-6.1-sol`<br>`openai-codex/gpt-6-sol`<br>`openai-codex/gpt-6.1-sol` | 400,000 | 65,536 | 20,000 | 334,464 | ~83.6% |
| `commandcode/deepseek/deepseek-v4.1-flash`<br>`deepseek/deepseek-v4.1-flash` | 1,000,000 | 140,000 | 20,000 | 860,000 | 86.0% |
| `omniroute/antigravity/gemini-3.8-flash-tiered`<br>`antigravity/gemini-3.8-flash-tiered` | 1,048,576 | 200,000 | 20,000 | 848,576 | ~80.9% |

### Historical Defect Analysis
In legacy environments, an external configuration set `reserveTokens: 860000` for DeepSeek. Because Pi subtracts reserve tokens from the context window (`1,000,000 - 860,000 = 140,000`), compaction was triggered at just **14% of capacity**, triggering 105 premature compactions in a single session. The managed policy enforces `reserveTokens: 140000`, delaying compaction until 860,000 tokens (86% capacity). `doctor` identifies any deviations and reports the exact trigger percentage.

### Unmanaged Models
Any model identifier not listed above remains unmanaged: it preserves user-configured overrides or Pi defaults (`reserveTokens: 16384`, `keepRecentTokens: 20000`).

---

## 5. Summarizer Configuration Store & Precedence

Summarizer models are resolved at runtime through a strict 4-level precedence cascade:

$$\text{options} \succ \text{env} \succ \text{file} \succ \text{default}$$

1. **`options`**: Explicit arguments passed to `autoCompactionExtension(pi, options)`.
2. **`env`**: Environment overrides:
   - `PI_AUTO_COMPACTION_PRIMARY_PROVIDER` + `PI_AUTO_COMPACTION_PRIMARY_MODEL`
   - `PI_AUTO_COMPACTION_FALLBACK_PROVIDER` + `PI_AUTO_COMPACTION_FALLBACK_MODEL`
   *Note*: Incomplete pairs (provider without model) are ignored with a warning.
3. **`file`**: Dedicated configuration file `$AGENT_DIR/.pi-auto-compaction-settings.json` (or path in `PI_AUTO_COMPACTION_SETTINGS_PATH`). Written atomically with mode `0600`.
4. **`default`**: Hard-coded defaults: `omniroute/antigravity/gemini-3.8-flash-tiered` (primary) and `omniroute/antigravity/gemini-3.6-flash-high` (fallback).

### Architectural Purity
`resolveConfig()` in `src/config.mjs` is a pure function without I/O. Disk reads are isolated to `resolveActiveConfig()` in `src/summarizer-settings.mjs`, which returns an immutable descriptor including `path`, `source` (e.g., `"file"`, `"env"`, `"default"`), and diagnostic `warnings`.

---

## 6. Interactive Model Selector (`/compaction`)

The `/compaction` command provides an interactive terminal interface to select summarizers:

- **Dynamic Model Discovery**: Queries `ctx.modelRegistry` for models of type `"chat"` where `hasConfiguredAuth(model)` is true. Only authorized, usable models appear in the list.
- **TUI Implementation (v1.2.1+)**: Built with `SelectList` from `@earendil-works/pi-tui`.
  - **Dynamic Viewport**: Computes `maxVisible` from `terminal.rows`, safely rendering lists of 100+ models.
  - **Incremental Search**: Filters models dynamically across provider, model ID, and display name.
  - **Controls**: Arrow keys (`↑`/`↓`), Vim keys (`j`/`k`), `PgUp`/`PgDn`, `Home`/`End`, Mouse Wheel, `Enter` (select), `Esc` (cancel).
  - **Fallback**: Degrades gracefully to flat `ui.select` in headless environments.

### Design Rationale: Why `/compaction` instead of Pi Settings

Configuring summarizers via `/compaction` was chosen over integrating into Pi's `/settings` → Extensions menu or gentle-shell's `/gentle:customize` for specific technical reasons:
1. **SDK Limitations**: Pi's `ExtensionAPI` provides `registerCommand`, `setStatus`, and `ctx.ui.*`, but lacks an API for injecting custom form fields into `/settings`.
2. **Binary Switch Restriction**: Pi's internal `ConfigSelectorComponent` only supports toggling extensions on or off.
3. **Static Menus**: In gentle-shell, `/gentle:customize` menus are statically defined in `gentle-shell.ts`.
4. **No-Patch Policy**: Bypassing these boundaries would require monkey-patching installed packages in `node_modules`, directly violating our architectural integrity contract.

---

## 7. Read-Only Diagnostics (`doctor`)

`scripts/doctor.mjs` inspects the active installation without modifying files or settings:

- **Exit Codes**:
  - `0`: Healthy.
  - `1`: Warnings (unmanaged overrides, missing catalog entries, small context windows `<32,000`).
  - `2`: Critical errors (missing manifests, pending deployment markers, corrupt baselines).
- **Programmatic JSON (`--json`)**: Emits structured JSON suitable for AI agents and automated monitors.
- **Evaluations**: Validates loader hash match, deploy marker state, effective trigger thresholds, telemetry permissions, and catalog model definitions.

---

## 8. Telemetry Allowlist and Privacy Guarantees

Local telemetry is logged to `$HOME/.local/state/pi-auto-compaction/compaction.jsonl` (mode `0600`, parent folder `0700`):

### Strictly Allowlisted Fields
- `timestamp`, `sessionId`, `reason`, `model` (summarizer model), `status`, `durationMs`, `tokensBefore`, `usage`, `attemptCount`, `errorCategory`.
- Conversation Context Metrics: `conversationModel`, `conversationProvider`, `contextWindow`, `reserveTokens`, `keepRecentTokens`, `thresholdTokens`.

### Explicit Exclusions
- **No Transcripts**: Message bodies, prompts, and file contents are never written to disk.
- **No `tokensAfter`**: The token count after compaction is not persisted.
- **No Credentials**: API keys, auth tokens, and session secrets are completely excluded.
- **No User Paths**: Local home directory prefixes are sanitized and stripped.

> **Data in Transit**: To summarize conversation history, the text of older conversation turns is transmitted to the configured summarizer API endpoint (OmniRoute by default). Local telemetry records only quantitative metadata.

---

## 9. Licensing and Source-Available Policy

- **Licensing**: Licensed as `UNLICENSED` (all rights reserved, `private: true` in `package.json`).
- **Source-Available**: The repository is public on GitHub for transparency, code auditing, and issue reporting.
- **No npm Distribution**: This package is not published to the npm registry. Installation and distribution occur solely through official Git checkouts and managed transactional deployments.

---

## Next Steps

- Explore deployment procedures: [`docs/en/installation.md`](installation.md)
- Learn automated agent protocols: [`docs/en/agent-install.md`](agent-install.md)
- Review routine maintenance: [`docs/en/maintenance.md`](maintenance.md)
- Consult troubleshooting procedures: [`docs/en/troubleshooting.md`](troubleshooting.md)
