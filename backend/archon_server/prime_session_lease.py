"""Native-compatible session lease for Prime Agent sessions.

Prime Agent protects a session file with a lease directory:
`<agent dir>/session-leases/<sha256 of the canonical session path>.lock/`, whose
`owner.json` names the owning pid, that process's start identity, an optional
active session id and the canonical session path. A contender creates a
candidate directory and renames it into place, so exactly one process wins;
an existing lease is taken over only when its owner is provably gone.

Archon must not let its own runner and an interactive native Prime process work
the same session at once. This module speaks the native protocol, so each side
sees the other:

* a native lease held by a live process makes an Archon run fail closed, and
* an Archon-held lease makes a native process refuse to start.

Deliberate differences from the native implementation are worth stating.

* The native module coordinates with `proper-lockfile` on `<lease>.guard`; this
  module takes that same guard directory with the same staleness rule before it
  reclaims or releases, but it does not run a background guard-refresh timer, so
  a critical section longer than the staleness window could look stale to another
  participant. Acquisition itself is the same atomic rename on both sides, so a
  race still produces exactly one owner. Owner metadata is diagnostic:
  kernel-level atomicity of the rename decides ownership.
* The owner here is the Archon server process. Archon's own per-session lock is
  an flock whose descriptor is handed to the run supervisor, so that lock
  survives a server restart; a native lease cannot be handed over that way, so if
  the server dies while a supervised run continues, its lease names a dead pid
  and a native participant would judge it reclaimable. Cross-tool exclusion is
  therefore guaranteed for the lifetime of the server process only.
"""
from __future__ import annotations

import hashlib
import json
import os
import random
import shutil
import stat
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

LEASE_VERSION = 1
LEASE_DIRECTORY_NAME = "session-leases"
LEASE_ENABLED_ENV = "PRIME_AGENT_INTERNAL_SESSION_LEASES"
LEASE_OWNER_ID_ENV = "PRIME_AGENT_INTERNAL_SESSION_LEASE_OWNER_ID"
GUARD_STALE_SECONDS = 5.0
MAX_ACQUIRE_ATTEMPTS = 3
MAX_GUARD_WAIT_SECONDS = 2.0
MAX_OWNER_BYTES = 16 * 1024


class PrimeSessionLeaseError(RuntimeError):
    """Base error for native Prime session leases."""


class PrimeSessionAlreadyActive(PrimeSessionLeaseError):
    """A live process already holds the native lease for this session."""


class PrimeSessionLeaseUnavailable(PrimeSessionLeaseError):
    """The lease cannot be judged safely, so the caller must not proceed."""


@dataclass
class PrimeSessionLease:
    """One held native session lease."""

    session_path: str
    directory: Path
    token: str
    _released: bool = False

    def release(self) -> None:
        if self._released:
            return
        self._released = True
        release_session_lease(self)


def canonical_session_path(session_path: str | os.PathLike[str]) -> str:
    """Return the same canonical path the native implementation would lease."""
    resolved = os.path.abspath(os.fspath(session_path))
    try:
        return os.path.realpath(resolved, strict=True)
    except OSError:
        parent = os.path.realpath(os.path.dirname(resolved) or "/")
        return os.path.join(parent, os.path.basename(resolved))


def lease_directory(agent_dir: str | os.PathLike[str], session_path: str) -> Path:
    key = hashlib.sha256(session_path.encode("utf-8")).hexdigest()
    return Path(agent_dir) / LEASE_DIRECTORY_NAME / f"{key}.lock"


def _lease_root(agent_dir: str | os.PathLike[str]) -> Path:
    root = Path(agent_dir) / LEASE_DIRECTORY_NAME
    if not root.is_absolute():
        raise PrimeSessionLeaseUnavailable("Prime agent directory must be an absolute path")
    root.mkdir(parents=True, mode=0o700, exist_ok=True)
    return root


def _process_start_id(pid: int) -> str | None:
    """Return the Linux start-time identity the native implementation uses."""
    try:
        raw = Path(f"/proc/{pid}/stat").read_bytes().rsplit(b")", 1)[1].strip().split()
        if len(raw) < 20:
            return None
        start = raw[19].decode("ascii")
    except (OSError, ValueError, IndexError, UnicodeDecodeError):
        return None
    return f"proc:{start}" if start else None


def _process_alive(pid: int) -> bool:
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _owner_alive(owner: dict[str, Any]) -> bool:
    pid = owner.get("pid")
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return False
    if not _process_alive(pid):
        return False
    recorded = owner.get("processStartId")
    if not isinstance(recorded, str) or not recorded:
        return True
    current = _process_start_id(pid)
    return current is None or current == recorded


def read_lease_owner(directory: Path) -> dict[str, Any] | None:
    """Read one lease owner record, or None when the lease directory is gone.

    A present but unreadable or malformed record raises: the caller must treat an
    unjudgeable lease as held rather than reclaim it.
    """
    owner_path = directory / "owner.json"
    try:
        descriptor = os.open(
            owner_path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
        )
    except FileNotFoundError:
        if directory.exists():
            raise PrimeSessionLeaseUnavailable("session lease has no readable owner record")
        return None
    except OSError as exc:
        raise PrimeSessionLeaseUnavailable("session lease owner record cannot be read safely") from exc
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_OWNER_BYTES:
            raise PrimeSessionLeaseUnavailable("session lease owner record is unsafe or oversized")
        payload = os.read(descriptor, MAX_OWNER_BYTES + 1)
    finally:
        os.close(descriptor)
    try:
        owner = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PrimeSessionLeaseUnavailable("session lease owner record is malformed") from exc
    if (not isinstance(owner, dict) or owner.get("version") != LEASE_VERSION
            or not isinstance(owner.get("token"), str) or not isinstance(owner.get("pid"), int)
            or not isinstance(owner.get("sessionPath"), str) or not isinstance(owner.get("createdAt"), str)):
        raise PrimeSessionLeaseUnavailable("session lease owner record has an unsupported schema")
    return owner


class _lease_guard:
    """The short mkdir guard the native implementation takes around reclaims."""

    def __init__(self, directory: Path, *, stale_seconds: float = GUARD_STALE_SECONDS):
        self._path = Path(f"{directory}.guard")
        self._stale = float(stale_seconds)
        self._held = False

    def __enter__(self) -> "_lease_guard":
        deadline = time.monotonic() + MAX_GUARD_WAIT_SECONDS
        while True:
            try:
                os.mkdir(self._path, 0o700)
                self._held = True
                return self
            except FileExistsError:
                try:
                    age = time.time() - self._path.stat().st_mtime
                except OSError:
                    continue
                if age > self._stale:
                    try:
                        os.rmdir(self._path)
                    except OSError:
                        pass
                    continue
                if time.monotonic() >= deadline:
                    raise PrimeSessionLeaseUnavailable("session lease guard is held by another process")
                time.sleep(0.01)

    def __exit__(self, *_exc) -> None:
        if self._held:
            try:
                os.rmdir(self._path)
            except OSError:
                pass
            self._held = False


def _quarantine(directory: Path) -> bool:
    """Move a lease directory aside, then remove it. Never touches a live one."""
    stale = f"{directory}.stale-{os.getpid()}-{uuid.uuid4().hex}"
    try:
        os.rename(directory, stale)
    except FileNotFoundError:
        return True
    except OSError:
        return False
    shutil.rmtree(stale, ignore_errors=True)
    return True


def acquire_session_lease(
    session_path: str | os.PathLike[str],
    agent_dir: str | os.PathLike[str],
    *,
    active_session_id: str | None = None,
) -> PrimeSessionLease:
    """Take the native lease for one session file, or fail closed.

    Raises PrimeSessionAlreadyActive when a live owner holds it and
    PrimeSessionLeaseUnavailable when the lease cannot be judged safely.
    """
    canonical = canonical_session_path(session_path)
    _lease_root(agent_dir)
    directory = lease_directory(agent_dir, canonical)
    with _lease_guard(directory):
        for _attempt in range(MAX_ACQUIRE_ATTEMPTS):
            token = uuid.uuid4().hex
            candidate = Path(f"{directory}.candidate-{os.getpid()}-{token}")
            try:
                os.mkdir(candidate, 0o700)
                owner: dict[str, Any] = {
                    "version": LEASE_VERSION,
                    "token": token,
                    "pid": os.getpid(),
                    "sessionPath": canonical,
                    "createdAt": datetime.now(timezone.utc).isoformat(),
                }
                start_id = _process_start_id(os.getpid())
                if start_id is not None:
                    owner["processStartId"] = start_id
                if active_session_id:
                    owner["activeSessionId"] = active_session_id
                descriptor = os.open(
                    candidate / "owner.json",
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0),
                    0o600,
                )
                try:
                    os.write(descriptor, (json.dumps(owner, indent=2) + "\n").encode("utf-8"))
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
            except OSError as exc:
                shutil.rmtree(candidate, ignore_errors=True)
                raise PrimeSessionLeaseUnavailable("session lease candidate could not be prepared") from exc
            try:
                os.rename(candidate, directory)
            except FileNotFoundError:
                # The candidate vanished under us; retry with a fresh token.
                shutil.rmtree(candidate, ignore_errors=True)
                continue
            except OSError as exc:
                shutil.rmtree(candidate, ignore_errors=True)
                if not isinstance(exc, (FileExistsError, NotADirectoryError, OSError)):
                    raise
                owner_row = read_lease_owner(directory)
                if owner_row is not None and _owner_alive(owner_row):
                    raise PrimeSessionAlreadyActive(
                        f"Session is already active in pid {owner_row['pid']}: {canonical}"
                    )
                if not _quarantine(directory):
                    raise PrimeSessionLeaseUnavailable("a stale session lease could not be reclaimed")
                continue
            return PrimeSessionLease(session_path=canonical, directory=directory, token=token)
        owner_row = read_lease_owner(directory)
        if owner_row is not None and _owner_alive(owner_row):
            raise PrimeSessionAlreadyActive(f"Session is already active in pid {owner_row['pid']}: {canonical}")
        raise PrimeSessionLeaseUnavailable(f"Could not acquire session lease: {canonical}")


def release_session_lease(lease: PrimeSessionLease) -> None:
    """Release a lease only when this process still owns its token."""
    try:
        with _lease_guard(lease.directory):
            owner = read_lease_owner(lease.directory)
            if owner is not None and owner.get("token") == lease.token:
                _quarantine(lease.directory)
    except PrimeSessionLeaseError:
        # Release is best effort: the next contender reclaims a dead owner.
        return


def lease_owner(agent_dir: str | os.PathLike[str], session_path: str | os.PathLike[str]) -> dict[str, Any] | None:
    """Report the current owner record for one session, if any."""
    canonical = canonical_session_path(session_path)
    return read_lease_owner(lease_directory(agent_dir, canonical))
