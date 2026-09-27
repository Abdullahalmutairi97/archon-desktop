# P3 — Unified workspaces and persistent runner

**Status:** in progress. Protected same-user pairing, versioned workspace identity, a durable local runner outbox, and revision-pinned checkout provisioning are implemented. Native execution isolation, safe generation recovery, and moving local Codex process ownership out of Electron remain open. **Dependencies:** P1; P2 before desktop UI delivery. **Outcome:** a fresh solo installation authenticates locally and accepted work belongs to a runner instead of the desktop.

## Scope

Use the same coordinator/runner contracts for local solo and private remote work. One `workspace_id` resolves to exactly one authoritative runner root, with explicit project, owner, generation, base/head revisions and isolation profile. Keep native histories in their original format and import IDs through durable mappings. Team invitations and project roles follow in P6.

## Checklist

- [x] Create the local owner/single-owner principal and protected local-socket pairing. Verify OS peer/permissions, challenge audience/nonce/expiry and replay denial; require no online login or team infrastructure.
- [ ] Store credentials through the protected OS store; unavailable keyring means memory-only session, not silent insecure persistence. Expire and retire M1's legacy credential migration path.
- [x] Add versioned workspace/session records and mappings with explicit ownership. Reject cross-runtime/cwd resume and unknown client-supplied roots.
- [ ] Add runner enrollment, authenticated local/remote channels, supervisor and durable attempt/outbox journal. Journal before acknowledgment; deduplicate dispatch and events.
- [ ] Deduplicate runner events by `(runner_id, journal_generation, runner_seq)`. After journal loss/restore, reconcile attempts and register a new generation; stale generations cannot mutate live state.
- [ ] Implement attempts, leases, fencing, per-session serialization and deterministic reconciling/interrupted states. UI closure does not stop accepted work.
- [ ] Provision trusted worktrees or isolated independent checkouts explicitly. Demonstrate required filesystem/network/CPU/memory/PID controls on the actual host; fail closed when unavailable.
- [ ] Enforce single-writer handoff over every write-capable process, including kernels, debugger/run tasks, detached tmux children and services. Quiesce or revoke actual write access; otherwise block transfer or allocate another workspace.
- [ ] Account for aggregate workspace/host resources across agents, kernels, language servers, debugger tasks, persistent shells and services; retain reservations while children remain alive.
- [ ] Move local Codex app-server ownership and task/event persistence into the runner after active turns drain. Keep native IDs, history, file mappings and a read-only migration backup.
- [ ] Add workspace source/branch/authority indicators to the existing UI; install local coordinator/runner user services with documented UI-close versus logout behavior.
- [ ] Support consistent snapshot plus cursor replay, bounded outbox/disk behavior, and explicit interrupted state after uncertain process/host loss.

## Validation and exit

- [ ] Clean solo bootstrap works without blank auth, online login or team services. Wrong peer, replay, unavailable keyring and M1 migration tests pass.
- [ ] Duplicate dispatch, lost acknowledgment, stale fences, old restored journal, runner/coordinator restarts and outbox exhaustion preserve truthful states and committed events.
- [ ] Closing/reopening UI during a job preserves work and replay; host loss never fabricates completed work or surviving process state.
- [ ] Two workspaces run concurrently without sharing writable roots or secrets. Handoff waits for all raw writers, including detached processes.
- [ ] Local and disposable remote environments pass the same runner contract; a small native smoke validates one retained agent in each enabled environment.
- [ ] Legacy sessions resolve correctly; migration and rollback preserve histories and fail safely on ambiguous ownership.

Known blockers: actual pinned runtimes/accounts, demonstrable host isolation controls, available resource capacity and P2's native desktop boundary. Authorization-lease loss can deliberately stop execution even if the runner survives; desktop disconnect must not. No full team-readiness claim belongs here.

A disposable host probe demonstrated cgroup CPU/memory/PID limits and a bubblewrap filesystem/network view for a harmless command; hiding the user bus also blocked a nested `systemd-run --user` escape. This does not qualify Prime/Pi: their executables are absent here, and the probed profile denied provider network and hid native credential/session paths. Automatic runner generation recovery remains disabled.

Publish increments using the [roadmap workflow](README.md), recording fixture versus native results separately.
