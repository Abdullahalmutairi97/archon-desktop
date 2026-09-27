# P5 — Native runtime parity and resource management

**Status:** in progress. Prime, Pi, Codex and Hermes are installed on the target workstation with pinned identities, headless start and native account material present (see [installed runtime availability](releases/p5-runtime-availability.md)). Adapter manifests, conformance fixtures, native resource accounting and enforced isolation remain open, and no adapter is qualified beyond availability; a bounded qualification probe was blocked by provider usage limits. **Dependencies:** P3; P4 for integrated UX. Individual adapter work can proceed independently once the contracts are stable. **Outcome:** Hermes, Pi, Prime and Codex are selectable with truthful capabilities, scoped native authentication and managed MCP/skills.

## Scope

Keep provider/model, runtime, harness and execution environment distinct. Use native bindings behind a versioned Archon adapter/event contract. Unknown capabilities fail closed. Preserve existing Prime/Pi print paths until richer RPC paths have parity; preserve native histories and original runtime/cwd ownership.

## Checklist

- [ ] Publish adapter manifests with runtime version/executable digest, modalities, resume/fork/steer, approval/read-only/chat-only support, reconnect semantics and resource formats/transports. The registry now publishes a read-only executable digest and honest capability flags per runtime (never executing the runtime to probe a version); declared versions and the target-host identities are recorded in releases/p5-runtime-availability.md.
- [ ] Add conformance fixtures for prompt/stream/cancel/auth/approval/unsupported/resume/error behavior; validate before admission and again when binary/config identity changes.
- [ ] Pin and qualify Prime/Pi RPC, separate Hermes ACP registration and runner-owned Codex app-server stdio. Do not silently fall back across runtimes or assume untested remote transports.
- [ ] Preserve imported native history restrictions until exact native resume mappings are validated. Reject cross-runtime or wrong-cwd resume.
- [ ] Normalize allowlisted events with attempt/runner/generation identity. Malformed/unknown native events become diagnostics, not false completion.
- [ ] Bound, redact, encrypt, restrict and expire optional diagnostic capture; disable raw capture when credentials cannot reliably be excluded.
- [ ] Bind approvals to action digest, attempt/native request, workspace generation and current policy. Deny stale/replayed/unauthorized/time-expired decisions; cancellation remains requested until termination is confirmed.
- [ ] Add scoped provider/native authentication states and secret references without copying personal auth files between users.
- [ ] Create resource definitions, assignments, install requests, immutable per-attempt snapshots, update/rollback pins and effective configuration provenance.
- [ ] Enforce hard policy before project/user/workspace/agent overrides; narrower scopes cannot widen denied permissions or secrets.
- [ ] Implement runtime-specific MCP transport/auth translators and versioned skill materialization. Inventory/configuration is not proof of connection; unsupported transports/formats are rejected.
- [ ] Approve managed executable installation/provisioning. Treat skill scripts as executable code and Markdown instructions as untrusted guidance rather than permission enforcement.
- [ ] For secret-backed restricted actions, use an isolated credential-holding broker that checks principal/tool/arguments/epoch, or equivalently enforced upstream credential scopes. Workspace code must not read broader credentials/process state or bypass the authorized channel with shell/direct HTTP.
- [ ] Stop/restart affected sessions when cached resources cannot be safely revoked. Never forward Archon credentials to MCP servers.
- [ ] Derive runtime/resource choices in the existing UI from capability/auth states and publish a tested compatibility table.

## Validation and exit

- [ ] Each enabled pinned runtime completes a small file/test turn in its assigned workspace; auth/cancel/recovery/unsupported behaviors match the advertised matrix.
- [ ] Malformed JSONL, subprocess loss, timeout/approval replay and indirect denied execution paths have regression coverage.
- [ ] A forbidden secret-backed operation fails through both the named tool and shell/direct HTTP; broker/process isolation or upstream scopes prevent the effect.
- [ ] No cross-user auth or secret values appear in API/UI/logs. Resource scope precedence, incompatible transport, update rollback and active revocation pass.
- [ ] Compatibility records include binary/version/digest, date, fixture/native evidence and limits. Unavailable credentials mark that adapter unverified, never ready.

Known blockers: exact installed runtime versions, native API behavior/accounts, extension/MCP bridge compatibility, authenticated tool availability and demonstrable credential isolation. Current upstream documentation alone is not qualification of an installed executable. Jev/Laya are optional advisers and are not required for agent operation or permissions. The target workstation now has the full runtime roster installed (see releases/p5-runtime-availability.md); the remaining blockers are behavioral qualification and enforcement, not availability.

Follow the [roadmap workflow](README.md). No fake adapter may be published as production-ready.
