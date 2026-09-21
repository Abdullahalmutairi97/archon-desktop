# P2 — Maintainable source build and UI parity

**Status:** not started; source/input provenance gap. **Dependencies:** matching authored source/assets or a documented bounded same-stack reconstruction route. Can run alongside P1; gates new P3/P4 desktop delivery.

## Scope and preservation contract

A fresh contributor must build the actual Linux desktop from Git source and pinned public dependencies. Preserve Electron/React, themes, mark, typography, sidebar/workbench placement, shortcuts, preferences, local/remote session distinction and existing behaviors. Keep the frozen reconstruction kit as a comparison/recovery reference. Historical legacy source is not the v0.3.0 release source.

## Checklist

- [ ] Inventory matching authored main/preload/renderer source, assets, build notes, source maps and any existing approved IDE decision. Record provenance and missing modules without relabeling legacy code.
- [ ] If the owner-provided parent ASAR is available, verify SHA-256 `36d3ae03bd6b20c4e9ea5fc690461ef972b16eb0c9433bfb1305daeb068e549b` before comparison. Never change expected hashes to hide a mismatch.
- [ ] Recover matching source or document the missing-shell reconstruction scope, effort and parity evidence before executing that route. A deminified bundle alone does not complete source recovery.
- [ ] Establish an authored desktop tree and import reusable candidate logic: IDE document/artifact model, Codex adapter, snapshot validation, connection lifecycle and queue-state behavior.
- [ ] Pin Node/Electron/dependencies/lockfiles and CI image; create versioned Linux installer/package manifests without private ASAR inputs in the normal source build.
- [ ] Define IPC request/response schemas and validate sender/frame identity. Separate privileged shell and untrusted remote views.
- [ ] Add typecheck/unit, native bridge/navigation, visual/layout and isolated-profile native smoke gates. Required artifacts absent from release validation must fail explicitly.
- [ ] Document build, source provenance, third-party license inputs, compatibility and recovery path. Preserve current configuration/data rather than resetting it for a clean demo.

## Validation and exit

- [ ] Two fresh workspaces build versioned installers from source and pinned dependencies; build manifests identify every packaged input.
- [ ] No minified alias/string-replacement anchors remain in the new application build path. The frozen legacy recipe stays available for recovery.
- [ ] Native local/remote session, connection, artifact links, shortcuts, themes and navigation pass parity checks on an isolated profile.
- [ ] Hostile navigation/IPC checks demonstrate the native boundary; fixture-only success is labeled separately.
- [ ] Provenance and package manifest are reviewable; documented source build and native gates pass before this phase is marked complete.

Known blockers: matching authored source, design assets, the private baseline archive and external historical IDE decisions were unavailable during the audit. Inventory can proceed without them; complete parity cannot be claimed without appropriate evidence. Do not overwrite an installed app or restart a service as part of source inventory.

Publish focused PRs under the [roadmap workflow](README.md). No release/deployment is implied by source recovery.
