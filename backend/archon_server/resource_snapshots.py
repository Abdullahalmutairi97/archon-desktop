"""Immutable per-attempt resource snapshots and runtime pins.

An attempt is what actually ran: which runtime identity, which executable digest,
which manifest revision, which workspace generation and which approval mode. A
snapshot records that, once, and refuses to be overwritten, so a later change to a
pin or to an installed binary cannot rewrite history. A pin records the identity a
person accepted; drift reports where the observed identity moved away from it, and
rolling back means adopting an identity that this ledger already recorded - it does
not install anything. It never returns or stores a credential value.
"""
from __future__ import annotations

import json
import os
import re
import stat
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping

_IDENTIFIER = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")
_DIGEST = re.compile(r"[0-9a-f]{64}\Z")
_RUNTIME = re.compile(r"[a-z][a-z0-9_-]{0,31}\Z")
_MAX_SNAPSHOT_BYTES = 32 * 1024
_MAX_PIN_LIST = 32
_MAX_HISTORY = 16
_APPROVAL_MODES = frozenset({"restricted", "auto", "read-only"})


class ResourceSnapshotError(RuntimeError):
    """Base error for resource snapshots and pins."""


class ResourceSnapshotUnavailable(ResourceSnapshotError):
    """A snapshot or pin file is missing, unsafe, malformed or already taken."""


def _private_root(path: str | os.PathLike[str], label: str) -> Path:
    root = Path(path).expanduser()
    if not root.is_absolute():
        raise ValueError(f"{label} must be an absolute path")
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = os.lstat(root)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise ResourceSnapshotUnavailable(f"{label} must be a directory, not a link")
    if info.st_uid != os.geteuid():
        raise ResourceSnapshotUnavailable(f"{label} must be owned by this account")
    if stat.S_IMODE(info.st_mode) & 0o077:
        os.chmod(root, 0o700)
    return root


def _write_private(path: Path, payload: bytes) -> None:
    """Replace one file atomically with a private, owner-only result."""
    handle, temporary = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-")
    try:
        os.fchmod(handle, 0o600)
        with os.fdopen(handle, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise
    os.chmod(path, 0o600)


def _read_private(path: Path, *, max_bytes: int) -> bytes:
    try:
        info = os.lstat(path)
    except OSError as exc:
        raise ResourceSnapshotUnavailable("The file is missing") from exc
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise ResourceSnapshotUnavailable("The file must be a regular file, not a link")
    if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise ResourceSnapshotUnavailable("The file is not private to this account")
    if info.st_size > max_bytes:
        raise ResourceSnapshotUnavailable("The file is larger than the permitted bound")
    with open(path, "rb") as stream:
        return stream.read()


def _bounded_text(value: Any, limit: int) -> str | None:
    if not isinstance(value, str) or not value or len(value) > limit:
        return None
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        return None
    return value


def _manifest_facts(manifest: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """Keep the identity facts of one runtime manifest row, and nothing else."""
    if not isinstance(manifest, Mapping):
        return None
    runtime = _bounded_text(manifest.get("id"), 32)
    if runtime is None or not _RUNTIME.fullmatch(runtime):
        return None
    digest = manifest.get("executable_digest")
    executable = _bounded_text(manifest.get("executable"), 512)
    capabilities = manifest.get("capabilities")
    return {
        "id": runtime,
        "available": manifest.get("available") is True,
        "version": _bounded_text(manifest.get("version"), 128),
        "versionVerified": manifest.get("version_verified") is True,
        "manifestVersion": manifest.get("manifest_version") if isinstance(manifest.get("manifest_version"), int) else None,
        "executableDigest": digest if isinstance(digest, str) and _DIGEST.fullmatch(digest) else None,
        # The executable path is an operator-visible path, not a secret; the digest is
        # what identifies the artefact.
        "executable": executable,
        "capabilities": {
            key: capabilities[key] for key in sorted(capabilities)
            if key in {
                "modalities", "resume", "fork", "steer", "approval", "read_only", "chat_only",
                "reconnect", "resource_formats", "transports",
            }
        } if isinstance(capabilities, Mapping) else {},
    }



_DEFINITION_STATES = {"current", "drifted", "unobserved", "configuration-only"}
_DEFINITION_SCOPES = {"agent", "workspace", "project"}


def _definition_rows(definitions: Iterable[Any]) -> list[dict[str, Any]]:
    """Keep the declared-resource facts of an attempt, and drop anything else."""
    rows: list[dict[str, Any]] = []
    for row in list(definitions)[:32]:
        if not isinstance(row, Mapping):
            continue
        state = row.get("state")
        rows.append({
            "name": row.get("name") if isinstance(row.get("name"), str) else None,
            "kind": row.get("kind") if isinstance(row.get("kind"), str) else None,
            "version": row.get("version") if isinstance(row.get("version"), str) else None,
            "digest": row.get("digest") if isinstance(row.get("digest"), str) else None,
            "observedDigest": row.get("observedDigest") if isinstance(row.get("observedDigest"), str) else None,
            # An unknown state is never trusted from the ledger.
            "state": state if state in _DEFINITION_STATES else "unobserved",
            "scope": row.get("scope") if row.get("scope") in _DEFINITION_SCOPES else None,
            "scopeId": row.get("scopeId") if isinstance(row.get("scopeId"), str) else None,
        })
    return rows

class ResourceSnapshotStore:
    """One immutable snapshot per task attempt, in a private directory."""

    def __init__(
        self,
        root: str | os.PathLike[str],
        *,
        max_snapshots: int = 512,
        now: Callable[[], datetime] | None = None,
    ):
        if isinstance(max_snapshots, bool) or not isinstance(max_snapshots, int) or not 1 <= max_snapshots <= 8192:
            raise ValueError("max_snapshots must be between 1 and 8192")
        self.root = _private_root(root, "resource snapshot root")
        self.max_snapshots = max_snapshots
        self._now = now or (lambda: datetime.now(timezone.utc))

    # ------------------------------------------------------------------ write

    def record(
        self,
        *,
        task_id: Any,
        attempt_id: Any,
        approval_mode: Any = None,
        workspace_id: Any = None,
        workspace_generation: Any = None,
        manifests: Iterable[Mapping[str, Any]] = (),
        runtime_id: Any = None,
        pins: Mapping[str, Any] | None = None,
        definitions: Iterable[Mapping[str, Any]] = (),
    ) -> dict[str, Any]:
        """Write the snapshot for one attempt, or refuse because it already exists."""
        task = self._identifier(task_id, "task_id")
        attempt = self._identifier(attempt_id, "attempt_id")
        path = self._path(task, attempt)
        if path.exists():
            raise ResourceSnapshotUnavailable("A snapshot already exists for this attempt")
        rows = [row for row in (_manifest_facts(manifest) for manifest in list(manifests)[:8]) if row is not None]
        chosen = None
        if runtime_id is not None:
            wanted = self._identifier(runtime_id, "runtime_id")
            chosen = next((row for row in rows if row["id"] == wanted), None)
        elif len(rows) == 1:
            chosen = rows[0]
        mode = approval_mode if isinstance(approval_mode, str) and approval_mode in _APPROVAL_MODES else None
        record = {
            "version": 1,
            "taskId": task,
            "attemptId": attempt,
            "recordedAt": self._now().isoformat(),
            "runtime": chosen,
            "runtimeManifests": rows,
            "workspaceId": self._identifier(workspace_id, "workspace_id") if workspace_id is not None else None,
            "workspaceGeneration": workspace_generation if isinstance(workspace_generation, int) and workspace_generation > 0 else None,
            "approvalMode": mode,
            "pin": {
                "digest": (pins or {}).get("digest") if isinstance(pins, Mapping) else None,
                "pinnedAt": (pins or {}).get("pinnedAt") if isinstance(pins, Mapping) else None,
                "drifted": True if isinstance(pins, Mapping) and pins.get("drifted") is True else False,
            },
            # The declared resources in effect for this attempt, narrowest scope first.
            # Declarations are metadata; a state of "current" means the declaration's
            # digest matches what this host measured, not that a runtime loaded it.
            "definitions": _definition_rows(definitions),
            "note": (
                "Recorded once, when the attempt started. It states the identity this server "
                "observed; it is not a claim that the runtime authenticated or ran correctly."
            ),
        }
        payload = json.dumps(record, sort_keys=True, separators=(",", ":")).encode()
        if len(payload) > _MAX_SNAPSHOT_BYTES:
            raise ResourceSnapshotUnavailable("The snapshot is larger than the permitted bound")
        self._prune(keep=task, attempt=attempt)
        _write_private(path, payload)
        return self._shape(record)

    # ------------------------------------------------------------------- read

    def read(self, task_id: Any, attempt_id: Any) -> dict[str, Any]:
        task = self._identifier(task_id, "task_id")
        attempt = self._identifier(attempt_id, "attempt_id")
        raw = _read_private(self._path(task, attempt), max_bytes=_MAX_SNAPSHOT_BYTES)
        return self._shape(self._decode(raw))

    def list(self, *, task_id: Any = None, limit: int = 32) -> list[dict[str, Any]]:
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 128:
            raise ValueError("limit must be between 1 and 128")
        task = self._identifier(task_id, "task_id") if task_id is not None else None
        rows: list[dict[str, Any]] = []
        for path in sorted(self.root.glob("*.json"), key=lambda item: item.stat().st_mtime, reverse=True):
            name_task, _, name_attempt = path.stem.partition("__")
            if task is not None and name_task != task:
                continue
            if not _IDENTIFIER.fullmatch(name_attempt):
                continue
            rows.append(self.read(name_task, name_attempt))
            if len(rows) >= limit:
                break
        return rows

    def clear(self) -> int:
        removed = 0
        for path in self.root.glob("*.json"):
            try:
                os.unlink(path)
                removed += 1
            except OSError:
                continue
        return removed

    def status(self) -> dict[str, Any]:
        files = [path for path in self.root.glob("*.json")]
        return {
            "snapshots": len(files),
            "maxSnapshots": self.max_snapshots,
            "root": str(self.root),
            "rawValuesStored": False,
            "note": (
                "Snapshots hold identity facts only: runtime id, digest, manifest revision, "
                "workspace generation and approval mode. No credential value and no process "
                "output is stored."
            ),
        }

    # -------------------------------------------------------------- internals

    @staticmethod
    def _identifier(value: Any, label: str) -> str:
        if not isinstance(value, str) or not _IDENTIFIER.fullmatch(value):
            raise ValueError(f"{label} is invalid")
        return value

    def _path(self, task: str, attempt: str) -> Path:
        return self.root / f"{task}__{attempt}.json"

    def _prune(self, *, keep: str, attempt: str) -> None:
        paths = sorted(self.root.glob("*.json"), key=lambda item: item.stat().st_mtime)
        while len(paths) >= self.max_snapshots:
            oldest = paths.pop(0)
            if oldest.stem == f"{keep}__{attempt}":
                if not paths:
                    break
                oldest = paths.pop(0)
            try:
                os.unlink(oldest)
            except OSError:
                continue

    @staticmethod
    def _decode(raw: bytes) -> dict[str, Any]:
        try:
            document = json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise ResourceSnapshotUnavailable("The snapshot is not valid JSON") from exc
        if not isinstance(document, dict) or document.get("version") != 1:
            raise ResourceSnapshotUnavailable("The snapshot has an unsupported schema")
        for key in ("taskId", "attemptId", "recordedAt"):
            if not isinstance(document.get(key), str):
                raise ResourceSnapshotUnavailable("The snapshot is missing required fields")
        if document.get("runtime") is not None and not isinstance(document.get("runtime"), dict):
            raise ResourceSnapshotUnavailable("The snapshot runtime row is malformed")
        if not isinstance(document.get("runtimeManifests"), list):
            raise ResourceSnapshotUnavailable("The snapshot manifest list is malformed")
        if not isinstance(document.get("definitions", []), list):
            raise ResourceSnapshotUnavailable("The snapshot definition list is malformed")
        return document

    @staticmethod
    def _shape(document: Mapping[str, Any]) -> dict[str, Any]:
        """Return the snapshot with only the fields this API promises."""
        runtime = document.get("runtime")
        return {
            "taskId": document.get("taskId"),
            "attemptId": document.get("attemptId"),
            "recordedAt": document.get("recordedAt"),
            "runtime": dict(runtime) if isinstance(runtime, Mapping) else None,
            "runtimeManifests": [dict(row) for row in document.get("runtimeManifests") or []
                                 if isinstance(row, Mapping)][:8],
            "workspaceId": document.get("workspaceId"),
            "workspaceGeneration": document.get("workspaceGeneration"),
            "approvalMode": document.get("approvalMode"),
            "pin": dict(document.get("pin") or {}) if isinstance(document.get("pin"), Mapping) else {},
            "definitions": _definition_rows(document.get("definitions") or []),
            "note": document.get("note"),
        }


    def digest_by_task(self, task_ids: Iterable[Any], *, limit: int = 512) -> dict[str, str | None]:
        """Return the newest recorded executable digest for each requested task.

        A task can have several attempts; the newest snapshot is the identity the
        most recent attempt ran with.
        """
        wanted = {task for task in task_ids if isinstance(task, str) and _IDENTIFIER.fullmatch(task)}
        found: dict[str, str | None] = {}
        if not wanted:
            return found
        paths = sorted(self.root.glob("*.json"), key=lambda item: item.stat().st_mtime, reverse=True)[:limit]
        for path in paths:
            name_task, _, _ = path.stem.partition("__")
            if name_task not in wanted or name_task in found:
                continue
            try:
                document = self._decode(_read_private(path, max_bytes=_MAX_SNAPSHOT_BYTES))
            except ResourceSnapshotUnavailable:
                # An unreadable snapshot is not evidence for or against a resume, so
                # it is reported as unrecorded rather than treated as a match.
                found[name_task] = None
                continue
            runtime = document.get("runtime")
            digest = runtime.get("executableDigest") if isinstance(runtime, Mapping) else None
            found[name_task] = digest if isinstance(digest, str) else None
        for task in wanted:
            found.setdefault(task, None)
        return found


class ResourcePinLedger:
    """The runtime identity a person accepted, with drift and recorded rollback."""

    def __init__(self, root: str | os.PathLike[str], *, now: Callable[[], datetime] | None = None):
        self.root = _private_root(root, "resource pin root")
        self.path = self.root / "pins.json"
        self._now = now or (lambda: datetime.now(timezone.utc))

    def _load(self) -> dict[str, Any]:
        if not self.path.exists():
            return {"version": 1, "epoch": 0, "pins": {}}
        raw = _read_private(self.path, max_bytes=64 * 1024)
        try:
            document = json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise ResourceSnapshotUnavailable("The pin ledger is not valid JSON") from exc
        if not isinstance(document, dict) or document.get("version") != 1 or not isinstance(document.get("pins"), dict):
            raise ResourceSnapshotUnavailable("The pin ledger has an unsupported schema")
        if len(document["pins"]) > _MAX_PIN_LIST:
            raise ResourceSnapshotUnavailable("The pin ledger holds more pins than permitted")
        return document

    def _save(self, document: dict[str, Any]) -> None:
        payload = json.dumps(document, sort_keys=True, separators=(",", ":")).encode()
        if len(payload) > 64 * 1024:
            raise ResourceSnapshotUnavailable("The pin ledger would be larger than permitted")
        _write_private(self.path, payload)

    def _row(self, runtime: str, digest: str, note: str | None) -> dict[str, Any]:
        return {
            "digest": digest,
            "pinnedAt": self._now().isoformat(),
            "note": note,
        }

    def pin(
        self,
        *,
        runtime: Any,
        digest: Any,
        history: Iterable[Any] = (),
        note: Any = None,
        accept_observed: bool = False,
    ) -> dict[str, Any]:
        """Adopt one identity.

        `accept_observed=True` accepts the digest the host reports now, which is how
        an operator accepts a legitimate update (the previous digest is kept in
        history). Without it, the digest must be one this ledger already recorded, so
        an arbitrary digest can never be adopted as a rollback target.
        """
        name = runtime if isinstance(runtime, str) and _RUNTIME.fullmatch(runtime) else None
        if name is None:
            raise ValueError("runtime is invalid")
        if not isinstance(digest, str) or not _DIGEST.fullmatch(digest):
            raise ValueError("digest must be a sha256 hex digest")
        text = _bounded_text(note, 256) if note is not None else None
        document = self._load()
        entry = document["pins"].get(name)
        recorded = list(entry.get("history") or []) if entry else []
        if entry is None:
            if not accept_observed and history:
                raise ResourceSnapshotUnavailable("Cannot roll back a runtime that has no recorded pin")
        elif digest != entry.get("digest"):
            if accept_observed or digest in recorded:
                recorded = ([entry["digest"]] + [row for row in recorded if row != digest])[:_MAX_HISTORY]
            else:
                raise ResourceSnapshotUnavailable("That digest was never recorded for this runtime")
        document["pins"][name] = {**self._row(name, digest, text), "history": recorded}
        document["epoch"] = int(document.get("epoch", 0)) + 1
        self._save(document)
        return self._shape(document)

    def unpin(self, runtime: Any) -> None:
        name = runtime if isinstance(runtime, str) and _RUNTIME.fullmatch(runtime) else None
        if name is None:
            raise ValueError("runtime is invalid")
        document = self._load()
        if name not in document["pins"]:
            raise ResourceSnapshotUnavailable("That runtime has no pin")
        document["pins"].pop(name)
        document["epoch"] = int(document.get("epoch", 0)) + 1
        self._save(document)

    def drift(self, manifests: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
        """Report where an observed identity differs from the pin that was accepted."""
        document = self._load()
        observed = {row["id"]: row for row in (_manifest_facts(manifest) for manifest in manifests) if row}
        rows = []
        for name, entry in sorted(document["pins"].items()):
            current = observed.get(name)
            digest = current["executableDigest"] if current else None
            rows.append({
                "runtime": name,
                "pinnedDigest": entry.get("digest"),
                "observedDigest": digest,
                "drifted": bool(digest) and digest != entry.get("digest"),
                "observed": current is not None,
                "note": entry.get("note"),
                "pinnedAt": entry.get("pinnedAt"),
                "history": list(entry.get("history") or []),
            })
        return {
            "pins": rows,
            "epoch": int(document.get("epoch", 0)),
            "note": (
                "drifted means the executable digest on this host is not the digest that was "
                "accepted for that runtime. It never installs or restores a binary."
            ),
        }

    def _shape(self, document: Mapping[str, Any]) -> dict[str, Any]:
        return {"epoch": int(document.get("epoch", 0)), "pins": dict(document.get("pins") or {})}

    def pin_for(self, runtime: str) -> dict[str, Any] | None:
        return (self._load()["pins"] or {}).get(runtime)


def session_identity_state(
    *,
    recorded_digests: Iterable[str | None],
    current_digest: str | None,
) -> dict[str, Any]:
    """Decide whether a conversation may continue under the current runtime identity.

    A conversation is only resumed when every attempt that recorded an identity
    recorded the identity that is installed now. With no recorded identity there is
    no evidence of a change, so the resume is allowed and the state says
    `unrecorded` rather than pretending it was verified. With a recorded identity
    and nothing installed to match it against, the resume is refused: that is the
    fail-closed direction.
    """
    recorded = [digest for digest in recorded_digests if isinstance(digest, str)]
    if not recorded:
        return {
            "state": "unrecorded",
            "recordedDigest": None,
            "currentDigest": current_digest,
            "resumeAllowed": True,
            "reason": (
                "No attempt recorded a runtime identity for this conversation yet, so a "
                "change cannot be ruled out or confirmed."
            ),
        }
    newest = recorded[0]
    if current_digest is None:
        return {
            "state": "stale",
            "recordedDigest": newest,
            "currentDigest": None,
            "resumeAllowed": False,
            "reason": (
                "This conversation recorded a runtime identity and no executable digest is "
                "observable now, so the identity cannot be matched."
            ),
        }
    if any(digest != current_digest for digest in recorded):
        return {
            "state": "stale",
            "recordedDigest": newest,
            "currentDigest": current_digest,
            "resumeAllowed": False,
            "reason": (
                "The runtime executable changed since this conversation ran; start a new "
                "conversation rather than resuming cached state under a different identity."
            ),
        }
    return {
        "state": "current",
        "recordedDigest": newest,
        "currentDigest": current_digest,
        "resumeAllowed": True,
        "reason": "Every attempt recorded the identity that is installed now.",
    }
