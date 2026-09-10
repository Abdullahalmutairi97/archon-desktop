# Archon Desktop

A Linux app for working with your Prime and Pi agents. Organize projects and conversations, inspect agent-written code, and open results in a browser panel.

**Current version: v0.3.0.** The latest IDE, browser, sharing, and connection improvements are in the candidate build. They are merged into this repository but have not been installed or released as a new desktop package.

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

Your agents must already be configured on the server. Tailscale can provide a private connection between your PCs; you still need the Archon device token. Keep tokens out of Git and chat. See [backend setup](backend/README.md) if you need to configure a server.

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

The candidate passed 20 tests and a two-client sharing test. Native desktop installation, live agents, and connections between separate PCs still need verification. See the [readiness report](current/testing/readiness-audit.md).

## More details

- [Build guide](current/README.md) — current v0.3.0 code and reconstruction steps.
- [Change history](docs/releases/v0.3.0-candidate.md) — all feature commits and verification steps.
- [Changelog](CHANGELOG.md) — current and historical changes.
- [Release checklist](docs/releases.md) — packaging, installation, and rollback.
- [Contributing](CONTRIBUTING.md) — development guidelines.

Work on the current app in `current/`. The `desktop/` folder is legacy source, even though its package has a higher version number.
