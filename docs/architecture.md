# Architecture

Archon Desktop has two independent halves:

1. **Linux Electron client** — UI for remote work and a local Codex adapter. Remote task history belongs to the server; current local Codex process lifetime is still tied to Electron. Moving local execution into a persistent runner is planned separately.
2. **Archon Desktop server** — a FastAPI process on the configured Archon host with SQLite persistence, default Prime task dispatch, a Pi task runner, and Hermes-backed operational integrations. The Hermes task-runner implementation is not in the default dispatch mapping.

## Durable task contract

`POST /api/tasks` validates the runtime, execution mode and canonical workspace before committing a task row, its initial ordered event and initial project assignment in one SQLite transaction and returning HTTP 202. A server worker claims queued tasks atomically, selects its registered runner, rechecks admission, records events, and saves the final response. Closing a remote client does not stop the server worker.

The execution registry is separate from the Hermes agent roster. Prime/Pi support only explicit trusted `auto` execution until native restricted-mode enforcement is verified. Unknown runtime aliases, unavailable executable files and unsupported restrictions fail closed. Runtime file availability is not a provider or native-version readiness check. Project/session resolution confines the initial cwd to registered folders and preserves session ownership; trusted tools remain unrestricted OS-account processes.

Recovery keeps tasks that have never started queued. Started tasks whose outcome is unknown become terminal `failed` records with `result.recovery` metadata and a compatible `task.failed` event. Previously deferred queued tasks with a start timestamp also require review. Neither a daemon disconnect before visible output nor a provider-limit message proves that a tool had no side effects, so these failures do not trigger automatic replay. Late completion/state transitions cannot replace the recovered terminal outcome.

This prevents automatic replay of the interrupted task; it does not prove that an old native process stopped, reconcile external effects, or isolate all new work from surviving processes. Review effects and runner state before submitting another turn. Each claim now creates a durable attempt; event/result/session updates require its captured identity, and cancellation intent is committed before teardown. Cross-store session ownership must be unambiguous before launch. Persistent runner reconciliation across hosts remains later work.

Prime uses an advisory lock on a stable session lock file. Waiting yields to the event loop and times out; release closes the descriptor without removing the inode. The supervisor inherits the lock so surviving supervised work retains ownership after its parent server exits. An old directory-format lock fails with a migration error; drain and verify old processes before migrating it. External native Prime invocations do not participate in this Archon lock protocol.

Clients request `/api/tasks/{id}/events?after=<sequence>` to replay only events missed after their last acknowledged sequence.

An optional authenticated `Idempotency-Key` binds the normalized HTTP request to a SHA256 fingerprint. Lookup precedes mutable workspace admission, and the task transaction repeats the check to collapse simultaneous retries. Telegram supplies a fingerprint of its immutable incoming envelope. Changed payloads and legacy keys with no fingerprint conflict. This deduplicates task submission; it does not make native tool effects exactly once. A queued-only cancellation transition distinguishes an unclaimed task from one which must first reach its runner's cancellation path.

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

Schema version 2 retains immutable checksummed migrations and a version ledger, adding task attempts and reconciled session ownership. Existing database upgrades create a restrictive, integrity-checked SQLite backup before the transactional schema change; snapshot failure aborts the upgrade. The current binary rejects newer versions or checksum/ledger disagreement. Older binaries predate that guard, so rollback must restore a compatible snapshot while all writers are stopped. Phase 1C.2 provides attempt identity, stale-result fencing and legacy cross-store ownership reconciliation. Phase 1D adds no schema migration.

## Authentication and readiness

Server startup validates required credentials and loopback transport before database creation. An external service environment file supplies configuration; working-directory `.env` loading is disabled. Shared HTTP/WebSocket authorization remains a single-owner bearer protocol. Purpose-scoped environment allowlists prevent coordinator secrets from being inherited by new child processes.

Anonymous health is liveness only. Authenticated readiness combines storage checks, process-local worker liveness/heartbeats, queue aggregates and executable-file availability. Runtime credentials, actual execution, native conformance and private TLS deployment are reported separately as unverified. See [the security model](security.md) and [operator setup](operator-setup.md).
