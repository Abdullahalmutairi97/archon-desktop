# Stabilization code audit

Scope: current uncommitted backend and Prime-latest renderer/main-process code. No source files were changed. Findings below are reproducible from the cited control flow; priority reflects data loss/cross-session risk first.

## P0 — Session deletion races queued/resuming work and can erase an accepted turn

- `backend/archon_server/app.py:506-516` checks `has_running_session()`, then deletes the native transcript, then purges the task ledger in separate operations.
- `backend/archon_server/tasks.py:84-88` checks only `status='running'`, although accepted turns are initially `queued` (`tasks.py:50-57`) and are claimed later (`tasks.py:156-178`). Task submission and deletion share no transaction or per-session lock.
- Reproduction: pause/slow the worker, POST a resumed turn for an existing session (202/queued), then immediately DELETE that session. The delete is allowed and `purge_session()` removes the accepted queued task. A concurrent claim between the check and unlink can instead run against a transcript that has just been deleted.
- Fix: serialize submit/claim/delete per session. In one `BEGIN IMMEDIATE` transition, reject deletion if **queued, running, or cancelling** work exists and tombstone the session so new submissions cannot enter; only unlink native data after the tombstone/ledger decision succeeds. Make retry/recovery explicit if filesystem deletion fails.

## P0 — Resuming a native Prime Agent session uses the wrong working directory

- The renderer resumes by ID without a cwd (`app/src/views/Thread.tsx:510-537`).
- The runner consequently selects its configured default (`backend/archon_server/prime_runner.py:37-55`, especially 51-55) and always passes `--cwd <default>` even though the native JSONL session header contains its original `cwd` (`workspace.py:273-292`).
- Reproduction: discover a native session created in `/tmp/project-a`, configure `archon_root` to another directory, then reply from the desktop; the spawned argv contains `--cwd <archon_root> --resume <id>`. Relative file/tool operations can affect the wrong project.
- Fix: resolve the authoritative cwd during task submission (native header first, durable location second), persist it on the task, and pass it to the runner. Alternatively omit `--cwd` on native `--resume` only if the Prime CLI is verified to restore the saved cwd. Add an argv/cwd regression test to `test_prime_runner.py`.

## P1 — Overlapping refreshes can roll state backward or falsely take the whole UI offline

- `refresh()` has no generation token, abort controller, or in-flight coalescing (`app/src/state/store.tsx:347-442`). It is invoked on provider/config hydration (`store.tsx:481-486`) and again whenever Sessions mounts (`app/src/views/Lists.tsx:47-50`), as well as after mutations and by the button.
- Any older call may commit after a newer one; an older failure resets **all** data to `OFFLINE` (`store.tsx:434-440`) after a newer successful refresh. An older successful sessions/projects response can also resurrect a just-deleted row in renderer state until another refresh.
- `refresh()` swallows errors, so `doRefresh()` always reaches “Sessions refreshed” and its catch is unreachable (`Lists.tsx:184-194`). Create/attach/delete flows likewise cannot distinguish a failed refresh from success.
- Fix: coalesce refreshes or attach a monotonically increasing generation and commit only the latest; abort obsolete requests on server/config change and unmount. Return a result or rethrow after setting connectivity so callers report failure honestly. Prefer targeted optimistic mutation followed by a guarded revalidation.

## P1 — Prime transcript/count projection ignores the active JSONL branch

- Native records have `id`/`parentId`, but `_native()` flattens every message record from every JSONL (`backend/archon_server/services/workspace.py:209-235`). `list()` counts every textual user/assistant record (`workspace.py:269-301`) and `messages()` displays the same flat history (`workspace.py:305-320`).
- Reproduction: create a valid synthetic native JSONL with a common ancestor and two alternative child branches. The API reports both branches in `message_count` and returns both as one conversation, even though only the active leaf ancestry is the resumable transcript. Multiple JSONLs in an Archon session directory are also concatenated solely by file mtime.
- Fix: implement Prime-format branch resolution: select the active/latest leaf and walk `parentId` ancestry, then use that single projection for both list counts and messages. Add fixtures for rewind/branch, compaction, malformed tail lines, and multiple JSONLs.

## P1 — Native session deletion leaves its Prime artifact tree behind

- `PrimeSessionService.delete()` removes only the Archon session directory and/or `~/.prime/agent/sessions/<id>.jsonl` (`backend/archon_server/services/workspace.py:338-351`). Prime also stores per-session material under `~/.prime/agent/session-artifacts/<id>/` (kernel state, child JSONL, subagent/harness files); the service neither configures nor deletes that tree.
- Reproduction: delete a discovered native session that has a matching artifact directory. It disappears from `/api/sessions`, but the artifact directory and child transcripts remain on disk. This conflicts with the UI promise that transcript/tool log are removed (`app/src/views/Lists.tsx:62-66,136-139`).
- Fix: decide and document deletion semantics. For true deletion, inject a configured artifact root and safely remove the exact validated `<id>` tree, with partial-failure reporting/recovery. If artifacts must be retained, change the dialog to say the operation only hides/removes the primary transcript.

## P2 — Sessions are always reported idle, including while their task is running

- Backend session rows hard-code `"active": False` (`backend/archon_server/services/workspace.py:287-301`). The renderer maps only that flag to the session state (`app/src/api/index.ts:95-105`) and renders the status dot from it (`app/src/views/Lists.tsx:274-297`).
- Reproduction: refresh Sessions while a resumed task is running; its dot remains the done/idle state.
- Fix: join/aggregate task status for each session and set active for queued/running/cancelling work (ideally in one query, not another N+1 query). Keep deletion eligibility and displayed status based on the same predicate.

## P2 — Project create/delete are non-atomic across filesystem and two databases

- Create makes the directory before attempting the unique DB insert (`backend/archon_server/services/workspace.py:85-107`). A duplicate name with a new explicit path returns 409 but leaves the newly-created directory behind.
- Delete commits removal from `projects.db` first (`workspace.py:118-125`), then separately clears assignments in the task database (`backend/archon_server/app.py:482-487`; `workspace.py:265-267`). If the second DB is locked/fails, the API reports failure although the project is already gone and stale `session_projects` remain.
- Fix: on failed create, remove the directory only if this request created it and it is still empty. For delete, use a recoverable saga/tombstone (clear assignments first with compensation, then delete project) or place related metadata in one transactional DB; make retries idempotent.

## P2 — Current verification baseline does not pass cleanly

- Running `backend/.venv/bin/pytest -q --disable-warnings --maxfail=1` fails first in `tests/test_api_ops.py:40`: expected configured `health`, got global `agent-message`. App construction now uses Prime skill roots (`backend/archon_server/app.py:246`; defaults in `config.py:31-32`), while the operational test still provisions legacy profile skills, so the suite and the shipped contract disagree.
- The new `app/scripts/verify-project-controls.cjs` and `verify-session-isolation.cjs` are not wired into `package.json`; invoking them with `node` fails because Electron's `app` is unavailable. They need an Electron command/script and should run in CI.
- Fix: align the test fixture/contract with Prime-only skill discovery (or inject the skill root), add `verify:*` package scripts using `electron`, and gate stabilization on backend tests plus renderer typecheck/build and these lifecycle checks.
