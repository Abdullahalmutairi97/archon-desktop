# Backend operator setup

Phase 1D changes startup and service configuration. This guide describes deliberate operator actions; implementation tests do not install or restart a service.

## New installation

1. Install the backend virtual environment as described in [the backend guide](../backend/README.md).
2. Inventory the configured `archon_root`, scratch root and **every registered project root**. Include all of them, even when a project is outside the account/scratch root. The helper cannot discover omitted roots from an attestation.
3. Run the installer with each root and the completeness flag. For example, replacing these example paths and account:

```bash
sudo deploy/install-server.sh \
  --service-user archon \
  --env-file /etc/archon-desktop/server.env \
  --workspace-root /srv/archon \
  --workspace-root /srv/projects/example \
  --confirm-workspace-roots-complete
```

The installer creates a fresh credential if the external file does not exist. It refuses repository-local configuration, unsafe paths and unexpected file permissions. An existing external file is retained, not silently rotated. The generated credential is not displayed. The installer installs and enables the systemd service; it does not deploy a proxy.

To provision only, use the module without running the installer:

```bash
sudo backend/.venv/bin/python -m archon_server.provision \
  --output /etc/archon-desktop/server.env \
  --workspace-root /srv/archon \
  --workspace-root /srv/projects/example \
  --confirm-workspace-roots-complete
```

The destination must be new, outside all supplied roots, and inside a directory owned by the invoking account with private permissions. Existing files and symlinks are rejected. The helper writes a complete mode-0600 file without returning the token. Add nonsecret service settings with a protected editor; keep the file outside agent workspaces. The `.env.example` file lists supported names but is not loaded automatically.

## Solo desktop pairing

To let the desktop connect locally without entering a bearer, run the backend service under the **same Linux account** as the desktop and set `ARCHON_DESKTOP_LOCAL_OWNER_MODE=true` in its protected external environment file. Keep the listener on loopback and `ARCHON_DESKTOP_REMOTE_ACCESS_MODE=disabled`. If using the installer above, set `--service-user` to the desktop account; the example's separate `archon` account cannot pair with a desktop running as another user. The generated service token may remain configured, but the desktop does not need to display or store it.

The backend creates a private pairing socket at `<ARCHON_DESKTOP_DATA_DIR>/runner-journal/pairing.sock` (default `~/.local/share/archon-desktop/runner-journal/pairing.sock`). With no saved remote connection, the desktop pairs automatically and holds the resulting 24-hour bearer only in main-process memory. A saved remote connection takes precedence; Disconnect disables automatic local pairing until the next desktop startup. The local service and its accepted backend tasks continue after the desktop window closes. Local Codex app-server turns are still desktop-owned and are not yet a headless runner.

## Remote access

Keep `ARCHON_DESKTOP_BIND_HOST=127.0.0.1` (or another accepted loopback literal). To declare remote operation, set `ARCHON_DESKTOP_REMOTE_ACCESS_MODE=private_tls_proxy` and `ARCHON_DESKTOP_REMOTE_BASE_URL=https://your-private-host.example`. Provision the private HTTPS proxy independently and verify certificate trust, private ingress and authentication from the actual client. A valid URL is not proof of those properties. `remote_access_mode=disabled` requires the remote URL to be unset.

Distribute the bearer credential through a protected out-of-band channel; never place it in shell arguments, logs, issue bodies or chat. Do not assume the legacy desktop encrypts stored credentials: P2 still needs native storage/onboarding evidence.

## Existing installation and rollback

Schedule a maintenance window and drain native/backend writers before replacing the server. Preserve the existing configuration through a secure editor into an external mode-0600 file with a private parent; never print or commit it. Alternatively generate a fresh credential and update clients intentionally. Point the service's `EnvironmentFile` at that file. Repository `.env` files and direct plaintext tailnet binds no longer provide working configuration. Ensure the external file includes all required paths/settings previously supplied there, not only authentication.

The installer does not silently rotate credentials or rewrite existing private files. Read [the migration/rollback notes](releases/phase-1c2-durable-attempts.md) before changing database binaries. Phase 1D adds no database migration; reverting to Phase 1C.2 still requires deliberately restoring compatible service configuration, and its earlier authentication/environment limitations return. Preserve quiescence when changing worker ownership.

Use anonymous `/api/health` for process liveness and authenticated `/api/readiness` for dispatch eligibility. Readiness returns 503 when workers are disabled, dead or stale, storage checks fail, or no runtime executable is available. A 200 response does not verify provider credentials, native versions or successful agent execution.
