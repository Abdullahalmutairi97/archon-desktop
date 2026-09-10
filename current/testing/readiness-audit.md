# v0.3.0 readiness audit — 2026-09-10

## Result

Fixed blocking defects in the candidate's collaboration and connection setup. This is a verified renderer candidate, not a certification of the installed desktop app or production agents. No backend files, production credentials, deployment, or Tailscale configuration were changed.

## Defects fixed

- PeerJS CDN injection was blocked by the release CSP. Bundle pinned PeerJS with its license; narrowly allow its signaling WebSocket.
- Empty project/session invites and count-only received content: select actual data, review conversations, and read each received session's text/code.
- Project mode previously reused the active session; it now gathers the selected project's listed sessions.
- Localhost/file invite URLs were not portable. Pasteable peer codes work across installed clients.
- Unvalidated incoming objects could crash rendering. Validate version, schema, roles, strings, counts, and size; render received content as text.
- Automatic snapshot export on network failure removed. Exporting a snapshot is a separate explicit action after review.
- Peer cleanup, timeout, retries and Stop sharing added; late async results cannot revive stopped connections.
- Settings had removed token entry. Restored using the existing write-only desktop bridge.
- Test connection previously checked only public health. It now also checks authenticated status.

## Computer-control evidence

Used the actual patched v0.3.0 renderer with disposable bridge fixtures at port 4318. No Playwright or browser calls outside the computer-control tool were used.

- Session/project selection prevents an empty share. Project review displayed two fixture sessions, including user prompts and agent code.
- Created a real PeerJS Cloud invite. A second browser client connected over WebRTC and displayed both session transcripts. Switched to the second session and read its Python code.
- Stop sharing closed the connection. Receiving client reported disconnection and retained the received snapshot.
- Opened an agent session, opened its generated snippet in IDE, opened the referenced file, edited it, and saved with Ctrl+S. Status changed to Saved.
- Clicked a reply URL; Browser panel displayed the fixture greeting page.
- Inspected Settings General, Connection, and Agents & models. New token field is present with stored-token status. Test connection returned Authenticated connection against the fixture bridge.
- Navigated Skills/MCPs (inventory unavailable message because no inventory fixture), Automations (empty), Backups (empty), Logs (empty). This checks navigation/error/empty states, not those live services.

## Commands

From repository root:

```sh
ARCHON_V030_ASAR=/home/archonminipc/projects/archon-desktop-v0.3.0/unified-refresh/app-v0.3.0-unified-refresh.asar npm test
```

20 tests passed, none skipped. New coverage includes snapshot validation/Unicode roundtrip, exclusion of native records and unrelated fields, empty/oversized input rejection, bundled PeerJS assets/CSP guards, and connection integration. Existing IDE parser, saving, race, and patch guards pass.

From `current/`:

```sh
npm run build:candidate -- /home/archonminipc/projects/archon-desktop-v0.3.0/unified-refresh/app-v0.3.0-unified-refresh.asar /tmp/archon-v030-readiness-final.asar
git diff --check
```

Both passed. Builder validates full renderer syntax. Candidate SHA-256: `83853e2be7773b7c701eb79f4ddc8618c3836da8be1eec69374c0ff6f94a08c4`.

## Remaining verification

- Install/launch the candidate in native Electron on the intended PC before real work. Official installed archive was not replaced.
- User deferred agent connection details. No real agent prompt, credential save, live model catalog, or production authenticated connection was tested.
- Two browser clients on this computer passed; two-PC routing/TURN/Tailscale behavior remains untested. Tailscale is running locally with four online peers; this does not establish app authorization.
- Native WebContentsView compositing, live terminal transport, voice, backup/automation mutations, and real Skills/MCP inventories were not exercised.
- Collaboration is read-only snapshot sharing, not full live team collaboration or remote agent control. Snapshot codes roundtrip in unit tests; the live UI test exercised the PeerJS transfer path.
