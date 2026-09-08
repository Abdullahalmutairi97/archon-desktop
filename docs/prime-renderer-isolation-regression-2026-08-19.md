# Prime renderer isolation regression — 2026-08-19

## Defect found by live Electron automation

After concurrent A/B turns, direct A→B navigation displayed B under the correct header but appended A's prior streamed messages. The native API transcripts remained disjoint. Root cause was the global `data.thread` SSE buffer surviving session navigation and being appended to B's fetched transcript.

## Fix

- Clear the live SSE buffer in `openSession(...)` and `openChat(...)`.
- Re-check `activeSessionRef.current` when asynchronous terminal transcript hydration commits, preventing a request started for A from committing after navigation to B.
- Retain the existing event-level `session_id` routing gate and keyed `Thread` remount.

## Automated tests

Live Electron harness: `app/scripts/verify-session-isolation.cjs`.

Passed:

- concurrent active-A/background-B streaming isolation;
- direct A→B transcript switch;
- rapid B→A switch;
- disconnect/reconnect with event cursor reset and full historical replay;
- navigation from A to B while a delayed A turn completes;
- zero renderer console errors.

Backend race tests also passed:

- two simultaneous new sessions received distinct native session IDs and directories;
- two turns queued simultaneously to one session were serialized; turn two started after turn one completed and correctly recalled its context.

## Deployment

Installed on MiniPC and MainPC. Both packaged trees contain 73 files with identical SHA-256 manifests.

Final `app.asar`: `0bb9601e4aafee0c29d824ea76324232f0b363801b8c912097ebf1346e8f42bc`.

MainPC rollback ASAR: `/home/abdullah/Applications/archon-desktop-prime.pre-buffer-fix-20260819.asar` (`63a742d49d28f9e5a0d0aef9e2635d847b8d98ca90aac4cb96a271d540e47515`).

## Packaged MainPC runtime

The final installed MainPC package launched successfully under Wayland. Main, GPU, network, and sandboxed renderer processes remained alive; the renderer loaded `/home/abdullah/Applications/archon-desktop-prime/resources/app.asar`. Only pre-existing Fontconfig warnings were emitted.
