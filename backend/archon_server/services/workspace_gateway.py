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
import re
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
_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
_TIMEOUT_SECONDS = 10.0
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
        ticket = "wprev-" + uuid.uuid4().hex
        session = {
            "ticket": ticket,
            "workspaceId": workspace_id,
            "service": name,
            "port": target["port"],
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
        self._sessions = {
            ticket: session for ticket, session in self._sessions.items()
            if session["workspaceId"] != workspace_id
        }

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
        session = self.resolve(ticket)
        if method not in _ALLOWED_METHODS:
            raise WorkspaceGatewayRequestRejected("Method is not permitted for a preview")
        if len(body) > _MAX_REQUEST_BYTES:
            raise WorkspaceGatewayRequestRejected("Preview request body is too large")
        target_path = "/" + path if path else "/"
        url = f"http://127.0.0.1:{session['port']}{target_path}"
        if query:
            url += "?" + query
        forward_headers = {
            key: value for key, value in headers.items()
            if key.lower() in _FORWARD_REQUEST_HEADERS
        }
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
        authority = f"http://127.0.0.1:{session['port']}"
        if location.startswith("/"):
            return base + location
        if location.startswith(authority):
            remainder = location[len(authority):] or "/"
            return base + remainder
        return None

    def _prune(self) -> None:
        now = datetime.now(timezone.utc)
        self._sessions = {
            ticket: session for ticket, session in self._sessions.items()
            if session["expiresAt"] > now
        }
