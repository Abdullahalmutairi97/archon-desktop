# HANDOFF — continuing the Archon Desktop reconstruction

You are continuing work another agent started. Read this whole file before acting.

## Repository and remote

- Working tree: `/home/archonminipc/projects/cookie-project/workspace/work/phase2c6-integration`
- Remote: `Abdullahalmutairi97/archon-desktop` (private), branch `codex/phase-2c6-exact-file-approvals`, PR **#28**.
- The local git history is an **imported reconstruction**: its ancestry does **not** match the remote. **Never `git push`.** Publish with the API publisher (below), which rebuilds the remote tree from your local `HEAD` and the remote tree and preserves file modes.

### Publish

```bash
git -C <repo> add -A && git -C <repo> commit -m "..."
python3 scripts/publish-to-remote.py Abdullahalmutairi97/archon-desktop codex/phase-2c6-exact-file-approvals
```
Then check CI and mergeability:

```bash
gh pr view 28 -R Abdullahalmutairi97/archon-desktop --json headRefOid,mergeable,statusCheckRollup
```
Do not merge, deploy or release. Target: every change is committed, published, and CI-green.

## How to run things (exact commands)

- Desktop (Node **24** is required; default node is 22):
  ```bash
  cd <repo>/desktop
  export PATH="/home/archonminipc/.local/share/prime-node/node-v24.21.0/bin:$PATH"
  ( umask 0022; npm run typecheck && npm test && npm run licenses:check && npm run build )
  ```
- Backend (Python 3.14 venv):
  ```bash
  cd <repo>/backend
  ( umask 0022; ./.venv/bin/python -m pytest tests -q )
  ```
- Frozen v0.3.0 kit + canonical/visual harnesses:
  ```bash
  cd <repo>/current
  export PATH="/home/archonminipc/.local/share/prime-node/node-v24.21.0/bin:$PATH"
  ARCHON_V030_ASAR=/home/archonminipc/projects/archon-desktop-v0.3.0/unified-refresh/app-v0.3.0-unified-refresh.asar \
    node --test refresh.test.cjs tests/*.test.cjs
  # canonical-compare.cjs is a Node script, not Python.
  node testing/canonical-compare.cjs "$ARCHON_V030_ASAR" /tmp/candidate.asar
  # rebuild a candidate first (from the repository root):
  npm run build:candidate -- "$ARCHON_V030_ASAR" /tmp/archon-v030-candidate.asar
  ```
- `umask 0022` matters: a `0002` umask makes a permission-ancestry test fail.

## Progress since this handoff was written

Fifteen slices are committed on the branch (this list plus the handoff update);
each was checked locally (backend `pytest`, desktop `typecheck && test &&
licenses:check && build`) and published with the API publisher, and CI is green
on the head.

- **P5 secret broker** (done): isolated credential-holding broker, single-use
  grants bound to principal/tool/argument digest/attempt/workspace
  generation/ledger epoch, the broker performs the upstream call itself, bounded
  and redacted results, a private 0600 ledger, owner-only routes, a runner
  delegation channel and scoped provider auth states. An independent adversarial
  review found one medium and eight low defects; the medium (a credential echoed
  as a JSON object key reached the caller) and five lows are fixed with tests.
- **P3 write lease** (mostly done): file save/create, workspace service start, the
  code-server handoff and terminal creation each require the lease and refuse a
  competing live holder (409) before writing, with a blocked-handover test each.
  Kernels/debugger processes have no implementation to fence, and existing tmux
  children are not revoked by a later handover.
- **P3 isolation** (mostly done): host evidence record plus probe-verified
  enforcement for services — memory, CPU quota, task limit, workspace-only
  filesystem confinement and no-network isolation. Each declared control is
  refused before launch unless the probe observed it. Reproduced end to end with
  real services (denied `/tmp` write; `ENETUNREACH`). The agent-runtime profile
  (a sandboxed Prime/Pi child) is still unimplemented.
- **P2D** (mostly done): two fresh `npm ci` workspaces built byte-identical
  packages, and `desktop/scripts/native-hostile-frame-check.mjs` runs the real
  app and passes twelve checks. Two gates are **blocked on this host and recorded,
  not worked around**: the Chromium OS sandbox (no setuid helper; AppArmor blocks
  unprivileged user namespaces) and the native keyring (Electron selects no
  protected Linux backend, so the store degrades to memory-only).
- **P4 language profiles** (partial): four pinned extensions are licence- and
  digest-verified and installed, an owner-only endpoint reports honest states and
  gaps, and the desktop shows the same record. No breakpoint/debug flow is
  exercised, and Pylance cannot be provided here.
- **P1** (partial): native Prime session leases are compatible in both directions
  against the installed Prime Agent module; migration evidence covers duplicate
  project mappings, native ids, tombstones and queued/running tasks. An explicit
  resume exercised end to end through the API is still missing, as are some
  import/rollback shapes.
- **P6–P8**: not started. The operator deferred these earlier; confirm before
  starting either of them.

One publish attempt hung on a network read for ten minutes; killing it and
re-running the publisher was safe and produced the expected commit. Check that a
publish actually printed its commit line before polling CI.

## What is done (do not redo)

- **Attach**: one-use tickets → single server-fenced control lease → read-only denial → bounded key frames → main-relayed streaming.
- **Workspace services**: validated definitions, supervised processes, bounded logs, loopback health probe, `on-failure` restart, **enforced memory budget** (`systemd-run --user --scope -p MemoryMax=<n>M -p MemorySwapMax=0`; the probe must observe enforcement).
- **Private preview**: ticket gateway, bounded HTTP proxy (allowlisted headers, no off-origin redirects, cookies stripped), **WebSocket forwarding** with a local-origin check, **sandboxed native `WebContentsView`** (own partition, no preload).
- **Editor**: observed-content conflict detection + bounded local draft recovery.
- **Multi-machine runner (end-to-end)**: enrollment (private ledger, one-time secret) → secret-authenticated runner channel → durable per-runner outbox (dedup, generation-fenced) → remote worker loop (`scripts/runner_agent.py`) → owner dispatch → idempotent results ledger → liveness.
- **Full IDE**: code-server **4.139.1** installed at `~/.local/opt/code-server-4.139.1`; register on demand via `POST /api/local/workspaces/{id}/services/code-server`, then start + preview.
- **Workspace write lease**: exclusive, expiring, holder-scoped.
- **P5**: Prime + Pi qualify on DeepSeek Flash; Hermes on its own provider; adapter manifests published.
- **P2**: frozen v0.3.0 ASAR hash-exact, 88/88 kit tests, candidate build, canonical comparison, native capture (99.27% identical).
- **Resource summary**: `GET /api/local/workspaces/{id}/resources`.

Guiding constraints read from `AGENTS.md`, `docs/roadmap/*` and `docs/releases/*`: **fail closed**, never claim native/parity evidence you did not produce, no fabricated screenshots, no token in renderer storage, no arbitrary command execution from renderer input, no silent retries of ambiguous actions.

## What is left (highest value first)

1. **Agent-runtime isolation qualification** — the profile exists
   (`ARCHON_DESKTOP_RUNTIME_ISOLATION_PROFILE=workspace-only`, off by default): a
   Prime/Pi task child starts inside bubblewrap with a read-only host, and only its
   checkout, session directory and a private temp directory writable. The probe
   proves the mechanics and the run is refused when they are unavailable, and a
   sandboxed fake runtime is exercised in `backend/tests/test_runtime_isolation.py`.
   What remains is qualification: run a real provider turn inside the profile, then
   record the result. Until that happens, do not describe the profile as qualified
   or turn it on by default.
2. **P4 debug flow** — blocked on evidence only a human can produce. The server cannot
   start a session (no code-server session flag, no DAP implementation), so the report
   states the adapter artefact, the unsupported features and the IDE launch inspection,
   with `sessionExercised`/`breakpointVerified` as false constants the desktop validator
   refuses to see flipped. To close the bullet, run a debug session in the workspace IDE
   once and record what was observed; do not turn those constants on without that. Also
   open: Pylance is proprietary and absent, and there is no JavaScript debugger pin.
3. **P3 resource accounting and lease remainder** — the owner-only resources summary now
   covers services, terminals and agent tasks bound to the checkout, and names what it
   cannot see (language servers inside the IDE process, kernels inside a runtime, native
   processes outside the manager). Still open: fence the writers the lease does not reach:
   kernels, debugger/run tasks (no implementation exists to fence yet) and existing
   detached tmux children, which a later handover does not revoke.
4. **P2D blocked gates** — the Chromium OS sandbox and the native keyring need a
   host that provides them (setuid `chrome-sandbox` or unprivileged user namespaces;
   a protected Linux secret-service backend). Both are recorded in
   `docs/releases/p2d-fresh-builds.md`. Re-run the native check on such a host.
5. **P1 evidence remainder** — the explicit resume path and the snapshot
   restore/import procedure are now covered end to end
   (`backend/tests/test_resume_evidence.py`, `test_migration_restore_evidence.py`).
   The one shape a reviewer may still ask for is duplicate project *names*, which live
   in the separate Hermes projects database that the Archon migration never reads.
6. **P5 remainder** — event normalization and the approval binding are done
   (bounded diagnostics for unreadable or unhandled native records; the Codex
   approval broker binds each prompt to its request id, process generation and exact
   action, and denies stale, replayed, unauthorized and expired decisions). What is
   left is that no tool/MCP adapter consumes the broker yet. The two-channel bypass
   check is now
   *measured*, not demonstrated: the environment channel is filtered and the server
   clears its dumpable flag so `/proc/<server>/environ` is denied to other same-uid
   processes, but ledger-retarget (reproduced), the pairing socket and direct provider
   reachability stay open for anything running as the service account — see
   `docs/releases/p5-same-uid-exposure-evidence.md`. Closing it needs an enforced OS
   boundary around every workspace-capable process or real upstream scopes.
7. **P6–P8** — collaboration, release/ops qualification, enhancements (currently
   unstarted; the operator deferred these earlier — confirm before starting).

### Gates that must not be reported as passed

- Chromium OS sandbox on this host: blocked (`chrome-sandbox` is not setuid, and
  `kernel.apparmor_restrict_unprivileged_userns=1`).
- Native keyring persistence on this host: blocked (Electron selects no protected
  Linux backend; the store keeps the token in main-process memory and writes
  nothing). The fallback behaviour is verified; the protected path is not.
- Baseline parity with the frozen v0.3.0 app: the build manifest still says
  `baselineParity: unverified`.
- Real provider turns under any new isolation profile: not run.
- Broker isolation against a same-uid process: not achieved. The named-tool and
  environment channels are filtered and `/proc/<server>/environ` is denied; the ledger,
  the pairing socket and direct provider access are not.

## Host changes made on this machine (outside the repository)

These are deliberate operator-visible changes, each reversible:

- `~/.config/systemd/user/archon-desktop-prime.service.d/proc-privacy.conf` puts
  `~/.local/share/archon-proc-privacy` on that unit's `PYTHONPATH`, whose
  `sitecustomize.py` clears the process dumpable flag at interpreter start. Verified:
  the restarted server's `/proc/<pid>/environ` is `PermissionError`, its `/proc/<pid>/stat`
  is still readable, the unit is active and `/api/health` answers 200. Rollback: delete
  the drop-in and the directory, then `systemctl --user daemon-reload` and restart.
- The workspace-service extensions (code-server 4.139.1 and four digest-verified VSIX
  files) are installed under `~/.local/share/code-server/extensions`.
- Portable preview packages were built under `desktop/release/` (git-ignored); the newest
  one, commit `63c6ab0`, has sha256
  `978146586c7f15065fc7913d2868d05054f03e86eb97782d3bcc7133a3fcf9b7` and passes the
  native check 13/13.

Still exposed to same-uid readers on this host, and not fixed here: an unrelated auth
service (`GOTRUE_JWT_SECRET`, `GOTRUE_EXTERNAL_APPLE_SECRET`), the agent-harness
processes, and each unit's own 0600 `EnvironmentFile`.
- Debug session under the workspace IDE: never exercised. `ms-python.debugpy` is pinned
  and installed, but Archon has no debug-launch surface and code-server exposes no
  session flag, so no breakpoint, DAP message or adapter activation has been observed.

## Practical notes

- Reviewers reject privileged surfaces that are half-built; land a coherent slice with tests, not a partial feature.
- Prefer bounded, expiring, owner-checked private (0600) ledgers for new state, mirroring `runner_outbox.py` / `workspace_write_lease.py`.
- Node 24 for desktop; Python 3.14 venv for backend; keep the frozen `current/` kit and its official hashes unchanged.
