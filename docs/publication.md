# Repository publication

The active source is the `main` branch of `Abdullahalmutairi97/archon-desktop`. The repository now contains the v0.3.0 kit, shared backend, server deployment files, tests, and focused documentation. Generated ASARs, dependencies, credentials, private profiles, and runtime data remain outside Git.

## Current state

- Local and remote branch: `main` only.
- Latest verified source commit before this cleanup: `69bcf1e` (`Merge verified v0.3.0 desktop audit`).
- Official frozen v0.3.0 input SHA-256: `36d3ae03bd6b20c4e9ea5fc690461ef972b16eb0c9433bfb1305daeb068e549b`.
- MiniPC installed candidate payload verified against a clean build from `main`: `e409eaf57cebf98152d68842f19e98b7e15ab1931e2af38372fa371fe723b856`.
- Collaboration uses bundled PeerJS and does not add backend routes, tables, credentials, or services.

The removed legacy desktop source, design archives, version-specific launchers, and dated maintenance reports were not inputs to the active build or tests. Their history remains available through Git commits; they are no longer part of the working tree.

## Verification commands

```bash
npm run setup
ARCHON_V030_ASAR=/path/to/app-v0.3.0-unified-refresh.asar npm test
npm run test:backend
npm run build:candidate -- /path/to/app-v0.3.0-unified-refresh.asar /tmp/archon-v030-candidate.asar
git diff --check
```

A source publication is separate from packaging or installation. Uploading an ASAR, changing the update feed, restarting a service, or installing on another PC requires its own deliberate release step.
