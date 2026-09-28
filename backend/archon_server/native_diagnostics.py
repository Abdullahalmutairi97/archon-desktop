"""Bounded diagnostics for unparsable or unknown native runtime records.

A native CLI can emit a record this server does not understand. Two rules apply:
an unparsable or unknown record is never treated as completion or as an outcome,
and it is reported as a bounded diagnostic instead of being dropped silently.
"""
from __future__ import annotations

from typing import Any

MAX_DIAGNOSTIC_EMISSIONS = 4
MAX_DIAGNOSTIC_DETAIL = 200


class NativeEventDiagnostics:
    """Count unparsable and unknown native records, and report a bounded sample."""

    def __init__(self, runtime: str, *, max_emissions: int = MAX_DIAGNOSTIC_EMISSIONS):
        self.runtime = runtime
        self.max_emissions = max_emissions
        self.malformed = 0
        self.unknown = 0
        self._emitted = 0
        self._reported_types: set[str] = set()

    @property
    def total(self) -> int:
        return self.malformed + self.unknown

    def _bounded(self, detail: str) -> str:
        text = " ".join(str(detail).split())
        if len(text) > MAX_DIAGNOSTIC_DETAIL:
            return text[: MAX_DIAGNOSTIC_DETAIL - 3] + "..."
        return text

    def _emit_or_skip(self) -> bool:
        if self._emitted >= self.max_emissions:
            return False
        self._emitted += 1
        return True

    def note_malformed(self, detail: str) -> dict[str, Any] | None:
        """Count one unparsable record and return the bounded diagnostic, if any."""
        self.malformed += 1
        if not self._emit_or_skip():
            return None
        return {
            "kind": "malformed_record",
            "runtime": self.runtime,
            "detail": self._bounded(detail),
            "malformed": self.malformed,
            "unknown": self.unknown,
        }

    def note_unknown(self, event_type: Any) -> dict[str, Any] | None:
        """Count one unhandled record type and return the bounded diagnostic, if any."""
        self.unknown += 1
        name = event_type if isinstance(event_type, str) and event_type else "untyped"
        # Report each distinct unhandled type once, and only within the bound.
        if name in self._reported_types or not self._emit_or_skip():
            return None
        self._reported_types.add(name)
        return {
            "kind": "unknown_event_type",
            "runtime": self.runtime,
            "detail": self._bounded(f"unhandled native record type: {name}"),
            "malformed": self.malformed,
            "unknown": self.unknown,
        }
