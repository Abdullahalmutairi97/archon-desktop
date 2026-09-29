# Archon Desktop v0.3.0 kit

`current/` is the active final-stage reconstruction kit for the verified v0.3.0 app. It keeps the existing layout and adds the Browser result links, server previews, IDE, and read-only project/session sharing used by the candidate build.

## Included

- `baseline.json` — official version, archive/parent hashes, and packaged-file guards.
- `refresh.js` and `replacements.json` — the original verified refresh component and substitutions.
- `candidate.cjs` — guarded candidate builder with IDE, preview, connection, and collaboration patches.
- `ide-model.cjs` / `ide-renderer.js` — file extraction, explorer, tabs, line numbers, editing, save/reload/copy, and terminal access.
- `collab-model.cjs` / `collab-renderer.js` — reviewed PeerJS invites and offline snapshot codes for read-only sharing.
- `preview-renderer.js` — Browser routing of loopback URLs through the backend preview gateway.
- `git-model.cjs` / `git-renderer.js` — the Git workbench tab: status, stage/commit, branches, fetch/push, and the diff and review viewer.
- `runtime-renderer.js` / `runtime-patch.cjs` — OpenCode beside Prime and Pi: agent cards, per-agent model lists, dispatch, labels and the session filter.
- `harness-renderer.js` / `harness-patch.cjs` — Settings → Agent harnesses, and turned-off agents greyed out in Agents & models.
- `main-ops-patch.cjs` — main-process operations for previews and Git, keeping the server's error detail.
- `testing/` and `tests/` — disposable preview, audits, and regression coverage.

## Test and build

From the repository root:

```bash
npm run setup
export ARCHON_V030_ASAR=/absolute/path/to/app-v0.3.0-unified-refresh.asar
npm test
npm run build:candidate -- "$ARCHON_V030_ASAR" /tmp/archon-v030-candidate.asar
```

The official frozen input must have SHA-256 `36d3ae03bd6b20c4e9ea5fc690461ef972b16eb0c9433bfb1305daeb068e549b`. The builder refuses a wrong parent or an existing output, validates the patched renderer, and never installs or restarts the app. A clone needs that private parent archive before it can reconstruct the candidate.

Run the disposable preview with:

```bash
node current/testing/preview.cjs "$ARCHON_V030_ASAR"
```

Open `http://127.0.0.1:4318`. It uses synthetic sessions, files, and projects. Do not enter production credentials.

## Runtime behavior

The IDE presents code and file paths found in the selected session transcript. Files can be opened, edited, copied, reloaded, and saved through the existing desktop bridge. Dirty tabs ask before closing; binary, failed, loading, or truncated reads remain read-only. Drafts last for the app window and are not persisted across restarts.

Agents run on the server, so a `localhost` URL in their replies means the server's loopback. The Browser sends plain-HTTP loopback navigations (`localhost`, `127.0.0.1`, `0.0.0.0`, `[::1]`, including a bare `localhost:PORT` typed in the address bar) to `POST /api/previews`, then loads the returned private origin. The address bar and Ask Archon keep showing the `localhost` URL; Open in system browser carries the preview secret so the page loads there too. If nothing is listening, the panel explains why instead of loading this PC's own localhost.

OpenCode is a third server agent. Choosing it in Agents & models shows only OpenCode models, and each agent keeps its own model choice. Replies always go to the agent that owns the session.

The Git tab (`Ctrl+4`) opens the repository containing the session's working folder; any folder under the Archon root can be typed instead. Changes lists conflicts, staged, and unstaged/untracked files with stage, unstage and discard (discard asks first). Commit uses the staged files. The branch menu switches or creates branches; Fetch updates remotes; Push asks first and sets the upstream for a new branch. History shows commits, and Compare reviews `base...HEAD`, defaulting to the remote's default branch. Diffs render unified or side by side. Hover a line and press + to comment; Send to agent posts all comments to the open session as one reply, or copies them when no session is open. Comments stay with the repository until sent or cleared, but are not saved across app restarts. Secret-bearing files show only that they changed. The testing harness sends preview and Git operations to a real backend when `ARCHON_HARNESS_API` and `ARCHON_HARNESS_TOKEN` are set.

Sharing lets the user select a session or project, review the snapshot, and create either a PeerJS invite or an explicit offline code. Project snapshots include the sessions currently listed by the client and their fetched history. Shared content is read-only; no files, credentials, tool/thinking records, live editing, agent control, or durable team membership are transferred. PeerJS uses the bundled 1.5.4 client and its approved signaling socket; the backend is unchanged.

The verified frozen archive is the official v0.3.0 baseline. A candidate is a rebuilt app payload, not a complete Electron installer. See the [baseline record](../docs/releases/v0.3.0.md), [candidate ledger](../docs/releases/v0.3.0-candidate.md), and [readiness audit](testing/readiness-audit.md).
