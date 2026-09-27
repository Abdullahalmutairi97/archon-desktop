# Phase 2C.2 — Read-only server collections

This increment adds a separate Server data route to the authored desktop. In Electron, it reads projects, sessions and tasks through the finite P2B.1 bridge after resolving the current connection. Rows are labeled SERVER and display only bounded title/name/ID and status fields. Session and task lists may be capped by the backend; displayed counts say “shown” and are not totals. An authorization rejection directs the user back to Connection to re-enter the token. Disconnecting or changing connection generation hides prior rows and ignores late responses.

The normal project, session, task, chat, file and tool workspace views remain synthetic fixtures. Browser preview has no bridge and the Server data route explicitly stays offline. No server operation in this route creates, edits, executes or deletes data.

## Validation boundary

Focused fake-bridge tests cover bounded fields, 120 returned sessions, rejected credentials, other failures, disconnect and generation changes. The integrated desktop check passed typechecking, **79 tests in 16 files**, the license inventory check and source build. The manifest recorded **65 inputs and 5 outputs** with matching sizes and SHA-256 hashes. The browser preview was visually checked in the Server data route and showed the offline state. No real server, credential, installed profile or native Electron window was used. Full workspace integration and native qualification remain open.
