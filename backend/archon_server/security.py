"""Configuration checks and bearer-token policy for the local server."""

from __future__ import annotations

import hmac
import ipaddress
import re
import unicodedata
from urllib.parse import urlsplit


_REMOTE_MODES = {"disabled", "private_tls_proxy"}
_DNS_LABEL = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$", re.IGNORECASE)


def _is_loopback_bind_host(value: object) -> bool:
    if not isinstance(value, str) or not value or value != value.strip():
        return False
    if "%" in value:
        return False
    if value == "localhost":
        return True
    try:
        return ipaddress.ip_address(value).is_loopback
    except ValueError:
        return False


def _has_control_character(value: str) -> bool:
    return any(unicodedata.category(char) == "Cc" for char in value)


def _valid_remote_host(host: str) -> bool:
    if "%" in host:
        return False
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        pass

    if not host or host.endswith(".") or len(host) > 253:
        return False
    try:
        ascii_host = host.encode("idna").decode("ascii")
    except UnicodeError:
        return False
    labels = ascii_host.split(".")
    return all(_DNS_LABEL.fullmatch(label) is not None for label in labels)


def _valid_remote_url(value: object) -> bool:
    if not isinstance(value, str) or not value or value != value.strip():
        return False
    if any(ord(char) <= 0x20 or ord(char) == 0x7F for char in value):
        return False
    # Reject even empty query/fragment delimiters so the accepted URL shape is
    # deterministic and does not depend on a downstream URL parser.
    if "?" in value or "#" in value:
        return False
    try:
        parts = urlsplit(value)
        port = parts.port
    except ValueError:
        return False
    if parts.scheme.lower() != "https" or not parts.netloc:
        return False
    if parts.username is not None or parts.password is not None or "@" in parts.netloc:
        return False
    if parts.netloc.startswith("["):
        closing_bracket = parts.netloc.find("]")
        if closing_bracket < 0:
            return False
        suffix = parts.netloc[closing_bracket + 1 :]
        if suffix == ":":
            return False
    elif ":" in parts.netloc and parts.netloc.rsplit(":", 1)[1] == "":
        return False
    host = parts.hostname
    if not host or not _valid_remote_host(host):
        return False
    if port is not None and not (1 <= port <= 65535):
        return False
    return True


def validate_server_security(settings: object) -> None:
    """Reject unsafe listener and authentication configuration before startup.

    Errors name the setting to fix but never include a configured value.
    """
    token = getattr(settings, "auth_token", None)
    fixture_mode = getattr(settings, "fixture_mode", False) is True
    if not isinstance(token, str):
        raise ValueError("ARCHON_DESKTOP_AUTH_TOKEN must be configured as text")
    if _has_control_character(token):
        raise ValueError("ARCHON_DESKTOP_AUTH_TOKEN must not contain control characters")
    try:
        token.encode("utf-8")
    except UnicodeEncodeError:
        raise ValueError("ARCHON_DESKTOP_AUTH_TOKEN must be valid UTF-8 text") from None
    if not token or not token.strip():
        if not fixture_mode:
            raise ValueError(
                "ARCHON_DESKTOP_AUTH_TOKEN is required; fixture_mode is only for isolated tests"
            )
    elif token != token.strip():
        raise ValueError(
            "ARCHON_DESKTOP_AUTH_TOKEN must not contain edge whitespace or control characters"
        )

    if not _is_loopback_bind_host(getattr(settings, "bind_host", None)):
        raise ValueError(
            "ARCHON_DESKTOP_BIND_HOST must be a literal loopback address or exact localhost"
        )

    remote_mode = getattr(settings, "remote_access_mode", "disabled")
    remote_url = getattr(settings, "remote_base_url", None)
    if remote_mode not in _REMOTE_MODES:
        raise ValueError(
            "ARCHON_DESKTOP_REMOTE_ACCESS_MODE must be disabled or private_tls_proxy"
        )
    if remote_mode == "disabled":
        if remote_url is not None:
            raise ValueError(
                "ARCHON_DESKTOP_REMOTE_BASE_URL must be unset when remote access is disabled"
            )
    elif not _valid_remote_url(remote_url):
        raise ValueError(
            "ARCHON_DESKTOP_REMOTE_BASE_URL must be a valid HTTPS URL without userinfo, query, or fragment"
        )


def token_authorized(settings: object, supplied: str | None) -> bool:
    """Apply the shared constant-time bearer-token comparison policy."""
    configured = getattr(settings, "auth_token", None)
    fixture_mode = getattr(settings, "fixture_mode", False) is True
    if not isinstance(configured, str):
        return False
    if _has_control_character(configured):
        return False
    if not configured or not configured.strip():
        if not fixture_mode:
            return False
        return supplied is None or (
            isinstance(supplied, str)
            and not supplied.strip()
            and not _has_control_character(supplied)
        )
    if configured != configured.strip():
        return False
    if not isinstance(supplied, str) or supplied != supplied.strip() or _has_control_character(supplied):
        return False
    try:
        expected_bytes = configured.encode("utf-8")
        supplied_bytes = supplied.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return hmac.compare_digest(expected_bytes, supplied_bytes)
