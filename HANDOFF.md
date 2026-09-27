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
  python3 testing/canonical-compare.cjs "$ARCHON_V030_ASAR" /tmp/candidate.asar
  ```
- `umask 0022` matters: a `0002` umask makes a permission-ancestry test fail.

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

1. **P5 secret broker** — isolated credential-holding channel so tool/MCP calls never receive raw secrets; scoped provider auth states; event normalization; approval binding to action digest/attempt/generation.
2. **P4 debugger + language profiles** — pinned extensions with licensing/source verification for code-server; honest "unknown/unsupported feature" reporting.
3. **P3 write-lease enforcement** — require the lease in every write path (file writes, services handoff, kernels/debuggers) and test a blocked handoff.
4. **P3 isolation qualification** — demonstrate filesystem/network/CPU/PID controls around a runtime on this host, or record the gate as blocked.
5. **P2D** — native keyring + hostile-frame tests; two fresh `npm ci` package builds for reproducibility.
6. **P1** — native Prime lock compatibility and the remaining evidence tests.
7. **P6–P8** — collaboration, release/ops qualification, enhancements (currently unstarted; the operator deferred these earlier — confirm before starting).

## Practical notes

- Reviewers reject privileged surfaces that are half-built; land a coherent slice with tests, not a partial feature.
- Prefer bounded, expiring, owner-checked private (0600) ledgers for new state, mirroring `runner_outbox.py` / `workspace_write_lease.py`.
- Node 24 for desktop; Python 3.14 venv for backend; keep the frozen `current/` kit and its official hashes unchanged.
