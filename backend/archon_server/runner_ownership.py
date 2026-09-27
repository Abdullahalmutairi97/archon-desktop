from __future__ import annotations

import fcntl
import os
import stat
from pathlib import Path


class RunnerOwnershipError(RuntimeError):
    """The local task runner is already owned or its lock is unsafe."""


class RunnerOwnershipLock:
    """Hold exclusive ownership of one local Archon runner for an app lifetime."""

    def __init__(self, path: str | os.PathLike[str]):
        self.path = Path(path)
        self._fd: int | None = None

    def acquire(self) -> None:
        if self._fd is not None:
            raise RunnerOwnershipError("runner ownership is already held by this process")
        flags = os.O_CREAT | os.O_RDWR | os.O_NONBLOCK
        flags |= getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
        try:
            descriptor = os.open(self.path, flags, 0o600)
        except OSError as exc:
            raise RunnerOwnershipError("cannot safely open runner ownership lock") from exc

        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1:
                raise RunnerOwnershipError("runner ownership lock must be a private regular file")
            if stat.S_IMODE(info.st_mode) != 0o600:
                os.fchmod(descriptor, 0o600)
                info = os.fstat(descriptor)
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise RunnerOwnershipError("runner ownership is already held by another Archon process") from exc
            current = os.stat(self.path, follow_symlinks=False)
            if (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino):
                raise RunnerOwnershipError("runner ownership lock was replaced while acquiring it")
            self._fd = descriptor
            descriptor = -1
        except BaseException:
            if descriptor >= 0:
                os.close(descriptor)
            raise

    def release(self) -> None:
        descriptor, self._fd = self._fd, None
        if descriptor is not None:
            os.close(descriptor)
