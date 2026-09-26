# Phase 1C.2 — Durable execution attempts and session ownership

This increment follows Phase 1C.1 and adds attempt identity, durable cancellation intent, native prelaunch cancellation gates and session ownership reconciliation. It remains a source change for review. P1 credentials/readiness and native qualification gates remain open; no production database, service, native provider, Telegram or cron state has been changed.

## Execution and cancellation

Each successful claim creates an opaque attempt ID and a monotonically increasing ordinal for that task in the same transaction as the running transition and event. Attempts snapshot runtime, session, working folder and project. A claimed/running record describes coordinator state, not proof of a living native process. Task responses expose the current attempt identity; execution events carry the attempt that produced them.

Runner-origin events, session attachment, results, failure, interruption and cancellation must match the captured current attempt inside the write transaction. A stale or missing token cannot fall back to the newest attempt. Session metadata and its event commit together, so a rejected callback cannot leave a new session location behind.

Cancellation of never-started queued work retains the queued-only compare-and-swap from 1C.1. Running cancellation first records intent against the observed attempt, then awaits runner teardown, then finalizes only that attempt. Later completion/output cannot overtake recorded intent. A teardown error leaves intent recorded and the task active for investigation or a repeated cancellation request; it does not certify that the native workload stopped.

Prime checks cancellation while waiting for its lease and before releasing the gated supervisor. Both adapters combine local cancellation with the engine's current-attempt predicate before native launch. The supervisor is registered before release, allowing cancellation to stop it while the target is still gated. Fixture processes test these boundaries; no claim of native provider conformance or protection from external filesystem writers follows from them.

After restart, claimed/running or legacy-started work is conservatively interrupted with the existing failed-task/recovery envelope. Never-started queued tasks remain queued. Review surviving processes, native history, files and external effects before intentionally submitting a continuation as a new task. There is no automatic replay, same-task retry endpoint or exactly-once external-effect guarantee.

## Runtime, session and project identity

New admissions persist canonical runtime and project identity with the task. Dispatch and cancellation use the durable runtime rather than reinterpreting an old profile through today's alias map. Project identity is an admission snapshot, including explicit projectless NULL; moving an idle session does not rewrite earlier tasks. Dispatch rechecks the snapshot against the current assignment and active project catalog.

Session ownership records a verified runtime/canonical working folder or an actionable review-required state. Reconciliation considers relevant database and native evidence, tombstones and conflicting headers. Historical alias-only, mixed-runtime, missing-folder or conflicting-folder evidence cannot silently establish ownership. A unique actual Prime native header may establish Prime ownership; imported Pi history remains read-only. Equal longest-root matches across project IDs are ambiguous even when project display names match.

Verified session identity is preserved when later evidence conflicts. Review-required sessions cannot launch until their identity is repaired through an explicit, reviewed procedure; this increment does not provide a general ownership-repair UI. Reconciliation reads native history without rewriting it. Initial-folder admission remains defense in depth, not a filesystem sandbox.

## Schema upgrade and rollback

Migration 2 adds `task_attempts`, `session_ownership`, task runtime/project/current-attempt fields and event attempt identity. Migration 1 remains byte-for-byte unchanged. The registry validates ordered migration versions, historical checksums and required schema shape before applying missing migrations. Database-only reconciliation during migration does not read native history, mutable aliases or the current project catalog.

Existing version-0 or version-1 databases receive one verified mode-0600, WAL-inclusive snapshot named `<database>.pre-v2-<random>.sqlite3` before schema changes. A version-0 upgrade applies migrations 1 and 2 in one transaction; a version-1 upgrade applies migration 2. Failure rolls back schema and ledger changes. Fresh databases require no pre-upgrade copy. Snapshots contain private history and require protected storage, sufficient space and deliberate retention.

Upgrade and rollback require quiescent admission, backend writers, supervisors and native writers. Preserve the old code/configuration and do not run old/new servers against one database. For rollback, stop and verify all writers, archive the upgraded database with its matching WAL/SHM family, and use SQLite's backup API to restore the verified snapshot into a separate offline destination. Validate integrity, mode 0600 and the snapshot's actual original `user_version` (0 or 1), then install it with compatible code. Never combine an upgraded WAL with a restored older database or alter migration checksums to bypass a refusal.

A Phase 1C.1 binary rejects version 2; still older binaries may lack that guard and must use a compatible restored snapshot. Restore does not undo external effects or retain post-snapshot tasks/results. The procedure is fixture-tested; production cutover and reverse native-lock migration remain separate deliberate work. See the [earlier rollback notes](phase-1c1-durable-admission.md) and [lock migration notes](phase-1a-execution-recovery.md).

## Validation

Final validation: **437 backend tests passed**, with one existing Starlette/AnyIO deprecation warning. Desktop checks: **72 passed, 16 ASAR-dependent checks skipped**. `git diff --check` passed. Astra's bounded final review confirmed closure of the identified session attachment, schema protection, fingerprint compatibility, malformed-history and session visibility issues; native cancellation had already passed independent review.

Regressions cover stale/missing attempt tokens, atomic claim/event and session metadata writes, cancellation intent/teardown races, supervisor/lease cancellation, interrupted recovery without replay, project/runtime identity, malformed native evidence, history disappearance/alias compatibility, migration rollback and v1 fingerprint continuity. A vendored, hash-checked copy of the published v1 database implementation verifies that the restored v1 snapshot opens under the old code and the upgraded v2 database is refused; this check runs in fresh checkouts without relying on imported local Git history.

Tests used isolated databases, fake commands and temporary native-history files. Native Electron/provider behavior, live Prime lock compatibility and installed credential storage remain unqualified without the corresponding pinned artifacts and deliberate native checks. These results complete the bounded source increment, not full P1 or production qualification.
