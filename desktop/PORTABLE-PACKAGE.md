# Portable Linux package

From a clean checkout with the pinned desktop dependencies installed, run:

    npm run desktop:package:portable

The command rebuilds the Electron main, preload, renderer and runner outputs, then creates a Linux x64 tarball in desktop/release. Extract it and launch the archon-desktop-reconstruction file inside the extracted directory. Verify the adjacent .sha256 file before moving the package.

On a pull request or manual source-build workflow run, download the seven-day `archon-desktop-reconstruction-preview-not-a-release` artifact from that run's Artifacts section. It contains only the `.tar.gz` bundle and its `.sha256` sidecar.

This is the isolated reconstruction build. It uses the Archon Desktop Reconstruction app identity and its own user-data profile; it does not replace or modify the frozen v0.3.0 application. It does not install or start the backend. Server operations need an already-running, configured backend. Local Codex needs the Codex CLI on this computer. The chat and general project/session/task views and some workbench panels still show fixture data.

## Optional same-user backend service

For local pairing and server tasks, keep a Linux source checkout at a stable absolute path. From its repository root, create the backend environment and install its dependencies (Python 3.12+):

```bash
cd /absolute/path/to/source-checkout
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -e './backend[dev]'
```

Then, as the same Linux account that runs the desktop, install the user service from that checkout:

```bash
deploy/install-user-server.sh \
  --archon-root /home/you/work \
  --workspace-root /home/you/work \
  --confirm-workspace-roots-complete
```

Replace the example with your existing Archon root and every configured scratch and registered project root, repeating `--workspace-root` for each one. The `/home/you/work` example is outside the default `~/.config/archon-desktop/server.env`; the `--archon-root` path must also appear as a `--workspace-root` value. Choose a dedicated workspace directory so the file service does not include private account configuration, and keep the default environment file outside every workspace root (set `--env-file /absolute/private/path/server.env` if needed). The installer requires a logged-in systemd user manager, creates an external private environment file containing the Archon root, enables loopback-only same-user pairing, and points the unit directly at this checkout and `backend/.venv`; keep those paths in place. For environment-file location, existing-file validation, and removal details, see `docs/operator-setup.md` and `deploy/install-user-server.sh` in the source checkout.

Prime must also be installed and executable for that service account. The backend defaults to that account's `~/.local/bin/prime-agent`; if Prime is elsewhere, set `ARCHON_DESKTOP_PRIME_EXECUTABLE=/absolute/path/to/prime-agent` in the external `server.env` created by the installer, then restart `archon-desktop-server.service` with `systemctl --user restart archon-desktop-server.service`. The backend readiness check verifies the executable file and permission, but not the Prime version, credentials, provider access, or successful execution.

The selected-checkout line console also needs `tmux` installed on the backend host. By default, the backend resolves `tmux` from the service's `PATH`. To use a user-local binary, set `ARCHON_DESKTOP_LOCAL_WORKSPACE_TERMINAL_TMUX_EXECUTABLE=/absolute/path/to/tmux` in the external `server.env` file, or set it to a basename available on the service's `PATH`, then restart `archon-desktop-server.service`. The backend resolves and checks this server-owned executable before using it. The console starts a shell at the selected checkout as the backend account and can access that account's files; it is a trusted same-user console, not a filesystem sandbox or full interactive terminal. Closing the desktop detaches the view without stopping a surviving tmux session. **Interrupt command** sends Ctrl-C once to the selected running session without closing it; if delivery is uncertain, refresh before deciding whether to try again. Stop a session explicitly in the console when finished.

## Optional backend-owned Local Codex

The portable app and same-user backend can share one Codex metadata profile so a turn may continue after the desktop closes. This remains opt-in. Use the same Linux account for the desktop and user service, install and authenticate the Codex CLI for that account (auth defaults to `~/.codex`), and build the worker from the server source checkout with `npm run desktop:setup` and `npm run desktop:build`. The configured worker script must exist at `desktop/out/runner/runner/worker.js` in that checkout.

Launch the portable app once, then fully quit it. In the service's private external `server.env`, edit with a protected editor and add these nonsecret settings, replacing the sample with the **existing absolute `codex` directory inside the app's profile**:

```ini
ARCHON_DESKTOP_LOCAL_CODEX_ENABLED=true
ARCHON_DESKTOP_LOCAL_CODEX_METADATA_ROOT=/home/you/.config/archon-desktop-reconstruction-dev/codex
```

The shown path assumes the default Linux config directory; if you use `XDG_CONFIG_HOME`, use that directory in the path. Keep the installer's `ARCHON_DESKTOP_LOCAL_OWNER_MODE=true` and `ARCHON_DESKTOP_REMOTE_ACCESS_MODE=disabled` settings. Never print or copy the service credential while editing. Restart the service, then launch the extracted app with backend ownership enabled:

```bash
systemctl --user restart archon-desktop-server.service
ARCHON_DESKTOP_CODEX_OWNER=backend ./archon-desktop-reconstruction
```

Quit Electron before enabling or restarting the backend owner: both owners use an exclusive lease on this same profile. Backend mode does not fall back to an Electron-owned Codex process if pairing or the service fails. Closing Electron leaves an active turn with the service, but restarting or stopping the service can interrupt it and an interrupted turn is not resumed automatically.

The archive contains the pinned Electron runtime, compiled app outputs, runtime package metadata and license notices. It contains no source checkout, node_modules, backend, user profile, token, or settings. Linux x64 is the only package target here; other architectures require their own build and native qualification.
