# P7 — Release, operations and recovery qualification

**Status:** not started. **Dependencies:** P1–P6 for complete-product qualification. Backup, migration and resource safety begin in earlier phases; this is their combined release gate.

## Scope

Provide a reproducible supported Linux install, upgrade, observation, backup and recovery path. Preserve optional cron/voice/Telegram/backup integrations under appropriate permissions. Source/native validation is required; a green fixture suite with unexplained skips is not a release.

## Checklist

- [ ] Pin Python/npm/runtime artifacts and architecture-specific images/binaries. Record source commit, schema/protocol versions, digests, licenses and SBOM in a release manifest.
- [ ] Build signed/checksummed installers and updates; verify artifacts before applying. Publish support only for OS/CPU combinations actually tested.
- [ ] Provide solo user-service and restricted team service installation, configuration and data-preserving uninstall. Explain UI close versus logout, supervision and bounded drain semantics.
- [ ] Use checksummed schema migrations, a documented compatibility window and downgrade refusal. Preserve native IDs, tombstones, uncommitted/untracked files and explicit ambiguous-ownership handling.
- [ ] Migrate with backup/restore tests, shadow reads and one authoritative writer. Never dual-submit real prompts to compare adapters.
- [ ] For host cutover, pause/drain, snapshot/delta-copy, verify hashes/history, increment authority generation, disable the old writer and then resume.
- [ ] Emit structured operational/security logs and metrics for queue age, worker/lease health, event lag, task states, API/DB latency, disk, resource use, service health and backup age; avoid secret/raw-prompt leakage.
- [ ] Bound logs/events/outbox/disk retention, enforce aggregate reservations and graceful capacity queueing; test OOM/disk-full/network faults rather than relying on process death.
- [ ] Snapshot SQLite through its backup API or a quiesced consistent procedure, with workspace Git/uncommitted/untracked files, native histories/artifacts and resource manifests. Use a checkpoint barrier or label active copies crash-consistent.
- [ ] Encrypt off-host backups; store secret backups separately with tighter access and a separately held recovery key. Schedule metadata/workspace retention appropriate to measured size/cost.
- [ ] Restore onto a fresh isolated host with external hooks/cron/provider calls disabled. Verify integrity, counts, hashes, permissions and native history; restored running tasks become interrupted.
- [ ] Preserve revocation epochs/deny lists through rollback; expired invites/tickets cannot revive. Export/reconcile post-upgrade data rather than overwriting newer files with an older backup.
- [ ] Keep matching rollback binaries/backup and prohibit two writable authorities during rollback or cutover. Full-instance restore is operator-only.
- [ ] Run a bounded 24-hour soak with fixtures and a small authorized native workload; publish evidence, limitations and an executable recovery guide.

## Validation and exit

- [ ] Clean install, source build, native runtime versions, upgrade and data-preserving uninstall pass on each declared supported target.
- [ ] Artifact tampering and incompatible downgrade are rejected. Interrupted migration/run, disk-full, OOM and network drills lose no committed tasks/events.
- [ ] Restore onto another host preserves metadata/native histories/files and does not resume uncertain side effects or re-enable revoked credentials.
- [ ] Measure proposed normal-load metadata p95 under 200 ms and visible event delivery under 500 ms on a declared host; report actual load/hardware and revise unproven targets transparently.
- [ ] Measure backup recovery objectives: initial proposals are metadata RPO 15 minutes, uncommitted/native-state RPO one day and RTO two hours after replacement capacity exists. Do not report targets as achieved before a drill.
- [ ] Soak completes without unbounded growth; all required build/native/security/recovery gates have evidence and no unexplained skip.
- [ ] Release ledger, known limitations, restore guide and matching rollback artifacts are available without hidden host state or the private parent ASAR.

Known blockers: supported-host hardware, recovery storage/key custody, original script coverage, native workloads and prior-phase exit evidence. Release artifacts/production deployment are distinct actions from opening the review PR authorized by the current work.

Follow the [roadmap workflow](README.md); keep publication claims scoped to evidence actually obtained.
