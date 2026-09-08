# Contributing

## Before editing

1. Read [AGENTS.md](AGENTS.md), the root README, and the component README.
2. Check `git status --short --branch` and preserve existing work. This repository currently contains substantial pre-existing uncommitted changes.
3. Confirm which client lineage you mean using [versions](docs/versions.md). Do not overwrite the main desktop with the separate Prime client or blindly merge their histories.
4. Use a focused branch. Keep visual behavior and per-client preferences intact unless the task explicitly changes them.

## Checks

```bash
# Current v0.3.0 patch/metadata and backend fixtures
npm test
npm run test:backend

# Legacy source regressions (not the current release build)
npm --prefix desktop test
npm --prefix desktop run typecheck
npm --prefix desktop run build
git diff --check
```

The official baseline is AbdullahPC's verified unified-refresh v0.3.0. Read `current/README.md` before changing its reconstruction kit. Exact reconstruction requires a verified frozen parent archive; never update expected hashes merely to make a failing comparison pass.

Install dependencies as documented in the README first. Backend tests use fixtures and fake runners. For bug fixes, reproduce the problem and add a failing regression before changing behavior. Report warnings and skipped/failed checks honestly.

Electron screenshot/smoke tests require a display and an isolated profile. Live API tests, agent prompts, deployment, restarts, database changes, deletion, and cron mutations require separate operator approval. Unit/build success is not proof of UI behavior or production health.

## Changes and documentation

- Document user-visible changes under **Unreleased** in `CHANGELOG.md`.
- Update component setup when scripts, dependencies, runtime behavior, or configuration change.
- Keep historical validation reports intact; add a new report instead of editing old results to sound current.
- Keep API and backend versions independent unless an intentional release changes both.
- Never silently choose a new license; ownership and third-party/reference asset provenance must be reviewed before public distribution.

## Review and publication

Review an explicit source-file allowlist before staging. Never use `git add .` as a substitute for inspecting untracked files in this checkout. Environment backups, recovery data, private screenshots, operational session logs, and binaries do not belong in a source commit.

Do not commit, push, tag, force-push, or publish on the operator's behalf without approval. Follow the [release checklist](docs/releases.md). Git ignore rules protect future staging only; they do not remove sensitive material already committed or replace a pre-publication review.
