# Archon Desktop stabilization validation — 2026-08-19

## Scope

Independent audit follow-up for native Prime session integration, session/project lifecycle safety, renderer refresh ordering, production API behavior, Electron controls, isolation, packaging, and MainPC deployment.

## Corrections

- Made session deletion atomic against queued/running submissions; persistent tombstones reject deleted-session reuse with HTTP 409.
- Treated queued and running tasks as active in deletion guards and session status.
- Resolved native-session resume cwd from JSONL session metadata with prior-task and runner fallbacks.
- Projected native JSONL transcripts along the active `id`/`parentId` branch and ignored abandoned branches and malformed tails.
- Expanded native deletion to stop attached Prime agents and remove transcript plus artifact directories.
- Added rollback/cleanup compensation for project create/delete failures.
- Added generation guards to overlapping renderer refreshes and active-session guards to transcript hydration.
- Split update metadata (`/api/desktop/check`) from the authenticated AppImage download route (`/api/desktop/update`).
- Disabled the unavailable legacy v2 workspace event plane in the Prime-only client, eliminating repeated 404 reconnects.
- Added regression coverage across workspace parsing/deletion, API operations, Hermes/Prime process-tree cancellation, and renderer control/isolation harnesses.

## Verification

- Backend: `69 passed`; `compileall` successful.
- Renderer: TypeScript check and production build successful. Build has only existing large-chunk advisory warnings.
- Production API: 16/16 routes in `verify-live.cjs` returned 200; authenticated SSE opened and replayed 49 frames.
- Native branch lifecycle: a synthetic forked JSONL with a malformed tail rendered only the active user/assistant branch (2 messages), resolved cwd correctly, attached to a project, preserved the folder on project deletion, and removed transcript/artifacts on session deletion.
- Production inventory: 18 sessions; zero message-count/transcript mismatches.
- Electron controls: Refresh, project creation form, assignment, project attach/delete, and session detach/delete all present; zero console errors.
- Isolation: active A, replay, switch to B, rapid B→A, and completion-after-navigation all isolated; zero console errors.
- Route screenshot sweep: completed with zero console errors.
- MainPC runtime after final launch: one main process and one sandboxed renderer; normal `/api/events` and startup endpoints returned 200; no HTTP 4xx/5xx, traceback, legacy `/api/v2/events`, or old update probe appeared after launch.

## Deployment

- Final ASAR SHA-256: `adc4b238bada3a7e96d33ad000481e30699301386433a2b9576f1d9bc848c169`.
- MiniPC and MainPC installations have identical 73-file SHA-256 manifests.
- MainPC final ASAR retains the no-copy-on-write attribute required by Btrfs.
- MainPC rollback ASAR: `/home/abdullah/Applications/archon-desktop-prime.pre-stabilization-20260819.asar` (`488f56c76fd575f924ee48af10db90f8dc0f87c4990179c220c28f10cecf3235`).
