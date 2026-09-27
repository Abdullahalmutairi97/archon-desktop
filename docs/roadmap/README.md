# Archon Desktop implementation roadmap

This backlog turns the 21 September 2026 repository audit and revised implementation plan into reviewable phases. Implementation starts from the existing Linux Electron/React application, FastAPI service and SQLite ledger. Preserve the familiar project/session/workbench layout, native histories and working integrations.

**Resumed on 26 September 2026 from Phase 1C.1.** Phase 1A is published in [PR #14](https://github.com/Abdullahalmutairi97/archon-desktop/pull/14); Phase 1B adds explicit admission, runtimes and trusted-mode enforcement. Neither completes all of P1. Later phases are recorded here so they can proceed without losing requirements. Publishing means opening a GitHub pull request after the applicable checks pass. It does not mean merging, deploying, restarting services or publishing an installer.

## Phase index

| Phase | Outcome | Dependencies | Status |
| --- | --- | --- | --- |
| [P1 — Trustworthy execution baseline](p1-execution-baseline.md) | Honest admission, modes, locks, recovery, credentials and readiness | Existing backend and isolated fixtures | Backend source complete through #18; native qualification remains |
| [P2 — Maintainable source build](p2-source-build.md) | Build the actual desktop from authored source and preserve UI behavior | P1D source contract; native qualification before delivery | Authored reconstruction builds, launches, and has a portable Linux x64 package; native parity and official release qualification remain open |
| [P3 — Workspaces and persistent runner](p3-workspaces-runner.md) | Protected solo bootstrap; one workspace identity; work outlives UI | P1; P2 before desktop delivery | In progress; paired workspaces, checkout-bound Prime tasks, and opt-in backend Codex owner with durable turn status are implemented; native isolation/restart recovery remain open |
| [P4 — Full solo workstation](p4-solo-workstation.md) | Full IDE, persistent terminal and managed private previews | P2 and P3 | In progress; small-file browse/search/create/edit/diff and Prime activity work, full IDE, shell and preview remain open |
| [P5 — Runtime and resource parity](p5-runtimes-resources.md) | Honest Hermes/Pi/Prime/Codex adapters; scoped MCP and skills | P3; P4 for integrated UX | Not started |
| [P6 — Collaboration for friends](p6-collaboration.md) | Individual users, shared activity, reviews and scoped service access | P3–P5 and demonstrated enforcement | Not started |
| [P7 — Release and recovery qualification](p7-release-recovery.md) | Reproducible install, upgrade, backup, rollback and operational evidence | P1–P6; operations work begins earlier | Not started |
| [P8 — Optional enhancements](p8-enhancements.md) | Selected improvements with independently measured value | Relevant essential phases and an actual need | Deferred; optional |

The main dependency chain is P1 → P3 → P4 → P5 → P6 → P7. P2 runs in parallel with P1 and gates delivery of new desktop UI. Current increments use one review branch. No essential phase depends on P8.

## GitHub tracking

- [P1 — Trustworthy execution baseline](https://github.com/Abdullahalmutairi97/archon-desktop/issues/6)
- [P2 — Maintainable source build and UI parity](https://github.com/Abdullahalmutairi97/archon-desktop/issues/7)
- [P3 — Unified workspaces and persistent runner](https://github.com/Abdullahalmutairi97/archon-desktop/issues/8)
- [P4 — Full solo workstation](https://github.com/Abdullahalmutairi97/archon-desktop/issues/9)
- [P5 — Native runtime parity and resource management](https://github.com/Abdullahalmutairi97/archon-desktop/issues/10)
- [P6 — Genuine collaboration for friends](https://github.com/Abdullahalmutairi97/archon-desktop/issues/11)
- [P7 — Release, operations and recovery qualification](https://github.com/Abdullahalmutairi97/archon-desktop/issues/12)
- [P8 — Optional enhancements](https://github.com/Abdullahalmutairi97/archon-desktop/issues/13)

The roadmap is published in [PR #5](https://github.com/Abdullahalmutairi97/archon-desktop/pull/5). P1 backend source increments are published in [PRs #14–#18](https://github.com/Abdullahalmutairi97/archon-desktop/pull/18); native qualification remains open. P2A's authored desktop source foundation is published in [PR #19](https://github.com/Abdullahalmutairi97/archon-desktop/pull/19), and P2B.1's trusted read-only bridge is published in [PR #20](https://github.com/Abdullahalmutairi97/archon-desktop/pull/20). P2C.1 exposes an explicit Connection view in PR #21, and the isolated P2B.2 storage core is in PR #22. P2C.2 Server data is in review. Other P2B/C increments and P2D native/package gates remain open; each PR records its own fresh checks and limitations.

## How work is published

1. Keep one tracking issue per phase, linking this document and its phase checklist. Split substantial work into child issues or explicit increments.
2. Develop a focused increment on a branch. Write behavior tests first, use isolated data and fake runners, and preserve unrelated work.
3. Run focused regressions for changed behavior and one final integration check per increment; inspect the diff. Avoid repeated broad audits or tests without a concrete risk. Record exact commands, results, skipped checks, limitations and migration/rollback implications.
4. Open a pull request for review. Link the phase/child issue and state which exit gates remain open. An increment PR must not close its overarching phase issue unless every phase gate has passed.
5. A phase is complete only when its full checklist and required native/security/recovery evidence are satisfied. Passing fixtures does not certify native integration or production readiness.

Continue through tested increments under the latest instruction to stop when usage falls below 5% remaining. Check usage throughout, keep completed work published, and save unfinished work honestly if that threshold interrupts an increment. Update this backlog and leave an accurate handoff at the boundary. Do not represent partial work as a completed phase.

## Contracts retained throughout the roadmap

- A task is acknowledged only after its task and initial event transaction commits. Preserve durable ordered replay; project-filtered global sequence numbers need not be contiguous.
- The UI is disposable. A runner owns accepted execution and its journal. Desktop disconnect, coordinator loss, runner restart and host reboot have different outcomes.
- Each workspace has one authoritative root. Agents, IDE, debugger, terminals and managed services use that root; independent writers use separate workspaces with reviewed integration.
- Identity, capability, path, approval, resource and isolation checks are deterministic. Unsupported restrictions deny rather than becoming prompt-only promises.
- Unknown side effects require reconciliation or review. Native history/resume is not exactly-once execution, and recovery must not blindly replay started work.
- No raw secrets in API output, logs or Git. Paths/hosts remain configurable. Tests never touch live cron or production data.
- Backups, migration/rollback and retention start with relevant changes, not only at P7. Restore must preserve revocations and must not create two authorities.
- Keep the existing snapshot export as explicitly read-only sharing; it is not live collaboration or revocable recipient storage.

## Evidence and limitations

The audit source was [revision `0d69e63`](https://github.com/Abdullahalmutairi97/archon-desktop/commit/0d69e63f0a1b40a272494281a54df5f3b5b914bf). All 122 tracked files matched that snapshot. The dated audit recorded 169 backend fixture tests passing and 72 desktop tests passing with 16 ASAR-dependent skips. These are historical baseline results, not results of this roadmap publication or evidence that a new increment passes.

The current repository contains an active v0.3.0 reconstruction kit rather than the complete matching authored desktop source. On 26 September, all 102 files of a historical legacy Electron/React tree and both design ZIPs were recovered and hash-verified from GitHub. They are reference inputs and do not contain the matching parent ASAR. The [source inventory](p2-source-inventory.md) records the 24-commit search and provenance. Native desktop behavior, live agents and two-PC collaboration remain unverified; P2 retains explicit build and parity gates.

Local Laya was run in a separate plan review: 121 calls, 16/24 factual checks correct under its original rubric, 13/19 on the unambiguous subset, and four of twelve architecture choices changed when option order reversed. It is advisory, not the plan approver. Jev API calls were zero. Separate source/plan review supplied four refinements retained here: P3 owns solo bootstrap, privileged MCP restrictions need enforcement outside workspace code, checks bind to the actual merge result, and resource accounting includes persistent child workloads.

The local audit and Laya evidence package remains outside this repository; this backlog does not claim that unavailable artifacts are in Git. The phase documents carry the actionable requirements needed for implementation. Re-run relevant checks against every implementation revision and put fresh evidence in its PR.

For repository rules and current checks, read [AGENTS.md](../../AGENTS.md), [CONTRIBUTING.md](../../CONTRIBUTING.md), the [current kit guide](../../current/README.md) and [release checklist](../releases.md).
