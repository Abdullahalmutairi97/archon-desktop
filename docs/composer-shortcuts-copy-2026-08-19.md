# Composer shortcuts and copy controls — 2026-08-19

## Changes

- Up Arrow recalls the previous user prompt from the current conversation; repeated Up walks backward and Down walks forward/restores the draft.
- Prompt history is supplied per thread and is never shared across Prime sessions.
- Shift+Tab cycles Auto → Approve steps → Plan mode while focus remains in the composer.
- Completed assistant responses have a small Copy button beside the speech button.
- Copy uses an isolated Electron IPC bridge to the operating-system clipboard.
- Shortcut hints are platform-aware. Linux/Windows render `Ctrl+…`; Apple glyphs are shown only on Apple platforms.
- Settings now documents prompt-history and mode-cycle keys.

## Verification

Live Electron verification against the production backend confirmed:

- Linux hints: `Ctrl+N` and `Ctrl+K` present; `⌘K` absent.
- Up Arrow recalled the latest user prompt from the selected test session.
- Shift+Tab changed `Approve steps` to `Plan mode`.
- Copy control was present and produced the `Reply copied` confirmation.
- Zero renderer console errors.
- TypeScript and production builds passed.

## Deployment

- ASAR SHA-256: `4fdc1cebd86d22438eb3835e825dadfb234aa14b1da83c5a4087e32b47181842`
- MiniPC/MainPC manifests: identical, 73 files.
- MainPC runtime: one main process and one sandboxed renderer; no post-launch HTTP errors or legacy v2 stream.
- Rollback: `/home/abdullah/Applications/archon-desktop-prime.pre-shortcuts-20260819.asar` (`adc4b238bada3a7e96d33ad000481e30699301386433a2b9576f1d9bc848c169`).
