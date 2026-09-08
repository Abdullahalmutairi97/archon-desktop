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
- Reconnect uses ordered event cursors; cancel is not an optimistic UI state change.
- Prime/Pi histories have different continuation and deletion rules; check runtime-specific API responses rather than treating them as interchangeable.
- Blank API authentication is supported for local fixtures but must not be used for a shared endpoint.
- Optional Telegram needs private bot configuration. Tests use fake clients; do not invoke a live bot for unit verification.

See the root [README](../README.md), [work history](../docs/work-history.md), and [release checklist](../docs/releases.md).
