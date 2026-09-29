# Release checklist

A source commit, candidate ASAR, installed app, and published release are separate artifacts. The official Desktop baseline is v0.3.0.

## Verify source

- Keep the active code in `current/` and the shared service in `backend/`.
- Keep the official frozen input and expected hashes unchanged.
- Exclude generated ASARs, dependency directories, credentials, environment files, runtime data, and private screenshots.
- Run `npm test`, `npm run test:backend`, and `git diff --check`.
- When the private parent is available, build a fresh candidate and compare its checksum with the intended installed payload.

## Check the app

Use an isolated profile for native Electron checks. Exercise connection authentication, project/session navigation, the IDE explorer and save flow, Browser links and server previews (`localhost` links from a server session), the Git tab (stage, commit, push, diff review and sending comments to the agent), and read-only session/project sharing. The preview at `127.0.0.1:4318` is useful for fixture behavior but does not certify native Electron compositing, live agents, or two-PC routing.

## Package and publish

Record the source commit, package version, architecture, and SHA-256. Review the staged file list before committing. Installation, update-feed changes, service restarts, release uploads, tags, and distribution to another PC are separate deliberate actions. Check for active work before restarting a backend worker.

See the [v0.3.0 baseline](releases/v0.3.0.md), [candidate ledger](releases/v0.3.0-candidate.md), and [publication record](publication.md) for the current identities and limits.
