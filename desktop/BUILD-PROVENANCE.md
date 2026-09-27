# Authored source-build provenance

This directory is a new, isolated desktop reconstruction scaffold. Its package identity is `archon-desktop-reconstruction`, version `0.3.0-reconstruction.9`. It is not represented as an official Archon Desktop release, and parity with the unavailable v0.3.0 authored source remains unverified. The [source inventory](../docs/roadmap/p2-source-inventory.md) documents that the recovered historical tree identifies itself as version 1.0.0 and is not the source for v0.3.0. The local recovery manifest lives outside this repository and is not a build input. This foundation does not copy the legacy privileged main process.

The renderer and domain modules are authored or selectively reconstructed from the inputs documented next to those modules. The shell runs with Electron's sandbox and context isolation enabled, with Node integration disabled. P2C adds an explicit backend connection view and server project/workspace operations; the Local Codex route can use the local app-server. Chat and the general projects, sessions, tasks and workbench views still include fixture data. There is no updater. The product name, application ID, user-data namespace, and package name are all distinct from the installed application. Build metadata states `baselineParity: "unverified"` and `liveConnectionsEnabled: true` for the explicit Electron connection view; this flag is not native qualification.

The P2B.1 bridge, frame guard and fixed-route transport are newly authored against the Phase 1D backend routes and readiness shape. The historical privileged main process was inspected as a compatibility reference only; its IPC registration, asset scheme, updater and plaintext safe-storage test toggle were not imported.

The connection, Server data and Local Codex routes are new renderer code that consume typed bridges. They do not import legacy renderer bundles or connect in browser preview. Server file operations are bounded and scoped to registered workspaces; the regular workspace views remain labeled fixtures.

## Pinned toolchain

| Component | Pin | Basis |
| --- | --- | --- |
| Node.js | `24.21.0` | Official Node release archive and release schedule |
| npm | `11.19.0` | Bundled with the pinned Node release; enforced by `scripts/check-toolchain.mjs` |
| Electron | `44.4.5` | Exact published package version; Electron 44 is the current stable major line at scaffold creation |
| electron-vite | `5.0.0` | Exact package version with Electron 44 and Vite 7-compatible configuration |
| Vite | `7.3.6` | Exact package version supported by electron-vite 5 |
| `@vitejs/plugin-react` | `5.2.0` | Exact package version with Vite 7 support |
| React / React DOM | `19.2.8` | Exact published package versions |
| TypeScript | `5.9.3` | Exact published package version |
| Vitest | `4.1.11` | Exact package version supporting Node 24; patches the development-server file-read advisory |
| jsdom | `29.1.1` | Exact package version supporting Node 24 |
| `@testing-library/react` / `@testing-library/jest-dom` | `16.3.2` / `6.9.1` | Exact test package versions |
| `@types/node` | `24.19.0` | Exact typings patch from the Node 24 line |
| `@types/react` / `@types/react-dom` | `19.2.17` / `19.2.3` | Exact React typings versions |

All direct dependencies are exact pins in `package.json`; the npm lockfile records the complete transitive dependency graph and integrity hashes. The license inventory is generated from that lockfile's declared package metadata.

## Build and CI

The source-build workflow uses the official `node:24.21.0-bookworm-slim` OCI index pinned to `sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6`. It runs `npm ci` and the desktop package's `ci` script without launching Electron. The generated `out/build-manifest.json` records the source commit, dirty-tree state, toolchain, lockfile hash, and sorted path/size/SHA-256 inventories for source/build inputs and emitted main/preload/renderer/runner files. The manifest does not include its own hash.

For a local Linux x64 portable package, run `npm run desktop:package:portable` from the repository root. The command checks the pinned Node/npm toolchain, rebuilds the app, verifies the clean source commit and build manifest, and writes a versioned tar.gz bundle plus a SHA-256 sidecar under desktop/release. The packager allowlists only the installed Electron dist, compiled out files listed in the build manifest, package metadata, and license/readme files. It refuses to overwrite an existing artifact. The tarball is a local preview package, not an official release or installation over the frozen v0.3.0 app.

The renderer preview serves the already-built renderer on loopback and does not start Electron. Its connection controls remain disabled because the preload bridge is unavailable in a browser. No release artifact or compatibility claim is produced by this source build.

## Primary references

- [Node.js v24.21.0 release archive](https://nodejs.org/en/download/archive/v24.21.0)
- [Node.js release schedule](https://github.com/nodejs/Release#release-schedule)
- [Electron release schedule](https://releases.electronjs.org/schedule)
- [Electron security tutorial](https://www.electronjs.org/docs/latest/tutorial/security)
- [Electron sandbox tutorial](https://www.electronjs.org/docs/latest/tutorial/sandbox)
- [Electron 44.4.5 package metadata](https://www.npmjs.com/package/electron/v/44.4.5)
- [electron-vite 5.0.0 package metadata](https://www.npmjs.com/package/electron-vite/v/5.0.0)
- [Vite 7.3.6 package metadata](https://www.npmjs.com/package/vite/v/7.3.6)
- [React 19.2.8 package metadata](https://www.npmjs.com/package/react/v/19.2.8)
- [TypeScript 5.9.3 package metadata](https://www.npmjs.com/package/typescript/v/5.9.3)
- [Vitest 4.1.11 package metadata](https://www.npmjs.com/package/vitest/v/4.1.11) and [file-read advisory](https://github.com/advisories/GHSA-82fw-gwwq-j7x9)
- [jsdom 29.1.1 package metadata](https://www.npmjs.com/package/jsdom/v/29.1.1)
- [@types/node 24.19.0 package metadata](https://www.npmjs.com/package/@types/node/v/24.19.0)
- [Official Node Docker image](https://hub.docker.com/_/node)
