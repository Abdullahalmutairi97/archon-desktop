"""Enrollment and authentication for additional task runners.

The local coordinator already owns an exclusive, durable runner journal. This
service adds the missing multi-machine piece: a way to enroll a *named* runner,
hand it a one-time-shown secret, and authenticate it on a channel that is
separate from the owner's bearer token.

Secrets are stored only as salted SHA-256 digests and are compared in constant
time. Enrollments live in a private (0600) JSON ledger owned by this user; no
secret is ever returned after enrollment.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import stat
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_NAME = re.compile(r"[a-z][a-z0-9-]{0,31}\Z")
_RUNNER_ID = re.compile(r"runner-[0-9a-f]{32}\Z")
_MAX_RUNNERS = 16
_MAX_METADATA_BYTES = 64 * 1024


class RunnerEnrollmentError(RuntimeError):
    """Base error for runner enrollment."""


class RunnerEnrollmentUnavailable(RunnerEnrollmentError):
    """The enrollment ledger is missing, unsafe or oversized."""


class RunnerEnrollmentCapacity(RunnerEnrollmentError):
    """The bounded runner ledger has reached its limit."""


class RunnerNotFound(RunnerEnrollmentError):
    """No runner is enrolled under the given id."""


class RunnerAuthenticationError(RunnerEnrollmentError):
    """A runner secret is missing, wrong or revoked."""


def _digest(secret: str, salt: str) -> str:
    return hashlib.sha256((salt + secret).encode("utf-8")).hexdigest()


def _private_ledger(root: str | os.PathLike[str]) -> Path:
    directory = Path(root)
    if not directory.is_absolute():
        raise ValueError("runner ledger root must be an absolute server-owned path")
    was_present = directory.exists() or directory.is_symlink()
    directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    info = directory.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid()
            or (was_present and stat.S_IMODE(info.st_mode) != 0o700)
            or stat.S_IMODE(info.st_mode) & 0o077):
        raise RunnerEnrollmentUnavailable("runner ledger root must be a private directory owned by this user")
    if directory.resolve(strict=True) != directory.absolute():
        raise RunnerEnrollmentUnavailable("runner ledger root must not be a symlink")
    return directory.absolute()


class RunnerEnrollmentService:
    """Enroll, list, revoke and authenticate named task runners."""

    def __init__(self, state_root: str | os.PathLike[str], *, max_runners: int = _MAX_RUNNERS,
                 stale_after_seconds: int = 180):
        if isinstance(max_runners, bool) or not isinstance(max_runners, int) or not 1 <= max_runners <= 64:
            raise ValueError("max_runners must be between 1 and 64")
        if (isinstance(stale_after_seconds, bool) or not isinstance(stale_after_seconds, int)
                or not 5 <= stale_after_seconds <= 86400):
            raise ValueError("stale_after_seconds must be between 5 and 86400")
        self._root = _private_ledger(state_root)
        self._path = self._root / "runners.json"
        self._max_runners = max_runners
        self._stale_after_seconds = stale_after_seconds

    def enroll(self, name: Any) -> dict[str, str]:
        """Enroll a named runner and return its plaintext secret exactly once."""
        if not isinstance(name, str) or not _NAME.fullmatch(name):
            raise ValueError("runner name must be a lowercase slug")
        ledger = self._load()
        if len(ledger["runners"]) >= self._max_runners:
            raise RunnerEnrollmentCapacity("runner limit reached")
        if any(row["name"] == name for row in ledger["runners"]):
            raise RunnerEnrollmentError("a runner with this name is already enrolled")
        runner_id = "runner-" + uuid.uuid4().hex
        secret = secrets.token_urlsafe(32)
        salt = secrets.token_hex(16)
        ledger["runners"].append({
            "runnerId": runner_id,
            "name": name,
            "salt": salt,
            "secretHash": _digest(secret, salt),
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "lastSeenAt": None,
        })
        self._save(ledger)
        return {"runnerId": runner_id, "name": name, "secret": secret}

    def list(self) -> list[dict[str, Any]]:
        now = datetime.now(timezone.utc)
        rows = []
        for row in self._load()["runners"]:
            last_seen = row["lastSeenAt"]
            stale = True
            if isinstance(last_seen, str):
                try:
                    stale = (now - datetime.fromisoformat(last_seen)).total_seconds() > self._stale_after_seconds
                except ValueError:
                    stale = True
            rows.append({
                "runnerId": row["runnerId"], "name": row["name"],
                "createdAt": row["createdAt"], "lastSeenAt": last_seen, "stale": stale,
            })
        return rows

    def revoke(self, runner_id: Any) -> None:
        if not isinstance(runner_id, str) or not _RUNNER_ID.fullmatch(runner_id):
            raise ValueError("runner id is invalid")
        ledger = self._load()
        remaining = [row for row in ledger["runners"] if row["runnerId"] != runner_id]
        if len(remaining) == len(ledger["runners"]):
            raise RunnerNotFound(runner_id)
        ledger["runners"] = remaining
        self._save(ledger)

    def authenticate(self, runner_id: Any, secret: Any) -> dict[str, Any]:
        """Verify a runner secret and record the heartbeat time."""
        if not isinstance(runner_id, str) or not _RUNNER_ID.fullmatch(runner_id):
            raise RunnerAuthenticationError("runner credentials are invalid")
        if not isinstance(secret, str) or not secret:
            raise RunnerAuthenticationError("runner credentials are invalid")
        ledger = self._load()
        row = next((item for item in ledger["runners"] if item["runnerId"] == runner_id), None)
        if row is None:
            raise RunnerAuthenticationError("runner credentials are invalid")
        if not hmac.compare_digest(_digest(secret, row["salt"]), row["secretHash"]):
            raise RunnerAuthenticationError("runner credentials are invalid")
        row["lastSeenAt"] = datetime.now(timezone.utc).isoformat()
        self._save(ledger)
        return {"runnerId": row["runnerId"], "name": row["name"], "lastSeenAt": row["lastSeenAt"]}

    # -------------------------------------------------------------- internals

    def _empty(self) -> dict[str, Any]:
        return {"version": 1, "runners": []}

    def _load(self) -> dict[str, Any]:
        try:
            descriptor = os.open(self._path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0))
        except FileNotFoundError:
            return self._empty()
        except OSError as exc:
            raise RunnerEnrollmentUnavailable("runner ledger cannot be opened safely") from exc
        try:
            info = os.fstat(descriptor)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                    or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > _MAX_METADATA_BYTES):
                raise RunnerEnrollmentUnavailable("runner ledger is unsafe or oversized")
            payload = os.read(descriptor, _MAX_METADATA_BYTES + 1)
        finally:
            os.close(descriptor)
        if len(payload) > _MAX_METADATA_BYTES:
            raise RunnerEnrollmentUnavailable("runner ledger is oversized")
        try:
            data = json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise RunnerEnrollmentUnavailable("runner ledger is malformed") from exc
        if not isinstance(data, dict) or set(data) != {"version", "runners"} or data.get("version") != 1:
            raise RunnerEnrollmentUnavailable("runner ledger has an unsupported schema")
        rows = data.get("runners")
        if not isinstance(rows, list) or len(rows) > self._max_runners:
            raise RunnerEnrollmentUnavailable("runner ledger exceeds its bound")
        for row in rows:
            if (not isinstance(row, dict)
                    or set(row) != {"runnerId", "name", "salt", "secretHash", "createdAt", "lastSeenAt"}
                    or not isinstance(row.get("runnerId"), str) or not _RUNNER_ID.fullmatch(row["runnerId"])
                    or not isinstance(row.get("name"), str) or not _NAME.fullmatch(row["name"])
                    or not isinstance(row.get("salt"), str) or not isinstance(row.get("secretHash"), str)
                    or not isinstance(row.get("createdAt"), str)
                    or (row.get("lastSeenAt") is not None and not isinstance(row["lastSeenAt"], str))):
                raise RunnerEnrollmentUnavailable("runner ledger contains an invalid row")
        if len({row["runnerId"] for row in rows}) != len(rows) or len({row["name"] for row in rows}) != len(rows):
            raise RunnerEnrollmentUnavailable("runner ledger contains duplicates")
        return data

    def _save(self, ledger: dict[str, Any]) -> None:
        payload = json.dumps(ledger, separators=(",", ":"), sort_keys=True).encode("utf-8")
        if len(payload) > _MAX_METADATA_BYTES:
            raise RunnerEnrollmentCapacity("runner ledger limit reached")
        temporary = self._root / ("." + uuid.uuid4().hex + ".runners.tmp")
        descriptor = -1
        try:
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0), 0o600)
            view = memoryview(payload)
            while view:
                written = os.write(descriptor, view)
                if written <= 0:
                    raise OSError("short runner ledger write")
                view = view[written:]
            os.fsync(descriptor)
            os.close(descriptor)
            descriptor = -1
            os.replace(temporary, self._path)
        except OSError as exc:
            raise RunnerEnrollmentUnavailable("runner ledger could not be persisted") from exc
        finally:
            if descriptor >= 0:
                os.close(descriptor)
            temporary.unlink(missing_ok=True)
