# v0.3.0 IDE and Browser audit — 2026-09-10

The hands-on test used computer control to click, type, press shortcuts, scroll, and drag in the actual patched v0.3.0 renderer. The local bridge supplies disposable sessions and file content; it is clearly identified by the host label `DISPOSABLE UI TEST`.

## Verified through UI interactions

- Open a session from Sessions, then use **Open in IDE** to present its code.
- Click a file link in the reply to open the current file contents, resolved relative to that session's working directory.
- Type into an editable file: the dirty dot and Unsaved status appear. Ctrl+S writes the new content and returns to Saved. The bridge's write evidence confirmed the exact changed text.
- Switch from a dirty editor to Browser, open an agent-result URL, and return to IDE: the draft remains intact.
- Close a dirty tab: discard confirmation appears; Cancel preserves the draft.
- Open failed and truncated reads: explanatory status appears, textarea is read-only and Save stays disabled. Protected files are disabled in Explorer.
- Browse folders, expand the IDE, and scroll a 120-line file: gutter labels align with the corresponding code lines.
- Restore the panel and drag its divider: the width changes.
- Switch to another session: Agent code shows only its single Python snippet; the previous session's three artifacts disappear. Previously opened workspace tabs remain available.
- Create a disposable terminal and type/submit a command: transport status and output appear through the existing terminal component.

## Automated gate

`ARCHON_V030_ASAR=/path/to/official.asar npm test`: 16 tests passed, none skipped in this run. Tests cover exact snippet content, streaming/stable identities, session isolation, write/patch targets, protected/failed/partial reads, retry, asynchronous save edits, external-write conflicts, stale reads after tab close, stream updates, guarded renderer integration, syntax, and the original frozen baseline tests.

`npm --prefix current run build:candidate -- /path/to/official.asar /new/output/app.asar`: passed archive/version/anchor/syntax validation and built a candidate.

`git diff --check`: passed.

## Limits

Native Electron browser compositing and live tmux transport were not exercised through computer control because this environment exposes browser control only. The harness uses an iframe and a test terminal transport. No production files, sessions, app installation, or release archives were changed. Save conflict detection uses an optimistic read-before-write with the existing bridge; an atomic server-side conditional-write API is outside this candidate. App restart recovery for unsaved buffers is not implemented.
