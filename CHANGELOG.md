# Changelog

## Unreleased

- Removed the local Codex runtime: its desktop adapter, main-process and renderer patches, and tests. Prime and Pi are the only agents; the `openai-codex` model provider Prime uses is unchanged.
- Added server previews. `localhost` links from agent replies (and `localhost:PORT` typed in the Browser) open the server's dev server through a new authenticated backend gateway, `/api/previews`, with its own origin per port so root-relative assets, redirects and hot-reload WebSockets work.

- Added the agent harness manager (Settings → Agent harnesses, `/api/harnesses`). It shows each harness's install state, version, signed-in provider names, usage and path. Turning a harness off makes the server refuse new and continued work for it. It also sets OpenCode's default model, checks npm for newer versions, and updates Pi or OpenCode with `npm install -g` after confirmation (refused while that harness has running work).
- Added OpenCode as a third agent on the server. The backend runs `opencode run --format json`, stores each turn in Archon's session history and continues the same OpenCode session on replies. Approval modes are enforced by OpenCode: Auto passes `--auto`, Approve makes edits and shell commands ask (which non-interactive runs reject), and Plan/chat use OpenCode's read-only plan agent.
- Fixed the working folder for tasks started without a project: a relative folder such as `.` now resolves inside the Archon root for Prime, Pi and OpenCode, instead of the backend service's own directory.
- Added Git integration and code review. A new Git workbench tab shows status and history, stages, commits, switches branches, fetches and pushes through new `/api/git/*` routes. Its diff viewer covers working-tree, staged, commit and branch-against-base changes in unified or split view, with line comments that can be sent to the session's agent. Secret-bearing files never show content.

## Repository cleanup

- Removed the unused legacy desktop source tree, design/reference archives, version-specific launchers, and dated maintenance reports.
- Kept the active v0.3.0 kit, shared backend, server installer, tests, live soak utility, and release documentation.
- Removed the obsolete legacy test command and CI job; the root checks now cover the current kit and backend only.
- Confirmed that the MiniPC installed candidate still matches a clean build from `main`.

## v0.3.0 candidate

- Added Browser result links, an IDE for agent-written code, local Codex sessions, authenticated connection testing, and read-only PeerJS session/project sharing.
- Added guarded ASAR reconstruction, disposable preview fixtures, and regression coverage for patching, CSP, collaboration, code extraction, and safe file editing.
- The backend API and database were not changed for collaboration.

## v0.3.0 baseline

- The verified frozen v0.3.0 archive remains the official release input.
- Official frozen input SHA-256: `36d3ae03bd6b20c4e9ea5fc690461ef972b16eb0c9433bfb1305daeb068e549b`.
- The Python backend keeps its independent package version (`0.2.0`).

See the [baseline record](docs/releases/v0.3.0.md), [candidate ledger](docs/releases/v0.3.0-candidate.md), and [release checklist](docs/releases.md).
