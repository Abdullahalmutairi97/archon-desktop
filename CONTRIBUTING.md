# Contributing

Read [AGENTS.md](AGENTS.md) and the [README](README.md) first. Work on the active v0.3.0 kit in `current/`; keep the shared backend in `backend/` unchanged unless the task explicitly requires a backend fix. Preserve existing work and review the diff before staging.

## Checks

```bash
npm run setup
npm test
npm run test:backend
git diff --check
```

When the verified parent archive is available, set `ARCHON_V030_ASAR` so the tests inspect the packaged renderer. Build a candidate with `npm run build:candidate -- <parent> <new-output>`. Never update expected hashes to hide a mismatch.

The preview and unit suites use synthetic data. Native Electron behavior, live agent execution, deployment, service restarts, database changes, and real session mutations require a separate deliberate check. Report warnings and skipped checks honestly.

## Documentation and Git

Document user-visible changes in `CHANGELOG.md` and update the relevant component guide. Keep release notes tied to the active v0.3.0 kit. Do not commit credentials, environment files, runtime data, generated ASARs, dependency directories, or private screenshots. Use a focused branch for work and a concise commit message after verification.
