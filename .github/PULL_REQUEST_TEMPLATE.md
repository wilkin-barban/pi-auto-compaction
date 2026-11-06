# Pull Request

_English or Spanish is fine. / Se puede escribir en inglés o español._

## Summary

<!-- What changes and why, in two or three sentences. -->

## Related issue

<!-- Closes #... / Refs #... Leave empty when there is no issue. -->

## Type

- [ ] `feat` — new behavior
- [ ] `fix` — defect
- [ ] `docs` — documentation
- [ ] `test` — tests only
- [ ] `chore` — tooling, metadata, CI

## How it was tested

<!-- Exact commands and observed results, e.g. `npm test` → 326 tests in 33 suites, 0 failures. -->

## Documentation

- [ ] `README.md` / `README.es.md` updated when user-visible
- [ ] `docs/en/*` updated
- [ ] `docs/es/*` updated
- [ ] `CHANGELOG.md` updated

## Risk and rollback

<!-- What can break, who consumes it, and how to revert. State "Risk: none" with a reason when nothing shared is touched. -->

## Checklist

- [ ] `npm ci --ignore-scripts` and `npm test` pass locally
- [ ] CI is green (Node 22, Node 24, Pi 1.5.0 smoke)
- [ ] No secrets, credentials, `auth.json`, sessions or real telemetry
- [ ] No personal paths (`$HOME`, `$PI_CODING_AGENT_DIR` placeholders instead)
- [ ] No force-push and no orphan branches
- [ ] Docs are aligned in both languages
