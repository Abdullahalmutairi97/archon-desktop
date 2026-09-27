# Archon Desktop

Archon Desktop is a Linux app for working with Prime, Pi, and Codex. The official frozen release remains **v0.3.0**. The repository also includes a separate authored reconstruction build, the shared backend, tests, and server deployment files.

## Use the app

- **Projects and sessions:** organize agent work and open a session from the project list.
- **IDE:** inspect agent-written files and snippets, switch tabs, edit, copy, reload, and save with `Ctrl/⌘+S`.
- **Browser:** open web links and local previews from agent replies.
- **Share:** send a reviewed, read-only session or project snapshot to a friend with PeerJS or an offline snapshot code. Sharing does not change the backend, sync files, or grant agent control.

To connect an agent, open **Settings → Connection**, enter the server URL and device token, test the connection, then choose the agent and model in **Settings → Agents & models**. Codex runs locally on the machine where its CLI is installed; it does not require a backend change. Tailscale can provide private network routing, but each app still needs its own valid device token.

## Repository layout

Implementation work is tracked in the [phased roadmap](docs/roadmap/README.md). Each phase records its dependencies, acceptance checks and publication status; completed source increments are published as pull requests for review.

| Path | Purpose |
| --- | --- |
| `desktop/` | Authored Electron/React reconstruction source, synthetic reference shell and pure domain models |
| `current/` | Active v0.3.0 final-stage kit, Browser/IDE/collaboration patches, tests, and preview |
| `backend/` | Shared FastAPI/SQLite service and fixture tests |
| `deploy/` | Backend service template and server installer |
| `scripts/` | Backend test entrypoint and optional live soak utility |
| `docs/` | Architecture, security, release, and verification notes |

## Authored source build

Use the pinned Node version in `.node-version`. This reconstruction build does **not** require the private ASAR:

```bash
npm run desktop:setup
npm run desktop:typecheck
npm run desktop:test
npm run desktop:build
npm run desktop:start
npm run desktop:preview
```

The normal workspace views use synthetic data. P2B.1 adds a validated preload bridge and main-process read-only backend transport; P2C.1 exposes explicit readiness and returned list lengths in a Connection view, and P2C.2 adds a separate read-only Server data route. Capped session/task lists are not totals. No live provider, filesystem or terminal is connected to the workspace UI. The source build has a separate reconstruction identity and leaves the official app/profile unchanged. See [the source-build guide](desktop/README.md) for outputs, provenance and remaining native/parity gates.

## Frozen kit setup and checks

Requires Linux, Node.js 22.12+, npm, and the verified v0.3.0 parent ASAR. The parent is a private release input and is intentionally not stored in Git.

```bash
npm run setup
export ARCHON_V030_ASAR=/absolute/path/to/app-v0.3.0-unified-refresh.asar
npm test
npm run test:backend
npm run build:candidate -- "$ARCHON_V030_ASAR" /tmp/archon-v030-candidate.asar
```

The candidate builder checks the input archive, applies guarded patches, bundles the pinned PeerJS client, and writes an ASAR without installing or restarting anything. The disposable preview is available with:

```bash
node current/testing/preview.cjs "$ARCHON_V030_ASAR"
```

Then open `http://127.0.0.1:4318`. Preview data is synthetic; do not enter real tokens. See the [current kit guide](current/README.md), [candidate ledger](docs/releases/v0.3.0-candidate.md), [release checklist](docs/releases.md), and [changelog](CHANGELOG.md).

The verified frozen input SHA-256 is `36d3ae03bd6b20c4e9ea5fc690461ef972b16eb0c9433bfb1305daeb068e549b`. The MiniPC candidate built from this repository was checked against its installed app payload after the audit.
