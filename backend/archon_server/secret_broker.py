"""Isolated credential-holding broker for secret-backed actions.

Archon must never hand a provider credential to a workspace, renderer, tool
bridge or child process. This module is the coordinator-side holder: a secret
value exists only in the server's own process environment (supplied by the
service manager's external EnvironmentFile) and is addressed by an
operator-registered *reference* name. No value is ever persisted, returned,
logged or copied into a child environment.

A secret-backed action needs a short-lived, single-use grant that is bound to
the requesting principal, the exact tool name, a digest of the exact arguments,
the attempt identity, the workspace identity plus its current generation, and
the ledger epoch that was current when the grant was minted. The broker checks
that binding, performs the upstream HTTPS request itself, and returns only a
redacted, bounded result. A failed check is denied and audited; a granted
action is consumed before the upstream call starts, so an ambiguous failure can
never be retried silently with the same grant.

Ledger state is a bounded, schema-validated, private (0600) JSON document owned
by this user: reference metadata, provider verification history, pending grants
(stored as token digests) and a bounded audit of decisions. Revoking a
reference bumps the ledger epoch, which invalidates every outstanding grant.

Honest limits: the broker runs inside the server process, so this is a
capability boundary rather than an OS-level sandbox. It prevents Archon's own
surfaces from receiving the value; it does not claim to contain a process that
already shares the service account's file access.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import stat
import threading
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Mapping, Protocol
from urllib.parse import urlsplit

_REFERENCE = re.compile(r"[a-z][a-z0-9._-]{2,63}\Z")
_PROVIDER = re.compile(r"[a-z][a-z0-9-]{0,31}\Z")
_PRINCIPAL = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}\Z")
_TOOL = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}\Z")
_SOURCE_KEY = re.compile(r"[A-Z][A-Z0-9_]{2,63}\Z")
_ATTEMPT = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\Z")
_WORKSPACE = re.compile(r"workspace-[0-9a-f]{32}\Z")
_GRANT_ID = re.compile(r"grant-[0-9a-f]{32}\Z")
_DIGEST = re.compile(r"[0-9a-f]{64}\Z")
_PATH = re.compile(r"/[A-Za-z0-9._~!$&'()*+,;=:@/-]{0,511}\Z")
_PURPOSE = re.compile(r"[A-Za-z0-9][A-Za-z0-9 ._:/()-]{0,199}\Z")
_ENDPOINT = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,253}\Z")

_METHODS = frozenset({"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"})
_REQUEST_HEADERS = frozenset({"accept", "content-type", "x-request-id"})
_RESPONSE_HEADERS = frozenset({"content-type", "retry-after", "x-request-id"})
_AUTH_HEADERS = frozenset({"authorization", "x-api-key"})
_AUTH_PREFIXES = frozenset({"Bearer ", ""})

DEFAULT_TTL_SECONDS = 120
MAX_GRANT_TTL_SECONDS = 900
_CEILING_TTL_SECONDS = 3600
_MIN_TTL_SECONDS = 5
_MAX_REFERENCES = 32
_MAX_GRANTS = 256
_MAX_AUDIT = 128
_MAX_LEDGER_BYTES = 512 * 1024
_MAX_REQUEST_BYTES = 64 * 1024
_MAX_RESPONSE_BYTES = 64 * 1024
_MAX_HEADER_CHARS = 256
DEFAULT_TIMEOUT_SECONDS = 15.0

_SECRET_PATTERN = re.compile(
    r"(?i)\b(api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)"
    r"(\s*[:=]\s*)([^\s,;\"'}]+)"
)


class SecretBrokerError(RuntimeError):
    """Base error for the secret broker."""


class SecretBrokerUnavailable(SecretBrokerError):
    """The broker ledger is missing, unsafe or malformed."""


class SecretReferenceUnknown(SecretBrokerError):
    """No reference is registered under the given name."""


class SecretWorkspaceUnknown(SecretBrokerError):
    """The bound workspace is unknown, not owned here, or has no generation."""


class SecretValueUnavailable(SecretBrokerError):
    """The referenced secret cannot be resolved, so the action fails closed."""


class SecretTransportError(SecretBrokerError):
    """The brokered upstream request did not complete."""


class SecretGrantRejected(SecretBrokerError):
    """A grant is unknown, malformed, replayed or bound to other inputs."""

    def __init__(self, reason: str, detail: str, status: int = 403):
        super().__init__(detail)
        self.reason = reason
        self.status = status


class SecretValueSource(Protocol):
    """Resolve one reference's source key to its value, or None when absent."""

    def read(self, source_key: str) -> str | None:  # pragma: no cover - protocol
        ...


BrokerTransport = Callable[[dict[str, Any]], dict[str, Any]]


class EnvironmentSecretSource:
    """Read credentials from this process's own environment only.

    Child processes never receive these keys, so an Archon-launched workspace
    cannot read the value that this source resolves.
    """

    def __init__(self, environ: Mapping[str, str] | None = None):
        self._environ = os.environ if environ is None else environ

    def read(self, source_key: str) -> str | None:
        value = self._environ.get(source_key)
        if not isinstance(value, str) or not value.strip():
            return None
        return value


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:  # noqa: D401 - never follow
        return None


def _default_transport(request: dict[str, Any]) -> dict[str, Any]:
    """Perform one bounded, non-redirecting upstream HTTPS request."""
    http_request = urllib.request.Request(
        request["url"], data=request["body"] or None, method=request["method"]
    )
    for key, value in request["headers"].items():
        http_request.add_header(key, value)
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        response = opener.open(http_request, timeout=request["timeoutSeconds"])
    except urllib.error.HTTPError as exc:
        response = exc
    try:
        status = int(getattr(response, "status", getattr(response, "code", 0)))
        header_items = getattr(response, "headers", None)
        collected = {str(k).lower(): str(v) for k, v in header_items.items()} if header_items else {}
        raw = response.read(_MAX_RESPONSE_BYTES + 1)
        return {
            "status": status,
            "headers": collected,
            "body": raw[:_MAX_RESPONSE_BYTES],
            "truncated": len(raw) > _MAX_RESPONSE_BYTES,
        }
    finally:
        try:
            response.close()
        except Exception:
            pass


def _private_root(root: str | os.PathLike[str]) -> Path:
    directory = Path(root)
    if not directory.is_absolute():
        raise ValueError("secret broker root must be an absolute server-owned path")
    was_present = directory.exists() or directory.is_symlink()
    directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    info = directory.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid()
            or (was_present and stat.S_IMODE(info.st_mode) != 0o700)
            or stat.S_IMODE(info.st_mode) & 0o077):
        raise SecretBrokerUnavailable("secret broker root must be a private directory owned by this user")
    if directory.resolve(strict=True) != directory.absolute():
        raise SecretBrokerUnavailable("secret broker root must not be a symlink")
    return directory.absolute()


def _canonical_json(value: Any) -> bytes:
    try:
        encoded = json.dumps(
            value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
        )
    except (TypeError, ValueError) as exc:
        raise ValueError("arguments must be a plain JSON value") from exc
    payload = encoded.encode("utf-8")
    if len(payload) > _MAX_REQUEST_BYTES:
        raise ValueError("arguments are too large for a brokered action")
    return payload


def _validate_principal(value: Any) -> str:
    if not isinstance(value, str) or not _PRINCIPAL.fullmatch(value):
        raise ValueError("principal is invalid")
    return value


def _validate_tool(value: Any) -> str:
    if not isinstance(value, str) or not _TOOL.fullmatch(value):
        raise ValueError("tool is invalid")
    return value


def _validate_attempt(value: Any) -> str:
    if not isinstance(value, str) or not _ATTEMPT.fullmatch(value):
        raise ValueError("attempt id is invalid")
    return value


def action_digest(tool: Any, arguments: Any) -> str:
    """Return the stable digest that binds a grant to one exact tool call."""
    name = _validate_tool(tool)
    payload = _canonical_json(arguments)
    return hashlib.sha256(
        b"archon-secret-action-v1\x00" + name.encode("utf-8") + b"\x00" + payload
    ).hexdigest()


def _token_digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _redact_text(text: Any, secret: str | None) -> tuple[str, bool]:
    value = str(text if text is not None else "")
    changed = False
    if secret and secret in value:
        value = value.replace(secret, "[REDACTED]")
        changed = True
    replaced = _SECRET_PATTERN.sub(lambda match: f"{match.group(1)}{match.group(2)}[REDACTED]", value)
    if replaced != value:
        changed = True
    return replaced, changed


def _redact_json(value: Any, secret: str | None) -> tuple[Any, bool]:
    if isinstance(value, str):
        return _redact_text(value, secret)
    if isinstance(value, list):
        redacted, changed = [], False
        for item in value:
            item_value, item_changed = _redact_json(item, secret)
            redacted.append(item_value)
            changed = changed or item_changed
        return redacted, changed
    if isinstance(value, dict):
        redacted_map: dict[Any, Any] = {}
        changed = False
        for key, item in value.items():
            item_value, item_changed = _redact_json(item, secret)
            redacted_map[key] = item_value
            changed = changed or item_changed
        return redacted_map, changed
    return value, False


def _validate_request(arguments: Any) -> dict[str, Any]:
    """Validate the bounded upstream request shape a brokered call may describe."""
    if not isinstance(arguments, dict):
        raise ValueError("arguments must be an object")
    if set(arguments) - {"method", "path", "body", "headers"}:
        raise ValueError("arguments contain unsupported fields")
    method = arguments.get("method")
    if not isinstance(method, str) or method.upper() not in _METHODS:
        raise ValueError("method is not permitted for a brokered action")
    path = arguments.get("path")
    if (not isinstance(path, str) or not _PATH.fullmatch(path)
            or ".." in path or "//" in path or path.endswith("/..")):
        raise ValueError("path must be an absolute, in-origin path")
    raw_headers = arguments.get("headers") or {}
    if not isinstance(raw_headers, dict):
        raise ValueError("headers must be an object")
    if len(raw_headers) > len(_REQUEST_HEADERS):
        raise ValueError("headers contain unsupported names")
    headers: dict[str, str] = {}
    for key, value in raw_headers.items():
        if not isinstance(key, str) or key.lower() not in _REQUEST_HEADERS:
            raise ValueError("headers contain unsupported names")
        if (not isinstance(value, str) or len(value) > _MAX_HEADER_CHARS
                or any(ord(char) < 0x20 or ord(char) == 0x7F for char in value)):
            raise ValueError("header values must be bounded visible text")
        headers[key.lower()] = value
    body = arguments.get("body")
    payload = _canonical_json(body) if body is not None else b""
    return {"method": method.upper(), "path": path, "headers": headers, "body": payload}


def _safe_read(values: SecretValueSource, source_key: str) -> str | None:
    """Resolve one value, treating any resolver failure as unavailable."""
    try:
        value = values.read(source_key)
    except Exception:
        return None
    return value if isinstance(value, str) and value else None


def _isoformat(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat()


def _parse_isoformat(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)


class SecretReferenceExists(SecretBrokerError):
    """A reference with this name is already registered."""


class SecretBroker:
    """Register secret references, mint action grants and perform brokered calls."""

    def __init__(
        self,
        root: str | os.PathLike[str],
        *,
        values: SecretValueSource | None = None,
        generation_lookup: Callable[[str], int | None] | None = None,
        transport: BrokerTransport | None = None,
        now: Callable[[], datetime] | None = None,
        max_ttl_seconds: int = MAX_GRANT_TTL_SECONDS,
        max_references: int = _MAX_REFERENCES,
        max_grants: int = _MAX_GRANTS,
        max_audit: int = _MAX_AUDIT,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    ):
        if (isinstance(max_ttl_seconds, bool) or not isinstance(max_ttl_seconds, int)
                or not _MIN_TTL_SECONDS <= max_ttl_seconds <= _CEILING_TTL_SECONDS):
            raise ValueError("max_ttl_seconds must be between 5 and 3600")
        if isinstance(max_references, bool) or not isinstance(max_references, int) or not 1 <= max_references <= 64:
            raise ValueError("max_references must be between 1 and 64")
        if isinstance(max_grants, bool) or not isinstance(max_grants, int) or not 1 <= max_grants <= 1024:
            raise ValueError("max_grants must be between 1 and 1024")
        if isinstance(max_audit, bool) or not isinstance(max_audit, int) or not 1 <= max_audit <= 1024:
            raise ValueError("max_audit must be between 1 and 1024")
        if (isinstance(timeout_seconds, bool) or not isinstance(timeout_seconds, (int, float))
                or not 1.0 <= float(timeout_seconds) <= 30.0):
            raise ValueError("timeout_seconds must be between 1 and 30")
        self._root = _private_root(root)
        self._path = self._root / "secrets.json"
        self._values = values if values is not None else EnvironmentSecretSource()
        self._generation_lookup = generation_lookup
        self._transport = transport if transport is not None else _default_transport
        self._now = now if now is not None else (lambda: datetime.now(timezone.utc))
        self._max_ttl = max_ttl_seconds
        self._max_references = max_references
        self._max_grants = max_grants
        self._max_audit = max_audit
        self._timeout = float(timeout_seconds)
        self._lock = threading.Lock()

    # -- references ---------------------------------------------------------

    def register_reference(
        self,
        reference: Any,
        *,
        provider: Any,
        purpose: Any,
        source_key: Any,
        endpoint: Any,
        auth_header: str = "authorization",
        auth_prefix: str = "Bearer ",
    ) -> dict[str, Any]:
        """Record how to reach one upstream secret. No value is read or stored."""
        name = self._validate_reference(reference)
        if not isinstance(provider, str) or not _PROVIDER.fullmatch(provider):
            raise ValueError("provider must be a lowercase slug")
        if not isinstance(purpose, str) or not _PURPOSE.fullmatch(purpose):
            raise ValueError("purpose must be short visible text")
        if not isinstance(source_key, str) or not _SOURCE_KEY.fullmatch(source_key):
            raise ValueError("source key must be an uppercase environment name")
        origin = self._validate_endpoint(endpoint)
        if auth_header not in _AUTH_HEADERS:
            raise ValueError("auth header is not supported")
        if auth_prefix not in _AUTH_PREFIXES:
            raise ValueError("auth prefix is not supported")
        with self._lock:
            document = self._load()
            if name in document["references"]:
                raise SecretReferenceExists("secret reference is already registered")
            if len(document["references"]) >= self._max_references:
                raise SecretBrokerError("secret reference capacity reached")
            created_at = _isoformat(self._now())
            document["references"][name] = {
                "provider": provider,
                "purpose": purpose,
                "sourceKey": source_key,
                "endpoint": origin,
                "authHeader": auth_header,
                "authPrefix": auth_prefix,
                "createdAt": created_at,
            }
            document["providers"].setdefault(
                provider, {"verifiedAt": None, "lastAttemptAt": None, "lastFailureReason": None}
            )
            self._save(document)
        return {
            "reference": name, "provider": provider, "purpose": purpose,
            "sourceKey": source_key, "endpoint": origin,
            "authHeader": auth_header, "authPrefix": auth_prefix, "createdAt": created_at,
        }

    def revoke_reference(self, reference: Any) -> dict[str, Any]:
        """Forget a reference, bump the epoch and invalidate its outstanding grants."""
        name = self._validate_reference(reference)
        with self._lock:
            document = self._load()
            if name not in document["references"]:
                raise SecretReferenceUnknown("secret reference is not registered")
            del document["references"][name]
            document["epoch"] = int(document["epoch"]) + 1
            document["grants"] = {
                key: row for key, row in document["grants"].items() if row["reference"] != name
            }
            self._save(document)
            epoch = document["epoch"]
        return {"reference": name, "epoch": epoch, "revoked": True}

    def list_references(self) -> list[dict[str, Any]]:
        document = self._load()
        return [
            {"reference": name, **row}
            for name, row in sorted(document["references"].items())
        ]

    def epoch(self) -> int:
        return int(self._load()["epoch"])

    def audit(self, limit: int = 32) -> list[dict[str, Any]]:
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= _MAX_AUDIT:
            raise ValueError("audit limit is invalid")
        return list(reversed(self._load()["audit"][-limit:]))

    def auth_states(self) -> dict[str, Any]:
        """Report honest per-provider authentication state; never a value."""
        document = self._load()
        grouped: dict[str, list[dict[str, Any]]] = {}
        for name, row in document["references"].items():
            grouped.setdefault(row["provider"], []).append({"reference": name, **row})
        providers = []
        for provider in sorted(grouped):
            rows = grouped[provider]
            resolvable = any(_safe_read(self._values, row["sourceKey"]) is not None for row in rows)
            recorded = document["providers"].get(provider) or {}
            if not resolvable:
                state = "unavailable"
            elif recorded.get("verifiedAt"):
                state = "verified"
            else:
                state = "unverified"
            providers.append({
                "provider": provider,
                "state": state,
                "references": len(rows),
                "purpose": sorted({row["purpose"] for row in rows}),
                "verifiedAt": recorded.get("verifiedAt"),
                "lastAttemptAt": recorded.get("lastAttemptAt"),
                "lastFailureReason": recorded.get("lastFailureReason"),
            })
        return {
            "providers": providers,
            "epoch": int(document["epoch"]),
            "secretSource": "process-environment",
            "secretValuesExposed": False,
            "note": (
                "verified means one brokered call reached this provider from this host; "
                "unavailable means the referenced credential is absent, and unverified "
                "means no brokered call has succeeded yet. Neither state claims a "
                "provider capability or quota."
            ),
        }

    # -- grants -------------------------------------------------------------

    def mint_grant(
        self,
        *,
        principal: Any,
        reference: Any,
        tool: Any,
        arguments: Any,
        attempt_id: Any,
        workspace_id: Any,
        delegate_principal: Any = None,
        ttl_seconds: Any = None,
    ) -> dict[str, Any]:
        """Mint one single-use grant bound to this exact action and context."""
        actor = _validate_principal(principal)
        bound = actor if delegate_principal is None else _validate_principal(delegate_principal)
        name = _validate_tool(tool)
        attempt = _validate_attempt(attempt_id)
        if not isinstance(workspace_id, str) or not _WORKSPACE.fullmatch(workspace_id):
            raise ValueError("workspace id is invalid")
        digest = action_digest(name, arguments)
        ttl = DEFAULT_TTL_SECONDS if ttl_seconds is None else ttl_seconds
        if isinstance(ttl, bool) or not isinstance(ttl, int) or not _MIN_TTL_SECONDS <= ttl <= self._max_ttl:
            raise ValueError("ttl_seconds is invalid")
        with self._lock:
            document = self._load()
            resolved = self._validate_reference(reference)
            row = document["references"].get(resolved)
            if row is None:
                raise SecretReferenceUnknown("secret reference is not registered")
            generation = self._workspace_generation(workspace_id)
            now = self._now()
            self._prune(document, now)
            if len(document["grants"]) >= self._max_grants:
                raise SecretBrokerError("grant capacity reached")
            token = secrets.token_urlsafe(32)
            grant = {
                "grantId": "grant-" + uuid.uuid4().hex,
                "principal": bound,
                "reference": resolved,
                "provider": row["provider"],
                "tool": name,
                "actionDigest": digest,
                "attemptId": attempt,
                "workspaceId": workspace_id,
                "workspaceGeneration": generation,
                "epoch": int(document["epoch"]),
                "mintedAt": _isoformat(now),
                "expiresAt": _isoformat(now + timedelta(seconds=ttl)),
                "consumedAt": None,
            }
            document["grants"][_token_digest(token)] = grant
            self._save(document)
        return {"grant": dict(grant), "grantToken": token}

    def invoke(
        self,
        *,
        grant_token: Any,
        principal: Any,
        tool: Any,
        arguments: Any,
        attempt_id: Any,
    ) -> dict[str, Any]:
        """Verify a grant, perform the upstream call and return only a redacted result."""
        actor = _validate_principal(principal)
        name = _validate_tool(tool)
        attempt = _validate_attempt(attempt_id)
        digest = action_digest(name, arguments)
        request = _validate_request(arguments)
        if not isinstance(grant_token, str) or not 16 <= len(grant_token) <= 128 or not grant_token.isascii():
            self._reject("unknown_grant", "grant is unknown or already completed", 404,
                         actor, None, name, digest, attempt)
        key = _token_digest(grant_token)
        with self._lock:
            document = self._load()
            grant = document["grants"].get(key)
            if grant is None:
                self._deny_locked(document, "unknown_grant", actor, None, name, digest, attempt)
                raise SecretGrantRejected("unknown_grant", "grant is unknown or already completed", 404)
            if grant["consumedAt"] is not None:
                self._deny_locked(document, "replayed_grant", actor, grant, name, digest, attempt)
                raise SecretGrantRejected("replayed_grant", "grant was already used", 409)
            now = self._now()
            if (_parse_isoformat(grant["expiresAt"]) or now) <= now:
                document["grants"].pop(key, None)
                self._deny_locked(document, "expired_grant", actor, grant, name, digest, attempt)
                raise SecretGrantRejected("expired_grant", "grant has expired", 403)
            if grant["epoch"] != int(document["epoch"]):
                document["grants"].pop(key, None)
                self._deny_locked(document, "stale_epoch", actor, grant, name, digest, attempt)
                raise SecretGrantRejected("stale_epoch", "grant was minted before the current ledger epoch", 403)
            if grant["principal"] != actor:
                self._deny_locked(document, "principal_mismatch", actor, grant, name, digest, attempt)
                raise SecretGrantRejected("principal_mismatch", "grant is bound to another principal", 403)
            if grant["tool"] != name:
                self._deny_locked(document, "tool_mismatch", actor, grant, name, digest, attempt)
                raise SecretGrantRejected("tool_mismatch", "grant is bound to another tool", 403)
            if grant["actionDigest"] != digest:
                self._deny_locked(document, "arguments_mismatch", actor, grant, name, digest, attempt)
                raise SecretGrantRejected("arguments_mismatch", "grant is bound to other arguments", 403)
            if grant["attemptId"] != attempt:
                self._deny_locked(document, "attempt_mismatch", actor, grant, name, digest, attempt)
                raise SecretGrantRejected("attempt_mismatch", "grant is bound to another attempt", 403)
            row = document["references"].get(grant["reference"])
            if row is None:
                document["grants"].pop(key, None)
                self._deny_locked(document, "unknown_reference", actor, grant, name, digest, attempt)
                raise SecretGrantRejected("unknown_reference", "the referenced secret was revoked", 404)
            generation = self._generation_or_none(grant["workspaceId"])
            if generation != grant["workspaceGeneration"]:
                document["grants"].pop(key, None)
                self._deny_locked(document, "stale_generation", actor, grant, name, digest, attempt)
                raise SecretGrantRejected("stale_generation", "the workspace generation changed", 403)
            # Consume before the upstream call starts: an ambiguous failure is
            # never retried silently with the same grant.
            grant["consumedAt"] = _isoformat(now)
            document["grants"][key] = grant
            self._save(document)
            reference_row = dict(row)

        value = _safe_read(self._values, reference_row["sourceKey"])
        if value is None:
            self._record(decision="failed", reason="value_unavailable",
                         actor=actor, grant=grant, verified=False)
            raise SecretValueUnavailable("the referenced credential is unavailable")
        try:
            response = self._call_upstream(reference_row, request, value)
        except SecretTransportError as exc:
            self._record(decision="failed", reason="upstream_error",
                         actor=actor, grant=grant, verified=False)
            raise SecretTransportError(str(exc)) from None
        status = response["status"]
        # Only a completed 2xx is a verified call. The transport never follows a
        # redirect, so a 3xx is an unfinished action: it is reported as a denial
        # rather than as evidence that the provider accepted anything.
        succeeded = 200 <= status < 300
        self._record(
            decision="allowed" if succeeded else "failed",
            reason=None if succeeded else (
                "upstream_redirect" if 300 <= status < 400 else "upstream_status"
            ),
            actor=actor, grant=grant, verified=succeeded,
        )
        return {
            "grantId": grant["grantId"],
            "reference": grant["reference"],
            "provider": grant["provider"],
            "principal": actor,
            "tool": name,
            "actionDigest": digest,
            "attemptId": attempt,
            "workspaceId": grant["workspaceId"],
            "workspaceGeneration": grant["workspaceGeneration"],
            "ok": succeeded,
            "status": status,
            "headers": response["headers"],
            "body": response["body"],
            "bodyEncoding": response["bodyEncoding"],
            "truncated": response["truncated"],
            "redacted": response["redacted"],
            "durationMs": response["durationMs"],
        }

    # -- internals ----------------------------------------------------------

    def _call_upstream(self, reference_row: dict[str, Any], request: dict[str, Any], value: str) -> dict[str, Any]:
        headers = dict(request["headers"])
        headers.setdefault("accept", "application/json")
        if request["body"]:
            headers.setdefault("content-type", "application/json")
        headers[reference_row["authHeader"]] = reference_row["authPrefix"] + value
        url = reference_row["endpoint"].rstrip("/") + request["path"]
        started = self._now()
        try:
            result = self._transport({
                "method": request["method"], "url": url, "headers": headers,
                "body": request["body"], "timeoutSeconds": self._timeout,
            })
        except Exception as exc:
            message, _ = _redact_text(str(exc) or type(exc).__name__, value)
            raise SecretTransportError(f"brokered upstream request failed: {message[:200]}") from None
        status = result.get("status") if isinstance(result, dict) else None
        if isinstance(status, bool) or not isinstance(status, int) or not 100 <= status <= 599:
            raise SecretTransportError("brokered upstream request returned no usable status")
        raw = result.get("body")
        if isinstance(raw, str):
            raw = raw.encode("utf-8", errors="replace")
        if not isinstance(raw, (bytes, bytearray)):
            raw = b""
        raw = bytes(raw)
        truncated = bool(result.get("truncated")) or len(raw) > _MAX_RESPONSE_BYTES
        raw = raw[:_MAX_RESPONSE_BYTES]
        upstream_headers = result.get("headers")
        upstream_headers = upstream_headers if isinstance(upstream_headers, dict) else {}
        content_type = str(upstream_headers.get("content-type", "")).lower()
        headers_out: dict[str, str] = {}
        redacted = False
        for key, item in upstream_headers.items():
            lowered = str(key).lower()
            if lowered in _RESPONSE_HEADERS:
                cleaned, changed = _redact_text(item, value)
                headers_out[lowered] = cleaned
                redacted = redacted or changed
        text = raw.decode("utf-8", errors="replace")
        if not text.strip():
            body: Any = None
            encoding = "empty"
        elif "json" in content_type:
            try:
                parsed = json.loads(text)
            except (json.JSONDecodeError, ValueError):
                parsed = text
            body, changed = _redact_json(parsed, value)
            redacted = redacted or changed
            encoding = "json" if not isinstance(body, str) else "text"
        else:
            body, changed = _redact_text(text, value)
            redacted = redacted or changed
            encoding = "text"
        elapsed = (self._now() - started).total_seconds()
        return {
            "status": status,
            "headers": headers_out,
            "body": body,
            "bodyEncoding": encoding,
            "truncated": truncated,
            "redacted": redacted,
            "durationMs": max(int(elapsed * 1000), 0),
        }

    def _reject(
        self,
        reason: str,
        detail: str,
        status: int,
        actor: str,
        grant: dict[str, Any] | None,
        tool: str,
        digest: str,
        attempt: str,
    ) -> None:
        """Record a denial that was decided before the ledger lock was taken."""
        with self._lock:
            document = self._load()
            self._deny_locked(document, reason, actor, grant, tool, digest, attempt)
        raise SecretGrantRejected(reason, detail, status)

    def _deny_locked(
        self,
        document: dict[str, Any],
        reason: str,
        actor: str,
        grant: dict[str, Any] | None,
        tool: str,
        digest: str,
        attempt: str,
    ) -> None:
        """Audit and persist one denied decision. The caller holds the lock."""
        self._append_audit(
            document, decision="denied", reason=reason, actor=actor, grant=grant,
            reference=None if grant is None else grant["reference"],
            provider=None if grant is None else grant["provider"],
            tool=tool, digest=digest, attempt=attempt,
        )
        self._save(document)

    def _record(
        self,
        *,
        decision: str,
        reason: str | None,
        actor: str,
        grant: dict[str, Any],
        verified: bool,
    ) -> None:
        """Audit one completed brokered attempt and update the provider state."""
        with self._lock:
            document = self._load()
            self._append_audit(
                document, decision=decision, reason=reason, actor=actor, grant=grant,
                reference=grant["reference"], provider=grant["provider"],
                tool=grant["tool"], digest=grant["actionDigest"], attempt=grant["attemptId"],
            )
            provider_row = document["providers"].setdefault(
                grant["provider"], {"verifiedAt": None, "lastAttemptAt": None, "lastFailureReason": None}
            )
            stamp = _isoformat(self._now())
            provider_row["lastAttemptAt"] = stamp
            if verified:
                provider_row["verifiedAt"] = stamp
                provider_row["lastFailureReason"] = None
            else:
                provider_row["lastFailureReason"] = reason
            self._save(document)

    def _append_audit(
        self,
        document: dict[str, Any],
        *,
        decision: str,
        reason: str | None,
        actor: str,
        grant: dict[str, Any] | None,
        reference: str | None,
        provider: str | None,
        tool: str,
        digest: str,
        attempt: str,
    ) -> None:
        document["audit"].append({
            "at": _isoformat(self._now()),
            "decision": decision,
            "reason": reason,
            "principal": actor,
            "reference": reference,
            "provider": provider,
            "tool": tool,
            "actionDigest": digest,
            "grantId": None if grant is None else grant["grantId"],
            "attemptId": attempt,
            "workspaceId": None if grant is None else grant["workspaceId"],
            "workspaceGeneration": None if grant is None else grant["workspaceGeneration"],
        })
        if len(document["audit"]) > self._max_audit:
            del document["audit"][: len(document["audit"]) - self._max_audit]

    def _workspace_generation(self, workspace_id: str) -> int:
        generation = self._generation_or_none(workspace_id)
        if generation is None:
            raise SecretWorkspaceUnknown("workspace is unknown or not owned by this server")
        return generation

    def _generation_or_none(self, workspace_id: str) -> int | None:
        if self._generation_lookup is None:
            return None
        try:
            generation = self._generation_lookup(workspace_id)
        except Exception:
            return None
        if isinstance(generation, bool) or not isinstance(generation, int) or generation < 1:
            return None
        return generation

    @staticmethod
    def _validate_reference(reference: Any) -> str:
        if not isinstance(reference, str) or not _REFERENCE.fullmatch(reference):
            raise ValueError("secret reference name is invalid")
        return reference

    @staticmethod
    def _validate_endpoint(endpoint: Any) -> str:
        if not isinstance(endpoint, str) or not endpoint:
            raise ValueError("endpoint is invalid")
        try:
            parts = urlsplit(endpoint)
            host = parts.hostname
            port = parts.port
        except ValueError:
            raise ValueError("endpoint is invalid") from None
        if parts.scheme.lower() != "https" or not host:
            raise ValueError("endpoint must be an HTTPS origin")
        if parts.username or parts.password or parts.query or parts.fragment:
            raise ValueError("endpoint must be an HTTPS origin without userinfo, query or fragment")
        if parts.path not in ("", "/"):
            raise ValueError("endpoint must be an HTTPS origin without a path")
        if not _ENDPOINT.fullmatch(host):
            raise ValueError("endpoint host is invalid")
        if port is not None and not 1 <= port <= 65535:
            raise ValueError("endpoint port is invalid")
        origin = f"https://{host}"
        if port is not None and port != 443:
            origin += f":{port}"
        return origin

    def _prune(self, document: dict[str, Any], now: datetime) -> None:
        document["grants"] = {
            key: row for key, row in document["grants"].items()
            if (_parse_isoformat(row["expiresAt"]) or now) > now
        }

    def _load(self) -> dict[str, Any]:
        try:
            descriptor = os.open(
                self._path,
                os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0),
            )
        except FileNotFoundError:
            return self._empty()
        except OSError as exc:
            raise SecretBrokerUnavailable("secret broker ledger cannot be opened safely") from exc
        try:
            info = os.fstat(descriptor)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                    or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > _MAX_LEDGER_BYTES):
                raise SecretBrokerUnavailable("secret broker ledger is unsafe or oversized")
            payload = os.read(descriptor, _MAX_LEDGER_BYTES + 1)
        finally:
            os.close(descriptor)
        if len(payload) > _MAX_LEDGER_BYTES:
            raise SecretBrokerUnavailable("secret broker ledger is oversized")
        try:
            data = json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise SecretBrokerUnavailable("secret broker ledger is malformed") from exc
        self._validate_document(data)
        return data

    def _empty(self) -> dict[str, Any]:
        return {"version": 1, "epoch": 1, "references": {}, "providers": {}, "grants": {}, "audit": []}

    def _validate_document(self, data: Any) -> None:
        if not isinstance(data, dict) or set(data) != {"version", "epoch", "references", "providers", "grants", "audit"}:
            raise SecretBrokerUnavailable("secret broker ledger has an unsupported schema")
        if data["version"] != 1 or isinstance(data["epoch"], bool) or not isinstance(data["epoch"], int) or data["epoch"] < 1:
            raise SecretBrokerUnavailable("secret broker ledger has an unsupported version or epoch")
        references, providers, grants, audit = data["references"], data["providers"], data["grants"], data["audit"]
        if not isinstance(references, dict) or len(references) > self._max_references:
            raise SecretBrokerUnavailable("secret broker ledger has too many references")
        for name, row in references.items():
            if (not isinstance(name, str) or not _REFERENCE.fullmatch(name) or not isinstance(row, dict)
                    or set(row) != {"provider", "purpose", "sourceKey", "endpoint", "authHeader", "authPrefix", "createdAt"}
                    or not isinstance(row["provider"], str) or not _PROVIDER.fullmatch(row["provider"])
                    or not isinstance(row["purpose"], str) or not _PURPOSE.fullmatch(row["purpose"])
                    or not isinstance(row["sourceKey"], str) or not _SOURCE_KEY.fullmatch(row["sourceKey"])
                    or not isinstance(row["endpoint"], str) or not row["endpoint"].startswith("https://")
                    or row["authHeader"] not in _AUTH_HEADERS or row["authPrefix"] not in _AUTH_PREFIXES
                    or not isinstance(row["createdAt"], str)):
                raise SecretBrokerUnavailable("secret broker ledger contains an invalid reference")
        if not isinstance(providers, dict) or len(providers) > self._max_references:
            raise SecretBrokerUnavailable("secret broker ledger has too many providers")
        for name, row in providers.items():
            if (not isinstance(name, str) or not _PROVIDER.fullmatch(name) or not isinstance(row, dict)
                    or set(row) != {"verifiedAt", "lastAttemptAt", "lastFailureReason"}
                    or not all(row[key] is None or isinstance(row[key], str) for key in row)):
                raise SecretBrokerUnavailable("secret broker ledger contains an invalid provider record")
        if not isinstance(grants, dict) or len(grants) > self._max_grants:
            raise SecretBrokerUnavailable("secret broker ledger has too many grants")
        for key, row in grants.items():
            if (not isinstance(key, str) or not _DIGEST.fullmatch(key) or not isinstance(row, dict)
                    or set(row) != {"grantId", "principal", "reference", "provider", "tool", "actionDigest",
                                    "attemptId", "workspaceId", "workspaceGeneration", "epoch", "mintedAt",
                                    "expiresAt", "consumedAt"}
                    or not isinstance(row["grantId"], str) or not _GRANT_ID.fullmatch(row["grantId"])
                    or not isinstance(row["principal"], str) or not _PRINCIPAL.fullmatch(row["principal"])
                    or not isinstance(row["reference"], str) or not _REFERENCE.fullmatch(row["reference"])
                    or not isinstance(row["provider"], str) or not _PROVIDER.fullmatch(row["provider"])
                    or not isinstance(row["tool"], str) or not _TOOL.fullmatch(row["tool"])
                    or not isinstance(row["actionDigest"], str) or not _DIGEST.fullmatch(row["actionDigest"])
                    or not isinstance(row["attemptId"], str) or not _ATTEMPT.fullmatch(row["attemptId"])
                    or not isinstance(row["workspaceId"], str) or not _WORKSPACE.fullmatch(row["workspaceId"])
                    or isinstance(row["workspaceGeneration"], bool) or not isinstance(row["workspaceGeneration"], int)
                    or isinstance(row["epoch"], bool) or not isinstance(row["epoch"], int)
                    or not isinstance(row["mintedAt"], str) or not isinstance(row["expiresAt"], str)
                    or (row["consumedAt"] is not None and not isinstance(row["consumedAt"], str))):
                raise SecretBrokerUnavailable("secret broker ledger contains an invalid grant")
        if not isinstance(audit, list) or len(audit) > self._max_audit:
            raise SecretBrokerUnavailable("secret broker ledger has an invalid audit trail")
        for entry in audit:
            if (not isinstance(entry, dict)
                    or set(entry) != {"at", "decision", "reason", "principal", "reference", "provider", "tool",
                                      "actionDigest", "grantId", "attemptId", "workspaceId", "workspaceGeneration"}
                    or entry["decision"] not in {"allowed", "denied", "failed"}):
                raise SecretBrokerUnavailable("secret broker ledger has an invalid audit entry")

    def _save(self, document: dict[str, Any]) -> None:
        document["providers"] = {
            name: row for name, row in document["providers"].items()
            if any(reference["provider"] == name for reference in document["references"].values())
        }
        if len(document["audit"]) > self._max_audit:
            del document["audit"][: len(document["audit"]) - self._max_audit]
        # Drop expired grants so the ledger stays bounded, but keep consumed
        # grants until they expire so a replay is reported as a replay.
        self._prune(document, self._now())
        payload = json.dumps(document, separators=(",", ":"), sort_keys=True).encode("utf-8")
        if len(payload) > _MAX_LEDGER_BYTES:
            raise SecretBrokerError("secret broker ledger limit reached")
        temporary = self._root / ("." + uuid.uuid4().hex + ".secrets.tmp")
        descriptor = -1
        try:
            descriptor = os.open(
                temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0), 0o600
            )
            view = memoryview(payload)
            while view:
                written = os.write(descriptor, view)
                if written <= 0:
                    raise OSError("short secret broker ledger write")
                view = view[written:]
            os.fsync(descriptor)
            os.close(descriptor)
            descriptor = -1
            os.replace(temporary, self._path)
        except OSError as exc:
            raise SecretBrokerUnavailable("secret broker ledger could not be persisted") from exc
        finally:
            if descriptor >= 0:
                os.close(descriptor)
            temporary.unlink(missing_ok=True)
