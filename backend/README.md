# Archon Desktop backend

FastAPI/SQLite service for durable tasks, agent execution, ordered event replay, sessions/projects, files, terminal, resources, and optional Telegram/voice integration.

**Package version: 0.2.0.** The backend package is outside the Desktop version reset. The official Desktop baseline is **v0.3.0 on AbdullahPC**; see the [baseline record](../docs/releases/v0.3.0.md).

`Settings.desktop_version` now defaults to **0.3.0**, matching the verified baseline, with a regression check against `current/baseline.json`. This is a source default only: existing environment overrides, live update feeds, and installed applications were not changed. Configure an actual approved artifact and verify updater behavior before deployment, especially for devices with legacy higher-numbered labels.

## Install

From the repository root, using Python 3.12+:

```bash
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -e './backend[dev]'
```

For a new development configuration only, copy `backend/.env.example` to `backend/.env` if it does not already exist. Review every path and bind setting; examples are not a production configuration. Set a strong, non-empty `ARCHON_DESKTOP_AUTH_TOKEN` locally. Never paste it into issues, logs, or chat.

```bash
cd backend
.venv/bin/python -m archon_server.main
```

The real entrypoint is **`archon_server.main`**, not `hermes.main`. Settings read `.env` from the working directory and environment variables prefixed `ARCHON_DESKTOP_`. Source defaults are loopback port 8787. Data defaults to the OS account's `~/.local/share/archon-desktop/`, independent of an agent's overridden `$HOME`.

For a truly isolated development server, configure a separate data directory, agent history/artifact directories, resource roots, and workspace root. Starting the server with default paths is not a fixture test.

## Tests

From the repository root:

```bash
python3 scripts/test-backend.py
# Focus a test without loading the development .env:
python3 scripts/test-backend.py backend/tests/test_echo.py
```

The helper runs pytest from a temporary working directory with isolated default data/history/resource paths and removes inherited `ARCHON_DESKTOP_*` settings. Individual tests still supply their own fake runners and temporary directories. It does not start/restart a system service. It is an isolation helper, not an OS/network sandbox.

Tests cover authentication, API operations, runtime selection, native histories, session lifecycle, project assignments, event streams, shutdown, Telegram, models/resources, terminal, and filesystem restrictions.

## Runtime contract

- Accepted tasks are committed before acknowledgment.
- On restart, only never-started queued tasks remain eligible for automatic execution. Started tasks with unknown outcomes become `failed`, with review instructions in `error`, structured `result.recovery`, and a `task.failed` event. Existing clients can display the failure without a new status vocabulary.
- Daemon resets and provider-limit errors do not automatically replay a started turn. Inspect its files, native history, external effects and surviving process state before submitting new work. An interrupted outcome does not certify process teardown or exactly-once effects.
- Reconnect uses ordered event cursors; cancel is not an optimistic UI state change.
- Prime/Pi histories have different continuation and deletion rules; check runtime-specific API responses rather than treating them as interchangeable.
- Blank configured authentication currently disables the shared-token check; use it only in isolated fixtures. Phase 1A does not add team identities or complete the planned admission/authentication hardening.
- Optional Telegram needs private bot configuration. Tests use fake clients; do not invoke a live bot for unit verification.

See the root [README](../README.md), [version policy](../docs/versions.md), and [release checklist](../docs/releases.md).

### Prime lock migration

Phase 1A uses Linux `flock` on a persistent `.<session-id>.lock` file under the configured Prime session root. Do not remove an active lock file: replacing its inode can split ownership. The process supervisor retains the descriptor while its supervised work survives, even if the server dies.

The earlier implementation used a directory of the same name containing `owner.json`. A directory or unsafe file type now gives a bounded, actionable error. Before the first production upgrade, drain admissions and verify that old servers, supervisors and native session writers have stopped. Back up and migrate only the verified legacy directory while all writers are quiescent; the new runner creates the regular lock file. PID metadata alone is not proof that the work has stopped. Rolling mixed-version execution and external Prime CLI coordination are not certified by fixture tests.

See the [Phase 1A validation and upgrade notes](../docs/releases/phase-1a-execution-recovery.md) before deploying this source change.
