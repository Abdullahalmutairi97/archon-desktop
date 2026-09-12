# Native desktop audit — 2026-09-12

Test target: the installed MiniPC Electron executable, version 0.3.0, using its existing profile and real server connection. Native UI interaction uses Electron automation with clicks, typing, keyboard shortcuts, and screenshots. The earlier browser fixture tests are documented separately in `audit-20260912.md`.

## Issue: queued requests displayed as working

Created two small test projects and submitted scoped Python and Node.js tasks through the installed app. Both requests were accepted, but neither started or created files. Read-only inspection confirmed queued tasks with no worker assignment and no execution worker running. The API itself remained connected.

The desktop previously interpreted an active session as a running agent. Fixed session labels, project counts, sidebar counts, and pending-session placeholders to distinguish **Queued** from **Working**. A running turn takes precedence over a queued follow-up. Existing sessions without matching task records retain their original activity state.

Validation: six regression tests exercise the release's actual data converters and session header, including queued/running/finished/failed transitions and guarded patch anchors. The full current workspace suite passed against the official archive. Backend files and services were not changed; starting the missing worker requires the user's separate decision.

One test request was cancelled successfully using the native app's Stop control. The second remains queued, alongside one older request. No unrelated tasks were cancelled.

## In progress

Codex integration and further native mini-project tests are being verified before publication of their feature commit.
