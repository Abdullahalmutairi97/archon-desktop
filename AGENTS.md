# Archon Desktop

Linux-only private control center for Abdullah's Archon VPS.

## Invariants
- The desktop client is disposable; tasks and event history are durable on the VPS.
- A task is acknowledged only after SQLite commit.
- Reconnecting clients replay events by monotonically increasing sequence number.
- Never read or return secret values. Server credentials live only in a private external service environment file outside workspace roots; never commit or implicitly load a repository `.env`.
- All paths and hosts are configurable; never hardcode the current VPS IP so MiniPC migration remains possible.
- Cron tests use an isolated fake runner. Never alter live cron state during development or tests.
- Destructive file, backup restore, and cron actions require explicit confirmation in the UI.
- Use tests first for behavior changes.
