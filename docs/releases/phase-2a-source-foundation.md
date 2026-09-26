# Phase 2A — Authored source foundation

P2A introduces an authored Electron/React source build that does not require the missing private ASAR. The frozen v0.3.0 kit remains unchanged. This is a reconstruction development channel, not a new official release.

## Delivered scope

- Exact dependency pins and a lockfile, isolated app identity, build metadata/provenance and a dedicated source-build CI path.
- Typed pure runtime identity, queue, scoped IDE and read-only snapshot models derived from the current readable helpers.
- A synthetic renderer shell using recovered layout/theme references, navigation controls and fixture project/session/workbench views.
- A renderer-only loopback browser preview, with no live backend, provider, filesystem, terminal or credential integration.

See [the build guide](../../desktop/README.md) and the source provenance records for commands and input origins. The historical source is a verified reference input, not matching authored v0.3.0 source. Build metadata retains `baselineParity: unverified`.

## Validation

The integrated `npm run ci` passed type checking, 26 tests, the 243-entry license inventory check and the source build. After review fixes, the focused App suite passed all 5 tests and the final build was refreshed. These are separate runs; no later integrated test count is claimed. The final build manifest recorded 45 source/configuration inputs and 4 emitted files, with sizes and hashes verified.

Browser inspection covered 1440×900 Obsidian and 1040×680 Ivory with RTL, right navigation and 120% typography. Runtime selection, scoped IDE fixtures, sidebar toggling, exclusive appearance/command dialogs and Escape behavior worked without horizontal overflow. Astra approved this source/fixture boundary with all findings closed.

Backend code is unchanged from the green Phase 1D source in PR #18; its 542-test result remains separately recorded there. Hosted CI status will be recorded on the pull request.

## Remaining P2 scope

Validated main/preload operations, protected transport/storage, local Codex integration, complete renderer behavior, hostile native frame checks, keyring qualification and two fresh package builds remain P2B–P2D. No native app, installed profile, real agent or provider was launched during P2A implementation. A source build and browser preview do not certify those native gates or authorize an installer release.
