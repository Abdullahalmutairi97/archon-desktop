# P4 — Full solo workstation

**Status:** in progress. Registered checkouts can be browsed, searched, created and edited for small text files, with a bounded selected-file Git diff in the Server data view; the full IDE, persistent shell, debugger, and in-app service preview remain open. **Dependencies:** P2 and P3. **Outcome:** one person can ask an agent to build, inspect/edit/debug its code, run a persistent shell and use the resulting app within Archon.

## Scope

Integrate workspace-hosted code-server, persistent tmux and managed application services into the existing Files/IDE/Browser/Terminal workbench. Keep the lightweight artifact viewer. Reconcile any recovered earlier IDE decision before selecting an equivalent supported implementation. Begin with pinned Python and TypeScript language/debug profiles.

## Checklist

- [ ] Launch code-server on demand inside the workspace; pin supported extensions and verify licensing/source. Show unknown/unsupported language features honestly.
- [ ] Implement completions, diagnostics, project-wide search, Git diff and breakpoint/debug flows against the same root used by agents and terminals.
- [ ] Require human writer ownership for full IDE; agent ownership uses the read-only viewer. Enforce P3's full process teardown before handing over write access.
- [ ] Complete revision-aware brokered file saves, file invalidation, and editor draft recovery. Small existing UTF-8 files now use owner-scoped relative paths, no-symlink traversal, observed-content conflict detection, and atomic same-directory replacement. This does not fence native writers or persist editor drafts; claim atomic conflict protection only while the broker has exclusive mutator authority, and test native IDE save conflicts separately.
- [ ] Use private workspace tmux sockets and generated terminal IDs. Persist metadata/cwd/generation and bounded output; detach clients without killing surviving shells.
- [ ] Issue one-use short attach tickets; enforce Origin, workspace authorization and exclusive input control. Read-only attach denies input/control frames as well as ordinary text.
- [ ] Add service definitions with argv arrays, relative cwd, env references, named ports, health/dependencies, logs, restart policy and resource budgets.
- [ ] Launch only registered services and validate targets inside the workspace namespace. A chat URL or parsed log port does not authorize execution or proxy access.
- [ ] Provide an authenticated service-specific gateway and per-view loopback tunnel, origin and storage partition; forward HTTP/HMR/WebSockets while stripping control credentials.
- [ ] Use sandboxed remote views with no Node integration or Archon preload. Validate privileged IPC senders and prevent preview access to control/private destinations, other services and credential-bearing redirects.
- [ ] Teardown view/tunnel state and invalidate tickets on service generation changes. Keep IDE auth or restrict its listener to the gateway-only path.
- [ ] Add on-demand/idle behavior and limits using P3 aggregate accounting; UI closure must not kill an active shell/service.

## Validation and exit

- [ ] Python and TypeScript fixtures demonstrate real completion, diagnostics, search, diff, breakpoint/run and agent-to-IDE shared-root identity.
- [ ] Brokered stale saves return conflict under exclusive ownership; native IDE conflict/draft recovery is verified independently. A detached writer blocks unsafe handoff.
- [ ] Terminal disconnect/reconnect preserves surviving shell identity without duplicate commands; API/runner restarts reconcile identity; container/host restart reports lost processes and a new generation.
- [ ] Service port collision, crash/restart, health, logs and HMR work without duplicate launches or public ports.
- [ ] Hostile preview/navigation/redirect/IPC/SSRF tests cannot obtain host/control credentials or another workspace's service.
- [ ] A clean Linux solo installation and an isolated remote workspace complete the workflow; backup/restore smoke preserves project/native history.

Known blockers: P2 source/native views, extension compatibility, code-server/gateway WebSocket and HMR behavior, and target-host RAM/CPU capacity. Native execution/network checks cannot be replaced with synthetic frontend previews. Public/external-browser preview sharing is P8.

Follow the [roadmap workflow](README.md); publish PR evidence without claiming an installer release or deployment.
