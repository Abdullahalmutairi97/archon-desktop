# Changelog

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
