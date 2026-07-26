# Security model

- The current listener is `100.80.70.23:9700`, selected by the protected `ARCHON_DESKTOP_BIND_HOST` and `ARCHON_DESKTOP_BIND_PORT` environment settings and reachable only inside the tailnet with bearer authentication retained.
- The service must never bind to `0.0.0.0` or a public interface.
- The backend token is generated with 256 bits of randomness and stored only in `backend/.env` with mode 0600.
- Provider credentials, Hermes `.env` values, SSH keys, and backup encryption keys never enter desktop API responses.
- Electron uses context isolation, a minimal preload bridge, disabled Node integration in the renderer, and `safeStorage` for the connection token when the OS keyring supports it.
- Filesystem APIs resolve every path beneath the configured account root and block secret-like names.
- SQL uses parameterized statements.
- Subprocesses use argument arrays; user input is not executed with `shell=True`.
- Restore, schedule, cron, service, model, and skill mutations require explicit confirmation and are audit events.
- CORS permits only local Electron/file origins and loopback development origins.

The current private endpoint is HTTP inside Tailscale. Traffic is encrypted by Tailscale; no public TLS endpoint or domain is required.
