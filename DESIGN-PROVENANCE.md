# Archon Desktop v0.5.0 — supplied design provenance

Canonical input archive

- Source path: `/home/abdullah/Downloads/Archon Desktop with themes and icons(1).zip`
- Staged immutable copy: `reference/user-source/Archon Desktop with themes and icons(1).zip`
- SHA-256: `1478577c1022a7df1da97860d6ffbf5f6ce371bc2d8b75c21275387c2dd8fdcc`
- Size: 6,371,314 bytes

Implementation contract

- `Archon Desktop v2.dc.html` is the canonical v2 shell and interaction reference.
- `BUILD-NOTES.md` supplies implementation guidance and design intent.
- `_ds/*` supplies the Nocturne, Classical, and Modernist design systems.
- `assets/home-backdrop.png` is shipped as the default start-page plate.
- Seven themes and twenty-two app marks from the v2 prototype are implemented as real persisted preferences.
- The archive is read-only and never used as a mutable source tree.

Functional behavior remains connected to the real Archon Desktop renderer, preload bridge, Electron main process, and VPS API. Placeholder data and prototype-only version numbers are not copied into production.
