# Current Archon Desktop — v0.3.0

For the complete Browser/IDE/collaboration commit history, final behavior, and step-by-step setup/build/preview workflow, see the [candidate change ledger](../docs/releases/v0.3.0-candidate.md). The reconstruction baseline below and the newer candidate are distinct build targets.

The authoritative build is the installed **AbdullahPC** application. Read-only inspection on 2026-09-08 confirmed its package already says **0.3.0**, and its entire ASAR matches the saved unified-refresh release:

```text
36d3ae03bd6b20c4e9ea5fc690461ef972b16eb0c9433bfb1305daeb068e549b
```

This directory is the repository's **current release reconstruction kit**, not another desktop redesign. The older `desktop/` implementation and other 0.4.x/0.6.1/1.0.0 trees are legacy, regardless of their numeric labels.

## What is included

- `baseline.json`: authoritative version, whole-archive checksum, parent checksum, key packaged-file hashes, and provenance.
- `refresh.js`: the exact editable shared refresh component shipped on AbdullahPC.
- `replacements.json`: the six guarded substitutions extracted from the original release recipe, covering seven views.
- `build.cjs`: portable final-stage reconstruction with hash/patch guards and no deployment actions.
- Tests: the original component assertions plus metadata, reversibility, wrong-parent, missing/duplicate-target, and double-patch checks.
- A pinned ASAR packer and npm lockfile.

**Scope limitation:** the shipped app was refined from frozen packaged inputs. This kit reproduces the final release from its verified parent; it is **not a full TypeScript-source rebuild**. The underlying source lineage and earlier UI override stages still need consolidation for a clean from-source build. Do not claim the legacy `desktop/` tree produces this app.

## Install tools and test

From the repository root with Node.js 22 LTS:

```bash
npm run setup
npm test
```

The offline suite does not start Electron, contact a backend, or read preferences. ASAR 3.4.1 is pinned to reproduce the historical archive; npm reports deprecated transitive `glob`/`inflight` packages. Changing packer versions requires a fresh reproducibility check.

## Reconstruct the verified archive

Obtain the original **agent-resources parent** from the operator's saved release files. It is a release input, not a credential/profile backup, and is deliberately not committed as a large binary.

Expected parent SHA-256:

```text
0e4564634d15e8b22de2bd41b517d0778535fa4ccdb1277de5e140e6954e3711
```

On the MiniPC the saved input is `~/projects/archon-desktop-v0.3.0/agent-resources/app-v0.3.0-resources.asar`. That sibling is not included in a Git clone.

```bash
npm run build -- /path/to/app-v0.3.0-resources.asar /new/output/app.asar
```

The recipe validates the parent before extraction, patches only the six exact targets, checks syntax and key files, and requires the final whole-archive SHA-256 to match AbdullahPC. It refuses existing output files and stages work in a temporary directory. A clean clone cannot perform this reconstruction until the verified parent is supplied.

A fresh reconstruction on 2026-09-08 produced the **exact same archive hash** as AbdullahPC. The output was kept outside Git at `/tmp/archon-v030-verified-20260908/app.asar`. No app installation or restart was performed.

## v0.3.0 browser and IDE candidate

The candidate keeps the existing v0.3.0 layout and Browser/Terminal bridge, and adds a resizable IDE with an expandable view, collapsible explorer, file filtering, editor tabs, synchronized line numbers, Copy, Reload, Save, and Ctrl/⌘+S.

The **Agent code** list comes from the selected session's rendered transcript, including fetched history and streamed messages. It includes fenced snippets, linked/inline file paths, structured write/edit tool targets, and apply-patch file targets. Reply file links open in the IDE; web links open in Browser. Snippets are read-only and update while streaming. No demo transcript is used when disconnected or outside a session.

Editor tabs and drafts survive panel changes and session navigation for the lifetime of the app window. Closing a dirty tab or reloading it requires a discard confirmation. Failed, loading, binary and truncated reads cannot be saved. Saving checks for changes on disk first, preserves edits made while the save is running, and reports errors inline. This is an optimistic check using the existing read/write API; it is not an atomic server-side compare-and-swap. Drafts are not persisted across app restarts.

Implementation lives in `ide-model.cjs` (parsing/document behavior) and `ide-renderer.js` (UI integration), injected by the guarded `candidate.cjs` builder. The frozen release recipe and hashes remain unchanged.

Build it from the saved verified release input:

```bash
npm run setup
npm run build:candidate -- \
  /path/to/app-v0.3.0-unified-refresh.asar \
  /new/output/archon-v0.3.0-ide-browser-candidate.asar
```

The candidate builder checks the input archive and v0.3.0 package version, validates the patched renderer syntax, refuses an existing output, and never installs or restarts the app. It is intentionally a candidate artifact because the official v0.3.0 archive remains the authoritative release.

## Editing and future releases

### Readiness audit and collaboration

The candidate now bundles PeerJS 1.5.4 locally and permits its specific signaling WebSocket. Sharing offers explicit session/project selection, a content review, peer invites, a separate snapshot-code option, a read-only conversation viewer, and Stop sharing. Project shares contain the sessions currently listed in the client and their fetched history (up to the existing API's 2,000-message limit per session). Files, live editing, continuing a friend's agent session, and durable team membership are not implemented. Large snapshots are rejected rather than silently truncated. Tool/thinking records and stored connection credentials are excluded. Text within ordinary messages is shared as reviewed.

Peer codes are pasted into the other Archon client's Share dialog; they do not depend on a localhost or file URL. Keep the sending app open until the peer receives the snapshot. Stopping closes the peer connections and invalidates that live invite; already received snapshots and snapshot codes remain readable. Snapshot codes are explicit exports, never an automatic error fallback.

Settings → Connection now includes device-token entry through the existing write-only Electron bridge. Test connection checks both public health and authenticated status. The candidate does not configure agent credentials or modify any backend. The local preview is disposable test data and must not be used for real work or real tokens.

See [readiness audit](testing/readiness-audit.md) for the actual test coverage and remaining release checks.

The current recipe intentionally fails if edits change the frozen baseline. To develop a new release, preserve this record, use a separately reviewed candidate recipe/manifest, and run isolated UI checks before approving new hashes. Never change expected checksums simply to silence a mismatch.

See the [baseline record](../docs/releases/v0.3.0.md), [legacy inventory](../docs/versions.md), and [release checklist](../docs/releases.md). GitHub publication, full source recovery, full Electron distribution packaging, and new visual/live checks are separate work.

## Reproduce the candidate verification

```bash
ARCHON_V030_ASAR=/path/to/app-v0.3.0-unified-refresh.asar npm test
node current/testing/preview.cjs /path/to/app-v0.3.0-unified-refresh.asar
```

Run these commands from the repository root. The optional archive environment variable makes the integration tests read the actual packaged renderer instead of relying on a local inspection extraction. The preview serves the same patched renderer at `http://127.0.0.1:4318`, with an explicitly disposable bridge and test workspace. It never connects to production. Browser compositing is represented by a local iframe and terminal transport by a test echo; testing them here does not certify native Electron compositing or live tmux transport. See [hands-on verification](testing/verification.md).
