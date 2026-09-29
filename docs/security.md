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
- Harness management reads only provider names from each harness's `auth.json`, never values. Updates run `npm install -g <fixed package>@latest` for Pi and OpenCode only, require confirmation, and are refused while that harness has running work. The on/off state is enforced by the server when a task is created.
- OpenCode runs as the server account with argument arrays. The prompt is passed after `--`. Approve mode sets edit and shell permissions to ask through `OPENCODE_CONFIG_CONTENT`; non-interactive runs reject those, so this is enforced rather than requested in the prompt. Only Auto mode passes `--auto`.
- Git (`/api/git/*`) runs `git -C <repository>` with argument arrays for repositories inside the Archon root only. File names must stay inside the repository; refs are validated and passed after `--end-of-options`. Diffs disable external diff and textconv drivers, are size-capped, and never include content of secret-bearing files (the same names the file API blocks). Discard and push require explicit confirmation; commits run the repository's own hooks, as a terminal commit would. Push never forces.
- Previews (`/api/previews`) are opened only with the bearer token. Each gets its own listener on the configured bind host (refused when that host is a wildcard address) and forwards only to the one loopback port chosen at open time. The listener requires a 256-bit secret, traded on first navigation for an HttpOnly cookie, and strips its cookies before forwarding. At most eight are open; idle ones close after 30 minutes. A preview reaches the same account-owned loopback services the terminal already can, so it adds no authority beyond the token.

The current private endpoint is HTTP inside Tailscale. Traffic is encrypted by Tailscale; no public TLS endpoint or domain is required.
