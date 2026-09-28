"""Exclusive single-writer lease per workspace.

Before a write-capable process (editor, kernel, debugger or service) takes over a
checkout, the coordinator must be able to name exactly one holder. This service
provides a bounded, expiring, owner-issued lease in a private (0600) ledger.
Handing write access over requires the current holder to release first; an
expired lease does not block a new holder.

The key is the registered workspace id. This service validates the key's shape
only, because the caller has already resolved and owner-checked the workspace;
the bounded charset keeps the ledger a plain, line-free JSON object.
"""
from __future__ import annotations

import fcntl
import json
import os
import re
import stat
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator

_WORKSPACE_ID = re.compile(r"workspace-[A-Za-z0-9._-]{1,190}\Z")
_HOLDER = re.compile(r"[A-Za-z0-9._:/-]{1,128}\Z")
_MAX_LEASES = 128
_MAX_METADATA_BYTES = 64 * 1024
_MIN_TTL = 5
_MAX_TTL = 3600


class WorkspaceWriteLeaseError(RuntimeError):
    """Base error for the workspace write lease."""


class WorkspaceWriteLeaseBusy(WorkspaceWriteLeaseError):
    """Another holder currently owns the workspace write lease."""


class WorkspaceWriteLeaseNotHolder(WorkspaceWriteLeaseError):
    """The caller does not hold the lease."""


class WorkspaceWriteLeaseUnavailable(WorkspaceWriteLeaseError):
    """The lease ledger is missing, unsafe or malformed."""


def _private_root(root: str | os.PathLike[str]) -> Path:
    directory = Path(root)
    if not directory.is_absolute():
        raise ValueError("write-lease root must be an absolute server-owned path")
    was_present = directory.exists() or directory.is_symlink()
    directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    info = directory.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid()
            or (was_present and stat.S_IMODE(info.st_mode) != 0o700)
            or stat.S_IMODE(info.st_mode) & 0o077):
        raise WorkspaceWriteLeaseUnavailable("write-lease root must be a private directory owned by this user")
    return directory.absolute()


class WorkspaceWriteLease:
    """Acquire, release and inspect one bounded write lease per workspace."""

    def __init__(self, root: str | os.PathLike[str], *, max_ttl_seconds: int = _MAX_TTL):
        if isinstance(max_ttl_seconds, bool) or not isinstance(max_ttl_seconds, int) or not _MIN_TTL <= max_ttl_seconds <= _MAX_TTL:
            raise ValueError("max_ttl_seconds must be between 5 and 3600")
        self._root = _private_root(root)
        self._path = self._root / "leases.json"
        self._lock_path = self._root / ".leases.lock"
        self._thread_lock = threading.Lock()
        self._max_ttl = max_ttl_seconds

    @contextmanager
    def _exclusive(self) -> Iterator[None]:
        """Serialize a read-modify-write cycle across threads and processes.

        The ledger is replaced atomically, so a reader never sees a torn file, but
        ``acquire`` decides from a snapshot and then writes: without this lock two
        callers can both observe a free workspace and both record themselves as the
        holder. The in-process lock covers the API thread pool; the descriptor lock
        covers a second Archon process sharing this ledger.
        """
        with self._thread_lock:
            descriptor = os.open(
                self._lock_path,
                os.O_CREAT | os.O_RDWR | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0),
                0o600,
            )
            try:
                opened = os.fstat(descriptor)
                if not stat.S_ISREG(opened.st_mode) or opened.st_uid != os.geteuid():
                    raise WorkspaceWriteLeaseUnavailable("write-lease lock file is unsafe")
                fcntl.flock(descriptor, fcntl.LOCK_EX)
                yield
            finally:
                os.close(descriptor)

    def acquire(self, workspace_id: Any, holder: Any, ttl_seconds: Any = None) -> dict[str, str]:
        workspace = self._validate_workspace(workspace_id)
        if not isinstance(holder, str) or not _HOLDER.fullmatch(holder):
            raise ValueError("holder is invalid")
        ttl = self._max_ttl if ttl_seconds is None else ttl_seconds
        if isinstance(ttl, bool) or not isinstance(ttl, int) or not _MIN_TTL <= ttl <= self._max_ttl:
            raise ValueError("ttl_seconds is invalid")
        with self._exclusive():
            leases = self._load()
            existing = leases.get(workspace)
            if isinstance(existing, dict) and existing.get("holder") != holder and not self._expired(existing):
                raise WorkspaceWriteLeaseBusy(f"workspace is held by {existing.get('holder')}")
            expires_at = datetime.now(timezone.utc) + timedelta(seconds=ttl)
            leases[workspace] = {"holder": holder, "expiresAt": expires_at.isoformat()}
            self._save(leases)
            return {"workspaceId": workspace, "holder": holder, "expiresAt": leases[workspace]["expiresAt"]}

    def release(self, workspace_id: Any, holder: Any) -> None:
        workspace = self._validate_workspace(workspace_id)
        if not isinstance(holder, str) or not _HOLDER.fullmatch(holder):
            raise ValueError("holder is invalid")
        with self._exclusive():
            leases = self._load()
            existing = leases.get(workspace)
            if not isinstance(existing, dict) or self._expired(existing):
                leases.pop(workspace, None)
                self._save(leases)
                raise WorkspaceWriteLeaseNotHolder("no active write lease to release")
            if existing.get("holder") != holder:
                raise WorkspaceWriteLeaseNotHolder("a different holder owns the write lease")
            leases.pop(workspace, None)
            self._save(leases)

    def status(self, workspace_id: Any) -> dict[str, Any]:
        workspace = self._validate_workspace(workspace_id)
        leases = self._load()
        existing = leases.get(workspace)
        if not isinstance(existing, dict) or self._expired(existing):
            return {"workspaceId": workspace, "held": False, "holder": None, "expiresAt": None}
        return {
            "workspaceId": workspace, "held": True,
            "holder": existing["holder"], "expiresAt": existing["expiresAt"],
        }

    @staticmethod
    def _validate_workspace(workspace_id: Any) -> str:
        if not isinstance(workspace_id, str) or not _WORKSPACE_ID.fullmatch(workspace_id):
            raise ValueError("workspace id is invalid")
        return workspace_id

    @staticmethod
    def _expired(row: dict[str, Any]) -> bool:
        try:
            return datetime.fromisoformat(row["expiresAt"]) <= datetime.now(timezone.utc)
        except (KeyError, ValueError):
            return True

    def _load(self) -> dict[str, Any]:
        try:
            descriptor = os.open(self._path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0))
        except FileNotFoundError:
            return {}
        except OSError as exc:
            raise WorkspaceWriteLeaseUnavailable("write-lease ledger cannot be opened safely") from exc
        try:
            info = os.fstat(descriptor)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                    or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > _MAX_METADATA_BYTES):
                raise WorkspaceWriteLeaseUnavailable("write-lease ledger is unsafe or oversized")
            payload = os.read(descriptor, _MAX_METADATA_BYTES + 1)
        finally:
            os.close(descriptor)
        if len(payload) > _MAX_METADATA_BYTES:
            raise WorkspaceWriteLeaseUnavailable("write-lease ledger is oversized")
        try:
            data = json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise WorkspaceWriteLeaseUnavailable("write-lease ledger is malformed") from exc
        if not isinstance(data, dict) or len(data) > _MAX_LEASES:
            raise WorkspaceWriteLeaseUnavailable("write-lease ledger has an unsupported schema")
        for key, row in data.items():
            if (not isinstance(key, str) or not _WORKSPACE_ID.fullmatch(key) or not isinstance(row, dict)
                    or set(row) != {"holder", "expiresAt"}
                    or not isinstance(row.get("holder"), str) or not isinstance(row.get("expiresAt"), str)):
                raise WorkspaceWriteLeaseUnavailable("write-lease ledger contains an invalid entry")
        return data

    def _save(self, leases: dict[str, Any]) -> None:
        # Drop expired rows so the ledger stays bounded.
        leases = {key: row for key, row in leases.items() if not self._expired(row)}
        if len(leases) > _MAX_LEASES:
            raise WorkspaceWriteLeaseError("write-lease ledger limit reached")
        payload = json.dumps(leases, separators=(",", ":"), sort_keys=True).encode("utf-8")
        if len(payload) > _MAX_METADATA_BYTES:
            raise WorkspaceWriteLeaseError("write-lease ledger limit reached")
        temporary = self._root / ("." + uuid.uuid4().hex + ".leases.tmp")
        descriptor = -1
        try:
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0), 0o600)
            view = memoryview(payload)
            while view:
                written = os.write(descriptor, view)
                if written <= 0:
                    raise OSError("short write-lease ledger write")
                view = view[written:]
            os.fsync(descriptor)
            os.close(descriptor)
            descriptor = -1
            os.replace(temporary, self._path)
        except OSError as exc:
            raise WorkspaceWriteLeaseUnavailable("write-lease ledger could not be persisted") from exc
        finally:
            if descriptor >= 0:
                os.close(descriptor)
            temporary.unlink(missing_ok=True)
