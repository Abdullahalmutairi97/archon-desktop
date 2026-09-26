"""Build narrow environments for Archon-launched child processes.

Native runtimes keep their own file-based authentication. No provider environment
keys are currently required by a configured Archon adapter, so the provider
allowlists remain explicit and empty until an adapter contract names exact keys.
"""
from __future__ import annotations

import os
import re
from collections.abc import Mapping
from typing import Final, Literal


ChildEnvScope = Literal[
    "prime",
    "pi",
    "hermes",
    "operations",
    "resources",
    "terminal",
    "voice",
]

CHILD_ENV_SCOPES: Final[frozenset[str]] = frozenset(
    {"prime", "pi", "hermes", "operations", "resources", "terminal", "voice"}
)

COMMON_ENV_KEYS: Final[frozenset[str]] = frozenset(
    {
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "TZ",
        "TMPDIR",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_CACHE_HOME",
        "XDG_RUNTIME_DIR",
    }
)

# Prime's configured openai-codex account is file-backed. Pi and Hermes use
# their configured native homes; this server has not registered any ambient
# provider key for those adapters. Keep this mapping scope-specific so a future
# provider integration must name each exact allowed environment key and scope.
PROVIDER_ENV_ALLOWLIST: Final[dict[str, frozenset[str]]] = {
    "prime": frozenset(),
    "pi": frozenset(),
    "hermes": frozenset(),
    "operations": frozenset(),
    "resources": frozenset(),
    "terminal": frozenset(),
    "voice": frozenset(),
}

_SCOPE_SOURCE_KEYS: Final[dict[str, frozenset[str]]] = {
    scope: COMMON_ENV_KEYS | PROVIDER_ENV_ALLOWLIST[scope] | ({"TERM"} if scope == "terminal" else set())
    for scope in CHILD_ENV_SCOPES
}

_VOICE_OVERRIDE_KEYS: Final[frozenset[str]] = frozenset({"HERMES_HOME", "PYTHONPATH"})
_HERMES_OVERRIDE_KEYS: Final[frozenset[str]] = frozenset(
    {"HERMES_HOME", "ARCHON_DESKTOP_CONTROL_MODULE"}
)
_HERMES_CONTROL_MODULE_PATH: Final[str] = os.path.join(
    os.path.dirname(__file__), "hermes_control.py"
)
_ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _validated_mapping(
    values: Mapping[str, str] | None,
    *,
    label: str,
) -> dict[str, str]:
    if values is None:
        return {}
    if not isinstance(values, Mapping):
        raise TypeError(f"{label} must be a mapping of environment names to strings")

    result: dict[str, str] = {}
    for key, value in values.items():
        if not isinstance(key, str) or not _ENV_NAME.fullmatch(key):
            raise ValueError(f"{label} contains an invalid environment name")
        if not isinstance(value, str):
            raise TypeError(f"{label} values must be strings")
        if "\x00" in value:
            raise ValueError(f"{label} values cannot contain NUL")
        result[key] = value
    return result


def _scope_source_keys(scope: str) -> frozenset[str]:
    try:
        return _SCOPE_SOURCE_KEYS[scope]
    except KeyError as exc:
        raise ValueError("Unsupported child environment scope") from exc


def _scope_override_keys(scope: str) -> frozenset[str]:
    common = COMMON_ENV_KEYS | PROVIDER_ENV_ALLOWLIST[scope]
    if scope == "terminal":
        return common | {"TERM"}
    if scope == "voice":
        return common | _VOICE_OVERRIDE_KEYS
    if scope == "hermes":
        return common | _HERMES_OVERRIDE_KEYS
    return common


def build_child_env(
    scope: ChildEnvScope | str,
    *,
    source: Mapping[str, str] | None = None,
    overrides: Mapping[str, str] | None = None,
) -> dict[str, str]:
    """Return a fresh allowlisted environment for one child-process purpose.

    `source` is normally `os.environ`; tests and callers may pass a mapping to
    make inherited inputs explicit. Overrides are trusted, server-constructed
    values limited to common environment essentials and narrowly scoped
    runtime needs. Arbitrary task/request data must never be passed here.
    """
    if not isinstance(scope, str):
        raise ValueError("Unsupported child environment scope")
    source_keys = _scope_source_keys(scope)
    source_mapping = os.environ if source is None else source
    if not isinstance(source_mapping, Mapping):
        raise TypeError("Source environment must be a mapping of environment names to strings")
    # Shell-exported functions and unrelated ambient variables can have names
    # outside the portable env-key syntax. Drop disallowed names before
    # validating retained entries so they cannot prevent safe child launches.
    filtered_source = {
        key: value for key, value in source_mapping.items()
        if key in source_keys
    }
    source_values = _validated_mapping(filtered_source, label="Source environment")
    override_values = _validated_mapping(overrides, label="Environment overrides")
    allowed_overrides = _scope_override_keys(scope)

    if any(key not in allowed_overrides for key in override_values):
        raise ValueError("Environment overrides contain a key not allowed for this scope")
    if "ARCHON_DESKTOP_CONTROL_MODULE" in override_values:
        if scope != "hermes" or override_values["ARCHON_DESKTOP_CONTROL_MODULE"] != _HERMES_CONTROL_MODULE_PATH:
            raise ValueError("Hermes control-module override must use the server-owned path")

    child_env = {
        key: value
        for key, value in source_values.items()
        if key in source_keys
    }
    child_env.update(override_values)
    return child_env
