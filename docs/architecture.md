# Architecture

Archon Desktop has two independent halves:

1. **Linux Electron client** — a replaceable UI with no provider secrets and no ownership of work execution.
2. **Archon Desktop server** — a FastAPI process on the Archon host with SQLite persistence and adapters to Hermes Agent and host operations.

## Durable task contract

`POST /api/tasks` commits a task row and its initial ordered event in one SQLite transaction before returning HTTP 201. A server worker claims queued tasks atomically, launches Hermes as a server-side subprocess, records every state transition/event, and saves the final response. If the client closes or the network disappears, the worker continues. On restart, running tasks are recovered to the queue and safely restarted.

Clients request `/api/tasks/{id}/events?after=<sequence>` to replay only events missed after their last acknowledged sequence.

## Operational adapters

- Models: inspected and changed through the Archon profile config
- Skills: listed from the Archon profile and enabled/disabled in profile config
- Files: confined to the configured account root with traversal and secret-file checks
- Terminal: named tmux sessions owned by the server account, attached over authenticated WebSockets
- Harnesses: installed agents are inventoried and switched on or off in `data_dir/harnesses.json`; the task API refuses work for a turned-off harness
- Agents: Prime, Pi and OpenCode run as server subprocesses; OpenCode turns are mirrored into the same session store Prime and Pi use
- Git: status, history, branch, diff and commit operations through the `git` CLI, confined to repositories under the account root
- Previews: one private listener per server loopback port an agent's dev server uses, opened through the authenticated API and closed after 30 idle minutes
- Backups: existing `archon-backup.sh` and `archon-restore.sh` with inspect-before-restore and confirmation
- Cron: existing Hermes scheduler through `/home/archon/.local/bin/hermes`, with every mutation confirmed
- Status: local psutil and systemd inspection

## Persistence and migration

Application state is under `~/.local/share/archon-desktop`. Existing Hermes state remains under `~/.hermes`; backups remain under `~/backups`. All paths are configuration-derived rather than tied to the temporary Hermes process `$HOME`, which may point inside a profile directory.
