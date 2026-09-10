# Repository verification — 2026-09-08

**2026-09-10 candidate update:** see the [candidate ledger](releases/v0.3.0-candidate.md) and [readiness audit](../current/testing/readiness-audit.md). The newer candidate has 20 passing current-kit tests with the actual archive and a successful two-client PeerJS UI transfer. This supersedes older test counts for the candidate only; the installed baseline is unchanged. Historical results below are not fresh checks.

**Publication follow-up:** GitHub sign-in is now configured and the owner authorized source synchronization. See [publication.md](publication.md) for branch targets, fresh pre-push checks, and exclusions. The blocked/not-pushed statements below record earlier maintenance stages.

## Scope and provenance

Repository/documentation maintenance on the MiniPC, not a deployment. Main branch created: `chore/repository-refresh-20260908`, based on existing recovery commit `c70e43b`, carrying all pre-existing local changes intact. Separate Prime and standalone-client checkouts were not merged into this tree.

The earlier inspection found **MiniPC** archives labeled 1.0.0, main source labeled 1.0.0, and Prime source labeled 0.4.2. Those labels are now classified as legacy. The owner subsequently confirmed **AbdullahPC's current build as official v0.3.0**; that decision supersedes any earlier suggestion that the MiniPC's highest number identifies the latest release. See [versions](versions.md) and the [baseline record](releases/v0.3.0.md).

Before editing, affected existing READMEs/manifests/ignore files were copied to a private local maintenance backup under `~/.local/state/archon-repo-maintenance/`. No credentials or runtime data were copied.

## Initial maintenance verification

| Check | Result |
| --- | --- |
| Main desktop `npm --prefix desktop test` | **86 passed**, 23 files |
| Main desktop `npm --prefix desktop run typecheck` | Passed |
| Main desktop `npm --prefix desktop run build` | Passed |
| Backend `python3 scripts/test-backend.py` | **168 passed** |
| Prime pre-change unit suite | **62 passed** |
| New Prime repository regressions before repair | **2 failed**, as expected: version mismatch and nonexistent-backend setup |
| Prime final `npm test` | **64 passed** |
| Prime final `npm run build` (includes typecheck) | Passed |
| `git diff --check`, main / Prime / standalone client | Passed |
| Main private-file ignore checks | Environment backups, runtime env, attachments, resource/history backups ignored; `.env.example` retained |
| Main new-document relative links | Checked locally |
| New GitHub Actions YAML | Parsed locally; desktop/backend jobs present; **not run on GitHub** |

Toolchain: Node 22.23.1, npm 10.9.8; backend virtualenv Python 3.13.

### Warnings and test-harness correction

- Main desktop unit run emits jsdom's unimplemented canvas `getContext()` warning; the tests pass, but canvas rendering is not thereby verified.
- Prime production build reports bundles over 500 kB. Main renderer output is also large (approximately 1.8 MB JS); no performance claim is made.
- An initial backend invocation applied overly broad isolation environment overrides. It caused three fixture failures: the account-home default test and two shutdown tests whose workers were disabled by the override. Inspecting those tests identified the harness problem. The new test helper preserves worker/account-home semantics while isolating default data/history/resource paths; the subsequent full suite passed 168 tests. No production implementation was changed to mask these failures.
- An early documentation-link check ran before this report existed and found its pending links. Final validation passed across 11 documents, including this report.

## Changes made in this pass

- Rewritten main README plus new backend and desktop READMEs.
- Rewritten separate Prime and standalone-client READMEs with explicit lineage/status caveats.
- New changelog, work-history index, version/installation inventory, contribution guide, release checklist, and this report.
- New main offline CI workflow and isolated backend fixture-test helper.
- Main/Prime ignore rules for private recovery/configuration material and generated bundles.
- Prime root/app script and description repair, root version alignment to existing app 0.4.2, and two repository regression tests.

Historical snapshot READMEs, upstream design-reference READMEs, and old handoff/validation reports were preserved as evidence rather than rewritten as current guarantees. Existing user code was not broadly reformatted, discarded, or relabeled.

## Initial maintenance exclusions (before baseline verification)

- GitHub fetch/history/release inspection: HTTPS authentication was unavailable (`could not read Username`). No account was connected automatically.
- No commit, staging, push, tag, release upload, or force-push.
- No clean dependency reinstall, Linux packaging, installed-source hash comparison, graphical screenshot/smoke, or fresh live API checks.
- No tests/builds for the separate standalone-client checkout; only its README was updated.
- No service restart, installation, cron change, database migration, agent prompt, session deletion, or preference change.
- No full audit of pre-existing source changes, tracked history, dependency security, licenses, or private operational reports. Ignore rules are not a publication clearance.

## Follow-up: verified official v0.3.0 baseline

After the owner approved Tailscale SSH, read-only inspection confirmed AbdullahPC's launcher targets `archon-desktop-prime`, its package already says **0.3.0**, and its entire ASAR matches the local saved **unified-refresh** release. No installed-app renumbering was necessary.

The first connection attempt required interactive approval and timed out; the subsequent authorized attempt succeeded. No credentials, preferences, or session data were inspected or copied.

### Current verification

| Check | Result |
| --- | --- |
| AbdullahPC installed archive vs saved unified-refresh archive | Exact SHA-256 match |
| Current-kit unit tests, `npm test` | **7 passed**, including original component assertions and six recipe/metadata tests |
| Kit dependencies | Lockfile generated and `npm ci --ignore-scripts --offline` completed from local cache |
| Fresh final-stage reconstruction | **Byte-identical** to AbdullahPC, SHA-256 `36d3ae03bd6b20c4e9ea5fc690461ef972b16eb0c9433bfb1305daeb068e549b` |
| Existing-output CLI guard | Refused an already existing output; preserved artifact |
| Backend version-default regression before change | Failed as expected: legacy 1.0.0 vs official 0.3.0 |
| Final backend fixture suite, `npm run test:backend` | **169 passed** |
| Documentation links/anchors, whitespace, CI YAML structure | Checked locally; GitHub workflow not executed remotely |

The recipe tests initially failed because the portable builder did not yet exist; after implementation they passed. The backend source default was then changed to 0.3.0 with a failing-first regression against the baseline manifest. Live environment overrides and update feeds were not changed.

### Imported and preserved

- Added `current/`: exact editable refresh component, six guarded substitutions, portable recipe, pinned ASAR packer/lockfile, tests, and baseline manifest.
- Added root version-0.3.0 wrapper commands pointing to `current/`, not the legacy desktop.
- Added current-kit CI tests and ignored generated archives/dependencies.
- Preserved all legacy source packages, installations, snapshots, launchers, and original numbers as provenance.
- The local collection is mixed: its matching unified-refresh artifact is current; other artifacts sharing the 0.3.0 label remain legacy.

### Limitations

This is a **verified final-stage reconstruction**, requiring the frozen parent archive—not a complete TypeScript-source recovery. The generated ASAR lives outside Git at `/tmp/archon-v030-verified-20260908/app.asar`; it is not a full new Electron/AppImage/deb distribution. ASAR 3.4.1 reproduces the historical archive but emits npm deprecation warnings for transitive `glob`/`inflight`; no dependency-security certification is claimed.

No new graphical/live UI checks, full Electron distribution packaging, installation, restart, release/tag, commit, or push were performed. Earlier main/Prime build results above remain initial maintenance evidence, not fresh graphical checks of this baseline.

## Next steps before publication

1. Restore approved GitHub authentication, inspect remote history, and review source/private operational notes before staging.
2. Consolidate earlier source/override stages for a complete original-source workflow; preserve the verified parent/final artifacts as approved release assets outside Git.
3. Validate updater/reset behavior for legacy devices carrying higher numeric labels.
4. Complete isolated graphical/full-distribution packaging checks as separately approved.
5. Obtain commit/push/release approval and follow [releases](releases.md).
