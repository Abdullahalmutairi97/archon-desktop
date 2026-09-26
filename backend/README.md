# Archon Desktop backend

FastAPI/SQLite service for durable tasks, agent execution, ordered event replay, sessions/projects, files, terminal, resources, and optional Telegram/voice integration.

**Package version: 0.2.0.** The backend package is outside the Desktop version reset. The official Desktop baseline is **v0.3.0 on AbdullahPC**; see the [baseline record](../docs/releases/v0.3.0.md).

`Settings.desktop_version` now defaults to **0.3.0**, matching the verified baseline, with a regression check against `current/baseline.json`. This is a source default only: existing environment overrides, live update feeds, and installed applications were not changed. Configure an actual approved artifact and verify updater behavior before deployment, especially for devices with legacy higher-numbered labels.

## Install

From the repository root, using Python 3.12+:

```bash
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -e './backend[dev]'
```

Provision a non-empty bearer credential in a private external service environment file using the [operator setup guide](../docs/operator-setup.md). `backend/.env.example` documents setting names; the server no longer loads a working-directory `.env` automatically. Review every path and bind setting. Never paste credentials into issues, logs, chat or command-line arguments. The manual entrypoint below expects configuration already exported by the service manager or a protected local launcher.

```bash
cd backend
.venv/bin/python -m archon_server.main
```

The real entrypoint is **`archon_server.main`**, not `hermes.main`. Settings read exported environment variables prefixed `ARCHON_DESKTOP_`; implicit `.env` loading is disabled. Source defaults are loopback port 8787. Data defaults to the OS account's `~/.local/share/archon-desktop/`, independent of an agent's overridden `$HOME`.

For a truly isolated development server, configure a separate data directory, agent history/artifact directories, resource roots, and workspace root. Starting the server with default paths is not a fixture test.

## Tests

From the repository root:

```bash
python3 scripts/test-backend.py
# Focus a test without loading the development .env:
python3 scripts/test-backend.py backend/tests/test_echo.py
```

The helper runs pytest from a temporary working directory with isolated default data/history/resource paths and removes inherited `ARCHON_DESKTOP_*` settings. Individual tests still supply their own fake runners and temporary directories. It does not start/restart a system service. It is an isolation helper, not an OS/network sandbox.

Tests cover authentication, API operations, runtime selection, native histories, session lifecycle, project assignments, event streams, shutdown, Telegram, models/resources, terminal, and filesystem restrictions.

## Runtime contract

- Accepted tasks are committed before acknowledgment.
- Clients may send `Idempotency-Key` (1–200 ASCII letters, digits, underscores or hyphens) on authenticated `POST /api/tasks`. The key binds the parsed request including default values; object key order is irrelevant, while ordered skills, explicit values and selected profile names remain significant. Identical retries return the original task, including its current terminal state, without repeating admission or appending another event. Changed payloads return 409. Requests without a key remain independent submissions. Keys are scoped to this single-owner task database; this does not provide exactly-once external effects.
- Existing keyed tasks without a stored fingerprint fail closed with a legacy conflict. Inspect their outcome before intentionally using a new key; do not blindly retry with a new key after a lost response. Telegram derives its fingerprint from the immutable inbound message envelope so mutable conversation state cannot duplicate work after a delivery failure.
- `/api/runtimes` is the authenticated execution-capability catalog. `/api/agents` remains the legacy roster and does not authorize execution. Only canonical `prime` and `pi` are registered; `default`, the configured `profile` (normally `archon`) and an omitted profile map explicitly to Prime. Additional aliases require `ARCHON_DESKTOP_RUNTIME_PROFILE_ALIASES` JSON configuration. Unknown profiles never select a fallback.
- Both adapters currently accept only explicit `approval_mode: "auto"`, advertised as **Trusted execution**. The default `approve`, `plan`, and `chat_only: true` are rejected before enqueue; they are not silently upgraded. Existing clients that send protected modes must surface this error until a verified native enforcement protocol is implemented. Pi's tool flags alone are not treated as proof of isolation. Trusted execution is not sandboxed and may modify files or invoke external tools.
- Executable availability is checked from the configured file and executable permission, not by starting a native agent. Prime/Pi version conformance, credentials and provider access remain unverified by this check. Configure `ARCHON_DESKTOP_PRIME_EXECUTABLE` and `ARCHON_DESKTOP_PI_EXECUTABLE` explicitly when defaults differ.
- Projectless tasks use the registered `ARCHON_DESKTOP_TASK_SCRATCH_ROOT`, defaulting to configured `ARCHON_DESKTOP_ARCHON_ROOT` for solo compatibility. Configure a narrower existing absolute directory when appropriate. A selected active project authorizes its registered folders, including explicitly registered folders outside scratch. Missing/non-directory paths, symlink escapes, relative cwd and session/project mismatches are rejected. Resumes keep their original runtime and canonical cwd. Legacy sessions lacking a recorded cwd require explicit operator repair; no fallback creates an accidental continuation in another folder.
- The worker rechecks ownership and current workspace authorization, and native adapters repeat the check after waiting for a session lease. These checks cover the initial cwd only, not every file or shell command. They cannot prevent filesystem changes after validation or detect replacement at the same canonical path; they do not implement a filesystem sandbox.
- On restart, only never-started queued tasks remain eligible for automatic execution. Started tasks with unknown outcomes become `failed`, with review instructions in `error`, structured `result.recovery`, and a `task.failed` event. Existing clients can display the failure without a new status vocabulary.
- Daemon resets and provider-limit errors do not automatically replay a started turn. Inspect its files, native history, external effects and surviving process state before submitting new work. An interrupted outcome does not certify process teardown or exactly-once effects.
- Reconnect uses ordered event cursors; cancel is not an optimistic UI state change.
- Every claim records a durable attempt. Runner events, session attachment and terminal transitions require the captured current attempt identity; stale or missing tokens cannot mutate another attempt. Running cancellation records intent before teardown, and native prelaunch gates check both local cancellation and durable attempt eligibility. A teardown error retains intent for investigation/retry instead of claiming the process stopped.
- Tasks snapshot canonical runtime and project identity at admission. Session reconciliation uses all relevant evidence; ambiguous historical aliases, conflicting native headers or runtime/cwd disagreement require review before execution. Existing sessions keep their runtime across alias changes, and historical task project snapshots survive idle session reassignment. See [Phase 1C.2 behavior and limits](../docs/releases/phase-1c2-durable-attempts.md).
- Prime/Pi histories have different continuation and deletion rules; check runtime-specific API responses rather than treating them as interchangeable.
- Missing or whitespace-only credentials refuse startup before database creation. Anonymous fixture access requires explicit `fixture_mode=True` and a loopback listener. HTTP and terminal WebSocket authentication share the same constant-time token policy. This remains a single-owner bearer credential, not team identity.
- Backend listeners bind only to loopback. Remote use requires `remote_access_mode="private_tls_proxy"` plus a valid HTTPS `remote_base_url` and an operator-managed private ingress. URL validation does not verify the proxy or TLS deployment; Uvicorn ignores forwarded headers by default.
- `/api/health` is anonymous process liveness. Authenticated `/api/readiness` returns 200 only when storage, configured workers and at least one registered runtime executable are available, otherwise 503. Worker heartbeats describe process-local event-loop responsiveness. Credentials, native conformance and actual execution remain explicitly unverified.
- New children receive explicit purpose-scoped environment dictionaries. Ambient coordinator/Telegram/provider secrets and shell-injection variables are excluded. No ambient provider keys are currently allowlisted; supported native authentication remains file/profile based. Voice and Hermes receive only their server-constructed special overrides. This does not restrict OS-account file access or change preexisting tmux/native environments.
- Optional Telegram needs private bot configuration. Tests use fake clients; do not invoke a live bot for unit verification.

See the root [README](../README.md), [version policy](../docs/versions.md), and [release checklist](../docs/releases.md).

### Prime lock migration

Phase 1A uses Linux `flock` on a persistent `.<session-id>.lock` file under the configured Prime session root. Do not remove an active lock file: replacing its inode can split ownership. The process supervisor retains the descriptor while its supervised work survives, even if the server dies.

The earlier implementation used a directory of the same name containing `owner.json`. A directory or unsafe file type now gives a bounded, actionable error. Before the first production upgrade, drain admissions and verify that old servers, supervisors and native session writers have stopped. Back up and migrate only the verified legacy directory while all writers are quiescent; the new runner creates the regular lock file. PID metadata alone is not proof that the work has stopped. Rolling mixed-version execution and external Prime CLI coordination are not certified by fixture tests.

See the [Phase 1A validation and upgrade notes](../docs/releases/phase-1a-execution-recovery.md) before deploying this source change.

See [Phase 1B admission compatibility](../docs/releases/phase-1b-task-admission.md) for rejected legacy modes and workspace repair requirements. The optional Telegram bridge currently submits protected `approve` turns, which now fail durably before native launch; it does not implicitly opt users into trusted execution.

### Versioned database upgrade

Phase 1C.2 validates `PRAGMA user_version`, the ordered migration ledger, historical checksums and required schema shape before schema changes. Migration 1 remains unchanged; migration 2 adds attempt and ownership records. Existing version-0 or version-1 databases receive one verified SQLite snapshot named `<database>.pre-v2-<random>.sqlite3` in the same directory, mode 0600, before migration. It includes committed WAL content and may contain private prompts/history; keep it in protected operator storage and include it in retention planning. A failed snapshot or migration prevents startup; no queued work starts through that failed server initialization. Fresh databases need no pre-migration copy.

Drain backend/native writers before deployment. The bounded migration lock serializes cooperating initializers; it is not a deployment drain mechanism. Future migrations must be new files; never edit published migration files or update checksums to conceal a mismatch. A Phase 1C.1 binary refuses schema 2. Restore a verified pre-upgrade snapshot to its original schema version with compatible code rather than pointing an older binary at upgraded data. See [Phase 1C.2 upgrade and rollback](../docs/releases/phase-1c2-durable-attempts.md), including WAL-family handling and older-binary limitations.
