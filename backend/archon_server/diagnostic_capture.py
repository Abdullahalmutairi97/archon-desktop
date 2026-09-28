"""Bounded, redacted, expiring capture of runtime diagnostics.

A native runtime can emit records this server cannot read, and an operator needs to
see that without the server becoming a place where credentials accumulate. This
module stores only the bounded diagnostic records the runners already produce
(kinds, counts and short shape descriptions), never raw process output, and it:

* redacts anything that looks like a credential assignment or a bearer token before
  the record is written, because the detail text can carry a runtime's own text,
* caps each record and the whole ledger, and refuses to load a ledger that does not
  match its schema, an unsafe mode or an unexpected owner,
* expires every record after a TTL, pruned on read and on write,
* and reports `rawCapture: false` so a client never assumes full output is stored.

Raw output capture is deliberately not implemented: there is no reliable way to
prove that an arbitrary runtime's stdout or stderr excludes credentials, and the
roadmap rule is to disable raw capture when it cannot be excluded.
"""
from __future__ import annotations

import json
import os
import re
import stat
import uuid
from collections import deque
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

_MAX_ENTRIES = 64
_MAX_ENTRY_CHARS = 512
_MAX_LEDGER_BYTES = 256 * 1024
_MIN_TTL_SECONDS = 60
_MAX_TTL_SECONDS = 30 * 24 * 3600
_ALLOWED_KINDS = frozenset({"malformed_record", "unknown_event_type", "runner_error", "other"})

_SECRET_ASSIGNMENT = re.compile(
    r"(?i)\b(token|api[_-]?key|authorization|password|secret)\b\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+"
)
_BEARER = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+")
_LONG_TOKEN = re.compile(r"\b[A-Za-z0-9_-]{32,}\b")
# Heuristic: a credential-shaped word followed by a long opaque value, with or
# without a separator. Over-redaction in a diagnostic record is acceptable; leaking
# is not, and the rule is documented as a heuristic rather than a guarantee.
_KEY_VALUE = re.compile(
    r"(?i)\b(key|token|secret|password|authorization|apikey|api_key)\b\s*[:=]?\s*([A-Za-z0-9._~+/=-]{16,})"
)
_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")
_IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,199}\Z")


class DiagnosticCaptureError(RuntimeError):
    """Base error for diagnostic capture."""


class DiagnosticCaptureUnavailable(DiagnosticCaptureError):
    """The capture ledger is missing, unsafe, malformed or oversized."""


def redact(text: Any, *, limit: int = _MAX_ENTRY_CHARS) -> str:
    """Return bounded, control-free text with credential-shaped spans removed."""
    value = str(text if text is not None else "")
    value = _SECRET_ASSIGNMENT.sub(lambda match: f"{match.group(1)}=[REDACTED]", value)
    value = _BEARER.sub("Bearer [REDACTED]", value)
    value = _KEY_VALUE.sub(lambda match: f"{match.group(1)}=[REDACTED]", value)
    value = _LONG_TOKEN.sub("[REDACTED]", value)
    value = _CONTROL.sub(" ", value)
    collapsed = " ".join(value.split())
    if len(collapsed) > limit:
        return collapsed[: max(limit - 3, 0)] + "..."
    return collapsed


def _private_root(root: str | os.PathLike[str]) -> Path:
    directory = Path(root)
    if not directory.is_absolute():
        raise ValueError("diagnostic capture root must be an absolute server-owned path")
    was_present = directory.exists() or directory.is_symlink()
    directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    info = directory.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid()
            or (was_present and stat.S_IMODE(info.st_mode) != 0o700)
            or stat.S_IMODE(info.st_mode) & 0o077):
        raise DiagnosticCaptureUnavailable("capture root must be a private directory owned by this user")
    return directory.absolute()


class DiagnosticCapture:
    """Store bounded diagnostic records with a TTL and a hard ledger cap."""

    def __init__(
        self,
        root: str | os.PathLike[str],
        *,
        max_entries: int = _MAX_ENTRIES,
        ttl_seconds: int = 24 * 3600,
        now: Callable[[], datetime] | None = None,
    ):
        if isinstance(max_entries, bool) or not isinstance(max_entries, int) or not 1 <= max_entries <= 512:
            raise ValueError("max_entries must be between 1 and 512")
        if (isinstance(ttl_seconds, bool) or not isinstance(ttl_seconds, int)
                or not _MIN_TTL_SECONDS <= ttl_seconds <= _MAX_TTL_SECONDS):
            raise ValueError("ttl_seconds must be between 60 and 2592000")
        self._root = _private_root(root)
        self._path = self._root / "diagnostics.json"
        self._max_entries = max_entries
        self._ttl = ttl_seconds
        self._now = now or (lambda: datetime.now(timezone.utc))

    # -- writes -------------------------------------------------------------

    def record(
        self,
        *,
        kind: Any,
        detail: Any,
        task_id: Any = None,
        attempt_id: Any = None,
        runtime: Any = None,
    ) -> dict[str, Any] | None:
        """Store one diagnostic record, or return None when it cannot be bounded."""
        safe_kind = kind if isinstance(kind, str) and kind in _ALLOWED_KINDS else "other"
        text = redact(detail)
        if not text:
            return None
        entry = {
            "recordedAt": self._now().astimezone(timezone.utc).isoformat(),
            "expiresAt": (self._now() + timedelta(seconds=self._ttl)).astimezone(timezone.utc).isoformat(),
            "kind": safe_kind,
            "detail": text,
            "taskId": self._identifier(task_id),
            "attemptId": self._identifier(attempt_id),
            "runtime": self._identifier(runtime),
        }
        document = self._load()
        entries = document["entries"]
        entries.append(entry)
        if len(entries) > self._max_entries:
            del entries[: len(entries) - self._max_entries]
        document["entries"] = entries
        self._save(document)
        return dict(entry)

    def record_mapping(self, row: Any) -> None:
        """Adapt a runner event mapping to `record`, ignoring unknown keys.

        The task engine hands the sink one mapping; keeping the adapter here means
        the engine does not need to know this module's keyword contract.
        """
        if not isinstance(row, dict):
            return
        self.record(
            kind=row.get("kind"),
            detail=row.get("detail"),
            task_id=row.get("task_id"),
            attempt_id=row.get("attempt_id"),
            runtime=row.get("runtime"),
        )

    def clear(self) -> int:
        document = self._load()
        removed = len(document["entries"])
        document["entries"] = []
        self._save(document)
        return removed

    # -- reads --------------------------------------------------------------

    def list(self, limit: int = 32) -> list[dict[str, Any]]:
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= self._max_entries:
            raise ValueError("limit is invalid")
        document = self._load()
        rows = [dict(row) for row in reversed(document["entries"])][:limit]
        return rows

    def status(self) -> dict[str, Any]:
        document = self._load()
        return {
            "entryCount": len(document["entries"]),
            "maxEntries": self._max_entries,
            "ttlSeconds": self._ttl,
            "maxEntryChars": _MAX_ENTRY_CHARS,
            "rawCapture": False,
            "note": (
                "Only bounded diagnostic records are stored, never raw process output: a "
                "runtime's text cannot be proven free of credentials, so raw capture stays "
                "disabled."
            ),
        }

    # -- internals ----------------------------------------------------------

    @staticmethod
    def _identifier(value: Any) -> str | None:
        """Accept a bounded identifier, or drop it.

        The charset check runs on the raw value: a task id can be a long hex uuid,
        which the redaction heuristic would otherwise treat as an opaque token.
        Identifiers come from this server's own task/attempt records and runtime
        names, and the charset excludes anything that could carry a credential.
        """
        if isinstance(value, str) and _IDENTIFIER.fullmatch(value):
            return value
        return None

    def _empty(self) -> dict[str, Any]:
        return {"version": 1, "entries": []}

    def _prune(self, document: dict[str, Any]) -> None:
        now = self._now().astimezone(timezone.utc)
        kept = []
        for row in document["entries"]:
            try:
                expires = datetime.fromisoformat(str(row["expiresAt"]))
            except (KeyError, ValueError):
                continue
            if expires.tzinfo is None:
                expires = expires.replace(tzinfo=timezone.utc)
            if expires > now:
                kept.append(row)
        document["entries"] = kept[-self._max_entries:]

    def _load(self) -> dict[str, Any]:
        try:
            descriptor = os.open(
                self._path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
            )
        except FileNotFoundError:
            return self._empty()
        except OSError as exc:
            raise DiagnosticCaptureUnavailable("capture ledger cannot be opened safely") from exc
        try:
            info = os.fstat(descriptor)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                    or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > _MAX_LEDGER_BYTES):
                raise DiagnosticCaptureUnavailable("capture ledger is unsafe or oversized")
            payload = os.read(descriptor, _MAX_LEDGER_BYTES + 1)
        finally:
            os.close(descriptor)
        if len(payload) > _MAX_LEDGER_BYTES:
            raise DiagnosticCaptureUnavailable("capture ledger is oversized")
        try:
            data = json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise DiagnosticCaptureUnavailable("capture ledger is malformed") from exc
        if not isinstance(data, dict) or set(data) != {"version", "entries"} or data["version"] != 1:
            raise DiagnosticCaptureUnavailable("capture ledger has an unsupported schema")
        entries = data["entries"]
        if not isinstance(entries, list) or len(entries) > self._max_entries:
            raise DiagnosticCaptureUnavailable("capture ledger has too many entries")
        for row in entries:
            if (not isinstance(row, dict)
                    or set(row) != {"recordedAt", "expiresAt", "kind", "detail", "taskId", "attemptId", "runtime"}
                    or row["kind"] not in _ALLOWED_KINDS
                    or not isinstance(row["detail"], str) or len(row["detail"]) > _MAX_ENTRY_CHARS
                    or not isinstance(row["recordedAt"], str) or not isinstance(row["expiresAt"], str)
                    or any(row[key] is not None and not isinstance(row[key], str)
                           for key in ("taskId", "attemptId", "runtime"))):
                raise DiagnosticCaptureUnavailable("capture ledger contains an invalid entry")
        self._prune(data)
        return data

    def _save(self, document: dict[str, Any]) -> None:
        self._prune(document)
        if len(document["entries"]) > self._max_entries:
            raise DiagnosticCaptureError("capture ledger limit reached")
        payload = json.dumps(document, separators=(",", ":"), sort_keys=True).encode("utf-8")
        if len(payload) > _MAX_LEDGER_BYTES:
            raise DiagnosticCaptureError("capture ledger limit reached")
        temporary = self._root / ("." + uuid.uuid4().hex + ".diagnostics.tmp")
        descriptor = -1
        try:
            descriptor = os.open(
                temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0), 0o600
            )
            view = memoryview(payload)
            while view:
                written = os.write(descriptor, view)
                if written <= 0:
                    raise OSError("short capture ledger write")
                view = view[written:]
            os.fsync(descriptor)
            os.close(descriptor)
            descriptor = -1
            os.replace(temporary, self._path)
        except OSError as exc:
            raise DiagnosticCaptureUnavailable("capture ledger could not be persisted") from exc
        finally:
            if descriptor >= 0:
                os.close(descriptor)
            temporary.unlink(missing_ok=True)
