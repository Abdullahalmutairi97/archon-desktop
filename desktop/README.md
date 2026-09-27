# Archon Desktop authored reconstruction

This is the maintained Electron/React source route introduced in P2A. It builds without the private v0.3.0 ASAR. The official baseline and guarded `current/` recovery kit are unchanged.

The development version is **0.3.0-reconstruction.2**, with a separate app identity and user-data namespace. Build metadata labels baseline parity **unverified**. There is no automatic updater or installation over the official app.

## Build and preview

Use Node **24.21.0** from the root `.node-version` and npm **11.19.0**, as pinned in `desktop/package.json`. From the repository root:

```bash
npm run desktop:setup
npm run desktop:typecheck
npm run desktop:test
npm run desktop:build
npm run desktop:preview
```

`desktop:setup` installs the checked-in lockfile. `desktop:preview` serves only the compiled renderer at `http://127.0.0.1:4173` for a browser; it does not launch Electron or start an agent. The source-build CI job uses pinned dependencies and an immutable container image.

P2A provides a synthetic reference shell and pure typed models for runtime identity, queue state, scoped IDE documents/artifacts and read-only snapshots. The interface uses fake projects, sessions and messages. Its controls demonstrate local UI behavior; they do not access a server, workspace filesystem, native terminal, real browser session, provider or credential store.

P2B.1 adds a finite preload bridge and main-process backend transport for five read-only operations. The token stays in main-process memory, and the current renderer still shows synthetic data. The bridge is exercised with fake services; no real backend or local Codex agent is started. See [the P2B.1 scope](../docs/releases/phase-2b1-trusted-connection.md).

P2B.2 adds injected profile and credential storage modules under `src/main/storage/`. They are exercised only with temporary fixtures and fake `safeStorage`; the active connection does not yet use them. See [the P2B.2 scope](../docs/releases/phase-2b2-profile-credential-storage.md).

## Source boundaries

The historical Electron/React tree at commit `69bcf1ecb25e4004c11576d3becdb3cb2d266767` supplies layout/theme references. Readable pure helpers from `current/` supply behavior references. Neither the historical 1.0.0 label nor a matching prototype screenshot proves v0.3.0 parity. Authored modules have origin/transformation records; the normal build does not import bundle string-replacement patches or require recovered source directories.

See [build provenance](BUILD-PROVENANCE.md) for pinned toolchain sources and input/output manifests, and [the dependency license inventory](THIRD-PARTY-LICENSES.md) for the locked package graph.

The browser preview is useful for layout and interaction checks, but it does not qualify Electron's sandbox, IPC, remote views or OS keyring. P2B implements the validated bridge, transport/storage and local Codex adapter; P2C completes renderer feature integration; P2D qualifies native behavior and fresh packages. See the [bounded reconstruction plan](../docs/roadmap/p2-reconstruction-plan.md).

Use synthetic fixture data for current source checks. Importing real profiles, enabling live adapters, packaging a release or replacing the official baseline are separate later gates.
