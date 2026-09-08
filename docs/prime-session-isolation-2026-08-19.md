# Prime session isolation validation — 2026-08-19

## Defects fixed

1. The renderer accepted every global `message.delta` and `message.done` event into one shared on-screen thread.
2. React reused the same `Thread` component when navigating directly between session IDs, allowing stale local transcript state to remain during the next fetch.
3. Stream events did not explicitly carry their native Prime session ID.

## Changes

- `backend/archon_server/prime_runner.py`: every answer delta and completion now includes `session_id`.
- `app/src/state/store.tsx`: streamed answers are accepted only when their session or pending task matches the thread currently visible.
- `app/src/App.tsx`: `Thread` is keyed by session/pending-task identity so switching sessions creates isolated local state.
- Rebuilt and installed the corrected application at `~/Applications/archon-desktop-prime`.

## Concurrent stress test

Two different existing Prime sessions ran concurrently:

- A: `prime-635e16ff982d408e90e00899dcaca61e` → `ISOLATION-A ORBIT-731`
- B: `prime-28ee85c6c4b24192a074129ae6adbd4f` → `ISOLATION-B archon-desktop-server`

Results:

- A emitted 8 deltas, all tagged only with A's session ID.
- B emitted 9 deltas, all tagged only with B's session ID.
- Event sequence IDs were disjoint.
- Reconstructed stream A exactly matched final answer A.
- Reconstructed stream B exactly matched final answer B.
- Transcript A contained no B marker.
- Transcript B contained no A marker.
- Each session uses a unique directory under `prime-sessions/<session-id>` and its own native Prime JSONL transcript.

## Validation

- PrimeRunner isolation regression test passed.
- Renderer TypeScript typecheck passed.
- Full renderer/main build and Electron packaging passed.
- Installed app archive contains the new session-tag and delta-routing logic.
- Backend service remains healthy and active.
