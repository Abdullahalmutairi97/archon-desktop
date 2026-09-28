"""Bounded, ticket-gated loopback preview for registered workspace services.

A preview session is a short-lived, read-only capability bound to one
workspace, service and declared port. The sandboxed preview view carries the
ticket in its URL, never an Archon credential, so the proxy forwards only a
small request-header allowlist, refuses to follow redirects off the preview
origin, strips response cookies and bounds request and response bodies. Only a
port declared by a registered service can be reached; a chat URL or a port parsed
from logs never authorizes a proxy target.
"""
from __future__ import annotations

import asyncio
import http.client
import re
import socket
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable

from .workspace_services import WorkspaceServiceManager

_TICKET = re.compile(r"wprev-[0-9a-f]{32}\Z")
_DEFAULT_TTL_SECONDS = 600.0
_MAX_SESSIONS = 8
_MAX_REQUEST_BYTES = 512 * 1024
# The largest asset a previewed IDE serves (code-server's workbench bundle) is
# about 19 MiB, so a 2 MiB cap truncated it and no editor could load. The proxy
# buffers one response in memory per request and a workspace is limited to eight
# preview sessions, so this bound is what the gateway may hold at once.
_MAX_RESPONSE_BYTES = 24 * 1024 * 1024
_TIMEOUT_SECONDS = 10.0
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


class WorkspaceGatewayError(RuntimeError):
    """Base error for the workspace preview gateway."""


class WorkspaceGatewayTicketUnavailable(WorkspaceGatewayError):
    """The preview ticket is unknown, expired or malformed."""


class WorkspaceGatewayRequestRejected(WorkspaceGatewayError):
    """The proxied request is outside the bounded preview contract."""


class WorkspaceGatewayServiceUnavailable(WorkspaceGatewayError):
    """The service has no live process to preview."""


Forward = Callable[[str, str, dict[str, str], bytes, float], Awaitable[dict[str, Any]]]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:  # noqa: D401 - never follow
        return None


async def _default_forward(
    method: str, url: str, headers: dict[str, str], body: bytes, timeout: float,
) -> dict[str, Any]:
    """Perform one bounded, non-redirecting loopback request via urllib."""

    def call() -> dict[str, Any]:
        request = urllib.request.Request(url, data=body if body else None, method=method)
        for key, value in headers.items():
            request.add_header(key, value)
        opener = urllib.request.build_opener(_NoRedirect)
        try:
            response = opener.open(request, timeout=timeout)
        except urllib.error.HTTPError as exc:
            response = exc
        try:
            status = int(getattr(response, "status", getattr(response, "code", 0)))
            header_items = getattr(response, "headers", None)
            collected = {str(k).lower(): str(v) for k, v in header_items.items()} if header_items else {}
            raw = response.read(_MAX_RESPONSE_BYTES + 1)
            truncated = len(raw) > _MAX_RESPONSE_BYTES
            return {
                "status": status,
                "headers": collected,
                "body": raw[:_MAX_RESPONSE_BYTES],
                "truncated": truncated,
                "location": collected.get("location"),
            }
        finally:
            try:
                response.close()
            except Exception:
                pass

    return await asyncio.to_thread(call)




class _UnixSocketHTTPConnection(http.client.HTTPConnection):
    """One HTTP connection over a declared unix socket, never a TCP port."""

    def __init__(self, socket_path: str, timeout: float):
        super().__init__("localhost", timeout=timeout)
        self._socket_path = socket_path

    def connect(self) -> None:
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self._socket_path)


async def _unix_forward(
    socket_path: str, method: str, path_query: str, headers: dict[str, str], body: bytes, timeout: float,
) -> dict[str, Any]:
    """Perform one bounded, non-redirecting request to a declared unix socket.

    The contract matches the loopback forward: the response body is read with the
    same cap, redirects are never followed, and only the caller's allowlisted
    headers are sent.
    """

    def call() -> dict[str, Any]:
        connection = _UnixSocketHTTPConnection(socket_path, timeout)
        try:
            connection.request(method, path_query, body=body if body else None, headers=headers)
            response = connection.getresponse()
            collected = {str(key).lower(): str(value) for key, value in response.getheaders()}
            raw = response.read(_MAX_RESPONSE_BYTES + 1)
            truncated = len(raw) > _MAX_RESPONSE_BYTES
            return {
                "status": int(response.status),
                "headers": collected,
                "body": raw[:_MAX_RESPONSE_BYTES],
                "truncated": truncated,
                "location": collected.get("location"),
            }
        finally:
            try:
                connection.close()
            except Exception:
                pass

    return await asyncio.to_thread(call)


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

        A long-lived WebSocket can outlive the workspace generation or the service
        process, so the connection is re-checked on a bounded interval for as long
        as it stays open.
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
        """Proxy one bounded request to the ticket's declared loopback port."""
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
            result = await _unix_forward(
                session["unixSocket"], method, target_path, forward_headers, body, _TIMEOUT_SECONDS,
            )
        else:
            url = f"http://127.0.0.1:{session['port']}{target_path}"
            result = await self._forward(method, url, forward_headers, body, _TIMEOUT_SECONDS)
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
        return {
            "status": result["status"],
            "headers": response_headers,
            "body": result["body"],
            "truncated": result["truncated"],
        }

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
