# Current Archon Desktop — v0.3.0

The authoritative build is the installed **AbdullahPC** application. Read-only inspection on 2026-09-08 confirmed its package already says **0.3.0**, and its entire ASAR matches the saved unified-refresh release:

```text
36d3ae03bd6b20c4e9ea5fc690461ef972b16eb0c9433bfb1305daeb068e549b
```

This directory is the repository's **current release reconstruction kit**, not another desktop redesign. The older `desktop/` implementation and other 0.4.x/0.6.1/1.0.0 trees are legacy, regardless of their numeric labels.

## What is included

- `baseline.json`: authoritative version, whole-archive checksum, parent checksum, key packaged-file hashes, and provenance.
- `refresh.js`: the exact editable shared refresh component shipped on AbdullahPC.
- `replacements.json`: the six guarded substitutions extracted from the original release recipe, covering seven views.
- `build.cjs`: portable final-stage reconstruction with hash/patch guards and no deployment actions.
- Tests: the original component assertions plus metadata, reversibility, wrong-parent, missing/duplicate-target, and double-patch checks.
- A pinned ASAR packer and npm lockfile.

**Scope limitation:** the shipped app was refined from frozen packaged inputs. This kit reproduces the final release from its verified parent; it is **not a full TypeScript-source rebuild**. The underlying source lineage and earlier UI override stages still need consolidation for a clean from-source build. Do not claim the legacy `desktop/` tree produces this app.

## Install tools and test

From the repository root with Node.js 22 LTS:

```bash
npm run setup
npm test
```

The offline suite does not start Electron, contact a backend, or read preferences. ASAR 3.4.1 is pinned to reproduce the historical archive; npm reports deprecated transitive `glob`/`inflight` packages. Changing packer versions requires a fresh reproducibility check.

## Reconstruct the verified archive

Obtain the original **agent-resources parent** from the operator's saved release files. It is a release input, not a credential/profile backup, and is deliberately not committed as a large binary.

Expected parent SHA-256:

```text
0e4564634d15e8b22de2bd41b517d0778535fa4ccdb1277de5e140e6954e3711
```

On the MiniPC the saved input is `~/projects/archon-desktop-v0.3.0/agent-resources/app-v0.3.0-resources.asar`. That sibling is not included in a Git clone.

```bash
npm run build -- /path/to/app-v0.3.0-resources.asar /new/output/app.asar
```

The recipe validates the parent before extraction, patches only the six exact targets, checks syntax and key files, and requires the final whole-archive SHA-256 to match AbdullahPC. It refuses existing output files and stages work in a temporary directory. A clean clone cannot perform this reconstruction until the verified parent is supplied.

A fresh reconstruction on 2026-09-08 produced the **exact same archive hash** as AbdullahPC. The output was kept outside Git at `/tmp/archon-v030-verified-20260908/app.asar`. No app installation or restart was performed.

## v0.3.0 browser and IDE candidate

The verified renderer already contains the Browser workbench, Files editor and persistent Terminal. `candidate.cjs` builds a separate review artifact that keeps those surfaces and adds two small integrations: links found in the visible agent result appear as one-click Browser shortcuts, and an **IDE** workbench tab provides a compact VS Code-style explorer, file tabs, line-numbered editor, save state/Ctrl+S, status bar, and terminal switcher. The frozen release recipe and its hashes are unchanged.

Build it from the saved verified release input:

```bash
npm run setup
npm run build:candidate -- \
  /path/to/app-v0.3.0-unified-refresh.asar \
  /new/output/archon-v0.3.0-ide-browser-candidate.asar
```

The candidate builder checks the input archive and v0.3.0 package version, validates the patched renderer syntax, refuses an existing output, and never installs or restarts the app. It is intentionally a candidate artifact because the official v0.3.0 archive remains the authoritative release.

## Editing and future releases

The current recipe intentionally fails if edits change the frozen baseline. To develop a new release, preserve this record, use a separately reviewed candidate recipe/manifest, and run isolated UI checks before approving new hashes. Never change expected checksums simply to silence a mismatch.

See the [baseline record](../docs/releases/v0.3.0.md), [legacy inventory](../docs/versions.md), and [release checklist](../docs/releases.md). GitHub publication, full source recovery, full Electron distribution packaging, and new visual/live checks are separate work.
