# Archon Desktop

A private Linux desktop for durable agent work. **The server owns the work:** accepted tasks, sessions, and ordered event history survive closing the desktop window.

Electron + React + TypeScript provide the desktop; FastAPI + SQLite provide the backend. Runtime selection and native-history support are server-owned. Current backend sources include Prime and Pi integration alongside legacy Hermes compatibility; capabilities differ between client generations.

## Official version: v0.3.0

**The current build on AbdullahPC is the source of truth and is designated v0.3.0.** All other Desktop builds are **legacy**, even if their old labels say 0.4.x, 0.6.1, or 1.0.0. Those numbers are historical identifiers, not newer releases.

Read-only inspection confirmed that AbdullahPC already runs **0.3.0**. Its entire archive matches the saved **unified-refresh** build, and the new [`current/` reconstruction kit](current/README.md) reproduces it byte-for-byte. See the [verified baseline record](docs/releases/v0.3.0.md).

**Source scope:** this is the verified final-stage patch/recipe, requiring a frozen parent archive—not yet a full original TypeScript-source rebuild. The legacy `desktop/` tree is not the current app's source.

| Component | Status | Location |
| --- | --- | --- |
| AbdullahPC installed Desktop | **Verified v0.3.0 unified-refresh baseline** | AbdullahPC |
| Current reconstruction kit | **0.3.0**, byte-identical ASAR reconstruction | [`current/`](current/README.md) |
| Local main desktop | **Legacy**, original package label 1.0.0 | [`desktop/`](desktop/README.md) |
| Separate Prime desktop | **Legacy**, original package label 0.4.2 | Sibling `archon-desktop-prime-latest/app/` |
| Python backend package | Independent package version 0.2.0; not part of the Desktop reset | [`backend/`](backend/README.md) |

The MiniPC's installed archives labeled 1.0.0 are legacy and do not identify the current release. GitHub access is now configured for the owner-authorized source sync; see the [branch map and pre-push checks](docs/publication.md). No release tag or binary publication is implied.

Start with the [version inventory](docs/versions.md), [changelog](CHANGELOG.md), [work history](docs/work-history.md), and [current verification report](docs/repository-status.md). Older deployment reports describe their own point in time, not today's installed state.

## Latest work: v0.3.0 candidate (2026-09-10)

The Browser, IDE, collaboration, and connection fixes are available in the **candidate builder in `current/`**. They have not replaced the official installed archive. The layout remains based on v0.3.0; the first two experimental commits also preserve older `desktop/` implementations as legacy history.

| Candidate feature | What works | Limits |
| --- | --- | --- |
| Browser panel | Open links from agent replies, URL navigation and existing browser controls | Native Electron compositing still needs release testing |
| IDE panel | Session code, referenced files, explorer, tabs, resize/expand, copy, reload, save, Ctrl+S, terminal tab | Snippets are read-only; drafts last for the window lifetime; save conflict check is optimistic |
| Collaboration | Select/review a session or project's listed sessions; share through bundled PeerJS; read received conversations/code; stop sharing | Read-only snapshots, not live editing, file sync, remote agent control, or team accounts |
| Connection | Device-token entry through the existing write-only bridge; authenticated connection test | Actual agent credentials and live agent execution remain operator setup |

Collaboration changes only the client. It uses third-party [PeerJS](https://peerjs.com/) signaling and WebRTC; a separate explicit snapshot-code export works without signaling. Paste sharing codes into the other client's **Share** dialog. Keep the host app open for peer transfers. Tailscale can provide private network reachability, but does not grant Archon application permissions or replace the device token.

**Verification:** 20 current-kit tests passed with the actual baseline archive supplied. Computer-control testing transferred a two-session project between two clients using the real PeerJS service, displayed both conversations, and verified Stop sharing. IDE save, reply-to-browser navigation, and connection settings were also checked with fixture data. Two-PC routing, native Electron features, and real agent execution remain unverified. The local preview is disposable: do not enter real tokens or use it for actual work.

See the [complete change/commit ledger and reproduction steps](docs/releases/v0.3.0-candidate.md), [readiness audit](current/testing/readiness-audit.md), and [candidate implementation guide](current/README.md).

### Build and preview the candidate

From the repository root, using Node.js 22.12+:

```bash
npm run setup
# The official unified-refresh ASAR is a private release input, not in Git.
export ARCHON_V030_ASAR=/absolute/path/to/app-v0.3.0-unified-refresh.asar
npm test
npm run build:candidate -- "$ARCHON_V030_ASAR" /new/output/candidate.asar
node current/testing/preview.cjs "$ARCHON_V030_ASAR"
```

Open `http://127.0.0.1:4318` for the fixture preview. The builder refuses existing output files and a wrong baseline hash. An ASAR is an application payload, not an installer. Follow the [release checklist](docs/releases.md) for native packaging, installation, and rollback checks.

## Existing app/backend capabilities

- Server-owned task queue, cancellation, quota retry, and ordered SSE replay.
- Sessions, transcripts, projects, and explicit session-to-project assignments.
- Native agent history and runtime-specific resume/deletion behavior.
- Agent/model selection and per-agent Skills/MCP resource inventory.
- Files, persistent terminal sessions, logs, backups, cron, and system status.
- Optional Telegram integration and voice services, subject to server configuration.
- Device-local appearance settings, themes, and English/Arabic presentation.

The separate Prime client also contains design, diagram, and office editing workspaces. Do not assume every feature exists in both desktop implementations. Runtime ownership, confirmations, and supported operations must be respected by each client.

## Development and reconstruction

Requirements: Linux, **Node.js 22.12+** (22 LTS recommended), npm, and **Python 3.12+** for the backend. Live agent work additionally requires the selected runtime to be configured privately.

```bash
# Current v0.3.0 kit and offline checks
npm run setup
npm test

# Reconstruct the exact current archive; requires the verified frozen parent
npm run build -- /path/to/app-v0.3.0-resources.asar /new/output/app.asar

# Backend development environment
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -e './backend[dev]'
npm run test:backend
```

The [current kit guide](current/README.md) explains the required input and source limitations. No install/start command is provided for the baseline kit: it reconstructs an ASAR, not a complete Electron distribution. For backend setup see [backend/README.md](backend/README.md); for the older source's development commands see [legacy desktop](desktop/README.md). Do not reuse production profiles for tests.

## Connection and safety

- Default source configuration binds to `127.0.0.1:8787`. Deployed hosts and ports are configurable; there is no universal production endpoint.
- Set a non-empty `ARCHON_DESKTOP_AUTH_TOKEN` privately before exposing a backend to another device. An empty token disables API authentication in the current implementation.
- Use loopback, a private tailnet, or appropriately secured HTTPS; never expose the service on a public interface by default.
- Provider credentials stay with the agent runtime. Never commit `.env` files, connection tokens, session transcripts, databases, recovery archives, or private screenshots.
- Backups/restores, session deletion, cron changes, deployment, and service restarts require explicit operator approval. Tests must use fixtures, not production data.
- Do not start a second app against the same preferences/profile merely to test it.

See [security](docs/security.md), [architecture](docs/architecture.md), and [migration](docs/migration.md). Existing architecture/design documents include historical Hermes-era details; current code and the component guides explain the current entrypoints.

## Repository map

```text
current/       Verified v0.3.0 final-stage source/recipe, manifest, and tests
backend/       FastAPI service, runners, SQLite storage, fixture tests
desktop/       Legacy Electron/React desktop and regression tests
deploy/        Operator-reviewed deployment templates and scripts
docs/          Architecture, version inventory, work history, validation records
scripts/       Local verification and maintenance helpers
reference/     Design reference material; not a release payload
```

## Packaging and contributions

`npm run build -- <parent.asar> <new-output.asar>` reconstructs the verified current application payload. The old `desktop` packaging commands build **legacy** AppImage/deb packages, not official v0.3.0. See the [release checklist](docs/releases.md) before packaging a full distribution, tagging, deploying, or publishing.

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) before changing code. Preserve existing UI and runtime ownership. Report unit tests, builds, fixture smoke tests, and live checks separately; never reuse historical results as current verification.
