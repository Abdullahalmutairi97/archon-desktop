# Source synchronization — 2026-09-08

The owner authorized committing and pushing the Archon updates. GitHub authentication is now configured through GitHub CLI's credential-store-backed login; both repositories were confirmed private with owner access. No credentials were copied into source or passed in remote URLs.

## Branch map

| Repository | Branch | Purpose |
| --- | --- | --- |
| `Abdullahalmutairi97/archon-desktop` | `main` | Current v0.3.0 reconstruction kit, shared backend, documentation, and preserved legacy desktop source |
| Same repository | `chore/repository-refresh-20260908` | Maintenance branch carrying the same synchronized source |
| Same repository | `legacy/prime-0.4.2-20260908` | Separate Prime client history, explicitly legacy; not merged over the main layout |
| `Abdullahalmutairi97/archon-desktop-client` | `main` | Standalone legacy client updates and corrected README |
| Same repository | `chore/legacy-client-sync-20260908` | Maintenance branch for that client sync |

Both main-branch updates are intended as ordinary fast-forwards from the inspected remote history. No force-push, default-branch change, release tag, artifact upload, deployment, or restart is part of this sync. The GitHub branch refs are the final authority for whether a push completed.

## Fresh pre-push checks

- Current v0.3.0 kit: **7 tests passed**.
- Backend: **169 tests passed**.
- Legacy main desktop: **86 tests passed**, typecheck/build passed.
- Prime client: **64 tests passed**, typecheck/build passed.
- Standalone client: **88 tests passed**, typecheck/build passed.
- Existing canvas-test and large-bundle warnings remain; these checks are not new graphical/live verification.
- Staged whitespace checks caught trailing spaces/blank lines in five previously untracked source/test files. Those were trimmed without behavior changes, and the affected tests were rerun.
- Current source trees and outgoing historical blobs were checked for common credential/key patterns without printing secret values. Apparent credential-literal matches were shell-generated values and test fixtures. Reference ZIP filenames and known-key patterns were also checked. This limited scan is not a comprehensive security audit.

## Excluded intentionally

- Environment files/backups, credentials, session/history/recovery data, live screenshots, generated binaries, dependencies, and local audit output.
- The standalone client's untracked `LICENSE` file: it proposes MIT licensing while app metadata remains `UNLICENSED`. It is left local pending an explicit licensing decision, not silently published.

Source updates include existing local backend/client work and the new baseline kit/documentation. Old build numbers remain legacy provenance. The installed AbdullahPC archive is unchanged. Earlier maintenance documents' "not pushed" and authentication-blocked notes describe the initial work; this synchronization record supersedes those as the publication plan.

For the exact v0.3.0 identity and reconstruction limitations, see [the baseline record](releases/v0.3.0.md). A clone still needs the verified frozen parent archive for full ASAR reconstruction; source synchronization does not upload that artifact.
