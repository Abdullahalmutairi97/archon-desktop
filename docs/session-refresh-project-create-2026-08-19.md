# Session refresh and project creation — 2026-08-19

## Features

- Sessions page has an explicit Refresh button with loading state and toast feedback.
- Sessions still refresh automatically when the page mounts.
- Projects page has a New project button and inline form for name and optional server folder.
- POST `/api/projects` validates and creates the folder, persists the project, and rejects duplicate/out-of-account paths.
- Existing project registry is now exposed by GET `/api/projects`.
- Prime sessions are assigned to the most-specific project folder by cwd.

## Verification

- Focused backend/API tests: 8 passed.
- TypeScript check and production renderer/main builds passed.
- Live Electron automation found Refresh, New project, both form fields, and Create; zero console errors.
- Production create/list/folder integration passed and test data was removed.
- Production currently exposes 7 projects and maps 4 of 18 sessions to projects.
- MiniPC/MainPC 73-file package manifests match.
- MainPC launched with one main and one sandboxed renderer process.
- Final ASAR: `4290adf801eb708fc62c9d10149177e0aad1051445fbb2a53a7a21039da032c1`.
