# Archon Desktop authored reconstruction

This is the maintained Electron/React source route introduced in P2A. It builds without the private v0.3.0 ASAR. The official baseline and guarded `current/` recovery kit are unchanged.

The development version is **0.3.0-reconstruction.9**, with a separate app identity and user-data namespace. Build metadata labels baseline parity **unverified**. There is no automatic updater or installation over the official app.

## Build and preview

Use Node **24.21.0** from the root `.node-version` and npm **11.19.0**, as pinned in `desktop/package.json`. From the repository root:

```bash
npm run desktop:setup
npm run desktop:typecheck
npm run desktop:test
npm run desktop:build
npm run desktop:start
npm run desktop:preview
```

`desktop:setup` installs the checked-in lockfile. `desktop:preview` serves only the compiled renderer at `http://127.0.0.1:4173` for a browser; it does not launch Electron or start an agent. The source-build CI job uses pinned dependencies and an immutable container image.

`desktop:start` rebuilds the authored app, then opens that compiled build in Electron without starting the Vite development server. The launch uses Electron's normal per-user app-data path under the separate `archon-desktop-reconstruction-dev` profile and may connect to the configured same-user backend; it does not install or start backend services. `desktop:start` requires the desktop dependencies (run `desktop:setup` once) and an available graphical session.

The source build also emits `desktop/out/runner/runner/worker.js` for optional backend-owned Local Codex. To use it, fully quit Electron, then configure the already-running same-user backend service with `ARCHON_DESKTOP_LOCAL_OWNER_MODE=true`, `ARCHON_DESKTOP_LOCAL_CODEX_ENABLED=true`, `ARCHON_DESKTOP_REMOTE_ACCESS_MODE=disabled`, and `ARCHON_DESKTOP_LOCAL_CODEX_METADATA_ROOT` set to the **exact existing** `codex` directory inside this Electron profile. Keep the backend's normal private service credentials and paths from the [operator setup guide](../docs/operator-setup.md). Start Electron with `ARCHON_DESKTOP_CODEX_OWNER=backend npm run desktop:start`; it will use only the paired backend owner and will not start a second app-server. Both owners claim the same exclusive metadata lease, so an existing owner or stale lock stops a second owner. Back up the profile before switching ownership, and inspect any stale lock before removing it. Closing Electron leaves a turn running only while the backend service remains alive; stopping or restarting that service can interrupt the turn, and its in-memory event ring does not survive a restart.

P2A provides a synthetic reference shell and pure typed models for runtime identity, queue state, scoped IDE documents/artifacts and read-only snapshots. The Local Codex view now uses the local Codex app-server. In Electron, Server data can inspect the configured backend, provision a revision-pinned checkout, and browse, search, create and edit small text files in a registered checkout. Other reference workspace views remain synthetic.

P2B.1 added a finite preload bridge and main-process backend transport for five read-only operations. The token stays in main-process memory. At that phase, the renderer still showed synthetic data; the bridge was exercised with fake services and did not start a real backend or local Codex agent. See [the P2B.1 scope](../docs/releases/phase-2b1-trusted-connection.md).

P2C.1 adds an explicit Connection view. In Electron it can show authenticated backend readiness, returned read-only project/session/task rows and event cursor; session/task lists are capped and do not represent totals. The rest of the workspace remains synthetic. In the browser preview the bridge is absent, so connection controls are disabled. The token input clears after submission and is not written to renderer preferences or local storage. The native security and keyring gates are still unverified. See [the P2C.1 scope](../docs/releases/phase-2c1-connection-view.md).

P2C.2 adds a separate Server data route for bounded project, session and task rows. It resolves the current connection on entry and clears old results on disconnect or generation change. Later increments add workspace checkout and bounded text-file tools there. Browser preview stays offline, and the regular workspace views still use fixtures. See [the P2C.2 scope](../docs/releases/phase-2c2-server-collections.md).

## Source boundaries

The historical Electron/React tree at commit `69bcf1ecb25e4004c11576d3becdb3cb2d266767` supplies layout/theme references. Readable pure helpers from `current/` supply behavior references. Neither the historical 1.0.0 label nor a matching prototype screenshot proves v0.3.0 parity. Authored modules have origin/transformation records; the normal build does not import bundle string-replacement patches or require recovered source directories.

See [build provenance](BUILD-PROVENANCE.md) for pinned toolchain sources and input/output manifests, and [the dependency license inventory](THIRD-PARTY-LICENSES.md) for the locked package graph.

The browser preview is useful for layout and interaction checks, but it does not qualify Electron's sandbox, IPC, remote views or OS keyring. P2B implements the validated bridge, transport/storage and local Codex adapter; P2C completes renderer feature integration; P2D qualifies native behavior and fresh packages. See the [bounded reconstruction plan](../docs/roadmap/p2-reconstruction-plan.md).

Use isolated fixture data for source checks. Importing real profiles, packaging a release or replacing the official baseline are separate later gates.
