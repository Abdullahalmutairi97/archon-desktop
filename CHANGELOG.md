# Changelog

## Unreleased — Chat, Sessions, Tasks and Projects show live server work

- In the desktop app, the Chat, Sessions, Tasks and Projects views and the sidebar now show live server data instead of synthetic fixtures; the browser preview (no desktop bridge) keeps the labelled demo. Not-connected, rejected and failed states point to the Connection view and never mix in sample data.
- Open a server conversation to read its transcript (thinking, tool and native records collapsed; all content rendered as text with `dir="auto"`) and continue it. The follow-up is sent once, the task is followed with bounded polling and can be cancelled, and the transcript reloads when it ends; an ambiguous send is never retried, and the composer stays locked while a task runs.
- Start a new server conversation in a registered project with a runtime the server reports as available. Read-only (`pi-native-*`), review-required and unverified conversations are labelled and cannot be continued.
- Bridge: new read-only `sessions.messages` operation (`GET /api/sessions/{id}/messages?limit=`, 1..500, exact message records, 2 MiB content bound). `tasks.submit` now accepts a `sessionId` (continue; the server keeps the conversation's runtime) or a `runtime` (`prime`/`pi`, new conversation), validated strictly and never combined with a checkout.
- Verified in the built Electron app against an isolated backend with fake runtimes: live sidebar, transcript, a continued turn from queued to answered, tasks and projects, in both LTR and RTL. The last physical left/right style rules now use logical sides.

## Unreleased — the preview gateway streams

- The private preview gateway streams proxied responses as they arrive (event streams, long polls, chunked HMR, large assets) instead of buffering up to 24 MiB per request, for loopback-port and unix-socket targets alike, using a bounded standard-library HTTP/1.1 exchange.
- A response is still capped at 24 MiB: a body that passes the cap mid-stream is aborted (no terminating chunk), never cut and presented as complete, and a declared `Content-Length` over the cap is refused with 502. The `x-archon-preview-truncated` header is gone.
- A streamed response is re-checked against the live ticket binding every 2 s, like preview WebSockets: stopping or removing the service, a generation change or ticket expiry ends it, and the target connection is always released. The gateway waits up to 60 s for a response head or the next chunk; an unreachable or stalled target answers 502 instead of 500.

## Unreleased — a write-lease handover waits for detached writers

- A write-lease handover now refuses (409 `workspace_detached_writers`) while any same-user process has its working directory in the checkout or a checkout file open for writing — `nohup`/`setsid` jobs and editors started from a shell included. A process that only reads is not counted.
- `quiesce` also stops detached writers that provably descend from the workspace's own terminal or service (parent chain or session, matched by pid and start time; SIGTERM, then SIGKILL, then verified gone, signalled through a pidfd). A writer Archon cannot prove it started is never killed and keeps blocking; nothing is stopped when any such writer exists.
- A scan that cannot finish (`/proc` unreadable, timeout, too many processes or descriptors) refuses the handover (409 `workspace_writer_scan_incomplete`) instead of assuming the checkout is quiet. Processes that hide their `/proc` details are reported under `detachedWriters.unknown`; they block only when they provably descend from the workspace's own terminal or service.
- Lease status, lease acquire and the workspace resources summary report `detachedWriters` (count, up to 32 entries, unknown processes). Lease refusals are structured JSON (`detail`, `code`, `writers`, `detachedWriters`); `detail` keeps its previous text.

## Unreleased — workspaces report their owner and where HEAD points

- `GET /api/workspaces` and `GET /api/workspaces/{id}` accept `?include=checkout` and then add the recorded `owner_id` and a `checkout` record: `branch` (with its name), `detached` (with the full commit and whether it is still the provisioned revision), or `unknown`. HEAD is read from `.git/HEAD` directly — no Git process, hook or configuration from the writable checkout runs — and a linked or symlinked Git directory, an oversized or non-regular HEAD, or an unusual ref is `unknown`, never a guess. Without the parameter the record is unchanged, so an older desktop keeps validating it.
- The desktop requests the new fields and its Server work view now shows, per checkout, `Owner: local-uid:1000 · Branch: detached at ec95c608eba8 (provisioned revision)`, `on feature/review`, `moved since provisioning` or `unknown`, instead of `unavailable`. It accepts either record shape from the server and refuses a malformed checkout record.

## Unreleased — confined services and runtimes can no longer reach the host through IPC

- **Security fix.** A service with `filesystemIsolation: "workspace-only"` (and a runtime under `ARCHON_DESKTOP_RUNTIME_ISOLATION_PROFILE=workspace-only`) ran with the host bound read-only, but a read-only mount does not stop `connect()` on a unix socket. From inside the sandbox, `systemd-run --user` over the session bus wrote a file outside it (reproduced on the target workstation), and the docker socket (root-equivalent for this account), libvirt, the system bus, tmux and runtime-daemon sockets in `/tmp`, the code-server IDE socket under the data directory, `~/.ssh` keys and the running server's own environment file were all reachable. A process that daemonized (Prime 0.9.6 starts one) also outlived the run in the sandbox's mount namespace.
- Every confined view now runs in its own PID namespace (nothing started inside outlives the command or can signal host processes), replaces `/run`, `/tmp`, `/var/tmp` and `/dev` with private empty ones (the systemd-resolved directory is re-exposed read-only so names still resolve), and hides the account's home directory. Only what the confined program needs to start is shown again, read-only: its symlink chain, its install tree (a Node package is shown whole) and its `#!` interpreter, resolved on the child's `PATH`.
- A writable root that is `/`, the home directory, or contains a hidden location is refused instead of silently undoing the mask; a service start answers 503 and a runtime run is not started.
- The runtime profile shows the runtime's own native home (`~/.prime`, `~/.pi`) through a discarded write layer (`bwrap --tmp-overlay`, bubblewrap 0.10 or later): its lock files work, and its settings and credentials on the host cannot be rewritten. Without that, Pi and Prime both failed at startup (`EROFS` on `settings.json.lock`). New setting `ARCHON_DESKTOP_RUNTIME_ISOLATION_READABLE_PATHS` shows extra host paths read-only (for example an extension package loaded from outside the runtime's install tree).
- The behavioural probe gains three legs: sockets the probe serves in `/tmp` and in the runtime directory (where the session bus lives) must refuse a connection from inside, a process detached inside must not survive the sandbox, and for runtimes a write to the private native home must leave the host copy unchanged. The probe no longer binds the whole of `/tmp` writable.
- Limits: the network namespace is still shared unless `networkIsolation: "isolated"` is declared, so loopback and LAN services and abstract unix sockets stay reachable; the host outside the hidden locations stays readable. See `docs/releases/p3-host-isolation-evidence.md`.

## Unreleased — stale work can be stopped when a runtime identity changes

- Add owner-only `GET /api/local/resources/stale-work`, which judges every queued and running task against the runtime identity installed now: a running task by the digest its newest attempt snapshot recorded, a queued task by its conversation (it would resume under the changed identity). Only a `stale` state is marked `stop`; unrecorded work is reported and kept, and a task already cancelling is left alone.
- Add owner-only `POST /api/local/resources/stale-work/stop` with `{"confirm": true}`. It cancels each stale task through the engine's existing cancel path, which records the intent first and, for running work, waits for the runner to reap the process group, then reports `cancelled`, `cancel-requested` or `failed` per task. Nothing restarts the work automatically: a resume of that conversation is still refused, and the owner starts a new one.

## Unreleased — approved install requests are provisioned through a managed store

- Add owner-only `POST /api/local/resources/install-requests/{id}/provision` with `{"artifact": "<file name>", "confirm": true}`. The artefact is a bare file name in the staging directory (`ARCHON_DESKTOP_RESOURCE_STAGING_DIR`, default `<data_dir>/resource-staging`, private 0700); it must be a regular file owned by and writable only by this account, and is opened without following links. Its bytes are hashed while they are copied into `<data_dir>/resource-store/objects/<sha256>` (read-only; owner-executable for a runtime), and nothing is kept unless they match the approved digest. `current/<name>` is then switched to it with an atomic link replace.
- An approval now binds the digest the definition declared when it was given (`approvedDigest`). Provisioning refuses when the definition changed afterwards, when the request is not approved, when it was already provisioned (an update needs its own request), for a configuration-only kind, and when the policy denies `resource.install.<name>`. Only a successful activation sets `installationPerformed`, `installedBy` and `installation` on the row.
- Add owner-only `GET /api/local/resources/store` (staging location, active and retained digests, history) and `POST /api/local/resources/store/{name}/rollback` with `{"confirm": true, "digest"?}`, which re-hashes a retained object before switching back and is gated by `resource.rollback.<name>`. A modified object is never activated.
- Verification of an approved request now also measures the managed store's link (by hashing it) when no runtime manifest or editor extension measures the name. A runtime the registry measures is still measured at its configured executable, so the store does not change what runs until the operator points that setting at `current/<name>`.
- Limits: nothing is downloaded, unpacked or executed; an extension is stored but not registered with the editor; attempt snapshots still measure only runtime manifests and extensions.

## Unreleased — diagnostic records are encrypted at rest

- The diagnostic capture ledger (`GET/DELETE /api/local/diagnostics`) is now written as an AES-256-GCM envelope under a random key drawn when the server starts and held only in its memory. A copied data directory or backup carries no readable record: not the detail, the kind, the task or the runtime. Each write uses a fresh nonce, and the envelope's authenticated data binds its version and key id.
- A ledger left by an earlier process cannot be decrypted after a restart; it is deleted once and counted in `discardedUnreadableLedgers`, exactly as if its records had expired. A ledger under the current key that fails authentication is tampering and answers 503. The status reports `encryptedAtRest`, the cipher and `keyScope: process-memory`.
- The key's protection against another process of the same account rests on the server clearing its dumpable flag, which denies `/proc/<pid>/mem`; it is not an OS boundary.
- New backend dependency: `cryptography` (lockfile updated). **Reinstall backend dependencies (`backend/.venv/bin/python -m pip install -e './backend'`) before restarting a deployed server.** If the package is missing, the server still starts with diagnostic capture off and its routes answering 503; it never falls back to plaintext.

## Unreleased — a runtime deny decides before availability

- Task admission evaluates the `runtime.<id>` policy as soon as the runtime is resolved, before checking whether the runtime is installed, so a denied runtime answers 403 on every host instead of 503 where it happens to be absent. This fixes the backend CI job, where Pi is not installed.

## Unreleased — the policy deny floor guards the other privileged gates

- The same policy helper now guards workspace file create (`files.create`), file save (`files.write`), terminal creation (`terminal.create`), service start (`service.start`) and runtime selection at task admission (`runtime.<id>`). A recorded deny returns 403 with the deciding scope in the detail; a capability with no entry is unchanged, so only a deny alters behaviour. A narrower allow still cannot re-open what a broader scope denied.

## Unreleased — hard policy precedence with a deny floor

- Add owner-only policy entries (`GET/PUT/DELETE /api/local/policy`) evaluated over one fixed chain, `global` > `project` > `workspace` > `agent`, with a deny floor: any matching `deny` decides, a matching `allow` decides only when nothing denies, and no entry means `unset` — never allowed. A narrower scope can therefore only narrow; it cannot widen a denial or re-open a reference. `GET /api/local/policy/effective` explains one decision with the chain, every matching entry and the deciding scope.
- Capabilities are dotted names, so a subtree wildcard matches at a separator boundary (`secret:*` covers `secret.tool.send`, not `secrets.write`). Names from outside (a tool, a reference) become lowercase tokens, so an unexpected character cannot defeat a pattern.
- Enforced on the brokered secret path: a denied reference or tool is refused with 403 at grant minting, before the workspace is even looked up, and checked again at invocation, so a grant minted before a denial cannot be spent after it. An unset policy leaves behaviour unchanged.

## Unreleased — an approval can be checked against the host, still without installing

- Add owner-only `POST /api/local/resources/install-requests/{id}/verify`. Only an approved request can be verified, and the check only measures: it compares the digest the definition declares with the digest this host reports and records `provisioned`, `drifted`, `missing` or `unverifiable`. A definition with no digest, or an artefact this host cannot measure, is `unverifiable`, never `provisioned`. Every row still reports `installationPerformed: false` and `installedBy: null`: the server observes, it never installs.

## Unreleased — install requests recorded, never performed

- Add owner-only `GET/POST /api/local/resources/install-requests` and `POST /api/local/resources/install-requests/{id}/decision`. An install request names a recorded definition, a reason, an optional scope and the requesting principal; the decision records `approved` or `rejected` once, and a second decision is refused. The ledger has no `installed` state at all: every row reports `installationPerformed: false` and `installedBy: null`, so no code path here can claim an installation this server never performs.

## Unreleased — declarative resource definitions, assignments and effective configuration

- Add `PUT/GET/DELETE /api/local/resources/definitions` (owner credential) for declarative resource records: a name, a kind (`runtime`, `extension`, `tool`, `mcp`), a version, and for an artefact kind a sha256 digest, with optional source, licence and note. A definition is metadata: nothing is installed, downloaded or executed, and updating a digest keeps the previous one as history. A definition that is still assigned cannot be removed.
- Add `PUT/GET/DELETE /api/local/resources/assignments` binding a recorded definition to a scope (`agent`, `workspace`, `project`), and `GET /api/local/resources/effective` resolving the definitions in effect for a scope with the fixed precedence `agent > workspace > project`, narrowest first. A narrower scope may only name a definition that exists, so an assignment cannot widen what a broader scope declares. Each row reports the declared digest against the digest measured on this host, as `current`, `drifted`, `unobserved` (nothing measured) or `configuration-only`; nothing measured is never reported as current.
- Every attempt snapshot now carries the effective definitions (name, kind, version, declared and observed digest, state, scope) alongside the runtime identity, so the configuration a turn ran under is recorded with the attempt. States read back from the ledger are re-sanitised, so a tampered snapshot cannot introduce an unknown state.

## Unreleased — a changed runtime identity blocks resuming a conversation

- A conversation can only continue under the runtime identity its attempts ran with. `GET /api/local/resources/sessions` (owner credential) reports, per conversation, the identity its newest attempt snapshot recorded, the digest installed now, and whether a resume is allowed; `POST /api/tasks` refuses a resume with 409 when an attempt recorded a different executable digest, or when a recorded identity has no installed digest to match against. A conversation with no recorded identity is still allowed and reported as `unrecorded`, so an absence of evidence is never reported as verification.

## Unreleased — per-attempt resource snapshots, pins and drift

- Every attempt now records an immutable snapshot of the identity it ran with, written before the runner starts and never overwritten: runtime id, executable digest, manifest revision and declared version, the capabilities the adapter publishes, the workspace id and generation, the approval mode, and whether the host had drifted from the accepted pin. Snapshots are 0600 files in a 0700 directory, hold identity facts only (no credential value and no process output), are schema-validated on read and refuse an unsafe, malformed or already-taken file. `GET /api/local/resources/snapshots` lists them, `GET /api/local/resources/snapshots/{task}/{attempt}` reads one, and `DELETE` clears them; a failing snapshot sink never fails a turn.
- Runtime pins record the identity a person accepted (`POST /api/local/resources/pins`), keep the previous digests as rollback targets, report drift against the observed executable (`GET /api/local/resources/pins`) and can be removed (`DELETE /api/local/resources/pins/{runtime}`). Accepting the identity the host reports now is how a legitimate update becomes the pin; adopting an explicit digest is refused unless this ledger already recorded it. Pins are metadata: the ledger never installs or restores a binary.

## Unreleased — runtime choices come from the manifest and the auth state

- The server view now has a Runtime compatibility panel that derives what may be chosen from `GET /api/runtimes` and the provider authentication state, instead of a hardcoded list. A runtime is `ready` only when the executable, its declared version and one brokered provider call were all observed; an unavailable executable, an unverified version or an absent/unverified credential state render as `unavailable` or `unverified` with the specific reason. Every capability the manifest publishes has a row, an unsupported capability is shown as `unsupported` rather than hidden, and a test fails if the manifest gains a key the table does not cover. The matrix and its limits are published in `docs/releases/p5-runtime-compatibility.md`.
- Add the read-only `secrets.authStates` bridge operation (`GET /api/local/secrets/auth-states`) with strict validation: the response is refused unless it carries `secretValuesExposed: false`, a known state per provider and bounded fields, so a value-carrying response can never reach the renderer.

## Unreleased — the IDE listens on a private socket, not a loopback port

- `POST /api/local/workspaces/{id}/services/code-server` now binds code-server to a unix socket under this server's private service state root (`--socket`, `--socket-mode 600`, parent directory `0700`) instead of a loopback TCP port. code-server runs with `--auth none`, so a loopback port was a full write-capable IDE for any host-local process; a socket in a private directory is openable only by this account, and a different local account is denied. The preview gateway resolves either declared target kind for HTTP and WebSockets, so the ticket-gated preview still reaches the IDE, and a caller that still sends a port gets the same socket definition.
- Service definitions accept a target as `{"name": ..., "unixSocket": "<path>"}` next to `{"name": ..., "port": ...}`. A socket path is either workspace-relative (resolved inside the checkout) or absolute and inside the manager's private state root, is capped to fit `sun_path`, and its parent directory is created `0700`. Health checks probe a socket target over the socket, the port environment variable is only set for a TCP target, and a declared socket with no listener is refused instead of forwarding to a path that does not exist.
- The preview response cap was 2 MiB, which truncated code-server's 19 MiB editor bundle so no IDE preview could load. The cap is now 24 MiB, still bounded and still reported when exceeded, and a real code-server bundle now forwards in full.

## Unreleased — preview tickets die with the binding they were minted for

- A workspace service preview ticket is now re-validated against the live workspace, service and process, so a stale preview page stops reaching a process it no longer belongs to. The server drops a ticket when the workspace generation changed, the service was redefined, stopped or removed, and it refuses to open a preview for a service that has no running process. Every service change notifies the preview gateway through a manager change listener, so revocation follows the state change instead of depending on each route. An open WebSocket is watched on a bounded interval and closed as soon as its binding is lost; a normal HTTP preview re-checks at most once per second so an asset-heavy page is not slowed down, which bounds how long a stale ticket can still answer.

## Unreleased — a handover must quiesce the writers it cannot see

- Taking the workspace write lease now accounts for the writers a lease cannot name. `POST /api/local/workspaces/{id}/write-lease` reports the live writers (`terminals`, `services`, `agentTasks`) and refuses with 409 while this server's own terminals or services are still running, unless the caller passes `quiesce: true`, which stops them (terminals terminated, services stopped with confirmation) and verifies none remain before the lease is recorded. An agent task always refuses the handover, because this server cannot stop one mid-turn without leaving unknown side effects. Driving an existing shell already required the lease; that path now only reachable by seeding a competing lease, as a crash would leave it.

## Unreleased — bounded diagnostic capture

- Add a private, redacted, expiring capture of runner diagnostics: `GET /api/local/diagnostics` (owner credential) returns the newest records with `rawCapture: false`, the caps and the TTL, and `DELETE` clears them. The task engine forwards every `diagnostic` event a runner emits to the ledger, and a failing sink can never fail a turn. Each record is capped, control characters are stripped and credential-shaped spans (assignments, bearer tokens, long opaque tokens) are redacted before the write; the ledger is 0600 with a bounded entry count, expires records after a TTL on read and write, and refuses an unsafe, malformed or oversized file. Raw process output is deliberately not stored, because a runtime's text cannot be proven free of credentials.

## Unreleased — aggregate resource accounting

- Extend `GET /api/local/workspaces/{id}/resources`: the service block now reports the sums of declared CPU quota, task limit and the confined/isolated service counts for running services beside the memory reservation; the report adds the workspace identity and generation, the count of agent tasks bound to that checkout (queued/running/cancelling, using the same cwd predicate the file-write guard uses), and an explicit `unaccounted` list — language servers inside the IDE process, REPL kernels inside a runtime task, and native processes started outside the service manager — with a note that counts are observations, not reservations.

## Unreleased — review fixes for the newest security code

- **Lease race (high).** `WorkspaceWriteLease.acquire`/`release` were unlocked read-modify-write cycles, so two writers could both record themselves as holder. Each cycle now runs under an in-process lock plus an flock on a private `<root>/.leases.lock`, with thread and cross-process tests that assert exactly one holder.
- **Confinement probes (medium).** Both probes accepted sandboxes that enforce nothing: the filesystem probe's "denied" leg wrote `/etc` (unwritable here even unsandboxed) and ignored its `writable_root` argument, and the network probe had no positive control. The filesystem probe now proves an unsandboxed write to an unbound control directory succeeds, then requires that same write to fail and the bound directory to stay writable; the network probe serves a loopback listener and requires the unsandboxed control connect to succeed before requiring the sandboxed one to fail. A failing control makes each probe return False, with tests that fail against the old code.
- **Wrong-shaped native records (medium).** Valid JSON with wrong field types raised out of the stream readers. Each runner now handles a record in a guarded handler, so an unexpected shape becomes a bounded `diagnostic` instead of an internal error, and a turn with no answer still fails closed.
- **Silent hardening failure (medium).** The server logged nothing when the host refused `PR_SET_DUMPABLE`; `ensure_process_environment_is_private()` now warns with the pid and the channel that stays open, and a test asserts the warning.
- **Terminal input (low).** Sending a line into a workspace shell now requires the write lease; interrupt stays available to the owner because stopping a runaway command must not depend on lease ownership.
- **Native-session bind (low).** A resumed native session now binds its own session file instead of the whole native session store, so the sandbox cannot rewrite another session's transcript.

## Unreleased — approval binding evidence recorded

- Record the approval-binding evidence for the P5 box: the local Codex approval broker binds each prompt to the protocol request id and app-server process generation, and accepts an answer only when session, thread, task, kind, command or canonical changed paths, cwd, reason and diffs all match, denying stale generations, inactive tasks, unknown or replayed requests, a path that became a symlink while the dialog was open, disconnects and timeouts. Prime, Pi and Hermes have no interactive approval prompt, and the secret broker binds its grants to the action digest and identity fields.

## Unreleased — debug readiness is reported, not claimed

- Add a bounded `debug` block to the owner-only `GET /api/local/workspaces/{id}/language-profiles` report: the pinned debug adapter with its version, digest and install state, the debug features this host cannot provide with reasons (no JavaScript debugger pin; this server speaks no debug adapter protocol and code-server exposes no session flag), and how the IDE service is actually launched (argv, state, ports, `authMode`, bind address and declared resource controls) when it is registered. `sessionExercised` and `breakpointVerified` are false constants, and the desktop validator refuses any payload that sets them true, so a fabricated session claim cannot reach the renderer. The desktop renders the same facts including "no session exercised, no breakpoint verified".

## Unreleased — restore and import evidence

- Add `backend/tests/test_migration_restore_evidence.py`: restore the pre-migration snapshot produced by a mixed-shape legacy database, reopen the restored copy with the current code and require the current schema version, every row/status/native session id/project mapping/tombstone, its own pre-migration copy, an identical `sqlite_master` and migration ledger against a directly migrated database, and an unchanged snapshot file; then drive the hash-checked frozen published-v1 reader through the same procedure so the older binary opens the restored copy and refuses the migrated one.

## Unreleased — same-uid exposure measured and one channel closed

- Clear the server process's dumpable flag at startup (`hardening.py`), so Linux denies `/proc/<server>/environ` and `/proc/<server>/mem` to other same-uid processes: the credential cannot be read out of the server environment any more, while `/proc/<server>/stat` stays readable for runner supervision. Verified with a hardened child plus an unhardened control, and end to end against the real entry point (`PermissionError`, errno 13).
- Record the rest of the channel honestly in [P5 same-uid exposure evidence](docs/releases/p5-same-uid-exposure-evidence.md): a same-uid process can still write the broker ledger and make the broker send the stored credential to an origin of its choosing (reproduced), reach the pairing socket, and reach a provider origin directly. `docs/security.md`, the P5 roadmap box and `HANDOFF.md` now say so instead of implying shell/direct-HTTP prevention.

## Unreleased — frozen kit re-verification

- Re-verify the frozen v0.3.0 kit on this host: 88/88 kit tests pass, the frozen archive still hashes to `36d3ae03…e549b`, a rebuilt candidate hashes to `e409eaf5…b856`, and the canonical comparison reports `frozen.ok: true` with the expected two-by-design differences. Also correct the handoff: `current/testing/canonical-compare.cjs` is a Node script, so it must be run with `node`, not `python3`.

## Unreleased — unreadable runtime records become diagnostics

- A native record this server cannot parse, or one whose type is not handled, is now counted and reported as a bounded `diagnostic` task event (`malformed_record` or `unknown_event_type`, at most four per run, with the running counts) instead of being dropped silently. A record that is valid JSON but not an object no longer aborts the stream. If a runtime exits successfully with unreadable output and no answer, the turn fails closed rather than completing with empty text, and the desktop shows the diagnostic in the task activity without treating it as assistant output.

## Unreleased — resume evidence through the API

- Add an end-to-end evidence test for the P1 M1.6 list: a task that records a durable effect and then vanishes, a restart that reconciles it as `review_required` without a retry, an explicit resume that admits a new task for the same session, and a late completion for the interrupted attempt that cannot mutate the resumed task or its event ledger.

## Unreleased — opt-in confinement for runtime children

- Add `ARCHON_DESKTOP_RUNTIME_ISOLATION_PROFILE` (`none` by default, or `workspace-only`). With `workspace-only`, the Prime and Pi child that runs a task starts inside bubblewrap: the host filesystem is read-only, and only the run's checkout, the runtime's own session directory and a private temp directory are writable. The probe must prove the confinement mechanics (a denied host write plus an allowed bound write) before any run starts, and a host without them refuses the run instead of launching unconfined. **Not qualified**: no real provider turn has been run inside the profile, so runtime compatibility is unverified and the profile stays off by default. Shared sandbox helpers now live in `backend/archon_server/sandbox.py` and back the workspace-service confinement too.

## Unreleased — handoff accuracy

- Update `HANDOFF.md` for the current published state: a "progress since this handoff" list of the twelve published slices, corrected "what is left" items with the exact remaining work per item, the two gates this host cannot qualify, and the check commands that match the repository today.

## Unreleased — language profiles in the desktop

- Add a read-only Language profiles surface for the active checkout: it lists each pinned language profile, the install state of every pinned extension and debugger adapter (with the reason when a state is not `installed`), the capabilities this host cannot provide, and any installed extension that no verified pin covers. The report crosses a fixed validated bridge path (`archon:language-profiles:list` → `GET /api/local/workspaces/{id}/language-profiles`), unknown fields are refused instead of forwarded, and the panel states that the record is not a behavioural qualification.

## Unreleased — service controls in the desktop panel

- The service row now reports the controls the server applied (`memoryLimitMb`, `cpuQuotaPercent`, `tasksMax`, `filesystemIsolation`, `networkIsolation`), and a service without declared controls says so instead of implying isolation. The panel can declare all five when registering a service, refuses an out-of-range value or a network-isolated service with a port before any request, and its description no longer claims that every service runs unconfined.

## Unreleased — network isolation for workspace services

- A workspace service definition may declare `networkIsolation: "isolated"`. The service then runs with no network namespace route (`bwrap --unshare-net`), which composes with the filesystem confinement and the resource scope. A definition that declares ports or a loopback health target is refused, because an isolated service could never answer them, and a host where the probe cannot demonstrate an unreachable network refuses to start the service. Verified end to end with a real service whose connection attempt returned `ENETUNREACH`.

## Unreleased — workspace-only filesystem confinement for services

- A workspace service definition may declare `filesystemIsolation: "workspace-only"`. The service then runs inside a mount namespace where the host filesystem is read-only and only the workspace root is writable (`bwrap --die-with-parent --ro-bind / / --dev-bind /dev /dev --proc /proc --bind <root> <root>`), which composes with the CPU, memory and task scope. A behavioural probe must observe a denied host write and an allowed workspace write before any service starts, and a host without that confinement is refused rather than started unconfined. Verified end to end with a real service process: its workspace write succeeded and its `/tmp` write was denied. Network confinement is still not implemented.

## Unreleased — CPU and task limits for workspace services

- A workspace service definition may now declare `cpuQuotaPercent` (1-1600) and `tasksMax` (4-4096). Both are applied through the same user scope as the memory budget, and both are refused before launch unless a behavioural probe observes real enforcement on this host: the CPU probe requires the scope's own `cpu.stat` to report throttled periods under a 5% quota, and the task probe requires the fork past `TasksMax` to fail with `EAGAIN`. The API projection is unchanged, so the desktop's existing service row validation is unaffected.

## Unreleased — write lease covers workspace terminals

- Opening a workspace terminal now requires the workspace write lease: the request takes or refreshes the lease for the identity its credential carries, and a live lease held by another writer is refused with 409 before any shell is created. Existing terminals are not revoked by a later handover, and that limit is stated in the route.

## Unreleased — migration evidence for the legacy data shapes

- Add migration evidence tests for one legacy database holding every shape the P1 checklist names: two sessions sharing a project id beside a third on another project, native Prime and Pi session ids, two tombstoned sessions, and queued, running and completed tasks. The migration keeps every row, status, session id and mapping unchanged, writes exactly one pre-migration copy whose version and rows are pre-migration and whose integrity check passes, and reopening is idempotent.

## Unreleased — pinned language profiles

- Add pinned language profiles for the workspace IDE (`GET /api/local/workspaces/{id}/language-profiles`). Each pin records the marketplace, version, declared licence, licence-file digest, VSIX digest and the digest of the installed extension directory for `ms-python.python` 2026.4.0, `ms-python.debugpy` 2026.6.0 (linux-x64), `redhat.vscode-yaml` 1.25.2026092308 and `dbaeumer.vscode-eslint` 3.0.34, all installed on this host from Open VSX. The report is artefact-based and honest about gaps: Pylance is unsupported because it is proprietary and absent from this marketplace, no JavaScript debugger adapter is pinned, and an automatically installed dependency without a licence field is reported as unpinned. Evidence: [P4 language profiles](docs/releases/p4-language-profiles.md).

## Unreleased — native Prime session leases

- Add native-compatible Prime Agent session leases. Archon now takes Prime's own lease directory (`<agent dir>/session-leases/<sha256 of the canonical session path>.lock` with a `owner.json` record) for every resumed native session, so an interactive Prime process and an Archon run cannot work the same session at once: a live native owner makes the turn fail closed with an actionable message, and an Archon-held lease makes native Prime refuse the session. Compatibility is tested against the installed Prime Agent implementation in both directions, and a killed owner is reclaimed. Limits: this module does not run a guard-refresh timer, and the lease owner is the server process, so the exclusion holds for the server's lifetime rather than the supervised run's.

## Unreleased — fresh package builds and native frame checks

- Add `desktop/scripts/native-hostile-frame-check.mjs` (`npm run native:hostile-frame`): it launches the real Electron app in an isolated fixture profile and reports, as a pass/fail JSON report, whether the trusted top frame sees the preload bridge, whether same-origin and out-of-process sandboxed frames can reach it, whether a new window or remote top-level navigation is refused and whether that attempt revokes IPC trust, whether the credential store persisted anything, and whether the run wrote outside the fixture root. Two fresh `npm ci` workspaces built byte-identical portable packages; the Chromium sandbox and native keyring gates are recorded as blocked on this host rather than worked around. Evidence: [P2D fresh builds and native checks](docs/releases/p2d-fresh-builds.md).

## Unreleased — write-lease enforcement

- Require the workspace write lease in the write paths. `POST /api/workspaces/{id}/files/write`, `POST /api/workspaces/{id}/files/create`, workspace service start and the code-server handoff each take or refresh the lease for the identity the request presented (a paired owner, or the static server token), and a live lease held by another writer is refused with 409 before anything is written. Moving write access now needs an explicit handover: the holder releases and the other writer acquires. Kernels, debuggers, tmux children and other native processes are still not fenced, and the lease ledger accepts any registered workspace id shape.

## Unreleased — secret broker

- Add an isolated credential-holding broker for secret-backed actions. A credential stays in the server process environment and is addressed by an operator-registered reference; no value is persisted, returned, logged or copied into a child environment. An action needs a single-use grant bound to the principal, tool name, digest of the exact arguments, attempt id, workspace identity plus its current generation and the ledger epoch. The broker re-checks that binding, performs the upstream HTTPS request itself over an allowlisted request shape, consumes the grant before the call starts (an ambiguous failure is never retried silently), redacts the credential from the bounded result and audits every decision. Owner-only `/api/local/secrets/*` endpoints register and revoke references, report scoped provider auth states and read the bounded decision trail; an enrolled runner redeems a grant minted for it over its own authenticated channel (`/api/runners/{id}/secret-invoke`). Ledger state is a bounded, schema-validated, private (0600) document.

## Unreleased — workspace write lease

- Add an exclusive, expiring single-writer lease per workspace in a private bounded ledger: the owner can acquire, inspect and release it, a second holder is refused while a live lease is held, the current holder may renew, and an expired lease does not block a new holder. This is the coordination primitive a handoff needs before write access moves.

## Unreleased — workspace code-server template

- Install code-server 4.139.1 and add `POST /api/local/workspaces/{id}/services/code-server`, which registers a loopback-bound code-server (`--auth none`, telemetry disabled, health `/healthz`) as a workspace service so the full IDE can be started on demand and reached through the sandboxed preview gateway. The Workspace services panel exposes a code-server control (port input + one-click register) through a finite `workspaceServices.codeServer` bridge call.

## Unreleased — runner liveness

- The enrolled-runner list now reports a `stale` flag derived from the last authenticated heartbeat against a configurable threshold, so the owner can tell a live remote runner from a silent one.

## Unreleased — remote runner dispatch

- Owner submits a prompt for an enrolled runner via `POST /api/local/runners/{id}/tasks`; it is dispatched through the durable outbox and the runner claims, executes and reports it. The multi-machine loop (submit -> durable dispatch -> remote execute -> bounded result) is now end-to-end.

## Unreleased — remote runner worker loop

- Add the remote half of the runner: a `RemoteRunnerClient` (authenticated claim/report/ack), a `RunnerAgent` that claims a bounded batch, executes, reports the bounded outcome and then acknowledges (a failed item is reported, never silently dropped), a `prompt` executor over a runtime CLI confined to a work root, and `scripts/runner_agent.py`. The coordinator records bounded per-runner results in a private ledger with an owner-only read endpoint.

## Unreleased — aggregate workspace resource summary

- Add an owner-only `GET /api/local/workspaces/{id}/resources` summary reporting registered/running services, the reserved memory budget against its cap, and the terminal session count against its limit.

## Unreleased — remote runner claim/ack transport

- Add a durable per-runner outbox: the coordinator enqueues work for an enrolled runner (owner-only, deduplicated by event key), and the runner claims unacknowledged entries over its own authenticated channel and acknowledges them by sequence. Entries are generation-fenced, bounded, and survive a restart on either side until acknowledged.

## Unreleased — runner enrollment and authenticated channel

- Enroll named task runners into a private (0600) ledger; each enrollment returns a one-time-shown secret stored only as a salted SHA-256 digest and compared in constant time. Owner-only `/api/local/runners` endpoints enroll, list and revoke; `/api/runners/{id}/heartbeat` authenticates an enrolled runner with its own secret, separate from the owner token. The ledger is bounded, schema-validated and rejects tampering.

## Unreleased — native capture and visual comparison harness

- Add an isolated native capture harness: `capture-app.sh` launches a built app on a throwaway Xvfb display with a remote-debugging port, `capture-cdp.py` captures its real renderer over the Chrome DevTools Protocol at a forced 1440×900 viewport, and `compare-captures.py` reports the differing-pixel ratio against an explicit threshold.
- Result: the frozen v0.3.0 baseline and the candidate built from it both render at 1440×900 with a 0.728% differing-pixel ratio (99.27% identical). This is a capture-level comparison, not a semantic parity claim.

## Unreleased — Prime and Pi qualified on DeepSeek Flash

- Prime and Pi both completed a bounded headless provider turn on DeepSeek Flash (`deepseek` / `deepseek-flash`), joining Hermes; Codex is intentionally unused for this workstream. Pi's defaults and Prime's key were switched to DeepSeek.

## Unreleased — runtime adapter manifests

- Publish an adapter manifest per runtime: executable path, read-only SHA-256 digest, an optional declared version (never probed by executing the runtime), and honest capability flags (modalities, resume/fork/steer, approval/read-only/chat-only, reconnect, resource formats, transports — all unsupported for the print-based adapters). The digest is cached by file identity and computing it never runs the executable.

## Unreleased — aggregate service memory accounting

- Enforce a workspace-wide memory budget across running services: starting a service whose declared budget would push the aggregate of running services over `max_total_memory_mb` (default 4096) is refused with a capacity error. Budgets are only used when the host actually enforces them (see below).

## Unreleased — editor draft recovery

- Persist small-file editor drafts locally and bounded (max 8 drafts, 16 KiB per file, 128 KiB total, oldest-first eviction). Opening a file with a recovered draft that differs from the server content restores it with a visible notice; saving or cancelling clears it. Only file text is stored, never credentials, and storage failures degrade to no persistence.

## Unreleased — streaming attach transport

- Stream an active attach lease's screen to the renderer: main polls the bounded attach-screen operation and pushes validated frames over a dedicated event channel, and the renderer subscribes for live updates. Watch/unwatch are finite bridge calls; frames with a wrong attach id or bad shape are dropped.

## Unreleased — canonical baseline comparison harness

- Add `current/testing/canonical-compare.cjs`: it verifies the frozen v0.3.0 input against every official baseline hash and verifies a rebuilt candidate keeps the untouched files byte-identical while changing only the intended files, bundling PeerJS and patching the renderer CSP. The frozen input matches all four baseline files and the candidate passes (exit 0).

## Unreleased — preview WebSocket forwarding

- Forward preview WebSockets (HTTP/HMR) through the ticket-gated gateway on the same declared loopback port with a 2 MiB frame cap and an Origin check that rejects a WebSocket whose Origin is not the local server origin; an invalid ticket closes with 1008.

## Unreleased — sandboxed native service preview

- Add a main-process `WebContentsView` preview with its own storage partition, no Node integration, no Archon preload, window-open denied and same-preview navigation enforced. The renderer never builds a preview URL: main resolves a read-only ticket and the loopback URL from the backend.
- Wire the preview through a finite `workspacePreview` bridge (open/bounds/close) and a Workspace services "Preview" control that reserves a surface and tracks its bounds. WebSocket/HMR forwarding and the hostile preview test matrix remain open.

## Unreleased — private preview gateway foundation

- Add short-lived, read-only preview tickets bound to one workspace, registered service and declared port. The ticket-gated loopback proxy forwards only an allowlisted request-header set and never an Archon credential; it does not follow redirects off the preview origin, drops cross-origin redirects, strips response cookies and hop-by-hop headers, and bounds request (512 KiB) and response (2 MiB) bodies.
- Only a port declared by a registered service can be reached; a chat URL or a log-parsed port is not a valid target. The sandboxed preview view and HTTP/HMR/WebSocket streaming follow in the next increment.

## Unreleased — frozen v0.3.0 input verified

- The official frozen v0.3.0 archive is present on the target workstation with the expected SHA-256. The frozen kit ran 88 tests with 0 skipped against it, and the guarded candidate builder produced a validated payload. Visual/native parity and release qualification remain open.

## Unreleased — enforced service memory budget

- Launch a service that declares `memoryLimitMb` under `systemd-run --user --scope -p MemoryMax=<n>M -p MemorySwapMax=0` (cgroup v2) instead of an unbounded process; a service without a budget keeps the plain argv launch. Swap is disabled for the scope because it would otherwise absorb the overage and mask the cap. A behavioral probe verifies that a scope actually kills an over-budget allocation before any budgeted service starts; on a host that sets `memory.max` without enforcing it a budgeted service is refused (fail closed) rather than launched unbounded. The probe passes on the target host.

## Unreleased — managed service health state

- Probe each service's declared loopback health target with a bounded, credential-free GET (2s interval, 1.5s timeout) and report `starting`/`healthy`/`unhealthy`; a service without a health target reports `unknown`. Health stops with the service and is exposed on the service DTO and in the panel.

## Unreleased — desktop service surface

- Add a finite `workspaceServices` preload bridge (list, define, remove, start, stop, logs) with strict input validation of every definition field: argv bounds and control-character rejection, workspace-relative cwd, referenced allowlisted env names, unique named ports, absolute health paths and a bounded dependency list.
- Map each call to a fixed owner-only route and render a Workspace services panel that registers, starts, stops (confirmed), removes (confirmed) and tails logs, with honest state and no automatic retry of ambiguous actions.

## Unreleased — P5 runtime availability record

- Record the installed Prime/Pi/Codex/Hermes identities, headless availability, native account material and host facilities on the target workstation, and mark P5 in progress with availability established but no adapter qualified.
- Reinstall Hermes 0.19.0 as an isolated `uv` tool from the retired migration source; no gateway, dashboard, cron or systemd unit is installed or started.

## Unreleased — managed workspace services

- Add a bounded, validated registry of workspace services: an argv array, a workspace-relative working directory, referenced (allowlisted) environment names, named ports, an optional health target, dependencies and a restart policy. Definitions persist behind the workspace generation fence; dependencies must exist and cannot cycle.
- Supervise each registered definition as a workspace-owned child process with the allowlisted service environment plus server-constructed `<PORT>_PORT` variables, a bounded 16 KiB log tail and in-memory lifecycle (`registered`, `starting`, `running`, `stopped`, `exited`, `failed`). `on-failure` restart is bounded; a failing service reports `failed` with its exit code.
- Require explicit confirmation to stop or remove, block removal while other definitions depend on it, and stop every supervised child during backend shutdown. A private preview gateway and sandboxed remote view follow in the next increment; memory budgets are recorded but not yet enforced.

## Unreleased — interactive checkout attach

- Add a one-use, short-lived attach ticket that redeems exactly once into a sliding, server-fenced input lease for a persisted checkout session. Tickets and leases are bounded, owner-checked and pruned on expiry; a workspace generation change refuses stale metadata.
- Enforce a single control lease per session: a second control attach is refused while a read-only attach may still observe, and a read-only lease can never send text or control keys.
- Add bounded interactive key frames (reviewed allowlist of named tmux keys plus literal UTF-8 text) with ordered, never-retried delivery. Detaching a client always leaves the surviving shell running.
- Expose the attach lifecycle (open, claim, screen, input, detach) through the finite desktop bridge and a console panel that keeps input disabled for read-only attaches. The plain-text line console remains available.

## Unreleased — Phase 2C.2 read-only server collections

- Add a separate Server data route for authenticated read-only project, session and task rows through the finite desktop bridge.
- Label returned rows and capped list counts, clear rows on connection changes, and distinguish access rejection from other read failures.
- Keep synthetic workspace views separate and advance the reconstruction source channel to `0.3.0-reconstruction.4`.

## Unreleased — Phase 2C.1 connection and readiness view

- Add a Connection view that explicitly saves a main-process memory-only token and shows authenticated backend readiness, bounded read-only project/session/task lists and event cursor. Returned session/task lengths are not totals.
- Keep the existing workspace fixture views separate from server data. Browser preview has no bridge and cannot connect.
- Clear entered token text after submission and avoid renderer persistence; native security and keyring qualification remain later gates.
- Advance the reconstruction source channel to `0.3.0-reconstruction.3`.

## Unreleased — Phase 2B.1 trusted connection boundary

- Add a finite, validated preload bridge and top-frame IPC binding for five read-only backend operations and explicit connection methods.
- Keep bearer credentials in main-process memory, reject unsafe URLs and redirects, and abort stale requests when the connection changes.
- Preserve the synthetic renderer while native profile, keyring, local Codex, remote browser and live UI integration remain later gates.
- Advance the isolated reconstruction build to `0.3.0-reconstruction.2` and patch the Vitest development dependency.

## Unreleased — Phase 2A authored source foundation

- Add a separate Electron/React reconstruction source build with pinned dependencies and build provenance, without private-ASAR or bundle-replacement inputs.
- Port queue, scoped IDE, runtime identity and read-only snapshot behavior into typed pure modules with focused parity fixtures.
- Add a synthetic renderer shell preserving the recovered sidebar/workbench structure, theme controls and navigation shortcuts. Live transport, privileged operations, full feature parity and native qualification remain later P2 increments.
- Keep the official v0.3.0 kit unchanged; use a separate reconstruction version/identity with baseline parity explicitly unverified.

## Unreleased — Phase 1D credentials and readiness

- Require server credentials before database initialization, share HTTP/WebSocket authorization, and restrict listeners to loopback with explicit private HTTPS proxy configuration for remote use. Implicit repository `.env` loading is disabled.
- Provision credentials once into a private external mode-0600 service environment file outside all declared workspace roots; retain existing external configuration without silent rotation.
- Filter every newly launched child environment by purpose, excluding coordinator tokens, unrelated secrets and ambient shell/runtime injection settings.
- Add authenticated storage, worker, queue and runtime readiness while keeping anonymous health minimal. Dispatch eligibility does not certify native execution or provider credentials.

## Unreleased — Phase 1C.2 durable execution attempts

- Record an execution attempt with every claim and require its identity for runner events, results, errors and cancellation. Stale callbacks cannot mutate a newer attempt or attach a session.
- Persist cancellation intent before awaiting native teardown; prevent cancelled work from launching while waiting for a Prime lease or gated supervisor. Uncertain started work remains failed for review after restart and is never automatically replayed.
- Bind admitted tasks to canonical runtime and project snapshots. Reconcile session runtime/cwd ownership from complete evidence; ambiguous legacy history requires review instead of guessing from current aliases or the first native file.
- Add migration 2 with a verified pre-upgrade snapshot, preserving the immutable version-1 migration and its checksum. See the Phase 1C.2 evidence for compatibility and remaining native qualification gates.

## Unreleased — Phase 1C.1 durable request admission

- Introduce a versioned, checksummed SQLite migration with a verified mode-0600 pre-migration snapshot for existing databases. Reject newer or inconsistent migration metadata before schema changes.
- Support authenticated `Idempotency-Key` task requests. Identical retries return the existing task; changed payloads or unverifiable legacy keys return HTTP 409. Preserve one task/event across concurrent retries and Telegram delivery failures.
- Fix the queued-cancellation/claim race with a queued-only compare-and-swap before routing a newly running task through runner cancellation. Durable attempt fencing and native prelaunch cancellation remain Phase 1C.2.

## Unreleased — Phase 1B task admission

- Resolve Prime/Pi through an explicit execution registry and documented profile aliases. Unknown profiles and unavailable executables fail before task acknowledgment; `/api/runtimes` describes filesystem availability and supported modes separately from the agent roster.
- Require explicit `approval_mode: "auto"`, labeled trusted execution. Reject approval, planning and chat-only requests because neither native adapter has a verified enforcement protocol for those restrictions.
- Canonicalize task working folders within the configured scratch root or a selected registered project. Preserve session runtime/cwd ownership, reject mismatched inputs, and recheck workspace authorization before dispatch and native launch.
- Commit an initial project assignment with the task and initial event. Missing folders never silently fall back to the account home. These admission checks do not sandbox trusted execution.

## Unreleased — Phase 1A execution recovery

- Replace Prime's directory-based session lease with a bounded Linux advisory lock, retained by the process supervisor while its work survives. Legacy directory locks require a deliberate, quiescent migration instead of spinning indefinitely.
- Preserve unstarted queued tasks on recovery; record interrupted started tasks as review-required failures instead of automatically replaying them.
- Stop automatic replay after ambiguous daemon disconnects and provider-limit errors. Review side effects and runner state before submitting new work.
- Keep existing terminal task status/event shapes and add recovery detail without a database schema migration. Full runner reconciliation, admission policy and idempotency changes remain later Phase 1 increments.

## Unreleased — repository cleanup

- Removed the unused legacy desktop source tree, design/reference archives, version-specific launchers, and dated maintenance reports.
- Kept the active v0.3.0 kit, shared backend, server installer, tests, live soak utility, and release documentation.
- Removed the obsolete legacy test command and CI job; the root checks now cover the current kit and backend only.
- Confirmed that the MiniPC installed candidate still matches a clean build from `main`.

## v0.3.0 candidate

- Added Browser result links, an IDE for agent-written code, local Codex sessions, authenticated connection testing, and read-only PeerJS session/project sharing.
- Added guarded ASAR reconstruction, disposable preview fixtures, and regression coverage for patching, CSP, collaboration, code extraction, and safe file editing.
- The backend API and database were not changed for collaboration.

## v0.3.0 baseline

- The verified frozen v0.3.0 archive remains the official release input.
- Official frozen input SHA-256: `36d3ae03bd6b20c4e9ea5fc690461ef972b16eb0c9433bfb1305daeb068e549b`.
- The Python backend keeps its independent package version (`0.2.0`).

See the [baseline record](docs/releases/v0.3.0.md), [candidate ledger](docs/releases/v0.3.0-candidate.md), and [release checklist](docs/releases.md).
