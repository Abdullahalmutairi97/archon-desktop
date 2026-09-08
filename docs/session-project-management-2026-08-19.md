# Session/project management — 2026-08-19

## Added

- Durable explicit session→project assignments in `session_projects`.
- Sessions-page project selector supports attach, move, and explicit detach.
- Project page provides “Attach a session…” and per-session detach/delete controls.
- Project deletion removes only the Archon registry record; folders, files, and sessions are preserved and assignments are cleared.
- Session deletion also removes assignment state.
- API routes:
  - `PUT /api/sessions/{session_id}/project`
  - `DELETE /api/projects/{project_id}`

## Verification

- Focused backend/API suite: 8 passed.
- Production lifecycle passed: create project → attach → project-filter query → detach → reattach → delete project with folder preserved → delete test session → remove test folder.
- TypeScript, renderer, main process, and package builds passed.
- Live Electron verified refresh, session assignment, new project, project delete, project attach, session detach, and session delete controls with zero console errors.
- Production state: 7 projects, 18 sessions, 4 cwd-derived assignments, 0 invalid project references.
- MiniPC/MainPC package manifests match all 73 files.
- Final ASAR: `488f56c76fd575f924ee48af10db90f8dc0f87c4990179c220c28f10cecf3235`.
