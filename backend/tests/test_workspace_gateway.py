from __future__ import annotations

import asyncio
import contextlib
import http.server
import socket
import socketserver
import tempfile
import threading
from pathlib import Path

import pytest

from archon_server.db import Database
from archon_server.services import workspace_gateway as gateway_module
from archon_server.services.workspace_gateway import (
    WorkspaceGatewayRequestRejected,
    WorkspaceGatewayResponseTooLarge,
    WorkspaceGatewayServiceUnavailable,
    WorkspaceGatewayTicketUnavailable,
    WorkspaceGatewayUpstreamError,
    WorkspacePreviewGateway,
)
from archon_server.services.workspace_services import WorkspaceServiceConflict, WorkspaceServiceManager, WorkspaceServiceNotFound


OWNER_ID = "local-uid:1000"
WORKSPACE_ID = "workspace-0123456789abcdef0123456789abcdef"


def _manager(tmp_path: Path, state_root: Path | None = None) -> WorkspaceServiceManager:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir(exist_ok=True)
    database = Database(tmp_path / "database.sqlite3")
    try:
        database.get_workspace(WORKSPACE_ID)
    except KeyError:
        database.create_workspace(
            workspace_id=WORKSPACE_ID,
            root=str(workspace_root),
            owner_id=OWNER_ID,
            project_id="project-test",
            generation=1,
            isolation_profile="git-checkout",
        )
    return WorkspaceServiceManager(
        database, owner_id=OWNER_ID, state_root=state_root or tmp_path / "private-state",
    )


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class _Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):  # silence
        return

    def do_GET(self):  # noqa: N802
        if self.path == "/ok":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Set-Cookie", "session=secret")
            self.end_headers()
            self.wfile.write(b"hello-preview")
        elif self.path == "/same":
            self.send_response(302)
            self.send_header("Location", f"http://127.0.0.1:{self.server.server_address[1]}/ok")
            self.end_headers()
        elif self.path == "/cross":
            self.send_response(302)
            self.send_header("Location", "https://control.example/steal")
            self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()


def _serve() -> tuple[http.server.HTTPServer, threading.Thread, int]:
    port = _free_port()
    server = http.server.HTTPServer(("127.0.0.1", port), _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread, port




class _GateProcess:
    """A fake service process: the gateway only needs the manager's state."""

    def __init__(self) -> None:
        self.returncode = None
        self.stdout = None

    async def wait(self) -> int:
        while self.returncode is None:
            await asyncio.sleep(0.01)
        return self.returncode

    def terminate(self) -> None:
        self.returncode = 0

    def kill(self) -> None:
        self.returncode = 0


def _startable_manager(tmp_path: Path, state_root: Path | None = None) -> WorkspaceServiceManager:
    """A manager whose fake spawn lets a service reach the running state."""
    manager = _manager(tmp_path, state_root=state_root)

    async def fake_spawn(*_argv, **_kwargs):
        return _GateProcess()

    manager._spawn = fake_spawn
    return manager


async def _running_manager(tmp_path: Path, *definitions: dict) -> WorkspaceServiceManager:
    manager = _startable_manager(tmp_path)
    for definition in definitions:
        await manager.define(WORKSPACE_ID, definition)
        await manager.start(WORKSPACE_ID, definition["name"])
    return manager


@pytest.mark.asyncio
async def test_open_requires_a_registered_running_service_and_declared_port(tmp_path):
    manager = _startable_manager(tmp_path)
    gateway = WorkspacePreviewGateway(manager, forward=_unused_forward)
    with pytest.raises(WorkspaceServiceNotFound):
        await gateway.open(WORKSPACE_ID, "missing", expected_generation=1)
    await manager.define(WORKSPACE_ID, {"name": "plain", "argv": ["/bin/echo"]})
    with pytest.raises(WorkspaceServiceConflict):
        await gateway.open(WORKSPACE_ID, "plain", expected_generation=1)
    await manager.define(WORKSPACE_ID, {
        "name": "web", "argv": ["/bin/echo"], "ports": [{"name": "http", "port": 4173}],
    })
    # A registered but stopped service has nothing to proxy to.
    with pytest.raises(WorkspaceGatewayServiceUnavailable):
        await gateway.open(WORKSPACE_ID, "web", expected_generation=1)
    await manager.start(WORKSPACE_ID, "web")
    preview = await gateway.open(WORKSPACE_ID, "web", expected_generation=1)
    assert preview["ticket"].startswith("wprev-") and preview["mode"] == "read-only"
    with pytest.raises(ValueError):
        await gateway.open(WORKSPACE_ID, "web", expected_generation=2)
    with pytest.raises(WorkspaceServiceConflict):
        await gateway.open(WORKSPACE_ID, "web", expected_generation=1, port_name="nope")


async def _unused_forward(*_args, **_kwargs):  # pragma: no cover - open() never forwards
    raise AssertionError("forward must not be called")


@pytest.mark.asyncio
async def test_proxy_contract_forwards_allowlisted_headers_and_strips_cookies(tmp_path):
    manager = await _running_manager(tmp_path, {
        "name": "web", "argv": ["/bin/echo"], "ports": [{"name": "http", "port": 4173}],
    })
    calls: list[tuple] = []

    async def fake_forward(method, url, headers, body, timeout):
        calls.append((method, url, dict(headers), body))
        return {
            "status": 200,
            "headers": {"content-type": "text/plain", "set-cookie": "session=secret", "content-length": "5"},
            "body": b"hello",
            "truncated": False,
            "location": None,
        }

    gateway = WorkspacePreviewGateway(manager, forward=fake_forward)
    preview = await gateway.open(WORKSPACE_ID, "web", expected_generation=1)
    ticket = preview["ticket"]
    result = await gateway.proxy(
        ticket, method="GET", path="index.html", query="a=1",
        headers={"accept": "text/html", "authorization": "Bearer secret", "cookie": "x=1", "host": "localhost"},
        body=b"",
    )
    assert calls[0][0] == "GET"
    assert calls[0][1] == "http://127.0.0.1:4173/index.html?a=1"
    assert calls[0][2] == {"accept": "text/html"}
    assert "set-cookie" not in result["headers"]
    assert "content-length" not in result["headers"]
    assert result["headers"]["content-type"] == "text/plain"
    assert result["body"] == b"hello"


@pytest.mark.asyncio
async def test_proxy_rejects_bad_tickets_methods_and_oversized_bodies(tmp_path):
    manager = await _running_manager(tmp_path, {
        "name": "web", "argv": ["/bin/echo"], "ports": [{"name": "http", "port": 4173}],
    })

    async def fake_forward(*_args, **_kwargs):  # pragma: no cover
        raise AssertionError("forward must not be called")

    gateway = WorkspacePreviewGateway(manager, forward=fake_forward)
    with pytest.raises(WorkspaceGatewayTicketUnavailable):
        gateway.resolve("wprev-not-a-ticket")
    with pytest.raises(WorkspaceGatewayTicketUnavailable):
        gateway.resolve("wprev-" + "0" * 32)
    preview = await gateway.open(WORKSPACE_ID, "web", expected_generation=1)
    with pytest.raises(WorkspaceGatewayRequestRejected):
        await gateway.proxy(preview["ticket"], method="PATCH", path="", query="", headers={}, body=b"")
    with pytest.raises(WorkspaceGatewayRequestRejected):
        await gateway.proxy(preview["ticket"], method="POST", path="", query="", headers={}, body=b"x" * (512 * 1024 + 1))


@pytest.mark.asyncio
async def test_proxy_rewrites_same_origin_and_drops_cross_origin_redirects(tmp_path):
    manager = await _running_manager(tmp_path, {
        "name": "web", "argv": ["/bin/echo"], "ports": [{"name": "http", "port": 4173}],
    })
    replies = [
        {"status": 302, "headers": {"location": "http://127.0.0.1:4173/ok"}, "body": b"", "truncated": False, "location": "http://127.0.0.1:4173/ok"},
        {"status": 302, "headers": {"location": "https://control.example/steal"}, "body": b"", "truncated": False, "location": "https://control.example/steal"},
    ]

    async def fake_forward(*_args, **_kwargs):
        return replies.pop(0)

    gateway = WorkspacePreviewGateway(manager, forward=fake_forward)
    preview = await gateway.open(WORKSPACE_ID, "web", expected_generation=1)
    same = await gateway.proxy(preview["ticket"], method="GET", path="same", query="", headers={}, body=b"")
    assert same["headers"]["location"] == f"/api/local/preview/{preview['ticket']}/ok"
    cross = await gateway.proxy(preview["ticket"], method="GET", path="cross", query="", headers={}, body=b"")
    assert "location" not in cross["headers"]


@pytest.mark.asyncio
async def test_revoke_workspace_drops_sessions(tmp_path):
    manager = await _running_manager(tmp_path, {
        "name": "web", "argv": ["/bin/echo"], "ports": [{"name": "http", "port": 4173}],
    })
    gateway = WorkspacePreviewGateway(manager, forward=_unused_forward)
    preview = await gateway.open(WORKSPACE_ID, "web", expected_generation=1)
    gateway.revoke_workspace(WORKSPACE_ID)
    with pytest.raises(WorkspaceGatewayTicketUnavailable):
        gateway.resolve(preview["ticket"])


@pytest.mark.asyncio
async def test_preview_ticket_expires(tmp_path):
    manager = await _running_manager(tmp_path, {
        "name": "web", "argv": ["/bin/echo"], "ports": [{"name": "http", "port": 4173}],
    })
    gateway = WorkspacePreviewGateway(manager, ttl_seconds=0.05, forward=_unused_forward)
    preview = await gateway.open(WORKSPACE_ID, "web", expected_generation=1)
    await asyncio.sleep(0.12)
    with pytest.raises(WorkspaceGatewayTicketUnavailable):
        gateway.resolve(preview["ticket"])


@pytest.mark.asyncio
async def test_preview_requires_a_single_port_or_a_named_choice(tmp_path):
    manager = await _running_manager(tmp_path, {
        "name": "web", "argv": ["/bin/echo"],
        "ports": [{"name": "http", "port": 4173}, {"name": "ws", "port": 4174}],
    })
    gateway = WorkspacePreviewGateway(manager, forward=_unused_forward)
    with pytest.raises(WorkspaceServiceConflict):
        await gateway.open(WORKSPACE_ID, "web", expected_generation=1)
    chosen = await gateway.open(WORKSPACE_ID, "web", expected_generation=1, port_name="ws")
    calls: list[str] = []

    async def fake_forward(method, url, headers, body, timeout):
        calls.append(url)
        return {"status": 200, "headers": {}, "body": b"", "truncated": False, "location": None}

    gateway._forward = fake_forward
    await gateway.proxy(chosen["ticket"], method="GET", path="x", query="", headers={}, body=b"")
    assert calls and calls[0] == "http://127.0.0.1:4174/x"


@pytest.mark.asyncio
async def test_a_reply_cut_at_the_cap_is_refused_not_passed_off_as_whole(tmp_path):
    """A forward that could only return part of a body says so, and the preview
    refuses the reply instead of relaying the part as if it were complete."""
    manager = await _running_manager(tmp_path, {
        "name": "web", "argv": ["/bin/echo"], "ports": [{"name": "http", "port": 4173}],
    })

    async def fake_forward(*_args, **_kwargs):
        return {"status": 200, "headers": {}, "body": b"x", "truncated": True, "location": None}

    gateway = WorkspacePreviewGateway(manager, forward=fake_forward)
    preview = await gateway.open(WORKSPACE_ID, "web", expected_generation=1)
    with pytest.raises(WorkspaceGatewayResponseTooLarge):
        await gateway.proxy(preview["ticket"], method="GET", path="", query="", headers={}, body=b"")


@pytest.mark.asyncio
async def test_websocket_target_uses_the_declared_loopback_port(tmp_path):
    manager = await _running_manager(tmp_path, {
        "name": "web", "argv": ["/bin/echo"], "ports": [{"name": "http", "port": 4173}],
    })
    gateway = WorkspacePreviewGateway(manager, forward=_unused_forward)
    preview = await gateway.open(WORKSPACE_ID, "web", expected_generation=1)
    target = await gateway.websocket_target(preview["ticket"], path="hmr", query="a=1")
    assert target == {"url": "ws://127.0.0.1:4173/hmr?a=1", "unixSocket": None}
    with pytest.raises(WorkspaceGatewayTicketUnavailable):
        await gateway.websocket_target("wprev-" + "0" * 32, path="", query="")


def test_preview_websocket_route_rejects_an_invalid_ticket(tmp_path):
    from fastapi.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect

    from archon_server.app import create_app
    from archon_server.config import Settings

    settings = Settings(
        archon_root=tmp_path,
        hermes_home=tmp_path / ".hermes",
        data_dir=tmp_path / ".data",
        auth_token="legacy-token",
        local_owner_mode=True,
        start_worker=False,
    )
    with TestClient(create_app(settings)) as client:
        with pytest.raises(WebSocketDisconnect) as exc:
            with client.websocket_connect("/api/local/preview/wprev-" + "0" * 32 + "/"):
                pass
        assert exc.value.code == 1008


@pytest.mark.asyncio
async def test_default_forward_reaches_a_real_loopback_service(tmp_path):
    server, _thread, port = _serve()
    try:
        manager = _startable_manager(tmp_path)
        await manager.define(WORKSPACE_ID, {
            "name": "web", "argv": ["/bin/echo"], "ports": [{"name": "http", "port": port}],
        })
        await manager.start(WORKSPACE_ID, "web")
        gateway = WorkspacePreviewGateway(manager)
        preview = await gateway.open(WORKSPACE_ID, "web", expected_generation=1)
        ok = await gateway.proxy(preview["ticket"], method="GET", path="ok", query="", headers={"accept": "text/plain"}, body=b"")
        assert ok["status"] == 200 and ok["body"] == b"hello-preview"
        assert "set-cookie" not in ok["headers"]
        cross = await gateway.proxy(preview["ticket"], method="GET", path="cross", query="", headers={}, body=b"")
        assert cross["status"] == 302 and "location" not in cross["headers"]
        same = await gateway.proxy(preview["ticket"], method="GET", path="same", query="", headers={}, body=b"")
        assert same["headers"]["location"] == f"/api/local/preview/{preview['ticket']}/ok"
    finally:
        server.shutdown()
        server.server_close()

@pytest.mark.asyncio
async def test_a_ticket_stops_working_when_the_binding_changes(tmp_path):
    """A ticket is a capability for one binding; a stopped process or a new
    generation must end it instead of reaching whatever answers next."""
    manager = await _running_manager(tmp_path, {
        "name": "web", "argv": ["/bin/echo"], "ports": [{"name": "http", "port": 4173}],
    })

    async def fake_forward(*_args, **_kwargs):
        return {"status": 200, "headers": {}, "body": b"ok", "truncated": False, "location": None}

    gateway = WorkspacePreviewGateway(manager, forward=fake_forward)
    preview = await gateway.open(WORKSPACE_ID, "web", expected_generation=1)
    ticket = preview["ticket"]
    assert (await gateway.proxy(ticket, method="GET", path="", query="", headers={}, body=b""))["status"] == 200

    # Stop the process. The live check is cached for a second so a preview can load
    # its assets, so a forced check fails at once and the cached one follows.
    await manager.stop(WORKSPACE_ID, "web", confirm=True)
    with pytest.raises(WorkspaceGatewayTicketUnavailable):
        await gateway.authorize(ticket, force=True)
    # The route that stops a service revokes its tickets immediately.
    gateway.revoke_service(WORKSPACE_ID, "web")
    with pytest.raises(WorkspaceGatewayTicketUnavailable):
        gateway.resolve(ticket)

    # A new generation is a different checkout, so a ticket from the old one is refused too.
    await manager.start(WORKSPACE_ID, "web")
    fresh = await gateway.open(WORKSPACE_ID, "web", expected_generation=1)
    with manager.database.transaction() as conn:
        conn.execute("UPDATE workspaces SET generation=2 WHERE workspace_id=?", (WORKSPACE_ID,))
    with pytest.raises(WorkspaceGatewayTicketUnavailable):
        await gateway.proxy(fresh["ticket"], method="GET", path="", query="", headers={}, body=b"")


@pytest.mark.asyncio
async def test_revoke_service_keeps_other_services_previews(tmp_path):
    manager = await _running_manager(tmp_path, {
        "name": "web", "argv": ["/bin/echo"], "ports": [{"name": "http", "port": 4173}],
    }, {
        "name": "api", "argv": ["/bin/echo"], "ports": [{"name": "http", "port": 4174}],
    })
    gateway = WorkspacePreviewGateway(manager, forward=_unused_forward)
    web = await gateway.open(WORKSPACE_ID, "web", expected_generation=1)
    api = await gateway.open(WORKSPACE_ID, "api", expected_generation=1)
    gateway.revoke_service(WORKSPACE_ID, "web")
    with pytest.raises(WorkspaceGatewayTicketUnavailable):
        gateway.resolve(web["ticket"])
    assert gateway.resolve(api["ticket"])["service"] == "api"
    assert await gateway.authorize(api["ticket"], force=True) is not None


@pytest.mark.asyncio
async def test_authorize_rechecks_are_cached_but_forcible(tmp_path):
    """A preview loads many assets, so the live check is cached briefly - and a
    forced check always reaches the service manager."""
    manager = await _running_manager(tmp_path, {
        "name": "web", "argv": ["/bin/echo"], "ports": [{"name": "http", "port": 4173}],
    })
    gateway = WorkspacePreviewGateway(manager, forward=_unused_forward)
    preview = await gateway.open(WORKSPACE_ID, "web", expected_generation=1)
    calls = 0
    original = manager.preview_target

    async def counting(*args, **kwargs):
        nonlocal calls
        calls += 1
        return await original(*args, **kwargs)

    manager.preview_target = counting
    await gateway.authorize(preview["ticket"])
    await gateway.authorize(preview["ticket"])
    assert calls == 1
    await gateway.authorize(preview["ticket"], force=True)
    assert calls == 2


@pytest.mark.asyncio
async def test_schedule_revalidation_reports_a_lost_binding(tmp_path):
    manager = await _running_manager(tmp_path, {
        "name": "web", "argv": ["/bin/echo"], "ports": [{"name": "http", "port": 4173}],
    })
    gateway = WorkspacePreviewGateway(manager, forward=_unused_forward)
    preview = await gateway.open(WORKSPACE_ID, "web", expected_generation=1)
    lost = asyncio.Event()
    task = gateway.schedule_revalidation(preview["ticket"], lost.set)
    gateway.revoke_service(WORKSPACE_ID, "web")
    await asyncio.wait_for(lost.wait(), timeout=5)
    await asyncio.wait_for(task, timeout=5)

def test_the_server_wires_service_changes_to_preview_revocation(tmp_path):
    """A ticket must not outlive the process binding it was minted for, so the
    server connects every service change to the preview gateway."""
    from fastapi.testclient import TestClient

    from archon_server.app import create_app
    from archon_server.config import Settings

    settings = Settings(
        archon_root=tmp_path,
        hermes_home=tmp_path / ".hermes",
        data_dir=tmp_path / ".data",
        auth_token="legacy-token",
        local_owner_mode=True,
        start_worker=False,
    )
    with TestClient(create_app(settings)) as client:
        services = client.app.state.local_workspace_services
        gateway = client.app.state.local_workspace_preview
        assert services is not None and gateway is not None
        listener = services.change_listener
        assert listener is not None and getattr(listener, "__self__", None) is gateway
        assert listener.__name__ == "revoke_service"



class _SocketHandler(http.server.BaseHTTPRequestHandler):
    """A service that answers on a unix socket and redirects relative to itself."""

    def log_message(self, *_args):  # silence
        return

    def do_GET(self):  # noqa: N802
        if self.path == "/ok":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Set-Cookie", "session=secret")
            self.end_headers()
            self.wfile.write(b"hello-preview")
        elif self.path == "/same":
            self.send_response(302)
            self.send_header("Location", "/ok")
            self.end_headers()
        elif self.path == "/absolute":
            self.send_response(302)
            self.send_header("Location", "http://localhost/ok")
            self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()


def _unix_handler_server(socket_path: Path) -> socketserver.ThreadingUnixStreamServer:
    """A real HTTP service bound to a unix socket, as a declared target would be."""
    socket_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    server = socketserver.ThreadingUnixStreamServer(str(socket_path), _SocketHandler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


@pytest.mark.asyncio
async def test_a_socket_target_is_previewed_over_the_socket_not_a_port(tmp_path):
    """A gateway-only listener answers on its socket, and the proxy never needs a
    loopback port to reach it."""
    short_state = Path(tempfile.mkdtemp(prefix="archon-gw-"))
    manager = _startable_manager(tmp_path, state_root=short_state)
    socket_path = manager.socket_path(WORKSPACE_ID, "web")
    server = _unix_handler_server(socket_path)
    try:
        await manager.define(WORKSPACE_ID, {
            "name": "web", "argv": ["/bin/echo"],
            "ports": [{"name": "http", "unixSocket": str(socket_path)}],
        })
        await manager.start(WORKSPACE_ID, "web")
        gateway = WorkspacePreviewGateway(manager)
        preview = await gateway.open(WORKSPACE_ID, "web", expected_generation=1)
        ok = await gateway.proxy(preview["ticket"], method="GET", path="ok", query="", headers={}, body=b"")
        assert ok["status"] == 200 and ok["body"] == b"hello-preview"
        # A response cookie is stripped on this path too.
        assert "set-cookie" not in ok["headers"]
        assert (await gateway.proxy(preview["ticket"], method="GET", path="missing", query="", headers={}, body=b""))["status"] == 404

        # A relative redirect stays inside the preview; a socket target has no
        # authority to rewrite, so an absolute self-redirect is dropped.
        same = await gateway.proxy(preview["ticket"], method="GET", path="same", query="", headers={}, body=b"")
        assert same["headers"]["location"] == f"/api/local/preview/{preview['ticket']}/ok"
        absolute = await gateway.proxy(preview["ticket"], method="GET", path="absolute", query="", headers={}, body=b"")
        assert "location" not in absolute["headers"]

        target = await gateway.websocket_target(preview["ticket"], path="hmr", query="a=1")
        assert target == {"url": "ws://localhost/hmr?a=1", "unixSocket": str(socket_path)}
        await manager.stop(WORKSPACE_ID, "web", confirm=True)
    finally:
        server.shutdown()
        server.server_close()


@pytest.mark.asyncio
async def test_a_unix_socket_target_moves_and_invalidates_like_a_port(tmp_path):
    """The binding check covers the socket path, so a redefined service cannot be
    reached through a ticket minted for its previous socket."""
    short_state = Path(tempfile.mkdtemp(prefix="archon-gw2-"))
    manager = _startable_manager(tmp_path, state_root=short_state)
    first = manager.socket_path(WORKSPACE_ID, "web")
    server = _unix_handler_server(first)
    try:
        await manager.define(WORKSPACE_ID, {
            "name": "web", "argv": ["/bin/echo"],
            "ports": [{"name": "http", "unixSocket": str(first)}],
        })
        await manager.start(WORKSPACE_ID, "web")
        gateway = WorkspacePreviewGateway(manager)
        preview = await gateway.open(WORKSPACE_ID, "web", expected_generation=1)
        assert (await gateway.proxy(preview["ticket"], method="GET", path="ok", query="", headers={}, body=b""))["status"] == 200

        # Redefining the service to a different socket makes the old ticket invalid.
        await manager.stop(WORKSPACE_ID, "web", confirm=True)
        second = manager.socket_path(WORKSPACE_ID, "other")
        await manager.define(WORKSPACE_ID, {
            "name": "web", "argv": ["/bin/echo"],
            "ports": [{"name": "http", "unixSocket": str(second)}],
        })
        await manager.start(WORKSPACE_ID, "web")
        # The binding moved to a socket that no process bound, so the ticket dies.
        with pytest.raises(WorkspaceGatewayTicketUnavailable):
            await gateway.authorize(preview["ticket"], force=True)
    finally:
        server.shutdown()
        server.server_close()


def test_the_websocket_bridge_can_carry_a_socket_target(tmp_path):
    """The app connects to a socket target with the mechanism proven here.

    `websockets.unix_connect` (the same call the preview route makes for a socket
    target) reaches a WebSocket server that listens on a unix socket only, and a
    message round-trips through it.
    """
    import websockets

    socket_path = Path(tempfile.mkdtemp(prefix="archon-ws-")) / "echo.sock"
    received: list[str] = []

    async def scenario() -> None:
        async def handler(connection) -> None:
            async for message in connection:
                received.append(message)
                await connection.send(f"echo:{message}")

        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(str(socket_path))
        listener.listen(4)
        async with websockets.serve(handler, sock=listener):
            async with websockets.unix_connect(
                path=str(socket_path), uri="ws://localhost/", open_timeout=5,
            ) as client:
                await client.send("hello")
                assert await asyncio.wait_for(client.recv(), timeout=5) == "echo:hello"

    asyncio.run(scenario())
    assert received == ["hello"]


class _QuietUnixServer(socketserver.ThreadingUnixStreamServer):
    """A unix-socket service that does not report a client hanging up on it."""

    daemon_threads = True

    def handle_error(self, request, client_address):
        return


@pytest.mark.asyncio
async def test_a_large_ide_asset_streams_whole_and_a_larger_one_is_aborted(tmp_path, monkeypatch):
    """The editor bundle is far larger than a typical API response, so the cap must
    clear it; a body past the cap is aborted rather than cut and passed off as whole."""
    body = b"x" * (8 * 1024 * 1024)

    class _BigHandler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_args):  # silence
            return

        def do_GET(self):  # noqa: N802
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript")
            self.end_headers()
            self.wfile.write(body)

    short_state = Path(tempfile.mkdtemp(prefix="archon-big-"))
    manager = _startable_manager(tmp_path, state_root=short_state)
    socket_path = manager.socket_path(WORKSPACE_ID, "web")
    socket_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    server = _QuietUnixServer(str(socket_path), _BigHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        await manager.define(WORKSPACE_ID, {
            "name": "web", "argv": ["/bin/echo"],
            "ports": [{"name": "http", "unixSocket": str(socket_path)}],
        })
        await manager.start(WORKSPACE_ID, "web")
        gateway = WorkspacePreviewGateway(manager)
        preview = await gateway.open(WORKSPACE_ID, "web", expected_generation=1)
        whole = await gateway.proxy(preview["ticket"], method="GET", path="asset.js", query="", headers={}, body=b"")
        assert whole["status"] == 200 and len(whole["body"]) == len(body)

        monkeypatch.setattr(gateway_module, "_MAX_RESPONSE_BYTES", 1024)
        with pytest.raises(WorkspaceGatewayResponseTooLarge):
            await gateway.proxy(preview["ticket"], method="GET", path="asset.js", query="", headers={}, body=b"")
        await manager.stop(WORKSPACE_ID, "web", confirm=True)
    finally:
        server.shutdown()
        server.server_close()


# ------------------------------------------------------------------ streaming


async def _pending_watchdogs() -> list[asyncio.Task]:
    """Binding re-checks still running; a finished preview response leaves none.

    A cancelled task finishes on the loop's next pass, so let that pass run first.
    """
    await asyncio.sleep(0)
    return [
        task for task in asyncio.all_tasks()
        if not task.done()
        and task.get_coro().__qualname__.endswith("schedule_revalidation.<locals>.watch")
    ]


async def _until_peer_closes(reader: asyncio.StreamReader) -> None:
    try:
        while await reader.read(65536):
            pass
    except ConnectionError:
        pass


@contextlib.asynccontextmanager
async def _scripted_upstream(respond, *, unix_path: Path | None = None):
    """Answer each connection with `respond(head, reader, writer)` in the test's loop.

    Running the target in the same loop lets a test pace a response chunk by chunk
    and see the moment the gateway lets go of the connection.
    """
    handlers: set[asyncio.Task] = set()

    async def serve(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        handlers.add(asyncio.current_task())
        try:
            head = await reader.readuntil(b"\r\n\r\n")
            await respond(head, reader, writer)
        except (ConnectionError, asyncio.IncompleteReadError):
            pass
        finally:
            writer.close()

    if unix_path is None:
        server = await asyncio.start_server(serve, "127.0.0.1", 0)
        address = server.sockets[0].getsockname()[1]
    else:
        unix_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        server = await asyncio.start_unix_server(serve, path=str(unix_path))
        address = str(unix_path)
    try:
        yield address
    finally:
        server.close()
        for task in handlers:
            task.cancel()
        await asyncio.gather(*handlers, return_exceptions=True)


async def _streaming_gateway(tmp_path: Path, port: int):
    manager = await _running_manager(tmp_path, {
        "name": "web", "argv": ["/bin/echo"], "ports": [{"name": "http", "port": port}],
    })
    gateway = WorkspacePreviewGateway(manager)
    preview = await gateway.open(WORKSPACE_ID, "web", expected_generation=1)
    return manager, gateway, preview["ticket"]


@pytest.mark.asyncio
async def test_a_preview_body_streams_before_the_target_finishes(tmp_path):
    """A chunk reaches the preview as soon as the target sends it, not once the
    whole response is done, and the head is filtered before the first byte."""
    release = asyncio.Event()
    heads: list[bytes] = []

    async def respond(head, reader, writer):
        heads.append(head)
        writer.write(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nSet-Cookie: session=secret\r\n"
            b"Transfer-Encoding: chunked\r\n\r\n5\r\nfirst\r\n"
        )
        await writer.drain()
        await release.wait()
        writer.write(b"6\r\nsecond\r\n0\r\n\r\n")
        await writer.drain()

    async with _scripted_upstream(respond) as port:
        _manager_, gateway, ticket = await _streaming_gateway(tmp_path, port)
        stream = await gateway.proxy_stream(
            ticket, method="GET", path="log", query="n=1",
            headers={"accept": "text/plain", "authorization": "Bearer secret", "cookie": "x=1"},
            body=b"",
        )
        try:
            assert stream.status == 200
            assert stream.headers["content-type"] == "text/plain"
            assert "set-cookie" not in stream.headers and "transfer-encoding" not in stream.headers
            assert await asyncio.wait_for(anext(stream), timeout=5) == b"first"
            assert not release.is_set()
            release.set()
            assert [chunk async for chunk in stream] == [b"second"]
        finally:
            await stream.aclose()
    request = heads[0].lower()
    assert request.startswith(b"get /log?n=1 http/1.1\r\n")
    assert b"accept: text/plain" in request
    assert b"authorization" not in request and b"cookie" not in request
    await asyncio.sleep(0)
    assert await _pending_watchdogs() == []


@pytest.mark.asyncio
async def test_a_socket_target_streams_an_event_stream(tmp_path):
    release = asyncio.Event()

    async def respond(head, reader, writer):
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\ndata: one\n\n")
        await writer.drain()
        await release.wait()
        writer.write(b"data: two\n\n")
        await writer.drain()

    short_state = Path(tempfile.mkdtemp(prefix="archon-gw-sse-"))
    manager = _startable_manager(tmp_path, state_root=short_state)
    socket_path = manager.socket_path(WORKSPACE_ID, "web")
    async with _scripted_upstream(respond, unix_path=socket_path):
        await manager.define(WORKSPACE_ID, {
            "name": "web", "argv": ["/bin/echo"],
            "ports": [{"name": "http", "unixSocket": str(socket_path)}],
        })
        await manager.start(WORKSPACE_ID, "web")
        gateway = WorkspacePreviewGateway(manager)
        preview = await gateway.open(WORKSPACE_ID, "web", expected_generation=1)
        stream = await gateway.proxy_stream(
            preview["ticket"], method="GET", path="events", query="",
            headers={"accept": "text/event-stream"}, body=b"",
        )
        try:
            assert stream.headers["content-type"] == "text/event-stream"
            assert await asyncio.wait_for(anext(stream), timeout=5) == b"data: one\n\n"
            release.set()
            # The target closing its end is the end of an undelimited body.
            assert [chunk async for chunk in stream] == [b"data: two\n\n"]
        finally:
            await stream.aclose()
        await manager.stop(WORKSPACE_ID, "web", confirm=True)
    assert await _pending_watchdogs() == []


@pytest.mark.asyncio
async def test_a_body_that_outgrows_the_cap_is_aborted_not_cut_short(tmp_path, monkeypatch):
    monkeypatch.setattr(gateway_module, "_MAX_RESPONSE_BYTES", 1024)
    more = asyncio.Event()
    gone = asyncio.Event()

    async def respond(head, reader, writer):
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n\r\n" + b"x" * 600)
        await writer.drain()
        await more.wait()
        try:
            for _ in range(4):
                writer.write(b"x" * 600)
                await writer.drain()
        except ConnectionError:
            pass
        await _until_peer_closes(reader)
        gone.set()

    async with _scripted_upstream(respond) as port:
        _manager_, gateway, ticket = await _streaming_gateway(tmp_path, port)
        stream = await gateway.proxy_stream(ticket, method="GET", path="blob", query="", headers={}, body=b"")
        received = await asyncio.wait_for(anext(stream), timeout=5)
        assert received == b"x" * 600
        more.set()
        with pytest.raises(WorkspaceGatewayResponseTooLarge):
            while True:
                received += await asyncio.wait_for(anext(stream), timeout=5)
        # Nothing past the cap was handed on, and the target connection is gone.
        assert len(received) <= 1024
        await asyncio.wait_for(gone.wait(), timeout=5)
    assert await _pending_watchdogs() == []


@pytest.mark.asyncio
async def test_a_declared_length_over_the_cap_is_refused_before_any_byte(tmp_path, monkeypatch):
    monkeypatch.setattr(gateway_module, "_MAX_RESPONSE_BYTES", 1024)
    gone = asyncio.Event()

    async def respond(head, reader, writer):
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 4096\r\n\r\n")
        await writer.drain()
        if head.startswith(b"HEAD "):
            return
        await _until_peer_closes(reader)
        gone.set()

    async with _scripted_upstream(respond) as port:
        _manager_, gateway, ticket = await _streaming_gateway(tmp_path, port)
        with pytest.raises(WorkspaceGatewayResponseTooLarge):
            await gateway.proxy_stream(ticket, method="GET", path="big", query="", headers={}, body=b"")
        await asyncio.wait_for(gone.wait(), timeout=5)
        # A HEAD reply carries no body, so its declared length is no reason to refuse it.
        head = await gateway.proxy(ticket, method="HEAD", path="big", query="", headers={}, body=b"")
        assert head["status"] == 200 and head["body"] == b"" and "content-length" not in head["headers"]
    assert await _pending_watchdogs() == []


@pytest.mark.asyncio
async def test_a_stalled_target_is_dropped_after_the_idle_timeout(tmp_path, monkeypatch):
    monkeypatch.setattr(gateway_module, "_IDLE_TIMEOUT_SECONDS", 0.2)
    closed: list[str] = []

    async def respond(head, reader, writer):
        path = head.split(b" ", 2)[1].decode()
        if path == "/body":
            writer.write(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nfirst\r\n")
            await writer.drain()
        # Then say nothing more - or nothing at all - until the gateway gives up.
        await _until_peer_closes(reader)
        closed.append(path)

    async with _scripted_upstream(respond) as port:
        _manager_, gateway, ticket = await _streaming_gateway(tmp_path, port)
        loop = asyncio.get_running_loop()
        started = loop.time()
        with pytest.raises(WorkspaceGatewayUpstreamError):
            await gateway.proxy_stream(ticket, method="GET", path="head", query="", headers={}, body=b"")
        stream = await gateway.proxy_stream(ticket, method="GET", path="body", query="", headers={}, body=b"")
        assert await asyncio.wait_for(anext(stream), timeout=5) == b"first"
        with pytest.raises(WorkspaceGatewayUpstreamError):
            await asyncio.wait_for(anext(stream), timeout=5)
        assert loop.time() - started < 3
        for _ in range(250):
            if len(closed) == 2:
                break
            await asyncio.sleep(0.02)
        assert sorted(closed) == ["/body", "/head"]
    assert await _pending_watchdogs() == []


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["stop", "remove", "generation"])
async def test_an_open_stream_stops_when_its_binding_changes(tmp_path, monkeypatch, change):
    """A long response is re-checked like a WebSocket: a stopped or removed service
    or a new generation ends it promptly, even while the target sits quiet."""
    monkeypatch.setattr(gateway_module, "_AUTHORIZE_INTERVAL_SECONDS", 0.05)
    gone = asyncio.Event()

    async def respond(head, reader, writer):
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\ndata: one\n\n")
        await writer.drain()
        await _until_peer_closes(reader)
        gone.set()

    async with _scripted_upstream(respond) as port:
        manager, gateway, ticket = await _streaming_gateway(tmp_path, port)
        stream = await gateway.proxy_stream(ticket, method="GET", path="events", query="", headers={}, body=b"")
        assert await asyncio.wait_for(anext(stream), timeout=5) == b"data: one\n\n"
        if change == "stop":
            await manager.stop(WORKSPACE_ID, "web", confirm=True)
        elif change == "remove":
            await manager.remove(WORKSPACE_ID, "web", confirm=True)
        else:
            with manager.database.transaction() as conn:
                conn.execute("UPDATE workspaces SET generation=2 WHERE workspace_id=?", (WORKSPACE_ID,))
        # The idle timeout is a minute, so only the binding check can end this in time.
        with pytest.raises(WorkspaceGatewayTicketUnavailable):
            await asyncio.wait_for(anext(stream), timeout=5)
        await asyncio.wait_for(gone.wait(), timeout=5)
    assert await _pending_watchdogs() == []


@pytest.mark.asyncio
async def test_a_request_waiting_for_its_head_stops_when_its_binding_changes(tmp_path, monkeypatch):
    monkeypatch.setattr(gateway_module, "_AUTHORIZE_INTERVAL_SECONDS", 0.05)
    gone = asyncio.Event()

    async def respond(head, reader, writer):
        await _until_peer_closes(reader)
        gone.set()

    async with _scripted_upstream(respond) as port:
        manager, gateway, ticket = await _streaming_gateway(tmp_path, port)
        pending = asyncio.ensure_future(
            gateway.proxy_stream(ticket, method="GET", path="poll", query="", headers={}, body=b"")
        )
        await asyncio.sleep(0.1)
        assert not pending.done()
        await manager.stop(WORKSPACE_ID, "web", confirm=True)
        with pytest.raises(WorkspaceGatewayTicketUnavailable):
            await asyncio.wait_for(pending, timeout=5)
        await asyncio.wait_for(gone.wait(), timeout=5)
    assert await _pending_watchdogs() == []


@pytest.mark.asyncio
async def test_closing_a_stream_early_releases_the_target(tmp_path):
    gone = asyncio.Event()

    async def respond(head, reader, writer):
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\ndata: one\n\n")
        await writer.drain()
        await _until_peer_closes(reader)
        gone.set()

    async with _scripted_upstream(respond) as port:
        _manager_, gateway, ticket = await _streaming_gateway(tmp_path, port)
        stream = await gateway.proxy_stream(ticket, method="GET", path="events", query="", headers={}, body=b"")
        assert await asyncio.wait_for(anext(stream), timeout=5) == b"data: one\n\n"
        await stream.aclose()
        await asyncio.wait_for(gone.wait(), timeout=5)
        await asyncio.sleep(0)
        assert await _pending_watchdogs() == []
        with pytest.raises(StopAsyncIteration):
            await anext(stream)


@pytest.mark.asyncio
async def test_a_target_or_header_that_could_split_the_request_is_refused(tmp_path):
    """The request line is written verbatim, so a decoded line break in the path or
    a header value is refused before any connection, on either kind of target."""
    connections: list[bytes] = []

    async def respond(head, reader, writer):
        connections.append(head)

    short_state = Path(tempfile.mkdtemp(prefix="archon-gw-split-"))
    manager = _startable_manager(tmp_path, state_root=short_state)
    socket_path = manager.socket_path(WORKSPACE_ID, "sock")
    async with _scripted_upstream(respond) as port, _scripted_upstream(respond, unix_path=socket_path):
        await manager.define(WORKSPACE_ID, {
            "name": "web", "argv": ["/bin/echo"], "ports": [{"name": "http", "port": port}],
        })
        await manager.define(WORKSPACE_ID, {
            "name": "sock", "argv": ["/bin/echo"],
            "ports": [{"name": "http", "unixSocket": str(socket_path)}],
        })
        await manager.start(WORKSPACE_ID, "web")
        await manager.start(WORKSPACE_ID, "sock")
        gateway = WorkspacePreviewGateway(manager)
        for name in ("web", "sock"):
            ticket = (await gateway.open(WORKSPACE_ID, name, expected_generation=1))["ticket"]
            for path in ("a\r\nX-Injected: 1", "a b", "a\tb"):
                with pytest.raises(ValueError):
                    await gateway.proxy_stream(ticket, method="GET", path=path, query="", headers={}, body=b"")
            with pytest.raises(ValueError):
                await gateway.proxy_stream(
                    ticket, method="GET", path="ok", query="", headers={"accept": "a\r\nX-Injected: 1"}, body=b"",
                )
        await asyncio.sleep(0.05)
    assert connections == []
    assert await _pending_watchdogs() == []


@contextlib.asynccontextmanager
async def _served_preview(tmp_path: Path, port_entry: dict):
    """Run the real app under uvicorn in this loop with one previewable service.

    The preview route streams, so it is exercised over a real HTTP/1.1 connection,
    where an aborted body and a client that goes away are both visible.
    """
    import uvicorn

    from archon_server.app import create_app
    from archon_server.config import Settings

    settings = Settings(
        archon_root=tmp_path,
        hermes_home=tmp_path / ".hermes",
        data_dir=tmp_path / ".data",
        auth_token="legacy-token",
        local_owner_mode=True,
        start_worker=False,
    )
    app = create_app(settings)
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, log_config=None, access_log=False, timeout_graceful_shutdown=2))
    serving = asyncio.create_task(server.serve(sockets=[listener]))
    try:
        for _ in range(1000):
            if server.started or serving.done():
                break
            await asyncio.sleep(0.01)
        assert server.started
        services = app.state.local_workspace_services
        workspace_root = tmp_path / "workspace"
        workspace_root.mkdir(exist_ok=True)
        services.database.create_workspace(
            workspace_id=WORKSPACE_ID,
            root=str(workspace_root),
            owner_id=services.owner_id,
            project_id="project-test",
            generation=1,
            isolation_profile="git-checkout",
        )

        async def fake_spawn(*_argv, **_kwargs):
            return _GateProcess()

        services._spawn = fake_spawn
        await services.define(WORKSPACE_ID, {"name": "web", "argv": ["/bin/echo"], "ports": [port_entry]})
        await services.start(WORKSPACE_ID, "web")
        preview = await app.state.local_workspace_preview.open(WORKSPACE_ID, "web", expected_generation=1)
        yield port, preview["ticket"]
    finally:
        server.should_exit = True
        await asyncio.wait_for(serving, timeout=15)
        listener.close()


async def _preview_get(port: int, ticket: str, path: str):
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    writer.write(
        f"GET /api/local/preview/{ticket}/{path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n"
        "Accept: text/event-stream\r\n\r\n".encode("ascii")
    )
    await writer.drain()
    head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=5)
    return head.lower(), reader, writer


@pytest.mark.asyncio
async def test_the_preview_route_relays_an_event_stream_as_it_arrives(tmp_path):
    release = asyncio.Event()
    gone = asyncio.Event()

    async def respond(head, reader, writer):
        writer.write(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nSet-Cookie: session=secret\r\n\r\n"
            b"data: one\n\n"
        )
        await writer.drain()
        await release.wait()
        writer.write(b"data: two\n\n")
        await writer.drain()
        await _until_peer_closes(reader)
        gone.set()

    async with _scripted_upstream(respond) as target_port:
        async with _served_preview(tmp_path, {"name": "http", "port": target_port}) as (port, ticket):
            head, reader, writer = await _preview_get(port, ticket, "events")
            assert head.startswith(b"http/1.1 200")
            assert b"content-type: text/event-stream" in head and b"cache-control: no-store" in head
            assert b"set-cookie" not in head and b"transfer-encoding: chunked" in head
            await asyncio.wait_for(reader.readuntil(b"data: one\n\n"), timeout=5)
            assert not release.is_set()
            release.set()
            await asyncio.wait_for(reader.readuntil(b"data: two\n\n"), timeout=5)
            # The preview view going away drops the target connection too.
            writer.close()
            await asyncio.wait_for(gone.wait(), timeout=5)
            for _ in range(100):
                if not await _pending_watchdogs():
                    break
                await asyncio.sleep(0.02)
            assert await _pending_watchdogs() == []


@pytest.mark.asyncio
async def test_the_preview_route_refuses_or_aborts_a_body_over_the_cap(tmp_path, monkeypatch):
    monkeypatch.setattr(gateway_module, "_MAX_RESPONSE_BYTES", 1024)

    async def respond(head, reader, writer):
        if head.startswith(b"GET /declared "):
            writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 4096\r\n\r\n")
            await writer.drain()
        else:
            writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n\r\n")
            for _ in range(4):
                writer.write(b"x" * 600)
                await writer.drain()
                await asyncio.sleep(0.02)
        await _until_peer_closes(reader)

    async with _scripted_upstream(respond) as target_port:
        async with _served_preview(tmp_path, {"name": "http", "port": target_port}) as (port, ticket):
            head, _reader, writer = await _preview_get(port, ticket, "declared")
            assert head.startswith(b"http/1.1 502")
            writer.close()

            head, reader, writer = await _preview_get(port, ticket, "streamed")
            assert head.startswith(b"http/1.1 200") and b"transfer-encoding: chunked" in head
            rest = await asyncio.wait_for(reader.read(), timeout=5)
            # The connection ends without the terminating chunk: the client sees an
            # aborted transfer, never a short body presented as complete.
            assert not rest.endswith(b"0\r\n\r\n")
            assert rest.count(b"x") <= 1024
            writer.close()
