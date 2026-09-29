import asyncio
import socket

import pytest
from fastapi.testclient import TestClient

from archon_server.app import create_app
from archon_server.config import Settings
from archon_server.services.preview import PreviewError, PreviewGateway, PreviewLimit, PreviewUnavailable


class Upstream:
    """A tiny dev server that records what it receives."""

    def __init__(self):
        self.requests = []
        self.server = None
        self.port = 0

    async def start(self):
        self.server = await asyncio.start_server(self._handle, "127.0.0.1", 0)
        self.port = self.server.sockets[0].getsockname()[1]
        return self

    async def stop(self):
        self.server.close()
        await self.server.wait_closed()

    async def _handle(self, reader, writer):
        try:
            try:
                head = (await reader.readuntil(b"\r\n\r\n")).decode("latin-1")
            except asyncio.IncompleteReadError:
                return  # the gateway's reachability probe connects and closes
            lines = head.split("\r\n")
            method, target, _ = lines[0].split(" ")
            headers = {k.lower(): v.strip() for k, _, v in (l.partition(":") for l in lines[1:] if l)}
            self.requests.append({"method": method, "target": target, "headers": headers})
            if headers.get("upgrade") == "websocket":
                writer.write(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
                await writer.drain()
                while data := await reader.read(1024):
                    writer.write(b"echo:" + data)
                    await writer.drain()
                return
            if target == "/redirect":
                body = b""
                extra = f"Location: http://localhost:{self.port}/landing?a=1\r\n"
                status = "302 Found"
            elif method == "POST":
                body = await reader.readexactly(int(headers["content-length"]))
                extra, status = "", "200 OK"
            else:
                body = f"hello {target}".encode()
                extra, status = "", "200 OK"
            writer.write(
                f"HTTP/1.1 {status}\r\n{extra}Content-Length: {len(body)}\r\nConnection: keep-alive\r\n\r\n".encode()
                + body
            )
            await writer.drain()
        finally:
            writer.close()


async def request(port, raw: bytes) -> bytes:
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    writer.write(raw)
    await writer.drain()
    try:
        return await asyncio.wait_for(reader.read(-1), 5)
    finally:
        writer.close()


def get(path, port, *headers):
    lines = [f"GET {path} HTTP/1.1", f"Host: 127.0.0.1:{port}", *headers]
    return ("\r\n".join(lines) + "\r\n\r\n").encode()


@pytest.fixture
async def upstream():
    server = await Upstream().start()
    yield server
    await server.stop()


@pytest.fixture
async def gateway():
    gw = PreviewGateway("127.0.0.1", (8787,))
    yield gw
    await gw.close_all()


def cookie_for(preview):
    return f"Cookie: theme=dark; archon_preview_{preview['id']}={preview['secret']}; archon_preview_other=x"


async def test_listener_refuses_requests_without_the_preview_secret(upstream, gateway):
    preview = await gateway.open(upstream.port, "100.64.0.1")
    assert preview["origin"] == f"http://100.64.0.1:{preview['port']}"

    missing = await request(preview["port"], get("/", preview["port"]))
    wrong = await request(preview["port"], get("/?archon_preview=nope", preview["port"]))
    forged = await request(preview["port"], get("/", preview["port"], f"Cookie: archon_preview_{preview['id']}=nope"))

    for response in (missing, wrong, forged):
        assert response.startswith(b"HTTP/1.1 403")
    assert upstream.requests == []


async def test_first_navigation_trades_the_query_secret_for_an_httponly_cookie(upstream, gateway):
    preview = await gateway.open(upstream.port, "127.0.0.1")
    response = (await request(
        preview["port"], get(f"//evil.example/app?x=1&archon_preview={preview['secret']}", preview["port"]),
    )).decode()

    assert response.startswith("HTTP/1.1 303")
    assert "Location: /app?x=1\r\n" in response
    assert f"Set-Cookie: archon_preview_{preview['id']}={preview['secret']}; Path=/; HttpOnly; SameSite=Lax" in response
    assert upstream.requests == []


async def test_authorized_request_reaches_the_dev_server_as_localhost(upstream, gateway):
    preview = await gateway.open(upstream.port, "127.0.0.1")
    port = preview["port"]
    response = await request(port, get(
        "/assets/app.js", port, cookie_for(preview), f"Origin: http://127.0.0.1:{port}",
        f"Referer: http://127.0.0.1:{port}/index.html", "Connection: keep-alive",
    ))

    assert response.startswith(b"HTTP/1.1 200")
    assert response.endswith(b"hello /assets/app.js")
    assert b"Connection: close" in response and b"keep-alive" not in response
    seen = upstream.requests[0]["headers"]
    assert seen["host"] == f"localhost:{upstream.port}"
    assert seen["origin"] == f"http://localhost:{upstream.port}"
    assert seen["referer"] == f"http://localhost:{upstream.port}/index.html"
    assert seen["cookie"] == "theme=dark"
    assert seen["connection"] == "close"


async def test_redirects_to_the_dev_server_stay_inside_the_preview(upstream, gateway):
    preview = await gateway.open(upstream.port, "127.0.0.1")
    response = await request(preview["port"], get("/redirect", preview["port"], cookie_for(preview)))
    assert b"Location: /landing?a=1\r\n" in response


async def test_request_bodies_are_relayed(upstream, gateway):
    preview = await gateway.open(upstream.port, "127.0.0.1")
    port = preview["port"]
    raw = (
        f"POST /api HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{cookie_for(preview)}\r\n"
        "Content-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"ok\":true}"
    ).encode()
    response = await request(port, raw)
    assert response.endswith(b'{"ok":true}')


async def test_websocket_upgrades_stay_open_in_both_directions(upstream, gateway):
    preview = await gateway.open(upstream.port, "127.0.0.1")
    port = preview["port"]
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    writer.write(get("/hmr", port, cookie_for(preview), "Upgrade: websocket", "Connection: Upgrade"))
    await writer.drain()
    head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 5)
    assert head.startswith(b"HTTP/1.1 101")
    assert b"Connection: Upgrade" in head
    writer.write(b"ping")
    await writer.drain()
    assert await asyncio.wait_for(reader.readexactly(9), 5) == b"echo:ping"
    writer.close()
    assert upstream.requests[0]["headers"]["connection"] == "Upgrade"


async def test_open_reuses_a_port_and_enforces_limits(upstream, tmp_path):
    gateway = PreviewGateway("127.0.0.1", (8787,), max_previews=1)
    try:
        first = await gateway.open(upstream.port, "127.0.0.1")
        again = await gateway.open(upstream.port, "127.0.0.1")
        assert again["id"] == first["id"] and again["secret"] == first["secret"]
        assert [row["id"] for row in gateway.list("127.0.0.1")] == [first["id"]]
        assert "secret" not in gateway.list("127.0.0.1")[0]

        other = await Upstream().start()
        try:
            with pytest.raises(PreviewLimit):
                await gateway.open(other.port, "127.0.0.1")
        finally:
            await other.stop()

        with pytest.raises(ValueError):
            await gateway.open(8787, "127.0.0.1")
        with pytest.raises(ValueError):
            await gateway.open(0, "127.0.0.1")
    finally:
        await gateway.close_all()


async def test_open_rejects_dead_ports_and_wildcard_binds(gateway):
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        dead = probe.getsockname()[1]
    with pytest.raises(PreviewUnavailable):
        await gateway.open(dead, "127.0.0.1")
    with pytest.raises(PreviewError):
        await PreviewGateway("0.0.0.0").open(dead, "127.0.0.1")


async def test_closing_a_preview_stops_its_listener(upstream, gateway):
    preview = await gateway.open(upstream.port, "127.0.0.1")
    assert await gateway.close(preview["id"]) is True
    assert await gateway.close(preview["id"]) is False
    with pytest.raises(OSError):
        await asyncio.open_connection("127.0.0.1", preview["port"])


async def test_idle_previews_are_swept(upstream):
    gateway = PreviewGateway("127.0.0.1", idle_seconds=0)
    preview = await gateway.open(upstream.port, "127.0.0.1")
    assert gateway.list("127.0.0.1") == []
    await asyncio.sleep(0.05)
    with pytest.raises(OSError):
        await asyncio.open_connection("127.0.0.1", preview["port"])


def test_preview_api_requires_the_token_and_reports_errors(tmp_path):
    settings = Settings(data_dir=tmp_path, auth_token="preview-token", start_worker=False, bind_host="127.0.0.1")
    auth = {"Authorization": "Bearer preview-token"}
    with socket.socket() as listening, socket.socket() as dead:
        listening.bind(("127.0.0.1", 0))
        listening.listen()
        dead.bind(("127.0.0.1", 0))
        port, dead_port = listening.getsockname()[1], dead.getsockname()[1]
        with TestClient(create_app(settings), base_url="http://127.0.0.1") as client:
            assert client.post("/api/previews", json={"port": port}).status_code == 401
            assert client.post("/api/previews", json={"port": 0}, headers=auth).status_code == 422
            assert client.post("/api/previews", json={"port": dead_port}, headers=auth).status_code == 404

            opened = client.post("/api/previews", json={"port": port}, headers=auth)
            assert opened.status_code == 201
            assert opened.headers["cache-control"] == "no-store"
            preview = opened.json()["preview"]
            assert preview["origin"] == f"http://127.0.0.1:{preview['port']}"
            assert preview["upstream_port"] == port

            with socket.create_connection(("127.0.0.1", preview["port"]), timeout=5) as conn:
                conn.sendall(get("/", preview["port"]))
                assert conn.recv(64).startswith(b"HTTP/1.1 403")

            listed = client.get("/api/previews", headers=auth).json()["previews"]
            assert [row["id"] for row in listed] == [preview["id"]]
            assert client.delete(f"/api/previews/{preview['id']}", headers=auth).json() == {"ok": True}
            assert client.delete(f"/api/previews/{preview['id']}", headers=auth).status_code == 404
