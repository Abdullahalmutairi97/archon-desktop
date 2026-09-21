# Phase 1A — bounded session locking and conservative recovery

Source increment prepared 21 September 2026 for pull-request review. Tracks [P1](https://github.com/Abdullahalmutairi97/archon-desktop/issues/6) under the [roadmap PR](https://github.com/Abdullahalmutairi97/archon-desktop/pull/5). This completes the bounded Phase 1A source increment; admission/modes, durable attempt identity, credentials and readiness remain Phases 1B–1D. Desktop and backend package versions are unchanged. This is not an installer or a production deployment.

## Behavior

- A Prime session uses a stable local Linux `flock` file. Acquisition yields to the event loop, times out after 30 seconds by default, and cleans up a cancelled wait. Stale or malformed diagnostic JSON does not determine ownership.
- Closing a lease does not delete its inode or explicitly unlock a shared open description. The existing process supervisor inherits the descriptor, so a surviving supervised process group keeps the lock if its parent backend dies.
- Recovery retains never-started queued tasks. Started tasks with unknown outcomes become terminal `failed` records with an actionable error and `result.recovery`; the final `task.failed` event carries matching recovery metadata. Legacy queued rows with a start timestamp are never claimed again.
- Ambiguous daemon disconnects and provider-limit errors no longer trigger immediate or scheduled replay. The user must inspect effects and the prior runner state before submitting another task. Late completion, session announcements and streamed events cannot replace the recovered terminal outcome.

`failed` here describes the coordinator's unknown execution outcome; it does not prove that every native operation failed or stopped. Existing failed-status consumers remain compatible. No database schema migration is added, and native session history is preserved.

## Validation

Tests were added before the corresponding implementation changes and reproduced the old failures. Combined validation was run from an isolated checkout of audited base `0d69e63f0a1b40a272494281a54df5f3b5b914bf`, with these changes applied:

| Check | Result | Scope |
| --- | --- | --- |
| `npm run setup` | Passed; 19 packages installed, audit reported zero vulnerabilities | Existing lockfile; existing `inflight`/`glob` deprecation notices |
| `npm test` | 88 total: **72 passed, 16 skipped, 0 failed**, 0.99 s | Existing desktop fixtures; skips require private ASAR/extracted renderer |
| `npm run test:backend` using the new checkout's backend module path | **196 passed**, one dependency deprecation warning, 27.06 s | Full backend suite through the repository isolation wrapper |
| `git diff --check` | Passed | Changed text files |
| Independent implementation review | No newly introduced blocking defect identified | Lock lifetime, concurrency, recovery transitions and compatibility |

The local environment used Node 24.21.0, npm 11.19.0 and the existing scratch Python 3.12.14 environment. The backend module path was explicitly set to this implementation checkout because the dependency environment was reused. Dependencies were installed from the prior declared ranges; this is not a frozen dependency-lock reproduction. The warning is the existing AnyIO `BlockingPortal` alias deprecation from Starlette.

New tests exercise 20 spawned contenders with maximum critical-section concurrency of one; live/killed owners; malformed/stale metadata; legacy directory rejection; stable inode and descriptor reuse; cancellation and heartbeat; unsafe file types; metadata-write failure; and backend death while the real supervisor and a synthetic Prime process survive. Recovery tests cover a fixture side effect before failure, repeated startup, direct legacy queue claims before recovery, quota/daemon failures, terminal guards and late notifications. Focused test counts are subsets of the combined 196, not additional successes.

No real Prime/provider inference, native Electron launch, production data, live cron/Telegram action, installation or service restart was used. GitHub Actions status is recorded separately on the PR and must pass on the published revision before merging.

## Upgrade and rollback gate

1. Before deploying, stop new admissions, drain accepted work, and verify that old backend processes, supervisors and relevant native session writers have stopped. Unknown process ownership blocks the operation. Do not infer quiescence merely from an absent backend PID or stale JSON.
2. Back up the task database and native session state using the existing maintenance procedure. Inspect running or formerly deferred tasks; recovery may now report review-required failures instead of replaying them.
3. The old lock is a directory named `.<session-id>.lock` containing `owner.json`; normally finishing old runners remove it themselves. If a verified leftover remains, archive that exact legacy directory only while all writers are quiescent. The new implementation fails closed on the old format instead of deleting it automatically.
4. Keep the new regular lock files in place during normal operation. Unlinking/replacing an active inode can create multiple owners. Use a trusted local Linux session root with working advisory locks; mixed-version rolling execution is not qualified.
5. A rollback to the directory-lock implementation also requires full quiescence. Archive the new persistent regular lock files before starting the old binary; a binary-only downgrade will leave old runners waiting on those files. Review terminal recovery records and external effects explicitly; do not reset failed records to queued to force replay.

This document records the required deployment procedure; it does not perform or certify a production upgrade/rollback drill.

## Remaining boundaries

- The lease coordinates participating Archon Prime runners sharing one session root. External Prime CLIs, Pi, detached processes outside the supervisor's process group, hostile filesystem mutation and network filesystems are outside this guarantee. Simultaneous loss of both supervisor and backend is not certified as preserving exclusion.
- A terminal recovery record prevents replay of that task. It does not stop unrelated or newly queued work in the same workspace or prove old native processes are gone. Persistent runner reconciliation, launch intent, attempt generations, fencing and reviewed resume remain later work.
- Phase 1A does not fix all runtime fallback, working-directory admission, prompt-only mode, shared-token or child-environment issues identified in the audit. Keep the remaining P1 gates open before expanding access.
- A preexisting queued-cancellation race was recorded for the remaining lifecycle work: a worker can claim between the engine's status read and broad cancellation transition, causing the engine to return without cancelling the running process. It is not claimed fixed by this increment.
- Missing authored desktop source/private release input still blocks native desktop and installer qualification. Passing fixtures is not a native release claim.

The requested stopping point is this Phase 1A review PR. Do not start Phase 1B automatically after publication.
