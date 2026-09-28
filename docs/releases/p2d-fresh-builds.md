# P2D — fresh package builds and native frame/credential checks

Recorded 2026-09-28 on `archonminipc` (Ubuntu 26.04 LTS, x86_64, 16 CPUs, Node
24.21.0, npm 11.19.0, Electron 44.4.5). Source commit
`dbb0b8143e531dd0b5de16084c6aa9bfa1c9bf13`, tree `af65d893236f5b023239ef7ed9c1bd967e9e1309`,
`desktop/package-lock.json` sha256 `9f5fce01b292a39982dab809077747a6b1e46ef0d38aefa61c3bec0ed6a04a93`.

This record covers two P2D packaging gates and the native hostile-frame and
credential gates. It is not a release qualification: nothing was installed over
the official app, and no release, signing or deploy step ran.

## Two fresh builds

Method: two independent `git clone --no-hardlinks` workspaces of the same commit
in `/tmp`, each ran `npm ci` into an empty `desktop/node_modules` (the checkout
carries no dependency directory), then the same pipeline —
`npm run typecheck && npm test && npm run licenses:check && npm run build &&
npm run package:portable`. Nothing was copied between the two workspaces and no
dependency cache was pre-seeded from the working checkout.

| Observation | Build A | Build B |
| --- | --- | --- |
| `npm ci` result | `added 168 packages`, exit 0 | `added 168 packages`, exit 0 |
| typecheck / tests | pass, 335 tests in 38 files | pass, 335 tests in 38 files |
| `licenses:check` | pass | pass |
| build manifest sha256 | `6325dea17825e99099dcd799c8241cafb5c705caa892de4cd3770272b5d45bfc` | same |
| package file | `Archon-Desktop-Reconstruction-0.3.0-reconstruction.9-linux-x64.tar.gz` | same |
| package bytes | 123405122 | 123405122 |
| package sha256 | `1f2167bdc767a87697227240685bb99b48cb81a5e8dc88d1c0f72cbaafa3b8c9` | same |
| packaged file count | 97 files | 97 files |
| sha256 over packaged name/size list | `8ada872ab3e48387f7a70770dc5883544e9c8d03c257afa58016748ffaf6b875` | same |
| sha256 over packaged file contents | `fe595f8698d01ee0e79c0ef4b8c21998befe2383ae5e79d988caf009cc51f04f` | same |

The two builds are byte-identical in this run, not merely normalized-equal: the
tarballs, the sidecar `.sha256`, the build manifest, the packaged name/size list
and the packaged content digests all match. That is one reproducibility
observation on one host, not a standing guarantee — timestamps, signing and host
toolchain differences can still change bytes elsewhere, so repeat the comparison
before claiming reproducibility for a later commit.

Package contents: the launcher, `PORTABLE-MANIFEST.json`, README, the Electron
runtime, and the app under `electron/resources/app/` (compiled `out/` plus
`build-manifest.json` and the third-party license file). There is no `reference/`
directory, no source tree, no `node_modules` and no environment file. The
`default_app.asar` present under `electron/resources/` belongs to the stock
Electron runtime, not to this application.

## Native frame and credential checks

Harness: `desktop/scripts/native-hostile-frame-check.mjs`
(`npm run native:hostile-frame`). It launches the real Electron app with
`XDG_CONFIG_HOME`/`XDG_CACHE_HOME`/`XDG_DATA_HOME`/`XDG_STATE_HOME`/`TMPDIR`
pointed at a private fixture root, drives it over the DevTools protocol, and
writes a JSON report. Run against the extracted package of build A.

Result: every check passed. The first run of this harness reported 12 checks; the
table below lists those, and later runs report 13 because the language-profile
bridge namespace was added to the top-frame check. Observed values:

| Check | Observed |
| --- | --- |
| Renderer has no node integration | `require`, `module`, `process` are `undefined`; `window.archon` is an object |
| Trusted top frame sees the preload bridge | namespaces `connection, api, localCodex, workspaceConsole, workspaceServices, workspacePreview` |
| Embedded same-origin frame cannot reach the bridge | frame located, live default script context, `archon`/`require`/`process` all `undefined` |
| Opaquely sandboxed frame cannot reach the bridge | separate out-of-process target (`iframe about:srcdoc`), `origin` `null`, no bridge or node globals |
| A new remote window is refused | `window.open(...)` returns `null`; no `example.com` target appears |
| The shell frame cannot navigate to a remote origin | the documented shell URL is still loaded after `location.assign('https://example.com/...')` |
| A remote navigation attempt revokes IPC trust | later privileged IPC fails with `UntrustedShellIpcError: Untrusted IPC sender` |
| Renderer storage carries no credential | `localStorage` holds only `archon.reconstruction.preferences.v1`; session storage empty |
| Credential persistence is protected or memory-only | Electron reported `storageMode: memory`; no credential record file was written |
| Disconnect removes any stored credential record | no record file remains |
| The app profile was written inside the fixture root | 53 files under the fixture config root |
| No plaintext probe token under the fixture root | 0 plaintext hits with a fake token saved and disconnected |
| The real user config root was not written | no entry under `~/.config` changed or appeared during the run |

Gate records, not passes:

- **Chromium OS sandbox — blocked-on-host.** With the sandbox intact the app
  aborts: `The SUID sandbox helper binary was found, but is not configured
  correctly ... chrome-sandbox is owned by root and has mode 4755`. The packaged
  `chrome-sandbox` is mode 0755 owned by the build user, and forcing the
  namespace sandbox (`--disable-setuid-sandbox`) aborts with `No usable sandbox!
  ...` because `kernel.apparmor_restrict_unprivileged_userns = 1`. The
  application-level checks therefore ran with `--no-sandbox`, which says nothing
  about OS sandboxing. No production configuration was changed.
- **Native keyring — blocked-on-host.** Electron selected no protected Linux
  backend in this environment, so the credential store kept the token in
  main-process memory, reported `storageMode: memory`, and wrote nothing to the
  profile. That is the documented fallback behaviour and it is verified; the
  protected-backend persistence path is not qualified here and is not claimed.
  The concrete `safeStorage` backend identifier is main-process state and is not
  exposed to this harness.

Limits: one host, one architecture, Linux only; no Windows or macOS behaviour and
no statement about the frozen v0.3.0 baseline. The harness needs a display
(`xvfb-run` is used when `DISPLAY` is unset) and is deliberately not part of the
GitHub Actions jobs, so CI does not run these native checks.

## Re-verification 2026-09-28 (later commit)

After the P3/P4/P5 slices landed, the same harness was re-run against a package
built from commit `0ab955c`:

- `npm run package:portable` → `Archon-Desktop-Reconstruction-0.3.0-reconstruction.9-linux-x64.tar.gz`,
  sha256 `d05121a93724527ed875d7b486d63135f627c0ea510d89698a058b085089d7b9`.
- `node scripts/native-hostile-frame-check.mjs` against the extracted package:
  **13 of 13 checks pass** (the report now also lists the `languageProfiles`
  namespace among the top-frame bridges), and the sandbox gate is again recorded
  `blocked-on-host` for the reasons above.
