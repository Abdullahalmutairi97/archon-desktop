"""Bounded results ledger for enrolled remote runners.

A remote runner reports the outcome of claimed work through its authenticated
channel; the coordinator keeps a bounded, private (0600) record per runner so the
owner can read what a remote machine produced. Outputs are truncated and the
ledger is bounded per runner.
"""
from __future__ import annotations

import json
import os
import re
import stat
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_RUNNER_ID = re.compile(r"runner-[0-9a-f]{32}\Z")
_MAX_RESULTS = 64
_MAX_OUTPUT_CHARS = 8000
_MAX_METADATA_BYTES = 512 * 1024
_STATUSES = frozenset({"ok", "error"})


class RunnerResultError(RuntimeError):
    """Base error for the remote runner results ledger."""


class RunnerResultUnavailable(RunnerResultError):
    """The results ledger is missing, unsafe or malformed."""


def _private_root(root: str | os.PathLike[str]) -> Path:
    directory = Path(root)
    if not directory.is_absolute():
        raise ValueError("results root must be an absolute server-owned path")
    was_present = directory.exists() or directory.is_symlink()
    directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    info = directory.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid()
            or (was_present and stat.S_IMODE(info.st_mode) != 0o700)
            or stat.S_IMODE(info.st_mode) & 0o077):
        raise RunnerResultUnavailable("results root must be a private directory owned by this user")
    return directory.absolute()


class RunnerResultLedger:
    """Record and read bounded per-runner outcomes."""

    def __init__(self, root: str | os.PathLike[str], *, max_results: int = _MAX_RESULTS):
        if isinstance(max_results, bool) or not isinstance(max_results, int) or not 1 <= max_results <= 512:
            raise ValueError("max_results must be between 1 and 512")
        self._root = _private_root(root)
        self._max_results = max_results

    @staticmethod
    def _validate_runner(runner_id: Any) -> str:
        if not isinstance(runner_id, str) or not _RUNNER_ID.fullmatch(runner_id):
            raise ValueError("runner id is invalid")
        return runner_id

    def _path(self, runner_id: str) -> Path:
        return self._root / f"{runner_id}.json"

    def record(self, runner_id: Any, event_key: Any, status: Any, output: Any) -> None:
        runner = self._validate_runner(runner_id)
        if not isinstance(event_key, str) or not event_key or len(event_key) > 128:
            raise ValueError("event key is invalid")
        if status not in _STATUSES:
            raise ValueError("status must be 'ok' or 'error'")
        if output is not None and not isinstance(output, str):
            raise ValueError("output must be a string")
        rows = [row for row in self._load(runner) if row.get("eventKey") != event_key]
        rows.append({
            "eventKey": event_key,
            "status": status,
            "output": (output or "")[:_MAX_OUTPUT_CHARS],
            "at": datetime.now(timezone.utc).isoformat(),
        })
        self._save(runner, rows[-self._max_results:])

    def list(self, runner_id: Any) -> list[dict[str, Any]]:
        return self._load(self._validate_runner(runner_id))

    def _load(self, runner_id: str) -> list[dict[str, Any]]:
        path = self._path(runner_id)
        try:
            descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0))
        except FileNotFoundError:
            return []
        except OSError as exc:
            raise RunnerResultUnavailable("results ledger cannot be opened safely") from exc
        try:
            info = os.fstat(descriptor)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                    or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > _MAX_METADATA_BYTES):
                raise RunnerResultUnavailable("results ledger is unsafe or oversized")
            payload = os.read(descriptor, _MAX_METADATA_BYTES + 1)
        finally:
            os.close(descriptor)
        if len(payload) > _MAX_METADATA_BYTES:
            raise RunnerResultUnavailable("results ledger is oversized")
        try:
            data = json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise RunnerResultUnavailable("results ledger is malformed") from exc
        if not isinstance(data, list) or len(data) > self._max_results:
            raise RunnerResultUnavailable("results ledger has an unsupported schema")
        return data

    def _save(self, runner_id: str, rows: list[dict[str, Any]]) -> None:
        payload = json.dumps(rows, separators=(",", ":"), sort_keys=True).encode("utf-8")
        if len(payload) > _MAX_METADATA_BYTES:
            raise RunnerResultError("results ledger limit reached")
        temporary = self._root / ("." + uuid.uuid4().hex + ".results.tmp")
        descriptor = -1
        try:
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0), 0o600)
            view = memoryview(payload)
            while view:
                written = os.write(descriptor, view)
                if written <= 0:
                    raise OSError("short results ledger write")
                view = view[written:]
            os.fsync(descriptor)
            os.close(descriptor)
            descriptor = -1
            os.replace(temporary, self._path(runner_id))
        except OSError as exc:
            raise RunnerResultUnavailable("results ledger could not be persisted") from exc
        finally:
            if descriptor >= 0:
                os.close(descriptor)
            temporary.unlink(missing_ok=True)
