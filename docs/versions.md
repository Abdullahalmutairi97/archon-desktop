# Official v0.3.0 and legacy inventory

## Authoritative release

**AbdullahPC's current Desktop build is the official v0.3.0 baseline.** Authorized inspection on 2026-09-08 confirmed embedded version 0.3.0 and an exact whole-archive match to the saved unified-refresh release. A fresh reconstruction also matches. See the [verified baseline record](releases/v0.3.0.md).

| Current location | Verified identity |
| --- | --- |
| AbdullahPC `~/Applications/archon-desktop-prime/resources/app.asar` | Installed v0.3.0 selected by the launcher |
| MiniPC `~/projects/archon-desktop-v0.3.0/unified-refresh/app-v0.3.0-unified-refresh.asar` | Identical saved archive |
| This repo's [`current/`](../current/README.md) | Imported editable final-stage component/recipe; byte-identical reconstruction from verified parent |

Whole-archive SHA-256: `36d3ae03bd6b20c4e9ea5fc690461ef972b16eb0c9433bfb1305daeb068e549b`.

The rest of the inventory below describes **MiniPC** copies unless stated otherwise. GitHub access is now configured and remote main histories were inspected for the owner-authorized source sync; see [the publication branch map](publication.md). No release tag or binary publication is implied.

## Legacy classification

All nonmatching Desktop builds sit **behind official v0.3.0**. Original 0.3.1, 0.4.x, 0.5.0, 0.6.1, and 1.0.0 labels are traceability only, not newer supported releases. Within `archon-desktop-v0.3.0`, only the verified unified-refresh artifact/recipe is current; original and other refinement/rollback archives remain legacy.

No fabricated replacement version numbers have been assigned to old binaries. Active paths and rollback files remain physically untouched. The backend and separate browser-based Archon Design project are independent components, not Desktop releases to renumber.

## Legacy source checkouts

Paths below are relative to the operator's `~/projects/`, not directories included in a Git clone.

| Path | Version evidence | Role / state |
| --- | --- | --- |
| `archon-desktop/desktop/` | package **1.0.0** | Main desktop source; local Linux 1.0.0 artifacts exist |
| `archon-desktop/backend/` | Python package **0.2.0** | Shared durable backend; native Prime/Pi and resource changes in working tree |
| `archon-desktop-prime-latest/app/` | package **0.4.2** | Separate Prime-focused client; changes newer than its snapshot commit |
| `archon-desktop-client/app/` | package **0.4.0** | Separate client repository, with uncommitted fixes; root wrapper still declares 0.3.1 |
| `archon-desktop-testing/desktop/` | package **0.6.1** | Testing copy, not a Git checkout |
| Earlier/nonmatching artifacts in `archon-desktop-v0.3.0/` | original label **0.3.0** | Legacy snapshots/rollbacks; the matching unified-refresh baseline is listed above |
| `archon/archon-desktop-live/app/` | package **0.4.0**, wrapper 0.3.1 | Additional local live-client source copy; not promoted in this pass |
| `archon/archon-v2-verify/desktop/` | package **0.6.1** | Additional verification copy |
| `archon-design/` | package **1.0.0** | Separate browser-based Prime design workspace; not a Desktop release or Git checkout |

Other local work areas discovered: `archon/archon-v2-candidate`, `archon/archon-sandbox`, `archon/archon-bench`, `archon/archon-hermes-v2-stage`, `archon/archon-ops`, `archon/archon-v2-smoke-repo`, and migrated `main-pc-work/archon-hermes-v2` / `main-pc-work/archon-bench`. These are staging, operations, reference, or smoke-test material; no Desktop release is inferred from their directory names or generic design-template package versions.

## Legacy MiniPC installations and backups

Only MiniPC `resources/app.asar` → `package.json` was inspected. No application was launched and no preferences or credentials were read. These entries are not evidence of AbdullahPC's installed build and are classified as legacy.

Paths are relative to the MiniPC's `~/Applications/`:

| Installation / backup directory | Embedded version |
| --- | --- |
| `archon-desktop` | **1.0.0** |
| `archon-desktop-prime` | **1.0.0** |
| `archon-desktop-prime.pre-final-20260830023057` | 1.0.0 |
| `archon-desktop-prime.pre-no-token-20260830023026` | 0.6.1 |
| `archon-desktop-prime.pre-update-20260827052721` | 0.6.1 |
| `archon-desktop.pre-no-token-20260830023026` | 0.4.2 |
| `archon-desktop-prime.backup-1787357920` | 0.4.1 |
| `archon-desktop-prime.pre-buffer-fix-20260819` | 0.4.0 |
| `archon-desktop-prime.pre-isolation` | 0.4.0 |
| `archon-desktop.backup-clipboard-20260818052405` | 0.4.0 |

Matching version labels do not establish matching source, hashes, runtime behavior, or which launcher is in use. The installed 1.0.0 archives have not been compared byte-for-byte with a fresh build.

## Legacy label evidence (not official release ordering)

- **0.2.0 desktop:** retained as prior-installation/rollback provenance in the 0.3.0 release README; its historical installation path was not verified in this pass. Do not confuse this with backend package 0.2.0.
- **0.3.0:** original and intermediate Settings/Sessions refinements remain legacy; the **unified-refresh** archive is now verified as the current AbdullahPC baseline. Other 0.3.0-labeled artifacts are not automatically current.
- **0.3.1:** wrapper/spec version in the early standalone client; not independently established as a published binary release.
- **0.4.0:** original/Prime client source and local AppImage/deb artifacts; several installed rollback archives retain this label.
- **0.4.1:** local Prime AppImage/deb artifacts and an installed rollback archive.
- **0.4.2:** Prime source, local AppImage, and an installed rollback archive. The Prime workspace wrapper has now been aligned to the app's existing 0.4.2 version; this is not a new release.
- **0.5.0:** referenced by the previous main README's launch example only; no corresponding artifact verified. Treat as an unverified historical reference.
- **0.6.1:** main Git commit `17574cd` (2026-07-26), testing/verification copies, local Linux AppImage/deb artifacts, and installed rollback archives.
- **1.0.0:** legacy main desktop source, local Linux AppImage/deb artifacts, and both MiniPC installed application directories. The backend source update-version default has now been aligned to official 0.3.0; live configuration is unchanged.

The July 26 0.6.1 commit predates some lower-numbered August Prime builds. These inconsistent historical labels are preserved as provenance only; the owner's v0.3.0 designation now determines the official baseline, not numeric sorting.

## Git provenance

| Checkout | Last existing commit inspected | Remote configured |
| --- | --- | --- |
| Main backend + desktop | `c70e43b` — 2026-08-08, recovery snapshot before v2 rebuild | `Abdullahalmutairi97/archon-desktop` |
| Prime client | `0608365` — 2026-08-18, Prime-only current-build snapshot | `Abdullahalmutairi97/archon-desktop` |
| Standalone client | `663a527` — 2026-08-04, desktop help flag | `Abdullahalmutairi97/archon-desktop-client` |

The main and Prime directories target the same remote but have different layouts and histories. **Do not force-push one over the other.** The authoritative final-stage recipe is now imported into `current/`; earlier original-source recovery and authenticated remote-history review remain pending. Unmatched trees are preserved as legacy without moving, overwriting, or publishing them.

The main maintenance branch is `chore/repository-refresh-20260908`. Existing changes are included in the authorized source sync; the separate Prime line is preserved as `legacy/prime-0.4.2-20260908`. No release tag is created by this synchronization.
