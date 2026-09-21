# P1 — Trustworthy execution baseline

**Status:** in progress. **Current increment:** Phase 1A. **Dependencies:** audited backend and isolated fixture environment; backend work does not require the private ASAR. **Outcome:** admission, execution modes, locking, recovery and readiness describe enforced behavior truthfully.

Publish each completed increment as a pull request for review. The current work stops after Phase 1A and its evidence are published. P1 remains open until 1B–1D and the combined acceptance checks also pass. No merge, production deployment or service restart is included.

## Increment map

| Increment | Milestone items | Status | Dependency / scope boundary |
| --- | --- | --- | --- |
| Phase 1A — Locking and conservative recovery | M1.4 and the current-schema portion of M1.6 | In progress | Can proceed with existing backend; do not claim durable attempt fencing or all of M1.6 without M1.5 |
| Phase 1B — Admission, runtimes and modes | M1.1, M1.2, M1.3 | Not started | Coordinate ownership fields with 1C; no unsupported-mode fallback |
| Phase 1C — Durable admission and attempts | M1.5 and remaining M1.6 | Not started | 1B/1C can be developed in either order with an explicit compatibility contract; completes durable attempt identity and stale-result fencing |
| Phase 1D — Credentials and readiness | M1.7, M1.8 | Not started | Integrates 1B/1C; native credential handling remains gated on P2 evidence |

## Phase 1A checklist and publication gate

- [ ] Add regression tests reproducing the stale-owner lease hang and unsafe recovery of already-started work before changing behavior.
- [ ] Replace unbounded/spinning lease acquisition with bounded nonblocking waits and reliable owner release. Do not unlink a live lock inode or allow two owners during recovery.
- [ ] Gate legacy lock migration: demonstrate old/new/native lock compatibility, or require old-worker drain and an explicit maintenance migration before switching lock formats. Unknown or live legacy ownership must block safely rather than be removed automatically.
- [ ] Exercise killed owner, live owner, malformed metadata, timeout/cancellation and concurrent contenders; demonstrate event-loop responsiveness.
- [ ] Preserve unstarted queued work. Mark started work interrupted/reviewable unless verified process/native evidence proves continuation; never infer success from uncertainty.
- [ ] Demonstrate a fixture side effect is not executed twice after restart. Preserve existing client response shapes/status compatibility with a documented translation if needed.
- [ ] Record where the current schema cannot distinguish launch intent from started execution. Use conservative interruption, and carry durable attempt identity/fencing into 1C instead of claiming it exists.
- [ ] Run focused tests and applicable backend regressions with isolated paths/fake commands; inspect the diff and document result counts, skips and limitations.
- [ ] Publish the Phase 1A PR for review, link the P1 tracker, and stop. Leave the rest of P1 open.

## Full M1 work packages

### M1.1 — Explicit runtime registry (Phase 1B)

- [ ] Add an execution registry used by admission and dispatch. Prime and Pi are active only when configured/probed; Hermes remains unavailable until explicitly registered.
- [ ] Preserve documented legacy profile aliases through an explicit map. Unknown runtime/profile selections never fall back silently.
- [ ] Separate executable/version/readiness from user-facing roster/profile names.
- [ ] Assert exact dispatch for every supported alias and 422 for unknown/unsupported requests, with no runner launch on denial.

Likely files: `backend/archon_server/app.py`, `tasks.py`, `services/agents.py`; proposed `runtimes/registry.py`.

### M1.2 — Admission boundaries (Phase 1B)

- [ ] Resolve project/session ownership and canonical cwd before submitting the task.
- [ ] Map compatible projectless solo requests only to an explicitly registered scratch root within configured allowed roots.
- [ ] Reject outside-root, missing/non-directory, escaping symlink and mismatched session/project inputs. Admission resolution is defense in depth, not a filesystem sandbox.
- [ ] Test every denial with zero fake-runner launches; preserve legitimate native-session cwd ownership.

Likely files: `app.py`, `services/workspace.py`, `services/files.py`; proposed workspace resolver.

### M1.3 — Honest execution modes (Phase 1B)

- [ ] Advertise supported modes per adapter and validate before admission and dispatch.
- [ ] Reject Prime `chat_only` or protected plan/approve requests when deterministic enforcement is absent. Retain explicitly owner-authorized execution through an accurately named trusted mode.
- [ ] Verify Pi flags/extensions against the pinned invocation; do not claim unrestricted shell execution is sandboxed by tool labels.
- [ ] Replace tests that assume prompt prefixes enforce restrictions with explicit compatibility/denial cases.

Likely files: `prime_runner.py`, `pi_runner.py`, registry and API validation.

### M1.4 — Bounded session locking (Phase 1A)

- [ ] Prefer an OS advisory lock with bounded nonblocking waits and owner metadata; establish compatibility with native Prime locking.
- [ ] Never delete a live lock inode to manufacture a new owner.
- [ ] Test killed owner release, malformed metadata, responsive heartbeat and twenty contenders without overlapping critical sections. All finish or return bounded errors.

Likely files: `prime_runner.py` and its regression tests. Any native-lock compatibility not observed remains an explicit limitation in the PR.

### M1.5 — Durable admission and attempt schema (Phase 1C)

- [ ] Introduce ordered/checksummed migrations, idempotency request hashes, runtime/session ownership and explicit task-attempt states.
- [ ] Commit task, initial event and owned project relation together; use visible pending reconciliation for legacy cross-store imports.
- [ ] Identical idempotent requests return one task; reuse with a changed payload returns 409.
- [ ] Test migration and snapshot/import/rollback with duplicate project names, native Prime/Pi IDs, tombstoned sessions, and queued/running tasks.
- [ ] Restore the pre-migration copy under a tested compatibility procedure; never open an incompatible newer schema with an older binary.

Likely files: `db.py`, `tasks.py`; proposed `migrations/` and `attempts.py`.

### M1.6 — Conservative recovery (Phases 1A and 1C)

- [ ] Preserve unstarted queued tasks. Started attempts enter reconciliation/interruption unless live evidence supports continuation.
- [ ] Never automatically repeat a started attempt with unknown side effects; record an actionable review state.
- [ ] Bind events/results to attempt identity so a late old-attempt completion cannot complete its replacement (requires 1C).
- [ ] Test failure after a side effect and before result commit, restart, explicit resume as a new attempt, and stale completion.
- [ ] Keep native history intact and document existing-client status translation.

Likely files: `TaskStore.recover_inflight`, `TaskEngine`, attempt records and existing process identity helpers.

### M1.7 — Credentials and child environment (Phase 1D)

- [ ] Refuse blank token outside explicit fixture mode. Missing credentials fail with actionable setup instructions, never anonymous fallback.
- [ ] Provide an operator helper to generate a random single-owner credential into mode-0600 service configuration outside workspace roots. Keep existing wire authentication compatible; never put tokens in argv/logs.
- [ ] Verify protected or memory-only desktop connection handling before native onboarding. Missing authored source/ASAR blocks that evidence; backend fixtures do not certify storage.
- [ ] Validate bind configuration and require the private authenticated TLS path for remote use. P3 replaces the interim credential with local owner/device bootstrap and expiring migration.
- [ ] Build child environments from allowlisted essentials plus scoped runtime credentials. Secret sentinel and coordinator token must not reach fake children.

Likely files: `config.py`, `app.py`, runner spawn sites, `services/commands.py`, provisioning helper and operator guide.

### M1.8 — Readiness and observability (Phase 1D)

- [ ] Keep anonymous liveness minimal; authenticate worker/runtime/resource readiness.
- [ ] Report configured/live workers, last claim/heartbeat, queue age and per-runtime state/errors. Disabled or crashed workers cannot report execution ready.
- [ ] Update stale HTTP 201, default Hermes execution and unconditional restart-safety documentation.
- [ ] Document compatibility, migration, rollback and remaining unsupported behavior; add appropriate CI coverage.

Likely files: `app.py`, `tasks.py`, `main.py`, docs and CI.

## Full-phase validation and exit

- [ ] Applicable baseline backend behavior plus all new boundary/concurrency/recovery/auth/readiness tests pass with isolated state and fake commands.
- [ ] Every denied request is observable and launches nothing; no unsupported runtime or protected mode silently downgrades.
- [ ] Acknowledged task/event records survive restart; idempotent duplicate POST has one task; uncertain started attempts never replay automatically.
- [ ] Stale lease cannot spin forever; migration/import/rollback fixture passes; secret sentinels never reach child processes.
- [ ] Existing desktop compatibility checks pass. Record ASAR-dependent skips honestly; they do not certify native behavior.
- [ ] Publish all increment evidence and leave no unsupported full-P1 completion claim.

Known blockers: legacy lock coexistence/migration and live Prime/native-lock compatibility need explicit safety evidence or a documented old-worker drain gate. Native desktop credential handling needs actual pinned runtime/artifact evidence. Missing matching authored source/ASAR still blocks native installer qualification in P2. P1 does not provide team identities, containers, full workspace isolation or gateway revocation; those remain later gates. Follow the [roadmap workflow](README.md) and repository contribution instructions.
