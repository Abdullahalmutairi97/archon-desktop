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

## Canonical comparison

`node current/testing/canonical-compare.cjs <frozen.asar> [candidate.asar]` is the
isolated canonical comparison. Against the frozen input it verifies all four
`current/baseline.json` files byte-for-byte; against a rebuilt candidate it
verifies the untouched files stay byte-identical and only the intended files
change. Exit code is non-zero on any mismatch; no official hash is altered and
no threshold is lowered.

Result on 2026-09-27:

- Frozen input: all four baseline files match (`package.json`, `dist/main/main.cjs`,
  `dist/main/preload.cjs`, `dist/renderer/assets/index-DN77foUV.js`).
- Candidate: `package.json` and `dist/main/preload.cjs` byte-identical to baseline;
  `dist/main/main.cjs` and the renderer patched as intended; PeerJS bundled and the
  renderer CSP includes `wss://0.peerjs.com`.

This verifies the input identity and the patched change-set. It is not a native or
visual parity claim.

## Native visual capture

An isolated native capture harness is now in the repository:

- `current/testing/capture-app.sh` launches a built app on a throwaway virtual
display (`Xvfb`) with a remote-debugging port, and `current/testing/capture-cdp.py`
captures its **real renderer** through the Chrome DevTools Protocol at a forced
1440×900 viewport (the sandbox is disabled only for this disposable capture, never
as production configuration).
- `current/testing/compare-captures.py` compares two captures and reports the
differing-pixel ratio against an explicit `--threshold`.

Result on 2026-09-27 (frozen baseline vs the candidate built from it):

- Both render at **1440×900**; the differing-pixel ratio is **0.728%**
  (`--threshold 0.15`), with the diff bounding box `[161, 5, 1422, 882]` — about
  99.27% of pixels identical.

This is a capture-level comparison: it shows the candidate preserves the baseline
layout and changes only a small, localized fraction. It is not a semantic or
behavioural parity claim, and no threshold was lowered.

## Limits

- The candidate is an app payload, not an Electron installer or an official release.
- The capture harness runs the renderer of each app on a virtual display; interactive
  input, live transport and multi-monitor/DPI behaviour are not exercised.
- The installed app was not replaced, and no release/deploy step was performed.

## Re-verification 2026-09-28

Re-run on the same host after the P3/P4/P5/P2D work described in `HANDOFF.md`:

- Frozen kit: `ARCHON_V030_ASAR=<frozen> node --test refresh.test.cjs tests/*.test.cjs`
  → `tests 88`, `pass 88`, `fail 0`.
- Frozen archive unchanged: sha256
  `36d3ae03bd6b20c4e9ea5fc690461ef972b16eb0c9433bfb1305daeb068e549b`.
- Candidate rebuilt with `npm run build:candidate -- <frozen> /tmp/archon-v030-candidate.asar`
  → sha256 `e409eaf57cebf98152d68842f19e98b7e15ab1931e2af38372fa371fe723b856`.
- `node current/testing/canonical-compare.cjs <frozen> /tmp/archon-v030-candidate.asar`
  reports `frozen.ok: true` with all four baseline files hash-matching, the candidate's
  `package.json` and `dist/main/preload.cjs` matching the baseline, and the two files the
  candidate patches (`dist/main/main.cjs`, `dist/renderer/assets/index-DN77foUV.js`)
  differing by design, with `peerjsBundled` and `peerjsCsp` true.

Nothing in this work touched `current/`; `git status current/` stayed clean.
