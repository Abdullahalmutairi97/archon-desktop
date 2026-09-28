"""A managed, content-addressed store that provisions approved resource artefacts.

This is the one place the server installs anything, and it does so narrowly:

* the owner stages the artefact file in a private staging directory; the server
  never downloads, unpacks or executes it,
* the bytes are copied into `objects/<sha256>` while being hashed, and nothing is
  kept unless the measured digest equals the digest the definition recorded,
* activation is an atomic swap of the `current/<name>` link, so a reader sees the
  old object or the new one, never a partial file,
* the previously active digests are retained, so a rollback re-verifies a retained
  object and swaps the link back,
* and every install and rollback is recorded in a private ledger.

A consumer uses the artefact by pointing its configured path at `current/<name>`;
the store does not rewrite another program's configuration, register an editor
extension or restart a service, and `measure` reports what the link holds now.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

_NAME = re.compile(r"[a-z][a-z0-9._-]{0,63}\Z")
_DIGEST = re.compile(r"[0-9a-f]{64}\Z")
# Only an artefact a person can check by digest can be provisioned.
_KINDS = {"runtime": 0o500, "extension": 0o400}
_MAX_PREVIOUS = 8
_MAX_HISTORY = 32
_MAX_ENTRIES = 128
_LEDGER_BYTES = 256 * 1024
_DEFAULT_MAX_BYTES = 512 * 1024 * 1024
_CHUNK = 1024 * 1024
_OPERATIONS = frozenset({"install", "rollback"})


class ResourceStoreError(RuntimeError):
    """Base error for the managed resource store."""


class ResourceStoreUnavailable(ResourceStoreError):
    """The store is unsafe, malformed, or an object no longer matches its digest."""


class ResourceStoreRejected(ResourceStoreError):
    """The requested install or rollback is refused; nothing was changed."""


def _private_directory(path: str | os.PathLike[str], label: str) -> Path:
    directory = Path(path)
    if not directory.is_absolute():
        raise ValueError(f"{label} must be an absolute path")
    was_present = directory.exists() or directory.is_symlink()
    directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    info = directory.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid()
            or (was_present and stat.S_IMODE(info.st_mode) != 0o700)
            or stat.S_IMODE(info.st_mode) & 0o077):
        raise ResourceStoreUnavailable(f"{label} must be a private directory owned by this account")
    return directory


def _digest_of(descriptor: int) -> str:
    digest = hashlib.sha256()
    os.lseek(descriptor, 0, os.SEEK_SET)
    while True:
        chunk = os.read(descriptor, _CHUNK)
        if not chunk:
            return digest.hexdigest()
        digest.update(chunk)


class ResourceStore:
    """Install verified artefacts, activate them atomically and roll them back."""

    def __init__(
        self,
        root: str | os.PathLike[str],
        *,
        staging_root: str | os.PathLike[str],
        max_bytes: int = _DEFAULT_MAX_BYTES,
        now: Callable[[], datetime] | None = None,
    ):
        if isinstance(max_bytes, bool) or not isinstance(max_bytes, int) or max_bytes < 1:
            raise ValueError("max_bytes must be a positive integer")
        self.root = _private_directory(root, "resource store root")
        self.objects = _private_directory(self.root / "objects", "resource store objects")
        self.current = _private_directory(self.root / "current", "resource store links")
        self.staging_root = _private_directory(staging_root, "resource staging directory")
        self.ledger_path = self.root / "store.json"
        self.max_bytes = max_bytes
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._lock = threading.Lock()

    # -- public operations --------------------------------------------------

    def install(self, *, name: Any, kind: Any, digest: Any, source: Any) -> dict[str, Any]:
        """Copy a staged artefact into the store and activate it, or change nothing."""
        key, mode, expected = self._validate(name, kind, digest)
        with self._lock:
            document = self._load()
            entry = document["entries"].get(key)
            if entry is not None and entry["kind"] != kind:
                raise ResourceStoreRejected("That name is already provisioned as a different kind")
            if entry is None and len(document["entries"]) >= _MAX_ENTRIES:
                raise ResourceStoreRejected("The store holds its maximum number of resources")
            descriptor = self._open_source(source)
            try:
                self._store_object(descriptor, expected, mode)
            finally:
                os.close(descriptor)
            if entry is not None and entry["activeDigest"] == expected:
                # The accepted identity is already active; an install is not a new version.
                self._verify_object(expected)
                return self._public(key, entry)
            return self._activate(document, key, kind, expected, "install")

    def rollback(self, *, name: Any, digest: Any = None) -> dict[str, Any]:
        """Re-activate a retained digest, the most recent previous one by default."""
        if not isinstance(name, str) or not _NAME.fullmatch(name):
            raise ValueError("resource name is invalid")
        if digest is not None and (not isinstance(digest, str) or not _DIGEST.fullmatch(digest)):
            raise ValueError("digest must be a sha256 hex digest")
        with self._lock:
            document = self._load()
            entry = document["entries"].get(name)
            if entry is None:
                raise ResourceStoreRejected("That resource has never been provisioned here")
            previous = entry["previousDigests"]
            target = digest if digest is not None else (previous[0] if previous else None)
            if target is None or target not in previous:
                raise ResourceStoreRejected("That digest is not a retained version of this resource")
            return self._activate(document, name, entry["kind"], target, "rollback")

    def measure(self, name: str) -> dict[str, Any]:
        """Report what `current/<name>` holds now, by hashing it, not from the ledger."""
        if not isinstance(name, str) or not _NAME.fullmatch(name):
            raise ValueError("resource name is invalid")
        link = self.current / name
        try:
            target = os.readlink(link)
        except FileNotFoundError:
            return {"present": False, "digest": None, "path": None}
        except OSError as exc:
            raise ResourceStoreUnavailable("The resource link is not a link") from exc
        digest_name = Path(target).name
        if target != os.path.join("..", "objects", digest_name) or not _DIGEST.fullmatch(digest_name):
            raise ResourceStoreUnavailable("The resource link points outside the store")
        descriptor = self._open_object(digest_name)
        try:
            measured = _digest_of(descriptor)
        finally:
            os.close(descriptor)
        return {"present": True, "digest": measured, "path": str(link)}

    def entries(self) -> list[dict[str, Any]]:
        with self._lock:
            document = self._load()
        return [self._public(key, entry) for key, entry in sorted(document["entries"].items())]

    def status(self) -> dict[str, Any]:
        return {
            "stagingRoot": str(self.staging_root),
            "currentRoot": str(self.current),
            "maxBytes": self.max_bytes,
            "kinds": sorted(_KINDS),
            "note": (
                "An approved request is provisioned by copying a staged file whose sha256 "
                "matches its definition into this store and atomically switching "
                "current/<name> to it. The store never downloads, unpacks or executes an "
                "artefact, and it does not reconfigure the program that uses it."
            ),
        }

    # -- internals ----------------------------------------------------------

    @staticmethod
    def _validate(name: Any, kind: Any, digest: Any) -> tuple[str, int, str]:
        if not isinstance(name, str) or not _NAME.fullmatch(name):
            raise ValueError("resource name is invalid")
        if kind not in _KINDS:
            raise ValueError("only a runtime or an extension artefact can be provisioned")
        if not isinstance(digest, str) or not _DIGEST.fullmatch(digest):
            raise ValueError("digest must be a sha256 hex digest")
        return name, _KINDS[kind], digest

    def _open_source(self, source: Any) -> int:
        """Open a staged file directly inside the staging directory, without following links."""
        if not isinstance(source, (str, os.PathLike)):
            raise ResourceStoreRejected("The artefact path is invalid")
        path = Path(source)
        if not path.is_absolute() or path.name in {"", ".", ".."} or path.parent != self.staging_root:
            raise ResourceStoreRejected("The artefact must be a file directly inside the staging directory")
        directory = os.open(self.staging_root, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW)
        try:
            info = os.fstat(directory)
            if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077:
                raise ResourceStoreUnavailable("The staging directory is no longer private")
            try:
                descriptor = os.open(path.name, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK,
                                     dir_fd=directory)
            except OSError as exc:
                raise ResourceStoreRejected("The staged artefact cannot be opened as a regular file") from exc
        finally:
            os.close(directory)
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode):
                raise ResourceStoreRejected("The staged artefact is not a regular file")
            if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o022:
                raise ResourceStoreRejected("The staged artefact must be owned by and writable only by this account")
            if info.st_size > self.max_bytes:
                raise ResourceStoreRejected("The staged artefact is larger than the permitted bound")
        except BaseException:
            os.close(descriptor)
            raise
        return descriptor

    def _store_object(self, source: int, expected: str, mode: int) -> None:
        """Copy while hashing into a private temporary file; keep it only on a digest match."""
        final = self.objects / expected
        temporary = self.objects / (".tmp-" + uuid.uuid4().hex)
        output = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
        try:
            digest = hashlib.sha256()
            copied = 0
            while True:
                chunk = os.read(source, _CHUNK)
                if not chunk:
                    break
                copied += len(chunk)
                if copied > self.max_bytes:
                    raise ResourceStoreRejected("The staged artefact is larger than the permitted bound")
                digest.update(chunk)
                view = memoryview(chunk)
                while view:
                    written = os.write(output, view)
                    if written <= 0:
                        raise ResourceStoreUnavailable("Short write while storing the artefact")
                    view = view[written:]
            measured = digest.hexdigest()
            if measured != expected:
                raise ResourceStoreRejected(
                    f"The staged artefact's sha256 digest {measured} does not match the approved {expected}"
                )
            os.fchmod(output, mode)
            os.fsync(output)
            os.close(output)
            output = -1
            if os.path.lexists(final):
                # Content addressing: an existing object must still hold its digest.
                self._verify_object(expected)
            else:
                os.rename(temporary, final)
                self._fsync_directory(self.objects)
        finally:
            if output >= 0:
                os.close(output)
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass

    def _open_object(self, digest: str) -> int:
        try:
            descriptor = os.open(self.objects / digest, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
        except OSError as exc:
            raise ResourceStoreUnavailable("A stored object is missing or is not a regular file") from exc
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077:
            os.close(descriptor)
            raise ResourceStoreUnavailable("A stored object is not a private regular file")
        return descriptor

    def _verify_object(self, digest: str) -> None:
        descriptor = self._open_object(digest)
        try:
            measured = _digest_of(descriptor)
        finally:
            os.close(descriptor)
        if measured != digest:
            raise ResourceStoreUnavailable("A stored object no longer matches its sha256 digest")

    def _activate(self, document: dict[str, Any], key: str, kind: str, digest: str,
                  operation: str) -> dict[str, Any]:
        self._verify_object(digest)
        link = self.current / key
        temporary = self.current / (".tmp-" + uuid.uuid4().hex)
        os.symlink(os.path.join("..", "objects", digest), temporary)
        try:
            os.replace(temporary, link)
        except BaseException:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass
            raise
        self._fsync_directory(self.current)
        entry = document["entries"].get(key)
        previous_active = entry["activeDigest"] if entry else None
        retained = [value for value in (entry["previousDigests"] if entry else []) if value != digest]
        if previous_active is not None and previous_active != digest:
            retained = [previous_active] + [value for value in retained if value != previous_active]
        history = list(entry["history"]) if entry else []
        history.append({
            "operation": operation, "digest": digest, "replaced": previous_active,
            "at": self._now().astimezone(timezone.utc).isoformat(),
        })
        document["entries"][key] = {
            "kind": kind,
            "activeDigest": digest,
            "previousDigests": retained[:_MAX_PREVIOUS],
            "activatedAt": self._now().astimezone(timezone.utc).isoformat(),
            "history": history[-_MAX_HISTORY:],
        }
        self._save(document)
        return self._public(key, document["entries"][key])

    def _public(self, key: str, entry: dict[str, Any]) -> dict[str, Any]:
        return {
            "name": key,
            "kind": entry["kind"],
            "activeDigest": entry["activeDigest"],
            "previousDigests": list(entry["previousDigests"]),
            "activatedAt": entry["activatedAt"],
            "path": str(self.current / key),
            "history": [dict(row) for row in entry["history"]],
        }

    @staticmethod
    def _fsync_directory(directory: Path) -> None:
        descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def _load(self) -> dict[str, Any]:
        try:
            descriptor = os.open(self.ledger_path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
        except FileNotFoundError:
            return {"version": 1, "entries": {}}
        except OSError as exc:
            raise ResourceStoreUnavailable("The store ledger cannot be opened safely") from exc
        try:
            info = os.fstat(descriptor)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                    or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > _LEDGER_BYTES):
                raise ResourceStoreUnavailable("The store ledger is unsafe or oversized")
            payload = os.read(descriptor, _LEDGER_BYTES + 1)
        finally:
            os.close(descriptor)
        try:
            document = json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ResourceStoreUnavailable("The store ledger is malformed") from exc
        if (not isinstance(document, dict) or set(document) != {"version", "entries"}
                or document["version"] != 1 or not isinstance(document["entries"], dict)
                or len(document["entries"]) > _MAX_ENTRIES):
            raise ResourceStoreUnavailable("The store ledger has an unsupported schema")
        for key, entry in document["entries"].items():
            if not self._valid_entry(key, entry):
                raise ResourceStoreUnavailable("The store ledger contains an invalid entry")
        return document

    @staticmethod
    def _valid_entry(key: Any, entry: Any) -> bool:
        if not isinstance(key, str) or not _NAME.fullmatch(key) or not isinstance(entry, dict):
            return False
        if set(entry) != {"kind", "activeDigest", "previousDigests", "activatedAt", "history"}:
            return False
        if entry["kind"] not in _KINDS or not isinstance(entry["activatedAt"], str):
            return False
        if not isinstance(entry["activeDigest"], str) or not _DIGEST.fullmatch(entry["activeDigest"]):
            return False
        previous = entry["previousDigests"]
        if (not isinstance(previous, list) or len(previous) > _MAX_PREVIOUS
                or not all(isinstance(value, str) and _DIGEST.fullmatch(value) for value in previous)):
            return False
        history = entry["history"]
        if not isinstance(history, list) or len(history) > _MAX_HISTORY:
            return False
        for row in history:
            if (not isinstance(row, dict) or set(row) != {"operation", "digest", "replaced", "at"}
                    or row["operation"] not in _OPERATIONS
                    or not isinstance(row["digest"], str) or not _DIGEST.fullmatch(row["digest"])
                    or (row["replaced"] is not None
                        and (not isinstance(row["replaced"], str) or not _DIGEST.fullmatch(row["replaced"])))
                    or not isinstance(row["at"], str)):
                return False
        return True

    def _save(self, document: dict[str, Any]) -> None:
        payload = json.dumps(document, separators=(",", ":"), sort_keys=True).encode("utf-8")
        if len(payload) > _LEDGER_BYTES:
            raise ResourceStoreUnavailable("The store ledger would be larger than permitted")
        temporary = self.root / (".tmp-" + uuid.uuid4().hex + ".json")
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
        try:
            view = memoryview(payload)
            while view:
                written = os.write(descriptor, view)
                if written <= 0:
                    raise ResourceStoreUnavailable("Short write while saving the store ledger")
                view = view[written:]
            os.fsync(descriptor)
            os.close(descriptor)
            descriptor = -1
            os.replace(temporary, self.ledger_path)
        finally:
            if descriptor >= 0:
                os.close(descriptor)
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass
