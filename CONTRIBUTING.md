# Contributing to pi-auto-compaction

Thanks for helping. This repository is **public source-available** under `UNLICENSED`: the code can be read and audited, but all rights are reserved and nothing is published to npm. Reports, documentation, tests and patches are welcome.

- Languages: issues and pull requests in **English or Spanish**. Docs exist in both trees (`docs/en`, `docs/es`).
- Start here: [README](README.md) · [Docs EN](docs/en/installation.md) · [Docs ES](docs/es/instalacion.md) · [Security](SECURITY.md) · [Code of Conduct](CODE_OF_CONDUCT.md)
- Versión en español: [CONTRIBUTING.es.md](CONTRIBUTING.es.md)

---

## Quick path

| Step | Command / action |
|---|---|
| 1 | Fork the repository and create a descriptive branch, e.g. `docs/contributor-guide` |
| 2 | `npm ci --ignore-scripts` |
| 3 | Make the change, with tests when behavior changes |
| 4 | `npm test` — expected: `326` tests in `33` suites, `0` failures |
| 5 | Update English **and** Spanish docs when the change is user-visible |
| 6 | Open a pull request using the template |

External contributors open pull requests; only maintainers and repository agents push to `main`. No force-push, no orphan branches.

**Next step:** read [Development and tests](#development-and-tests), then open your PR.

---

## Development and tests

- Node `>= 22.19` and Pi or gentle-shell available for manual checks.
- Install exactly: `npm ci --ignore-scripts`.
- Full suite: `npm test`. Focused run: `node --test --test-name-pattern="<name>" <file>`.
- Discipline: RED (a failing test that captures the behavior), GREEN (minimal implementation), TRIANGULATE (edge cases the rule names), REFACTOR.
- Tests are offline: **no credentials, no network, no real agent directory**. Use temporary fixtures and clean them up. `test/env-isolation.mjs` is a preload of `npm test` for exactly this reason.
- CI runs Node 22, Node 24 and the Pi 1.5.0 compatibility smoke. A red CI never merges.

## Code and architecture

- ESM only (`.mjs`), small focused modules.
- Never patch Pi, gentle-shell, herdr or `node_modules`. Integrate through hooks and public APIs.
- Portable paths only: `$HOME`, `$PI_CODING_AGENT_DIR`, `$AGENT_DIR`, `$INSTALL_DIR`. No personal paths.
- No credentials, `auth.json`, sessions, real telemetry or conversation content in the repository or in tests.

## Documentation

- English is the default; Spanish must be complete, not a summary. Update both trees in the same PR.
- Relative links must resolve, counts must match reality (currently `326` tests in `33` suites), and nothing unverified may be stated as fact.
- When behavior changes, update `README.md`, `README.es.md`, `docs/en/*`, `docs/es/*`, `CHANGELOG.md` and — when applicable — the evidence and ODD files.

## Model or policy changes

- Conversation policies live in `MANAGED_POLICIES` (`src/install-state.mjs`) and are covered by `test/integration/install-state.test.mjs`.
- Any change there must keep manifest v2 and the v1→v2 migration correct, keep `doctor` accurate, and update both language docs.
- Never change defaults, license or repository visibility without the owner's decision.

## Commits and pull requests

- [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`, `chore:`.
- Atomic commits: one reviewable unit per commit.
- No `Co-Authored-By` trailers and no AI attribution.
- The PR template asks for summary, related issue, type, tests, EN/ES docs, changelog, risk and rollback, plus a checklist.
- Maintainers review, CI must be green, and the PR is squash-merged or merged. Never merge with secrets, red tests or stale docs.

## Issues and security

- Bug report: OS, Node version, Pi or gentle-shell version, extension version, reproduction steps, expected vs actual, and sanitized `doctor --json` output.
- Feature request: the problem, the proposal, alternatives and the intended scope.
- **Vulnerabilities:** do not open a public issue. Follow [SECURITY.md](SECURITY.md).
- Code of Conduct reports go privately to the maintainer through the GitHub profile; retaliation is not tolerated.

## Definition of done

- Tests and CI green.
- English and Spanish docs updated.
- `CHANGELOG.md` entry when the change is user-visible.
- No secrets and no personal paths.
- Compatibility and rollback considered and stated.
- PR reviewed and approved.

## Contribution license

- The repository is public source-available, `UNLICENSED` — **not** open source. No redistribution license is granted.
- Contributions are accepted at the maintainer's discretion. By opening a pull request you confirm you have the right to submit the change and accept that it is distributed under the repository's current terms.
- If you need another license or a CLA, contact the maintainer first. Never change the license yourself.

## Good first contributions

- Translations between English and Spanish.
- Tests for uncovered branches and error messages.
- Documentation fixes: broken links, stale counts, unclear steps.
- `doctor` output improvements and clearer error messages.
- Local-model support and provider documentation.

Look for issues labeled `good first issue` when they exist.

**Next step:** pick an issue or open one, branch, and run `npm test` before your first commit.
