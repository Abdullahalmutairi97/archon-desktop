# Release checklist

A build, an installed application, a Git commit, and a published release are different things.

**The release choice is settled: AbdullahPC's current build is official v0.3.0.** Other Desktop builds are legacy regardless of their old numbers. See the [baseline record](releases/v0.3.0.md).

## 1. Reconcile the repository

- Authenticate with the existing GitHub remote through an approved local flow; never paste tokens into chat.
- Fetch remote refs and inspect their history. The main and Prime checkouts target the same remote but have different histories/layouts.
- Preserve the verified AbdullahPC archive identity and `current/` final-stage recipe. The launcher/archive inspection and exact reconstruction are complete; full original-source consolidation remains separate work. Preserve unmatched source lines as legacy. Never force-push a snapshot over unknown remote history.
- Review all existing local changes; maintenance documentation does not certify unrelated code.
- Review source, scripts, deployment notes, design/reference assets, and license rights for publication. Local operational reports can contain private host/path/session information even when `.env` is ignored.
- Stage an explicit reviewed source/documentation list. Exclude runtime data, archives, screenshots with live data, credentials, and binaries.

## 2. Establish a release version

- Keep the official baseline at **0.3.0**, already present in the installed archive, root/current manifests, and backend source desktop-version default. Do not choose 1.0.0 or 0.4.x merely because a legacy number is larger. See [versions](versions.md).
- Keep that client's package, lockfile root metadata, workspace wrapper, and displayed release label aligned. Do not label every old source tree 0.3.0.
- Preserve legacy artifact labels/checksums for traceability. Validate update behavior for devices carrying old higher numeric labels before distributing the reset; numeric comparison alone cannot define the authoritative baseline.
- Configure backend desktop-update metadata to the actual chosen artifact, version, and architecture only as part of an approved deployment.
- Do not bump the Python backend package or a different desktop line just to make numbers match.
- Move approved changes from Unreleased to a dated release entry, recording the source commit.

## 3. Verify

- Run `npm test` for the current patch/metadata suite and `npm run test:backend` for backend fixtures. Supply the verified parent for exact ASAR reconstruction via `npm run build -- <parent> <new-output>`.
- Legacy desktop tests/typecheck/build remain regression checks only, not verification that the legacy source produces v0.3.0.
- Run isolated Electron smoke/screenshots, including connection, navigation, settings persistence, transcript isolation, and relevant controls.
- Exercise clean install, update, and rollback on the intended architecture with isolated preferences.
- Run separately approved live checks if needed; record exactly what was changed and clean up only test-owned data.
- Record warnings, known limitations, and commands. Do not copy old "all green" claims.

## 4. Package and publish — approval required

- Build the approved client and architecture; record SHA-256 checksums and source commit.
- Verify the packaged archive's version and key source behavior, not just its filename.
- Preserve the installed application and profile recovery plan before any update.
- Obtain approval for commit/push, tag, release upload, installation, and service restart as applicable.
- Before restarting a worker, check the configured database for active work; do not interrupt sessions.
- Upload release artifacts separately from Git source. No release was published by the repository-maintenance pass.

## Current blockers

For the September 10 candidate, see the [change ledger](releases/v0.3.0-candidate.md) and [readiness audit](../current/testing/readiness-audit.md). Source-branch publication is owner-requested; this does not authorize installation or a release. Real PeerJS transfer has been verified between local fixture clients, but native packaging, two-PC connectivity, live agent work, and updater behavior still need verification.

GitHub authentication/history, full original-source consolidation, distribution of approved frozen release inputs, review of pre-existing source/private documents, graphical/full-Electron-package checks, updater-reset behavior, and publication approval remain outstanding. AbdullahPC inspection and exact final-stage archive reconstruction are complete. The MiniPC's 1.0.0 labels are legacy evidence, not grounds to supersede official v0.3.0.
