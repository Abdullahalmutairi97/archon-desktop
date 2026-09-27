# P2 — frozen v0.3.0 input verification (target workstation)

Recorded 2026-09-27 on `archonminipc`. The official frozen v0.3.0 archive, long
reported unavailable, is present on this host and was used to run the frozen
reconstruction kit end-to-end. This is an **input-verification and
candidate-reconstruction** record, not a native/visual parity or release claim.

## Frozen input

- Path: `projects/archon-desktop-v0.3.0/unified-refresh/app-v0.3.0-unified-refresh.asar`
- SHA-256: `36d3ae03bd6b20c4e9ea5fc690461ef972b16eb0c9433bfb1305daeb068e549b`
- Matches `current/baseline.json` `archiveSha256` exactly.

## Frozen-kit tests

`ARCHON_V030_ASAR=<frozen> node --test refresh.test.cjs tests/*.test.cjs` in
`current/` (after `npm ci`): **88 tests passed, 0 failed, 0 skipped.** None were
skipped in this run, so the ASAR-gated baseline, patch-anchor, IDE, Codex,
connection and collaboration checks all executed against the real archive.

## Guarded candidate build

`node current/candidate.cjs <frozen> /tmp/archon-v030-candidate-verify.asar`
passed archive/version/anchor/syntax validation and wrote a candidate payload:

- Size: `296875791` bytes
- SHA-256: `e409eaf57cebf98152d68842f19e98b7e15ab1931e2af38372fa371fe723b856`

The builder never installs, restarts or replaces the app. No production files,
installed app payload, or release archives were changed.

## Limits

- The candidate is an app payload, not an Electron installer or an official release.
- Native Electron compositing, live transport and visual parity against the
  frozen archive were not exercised here.
- The installed app was not replaced, and no release/deploy step was performed.
