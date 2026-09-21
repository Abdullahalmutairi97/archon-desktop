# Phase 1C.1 — Versioned migration and durable request admission

This increment follows Phase 1B and delivers a bounded part of M1.5: migration bookkeeping/snapshot recovery, payload-bound idempotency and the queued cancellation race fix. Phase 1C.2 still owns durable attempt states, event/result fencing, native cancellation before launch and legacy ownership reconciliation. P1 remains open. No service deployment, live database migration or external agent execution was performed.

## Request and cancellation behavior

Authenticated `POST /api/tasks` accepts an optional `Idempotency-Key` of 1–200 ASCII letters/digits/underscores/hyphens. The server hashes the parsed request, including defaults, before resolving mutable workspace state. Same key and payload return the original task with HTTP 202, even if its workspace has since disappeared or it has completed. This is acknowledgment of the original submission, not a new execution. Concurrent retries commit one task and one initial event; changed payloads return 409 without a new task. Hashes are internal and are omitted from API task data.

Requests without keys retain independent-task behavior. Old task IDs without stored hashes are not assigned invented fingerprints; reuse conflicts with instructions to inspect their outcome. Keys use the existing single-owner database namespace. Multi-user scoping and retention/tombstone expansion remain later identity work. Native histories and external effects are not exactly-once transactions.

Telegram fingerprints immutable sender/chat/message/update identity independently of conversation state. A failed result delivery followed by redelivery returns the original task rather than treating a newly remembered session as a changed request. Fixtures exercise this without contacting Telegram. Protected Telegram execution modes remain rejected as documented in Phase 1B.

Queued cancellation now changes only a never-started queued row. If a worker claims between the initial read and the transaction, cancellation re-reads the task and awaits runner teardown. A completed task remains completed; failed teardown does not falsely report cancellation. Native cancellation while waiting for a Prime lease still needs the prelaunch gate tracked in 1C.2.

## Migration and backup

The immutable `archon_server/migrations/v001.py` normalizes the known legacy schema and adds nullable `tasks.request_hash`. A migration ledger records its source SHA256 and application time; `PRAGMA user_version` is 1. Newer versions, gaps, checksum differences and ledger/version disagreement stop initialization before bootstrap or schema changes. Published migration files must never be edited; add ordered migrations for future changes.

Each existing version-0 database gets a verified SQLite backup named `<database>.pre-v1-<random>.sqlite3` alongside the database, with mode 0600. The backup API includes committed WAL pages. A bounded, nonblocking sidecar lock serializes cooperating initializers; a write transaction prevents competing writes while the read connection makes the snapshot. Snapshot creation/integrity checking has a timeout. The snapshot is synced and published before migration; failed snapshot or migration leaves legacy schema/data intact. Failed migrations may leave a complete verified snapshot for recovery. Fresh databases do not need a copy.

Snapshots contain private history and need protected storage, space monitoring and deliberate retention. This is a database upgrade copy, not a full workspace/provider backup or evidence that external effects can be undone. Separate project catalogs are unchanged by this increment; cross-store import/reconciliation is not certified here.

## Quiescent upgrade and rollback procedure

1. Stop admission and drain/verify backend workers, native children and other database writers. Back up deployment configuration and application state. Do not run old and new binaries together against this database.
2. Preserve the installed code version and ensure sufficient protected disk space for the database snapshot. Start the candidate only after quiescence; inspect any initialization error before attempting another start. Never bypass checksum/version errors by rewriting the ledger.
3. For rollback, stop and verify all writers again. Archive the upgraded database **and its matching WAL/SHM files** together. Do not leave an upgraded WAL beside a restored legacy database.
4. Restore the verified pre-migration snapshot into a new offline destination using SQLite's backup API, validate `PRAGMA integrity_check` returns `ok` and `PRAGMA user_version` returns 0, and preserve mode 0600. Install that restored database only after removing the archived active family from service; then start its compatible prior code/configuration.
5. Review restored queued/started tasks and external effects. Phase 1A recovery marks ambiguous started work failed for review rather than replaying it. Restoring the database does not undo native actions or bring post-snapshot tasks/results back.

The new binary rejects unknown future schemas. A pre-1C.1 binary has no version guard and cannot be made safe merely by pointing it at the upgraded database; use the snapshot restore procedure. The restore procedure is verified on isolated fixtures, not a production cutover.

## Validation

Final validation: 381 backend tests passed with one existing AnyIO deprecation warning; 72 desktop checks passed and 16 existing ASAR-dependent checks skipped. `git diff --check` passed. Migration, request-handling and cancellation changes received independent review; reported compatibility issues were fixed and regression-tested before the final full run. Fixtures cover legacy normalization, WAL-inclusive snapshot restore, private snapshot permissions, initialization races, lock timeout, failed snapshot/migration rollback, version/ledger/checksum rejection, HTTP/store/Telegram retry identity, changed-payload conflicts and cancellation/claim interleavings. No live service, native provider, Telegram or cron state is touched. Existing ASAR-dependent skips remain native-qualification gaps.
