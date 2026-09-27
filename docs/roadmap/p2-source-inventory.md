# P2 source inventory — 26 September 2026

The repository history contains an authored Electron/React desktop, but its own provenance record identifies it as legacy source with original package label `1.0.0`. It explicitly states that it is not the source for the official `v0.3.0` release. Recovery of this tree provides reference code; it does not establish release parity or complete P2.

## Repository evidence

- Audited current main: [`0d69e63`](https://github.com/Abdullahalmutairi97/archon-desktop/commit/0d69e63f0a1b40a272494281a54df5f3b5b914bf). Its 122-file tree contains the current reconstruction kit and backend, not the complete authored desktop.
- Pre-cleanup source: [`desktop/` at `69bcf1e`](https://github.com/Abdullahalmutairi97/archon-desktop/tree/69bcf1ecb25e4004c11576d3becdb3cb2d266767/desktop). The historical [README](https://github.com/Abdullahalmutairi97/archon-desktop/blob/69bcf1ecb25e4004c11576d3becdb3cb2d266767/desktop/README.md) distinguishes this legacy tree from v0.3.0.
- All 102 desktop files were recovered to an isolated local reference copy and checked against their Git blob SHA and byte size. They include authored main/preload/renderer code, package and lockfile, tests, themes, components, scripts and assets. The large `home-backdrop.png` was retrieved using a fresh scoped download URL returned by the GitHub connector after its inline binary-content endpoint proved unsuitable.
- All 20 unique recursive trees across the 24 commits returned for main, through the initial root commit `17574cd72d2aba6d915054e31753d4514a4ecba8`, were inspected without truncation. None contains a separately tracked ASAR or source map. This does not establish the contents of other refs or expired CI artifacts.
- Both reference ZIPs in historical trees were downloaded and verified. The 110,472-byte `reference/incoming-archon-design/archon-desktop-themes-icons.zip` has blob SHA `e477e4c661712493acf873522ed8c12c82c894f6`; the 6,371,314-byte `reference/user-source/Archon Desktop with themes and icons(1).zip` has blob SHA `91b8bb8cddf1e88ca8f0280c79d8926f56d75258`. Their directories contain `.dc.html` design prototypes, design-system assets and support scripts; the larger ZIP also includes `BUILD-NOTES.md` and images. Neither contains an ASAR, authored Electron package or application lockfile. The archives' scripts have not been executed.
- The repository release collection was empty when inspected. No additional source branch was present beyond main and the current roadmap/implementation PR branches. The available connector could not list the tags or repository-wide workflow-artifact collections; those locations remain unverified.

## Reuse candidates and limits

The historical source separates Electron main, preload and React renderer code. It includes connection handling, application settings, workspace navigation, chat/project pages, browser/IDE panels, terminal components and appearance preferences. These are candidates for deliberate source reconstruction after compatibility and security review. They must not be copied wholesale and labeled as the v0.3.0 source.

Existing main-process code demonstrates a storage interface using Electron `safeStorage` and a memory-only return path when encryption is unavailable. This is source evidence only: it does not qualify the current installed desktop, prove OS keyring protection, or satisfy native credential gates. Sender/frame validation, protocol permissions, navigation, updater behavior and native profile isolation still require review before reusing privileged code. Historical provisioning and live-capture scripts have not been run.

The active `current/` kit contains reusable candidate behavior for the IDE, browser, local Codex, connection lifecycle and read-only sharing. A reconstruction plan must identify how each behavior maps into authored source and which visual, shortcut, settings and session-identity checks demonstrate parity. The verified parent archive remains the strongest comparison input and is still unavailable locally; its expected SHA-256 remains `36d3ae03bd6b20c4e9ea5fc690461ef972b16eb0c9433bfb1305daeb068e549b`.

## Next gate

Before implementation of a replacement shell, record a bounded same-stack reconstruction plan with module ownership, input provenance, migration compatibility and explicit native/visual acceptance checks. Build and fixture success may establish a new authored source path, but must not be reported as verified v0.3.0 parity while the corresponding evidence is absent. Keep the frozen kit usable for comparison and recovery, preserve installed data, and publish source changes as review PRs only.

See [P2 scope and exit criteria](p2-source-build.md).
