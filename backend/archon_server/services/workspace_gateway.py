"""Bounded, ticket-gated loopback preview for registered workspace services.

A preview session is a short-lived, read-only capability bound to one
workspace, service and declared port. The sandboxed preview view carries the
ticket in its URL, never an Archon credential, so the proxy forwards only a
small request-header allowlist, refuses to follow redirects off the preview
origin, strips response cookies and bounds request bodies. A response body is
relayed as it arrives, bounded in total size, in idle time and by the ticket's
live binding. Only a port declared by a registered service can be reached; a
chat URL or a port parsed from logs never authorizes a proxy target.
"""
from __future__ import annotations

import asyncio
import http.client
import io
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, AsyncIterator, Awaitable, Callable
from urllib.parse import urlsplit

from .workspace_services import WorkspaceServiceManager

_TICKET = re.compile(r"wprev-[0-9a-f]{32}\Z")
_DEFAULT_TTL_SECONDS = 600.0
_MAX_SESSIONS = 8
_MAX_REQUEST_BYTES = 512 * 1024
# The largest asset a previewed IDE serves (code-server's workbench bundle) is
# about 19 MiB, so a 2 MiB cap truncated it and no editor could load. A body is
# relayed as it arrives rather than held, so this no longer sets what the gateway
# keeps in memory; it caps what one response may carry. A body that would pass it
# is aborted, never cut short and passed off as complete.
_MAX_RESPONSE_BYTES = 24 * 1024 * 1024
_CONNECT_TIMEOUT_SECONDS = 10.0
# A dev server may compile a page before its first byte, and an event stream or a
# long poll sits quiet between messages, so the wait for the response head and
# between body chunks is longer than the connect bound - but still bounded, so a
# stalled target cannot pin a connection.
_IDLE_TIMEOUT_SECONDS = 60.0
_READ_CHUNK_BYTES = 64 * 1024
_MAX_HEAD_LINE_BYTES = 64 * 1024
_MAX_HEAD_LINES = 100
_MAX_INTERIM_RESPONSES = 8
# A preview session is re-validated against the live workspace and service, so a
# ticket cannot outlive a generation change or a stopped service. The result is
# cached only briefly: a preview loads many assets, but a revoked binding must
# stop answering promptly.
_AUTHORIZE_CACHE_SECONDS = 1.0
_AUTHORIZE_INTERVAL_SECONDS = 2.0
_PREVIEWABLE_STATES = frozenset({"starting", "running"})
_ALLOWED_METHODS = frozenset({"GET", "HEAD", "POST", "PUT", "DELETE"})
_FORWARD_REQUEST_HEADERS = frozenset({"accept", "accept-language", "content-type", "range"})
_STRIP_RESPONSE_HEADERS = frozenset({
    "set-cookie", "set-cookie2", "content-length", "transfer-encoding", "connection", "keep-alive",
})
_HOP_BY_HOP = frozenset({"connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade"})
# The request line and forwarded header values are written verbatim, so anything
# that could end a line or smuggle a second request is refused, as http.client did.
_REQUEST_TARGET = re.compile(r"/[\x21-\x7e]*\Z")
_HEADER_VALUE = re.compile(r"[^\r\n\x00]*\Z")


class WorkspaceGatewayError(RuntimeError):
    """Base error for the workspace preview gateway."""


class WorkspaceGatewayTicketUnavailable(WorkspaceGatewayError):
    """The preview ticket is unknown, expired or malformed."""


class WorkspaceGatewayRequestRejected(WorkspaceGatewayError):
    """The proxied request is outside the bounded preview contract."""


class WorkspaceGatewayServiceUnavailable(WorkspaceGatewayError):
    """The service has no live process to preview."""


class WorkspaceGatewayUpstreamError(WorkspaceGatewayError):
    """The declared target did not answer, stalled or broke the HTTP/1.1 contract."""


class WorkspaceGatewayResponseTooLarge(WorkspaceGatewayUpstreamError):
    """The target's response is larger than one preview response may carry."""


# A forward returns the target's reply: `status`, `headers`, `location` and either
# `stream` - a body read as it arrives, with a synchronous `close` - or a complete
# `body` with a `truncated` flag.
Forward = Callable[[str, str, dict[str, str], bytes, float], Awaitable[dict[str, Any]]]


class _UpstreamBody:
    """The body of one upstream HTTP/1.1 response, read as it arrives.

    Framing follows the response head as `http.client` does: no body for HEAD,
    1xx, 204 and 304, then chunked transfer coding, a declared length, or
    everything until the target closes. A body that ends before its framing says
    it should is an error, never a short success.
    """

    def __init__(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, *,
        chunked: bool, length: int | None,
    ):
        self._reader = reader
        self._writer = writer
        self._chunked = chunked
        self._length = length

    def __aiter__(self) -> AsyncIterator[bytes]:
        return self._chunks()

    def close(self) -> None:
        # Abort rather than close gracefully: a relay that stops has nothing left
        # to send, and a pending read must wake at once.
        self._writer.transport.abort()

    async def _chunks(self) -> AsyncIterator[bytes]:
        try:
            if self._chunked:
                async for piece in self._read_chunked():
                    yield piece
            elif self._length is not None:
                remaining = self._length
                while remaining:
                    piece = await self._reader.read(min(remaining, _READ_CHUNK_BYTES))
                    if not piece:
                        raise WorkspaceGatewayUpstreamError("Preview target ended its response early")
                    remaining -= len(piece)
                    yield piece
            else:
                while piece := await self._reader.read(_READ_CHUNK_BYTES):
                    yield piece
        except (OSError, ValueError) as exc:
            raise WorkspaceGatewayUpstreamError("Preview target sent a malformed response") from exc
        finally:
            self.close()

    async def _read_chunked(self) -> AsyncIterator[bytes]:
        while True:
            # A size line longer than the reader's limit raises ValueError.
            size = int((await self._reader.readline()).split(b";", 1)[0].strip(), 16)
            if size < 0:
                raise ValueError("negative chunk size")
            if size == 0:
                for _ in range(_MAX_HEAD_LINES + 1):
                    if await self._reader.readline() in (b"\r\n", b"\n", b""):
                        return
                raise ValueError("too many trailer lines")
            remaining = size
            while remaining:
                piece = await self._reader.read(min(remaining, _READ_CHUNK_BYTES))
                if not piece:
                    raise WorkspaceGatewayUpstreamError("Preview target ended its response early")
                remaining -= len(piece)
                yield piece
            if await self._reader.readline() not in (b"\r\n", b"\n"):
                raise ValueError("chunk is not terminated")


class _CompleteBody:
    """A reply a forward already holds in full, relayed as one chunk."""

    def __init__(self, body: bytes):
        self._body = body

    async def __aiter__(self) -> AsyncIterator[bytes]:
        if self._body:
            yield self._body

    def close(self) -> None:
        return None


def _encode_request(method: str, target: str, host: str, headers: dict[str, str], body: bytes) -> bytes:
    if not _REQUEST_TARGET.fullmatch(target):
        raise ValueError("Preview request target is not permitted")
    lines = [f"{method} {target} HTTP/1.1", f"Host: {host}", "Accept-Encoding: identity", "Connection: close"]
    for key, value in headers.items():
        if not _HEADER_VALUE.fullmatch(value):
            raise ValueError("Preview request header is not permitted")
        lines.append(f"{key}: {value}")
    if body or method in ("POST", "PUT"):
        lines.append(f"Content-Length: {len(body)}")
    return ("\r\n".join(lines) + "\r\n\r\n").encode("latin-1") + body


async def _read_head(reader: asyncio.StreamReader) -> tuple[int, http.client.HTTPMessage]:
    """Read one final response head, skipping interim 1xx responses."""
    for _ in range(_MAX_INTERIM_RESPONSES + 1):
        status_line = (await reader.readline()).decode("iso-8859-1")
        parts = status_line.split(None, 2)
        if len(parts) < 2 or not parts[0].startswith("HTTP/") or len(parts[1]) != 3:
            raise ValueError("malformed status line")
        status = int(parts[1])
        if not 100 <= status <= 999:
            raise ValueError("malformed status line")
        lines: list[bytes] = []
        while (line := await reader.readline()) not in (b"\r\n", b"\n", b""):
            lines.append(line)
            if len(lines) > _MAX_HEAD_LINES:
                raise ValueError("too many header lines")
        # 100 Continue and 103 Early Hints precede the response that counts.
        if 100 <= status < 200 and status != 101:
            continue
        return status, http.client.parse_headers(io.BytesIO(b"".join(lines) + b"\r\n"))
    raise ValueError("too many interim responses")


def _body_framing(method: str, status: int, message: http.client.HTTPMessage) -> tuple[bool, int | None]:
    """Return (chunked, declared length) the way `http.client` frames a body."""
    if method == "HEAD" or status in (204, 304) or 100 <= status < 200:
        return False, 0
    transfer = message.get("transfer-encoding")
    if transfer and transfer.lower() == "chunked":
        return True, None
    declared = message.get("content-length")
    if not declared:
        return False, None
    try:
        length = int(declared)
    except ValueError:
        return False, None
    return False, length if length >= 0 else None


async def _exchange(
    connect: Callable[[], Awaitable[tuple[asyncio.StreamReader, asyncio.StreamWriter]]],
    *, host: str, method: str, target: str, headers: dict[str, str], body: bytes, timeout: float,
) -> dict[str, Any]:
    """Send one request and read the response head; the body is left to stream.

    Redirects are never followed and only the caller's allowlisted headers are
    sent. A body declared larger than the cap is refused before any byte of it
    is read.
    """
    request = _encode_request(method, target, host, headers, body)
    try:
        async with asyncio.timeout(timeout):
            reader, writer = await connect()
    except OSError as exc:  # includes TimeoutError
        raise WorkspaceGatewayUpstreamError("Preview target is not answering") from exc
    try:
        async with asyncio.timeout(_IDLE_TIMEOUT_SECONDS):
            writer.write(request)
            await writer.drain()
            status, message = await _read_head(reader)
        chunked, length = _body_framing(method, status, message)
        if length is not None and length > _MAX_RESPONSE_BYTES:
            raise WorkspaceGatewayResponseTooLarge("Preview response is larger than a preview may carry")
    except TimeoutError as exc:
        writer.transport.abort()
        raise WorkspaceGatewayUpstreamError("Preview target stalled before answering") from exc
    except (OSError, ValueError, http.client.HTTPException) as exc:
        writer.transport.abort()
        raise WorkspaceGatewayUpstreamError("Preview target sent a malformed response") from exc
    except BaseException:
        writer.transport.abort()
        raise
    collected = {str(key).lower(): str(value) for key, value in message.items()}
    return {
        "status": status,
        "headers": collected,
        "location": collected.get("location"),
        "stream": _UpstreamBody(reader, writer, chunked=chunked, length=length),
    }


async def _default_forward(
    method: str, url: str, headers: dict[str, str], body: bytes, timeout: float,
) -> dict[str, Any]:
    """Open one bounded, non-redirecting loopback exchange whose body streams."""
    parts = urlsplit(url)
    authority = f"http://{parts.netloc}"
    if (parts.scheme != "http" or parts.hostname != "127.0.0.1" or parts.port is None
            or not url.startswith(authority)):
        raise ValueError("Preview target must be a loopback port")
    # urlsplit drops tabs and line breaks, so the target is taken from the URL as
    # given (less a fragment, as urllib did) and a control character is refused.
    target = url[len(authority):].split("#", 1)[0] or "/"
    port = parts.port
    return await _exchange(
        lambda: asyncio.open_connection("127.0.0.1", port, limit=_MAX_HEAD_LINE_BYTES),
        host=parts.netloc, method=method, target=target, headers=headers, body=body, timeout=timeout,
    )


async def _unix_forward(
    socket_path: str, method: str, path_query: str, headers: dict[str, str], body: bytes, timeout: float,
) -> dict[str, Any]:
    """Open one bounded, non-redirecting exchange with a declared unix socket.

    The contract matches the loopback forward: the same bounds apply, redirects
    are never followed, and only the caller's allowlisted headers are sent.
    """
    return await _exchange(
        lambda: asyncio.open_unix_connection(socket_path, limit=_MAX_HEAD_LINE_BYTES),
        host="localhost", method=method, target=path_query, headers=headers, body=body, timeout=timeout,
    )


class WorkspacePreviewStream:
    """One proxied response whose body is relayed as it arrives.

    The status and filtered headers are known before the first body byte. From
    the moment the request is forwarded until the body ends, the ticket is
    re-checked on the same interval as a preview WebSocket. A body that would
    pass the cap, sits idle too long or outlives its binding raises instead of
    ending, so a consumer never mistakes a cut body for a complete one.
    """

    def __init__(self, gateway: WorkspacePreviewGateway, ticket: str):
        self.status = 0
        self.headers: dict[str, str] = {}
        self._gateway = gateway
        self._ticket = ticket
        self._pending: asyncio.Future[dict[str, Any]] | None = None
        self._body: Any = None
        self._chunks: AsyncIterator[bytes] | None = None
        self._watchdog: asyncio.Task[None] | None = None
        self._sent = 0
        self._lost = False
        self._closed = False

    async def _receive(self, forwarding: Awaitable[dict[str, Any]]) -> dict[str, Any]:
        """Wait for the target's reply head while the binding is watched."""
        self._watchdog = self._gateway.schedule_revalidation(self._ticket, self._on_lost)
        self._pending = asyncio.ensure_future(forwarding)
        try:
            result = await self._pending
        except asyncio.CancelledError:
            self.close()
            current = asyncio.current_task()
            if self._lost and (current is None or not current.cancelling()):
                raise WorkspaceGatewayTicketUnavailable("Preview binding changed; open a new preview") from None
            raise
        except BaseException:
            self.close()
            raise
        finally:
            self._pending = None
        body = result.get("stream")
        self._body = body if body is not None else _CompleteBody(result.get("body", b""))
        self._chunks = self._body.__aiter__()
        try:
            self._raise_if_lost(None)
        except BaseException:
            self.close()
            raise
        return result

    def __aiter__(self) -> WorkspacePreviewStream:
        return self

    async def __anext__(self) -> bytes:
        if self._closed or self._chunks is None:
            raise StopAsyncIteration
        try:
            return await self._next_chunk()
        except BaseException:
            self.close()
            raise

    async def _next_chunk(self) -> bytes:
        self._raise_if_lost(None)
        try:
            async with asyncio.timeout(_IDLE_TIMEOUT_SECONDS):
                chunk = await anext(self._chunks)
        except TimeoutError as exc:
            self._raise_if_lost(exc)
            raise WorkspaceGatewayUpstreamError("Preview target stalled") from exc
        except (StopAsyncIteration, WorkspaceGatewayError, OSError) as exc:
            # A lost binding is ended by cutting the connection, so whatever the
            # read saw next is not a real end of the body.
            self._raise_if_lost(exc)
            raise
        self._raise_if_lost(None)
        self._sent += len(chunk)
        if self._sent > _MAX_RESPONSE_BYTES:
            raise WorkspaceGatewayResponseTooLarge("Preview response is larger than a preview may carry")
        return chunk

    def _raise_if_lost(self, cause: BaseException | None) -> None:
        if self._lost:
            raise WorkspaceGatewayTicketUnavailable("Preview binding changed; open a new preview") from cause

    def _on_lost(self) -> None:
        self._lost = True
        if self._pending is not None:
            self._pending.cancel()
        if self._body is not None:
            self._body.close()

    def close(self) -> None:
        """Release the target connection and stop watching the ticket; idempotent."""
        if self._closed:
            return
        self._closed = True
        if self._watchdog is not None:
            self._watchdog.cancel()
        if self._pending is not None:
            self._pending.cancel()
        if self._body is not None:
            self._body.close()

    async def aclose(self) -> None:
        self.close()


class WorkspacePreviewGateway:
    """Issue and resolve bounded preview tickets for registered services."""

    def __init__(
        self,
        manager: WorkspaceServiceManager,
        *,
        ttl_seconds: float = _DEFAULT_TTL_SECONDS,
        max_sessions: int = _MAX_SESSIONS,
        forward: Forward | None = None,
    ):
        if (isinstance(ttl_seconds, bool) or not isinstance(ttl_seconds, (int, float))
                or ttl_seconds <= 0 or ttl_seconds > 3600):
            raise ValueError("ttl_seconds must be between 0 and 3600")
        if isinstance(max_sessions, bool) or not isinstance(max_sessions, int) or not 1 <= max_sessions <= 32:
            raise ValueError("max_sessions must be between 1 and 32")
        self._manager = manager
        self._ttl_seconds = float(ttl_seconds)
        self._max_sessions = max_sessions
        self._forward = forward or _default_forward
        self._sessions: dict[str, dict[str, Any]] = {}
        self._authorized: dict[str, float] = {}
        self._clock: Callable[[], float] = lambda: asyncio.get_running_loop().time()

    async def open(
        self, workspace_id: str, name: str, *, expected_generation: int, port_name: str | None = None,
    ) -> dict[str, str]:
        """Open a read-only preview session for a registered service's declared port."""
        target = await self._manager.preview_target(
            workspace_id, name, expected_generation=expected_generation, port_name=port_name,
        )
        self._prune()
        active = [session for session in self._sessions.values() if session["workspaceId"] == workspace_id]
        if len(active) >= self._max_sessions:
            raise WorkspaceGatewayError("Preview session limit reached for this workspace")
        if target["state"] not in _PREVIEWABLE_STATES:
            # A stopped, failed or unregistered service has nothing to preview.
            raise WorkspaceGatewayServiceUnavailable("Service is not running; start it before previewing")
        ticket = "wprev-" + uuid.uuid4().hex
        session = {
            "ticket": ticket,
            "workspaceId": workspace_id,
            "service": name,
            "port": target.get("port"),
            "unixSocket": target.get("unixSocket"),
            "portName": target["portName"],
            "generation": target["generation"],
            "mode": "read-only",
            "expiresAt": datetime.now(timezone.utc) + timedelta(seconds=self._ttl_seconds),
        }
        self._sessions[ticket] = session
        return {"ticket": ticket, "mode": "read-only", "expiresAt": session["expiresAt"].isoformat()}

    def resolve(self, ticket: str) -> dict[str, Any]:
        self._prune()
        if not isinstance(ticket, str) or not _TICKET.fullmatch(ticket):
            raise WorkspaceGatewayTicketUnavailable("Preview ticket is invalid or expired")
        session = self._sessions.get(ticket)
        if session is None:
            raise WorkspaceGatewayTicketUnavailable("Preview ticket is invalid or expired")
        return session

    def revoke_workspace(self, workspace_id: str) -> None:
        """Drop every ticket for a workspace, e.g. after a generation change."""
        self._sessions = {
            ticket: session for ticket, session in self._sessions.items()
            if session["workspaceId"] != workspace_id
        }
        self._authorized.clear()

    def revoke_service(self, workspace_id: str, name: str) -> None:
        """Drop every ticket for one service, e.g. after it was stopped or removed."""
        self._sessions = {
            ticket: session for ticket, session in self._sessions.items()
            if not (session["workspaceId"] == workspace_id and session["service"] == name)
        }
        self._authorized.clear()

    async def authorize(self, ticket: str, *, force: bool = False) -> dict[str, Any]:
        """Re-check a ticket against the live workspace, service and process state.

        A ticket is a capability for one binding: the same workspace generation,
        the same service and the same declared port. Anything else - a
        re-provisioned checkout, a removed service, a stopped process - makes it
        invalid, so a stale preview page stops reaching a process it no longer
        belongs to.
        """
        session = self.resolve(ticket)
        now = self._clock()
        cached = self._authorized.get(ticket)
        if not force and cached is not None and now - cached < _AUTHORIZE_CACHE_SECONDS:
            return session
        try:
            target = await self._manager.preview_target(
                session["workspaceId"], session["service"],
                expected_generation=session["generation"], port_name=session["portName"],
            )
        except Exception as exc:  # noqa: BLE001 - every failure invalidates the ticket
            self._sessions.pop(ticket, None)
            self._authorized.pop(ticket, None)
            raise WorkspaceGatewayTicketUnavailable(
                "Preview binding changed; open a new preview"
            ) from exc
        if target.get("port") != session["port"] or target.get("unixSocket") != session["unixSocket"]:
            self._sessions.pop(ticket, None)
            self._authorized.pop(ticket, None)
            raise WorkspaceGatewayTicketUnavailable("Preview binding changed; open a new preview")
        if target["state"] not in _PREVIEWABLE_STATES:
            self._sessions.pop(ticket, None)
            self._authorized.pop(ticket, None)
            raise WorkspaceGatewayTicketUnavailable("Service is no longer running; open a new preview")
        self._authorized[ticket] = now
        return session

    async def websocket_target(self, ticket: str, *, path: str, query: str) -> dict[str, Any]:
        """Resolve a ticket to the declared target's WebSocket endpoint.

        A loopback port target answers on `ws://127.0.0.1:<port>`, while a declared
        unix socket has no authority at all: the caller connects to the socket file
        and asks for the same request path.
        """
        session = await self.authorize(ticket)
        target_path = "/" + path if path else "/"
        if query:
            target_path += "?" + query
        if session.get("unixSocket"):
            return {"url": f"ws://localhost{target_path}", "unixSocket": session["unixSocket"]}
        return {"url": f"ws://127.0.0.1:{session['port']}{target_path}", "unixSocket": None}

    def schedule_revalidation(self, ticket: str, on_lost: Callable[[], None]) -> asyncio.Task[None]:
        """Watch one open ticket and call `on_lost` as soon as its binding changes.

        A long-lived WebSocket or streamed response can outlive the workspace
        generation or the service process, so the connection is re-checked on a
        bounded interval for as long as it stays open.
        """

        async def watch() -> None:
            while True:
                await asyncio.sleep(_AUTHORIZE_INTERVAL_SECONDS)
                try:
                    await self.authorize(ticket, force=True)
                except WorkspaceGatewayTicketUnavailable:
                    try:
                        on_lost()
                    except Exception:
                        pass
                    return
                except asyncio.CancelledError:
                    raise
                except Exception:
                    return

        return asyncio.create_task(watch())

    async def proxy(
        self,
        ticket: str,
        *,
        method: str,
        path: str,
        query: str,
        headers: dict[str, str],
        body: bytes,
        prefix: str = "/api/local/preview/",
    ) -> dict[str, Any]:
        """Proxy one bounded request and collect its whole response.

        The preview route relays a body as it arrives through `proxy_stream`; this
        collects the same bounded stream for a caller that needs the whole reply.
        """
        stream = await self.proxy_stream(
            ticket, method=method, path=path, query=query, headers=headers, body=body,
        )
        try:
            collected = b"".join([chunk async for chunk in stream])
        finally:
            stream.close()
        return {"status": stream.status, "headers": stream.headers, "body": collected}

    async def proxy_stream(
        self,
        ticket: str,
        *,
        method: str,
        path: str,
        query: str,
        headers: dict[str, str],
        body: bytes,
    ) -> WorkspacePreviewStream:
        """Proxy one bounded request to the ticket's declared target.

        The returned stream carries the status and filtered headers; its body is
        read from the target only as the caller consumes it, and the caller must
        `close` it when done, however it ends.
        """
        session = await self.authorize(ticket)
        if method not in _ALLOWED_METHODS:
            raise WorkspaceGatewayRequestRejected("Method is not permitted for a preview")
        if len(body) > _MAX_REQUEST_BYTES:
            raise WorkspaceGatewayRequestRejected("Preview request body is too large")
        target_path = "/" + path if path else "/"
        if query:
            target_path += "?" + query
        forward_headers = {
            key: value for key, value in headers.items()
            if key.lower() in _FORWARD_REQUEST_HEADERS
        }
        if session.get("unixSocket"):
            forwarding = _unix_forward(
                session["unixSocket"], method, target_path, forward_headers, body, _CONNECT_TIMEOUT_SECONDS,
            )
        else:
            url = f"http://127.0.0.1:{session['port']}{target_path}"
            forwarding = self._forward(method, url, forward_headers, body, _CONNECT_TIMEOUT_SECONDS)
        stream = WorkspacePreviewStream(self, ticket)
        result = await stream._receive(forwarding)
        try:
            if result.get("truncated"):
                # A reply the forward could only hold in part is never relayed as whole.
                raise WorkspaceGatewayResponseTooLarge("Preview response is larger than a preview may carry")
            response_headers = {
                key: value for key, value in result["headers"].items()
                if key.lower() not in _STRIP_RESPONSE_HEADERS and key.lower() not in _HOP_BY_HOP
            }
            location = result.get("location")
            if location:
                rewritten = self._rewrite_location(location, session)
                if rewritten is None:
                    response_headers.pop("location", None)
                else:
                    response_headers["location"] = rewritten
        except BaseException:
            stream.close()
            raise
        stream.status = result["status"]
        stream.headers = response_headers
        return stream

    @staticmethod
    def _rewrite_location(location: str, session: dict[str, Any]) -> str | None:
        base = f"/api/local/preview/{session['ticket']}"
        if location.startswith("/"):
            return base + location
        # A loopback target may answer with its own authority; a unix socket target
        # has none, so only its path-relative redirects are kept.
        authority = f"http://127.0.0.1:{session['port']}" if session.get("port") else None
        if authority and location.startswith(authority):
            remainder = location[len(authority):] or "/"
            return base + remainder
        return None

    def _prune(self) -> None:
        now = datetime.now(timezone.utc)
        self._sessions = {
            ticket: session for ticket, session in self._sessions.items()
            if session["expiresAt"] > now
        }
        for ticket in [key for key in self._authorized if key not in self._sessions]:
            self._authorized.pop(ticket, None)
