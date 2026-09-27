# Phase 2C.1 — Read-only connection view

This increment makes the trusted P2B.1 backend bridge visible in the authored desktop reconstruction. The user must explicitly enter a server address and device token. The Electron view shows authenticated readiness, whether dispatch is ready, returned project/session/task row counts and the event cursor. Session and task API lists are capped, so these row counts are not total counts. Those values come only from the fixed read-only bridge operations; chat, files, projects, sessions, tasks and tools elsewhere in the workspace remain labeled fixtures.

The token field clears when submitted. The bridge retains it in main-process memory for this increment, so it must be entered again after a restart. The renderer does not save it to preferences or local storage. Browser preview has no preload bridge and keeps the connection controls disabled.

## Validation boundary

Focused renderer tests cover the browser-unavailable state, the explicit route, token-field clearing, capped returned rows, failed-refresh status and fake-bridge read-only data. The integrated desktop check passed type checking, **69 tests in 15 files**, the license inventory check and source build. The build manifest recorded **61 inputs and 5 outputs** with matching sizes and SHA-256 hashes. No real server, credential, installed profile or native Electron window was used for this increment. Native hostile-frame, keyring and package qualification remain open.

## Next steps

Phase 2B.2 adds injected profile and protected credential storage; Phase 2B.3 adds owned local Codex identity and approval handling. Later Phase 2C increments bind those capabilities to real workspace views while retaining explicit backend/local scope labels.
