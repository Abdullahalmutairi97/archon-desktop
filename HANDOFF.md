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
2. **P4 debug flow** — a breakpoint/debug flow for the workspace IDE. `ms-python.debugpy`
   is pinned and installed, but Archon exposes no debug-launch surface and no debug
   session has been exercised, so the roadmap box stays open. Also open: Pylance is
   proprietary and cannot be provided from this marketplace, and there is no
   JavaScript debugger adapter pin.
3. **P3 write-lease remainder** — fence the writers the lease does not reach:
   kernels, debugger/run tasks (no implementation exists to fence yet) and existing
   detached tmux children, which a later handover does not revoke.
4. **P2D blocked gates** — the Chromium OS sandbox and the native keyring need a
   host that provides them (setuid `chrome-sandbox` or unprivileged user namespaces;
   a protected Linux secret-service backend). Both are recorded in
   `docs/releases/p2d-fresh-builds.md`. Re-run the native check on such a host.
5. **P1 evidence remainder** — the explicit resume path is now covered end to end
   through the admission API (`backend/tests/test_resume_evidence.py`). Still open:
   the migration import/rollback shapes beyond the snapshot cases, and duplicate
   project *names*, which live in the separate Hermes projects database that the
   Archon migration never reads.
6. **P5 remainder** — event normalization is done (bounded diagnostics for
   unreadable or unhandled native records). An approval binding for the adapters
   themselves is still open, and no tool/MCP adapter consumes the broker yet, so the
   two-channel bypass check (named tool versus shell/direct HTTP) is not
   demonstrated.
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

## Practical notes

- Reviewers reject privileged surfaces that are half-built; land a coherent slice with tests, not a partial feature.
- Prefer bounded, expiring, owner-checked private (0600) ledgers for new state, mirroring `runner_outbox.py` / `workspace_write_lease.py`.
- Node 24 for desktop; Python 3.14 venv for backend; keep the frozen `current/` kit and its official hashes unchanged.
