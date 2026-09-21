# Architecture

Archon Desktop has two independent halves:

1. **Linux Electron client** — UI for remote work and a local Codex adapter. Remote task history belongs to the server; current local Codex process lifetime is still tied to Electron. Moving local execution into a persistent runner is planned separately.
2. **Archon Desktop server** — a FastAPI process on the configured Archon host with SQLite persistence, default Prime task dispatch, a Pi task runner, and Hermes-backed operational integrations. The Hermes task-runner implementation is not in the default dispatch mapping.

## Durable task contract

`POST /api/tasks` commits a task row and its initial ordered event in one SQLite transaction before returning HTTP 202. A server worker claims queued tasks atomically, selects its registered runner, records events, and saves the final response. Closing a remote client does not stop the server worker.

Recovery keeps tasks that have never started queued. Started tasks whose outcome is unknown become terminal `failed` records with `result.recovery` metadata and a compatible `task.failed` event. Previously deferred queued tasks with a start timestamp also require review. Neither a daemon disconnect before visible output nor a provider-limit message proves that a tool had no side effects, so these failures do not trigger automatic replay. Late completion/state transitions cannot replace the recovered terminal outcome.

This prevents automatic replay of the interrupted task; it does not prove that an old native process stopped, reconcile external effects, or isolate all new work from surviving processes. Review effects and runner state before submitting another turn. Persistent runner/attempt reconciliation and the other admission/permission boundaries remain later work.

Prime uses an advisory lock on a stable session lock file. Waiting yields to the event loop and times out; release closes the descriptor without removing the inode. The supervisor inherits the lock so surviving supervised work retains ownership after its parent server exits. An old directory-format lock fails with a migration error; drain and verify old processes before migrating it. External native Prime invocations do not participate in this Archon lock protocol.

Clients request `/api/tasks/{id}/events?after=<sequence>` to replay only events missed after their last acknowledged sequence.

## Operational adapters

- Models: inspected and changed through the Archon profile config
- Skills: listed from the Archon profile and enabled/disabled in profile config
- Files: confined to the configured account root with traversal and secret-file checks
- Terminal: named tmux sessions owned by the server account, attached over authenticated WebSockets
- Backups: existing `archon-backup.sh` and `archon-restore.sh` with inspect-before-restore and confirmation
- Cron: existing Hermes scheduler through the configured executable, with every mutation confirmed
- Status: local psutil and systemd inspection

## Persistence and migration

Application state is under `~/.local/share/archon-desktop`. Existing Hermes state remains under `~/.hermes`; backups remain under `~/backups`. All paths are configuration-derived rather than tied to the temporary Hermes process `$HOME`, which may point inside a profile directory.
