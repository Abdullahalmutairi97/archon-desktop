# Archon Desktop

Archon Desktop is a Linux app for working with Prime, Pi, and OpenCode. The current repository targets **v0.3.0** and includes the release reconstruction kit, the shared backend, tests, and server deployment files.

## Use the app

- **Projects and sessions:** organize agent work and open a session from the project list.
- **IDE:** inspect agent-written files and snippets, switch tabs, edit, copy, reload, and save with `Ctrl/⌘+S`.
- **Agent harnesses:** Settings → Agent harnesses lists Prime, Pi and OpenCode as installed on the server: version, providers each is signed in to (names only), Archon sessions and path. Turn a harness off to stop new and continued work with it, set OpenCode's default model, check for a newer version, and update Pi or OpenCode through npm after confirming.
- **Git:** see the session repository's changes, stage, commit, switch or create branches, fetch and push. Review working-tree changes, any commit, or the whole branch against its base in a unified or split diff, comment on lines, and send the review to the session's agent.
- **Browser:** open web links from agent replies. A `localhost` link (or a typed `localhost:PORT`) opens the dev server running on the server, through the backend's private preview gateway, with hot reload.
- **Share:** send a reviewed, read-only session or project snapshot to a friend with PeerJS or an offline snapshot code. Sharing does not change the backend, sync files, or grant agent control.

To connect an agent, open **Settings → Connection**, enter the server URL and device token, test the connection, then choose the agent and model in **Settings → Agents & models**. OpenCode needs the `opencode` CLI on the server (`npm install -g opencode-ai`); its model list comes from `opencode models`, and each agent remembers its own model. Tailscale can provide private network routing, but each app still needs its own valid device token.

## Repository layout

| Path | Purpose |
| --- | --- |
| `current/` | Active v0.3.0 final-stage kit, Browser/IDE/collaboration patches, tests, and preview |
| `backend/` | Shared FastAPI/SQLite service and fixture tests |
| `deploy/` | Backend service template and server installer |
| `scripts/` | Backend test entrypoint and optional live soak utility |
| `docs/` | Architecture, security, release, and verification notes |

## Setup and checks

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

🏗️ Archon Desktop — Main Features
- [ ] 💻 Full IDE
- [ ] 🖥️ Integrated Terminal
- [ ] 🔄 tmux Integration
- [ ] 🤖 Multi-Agent System
- [ ] 🔌 Agent / Harness Manager
- [ ] 🧩 MCP Manager
- [ ] 🛠️ Skills Manager
- [ ] 👥 Team Collaboration
- [ ] 🔐 Users & Permissions
- [ ] 📁 Project / Workspace Manager
- [ ] 🌿 Git Integration
- [ ] 🌿 Git Worktree Support
- [ ] 🌐 Live App / Website Preview
- [ ] 🧭 Self-Hosted Web App Dashboard
- [ ] 🧑‍💻 Agent ↔ IDE Integration
- [ ] 🧠 Persistent Agent Sessions
- [ ] ⚡ Parallel Agent Execution
- [ ] 📋 Task / Work Coordination
- [ ] 🔍 Code Review & Diff Viewer
- [ ] ▶️ Run / Build / Test Controls
- [ ] 🔑 Secrets & Credentials Manager
- [ ] 🖥️ Local Execution
- [ ] ☁️ Remote / Server Execution
- [ ] 🔄 Persistent Workspace Sessions
- [ ] 🛡️ Agent Permissions & Sandboxing
