"""Hard policy precedence: a narrower scope may never widen a denial.

Policy entries are (scope, scopeId, capability) -> allow | deny, evaluated broad to
narrow over one fixed chain: `global` (the hard policy) > `project` > `workspace` >
`agent`. The rule is a deny floor:

* any matching `deny` in the chain decides, whatever the narrower scopes say;
* otherwise a matching `allow` decides;
* otherwise the capability is `unset`, and the caller keeps its own default.

So an override can only narrow. A narrower `allow` cannot re-open what a broader
scope denied, and an absent entry never means allowed. Every decision reports which
scope decided it, so precedence is inspectable instead of implied.
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

# Broad to narrow. The hard policy is first and cannot be overridden.
SCOPE_ORDER = ("global", "project", "workspace", "agent")
_CAPABILITY = re.compile(r"[a-z][a-z0-9._:-]{0,127}\Z")
# `*` is the sentinel id for the global scope; other scopes use a real identifier.
_SCOPE_ID = re.compile(r"[A-Za-z0-9_.:\-*]{1,128}\Z")
_EFFECTS = ("allow", "deny")
_MAX_ENTRIES = 512
_LEDGER_BYTES = 256 * 1024


class PolicyError(RuntimeError):
    """Base error for policy storage and evaluation."""


class PolicyUnavailable(PolicyError):
    """The policy ledger is unsafe, malformed, too large or missing a row."""


def _private_directory(path: str | os.PathLike[str], label: str) -> Path:
    root = Path(path).expanduser()
    if not root.is_absolute():
        raise ValueError(f"{label} must be an absolute path")
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = os.lstat(root)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise PolicyUnavailable(f"{label} must be a directory, not a link")
    if info.st_uid != os.geteuid():
        raise PolicyUnavailable(f"{label} must be owned by this account")
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


_SEPARATORS = (".", ":", "-", "_")


def capability_token(value: Any) -> str:
    """Turn an external name into one capability token.

    A capability is a dotted name (`secret.tool.send`, `secret.reference.example_api`,
    `files.write`). A name from outside - a tool name, for example - is lower-cased and
    any character that is not part of a token becomes `-`, so a pattern can never be
    defeated by an unexpected character in a name.
    """
    if not isinstance(value, str) or not value:
        raise ValueError("capability part is invalid")
    token = re.sub(r"[^a-z0-9._:-]+", "-", value.strip().lower())[:64].strip("-.")
    if not token:
        raise ValueError("capability part is invalid")
    return token


def matches(capability: str, pattern: str) -> bool:
    """Match exactly, or as a subtree wildcard ending in `*`.

    `secret:*` covers `secret.tool.send` and `secret.reference.example_api`, and never
    `secrets.write`, because the token before the wildcard must end at a separator.
    """
    if pattern == capability:
        return True
    if not pattern.endswith("*") or len(pattern) < 2:
        return False
    stem = pattern[:-1]
    while stem and stem[-1] in _SEPARATORS:
        stem = stem[:-1]
    if not stem:
        return True
    return any(capability.startswith(stem + separator) for separator in _SEPARATORS)


class PolicyLedger:
    """Owner-managed policy entries, evaluated with a deny floor."""

    def __init__(self, root: str | os.PathLike[str], *, now: Callable[[], datetime] | None = None):
        self.root = _private_directory(root, "policy root")
        self.path = self.root / "policy.json"
        self._now = now or (lambda: datetime.now(timezone.utc))

    def _load(self) -> dict[str, Any]:
        if not self.path.exists():
            return {"version": 1, "epoch": 0, "entries": []}
        try:
            info = os.lstat(self.path)
        except OSError as exc:
            raise PolicyUnavailable("The policy ledger is missing") from exc
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
            raise PolicyUnavailable("The policy ledger must be a regular file, not a link")
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077:
            raise PolicyUnavailable("The policy ledger is not private to this account")
        if info.st_size > _LEDGER_BYTES:
            raise PolicyUnavailable("The policy ledger is larger than the permitted bound")
        try:
            document = json.loads(self.path.read_bytes())
        except (json.JSONDecodeError, UnicodeDecodeError, OSError) as exc:
            raise PolicyUnavailable("The policy ledger is not readable JSON") from exc
        if not isinstance(document, dict) or document.get("version") != 1 or not isinstance(document.get("entries"), list):
            raise PolicyUnavailable("The policy ledger has an unsupported schema")
        if len(document["entries"]) > _MAX_ENTRIES:
            raise PolicyUnavailable("The policy ledger holds more entries than permitted")
        return document

    def _save(self, document: dict[str, Any]) -> None:
        payload = json.dumps(document, sort_keys=True, separators=(",", ":")).encode()
        if len(payload) > _LEDGER_BYTES:
            raise PolicyUnavailable("The policy ledger would be larger than permitted")
        _write_private(self.path, payload)

    def set(
        self,
        *,
        scope: Any,
        scope_id: Any,
        capability: Any,
        effect: Any,
        note: Any = None,
    ) -> dict[str, Any]:
        """Record one entry, replacing the same (scope, scopeId, capability)."""
        if scope not in SCOPE_ORDER:
            raise ValueError("scope must be global, project, workspace or agent")
        if not isinstance(scope_id, str) or not _SCOPE_ID.fullmatch(scope_id):
            raise ValueError("scopeId is invalid")
        if not isinstance(capability, str) or not _CAPABILITY.fullmatch(capability[:-1] if capability.endswith("*") else capability):
            raise ValueError("capability is invalid")
        if effect not in _EFFECTS:
            raise ValueError("effect must be allow or deny")
        if note is not None and (not isinstance(note, str) or not note.strip() or len(note) > 256):
            raise ValueError("note is invalid")
        document = self._load()
        entry = {
            "scope": scope, "scopeId": scope_id, "capability": capability,
            "effect": effect, "note": note, "recordedAt": self._now().isoformat(),
        }
        document["entries"] = [
            row for row in document["entries"]
            if not (row.get("scope") == scope and row.get("scopeId") == scope_id
                    and row.get("capability") == capability)
        ]
        document["entries"].append(entry)
        if len(document["entries"]) > _MAX_ENTRIES:
            raise PolicyUnavailable("The policy ledger holds more entries than permitted")
        document["epoch"] = int(document.get("epoch", 0)) + 1
        self._save(document)
        return dict(entry)

    def remove(self, *, scope: Any, scope_id: Any, capability: Any) -> None:
        if scope not in SCOPE_ORDER:
            raise ValueError("scope must be global, project, workspace or agent")
        if not isinstance(scope_id, str) or not _SCOPE_ID.fullmatch(scope_id):
            raise ValueError("scopeId is invalid")
        if not isinstance(capability, str) or not _CAPABILITY.fullmatch(capability[:-1] if capability.endswith("*") else capability):
            raise ValueError("capability is invalid")
        document = self._load()
        before = len(document["entries"])
        document["entries"] = [
            row for row in document["entries"]
            if not (row.get("scope") == scope and row.get("scopeId") == scope_id
                    and row.get("capability") == capability)
        ]
        if len(document["entries"]) == before:
            raise PolicyUnavailable("That policy entry is not recorded")
        document["epoch"] = int(document.get("epoch", 0)) + 1
        self._save(document)

    def entries(self) -> list[dict[str, Any]]:
        document = self._load()
        return [dict(row) for row in document["entries"]]

    def chain(self, *, project: str | None = None, workspace: str | None = None,
              agent: str | None = None) -> list[tuple[str, str]]:
        """The scope chain to evaluate, broad to narrow, for the identifiers given."""
        chain: list[tuple[str, str]] = [("global", "*")]
        for scope, identifier in (("project", project), ("workspace", workspace), ("agent", agent)):
            if identifier is None:
                continue
            if not isinstance(identifier, str) or not _SCOPE_ID.fullmatch(identifier):
                raise ValueError(f"{scope} is invalid")
            chain.append((scope, identifier))
        return chain

    def effective(
        self,
        *,
        capability: str,
        project: str | None = None,
        workspace: str | None = None,
        agent: str | None = None,
    ) -> dict[str, Any]:
        """Decide one capability for one scope chain. Any deny in the chain wins."""
        if not isinstance(capability, str) or not _CAPABILITY.fullmatch(capability):
            raise ValueError("capability is invalid")
        chain = self.chain(project=project, workspace=workspace, agent=agent)
        document = self._load()
        decided: list[dict[str, Any]] = []
        for index, (scope, scope_id) in enumerate(chain):
            for row in document["entries"]:
                if row.get("scope") != scope or row.get("scopeId") != scope_id:
                    continue
                if not isinstance(row.get("capability"), str) or not matches(capability, row["capability"]):
                    continue
                decided.append({**dict(row), "order": index})
        denials = [row for row in decided if row.get("effect") == "deny"]
        allows = [row for row in decided if row.get("effect") == "allow"]
        if denials:
            # The broadest denial is the floor: it explains the decision because no
            # narrower scope could have overridden it.
            deciding = sorted(denials, key=lambda row: row["order"])[0]
            decision = "deny"
            ignored = len(allows) + len(denials) - 1
            reason = (
                f"denied by {deciding['scope']}:{deciding['scopeId']} ({deciding['capability']}); "
                "a narrower scope cannot widen a denial"
            )
            if ignored:
                reason += f" ({ignored} narrower or broader matching entr{'y' if ignored == 1 else 'ies'} did not change it)"
        elif allows:
            deciding = sorted(allows, key=lambda row: row["order"])[-1]
            decision = "allow"
            reason = f"allowed by {deciding['scope']}:{deciding['scopeId']} ({deciding['capability']})"
        else:
            deciding = None
            decision = "unset"
            reason = "no entry matches this capability in the chain, so the caller's own default applies"
        return {
            "capability": capability,
            "decision": decision,
            "reason": reason,
            "decidingEntry": {
                "scope": deciding["scope"], "scopeId": deciding["scopeId"],
                "capability": deciding["capability"], "effect": deciding["effect"],
            } if deciding else None,
            "chain": [{"scope": scope, "scopeId": scope_id} for scope, scope_id in chain],
            "matches": [
                {"scope": row["scope"], "scopeId": row["scopeId"], "capability": row["capability"],
                 "effect": row["effect"]}
                for row in sorted(decided, key=lambda row: row["order"])
            ],
            "note": (
                "A deny in the chain decides, so project, workspace and agent overrides can only "
                "narrow the hard policy. unset means no entry applies; it is not an allow."
            ),
        }

    def require(self, *, capability: str, **scopes: Any) -> dict[str, Any] | None:
        """Return the decision when policy forbids the capability, else None."""
        decision = self.effective(capability=capability, **scopes)
        return decision if decision["decision"] == "deny" else None

    def status(self) -> dict[str, Any]:
        document = self._load()
        return {
            "entries": len(document["entries"]),
            "maxEntries": _MAX_ENTRIES,
            "epoch": int(document.get("epoch", 0)),
            "scopeOrder": list(SCOPE_ORDER),
            "note": "Any deny in the chain decides; narrower scopes can only narrow.",
        }
