# Archon Desktop — main client

Electron + React + TypeScript Linux desktop. **Legacy source — original package label 1.0.0.** That label does not supersede the official **v0.3.0 baseline on AbdullahPC**.

AbdullahPC's archive was verified as the saved **unified-refresh v0.3.0** build, now reproducible through the repository's [`current/` kit](../current/README.md). This `desktop/` tree is not that release's reconstruction source and must not be relabeled or published as v0.3.0. See the [baseline record](../docs/releases/v0.3.0.md). The separate `archon-desktop-prime-latest/app/` client is also legacy (original label 0.4.2).

## Commands

From the repository root, with Node.js 22.12+:

```bash
npm --prefix desktop ci
npm --prefix desktop test
npm --prefix desktop run typecheck
npm --prefix desktop run build
npm --prefix desktop run dev
```

`src/main/` owns Electron/native operations, `src/preload/` exposes the IPC bridge, and `src/renderer/src/` contains views, state, components, and styles. The backend executes agent work; the renderer must not own task lifetime or provider credentials.

## Packaging

```bash
npm --prefix desktop run dist:linux
```

Artifacts are written under `release/` with their version and architecture in the filename. Building does not install, upload, or mark them as released. Use the architecture matching the target device. Keep binaries out of source commits.

`npm --prefix desktop run e2e` builds and invokes the Electron capture harness. Review its configuration before running: graphical/live checks are distinct from unit tests and must not share production preferences or create live work without approval.

## Compatibility

Connection URL and authentication are configurable. Use an isolated test profile for UI checks. Appearance and runtime choices belong to the client/operator; preserve them across changes. Never substitute another generation's source tree or bump a version merely because its number is larger.

See [version inventory](../docs/versions.md), [verification](../docs/repository-status.md), and [contributing](../CONTRIBUTING.md).
