# Changelog

## Unreleased — frozen v0.3.0 input verified

- The official frozen v0.3.0 archive is present on the target workstation with the expected SHA-256. The frozen kit ran 88 tests with 0 skipped against it, and the guarded candidate builder produced a validated payload. Visual/native parity and release qualification remain open.

## Unreleased — enforced service memory budget

- Launch a service that declares `memoryLimitMb` under `systemd-run --user --scope -p MemoryMax=<n>M` (cgroup v2) instead of an unbounded process; a service without a budget keeps the plain argv launch.

## Unreleased — managed service health state

- Probe each service's declared loopback health target with a bounded, credential-free GET (2s interval, 1.5s timeout) and report `starting`/`healthy`/`unhealthy`; a service without a health target reports `unknown`. Health stops with the service and is exposed on the service DTO and in the panel.

## Unreleased — desktop service surface

- Add a finite `workspaceServices` preload bridge (list, define, remove, start, stop, logs) with strict input validation of every definition field: argv bounds and control-character rejection, workspace-relative cwd, referenced allowlisted env names, unique named ports, absolute health paths and a bounded dependency list.
- Map each call to a fixed owner-only route and render a Workspace services panel that registers, starts, stops (confirmed), removes (confirmed) and tails logs, with honest state and no automatic retry of ambiguous actions.

## Unreleased — P5 runtime availability record

- Record the installed Prime/Pi/Codex/Hermes identities, headless availability, native account material and host facilities on the target workstation, and mark P5 in progress with availability established but no adapter qualified.
- Reinstall Hermes 0.19.0 as an isolated `uv` tool from the retired migration source; no gateway, dashboard, cron or systemd unit is installed or started.

## Unreleased — managed workspace services

- Add a bounded, validated registry of workspace services: an argv array, a workspace-relative working directory, referenced (allowlisted) environment names, named ports, an optional health target, dependencies and a restart policy. Definitions persist behind the workspace generation fence; dependencies must exist and cannot cycle.
- Supervise each registered definition as a workspace-owned child process with the allowlisted service environment plus server-constructed `<PORT>_PORT` variables, a bounded 16 KiB log tail and in-memory lifecycle (`registered`, `starting`, `running`, `stopped`, `exited`, `failed`). `on-failure` restart is bounded; a failing service reports `failed` with its exit code.
- Require explicit confirmation to stop or remove, block removal while other definitions depend on it, and stop every supervised child during backend shutdown. A private preview gateway and sandboxed remote view follow in the next increment; memory budgets are recorded but not yet enforced.

## Unreleased — interactive checkout attach

- Add a one-use, short-lived attach ticket that redeems exactly once into a sliding, server-fenced input lease for a persisted checkout session. Tickets and leases are bounded, owner-checked and pruned on expiry; a workspace generation change refuses stale metadata.
- Enforce a single control lease per session: a second control attach is refused while a read-only attach may still observe, and a read-only lease can never send text or control keys.
- Add bounded interactive key frames (reviewed allowlist of named tmux keys plus literal UTF-8 text) with ordered, never-retried delivery. Detaching a client always leaves the surviving shell running.
- Expose the attach lifecycle (open, claim, screen, input, detach) through the finite desktop bridge and a console panel that keeps input disabled for read-only attaches. The plain-text line console remains available.

## Unreleased — Phase 2C.2 read-only server collections

- Add a separate Server data route for authenticated read-only project, session and task rows through the finite desktop bridge.
- Label returned rows and capped list counts, clear rows on connection changes, and distinguish access rejection from other read failures.
- Keep synthetic workspace views separate and advance the reconstruction source channel to `0.3.0-reconstruction.4`.

## Unreleased — Phase 2C.1 connection and readiness view

- Add a Connection view that explicitly saves a main-process memory-only token and shows authenticated backend readiness, bounded read-only project/session/task lists and event cursor. Returned session/task lengths are not totals.
- Keep the existing workspace fixture views separate from server data. Browser preview has no bridge and cannot connect.
- Clear entered token text after submission and avoid renderer persistence; native security and keyring qualification remain later gates.
- Advance the reconstruction source channel to `0.3.0-reconstruction.3`.

## Unreleased — Phase 2B.1 trusted connection boundary

- Add a finite, validated preload bridge and top-frame IPC binding for five read-only backend operations and explicit connection methods.
- Keep bearer credentials in main-process memory, reject unsafe URLs and redirects, and abort stale requests when the connection changes.
- Preserve the synthetic renderer while native profile, keyring, local Codex, remote browser and live UI integration remain later gates.
- Advance the isolated reconstruction build to `0.3.0-reconstruction.2` and patch the Vitest development dependency.

## Unreleased — Phase 2A authored source foundation

- Add a separate Electron/React reconstruction source build with pinned dependencies and build provenance, without private-ASAR or bundle-replacement inputs.
- Port queue, scoped IDE, runtime identity and read-only snapshot behavior into typed pure modules with focused parity fixtures.
- Add a synthetic renderer shell preserving the recovered sidebar/workbench structure, theme controls and navigation shortcuts. Live transport, privileged operations, full feature parity and native qualification remain later P2 increments.
- Keep the official v0.3.0 kit unchanged; use a separate reconstruction version/identity with baseline parity explicitly unverified.

## Unreleased — Phase 1D credentials and readiness

- Require server credentials before database initialization, share HTTP/WebSocket authorization, and restrict listeners to loopback with explicit private HTTPS proxy configuration for remote use. Implicit repository `.env` loading is disabled.
- Provision credentials once into a private external mode-0600 service environment file outside all declared workspace roots; retain existing external configuration without silent rotation.
- Filter every newly launched child environment by purpose, excluding coordinator tokens, unrelated secrets and ambient shell/runtime injection settings.
- Add authenticated storage, worker, queue and runtime readiness while keeping anonymous health minimal. Dispatch eligibility does not certify native execution or provider credentials.

## Unreleased — Phase 1C.2 durable execution attempts

- Record an execution attempt with every claim and require its identity for runner events, results, errors and cancellation. Stale callbacks cannot mutate a newer attempt or attach a session.
- Persist cancellation intent before awaiting native teardown; prevent cancelled work from launching while waiting for a Prime lease or gated supervisor. Uncertain started work remains failed for review after restart and is never automatically replayed.
- Bind admitted tasks to canonical runtime and project snapshots. Reconcile session runtime/cwd ownership from complete evidence; ambiguous legacy history requires review instead of guessing from current aliases or the first native file.
- Add migration 2 with a verified pre-upgrade snapshot, preserving the immutable version-1 migration and its checksum. See the Phase 1C.2 evidence for compatibility and remaining native qualification gates.

## Unreleased — Phase 1C.1 durable request admission

- Introduce a versioned, checksummed SQLite migration with a verified mode-0600 pre-migration snapshot for existing databases. Reject newer or inconsistent migration metadata before schema changes.
- Support authenticated `Idempotency-Key` task requests. Identical retries return the existing task; changed payloads or unverifiable legacy keys return HTTP 409. Preserve one task/event across concurrent retries and Telegram delivery failures.
- Fix the queued-cancellation/claim race with a queued-only compare-and-swap before routing a newly running task through runner cancellation. Durable attempt fencing and native prelaunch cancellation remain Phase 1C.2.

## Unreleased — Phase 1B task admission

- Resolve Prime/Pi through an explicit execution registry and documented profile aliases. Unknown profiles and unavailable executables fail before task acknowledgment; `/api/runtimes` describes filesystem availability and supported modes separately from the agent roster.
- Require explicit `approval_mode: "auto"`, labeled trusted execution. Reject approval, planning and chat-only requests because neither native adapter has a verified enforcement protocol for those restrictions.
- Canonicalize task working folders within the configured scratch root or a selected registered project. Preserve session runtime/cwd ownership, reject mismatched inputs, and recheck workspace authorization before dispatch and native launch.
- Commit an initial project assignment with the task and initial event. Missing folders never silently fall back to the account home. These admission checks do not sandbox trusted execution.

## Unreleased — Phase 1A execution recovery

- Replace Prime's directory-based session lease with a bounded Linux advisory lock, retained by the process supervisor while its work survives. Legacy directory locks require a deliberate, quiescent migration instead of spinning indefinitely.
- Preserve unstarted queued tasks on recovery; record interrupted started tasks as review-required failures instead of automatically replaying them.
- Stop automatic replay after ambiguous daemon disconnects and provider-limit errors. Review side effects and runner state before submitting new work.
- Keep existing terminal task status/event shapes and add recovery detail without a database schema migration. Full runner reconciliation, admission policy and idempotency changes remain later Phase 1 increments.

## Unreleased — repository cleanup

- Removed the unused legacy desktop source tree, design/reference archives, version-specific launchers, and dated maintenance reports.
- Kept the active v0.3.0 kit, shared backend, server installer, tests, live soak utility, and release documentation.
- Removed the obsolete legacy test command and CI job; the root checks now cover the current kit and backend only.
- Confirmed that the MiniPC installed candidate still matches a clean build from `main`.

## v0.3.0 candidate

- Added Browser result links, an IDE for agent-written code, local Codex sessions, authenticated connection testing, and read-only PeerJS session/project sharing.
- Added guarded ASAR reconstruction, disposable preview fixtures, and regression coverage for patching, CSP, collaboration, code extraction, and safe file editing.
- The backend API and database were not changed for collaboration.

## v0.3.0 baseline

- The verified frozen v0.3.0 archive remains the official release input.
- Official frozen input SHA-256: `36d3ae03bd6b20c4e9ea5fc690461ef972b16eb0c9433bfb1305daeb068e549b`.
- The Python backend keeps its independent package version (`0.2.0`).

See the [baseline record](docs/releases/v0.3.0.md), [candidate ledger](docs/releases/v0.3.0-candidate.md), and [release checklist](docs/releases.md).
