# P4 — IDE listener evidence (gateway-only, private unix socket)

Scope: the code-server IDE that Archon registers for a workspace, and the claim that its
listener is reachable only through this server's preview gateway.

## What changed

`POST /api/local/workspaces/{id}/services/code-server` no longer registers a loopback TCP
port. The definition binds a unix socket under this server's private service state root
(`<data_dir>/workspace-services/<workspace-token>-code-server.sock`, parent directory mode
`0700`, socket mode `0600`) and declares that socket as its previewable target:

```
code-server --socket <state-root>/<token>-code-server.sock --socket-mode 600 \
            --auth none --disable-telemetry .
```

The preview gateway resolves either kind of declared target (loopback port or unix socket)
for HTTP and WebSocket, so the sandboxed preview view still reaches the IDE by ticket. A
caller that still sends `{"port": ...}` gets the same socket definition; the number no
longer selects a listener.

## Evidence produced on this host

`code-server 4.139.1` (the pinned executable) was started manually with the same flags, and
the gateway's own forwarding function was driven against it over the socket:

| Check | Result |
| --- | --- |
| socket exists after start | yes |
| socket file mode | `0o600` |
| `GET /healthz` over the socket | `200`, `{"status":"expired","lastHeartbeat":0}` |
| `GET /` over the socket | `302` with the relative redirect `./?folder=...` |
| `GET /static/out/vs/code/browser/workbench/workbench.js` over the socket | `200`, 19,339,709 bytes, `truncated: false` |
| same request attempted by another local account (`sudo -n -u nobody python3 … connect_ex`) | `denied` (EACCES) |

The last two rows are the point of the change: the editor's real bundle passes through
unmodified, and a different local account cannot open the listener at all. A loopback TCP
port could not make that second guarantee, because no per-user boundary exists on a TCP
port.

## Limits of this evidence

- The evidence above is a manual run of the pinned executable plus the gateway forwarding
  function, not a browser session inside the packaged desktop app. The preview view was
  not exercised against a socket target in a real window.
- The socket path must fit `sun_path` (108 bytes including the terminator on Linux). The
  manager keeps the name short and raises a clear error (refusing the registration) when a
  configured data directory is too long, instead of letting the IDE fail to bind.
- `code-server` still runs with `--auth none`; the guarantee is the socket mode and its
  private parent, so a process running as the same account remains inside the trust
  boundary, exactly as it does for the rest of this server's files.
- The response cap that a preview may forward was 2 MiB and truncated the 19 MiB editor
  bundle, so no IDE preview could load. The cap is now 24 MiB, still bounded, and a
  workspace is limited to eight preview sessions. Since 28 September responses stream
  instead of being buffered: the cap bounds one response, a body that passes it is
  aborted rather than truncated, and the `x-archon-preview-truncated` flag is gone.
