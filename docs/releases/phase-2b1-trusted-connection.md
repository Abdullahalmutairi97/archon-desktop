# Phase 2B.1 — Trusted connection boundary

This increment adds a finite preload bridge and a main-process connection to a fake or configured Archon backend. The renderer never receives the saved token or a general IPC, URL, filesystem, terminal, or network capability. The connection token remains in main-process memory; protected persistence and native keyring qualification are later gates.

## Scope

- Bind IPC to the exact loaded shell main frame and invalidate it on navigation or replacement.
- Accept only enumerated read operations for readiness, projects, sessions, tasks, and the current event cursor. Validate request and response size and shape. A connection switch advances its generation and aborts stale requests.
- Require an explicit loopback or HTTPS backend URL. Main sends bearer authorization and refuses cross-origin redirects, including token-bearing redirects.
- Expose finite `connection.describe/save/disconnect/probe` and `api.invoke` preload methods. Do not expose raw Electron APIs or streams in this increment.
- Keep the renderer's live controls visibly unavailable until Phase 2C binds these operations to application state.

## Validation boundary

Focused tests use fake fetch, fake IPC/frame objects and synthetic tokens. The integrated desktop check passed type checking, **64 tests in 14 files**, the 243-entry license inventory check and the source build. The build manifest has **59 inputs and 5 outputs**, including the new preload bundle; sizes and hashes were rechecked. The exact Vitest pin advanced to 4.1.11 to address the reviewed development-server file-read advisory; npm audit then reported **0 vulnerabilities**. Backend and frozen-kit source are unchanged, so their earlier checks were not repeated. Hosted CI and bounded review are recorded on the pull request.

No real backend, agent, provider, native credential store, installed profile, browser view or release package was exercised in this increment. The existing synthetic browser preview remains a fixture view.

## Remaining Phase 2B gates

Injected profile storage and explicit migration; protected storage/keyring policy; owned local Codex IDs and correlated native approvals; unprivileged browser views and asset routing; event subscription and complete renderer integration. Native hostile-frame and keyring evidence remains a Phase 2D acceptance gate.
