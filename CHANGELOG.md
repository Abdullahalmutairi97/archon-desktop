# Changelog

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
