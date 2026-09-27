"""Read-only, descriptor-relative access to registered workspace checkouts.

The caller supplies only a workspace identity and a relative path. The database
row is the sole source of the checkout root; every path component is opened
without following symlinks and checked again before a result is returned.

Sensitive-name filtering is a conservative heuristic for common credential
stores, not a comprehensive secret scanner or a security boundary around
workspace contents.
"""
from __future__ import annotations

import errno
import os
import re
import stat
from dataclasses import dataclass
from typing import Any


DEFAULT_LIST_LIMIT = 100
MAX_LIST_LIMIT = 200
MAX_SCANNED_ENTRIES = 5_000
MAX_COMPONENT_DEPTH = 64
DEFAULT_READ_BYTES = 64 * 1024
MAX_READ_BYTES = 256 * 1024
MAX_RELATIVE_PATH_LENGTH = 1_000

_SECRET_EXACT_NAMES = frozenset({
    ".netrc", ".npmrc", ".pypirc", ".ssh", ".aws", ".gnupg", ".docker", ".kube",
    "credentials", "credential", "secrets", "secret", "id_rsa", "id_dsa",
    "id_ecdsa", "id_ed25519", "known_hosts.old",
})
_SECRET_SUFFIXES = (".pem", ".key", ".p12", ".pfx", ".p7b", ".p7c", ".jks", ".keystore")
_SERVICE_ACCOUNT_RE = re.compile(r"(?:service[-_]account|credentials?[-_]?|secret[-_]?|token[-_]?|private[-_]key)", re.I)


class WorkspaceFilesError(Exception):
    """A controlled error suitable for returning from a workspace file route."""

    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def _identity(info: os.stat_result) -> tuple[int, int, int]:
    return info.st_dev, info.st_ino, stat.S_IFMT(info.st_mode)


def _same_version(first: os.stat_result, second: os.stat_result) -> bool:
    return (
        _identity(first) == _identity(second)
        and first.st_nlink == second.st_nlink
        and first.st_size == second.st_size
        and first.st_mtime_ns == second.st_mtime_ns
        and first.st_ctime_ns == second.st_ctime_ns
    )


def _protected_name(name: str) -> bool:
    lowered = name.casefold()
    if lowered == ".git":
        return True
    if lowered.startswith(".env"):
        return True
    if lowered in _SECRET_EXACT_NAMES:
        return True
    if lowered == "terraform.tfstate" or lowered.startswith("terraform.tfstate."):
        return True
    if lowered.endswith(_SECRET_SUFFIXES):
        return True
    return bool(_SERVICE_ACCOUNT_RE.search(lowered))


def _parse_relative_path(value: str, *, allow_root: bool) -> tuple[str, ...]:
    if not isinstance(value, str) or len(value) > MAX_RELATIVE_PATH_LENGTH or "\x00" in value:
        raise WorkspaceFilesError(400, "Invalid workspace-relative path")
    if value == "":
        if allow_root:
            return ()
        raise WorkspaceFilesError(400, "A file path is required")
    if value.startswith(("/", "\\")) or "\\" in value:
        raise WorkspaceFilesError(400, "Path must be workspace-relative")
    parts = tuple(value.split("/"))
    if any(part in {"", ".", ".."} or len(os.fsencode(part)) > 255 for part in parts):
        raise WorkspaceFilesError(400, "Invalid workspace-relative path")
    if any(_protected_name(part) for part in parts):
        # Do not confirm whether a protected entry exists.
        raise WorkspaceFilesError(404, "Workspace path not found")
    return parts


def _workspace_root_components(root: str) -> tuple[str, ...]:
    if (not isinstance(root, str) or not root.startswith("/")
            or "\x00" in root or root == "/"):
        raise WorkspaceFilesError(404, "Workspace root is unavailable")
    components = tuple(root.split("/")[1:])
    if any(part in {"", ".", ".."} for part in components):
        raise WorkspaceFilesError(404, "Workspace root is unavailable")
    if len(components) > MAX_COMPONENT_DEPTH:
        raise WorkspaceFilesError(404, "Workspace root is unavailable")
    return components


def _validate_total_depth(root: str, parts: tuple[str, ...]) -> None:
    # Bound total openat depth, including trusted root ancestors, before the
    # first descriptor is opened. Each path component otherwise retains an FD
    # so the chain can be checked against replacement before returning.
    if len(_workspace_root_components(root)) + len(parts) > MAX_COMPONENT_DEPTH:
        raise WorkspaceFilesError(400, "Workspace path is too deep")


def _open_flags() -> tuple[int, int]:
    required = ("O_DIRECTORY", "O_NOFOLLOW", "O_CLOEXEC")
    if any(not hasattr(os, name) for name in required):
        raise WorkspaceFilesError(503, "Safe workspace file access is unavailable")
    directory = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    regular = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | getattr(os, "O_NONBLOCK", 0)
    return directory, regular


@dataclass
class _LinkCheck:
    parent_fd: int
    name: str
    identity: tuple[int, int, int]


class _WorkspaceTraversal:
    """Hold a chain of directory fds and verify its names remain attached."""

    def __init__(self, root: str):
        self.root = root
        self.fds: list[int] = []
        self.links: list[_LinkCheck] = []
        self.root_fd: int | None = None
        self.root_identity: tuple[int, int, int] | None = None
        self.directory_flags, self.regular_flags = _open_flags()

    def __enter__(self) -> "_WorkspaceTraversal":
        components = _workspace_root_components(self.root)
        try:
            current = os.open("/", self.directory_flags)
            self.fds.append(current)
            for component in components:
                current = self._open_directory(current, component)
            root_info = os.fstat(current)
            if (not stat.S_ISDIR(root_info.st_mode) or root_info.st_uid != os.geteuid()
                    or stat.S_IMODE(root_info.st_mode) != 0o700):
                raise WorkspaceFilesError(404, "Workspace root is unavailable")
            self.root_fd = current
            self.root_identity = _identity(root_info)
            return self
        except WorkspaceFilesError:
            self.close()
            raise
        except OSError as exc:
            self.close()
            raise self._path_error(exc) from None

    def __exit__(self, _type, _value, _traceback) -> None:
        self.close()

    def close(self) -> None:
        while self.fds:
            try:
                os.close(self.fds.pop())
            except OSError:
                pass

    @staticmethod
    def _path_error(exc: OSError) -> WorkspaceFilesError:
        if exc.errno in {errno.EMFILE, errno.ENFILE}:
            return WorkspaceFilesError(503, "Workspace file service is temporarily unavailable")
        return WorkspaceFilesError(404, "Workspace path not found")

    def _open_directory(self, parent_fd: int, name: str) -> int:
        try:
            before = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
            if not stat.S_ISDIR(before.st_mode):
                raise WorkspaceFilesError(404, "Workspace path not found")
            child_fd = os.open(name, self.directory_flags, dir_fd=parent_fd)
            opened = os.fstat(child_fd)
            if not stat.S_ISDIR(opened.st_mode) or _identity(before) != _identity(opened):
                os.close(child_fd)
                raise WorkspaceFilesError(404, "Workspace path not found")
            self.fds.append(child_fd)
            self.links.append(_LinkCheck(parent_fd, name, _identity(opened)))
            return child_fd
        except WorkspaceFilesError:
            raise
        except OSError as exc:
            raise self._path_error(exc) from None

    def open_relative_directory(self, parts: tuple[str, ...]) -> int:
        current = self.fds[-1]
        for part in parts:
            current = self._open_directory(current, part)
        return current

    def verify_links(self) -> None:
        try:
            if self.root_fd is None:
                raise WorkspaceFilesError(409, "Workspace root is unavailable")
            root_info = os.fstat(self.root_fd)
            if (_identity(root_info) != self.root_identity or root_info.st_uid != os.geteuid()
                    or stat.S_IMODE(root_info.st_mode) != 0o700):
                raise WorkspaceFilesError(409, "Workspace root changed during the request")
            for link in self.links:
                current = os.stat(link.name, dir_fd=link.parent_fd, follow_symlinks=False)
                if _identity(current) != link.identity:
                    raise WorkspaceFilesError(409, "Workspace path changed during the request")
        except WorkspaceFilesError:
            raise
        except OSError as exc:
            raise WorkspaceFilesError(409, "Workspace path changed during the request") from exc


class WorkspaceFileService:
    """List directories and read bounded UTF-8 text under registered roots."""

    def list_directory(self, root: str, path: str, limit: int = DEFAULT_LIST_LIMIT) -> dict[str, Any]:
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_LIST_LIMIT:
            raise WorkspaceFilesError(400, f"limit must be between 1 and {MAX_LIST_LIMIT}")
        parts = _parse_relative_path(path, allow_root=True)
        _validate_total_depth(root, parts)
        with _WorkspaceTraversal(root) as traversal:
            directory_fd = traversal.open_relative_directory(parts)
            entries: list[tuple[str, dict[str, Any], tuple[int, int, int]]] = []
            truncated = False
            try:
                with os.scandir(directory_fd) as iterator:
                    for scanned, entry in enumerate(iterator):
                        if scanned >= MAX_SCANNED_ENTRIES:
                            truncated = True
                            break
                        name = entry.name
                        try:
                            name.encode("utf-8", errors="strict")
                        except UnicodeEncodeError:
                            continue
                        if _protected_name(name):
                            continue
                        try:
                            info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
                        except OSError:
                            # Entries that disappear or become inaccessible while
                            # enumerating are omitted. A later replacement check
                            # catches changes to entries we actually return.
                            continue
                        if stat.S_ISLNK(info.st_mode):
                            continue
                        if stat.S_ISDIR(info.st_mode):
                            kind = "directory"
                        elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                            kind = "file"
                        else:
                            continue
                        relative = "/".join((*parts, name))
                        entries.append((name, {
                            "name": name,
                            "path": relative,
                            "kind": kind,
                            "size": info.st_size if kind == "file" else None,
                        }, _identity(info)))
                        if len(entries) > limit:
                            truncated = True
                            break
            except WorkspaceFilesError:
                raise
            except OSError as exc:
                raise _WorkspaceTraversal._path_error(exc) from None

            # Entries are metadata only, but do not return a stale name/type if
            # an attacker replaced one while the directory was being scanned.
            selected = sorted(entries[:limit], key=lambda item: (item[0].casefold(), item[0]))
            try:
                for name, _entry, identity in selected:
                    current = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
                    if _identity(current) != identity:
                        raise WorkspaceFilesError(409, "Workspace path changed during the request")
            except WorkspaceFilesError:
                raise
            except OSError as exc:
                raise WorkspaceFilesError(409, "Workspace path changed during the request") from exc
            traversal.verify_links()
            return {
                "path": path,
                "entries": [entry for _name, entry, _identity_value in selected],
                "truncated": truncated,
            }

    def read_text(self, root: str, path: str, max_bytes: int = DEFAULT_READ_BYTES) -> dict[str, Any]:
        if (isinstance(max_bytes, bool) or not isinstance(max_bytes, int)
                or not 1 <= max_bytes <= MAX_READ_BYTES):
            raise WorkspaceFilesError(400, f"max_bytes must be between 1 and {MAX_READ_BYTES}")
        parts = _parse_relative_path(path, allow_root=False)
        _validate_total_depth(root, parts)
        with _WorkspaceTraversal(root) as traversal:
            parent_fd = traversal.open_relative_directory(parts[:-1])
            name = parts[-1]
            try:
                before = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
                if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
                    raise WorkspaceFilesError(404, "Workspace file not found")
                descriptor = os.open(name, traversal.regular_flags, dir_fd=parent_fd)
            except WorkspaceFilesError:
                raise
            except OSError as exc:
                raise _WorkspaceTraversal._path_error(exc) from None

            try:
                opened = os.fstat(descriptor)
                if not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1 or _identity(before) != _identity(opened):
                    raise WorkspaceFilesError(404, "Workspace file not found")
                data = bytearray()
                while len(data) <= max_bytes:
                    chunk = os.read(descriptor, min(64 * 1024, max_bytes + 1 - len(data)))
                    if not chunk:
                        break
                    data.extend(chunk)
                after = os.fstat(descriptor)
                if not _same_version(opened, after):
                    raise WorkspaceFilesError(409, "Workspace file changed during the request")
            except WorkspaceFilesError:
                raise
            except OSError as exc:
                raise _WorkspaceTraversal._path_error(exc) from None
            finally:
                os.close(descriptor)

            try:
                linked = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
            except OSError as exc:
                raise WorkspaceFilesError(409, "Workspace file changed during the request") from exc
            if not _same_version(opened, linked):
                raise WorkspaceFilesError(409, "Workspace file changed during the request")

            truncated = len(data) > max_bytes
            bounded = bytes(data[:max_bytes])
            if b"\x00" in bounded:
                raise WorkspaceFilesError(415, "Binary files are not supported")
            try:
                text = bounded.decode("utf-8")
            except UnicodeDecodeError as exc:
                if truncated and exc.end == len(bounded):
                    # The cap may bisect one UTF-8 scalar. Keep only the valid
                    # prefix, while still reporting that more file content exists.
                    text = bounded[:exc.start].decode("utf-8")
                else:
                    raise WorkspaceFilesError(415, "File is not valid UTF-8 text") from exc
            traversal.verify_links()
            return {
                "path": path,
                "content": text,
                "truncated": truncated,
            }
