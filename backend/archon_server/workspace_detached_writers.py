"""Find processes that can still write into a workspace checkout.

A write lease names one holder, but it cannot stop a process that is already running
in the checkout. The server knows its own terminals, services and agent tasks; a
process started from a terminal and detached (`nohup make &`, a double fork, an editor
or REPL launched from a shell) is invisible to that bookkeeping and keeps writing
through a handover.

This module inspects this host's processes that run as the same user and reports each
one whose working directory is inside the workspace root, or that holds a descriptor
for a path inside the root opened for writing (`O_WRONLY`/`O_RDWR` in
`/proc/<pid>/fdinfo`). The kernel reports canonical paths for both, so they are
compared lexically: nothing here resolves a candidate path or follows a symlink out of
the root.

Ownership is proven only from kernel-maintained process relations. A process descends
from an Archon terminal or service when its parent chain reaches one of the anchor
processes the caller names, or when it belongs to a session such a process leads.
Anchors are identified by pid *and* start time, so a reused pid never inherits the
proof, and nothing is ever matched by name, command line or environment.

The scan is bounded in time, process count and descriptor count. A scan that cannot
finish reports itself incomplete, and callers must treat that as "not quiet". A process
that vanishes mid-scan is skipped because it no longer writes. A process the kernel
will not let this account inspect (it cleared its dumpable flag) is reported as
unknown, never as quiet; it blocks a handover only when it provably descends from an
Archon terminal or service, because its location cannot be read.

Not covered: processes of other users (including root), writes through a shared
memory mapping whose descriptor was closed, directory descriptors, per-thread working
directories, and processes in another mount namespace whose paths the kernel reports
relative to that namespace.
"""
from __future__ import annotations

import os
import signal
import time
from collections.abc import Collection, Iterable, Mapping
from dataclasses import dataclass
from typing import Any

PROC_ROOT = "/proc"
_DEADLINE_SECONDS = 2.0
_MAX_PROCESSES = 32768
_MAX_DESCRIPTORS = 262144
_MAX_ANCESTRY = 64
_MAX_REPORTED = 32
_MAX_STAT_BYTES = 4096
_MAX_FDINFO_BYTES = 4096
_TERM_GRACE_SECONDS = 3.0
_KILL_GRACE_SECONDS = 2.0
_POLL_SECONDS = 0.05
_GONE_STATES = frozenset({"Z", "X", "x"})


@dataclass(frozen=True)
class ProcessIdentity:
    """One process, named by pid and kernel start time so a reused pid never matches."""

    pid: int
    start: int


@dataclass(frozen=True)
class _ProcessInfo:
    pid: int
    name: str
    state: str
    ppid: int
    sid: int
    start: int

    @property
    def identity(self) -> ProcessIdentity:
        return ProcessIdentity(self.pid, self.start)


class _Vanished(Exception):
    """The process exited while it was being read."""


@dataclass(frozen=True)
class DetachedWriter:
    """A live process that can write into the checkout outside the server's bookkeeping."""

    identity: ProcessIdentity
    name: str
    reason: str
    origin: str | None

    @property
    def killable(self) -> bool:
        # Only a process that provably descends from this workspace's own terminal or
        # service may be stopped by a quiesce; anything else belongs to the owner.
        return self.origin is not None

    def public(self) -> dict[str, Any]:
        if self.killable:
            message = (
                f"Started from this workspace's Archon {self.origin}; a handover with "
                "quiesce=true stops it."
            )
        else:
            message = (
                "Archon cannot prove it started this process, so it is never stopped "
                "automatically; the owner must close it before the handover."
            )
        return {
            "kind": "detached",
            "pid": self.identity.pid,
            "name": self.name,
            "reason": self.reason,
            "archonOwned": self.killable,
            "origin": self.origin,
            "blocking": True,
            "killable": self.killable,
            "message": message,
        }


@dataclass(frozen=True)
class DetachedWriterScan:
    """The outcome of one bounded scan; an incomplete scan is never quiet."""

    complete: bool
    reason: str | None
    writers: tuple[DetachedWriter, ...]
    unknown: tuple[tuple[int, str], ...]

    def public(self, limit: int = _MAX_REPORTED) -> dict[str, Any]:
        return {
            "complete": self.complete,
            "reason": self.reason,
            "quiet": self.complete and not self.writers and not self.unknown,
            "count": len(self.writers),
            "items": [writer.public() for writer in self.writers[:limit]],
            "truncated": len(self.writers) > limit,
            "unknown": {
                "count": len(self.unknown),
                "items": [{"pid": pid, "name": name} for pid, name in self.unknown[:limit]],
                "truncated": len(self.unknown) > limit,
            },
        }


def _incomplete(reason: str, writers: list[DetachedWriter] | None = None,
                unknown: list[tuple[int, str]] | None = None) -> DetachedWriterScan:
    return DetachedWriterScan(False, reason, tuple(writers or ()), tuple(unknown or ()))


def _list_pids(proc_root: str) -> list[int]:
    """List the numeric entries of the process table."""
    pids: list[int] = []
    with os.scandir(proc_root) as entries:
        for entry in entries:
            if entry.name.isdecimal():
                pids.append(int(entry.name))
    return pids


def _read_stat(proc_root: str, pid: int) -> _ProcessInfo:
    """Parse `/proc/<pid>/stat`; the name is the only field that may contain spaces."""
    try:
        descriptor = os.open(f"{proc_root}/{pid}/stat", os.O_RDONLY | getattr(os, "O_CLOEXEC", 0))
    except (FileNotFoundError, ProcessLookupError) as exc:
        raise _Vanished() from exc
    try:
        raw = os.read(descriptor, _MAX_STAT_BYTES)
    except ProcessLookupError as exc:
        raise _Vanished() from exc
    finally:
        os.close(descriptor)
    head, separator, tail = raw.rpartition(b")")
    fields = tail.split()
    if not separator or len(fields) < 20:
        raise _Vanished()
    name = head.partition(b"(")[2].decode("utf-8", errors="replace")
    name = "".join(char if char.isprintable() else "?" for char in name)[:32]
    try:
        return _ProcessInfo(
            pid=pid,
            name=name,
            state=fields[0].decode("ascii", errors="replace"),
            ppid=int(fields[1]),
            sid=int(fields[3]),
            start=int(fields[19]),
        )
    except ValueError as exc:
        raise _Vanished() from exc


def read_process_identity(pid: int, *, proc_root: str | None = None) -> ProcessIdentity | None:
    """Return the identity of a live process, or None when it is gone or a zombie."""
    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
        return None
    try:
        info = _read_stat(proc_root or PROC_ROOT, pid)
    except (_Vanished, OSError):
        return None
    if info.state in _GONE_STATES:
        return None
    return info.identity


def _readlink(path: str) -> bytes:
    return os.readlink(os.fsencode(path))


def _inside(target: bytes, root: bytes) -> bool:
    if target.endswith(b" (deleted)"):
        target = target[: -len(b" (deleted)")]
    if root == b"/":
        return target.startswith(b"/")
    return target == root or target.startswith(root + b"/")


def _open_for_write(proc_root: str, pid: int, fd: str) -> bool:
    """Read the descriptor's open flags and report write access."""
    descriptor = os.open(f"{proc_root}/{pid}/fdinfo/{fd}", os.O_RDONLY | getattr(os, "O_CLOEXEC", 0))
    try:
        raw = os.read(descriptor, _MAX_FDINFO_BYTES)
    finally:
        os.close(descriptor)
    for line in raw.splitlines():
        if line.startswith(b"flags:"):
            flags = int(line.split(b":", 1)[1].strip(), 8)
            return (flags & os.O_ACCMODE) in (os.O_WRONLY, os.O_RDWR)
    raise ValueError("descriptor flags are missing")


def _origin(info: _ProcessInfo, table: Mapping[int, _ProcessInfo],
            anchors: Mapping[ProcessIdentity, str]) -> str | None:
    """Name the anchor this process provably descends from, if any."""

    def by_ancestry(start: _ProcessInfo) -> str | None:
        current: _ProcessInfo | None = start
        for _ in range(_MAX_ANCESTRY):
            if current is None:
                return None
            label = anchors.get(current.identity)
            if label is not None:
                return label
            parent = table.get(current.ppid)
            # A parent that started after its child is a reused pid, not the parent.
            if parent is None or parent.pid == current.pid or parent.start > current.start:
                return None
            current = parent
        return None

    label = by_ancestry(info)
    if label is not None:
        return label
    # A double-forked process loses its parent chain but keeps its session: session
    # membership is only ever inherited, so a live leader proves the descent.
    leader = table.get(info.sid)
    if (leader is not None and leader.pid != info.pid and leader.sid == leader.pid
            and leader.start <= info.start and leader.state not in _GONE_STATES):
        return by_ancestry(leader)
    return None


def scan_detached_writers(
    root: str | os.PathLike[str],
    *,
    anchors: Mapping[ProcessIdentity, str] | None = None,
    exclude: Collection[ProcessIdentity] = (),
    proc_root: str | None = None,
    deadline_seconds: float = _DEADLINE_SECONDS,
    max_processes: int = _MAX_PROCESSES,
    max_descriptors: int = _MAX_DESCRIPTORS,
) -> DetachedWriterScan:
    """Report same-user processes that can write into `root`, bounded and fail closed.

    `anchors` maps the identities of this workspace's own terminal and service
    processes to "terminal" or "service"; `exclude` names processes already counted
    elsewhere (those same anchors, while they run). This server's own process is
    always excluded.
    """
    proc = proc_root or PROC_ROOT
    anchors = dict(anchors or {})
    excluded = set(exclude)
    deadline = time.monotonic() + deadline_seconds
    try:
        root_bytes = os.fsencode(os.path.realpath(os.fspath(root), strict=True))
    except (OSError, ValueError):
        return _incomplete("workspace root is unavailable")
    try:
        pids = _list_pids(proc)
    except OSError as exc:
        return _incomplete(f"process table is unreadable ({exc.strerror or type(exc).__name__})")
    if len(pids) > max_processes:
        return _incomplete("too many processes to inspect within the scan bound")

    this_pid = os.getpid()
    uid = os.geteuid()
    table: dict[int, _ProcessInfo] = {}
    candidates: list[_ProcessInfo] = []
    unreadable: list[tuple[int, str]] = []
    for pid in pids:
        if time.monotonic() > deadline:
            return _incomplete("process scan timed out")
        if pid == this_pid:
            continue
        try:
            owner = os.stat(f"{proc}/{pid}").st_uid
        except (FileNotFoundError, ProcessLookupError):
            continue
        except OSError:
            unreadable.append((pid, "?"))
            continue
        try:
            info = _read_stat(proc, pid)
        except _Vanished:
            continue
        except OSError:
            if owner == uid:
                unreadable.append((pid, "?"))
            continue
        # Every readable process joins the table, so a parent chain can be followed
        # through processes of other users.
        table[pid] = info
        if owner == uid and info.identity not in excluded and info.state not in _GONE_STATES:
            candidates.append(info)

    found: list[tuple[_ProcessInfo, str]] = []
    unknown: list[_ProcessInfo] = []
    descriptors = 0
    for info in candidates:
        if time.monotonic() > deadline:
            return _incomplete("process scan timed out")
        pid = info.pid
        try:
            cwd = _readlink(f"{proc}/{pid}/cwd")
        except (FileNotFoundError, ProcessLookupError):
            continue
        except OSError:
            unknown.append(info)
            continue
        if _inside(cwd, root_bytes):
            found.append((info, "cwd"))
            continue
        try:
            fds = os.listdir(f"{proc}/{pid}/fd")
        except (FileNotFoundError, ProcessLookupError):
            continue
        except OSError:
            unknown.append(info)
            continue
        descriptors += len(fds)
        if descriptors > max_descriptors:
            return _incomplete("too many open descriptors to inspect within the scan bound")
        for index, fd in enumerate(fds):
            if index % 1024 == 1023 and time.monotonic() > deadline:
                return _incomplete("process scan timed out")
            try:
                target = _readlink(f"{proc}/{pid}/fd/{fd}")
            except (FileNotFoundError, ProcessLookupError):
                continue
            except OSError:
                unknown.append(info)
                break
            if not _inside(target, root_bytes):
                continue
            try:
                writable = _open_for_write(proc, pid, fd)
            except (FileNotFoundError, ProcessLookupError):
                continue
            except (OSError, ValueError):
                unknown.append(info)
                break
            if writable:
                found.append((info, "open-for-write"))
                break
        if time.monotonic() > deadline:
            return _incomplete("process scan timed out")

    writers = [
        DetachedWriter(info.identity, info.name, reason, _origin(info, table, anchors))
        for info, reason in found
    ]
    unresolved: list[tuple[int, str]] = list(unreadable)
    for info in unknown:
        origin = _origin(info, table, anchors)
        if origin is not None:
            # Its location cannot be read, but it runs under this workspace's own
            # terminal or service, so it is treated as a writer rather than guessed.
            writers.append(DetachedWriter(info.identity, info.name, "uninspectable", origin))
        else:
            unresolved.append((info.pid, info.name))
    writers.sort(key=lambda writer: writer.identity.pid)
    return DetachedWriterScan(True, None, tuple(writers), tuple(sorted(unresolved)))


def _alive(identity: ProcessIdentity, proc_root: str) -> bool:
    current = read_process_identity(identity.pid, proc_root=proc_root)
    return current == identity


def _signal(identity: ProcessIdentity, signum: int, proc_root: str) -> None:
    """Signal exactly this process; a pid that now names another process is left alone."""
    descriptor: int | None = None
    try:
        descriptor = os.pidfd_open(identity.pid)
    except ProcessLookupError:
        return
    except (AttributeError, OSError):
        descriptor = None
    try:
        # With a pidfd open first, a matching start time proves the descriptor names
        # this process, so the signal cannot reach a process that reused the pid.
        if not _alive(identity, proc_root):
            return
        if descriptor is not None:
            signal.pidfd_send_signal(descriptor, signum)
        else:
            os.kill(identity.pid, signum)
    except ProcessLookupError:
        return
    finally:
        if descriptor is not None:
            os.close(descriptor)


def wait_for_exit(
    identities: Iterable[ProcessIdentity], seconds: float, *, proc_root: str | None = None,
) -> list[ProcessIdentity]:
    """Wait up to `seconds` for these processes to exit; return the ones still alive."""
    proc = proc_root or PROC_ROOT
    deadline = time.monotonic() + seconds
    pending = [identity for identity in dict.fromkeys(identities) if _alive(identity, proc)]
    while pending and time.monotonic() < deadline:
        time.sleep(_POLL_SECONDS)
        pending = [identity for identity in pending if _alive(identity, proc)]
    return pending


def terminate_processes(
    identities: Iterable[ProcessIdentity],
    *,
    grace_seconds: float = _TERM_GRACE_SECONDS,
    kill_seconds: float = _KILL_GRACE_SECONDS,
    proc_root: str | None = None,
) -> list[ProcessIdentity]:
    """SIGTERM, wait, SIGKILL, wait; return the identities that are still alive."""
    proc = proc_root or PROC_ROOT
    pending = [identity for identity in dict.fromkeys(identities) if _alive(identity, proc)]
    for identity in pending:
        _signal(identity, signal.SIGTERM, proc)
    pending = wait_for_exit(pending, grace_seconds, proc_root=proc)
    for identity in pending:
        _signal(identity, signal.SIGKILL, proc)
    return wait_for_exit(pending, kill_seconds, proc_root=proc)
