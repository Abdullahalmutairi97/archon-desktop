# Archon Desktop

Archon Desktop is Abdullah's private Linux control center for Archon. It replaces the Hermes dashboard transport with an independent Electron client and a durable FastAPI/SQLite service while keeping Hermes Agent as the execution engine.

## Ready endpoint

The production service binds directly to the VPS Tailscale address and is reachable only inside Abdullah's tailnet:

- Current backend listener and desktop endpoint: `http://100.94.49.55:9700` (configured by `ARCHON_DESKTOP_BIND_HOST` and `ARCHON_DESKTOP_BIND_PORT`)
- Authentication: bearer token stored only in `backend/.env`
- Database: `~/.local/share/archon-desktop/archon-desktop.db`

The desktop never receives provider keys, model credentials, or the server `.env` file. It stores only the Archon Desktop connection token via Electron `safeStorage` when the Linux keyring supports it.

## Features

- Durable Archon chat and server-owned task execution
- Ordered, replayable task events after disconnects
- Task Center and task cancellation
- Model and skill controls
- Safe VPS file browser/editor/upload/download
- Server-owned tmux terminals that survive client restarts
- Backup history, inspection, manual backup, safeguarded restore, and schedule controls
- Hermes cron management with a second confirmation for every mutation
- VPS health, resources, services, themes, and English/Arabic/RTL presentation
- Portable migration manifest for a future MiniPC move
- Faithful Archon v2 workspace from Abdullah's supplied themes-and-icons package: custom titlebar, project/session sidebar, centered task composer, activity/files/terminal bench, and the supplied A-arch identity
- Five complete visual systems (Carbon, Ivory, Blueprint, Moss, and Ember) plus device-local custom themes and density/layout controls

## Linux client

Use an artifact from `desktop/release/`:

```bash
chmod +x Archon-Desktop-0.5.0-arm64.AppImage
./Archon-Desktop-0.5.0-arm64.AppImage
```

Choose the `x86_64` artifact on normal Intel/AMD Linux desktops. Enter the server URL above and copy the token locally from the VPS over SSH; never paste it into chat:

```bash
ssh archonvm "sed -n 's/^ARCHON_DESKTOP_AUTH_TOKEN=//p' /home/archon/projects/archon-desktop/backend/.env"
```

## Development and verification

```bash
cd backend
.venv/bin/pytest -q

cd ../desktop
npm ci
npm run test
npm run typecheck
npm run build
npm run dist:linux
npm run e2e
```

## Service lifecycle

The installed system service is `archon-desktop-server.service`.

```bash
sudo systemctl status archon-desktop-server.service
sudo systemctl restart archon-desktop-server.service
journalctl -u archon-desktop-server.service -n 100 --no-pager
```

The service is independent of the old Hermes dashboard on port 9119 and the Telegram gateway. Closing the desktop client does not stop accepted tasks.

## Safety

- The configured backend binds only to the VPS Tailscale address; it must never bind to `0.0.0.0` or a public interface.
- Secrets are excluded from Git and live only in `backend/.env` or existing Hermes provider storage.
- Restore, schedule, cron, model, skill, and service-changing actions require explicit confirmation.
- File access is constrained to `/home/archon`, and secret-like files are blocked.
- Existing cron jobs are not modified by installation.

See `docs/architecture.md`, `docs/security.md`, and `docs/migration.md`.
