# Archon Desktop

A Linux app for working with Prime, Pi, and Codex. Organize projects and conversations, inspect agent-written code, and open results in a browser panel.

**Current version: v0.3.0.** The latest features and fixes are in the candidate build. Use the instructions below to build and preview them.

## What you can do

- Organize agent sessions into projects.
- Read generated code and edit workspace files in the IDE panel.
- Open links from agent replies in the browser panel.
- Share read-only snapshots of sessions and projects with a friend.
- Access agent/model settings, files, terminals, and other services supported by your server.

## Connect your agents

In the candidate desktop app:

1. Open **Settings → Connection**.
2. Enter your Archon server URL and device token, then test the connection.
3. Choose your agent and model in **Settings → Agents & models**.
4. Start a session and select your project.

Prime and Pi must already be configured on the server, with its execution worker running. **Queued** means a task has been accepted but has not started. Tailscale can provide a private connection between your PCs; you still need the Archon device token. See [backend setup](backend/README.md) for server setup.

For **Codex**, install and sign in to the [Codex CLI](https://developers.openai.com/codex/cli/) on the PC running this app. Choose **Codex** in **Settings → Agents & models**, select a model, and create a project. Codex runs locally without changing the Archon backend. Use the IDE to read and edit its files; ask Codex to run project commands. Its projects and sessions stay on that PC. Keep tokens out of Git and chat.

## Share with a friend

Open **Share**, select a session or project, and review the content. Create a peer invite and send the code to your friend. They paste it into **Share → Join a share** in their app. Keep your app open until the transfer finishes.

Sharing uses PeerJS and does not add anything to the current backend. You can also explicitly create a snapshot code for offline sharing. Sharing is **read-only**: it does not sync files, allow live editing, or give your friend control of your agents. Received copies remain readable after you stop sharing.

## Build and try the preview

Requires Linux, Node.js 22.12+, npm, and the official v0.3.0 unified-refresh ASAR. That private release input is not included in Git, so a clone alone cannot build the candidate.

From the repository root:

```bash
npm run setup
export ARCHON_V030_ASAR=/absolute/path/to/app-v0.3.0-unified-refresh.asar
npm test
npm run build:candidate -- "$ARCHON_V030_ASAR" /new/output/candidate.asar
node current/testing/preview.cjs "$ARCHON_V030_ASAR"
```

Open **http://127.0.0.1:4318**. This preview uses test data—do not enter real tokens or use it for actual work. The generated ASAR is an app payload, not an installer.

See the [native desktop audit](current/testing/native-audit-20260912.md) and [earlier fixture audit](current/testing/audit-20260912.md) for tested workflows, fixes, and remaining checks. The preview uses disposable data; it does not verify your live agents or connections between separate PCs.

## More details

- [Build guide](current/README.md) — current v0.3.0 code and reconstruction steps.
- [Change history](docs/releases/v0.3.0-candidate.md) — all feature commits and verification steps.
- [Changelog](CHANGELOG.md) — current and historical changes.
- [Release checklist](docs/releases.md) — packaging, installation, and rollback.
- [Contributing](CONTRIBUTING.md) — development guidelines.

Work on the current app in `current/`. The `desktop/` folder is legacy source, even though its package has a higher version number.
