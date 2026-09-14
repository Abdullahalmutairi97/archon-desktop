# Native desktop audit — 2026-09-12

Test target: the installed MiniPC Electron executable, version 0.3.0, using its existing profile and real server connection. Native UI interaction uses Electron automation with clicks, typing, keyboard shortcuts, and screenshots. The earlier browser fixture tests are documented separately in `audit-20260912.md`.

## Issue: queued requests displayed as working

Created two small test projects and submitted scoped Python and Node.js tasks through the installed app. Both requests were accepted, but neither started or created files. Read-only inspection confirmed queued tasks with no worker assignment and no execution worker running. The API itself remained connected.

The desktop previously interpreted an active session as a running agent. Fixed session labels, project counts, sidebar counts, and pending-session placeholders to distinguish **Queued** from **Working**. A running turn takes precedence over a queued follow-up. Existing sessions without matching task records retain their original activity state.

Validation: six regression tests exercise the release's actual data converters and session header, including queued/running/finished/failed transitions and guarded patch anchors. The full current workspace suite passed against the official archive. Backend files and services were not changed; starting the missing worker requires the user's separate decision.

One test request was cancelled successfully using the native app's Stop control. The second remains queued, alongside one older request. No unrelated tasks were cancelled.

## Codex and IDE verification

Added Codex as a real local agent backed by the signed-in Codex CLI app server. Prime and Pi remain remote server agents. Codex projects and sessions are stored on this PC, with local models shown only for Codex and remote models retained for Prime and Pi. Local file reads and writes require an owned Codex session, stay inside its project root, and reject protected credentials, private keys, and escaping symlinks. Unsupported approval requests are declined unless the desktop approval dialog explicitly allows the single request.

Native verification on the installed candidate:

- Settings shows a usable **Codex** card marked **THIS PC**, a ready status, and five discovered local models. Prime retains its remote model catalog.
- Created the local project **Codex Audit - Text Tools** at `/home/archonminipc/projects/codex-audit-20260912-text-tools` and two Codex sessions.
- Created `text_stats.py`, `test_text_stats.py`, and `README.md` in that project. Codex reported three passing unittest cases and a matching example; a separate shell check confirmed the three tests pass and Unicode output works.
- Opened `text_stats.py` from the new IDE panel, edited it, saved it with Ctrl+S, and confirmed the exact edit on disk. The IDE displayed **This PC**, scoped the explorer to the Codex project, and disabled the server terminal for the local session.
- Reopened the installed app with the same profile and confirmed both Codex sessions and the local project persisted. No renderer errors were reported.
- Ran a second native smoke test in the local project. The agent created `hello.py` and `test_hello.py`; the IDE opened both files, kept a dirty tab intact while switching files, prompted before discarding an unsaved tab, saved with the toolbar and Ctrl+S, reloaded an external disk edit, filtered the explorer, and navigated into and back out of `__pycache__`. The focused agent-code list contained only the two generated files after the follow-up fix.

Follow-up issues found and fixed during native testing:

- Codex sessions were initially displayed as Prime in the session list. Session labels now use the actual runtime.
- Switching into a local session could leave the explorer on the previous server root until a manual refresh. The explorer now keys its first load to the visible session ID and immediately scopes local sessions to their local root.
- The server model response uses a `choices` collection. The adapter now preserves the release's collection envelopes so Prime/Pi models remain available alongside Codex models.
- Local project/session association now rejects cross-runtime IDs, and a projectless local session uses an explicit scratch folder instead of the app launch folder.
- Task acknowledgements and early notifications wait for accepted turn mapping and synced local metadata. A failed metadata write interrupts the accepted turn.
- Agent-code extraction no longer treats inline shell commands, `.git`, or other prose references as generated files; explicit Markdown links and path-shaped references remain available.

The installed candidate is backed up at `/home/archonminipc/.local/state/archon-desktop-backups/20260912-native-audit/`. The Archon backend and worker service remain unchanged; the two remote Prime/Pi test requests are still queued because no execution worker is running.
