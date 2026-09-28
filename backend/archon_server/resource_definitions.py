"""Declarative resource definitions, their assignments, and effective configuration.

A definition is metadata: it names an artefact (a runtime binary, an editor
extension, a tool or an MCP transport) with the version and digest a person
recorded. An assignment binds a definition to a scope - a workspace, a project or
an agent profile. Nothing here installs, downloads or executes anything, and the
effective configuration is what this server reports for a scope, not what any
runtime was observed to load.

The precedence rule is fixed and documented: the narrowest scope wins
(`agent` > `workspace` > `project`), and a narrower scope may only *name* a
definition that exists. It cannot invent one, so an assignment can never widen
what is declared at a broader scope.
"""
from __future__ import annotations

import json
import os
import re
import stat
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping

_NAME = re.compile(r"[a-z][a-z0-9._-]{0,63}\Z")
_SCOPE_ID = re.compile(r"[A-Za-z0-9_.:-]{1,128}\Z")
_DIGEST = re.compile(r"[0-9a-f]{64}\Z")
_VERSION = re.compile(r"[A-Za-z0-9][A-Za-z0-9._+-]{0,63}\Z")
_MAX_DEFINITIONS = 128
_MAX_ASSIGNMENTS = 512
# An artefact a person can check by digest; a configuration-only kind has no digest.
_KINDS = frozenset({"runtime", "extension", "tool", "mcp"})
_DIGEST_KINDS = frozenset({"runtime", "extension"})
_SCOPES = ("agent", "workspace", "project")  # narrowest first
_LEDGER_BYTES = 256 * 1024


class ResourceDefinitionError(RuntimeError):
    """Base error for resource definitions and assignments."""


class ResourceDefinitionUnavailable(ResourceDefinitionError):
    """A ledger is unsafe, malformed, too large or missing a required row."""


def _private_directory(path: str | os.PathLike[str], label: str) -> Path:
    root = Path(path).expanduser()
    if not root.is_absolute():
        raise ValueError(f"{label} must be an absolute path")
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = os.lstat(root)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise ResourceDefinitionUnavailable(f"{label} must be a directory, not a link")
    if info.st_uid != os.geteuid():
        raise ResourceDefinitionUnavailable(f"{label} must be owned by this account")
    if stat.S_IMODE(info.st_mode) & 0o077:
        os.chmod(root, 0o700)
    return root


def _write_private(path: Path, payload: bytes) -> None:
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


def _read_private(path: Path, *, limit: int = _LEDGER_BYTES) -> bytes:
    info = os.lstat(path)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise ResourceDefinitionUnavailable("The ledger must be a regular file, not a link")
    if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise ResourceDefinitionUnavailable("The ledger is not private to this account")
    if info.st_size > limit:
        raise ResourceDefinitionUnavailable("The ledger is larger than the permitted bound")
    with open(path, "rb") as stream:
        return stream.read()


def _text(value: Any, pattern: re.Pattern[str], label: str) -> str:
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise ValueError(f"{label} is invalid")
    return value


class ResourceDefinitionLedger:
    """Definitions and their scope assignments, in one private directory."""

    def __init__(self, root: str | os.PathLike[str], *, now: Callable[[], datetime] | None = None):
        self.root = _private_directory(root, "resource definition root")
        self.definitions_path = self.root / "definitions.json"
        self.assignments_path = self.root / "assignments.json"
        self._now = now or (lambda: datetime.now(timezone.utc))

    # ------------------------------------------------------------ definitions

    def _load(self, path: Path, key: str) -> dict[str, Any]:
        if not path.exists():
            return {"version": 1, "epoch": 0, key: {}}
        try:
            document = json.loads(_read_private(path))
        except (json.JSONDecodeError, UnicodeDecodeError, OSError) as exc:
            raise ResourceDefinitionUnavailable("The ledger is not readable JSON") from exc
        if not isinstance(document, dict) or document.get("version") != 1 or not isinstance(document.get(key), dict):
            raise ResourceDefinitionUnavailable("The ledger has an unsupported schema")
        limit = _MAX_DEFINITIONS if key == "definitions" else _MAX_ASSIGNMENTS
        if len(document[key]) > limit:
            raise ResourceDefinitionUnavailable("The ledger holds more rows than permitted")
        return document

    def _save(self, path: Path, document: dict[str, Any]) -> None:
        payload = json.dumps(document, sort_keys=True, separators=(",", ":")).encode()
        if len(payload) > _LEDGER_BYTES:
            raise ResourceDefinitionUnavailable("The ledger would be larger than permitted")
        _write_private(path, payload)

    def define(
        self,
        *,
        name: Any,
        kind: Any,
        version: Any,
        digest: Any = None,
        source: Any = None,
        licence: Any = None,
        note: Any = None,
    ) -> dict[str, Any]:
        """Record or update one definition. A digest is required for an artefact kind."""
        key = _text(name, _NAME, "definition name")
        if kind not in _KINDS:
            raise ValueError("kind must be runtime, extension, tool or mcp")
        if not isinstance(version, str) or not _VERSION.fullmatch(version):
            raise ValueError("version is invalid")
        if kind in _DIGEST_KINDS:
            if not isinstance(digest, str) or not _DIGEST.fullmatch(digest):
                raise ValueError("a runtime or extension definition requires a sha256 digest")
        elif digest is not None and (not isinstance(digest, str) or not _DIGEST.fullmatch(digest)):
            raise ValueError("digest must be a sha256 hex digest")
        for value, label, limit in ((source, "source", 256), (licence, "licence", 64), (note, "note", 256)):
            if value is not None and (not isinstance(value, str) or not value or len(value) > limit
                                      or any(ord(char) < 32 for char in value)):
                raise ValueError(f"{label} is invalid")
        document = self._load(self.definitions_path, "definitions")
        existing = document["definitions"].get(key)
        history = list(existing.get("history") or []) if existing else []
        if existing and existing.get("digest") and existing["digest"] != digest:
            history = ([existing["digest"]] + history)[:16]
        document["definitions"][key] = {
            "name": key, "kind": kind, "version": version, "digest": digest,
            "source": source, "licence": licence, "note": note,
            "recordedAt": self._now().isoformat(), "history": history,
        }
        document["epoch"] = int(document.get("epoch", 0)) + 1
        self._save(self.definitions_path, document)
        return dict(document["definitions"][key])

    def remove(self, name: Any) -> None:
        key = _text(name, _NAME, "definition name")
        document = self._load(self.definitions_path, "definitions")
        if key not in document["definitions"]:
            raise ResourceDefinitionUnavailable("That definition is not recorded")
        assignments = self._load(self.assignments_path, "assignments")
        holders = [row for row in assignments["assignments"].values() if row.get("definition") == key]
        if holders:
            scopes = ", ".join(f"{row['scope']}:{row['scopeId']}" for row in holders[:4])
            raise ResourceDefinitionUnavailable(f"Assigned at {scopes}; unassign it first")
        document["definitions"].pop(key)
        document["epoch"] = int(document.get("epoch", 0)) + 1
        self._save(self.definitions_path, document)

    def definitions(self) -> list[dict[str, Any]]:
        document = self._load(self.definitions_path, "definitions")
        return [dict(row) for row in sorted(document["definitions"].values(), key=lambda row: row["name"])]

    # ------------------------------------------------------------ assignments

    def assign(self, *, scope: Any, scope_id: Any, definition: Any, note: Any = None) -> dict[str, Any]:
        """Bind a recorded definition to one scope. The definition must exist."""
        if scope not in _SCOPES:
            raise ValueError("scope must be agent, workspace or project")
        identifier = _text(scope_id, _SCOPE_ID, "scopeId")
        key = _text(definition, _NAME, "definition name")
        if note is not None and (not isinstance(note, str) or not note or len(note) > 256):
            raise ValueError("note is invalid")
        definitions = {row["name"] for row in self.definitions()}
        if key not in definitions:
            raise ResourceDefinitionUnavailable("That definition is not recorded")
        document = self._load(self.assignments_path, "assignments")
        document["assignments"][f"{scope}:{identifier}"] = {
            "scope": scope, "scopeId": identifier, "definition": key,
            "assignedAt": self._now().isoformat(), "note": note,
        }
        document["epoch"] = int(document.get("epoch", 0)) + 1
        self._save(self.assignments_path, document)
        return dict(document["assignments"][f"{scope}:{identifier}"])

    def unassign(self, *, scope: Any, scope_id: Any) -> None:
        if scope not in _SCOPES:
            raise ValueError("scope must be agent, workspace or project")
        identifier = _text(scope_id, _SCOPE_ID, "scopeId")
        document = self._load(self.assignments_path, "assignments")
        if f"{scope}:{identifier}" not in document["assignments"]:
            raise ResourceDefinitionUnavailable("That scope has no assignment")
        document["assignments"].pop(f"{scope}:{identifier}")
        document["epoch"] = int(document.get("epoch", 0)) + 1
        self._save(self.assignments_path, document)

    def assignments(self) -> list[dict[str, Any]]:
        document = self._load(self.assignments_path, "assignments")
        return [dict(row) for row in sorted(document["assignments"].values(),
                                             key=lambda row: (row["scope"], row["scopeId"]))]

    # -------------------------------------------------------------- effective

    def effective(
        self,
        *,
        agent: str | None = None,
        workspace: str | None = None,
        project: str | None = None,
        observed: Mapping[str, str | None] | None = None,
    ) -> dict[str, Any]:
        """Resolve the definitions in effect for a scope, narrowest first.

        `observed` maps a definition name to the digest this host reports for it.
        A definition whose observed digest is missing is reported as unobserved and
        never as matching.
        """
        wanted: list[tuple[str, str]] = []
        for scope, identifier in (("agent", agent), ("workspace", workspace), ("project", project)):
            if identifier is None:
                continue
            if not isinstance(identifier, str) or not _SCOPE_ID.fullmatch(identifier):
                raise ValueError(f"{scope} is invalid")
            wanted.append((scope, identifier))
        document = self._load(self.assignments_path, "assignments")
        definitions = {row["name"]: row for row in self.definitions()}
        rows: list[dict[str, Any]] = []
        seen: set[str] = set()
        for scope, identifier in wanted:  # narrowest scope first
            row = document["assignments"].get(f"{scope}:{identifier}")
            if row is None:
                continue
            definition = definitions.get(row["definition"])
            if definition is None:
                raise ResourceDefinitionUnavailable(
                    f"Assignment {scope}:{identifier} names a definition that is no longer recorded"
                )
            if definition["name"] in seen:
                continue
            seen.add(definition["name"])
            current = (observed or {}).get(definition["name"])
            if definition["kind"] in _DIGEST_KINDS:
                state = "unobserved" if current is None else ("current" if current == definition["digest"] else "drifted")
            else:
                state = "configuration-only"
            rows.append({
                "name": definition["name"],
                "kind": definition["kind"],
                "version": definition["version"],
                "digest": definition["digest"],
                "observedDigest": current,
                "state": state,
                "scope": scope,
                "scopeId": identifier,
                "note": definition["note"],
            })
        return {
            "definitions": rows,
            "scopeOrder": list(_SCOPES),
            "note": (
                "Effective configuration is what this server reports for the scope from its own "
                "records. It is not evidence that a runtime loaded the definition, and nothing "
                "here installs or downloads an artefact."
            ),
        }


class ResourceInstallRequestLedger:
    """Requests to provision a recorded definition, and the operator's decision.

    This server does not install, download or execute an artefact, and the ledger has
    no `installed` state at all: a request ends at `approved` or `rejected`, so no code
    path here can report an installation that never happened. An approval is the
    operator's instruction to provision the recorded identity out of band, and the
    record says so.
    """

    _DECISIONS = ("approved", "rejected")
    _ID = re.compile(r"req-[0-9a-f]{16}\Z")

    def __init__(self, root: str | os.PathLike[str], *, max_requests: int = 256,
                 now: Callable[[], datetime] | None = None):
        if isinstance(max_requests, bool) or not isinstance(max_requests, int) or not 1 <= max_requests <= 4096:
            raise ValueError("max_requests must be between 1 and 4096")
        self.root = _private_directory(root, "resource install request root")
        self.path = self.root / "install-requests.json"
        self.max_requests = max_requests
        self._now = now or (lambda: datetime.now(timezone.utc))

    def _load(self) -> dict[str, Any]:
        if not self.path.exists():
            return {"version": 1, "epoch": 0, "requests": {}}
        try:
            document = json.loads(_read_private(self.path))
        except (json.JSONDecodeError, UnicodeDecodeError, OSError) as exc:
            raise ResourceDefinitionUnavailable("The request ledger is not readable JSON") from exc
        if (not isinstance(document, dict) or document.get("version") != 1
                or not isinstance(document.get("requests"), dict)):
            raise ResourceDefinitionUnavailable("The request ledger has an unsupported schema")
        if len(document["requests"]) > self.max_requests:
            raise ResourceDefinitionUnavailable("The request ledger holds more rows than permitted")
        return document

    def _save(self, document: dict[str, Any]) -> None:
        payload = json.dumps(document, sort_keys=True, separators=(",", ":")).encode()
        if len(payload) > _LEDGER_BYTES:
            raise ResourceDefinitionUnavailable("The request ledger would be larger than permitted")
        _write_private(self.path, payload)

    def request(
        self,
        *,
        definition: Any,
        reason: Any,
        requested_by: Any,
        definitions: Iterable[str] = (),
        scope: Any = None,
        scope_id: Any = None,
    ) -> dict[str, Any]:
        key = _text(definition, _NAME, "definition name")
        recorded = set(definitions)
        if key not in recorded:
            raise ResourceDefinitionUnavailable("That definition is not recorded")
        if not isinstance(reason, str) or not reason.strip() or len(reason) > 512:
            raise ValueError("reason is invalid")
        if not isinstance(requested_by, str) or not _SCOPE_ID.fullmatch(requested_by):
            raise ValueError("requested_by is invalid")
        if scope is None and scope_id is not None:
            raise ValueError("scopeId requires a scope")
        if scope is not None:
            if scope not in _SCOPES:
                raise ValueError("scope must be agent, workspace or project")
            _text(scope_id, _SCOPE_ID, "scopeId")
        document = self._load()
        if len(document["requests"]) >= self.max_requests:
            raise ResourceDefinitionUnavailable("The request ledger is full")
        request_id = "req-" + os.urandom(8).hex()
        document["requests"][request_id] = {
            "id": request_id,
            "definition": key,
            "scope": scope,
            "scopeId": scope_id,
            "reason": reason,
            "requestedBy": requested_by,
            "requestedAt": self._now().isoformat(),
            "state": "requested",
            "decidedAt": None,
            "decidedBy": None,
            "decisionNote": None,
            "installedBy": None,
            "installationPerformed": False,
        }
        document["epoch"] = int(document.get("epoch", 0)) + 1
        self._save(document)
        return dict(document["requests"][request_id])

    def decide(
        self, *, request_id: Any, decision: Any, decided_by: Any, note: Any = None,
    ) -> dict[str, Any]:
        if not isinstance(request_id, str) or not self._ID.fullmatch(request_id):
            raise ValueError("request id is invalid")
        if decision not in self._DECISIONS:
            raise ValueError("decision must be approved or rejected")
        if not isinstance(decided_by, str) or not _SCOPE_ID.fullmatch(decided_by):
            raise ValueError("decided_by is invalid")
        if note is not None and (not isinstance(note, str) or not note.strip() or len(note) > 256):
            raise ValueError("note is invalid")
        document = self._load()
        row = document["requests"].get(request_id)
        if row is None:
            raise ResourceDefinitionUnavailable("That install request is not recorded")
        if row["state"] != "requested":
            raise ResourceDefinitionUnavailable("That install request already has a decision")
        row["state"] = decision
        row["decidedAt"] = self._now().isoformat()
        row["decidedBy"] = decided_by
        row["decisionNote"] = note
        document["epoch"] = int(document.get("epoch", 0)) + 1
        self._save(document)
        return dict(row)

    def list(self, limit: int = 32) -> list[dict[str, Any]]:
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 128:
            raise ValueError("limit must be between 1 and 128")
        document = self._load()
        rows = sorted(document["requests"].values(), key=lambda row: row["requestedAt"], reverse=True)
        return [dict(row) for row in rows[:limit]]

    def status(self) -> dict[str, Any]:
        document = self._load()
        return {
            "requests": len(document["requests"]),
            "maxRequests": self.max_requests,
            "installationPerformed": False,
            "note": (
                "This server records the request and the operator's decision. It does not "
                "install, download or execute the artefact, so an approved request means "
                "'provision this recorded identity out of band', never 'installed'."
            ),
        }
