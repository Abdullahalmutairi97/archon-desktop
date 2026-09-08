# Session integrity fix — 2026-08-19

## Root causes fixed

1. New sessions created from a project sent only `cwd`; project membership was inferred later and could be absent during the first-turn/list race. New tasks now carry `project_id`, and `prime-{task_id}` is assigned before the JSONL exists.
2. The renderer removed workspace-originated sessions from the authoritative Sessions list and its counts using stale local workspace maps. Sessions are now counted from the backend list without that exclusion.
3. Project views matched the display name (`session.project`) instead of the stable project ID. They now filter by `projectId`.

## Regression coverage

- Backend: 70 passed.
- TypeScript/build: passed.
- Real production A/B test: two separate Prime sessions, four sequential turns each, repeated refreshes; both retained 8/8 visible messages, with no cross-session markers.
- Live project contract: a new task with `project_id` appeared under the correct project before/after completion.
- Final production inventory: 27 sessions, zero message-count mismatches, zero tagged test sessions remaining.
- Electron live, project-control, and composer harnesses: passed with zero console errors.

## Deployment

- Final ASAR: `fcc3f32b5ac672e10bea56c207120045ea5a853746f1e62366bd520cc7bca1b3`.
- MiniPC/MainPC: identical 73-file manifests.
- MainPC: one main process and one renderer; ASAR retains no-COW attribute.
- Rollback: `/home/abdullah/Applications/archon-desktop-prime.pre-session-integrity-20260819.asar` (`5b9e9dbda315e7d2b528041eaebe96e66da525c32a03869ba971528356f5e17b`).
