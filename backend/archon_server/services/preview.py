"""Private previews of web servers that agents start on this host.

Agents run here, so a dev server they start listens on this host's loopback,
which the desktop cannot reach. A preview gives one loopback port its own
listener on the service's bind address. Each listener is its own origin, so
root-relative assets, redirects and WebSockets (hot reload) behave as they do
on localhost.

Opening a preview requires the API token. The listener itself requires a
256-bit preview secret: the first navigation carries it as a query parameter
and is answered with an HttpOnly cookie, so the secret never stays in the page
URL. Only the upstream port chosen at open time is ever reached.
"""
from __future__ import annotations

import asyncio
import hmac
import ipaddress
import logging
import secrets
import time
import uuid
from dataclasses import dataclass, field
from http.cookies import SimpleCookie
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

logger = logging.getLogger(__name__)

QUERY_KEY = "archon_preview"
COOKIE_PREFIX = "archon_preview_"
_LOOPBACK = ("127.0.0.1", "::1")
_MAX_HEAD_BYTES = 64 * 1024
_HEAD_TIMEOUT = 30.0
_CONNECT_TIMEOUT = 5.0
_MAX_CONNECTIONS = 64
_CHUNK = 64 * 1024


class PreviewError(RuntimeError):
    pass


class PreviewUnavailable(PreviewError):
    """Nothing answers on the requested loopback port."""


class PreviewLimit(PreviewError):
    pass


@dataclass
class _Preview:
    id: str
    upstream_port: int
    upstream_host: str
    secret: str
    server: asyncio.base_events.Server
    port: int
    created: float
    last_used: float
    connections: set[asyncio.Task] = field(default_factory=set)

    @property
    def cookie(self) -> str:
        return COOKIE_PREFIX + self.id

    def public(self, host: str) -> dict:
        shown = f"[{host}]" if ":" in host else host
        return {
            "id": self.id,
            "upstream_port": self.upstream_port,
            "port": self.port,
            "origin": f"http://{shown}:{self.port}",
            "secret": self.secret,
            "query_key": QUERY_KEY,
        }


def _wildcard(host: str) -> bool:
    try:
        return ipaddress.ip_address(host.strip("[]")).is_unspecified
    except ValueError:
        return host in ("", "*")


async def _connect_upstream(host: str, port: int):
    return await asyncio.wait_for(asyncio.open_connection(host, port), _CONNECT_TIMEOUT)


async def _read_head(reader: asyncio.StreamReader, timeout: float) -> bytes:
    try:
        return await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout)
    except asyncio.LimitOverrunError as exc:
        raise PreviewError("header too large") from exc


def _split_head(head: bytes) -> tuple[str, list[tuple[str, str]]]:
    lines = head.decode("latin-1").split("\r\n")
    start, headers = lines[0], []
    for line in lines[1:]:
        if not line:
            continue
        name, sep, value = line.partition(":")
        if not sep or not name or name != name.strip() or "\n" in line or "\x00" in line:
            raise PreviewError("malformed header")
        headers.append((name, value.strip()))
    return start, headers


def _join_head(start: str, headers: list[tuple[str, str]]) -> bytes:
    return ("\r\n".join([start, *(f"{name}: {value}" for name, value in headers)]) + "\r\n\r\n").encode("latin-1")


def _get(headers: list[tuple[str, str]], name: str) -> str | None:
    for key, value in headers:
        if key.lower() == name:
            return value
    return None


def _without(headers: list[tuple[str, str]], *names: str) -> list[tuple[str, str]]:
    return [(k, v) for k, v in headers if k.lower() not in names]


def _simple_response(status: str, extra: list[tuple[str, str]] = (), body: bytes = b"") -> bytes:
    headers = [("Content-Type", "text/plain; charset=utf-8"), ("Content-Length", str(len(body))),
               ("Cache-Control", "no-store"), ("Connection", "close"), *extra]
    return _join_head(f"HTTP/1.1 {status}", headers) + body


class PreviewGateway:
    def __init__(self, bind_host: str, reserved_ports: tuple[int, ...] = (), *,
                 idle_seconds: float = 1800.0, max_previews: int = 8):
        self.bind_host = bind_host
        self.reserved_ports = set(reserved_ports)
        self.idle_seconds = idle_seconds
        self.max_previews = max_previews
        self._previews: dict[str, _Preview] = {}
        self._lock = asyncio.Lock()

    async def open(self, upstream_port: int, request_host: str) -> dict:
        if not 1 <= upstream_port <= 65535:
            raise ValueError("port must be between 1 and 65535")
        if upstream_port in self.reserved_ports:
            raise ValueError("that port belongs to the Archon service")
        if _wildcard(self.bind_host):
            raise PreviewError("previews are disabled while the service binds a wildcard address")
        async with self._lock:
            self._sweep()
            for preview in self._previews.values():
                if preview.upstream_port == upstream_port:
                    preview.last_used = time.monotonic()
                    return preview.public(request_host)
            if len(self._previews) >= self.max_previews:
                raise PreviewLimit(f"close a preview first; at most {self.max_previews} can be open")
            upstream_host = await self._probe(upstream_port)
            preview_id = uuid.uuid4().hex[:16]
            holder: dict[str, _Preview] = {}
            server = await asyncio.start_server(
                lambda r, w: self._accept(holder["preview"], r, w), host=self.bind_host, port=0,
                limit=_MAX_HEAD_BYTES,
            )
            now = time.monotonic()
            preview = _Preview(
                id=preview_id, upstream_port=upstream_port, upstream_host=upstream_host,
                secret=secrets.token_urlsafe(32), server=server,
                port=server.sockets[0].getsockname()[1], created=now, last_used=now,
            )
            holder["preview"] = preview
            self._previews[preview_id] = preview
            return preview.public(request_host)

    def list(self, request_host: str) -> list[dict]:
        self._sweep()
        rows = [p.public(request_host) for p in self._previews.values()]
        for row in rows:
            row.pop("secret")
        return rows

    async def close(self, preview_id: str) -> bool:
        preview = self._previews.pop(preview_id, None)
        if preview is None:
            return False
        await self._shutdown(preview)
        return True

    async def run_sweeper(self, interval: float = 60.0) -> None:
        while True:
            await asyncio.sleep(interval)
            self._sweep()

    async def close_all(self) -> None:
        for preview_id in list(self._previews):
            await self.close(preview_id)

    def _sweep(self) -> None:
        cutoff = time.monotonic() - self.idle_seconds
        for preview_id, preview in list(self._previews.items()):
            if preview.last_used < cutoff and not preview.connections:
                del self._previews[preview_id]
                preview.server.close()

    async def _shutdown(self, preview: _Preview) -> None:
        preview.server.close()
        for task in list(preview.connections):
            task.cancel()
        await asyncio.gather(*preview.connections, return_exceptions=True)
        await preview.server.wait_closed()

    async def _probe(self, port: int) -> str:
        for host in _LOOPBACK:
            try:
                _, writer = await _connect_upstream(host, port)
            except (OSError, asyncio.TimeoutError):
                continue
            writer.close()
            return host
        raise PreviewUnavailable(f"nothing is listening on localhost:{port} on the server")

    async def _accept(self, preview: _Preview, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        task = asyncio.current_task()
        if len(preview.connections) >= _MAX_CONNECTIONS:
            writer.close()
            return
        preview.connections.add(task)
        preview.last_used = time.monotonic()
        try:
            await self._handle(preview, reader, writer)
        except (OSError, asyncio.IncompleteReadError, asyncio.TimeoutError, PreviewError, asyncio.CancelledError):
            pass
        except Exception:
            logger.exception("preview connection failed")
        finally:
            preview.connections.discard(task)
            preview.last_used = time.monotonic()
            writer.close()

    def _authorized(self, preview: _Preview, headers: list[tuple[str, str]]) -> bool:
        for key, value in headers:
            if key.lower() != "cookie":
                continue
            jar = SimpleCookie()
            try:
                jar.load(value)
            except Exception:
                continue
            morsel = jar.get(preview.cookie)
            if morsel is not None and hmac.compare_digest(morsel.value, preview.secret):
                return True
        return False

    async def _handle(self, preview: _Preview, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        start, headers = _split_head(await _read_head(reader, _HEAD_TIMEOUT))
        parts = start.split(" ")
        if len(parts) != 3 or not parts[2].startswith("HTTP/1."):
            writer.write(_simple_response("400 Bad Request"))
            return
        method, target, version = parts
        query = urlsplit(target)
        pairs = parse_qsl(query.query, keep_blank_values=True)
        offered = [value for key, value in pairs if key == QUERY_KEY]
        if offered:
            if not hmac.compare_digest(offered[0], preview.secret):
                writer.write(_simple_response("403 Forbidden", body=b"This preview link is not valid.\n"))
                return
            path = "/" + (query.path or "/").lstrip("/")
            clean = urlunsplit(("", "", path, urlencode([(k, v) for k, v in pairs if k != QUERY_KEY]), ""))
            cookie = f"{preview.cookie}={preview.secret}; Path=/; HttpOnly; SameSite=Lax"
            writer.write(_simple_response("303 See Other", [("Location", clean), ("Set-Cookie", cookie)]))
            return
        if not self._authorized(preview, headers):
            writer.write(_simple_response("403 Forbidden", body=b"Open this preview from Archon Desktop.\n"))
            return

        upstream_origin = f"http://localhost:{preview.upstream_port}"
        preview_origins = {f"http://{_get(headers, 'host')}"}
        upgrade = (_get(headers, "upgrade") or "") and "upgrade" in (_get(headers, "connection") or "").lower()
        rewritten: list[tuple[str, str]] = []
        for key, value in headers:
            lower = key.lower()
            if lower == "host":
                value = f"localhost:{preview.upstream_port}"
            elif lower in ("origin", "referer"):
                for origin in preview_origins:
                    if value == origin or value.startswith(origin + "/"):
                        value = upstream_origin + value[len(origin):]
            elif lower == "cookie":
                kept = "; ".join(
                    part.strip() for part in value.split(";")
                    if part.strip() and not part.strip().startswith(COOKIE_PREFIX)
                )
                if not kept:
                    continue
                value = kept
            elif lower in ("connection", "keep-alive", "proxy-connection") and not upgrade:
                continue
            rewritten.append((key, value))
        if not upgrade:
            rewritten.append(("Connection", "close"))

        try:
            up_reader, up_writer = await _connect_upstream(preview.upstream_host, preview.upstream_port)
        except (OSError, asyncio.TimeoutError):
            writer.write(_simple_response(
                "502 Bad Gateway",
                body=f"Nothing is answering on localhost:{preview.upstream_port} on the server.\n".encode(),
            ))
            return
        try:
            up_writer.write(_join_head(f"{method} {target} {version}", rewritten))
            await up_writer.drain()
            to_upstream = asyncio.create_task(self._pipe(reader, up_writer))
            try:
                await self._relay_response(preview, up_reader, writer)
            finally:
                to_upstream.cancel()
                await asyncio.gather(to_upstream, return_exceptions=True)
        finally:
            up_writer.close()

    async def _relay_response(self, preview: _Preview, up_reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        while True:
            start, headers = _split_head(await _read_head(up_reader, 300.0))
            status = start.split(" ", 2)[1] if start.count(" ") >= 1 else ""
            informational = status.startswith("1") and status != "101"
            if not informational and status != "101":
                headers = _without(headers, "connection", "keep-alive") + [("Connection", "close")]
            headers = [(k, self._local_location(preview, v) if k.lower() == "location" else v) for k, v in headers]
            writer.write(_join_head(start, headers))
            await writer.drain()
            if not informational:
                break
        await self._pipe(up_reader, writer)

    @staticmethod
    def _local_location(preview: _Preview, value: str) -> str:
        parsed = urlsplit(value)
        if parsed.scheme in ("http", "https") and parsed.port == preview.upstream_port and \
                parsed.hostname in ("localhost", "127.0.0.1", "::1", "0.0.0.0"):
            return urlunsplit(("", "", parsed.path or "/", parsed.query, parsed.fragment))
        return value

    @staticmethod
    async def _pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            while chunk := await reader.read(_CHUNK):
                writer.write(chunk)
                await writer.drain()
        finally:
            if writer.can_write_eof():
                try:
                    writer.write_eof()
                except OSError:
                    pass
