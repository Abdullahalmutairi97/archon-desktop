# P1 — Trustworthy execution baseline

**Status:** Planned P1 backend source implementation is complete; native qualification remains open. Phase 1A source is published for review in [PR #14](https://github.com/Abdullahalmutairi97/archon-desktop/pull/14). Phase 1B is published for review in [PR #15](https://github.com/Abdullahalmutairi97/archon-desktop/pull/15); Phase 1C.1 is published in [PR #16](https://github.com/Abdullahalmutairi97/archon-desktop/pull/16), and Phase 1C.2 is published in [PR #17](https://github.com/Abdullahalmutairi97/archon-desktop/pull/17). Phase 1D is published in [PR #18](https://github.com/Abdullahalmutairi97/archon-desktop/pull/18). **Dependencies:** audited backend and isolated fixture environment; backend work does not require the private ASAR. **Outcome:** admission, execution modes, locking, recovery and readiness describe enforced behavior truthfully.

Publish each completed increment as a pull request for review. Continue through tested increments, checking usage until the requested stop threshold of less than 5% remaining is reached. Backend increments 1A–1D and their combined fixture checks have passed. P1 remains open for the documented native credential/runtime qualification, which continues with P2. No merge, production deployment or service restart is included.

## Increment map

| Increment | Milestone items | Status | Dependency / scope boundary |
| --- | --- | --- | --- |
| Phase 1A — Locking and conservative recovery | M1.4 and the current-schema portion of M1.6 | Published for review | Can proceed with existing backend; do not claim durable attempt fencing or all of M1.6 without M1.5 |
| Phase 1B — Admission, runtimes and modes | M1.1, M1.2, M1.3 | Published for review in #15 | Coordinate ownership fields with 1C; no unsupported-mode fallback |
| Phase 1C — Durable admission and attempts | M1.5 and remaining M1.6 | 1C.1 published in #16; 1C.2 published in #17 | Split into 1C.1 migrations/idempotency/queued cancellation and 1C.2 durable attempts/fencing/native cancellation; no full 1C claim before both pass |
| Phase 1D — Credentials and readiness | M1.7, M1.8 | Backend source published in #18 | Integrates 1B/1C; native credential handling remains gated on P2 evidence |

## Phase 1A checklist and publication gate

- [x] Add regression tests reproducing the stale-owner lease hang and unsafe recovery of already-started work before changing behavior.
- [x] Replace unbounded/spinning lease acquisition with bounded nonblocking waits and reliable owner release. Do not unlink a live lock inode or allow two owners during recovery.
- [x] Gate legacy lock migration: demonstrate old/new/native lock compatibility, or require old-worker drain and an explicit maintenance migration before switching lock formats. Unknown or live legacy ownership must block safely rather than be removed automatically.
- [x] Exercise killed owner, live owner, malformed metadata, timeout/cancellation and concurrent contenders; demonstrate event-loop responsiveness.
- [x] Preserve unstarted queued work. Mark started work interrupted/reviewable unless verified process/native evidence proves continuation; never infer success from uncertainty.
- [x] Demonstrate a fixture side effect is not executed twice after restart. Preserve existing client response shapes/status compatibility with a documented translation if needed.
- [x] Record where the current schema cannot distinguish launch intent from started execution. Use conservative interruption, and carry durable attempt identity/fencing into 1C instead of claiming it exists.
- [x] Run focused tests and applicable backend regressions with isolated paths/fake commands; inspect the diff and document result counts, skips and limitations.
- [x] Publish the Phase 1A PR for review, link the P1 tracker, and record the boundary. Leave the rest of P1 open.

Phase 1A validation: 196 backend tests passed; 72 desktop tests passed and 16 existing ASAR-dependent checks skipped. Legacy lock migration and reverse migration require quiescence; native Prime/Electron qualification remains unperformed. See [the implementation evidence](https://github.com/Abdullahalmutairi97/archon-desktop/blob/codex/phase-1a-execution-recovery/docs/releases/phase-1a-execution-recovery.md). Checked items above describe the bounded source/publication gate, not full-P1 or production readiness.

## Phase 1C.1 boundary

Published in [PR #16](https://github.com/Abdullahalmutairi97/archon-desktop/pull/16): 381 backend tests passed, 72 desktop checks passed and 16 existing ASAR checks skipped. This increment adds versioned migration/snapshot recovery, HTTP and Telegram request fingerprints, and queued-cancellation compare-and-swap. It does not complete all of 1C. Phase 1C.2 must add attempt identity/fencing, legacy ownership reconciliation and cancellation before native launch. Native execution qualification, credential handling and full migration cutover remain separate gates.

## Phase 1C.2 boundary

Published in [PR #17](https://github.com/Abdullahalmutairi97/archon-desktop/pull/17): 437 backend tests passed and the bounded Astra review approved all fixes. Durable attempts fence events/results/session attachment; cancellation intent is stored before teardown; native prelaunch gates recheck eligibility and session ownership. Immutable v1 migration and a vendored published-v1 fixture protect upgrade compatibility. Native execution and missing frozen-ASAR qualification remain separate gates.

## Phase 1D boundary

Published in [PR #18](https://github.com/Abdullahalmutairi97/archon-desktop/pull/18): 542 backend tests passed, 72 desktop tests passed with 16 frozen-ASAR skips, and both GitHub CI runs passed. Astra approved credentials/provisioning, scoped child environments, HTTP/WebSocket authorization and authenticated readiness after one targeted environment compatibility fix. Backend feature implementation is complete. Native desktop credential storage/onboarding, actual runtime conformance and private TLS deployment are still qualification gates; further broad backend audits are not required to begin P2A.

## Full M1 work packages

### M1.1 — Explicit runtime registry (Phase 1B)

- [x] Add an execution registry used by admission and dispatch. Prime and Pi are active only when configured/probed; Hermes remains unavailable until explicitly registered.
- [x] Preserve documented legacy profile aliases through an explicit map. Unknown runtime/profile selections never fall back silently.
- [x] Separate executable/version/readiness from user-facing roster/profile names.
- [x] Assert exact dispatch for every supported alias and HTTP 409 for unknown/unsupported requests (preserving the API conflict envelope), with no runner launch on denial.

Likely files: `backend/archon_server/app.py`, `tasks.py`, `services/agents.py`; proposed `runtimes/registry.py`.

### M1.2 — Admission boundaries (Phase 1B)

- [x] Resolve project/session ownership and canonical cwd before submitting the task.
- [x] Map compatible projectless solo requests only to an explicitly registered scratch root within configured allowed roots.
- [x] Reject outside-root, missing/non-directory, escaping symlink and mismatched session/project inputs. Admission resolution is defense in depth, not a filesystem sandbox.
- [x] Test every denial with zero fake-runner launches; preserve legitimate native-session cwd ownership.

Likely files: `app.py`, `services/workspace.py`, `services/files.py`; proposed workspace resolver.

### M1.3 — Honest execution modes (Phase 1B)

- [x] Advertise supported modes per adapter and validate before admission and dispatch.
- [x] Reject Prime `chat_only` or protected plan/approve requests when deterministic enforcement is absent. Retain explicitly owner-authorized execution through an accurately named trusted mode.
- [x] Reject Pi restricted modes until pinned native conformance is verified; tool/extension flags alone are not proof of enforcement. Native verification remains a later adapter gate.
- [x] Replace tests that assume prompt prefixes enforce restrictions with explicit compatibility/denial cases.

Likely files: `prime_runner.py`, `pi_runner.py`, registry and API validation.

### M1.4 — Bounded session locking (Phase 1A)

- [ ] Prefer an OS advisory lock with bounded nonblocking waits and owner metadata; establish compatibility with native Prime locking. Archon keeps its bounded flock with owner metadata, and for a resumed native session it now also takes Prime Agent's own lease directory (atomic candidate rename plus an `owner.json` record), so each side refuses a session the other holds: a live native owner fails the turn closed, and an Archon-held lease makes native Prime refuse. Compatibility is tested in both directions against the installed Prime Agent module, and dead or recycled owners are reclaimed. Two limits remain: this module takes the native guard directory but does not refresh it in the background, and the lease owner is the server process rather than the supervisor, so after a server crash the native side may judge the lease reclaimable while a supervised run continues.
- [x] Never delete a live lock inode to manufacture a new owner.
- [ ] Test killed owner release, malformed metadata, responsive heartbeat and twenty contenders without overlapping critical sections. All finish or return bounded errors. Killed-owner release, malformed or unreadable owner records (refused, never reclaimed), twenty contenders with exactly one winner and the rest bounded refusals, and an end-to-end native holder blocking a runner turn are covered in `backend/tests/test_prime_session_lease.py`; the "responsive heartbeat" case has no equivalent in either implementation, because ownership is decided by kernel-level rename atomicity plus process liveness rather than by a heartbeat.

Likely files: `prime_runner.py` and its regression tests. Any native-lock compatibility not observed remains an explicit limitation in the PR.

### M1.5 — Durable admission and attempt schema (Phase 1C)

- [x] Fix the preexisting queued-cancellation/claim race: a queued-only cancellation transition must not return before cancelling a process that became running between the status read and transaction. Add a concurrent regression.

- [x] Introduce version-1 checksummed migration, verified pre-migration SQLite snapshots and request payload hashes (Phase 1C.1).
- [x] Add durable runtime/session ownership and explicit task-attempt states (Phase 1C.2).
- [x] Preserve Phase 1B atomic task/event/project binding; add durable ownership reconciliation for legacy cross-store imports.
- [x] Identical idempotent requests return one task; reuse with a changed payload returns 409 (Phase 1C.1).
- [ ] Test migration and snapshot/import/rollback with duplicate project names, native Prime/Pi IDs, tombstoned sessions, and queued/running tasks.
- [ ] Restore the pre-migration copy under a tested compatibility procedure; never open an incompatible newer schema with an older binary.

Likely files: `db.py`, `tasks.py`; proposed `migrations/` and `attempts.py`.

### M1.6 — Conservative recovery (Phases 1A and 1C)

- [x] Preserve unstarted queued tasks. Started attempts enter reconciliation/interruption unless live evidence supports continuation.
- [x] Never automatically repeat a started attempt with unknown side effects; record an actionable review state.
- [x] Bind events/results to attempt identity so a late old-attempt completion cannot complete its replacement (requires 1C).
- [ ] Test failure after a side effect and before result commit, restart, explicit resume as a new attempt, and stale completion.
- [x] Keep native history intact and document existing-client status translation.

Likely files: `TaskStore.recover_inflight`, `TaskEngine`, attempt records and existing process identity helpers.

### M1.7 — Credentials and child environment (Phase 1D)

- [x] Refuse blank token outside explicit fixture mode. Missing credentials fail with actionable setup instructions, never anonymous fallback.
- [x] Provide an operator helper to generate a random single-owner credential into mode-0600 service configuration outside workspace roots. Keep existing wire authentication compatible; never put tokens in argv/logs.
- [ ] Verify protected or memory-only desktop connection handling before native onboarding. Missing authored source/ASAR blocks that evidence; backend fixtures do not certify storage.
- [x] Validate bind configuration and require the private authenticated TLS path for remote use. P3 replaces the interim credential with local owner/device bootstrap and expiring migration.
- [x] Build child environments from allowlisted essentials plus scoped runtime credentials. Secret sentinel and coordinator token must not reach fake children.

Likely files: `config.py`, `app.py`, runner spawn sites, `services/commands.py`, provisioning helper and operator guide.

### M1.8 — Readiness and observability (Phase 1D)

- [x] Keep anonymous liveness minimal; authenticate worker/runtime/resource readiness.
- [x] Report configured/live workers, last claim/heartbeat, queue age and per-runtime state/errors. Disabled or crashed workers cannot report execution ready.
- [x] Update stale HTTP 201, default Hermes execution and unconditional restart-safety documentation.
- [x] Document compatibility, migration, rollback and remaining unsupported behavior; add appropriate CI coverage.

Likely files: `app.py`, `tasks.py`, `main.py`, docs and CI.

## Full-phase validation and exit

- [ ] Applicable baseline backend behavior plus all new boundary/concurrency/recovery/auth/readiness tests pass with isolated state and fake commands.
- [ ] Every denied request is observable and launches nothing; no unsupported runtime or protected mode silently downgrades.
- [ ] Acknowledged task/event records survive restart; idempotent duplicate POST has one task; uncertain started attempts never replay automatically.
- [ ] Stale lease cannot spin forever; migration/import/rollback fixture passes; secret sentinels never reach child processes.
- [ ] Existing desktop compatibility checks pass. Record ASAR-dependent skips honestly; they do not certify native behavior.
- [ ] Publish all increment evidence and leave no unsupported full-P1 completion claim.

Known blockers: legacy lock coexistence/migration and live Prime/native-lock compatibility need explicit safety evidence or a documented old-worker drain gate. Native desktop credential handling needs actual pinned runtime/artifact evidence. Missing matching authored source/ASAR still blocks native installer qualification in P2. P1 does not provide team identities, containers, full workspace isolation or gateway revocation; those remain later gates. Follow the [roadmap workflow](README.md) and repository contribution instructions.
