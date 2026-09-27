# P3 — Unified workspaces and persistent runner

**Status:** in progress. Protected same-user pairing, versioned workspace identity, a durable local runner outbox, revision-pinned checkout provisioning, workspace-bound Prime task admission, and an opt-in backend-owned Local Codex worker with bounded durable event replay are implemented. Accepted Local Codex turns retain status across event eviction, and the latest accepted turns can be found after a desktop relaunch. The renderer can best-effort replay retained output for that turn; event eviction can remove it, and approvals are never restored. One disposable live-provider UI-close/reattach probe restored both completed status and retained output. An interrupted worker or backend restart reports an unknown outcome instead of pretending the turn survived. Native execution isolation and safe generation recovery remain open. **Dependencies:** P1; P2 before desktop UI delivery. **Outcome:** a fresh solo installation authenticates locally and accepted work belongs to a runner instead of the desktop.

## Scope

Use the same coordinator/runner contracts for local solo and private remote work. One `workspace_id` resolves to exactly one authoritative runner root, with explicit project, owner, generation, base/head revisions and isolation profile. Keep native histories in their original format and import IDs through durable mappings. Team invitations and project roles follow in P6.

## Checklist

- [x] Create the local owner/single-owner principal and protected local-socket pairing. Verify OS peer/permissions, challenge audience/nonce/expiry and replay denial; require no online login or team infrastructure.
- [ ] Store credentials through the protected OS store; unavailable keyring means memory-only session, not silent insecure persistence. Expire and retire M1's legacy credential migration path.
- [x] Add versioned workspace/session records and mappings with explicit ownership. Reject cross-runtime/cwd resume and unknown client-supplied roots.
- [x] Admit a Prime task by provisioned workspace ID and generation through a distinct endpoint. Resolve its project/root on the server, snapshot the binding in the task and attempt, and reject changed ownership or generation before dispatch. This does not supply native process isolation.
- [ ] Add runner enrollment, authenticated local/remote channels, supervisor and durable attempt/outbox journal. Journal before acknowledgment; deduplicate dispatch and events. Enrollment (private ledger, one-time secret, constant-time digest check), an authenticated runner heartbeat channel separate from the owner token, the durable `RunnerJournal` outbox/generation fencing and event dedup already exist; a remote claim/ack transport and the remote supervisor remain open.
- [ ] Deduplicate runner events by `(runner_id, journal_generation, runner_seq)`. After journal loss/restore, reconcile attempts and register a new generation; stale generations cannot mutate live state.
- [ ] Implement attempts, leases, fencing, per-session serialization and deterministic reconciling/interrupted states. UI closure does not stop accepted work.
- [ ] Provision trusted worktrees or isolated independent checkouts explicitly. Demonstrate required filesystem/network/CPU/memory/PID controls on the actual host; fail closed when unavailable.
- [ ] Enforce single-writer handoff over every write-capable process, including kernels, debugger/run tasks, detached tmux children and services. Quiesce or revoke actual write access; otherwise block transfer or allocate another workspace.
- [ ] Account for aggregate workspace/host resources across agents, kernels, language servers, debugger tasks, persistent shells and services; retain reservations while children remain alive.
- [ ] Complete Local Codex app-server ownership and durable task/event persistence in the runner. The opt-in backend worker owns the app-server behind a single-writer metadata lease. A private, bounded SQLite journal replays committed events; accepted-turn status survives event eviction, and an owner-only bounded list supports desktop relaunch discovery. One live-provider UI-close/reattach probe restored the same accepted task as completed. Worker loss or backend restart reports `outcome_unknown`; restart still stops active work and does not reconcile native side effects.
- [ ] Add workspace source/branch/authority indicators to the existing UI; install local coordinator/runner user services with documented UI-close versus logout behavior. Server data now labels the source project, root, revisions, generation and server-managed checkout authority; branch and owner identity remain explicitly unavailable because the current API does not report them. The same-user service installer is reviewable source, not installed on this host.
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

On 27 September, a disposable local project completed one real backend-owned Codex turn with `codex-cli 0.155.1`: project registration succeeded, start was durably acknowledged, and the private turn ledger reached `completed`. The prompt requested a short reply without commands or file edits. This validates one native provider path on this laptop, not native side-effect recovery or a remote runner.

A separate isolated backend and compiled Electron renderer were driven through loopback DevTools because the computer-use tool exposed no Electron target. The UI showed a real backend-owned Codex task as `Running` immediately before Electron closed; backend health stayed OK after closure. Relaunching the same disposable profile restored the exact accepted task ID as `Completed` with the message that status came from the backend. An initial output-replay attempt failed in a repeat probe because the main process consumed the retained event before the renderer subscribed. The adapter now keeps one bounded output snapshot and re-sends it for the exact restored task. Rebuilding and reopening the same disposable profile restored that task's retained one-word answer as well as its completed status. The prompt forbade tools, commands and file changes. This verifies native UI reattach/status/output for one harmless turn, without establishing the exact completion timestamp relative to UI closure, active service-restart recovery, native side-effect reconciliation or process isolation. The Electron instances, temporary backend and profile were removed; their ports were closed.

Publish increments using the [roadmap workflow](README.md), recording fixture versus native results separately.
