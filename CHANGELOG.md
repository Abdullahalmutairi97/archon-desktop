# Changelog

**Official baseline: v0.3.0, defined by the current build on AbdullahPC.** All other Desktop builds are legacy, even when their original numeric labels are higher. Historical validation is not a fresh test result.

## v0.3.0 — AbdullahPC baseline (designation confirmed 2026-09-08)

- The owner selected the current AbdullahPC installation as the authoritative build.
- Prior 0.3.1, 0.4.x, 0.5.0, 0.6.1, and 1.0.0 Desktop labels are legacy identifiers, not subsequent official releases.
- Authorized read-only inspection confirmed the installed package already declares 0.3.0 and matches the saved **unified-refresh** archive exactly.
- Imported its exact refresh component and six guarded substitutions into `current/`, with a portable reconstruction recipe, pinned packer, baseline manifest, and tests.
- Fresh reconstruction is byte-identical to AbdullahPC: SHA-256 `36d3ae03bd6b20c4e9ea5fc690461ef972b16eb0c9433bfb1305daeb068e549b`.
- Root/current package metadata and backend source desktop-version default now identify 0.3.0. Legacy source package labels, installed applications, and live update configuration remain untouched.
- Reconstruction requires the frozen parent archive; full original TypeScript-source recovery and GitHub publication remain separate work.

See the [baseline record](docs/releases/v0.3.0.md), [legacy inventory](docs/versions.md), and [work history](docs/work-history.md). Older feature records describe their original scope and do not replace fresh verification.

## Unreleased — repository maintenance (2026-09-10)

### v0.3.0 candidate: Browser, IDE, sharing, and readiness

- Added session-scoped agent-code presentation and file/browser links in the verified v0.3.0 renderer.
- Added IDE explorer, tabs, line numbers, copy/reload/save, Ctrl+S, resizing/expansion, terminal access, draft preservation, dirty-close confirmation, read-only safeguards, and optimistic conflict detection.
- Reworked initial collaboration prototype into reviewed, read-only session/project snapshots. Bundled PeerJS 1.5.4 locally, allowed its specific signaling socket, added portable codes, validation, timeouts, cleanup, and Stop sharing. Removed automatic snapshot export on service failures.
- Restored device-token entry in Connection settings and made Test connection verify authenticated status.
- Added reproducible preview fixtures, model/patch/CSP regression tests, and a candid readiness report. Root `build:candidate` now invokes the current builder.
- Verified 20 current-kit tests and real PeerJS transfer between two fixture clients through computer control. No backend modification, installed-app update, or live-agent certification is implied.
- See the [commit-by-commit ledger](docs/releases/v0.3.0-candidate.md) for all nine implementation commits, including superseded prototypes and legacy work.

### Earlier maintenance and legacy work

- Added the original Browser and compact IDE prototypes in the legacy `desktop/` source before targeting the verified v0.3.0 candidate.
- Replaced stale main/Prime/client landing documentation with component-specific setup and status.
- Added backend/desktop guides, version and installed-copy inventory, work-history index, contribution guidance, release checklist, and verification report.
- Added an isolated backend test entrypoint and offline CI checks for the main repository.
- Excluded private environment backups, history/recovery material, and stray generated bundles from normal Git staging.
- Fixed the separate Prime client's setup scripts, exposed its unit suite through npm, and aligned its wrapper metadata to its existing 0.4.2 app version, with regression tests.
- Preserved prior local source changes, older snapshots, installed applications, and runtime data. No deployment, published release, or source consolidation is implied.

## Legacy main desktop source — original label 1.0.0

- Main Electron/React desktop metadata and local Linux artifacts declare 1.0.0.
- Backend includes Prime/Pi runtime integration, native history handling, per-agent resource discovery, Telegram support, and additional fixture coverage.
- These changes remain in the working tree relative to the recovery snapshot. Exact release date and remote publication have not been verified.

## Legacy Prime client line — original labels 0.4.0 / 0.4.1 / 0.4.2

### Recorded August 19 session and interaction work

- Progressive Prime answer/thinking/tool events, multi-turn continuation, and native session handoff.
- Session-scoped streaming, keyed thread state, replay isolation, and stale hydration guards.
- Correct visible-message counts, branch-aware transcript projection, and per-session submission ordering.
- Sessions refresh, project creation, attach/move/detach, and registry-only project deletion.
- Atomic session deletion guards/tombstones and project-operation compensation.
- Update metadata separated from authenticated artifact download; unavailable legacy event plane disabled in the Prime client.
- Composer prompt recall, mode cycling, reply copy via IPC, and platform-aware shortcut labels.

### Subsequent local follow-ups (undated handoff notes)

- Terminal output buffered by animation frame with bounded retained output and disposal safety.
- SSE cursor/framing/EOF, upload/path/URL/token, and cross-session regression tests.
- Removed private-LAN plaintext bearer transport allowance in the Prime client.
- Additional event/session routing and repeated-prompt stress coverage.

Not every change has an independently recorded version assignment. Do not attribute all August work to an invented patch release.

## Legacy Settings/Sessions snapshot — original label 0.3.0

- Promoted approved Settings/Sessions preview, preserving production preferences.
- Window/scale fitting, bounded bench, compact tabs, and narrow-screen fixes.
- Classic Sessions table, Prime/Pi/source filtering, selection, and confirmed native-history deletion.
- Real per-agent Skills/MCP inventory and shared refresh controls.
- Retained original, refinement, and rollback artifacts with local validation records.

## Other legacy provenance

- **0.2.0 desktop:** prior installation retained in 0.3.0 rollback documentation.
- **0.3.1 wrapper/spec:** standalone client generation with server-owned work, themes, and editing workspaces.
- **0.6.1 main line:** recorded by `17574cd` (2026-07-26); recovery snapshot `c70e43b` followed on August 8.

See [work history](docs/work-history.md) for the source notes rather than treating this reconstruction as a complete release ledger.
