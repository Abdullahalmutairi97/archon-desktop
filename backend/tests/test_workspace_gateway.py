from __future__ import annotations

import asyncio
import http.server
import socket
import threading
from pathlib import Path

import pytest

from archon_server.db import Database
from archon_server.services.workspace_gateway import (
    WorkspaceGatewayRequestRejected,
    WorkspaceGatewayTicketUnavailable,
    WorkspacePreviewGateway,
)
from archon_server.services.workspace_services import WorkspaceServiceConflict, WorkspaceServiceManager, WorkspaceServiceNotFound


OWNER_ID = "local-uid:1000"
WORKSPACE_ID = "workspace-0123456789abcdef0123456789abcdef"


def _manager(tmp_path: Path) -> WorkspaceServiceManager:
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
        database, owner_id=OWNER_ID, state_root=tmp_path / "private-state",
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


@pytest.mark.asyncio
async def test_open_requires_a_registered_service_and_declared_port(tmp_path):
    manager = _manager(tmp_path)
    gateway = WorkspacePreviewGateway(manager, forward=_unused_forward)
    with pytest.raises(WorkspaceServiceNotFound):
        await gateway.open(WORKSPACE_ID, "missing", expected_generation=1)
    await manager.define(WORKSPACE_ID, {"name": "plain", "argv": ["/bin/echo"]})
    with pytest.raises(WorkspaceServiceConflict):
        await gateway.open(WORKSPACE_ID, "plain", expected_generation=1)
    await manager.define(WORKSPACE_ID, {
        "name": "web", "argv": ["/bin/echo"], "ports": [{"name": "http", "port": 4173}],
    })
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
    manager = _manager(tmp_path)
    await manager.define(WORKSPACE_ID, {
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
    manager = _manager(tmp_path)
    await manager.define(WORKSPACE_ID, {
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
    manager = _manager(tmp_path)
    await manager.define(WORKSPACE_ID, {
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
    manager = _manager(tmp_path)
    await manager.define(WORKSPACE_ID, {
        "name": "web", "argv": ["/bin/echo"], "ports": [{"name": "http", "port": 4173}],
    })
    gateway = WorkspacePreviewGateway(manager, forward=_unused_forward)
    preview = await gateway.open(WORKSPACE_ID, "web", expected_generation=1)
    gateway.revoke_workspace(WORKSPACE_ID)
    with pytest.raises(WorkspaceGatewayTicketUnavailable):
        gateway.resolve(preview["ticket"])


@pytest.mark.asyncio
async def test_default_forward_reaches_a_real_loopback_service(tmp_path):
    server, _thread, port = _serve()
    try:
        manager = _manager(tmp_path)
        await manager.define(WORKSPACE_ID, {
            "name": "web", "argv": ["/bin/echo"], "ports": [{"name": "http", "port": port}],
        })
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
