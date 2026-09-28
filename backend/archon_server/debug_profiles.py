"""Honest debug readiness for the workspace IDE.

Archon does not speak the debug adapter protocol and cannot start a debug session:
code-server 4.139.1 exposes no session-launch flag, and `ms-python.debugpy` activates
only inside the IDE. This module therefore reports facts and gaps instead of a
capability:

* which pinned debug adapter exists, its version and whether its files still hash to
  the recorded digest (from `language_profiles`),
* the debug features this host cannot provide, with the reason,
* how the IDE service would be launched if it is registered (argv, state, ports, auth
  mode), so an operator can review it,
* and two constants that are always false: `sessionExercised` and `breakpointVerified`.

Nothing here may ever set those constants to true: they are set by a human-attested
debug session, which has not happened.
"""
from __future__ import annotations

from typing import Any, Iterable, Mapping

# A debug session has never been exercised from this codebase, and Archon cannot start
# one. These stay false until a human-attested session is recorded.
SESSION_EXERCISED = False
BREAKPOINT_VERIFIED = False

MAX_SERVICES = 32
_CODE_SERVER_NAME = "code-server"
_LAUNCH_FLAGS = ("--bind-addr", "--socket", "--socket-mode", "--auth", "--disable-telemetry")


def _adapter_row(profile: str, row: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "profile": profile,
        "extensionId": row.get("extensionId"),
        "version": row.get("version"),
        "state": row.get("state"),
        "reason": row.get("reason"),
        "declaredLicence": row.get("declaredLicence"),
        "pinnedInstalledSha256": row.get("pinnedInstalledSha256"),
    }


def _unsupported_rows(profiles: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for profile in profiles:
        name = profile.get("profile")
        if not profile.get("debuggers"):
            rows.append({
                "profile": name,
                "feature": "debugging",
                "reason": (
                    "no debug adapter is pinned for this profile, so breakpoint debugging is "
                    "unsupported and nothing is advertised as available"
                ),
            })
    rows.append({
        "profile": None,
        "feature": "dap-session-control",
        "reason": (
            "Archon speaks no debug adapter protocol and code-server exposes no session-launch "
            "flag, so this server cannot start, steer or observe a debug session"
        ),
    })
    return rows


def _code_server_row(services: Iterable[Mapping[str, Any]]) -> dict[str, Any] | None:
    for service in services:
        if service.get("name") != _CODE_SERVER_NAME:
            continue
        argv = [str(item) for item in service.get("argv", [])][:64]
        flags = {flag: argv[index + 1] if index + 1 < len(argv) else None
                 for index, flag in enumerate(argv) if flag in _LAUNCH_FLAGS}
        return {
            "registered": True,
            "state": service.get("state"),
            "argv": argv,
            "ports": [dict(port) for port in service.get("ports", [])][:4],
            "authMode": "none" if flags.get("--auth") == "none" else "unknown",
            # Either a loopback authority or the private socket the server bound.
            "bindAddress": flags.get("--bind-addr") or flags.get("--socket"),
            "resourceControls": {
                key: service.get(key) for key in (
                    "memoryLimitMb", "cpuQuotaPercent", "tasksMax", "filesystemIsolation", "networkIsolation",
                )
            },
            "accountNote": (
                "the IDE runs as the backend owner account with no confirmed resource or "
                "filesystem confinement; it runs without its own authentication, so its "
                "listener must stay private to this account"
            ),
        }
    return None


def describe_debug_readiness(
    profiles: Iterable[Mapping[str, Any]],
    *,
    services: Iterable[Mapping[str, Any]] = (),
) -> dict[str, Any]:
    """Report debug facts and gaps for the active checkout. Never a capability claim."""
    profile_rows = list(profiles)[:MAX_SERVICES]
    adapters: list[dict[str, Any]] = []
    for profile in profile_rows:
        for row in profile.get("debuggers", [])[:MAX_SERVICES]:
            adapters.append(_adapter_row(str(profile.get("profile")), row))
    return {
        "adapters": adapters,
        "unsupported": _unsupported_rows(profile_rows),
        "codeServer": _code_server_row(list(services)[:MAX_SERVICES]),
        "sessionExercised": SESSION_EXERCISED,
        "breakpointVerified": BREAKPOINT_VERIFIED,
        "note": (
            "This block reports artefacts and gaps. No debug session has been started, steered or "
            "observed from Archon, no breakpoint has been verified, and the adapters are the pinned "
            "extensions' own capability rather than this server's."
        ),
    }
