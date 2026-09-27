# Portable Linux package

From a clean checkout with the pinned desktop dependencies installed, run:

    npm run desktop:package:portable

The command rebuilds the Electron main, preload, renderer and runner outputs, then creates a Linux x64 tarball in desktop/release. Extract it and launch the archon-desktop-reconstruction file inside the extracted directory. Verify the adjacent .sha256 file before moving the package.

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

The archive contains the pinned Electron runtime, compiled app outputs, runtime package metadata and license notices. It contains no source checkout, node_modules, backend, user profile, token, or settings. Linux x64 is the only package target here; other architectures require their own build and native qualification.
