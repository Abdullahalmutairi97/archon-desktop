"""Executable runtime identities and the guarantees their adapters can enforce.

A Hermes profile is roster/configuration data, not an executable capability. The
registry intentionally accepts only canonical runtimes and explicit aliases.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import Any, Mapping


_ADAPTER_MANIFEST_VERSION = 1
# The authored Prime/Pi adapters use bounded print paths; every richer native
# capability is unsupported until a verified protocol exists.
_ADAPTER_CAPABILITIES: dict[str, Any] = {
    'modalities': ['prompt'],
    'resume': False,
    'fork': False,
    'steer': False,
    'approval': False,
    'read_only': False,
    'chat_only': False,
    'reconnect': 'task_event_replay',
    'resource_formats': ['print'],
    'transports': ['stdio'],
}
_FINGERPRINT_CACHE: dict[tuple[str, int, int], str | None] = {}


def _fingerprint(path: Path) -> str | None:
    """Return a read-only sha256 of an executable, cached by file identity.

    This only reads the file; it never executes the configured runtime.
    """
    try:
        info = path.stat()
    except OSError:
        return None
    key = (str(path), int(info.st_mtime_ns), int(info.st_size))
    if key in _FINGERPRINT_CACHE:
        return _FINGERPRINT_CACHE[key]
    digest: str | None = None
    try:
        hasher = hashlib.sha256()
        with open(path, 'rb') as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b''):
                hasher.update(chunk)
        digest = hasher.hexdigest()
    except OSError:
        digest = None
    _FINGERPRINT_CACHE[key] = digest
    return digest


class RuntimeUnavailable(RuntimeError):
    """A configured adapter has no executable file available for admission."""


def validate_execution_mode(task: dict[str, Any]) -> None:
    if task.get('approval_mode') != 'auto':
        raise ValueError(
            "This runtime requires explicit approval_mode='auto' (trusted execution). "
            "Approval and planning modes are not supported by a verified native enforcement protocol."
        )
    if task.get('chat_only'):
        raise ValueError("Chat-only execution is not supported by a verified native enforcement protocol")


def execution_cwd(value: str | Path, *, require_canonical: bool = True) -> Path:
    """Reject a vanished directory instead of switching the task's workspace."""
    try:
        requested = Path(value).expanduser()
        path = requested.resolve(strict=True)
        if require_canonical and (not requested.is_absolute() or requested != path):
            raise ValueError("Working directory is no longer its stored canonical directory")
    except (OSError, RuntimeError) as exc:
        raise ValueError("Working directory does not exist or cannot be resolved") from exc
    if not path.is_dir():
        raise ValueError("Working directory is not a directory")
    return path


class RuntimeRegistry:
    def __init__(
        self,
        runners: Mapping[str, Any],
        default_profile: str = 'archon',
        aliases: Mapping[str, str] | None = None,
    ):
        if not runners or any(name not in {'prime', 'pi'} for name in runners):
            raise ValueError('Runtime registry requires canonical prime/pi runner identities')
        self.runners = dict(runners)
        self.aliases = {'default': 'prime', 'prime': 'prime', 'pi': 'pi'}
        if default_profile:
            if default_profile in self.aliases and self.aliases[default_profile] != 'prime':
                raise ValueError('Default profile conflicts with a canonical runtime identity')
            self.aliases[default_profile] = 'prime'
        for alias, runtime in (aliases or {}).items():
            if not alias or alias != alias.strip() or runtime not in self.runners:
                raise ValueError('Runtime aliases require a nonempty name and configured runtime')
            if alias in self.aliases and self.aliases[alias] != runtime:
                raise ValueError(f'Runtime alias cannot redefine builtin identity: {alias}')
            self.aliases[alias] = runtime

    def resolve(self, profile: str | None) -> str:
        name = 'default' if profile is None else profile
        runtime = self.aliases.get(name)
        if runtime is None or runtime not in self.runners:
            raise ValueError(f'Unknown runtime profile: {name}')
        return runtime

    def runtime_for(self, task: Mapping[str, Any]) -> str:
        """Select a task's frozen runtime, falling back only for legacy tasks.

        Profiles and aliases are mutable roster configuration. Once a task has
        a canonical runtime_id, changing an alias must not redirect execution
        or cancellation.
        """
        runtime_id = task.get('runtime_id')
        if runtime_id is None:
            return self.resolve(task.get('profile'))
        if runtime_id not in {'prime', 'pi'} or runtime_id not in self.runners:
            raise ValueError(f'Invalid canonical runtime id: {runtime_id}')
        return runtime_id

    def _availability(self, runtime: str) -> tuple[bool, str]:
        executable = getattr(self.runners[runtime], 'executable', None)
        # A directly injected runner is an explicit integration/test dependency,
        # never a discovered executable or an implicitly selected fallback.
        if executable is None:
            return True, 'injected_runner'
        try:
            path = Path(executable).expanduser()
            return path.is_file() and os.access(path, os.X_OK), 'executable_file'
        except (OSError, ValueError, TypeError):
            return False, 'executable_file'

    def validate(self, task: dict[str, Any]) -> str:
        runtime = self.runtime_for(task)
        validate_execution_mode(task)
        available, _ = self._availability(runtime)
        if not available:
            raise RuntimeUnavailable(f'Runtime {runtime} is unavailable: configured executable is not an executable file')
        return runtime

    def runner_for(self, task: dict[str, Any]):
        # Identity selection also serves cancellation. Do not require the file
        # to still exist to cancel a process that has already been launched.
        return self.runners[self.runtime_for(task)]

    def describe(self) -> list[dict[str, Any]]:
        result = []
        for runtime in self.runners:
            available, check = self._availability(runtime)
            executable = getattr(self.runners[runtime], 'executable', None)
            declared_version = getattr(self.runners[runtime], 'declared_version', None)
            digest: str | None = None
            if executable is not None:
                try:
                    digest = _fingerprint(Path(executable).expanduser())
                except (OSError, ValueError, TypeError):
                    digest = None
            result.append({
                'id': runtime,
                'aliases': sorted(alias for alias, target in self.aliases.items() if target == runtime),
                'available': available,
                'availability_check': check,
                'executable': str(executable) if executable is not None else None,
                'executable_digest': digest,
                'version': declared_version if isinstance(declared_version, str) else None,
                'version_verified': False,
                'manifest_version': _ADAPTER_MANIFEST_VERSION,
                'capabilities': dict(_ADAPTER_CAPABILITIES),
                'availability_note': 'Filesystem availability and a read-only digest do not verify authentication, provider access, or native conformance.',
                'modes': [{'id': 'auto', 'label': 'Trusted execution', 'restricted': False}],
                'chat_only': False,
                'sandboxed': False,
            })
        return result
