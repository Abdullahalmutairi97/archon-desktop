# Work history and evidence index

**2026-09-10 follow-up:** the [v0.3.0 candidate ledger](releases/v0.3.0-candidate.md) records all Browser/IDE/collaboration commits, the switch from legacy source to the verified renderer, readiness fixes, build commands, and release limitations. The [readiness audit](../current/testing/readiness-audit.md) contains the current verification evidence; earlier records below remain historical.

Reconstructed from available code, Git metadata, release folders, and handoff notes on 2026-09-08. This covers the discoverable Archon Desktop work; it is not a claim to recover every past conversation. Source trees differ, so a recorded feature is not automatically present in every client.

**Version policy:** the current AbdullahPC build is official **v0.3.0**. Its archive is now verified as the saved **unified-refresh** release, and the repository's `current/` kit reconstructs it byte-for-byte. All nonmatching Desktop snapshots/source labels below are legacy, not releases above it. See the [baseline record](releases/v0.3.0.md). Historical feature records remain separate from fresh runtime/UI verification.

## 1. Durable desktop foundation

FastAPI/SQLite task ownership; acknowledgment after commit; ordered event replay; process-tree cancellation; task queue/retry; file/terminal/backup/cron operations; configurable hosts and paths; themes and Arabic/RTL support. Evidence: main `backend/`, `desktop/`, [architecture](architecture.md), and [security](security.md). Older architecture notes retain historical deployment assumptions.

## 2. Standalone client and creative workspaces

Electron main-process networking, write-only token bridge, React state/event handling, custom titlebar/sidebar/bench, persisted themes/backgrounds, design templates and shared canvas tools, diagrams, document/spreadsheet editing, and isolated browser/preview surfaces.

Evidence: sibling `archon-desktop-client/BUILD-NOTES.md`, `DECISIONS.md`, `API-SURFACE.md`, and corresponding Prime client sources. Build notes are product specifications: intended behavior and fixture-era descriptions must not be mistaken for verified implementation.

## 3. Settings/Sessions release refinements

The sibling `archon-desktop-v0.3.0/` preserves the original promotion and its refinements:

| Folder | Recorded work |
| --- | --- |
| Root | Settings/Sessions promotion, launcher fix, rollback/checksum and smoke records |
| `ui-fit/` | Zoom/viewport sizing, compact bench controls, bounded panels, small-window visibility |
| `session-selection/` | Native Pi deletion, selection behavior, confirmation/recovery |
| `sessions-classic/` | Classic compact table, filters, agent/source labels, visible details, selection |
| `agent-resources/` | Real per-agent installed Skills/MCP inventory and inspection |
| `unified-refresh/` | Consistent refresh controls across seven surfaces |
| `single-agent/` | Additional single-agent refinement and TDD records; see its own README |

These saved records and binaries remain unchanged. The **unified-refresh** artifact has now been independently matched to AbdullahPC and reconstructed exactly in the repository's `current/` kit. Its original/intermediate/other refinement artifacts remain legacy; see [versions](versions.md).

## 4. Native Prime runtime and session correctness

- [Streaming benchmark](prime-session-benchmark-2026-08-19.md): progressive deltas, event reconstruction, concurrency follow-up.
- [Multi-turn benchmark](prime-multiturn-benchmark-2026-08-19.md): context, tools/file workflows, replay, restart continuation.
- [Native handoff](prime-native-agent-session-handoff-2026-08-19.md): discovery, transcript projection, exact native resume routing.
- [Session isolation](prime-session-isolation-2026-08-19.md): session-tagged events and thread-local routing.
- [Renderer isolation](prime-renderer-isolation-regression-2026-08-19.md): clear stale buffers, guard late hydration, rapid navigation/replay coverage.
- [Visible-message counts](prime-message-count-fix-2026-08-19.md): consistent list/transcript text projection.
- [Session integrity](session-integrity-fix-2026-08-19.md): transcript and project correctness follow-up.
- [Stress validation](session-stress-validation-2026-08-19.md): recorded lifecycle/isolation stress results.

These reports contain historical live observations. They have not been rerun against production during repository maintenance.

## 5. Projects, lifecycle, and interactions

- [Refresh/project creation](session-refresh-project-create-2026-08-19.md): explicit refresh, project form, registry exposure, cwd assignment.
- [Session/project management](session-project-management-2026-08-19.md): attach, move, detach, preserved folders on registry deletion.
- [Stabilization audit](stabilization-code-audit.md) and [validation](stabilization-validation-2026-08-19.md): atomic deletion guards, tombstones, active JSONL branches, compensation, refresh generations, update endpoints.
- [Composer/copy](composer-shortcuts-copy-2026-08-19.md): per-thread prompt recall, mode shortcuts, platform hints, IPC clipboard.
- [MainPC deployment record](mainpc-isolation-deployment-2026-08-19.md): historical package parity and runtime checks; not an instruction to redeploy.

A separate historical session cleanup report exists locally. Session deletion inventories, transcript backups, and operational data are not release payloads. No cleanup operation was repeated in this pass.

## 6. Additional backend work present locally

Source/test inventory includes runtime selection, Pi native history and batch deletion, agent/model ownership, resource probing and read-only inspection, Prime skills, event streams, graceful shutdown, echo API, Telegram polling/reliability, and terminal behavior. See `backend/tests/` for the current fixture suite rather than assuming old reports' smaller test counts are current.

## 7. Prime client follow-up cycles

Sibling `archon-desktop-prime-latest/` contains these records:

- `CYCLE2-HANDOFF.md`: session-ID fallback edge case.
- `CYCLE3-HANDOFF.md`: repeated-prompt mapping stress.
- `CYCLE4-HANDOFF.md`: build/typecheck and cross-session checks; historical TSX loader failure.
- `SECURITY-FIX-HANDOFF.md`: plaintext transport restriction and boundary regression.
- `PERF-FIX-HANDOFF.md`: animation-frame terminal batching, bounded tail, disposal.
- `HYGIENE-FIX-HANDOFF.md`: whitespace correction.
- `LATEST-CYCLE.md`: that cycle's limited conclusions, not a global release certification.

Current Prime tests ran successfully in this maintenance pass; the historical loader failure was not reproduced. No speculative runtime fix was applied for it.

## 8. Repository maintenance

The September 8 pass adds discoverable component READMEs, separate version-line and installation inventory, changelog, contribution/release guidance, safer ignore patterns, isolated backend tests, and offline main-repository CI. It repairs the Prime wrapper's missing-backend setup and version drift with failing-first regression tests.

After the owner selected AbdullahPC as the baseline, authorized read-only inspection identified the exact installed unified-refresh artifact. The follow-up imported its editable refresh component and patch recipe, proved byte-identical final-stage reconstruction, and aligned the repository wrapper/current-kit metadata and backend source desktop-version default to 0.3.0. No installed app or live update configuration was changed.

See [repository status](repository-status.md) for fresh checks, caveats, and what still blocks publication. Older README snapshots, design references, and release evidence are deliberately not rewritten as though newly validated.
