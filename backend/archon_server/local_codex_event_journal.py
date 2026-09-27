"""Private, bounded durable storage for Local Codex runner events."""

from __future__ import annotations

import json
import os
import sqlite3
import stat
import threading
from contextlib import closing
from pathlib import Path
from typing import Any


MAX_EVENT_FRAME_BYTES = 128 * 1024
MAX_EVENT_BATCH = 64
MAX_SAFE_SEQUENCE = (1 << 53) - 1
_APPLICATION_ID = 0x41524348  # "ARCH"
_SCHEMA_VERSION = 1
_TABLE_NAMES = {"journal_events", "journal_state"}


class LocalCodexEventJournalError(RuntimeError):
    """The private event journal could not be safely opened or used."""


class LocalCodexEventJournal:
    """A small SQLite event journal with monotonic sequences and bounded history.

    ``path.parent`` must be the already-created, owner-only runner journal
    directory (mode 0700). The database is created with mode 0600. Each public
    operation uses a short-lived SQLite connection so callers may use this
    object from different threads.
    """

    def __init__(
        self,
        path: Path,
        *,
        max_events: int = 256,
        max_bytes: int = 8 * 1024 * 1024,
    ) -> None:
        if isinstance(max_events, bool) or not isinstance(max_events, int) or max_events < 1:
            raise ValueError("max_events must be a positive integer.")
        if isinstance(max_bytes, bool) or not isinstance(max_bytes, int) or max_bytes < 1:
            raise ValueError("max_bytes must be a positive integer.")

        self._path = Path(path)
        self._max_events = max_events
        self._max_bytes = max_bytes
        self._lock = threading.RLock()
        self._empty_on_open = self._prepare_private_file()
        try:
            with closing(self._connect()) as connection:
                connection.execute("BEGIN IMMEDIATE")
                application_id = int(connection.execute("PRAGMA application_id").fetchone()[0])
                schema_version = int(connection.execute("PRAGMA user_version").fetchone()[0])
                table_names = {
                    str(row[0])
                    for row in connection.execute(
                        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
                    ).fetchall()
                }

                if application_id == 0 and schema_version == 0 and not table_names:
                    if not self._empty_on_open:
                        raise LocalCodexEventJournalError("Unsafe Local Codex event journal file.")
                    connection.execute(f"PRAGMA application_id={_APPLICATION_ID}")
                    connection.execute(f"PRAGMA user_version={_SCHEMA_VERSION}")
                    connection.execute(
                        "CREATE TABLE journal_state ("
                        "singleton INTEGER PRIMARY KEY CHECK (singleton = 1), "
                        "latest_seq INTEGER NOT NULL CHECK (latest_seq >= 0)"
                        ")"
                    )
                    connection.execute(
                        "INSERT INTO journal_state(singleton, latest_seq) VALUES (1, 0)"
                    )
                    connection.execute(
                        "CREATE TABLE journal_events ("
                        "seq INTEGER PRIMARY KEY CHECK (seq > 0), "
                        "event_json TEXT NOT NULL, "
                        "event_bytes INTEGER NOT NULL CHECK (event_bytes >= 0)"
                        ")"
                    )
                elif (
                    application_id != _APPLICATION_ID
                    or schema_version != _SCHEMA_VERSION
                    or table_names != _TABLE_NAMES
                    or not self._has_expected_schema(connection)
                ):
                    raise LocalCodexEventJournalError("Unsafe Local Codex event journal file.")
                else:
                    state_rows = connection.execute(
                        "SELECT COUNT(*) FROM journal_state WHERE singleton = 1"
                    ).fetchone()
                    if state_rows is None or int(state_rows[0]) != 1:
                        raise LocalCodexEventJournalError("Unsafe Local Codex event journal file.")
                self._evict_to_limits(connection)
                connection.commit()
        except LocalCodexEventJournalError:
            raise
        except (OSError, sqlite3.Error):
            raise LocalCodexEventJournalError("Local Codex event journal unavailable.") from None

    def append(self, event: dict[str, Any]) -> int:
        """Persist an event and return its durable, one-based sequence number."""
        event_json = self._encode_event(event)
        event_bytes = len(event_json.encode("utf-8"))
        if event_bytes > self._max_bytes:
            raise ValueError("Event exceeds the journal size limit.")
        if not self._fits_event_frame(event):
            raise ValueError("Event exceeds the runner frame size limit.")

        with self._lock:
            try:
                with closing(self._connect()) as connection:
                    connection.execute("BEGIN IMMEDIATE")
                    row = connection.execute(
                        "SELECT latest_seq FROM journal_state WHERE singleton = 1"
                    ).fetchone()
                    if row is None:
                        raise LocalCodexEventJournalError("Local Codex event journal unavailable.")
                    latest = int(row[0])
                    if latest >= MAX_SAFE_SEQUENCE:
                        raise ValueError("Event sequence limit reached.")
                    sequence = latest + 1
                    connection.execute(
                        "INSERT INTO journal_events(seq, event_json, event_bytes) VALUES (?, ?, ?)",
                        (sequence, event_json, event_bytes),
                    )
                    connection.execute(
                        "UPDATE journal_state SET latest_seq = ? WHERE singleton = 1",
                        (sequence,),
                    )
                    self._evict_to_limits(connection)
                    connection.commit()
                    return sequence
            except (ValueError, LocalCodexEventJournalError):
                raise
            except (OSError, sqlite3.Error):
                raise LocalCodexEventJournalError("Local Codex event journal unavailable.") from None

    def read(self, after: int, limit: int) -> dict[str, Any]:
        """Read a bounded page using the runner protocol's cursor semantics."""
        if isinstance(after, bool) or not isinstance(after, int) or not 0 <= after <= MAX_SAFE_SEQUENCE:
            raise ValueError("Invalid event cursor.")
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_EVENT_BATCH:
            raise ValueError("Invalid event limit.")

        with self._lock:
            try:
                with closing(self._connect()) as connection:
                    connection.execute("BEGIN")
                    state = connection.execute(
                        "SELECT latest_seq FROM journal_state WHERE singleton = 1"
                    ).fetchone()
                    if state is None:
                        raise LocalCodexEventJournalError("Local Codex event journal unavailable.")
                    latest = int(state[0])
                    first = connection.execute(
                        "SELECT MIN(seq) FROM journal_events"
                    ).fetchone()
                    oldest = int(first[0]) if first is not None and first[0] is not None else latest + 1
                    reset = after > latest or after < oldest - 1
                    start = latest if after > latest else after
                    rows = connection.execute(
                        "SELECT seq, event_json FROM journal_events WHERE seq > ? ORDER BY seq LIMIT ?",
                        (start, limit),
                    ).fetchall()

                    events: list[dict[str, Any]] = []
                    for sequence, event_json in rows:
                        record = {"seq": int(sequence), "event": json.loads(event_json)}
                        candidate = [*events, record]
                        cursor = record["seq"]
                        result = {
                            "cursor": cursor,
                            "latest": latest,
                            "oldest": oldest,
                            "reset": reset,
                            "events": candidate,
                        }
                        # Match the desktop runner's conservative response-size
                        # check, including its largest permitted RPC id.
                        response = {"id": "x" * 128, "ok": True, "result": result}
                        if len(self._json_bytes(response)) > MAX_EVENT_FRAME_BYTES:
                            break
                        events.append(record)

                    cursor = events[-1]["seq"] if events else start
                    connection.commit()
                    return {
                        "cursor": cursor,
                        "latest": latest,
                        "oldest": oldest,
                        "reset": reset,
                        "events": events,
                    }
            except LocalCodexEventJournalError:
                raise
            except (json.JSONDecodeError, UnicodeError):
                raise LocalCodexEventJournalError("Local Codex event journal unavailable.") from None
            except ValueError:
                raise
            except (OSError, sqlite3.Error):
                raise LocalCodexEventJournalError("Local Codex event journal unavailable.") from None

    def _prepare_private_file(self) -> bool:
        """Validate the pre-created private directory and safely create/open DB."""
        descriptor: int | None = None
        try:
            directory = os.lstat(self._path.parent)
            if (
                not stat.S_ISDIR(directory.st_mode)
                or stat.S_IMODE(directory.st_mode) != 0o700
                or directory.st_uid != os.geteuid()
            ):
                raise LocalCodexEventJournalError("Unsafe Local Codex event journal location.")

            flags = os.O_RDWR | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
            try:
                descriptor = os.open(self._path, flags | os.O_CREAT | os.O_EXCL, 0o600)
                os.fchmod(descriptor, 0o600)
                empty_on_open = True
            except FileExistsError:
                existing = os.lstat(self._path)
                if (
                    not stat.S_ISREG(existing.st_mode)
                    or stat.S_IMODE(existing.st_mode) != 0o600
                    or existing.st_uid != os.geteuid()
                    or existing.st_nlink != 1
                ):
                    raise LocalCodexEventJournalError("Unsafe Local Codex event journal file.")
                descriptor = os.open(self._path, flags)
                opened = os.fstat(descriptor)
                if (
                    not stat.S_ISREG(opened.st_mode)
                    or opened.st_dev != existing.st_dev
                    or opened.st_ino != existing.st_ino
                    or stat.S_IMODE(opened.st_mode) != 0o600
                    or opened.st_uid != os.geteuid()
                    or opened.st_nlink != 1
                ):
                    raise LocalCodexEventJournalError("Unsafe Local Codex event journal file.")
                empty_on_open = opened.st_size == 0
            return empty_on_open
        except LocalCodexEventJournalError:
            raise
        except OSError:
            raise LocalCodexEventJournalError("Unsafe Local Codex event journal location.") from None
        finally:
            if descriptor is not None:
                os.close(descriptor)

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self._path, timeout=10, isolation_level=None)
        try:
            connection.execute("PRAGMA synchronous=FULL")
            return connection
        except sqlite3.Error:
            connection.close()
            raise

    @staticmethod
    def _has_expected_schema(connection: sqlite3.Connection) -> bool:
        expected_columns = {
            "journal_state": {"singleton", "latest_seq"},
            "journal_events": {"seq", "event_json", "event_bytes"},
        }
        for table, expected in expected_columns.items():
            columns = {
                str(row[1])
                for row in connection.execute(f"PRAGMA table_info({table})").fetchall()
            }
            if columns != expected:
                return False
        return True

    def _evict_to_limits(self, connection: sqlite3.Connection) -> None:
        row = connection.execute(
            "SELECT COUNT(*), COALESCE(SUM(event_bytes), 0) FROM journal_events"
        ).fetchone()
        count, total_bytes = (int(row[0]), int(row[1])) if row is not None else (0, 0)
        while count > self._max_events or total_bytes > self._max_bytes:
            oldest = connection.execute(
                "SELECT seq, event_bytes FROM journal_events ORDER BY seq LIMIT 1"
            ).fetchone()
            if oldest is None:
                break
            connection.execute("DELETE FROM journal_events WHERE seq = ?", (int(oldest[0]),))
            count -= 1
            total_bytes -= int(oldest[1])

    @classmethod
    def _encode_event(cls, event: dict[str, Any]) -> str:
        if not isinstance(event, dict):
            raise ValueError("Event must be a JSON object.")
        try:
            encoded = json.dumps(event, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
            encoded.encode("utf-8")
            # Verify the result can be decoded as a normal JSON object, without
            # accepting custom values that serialize into a different shape.
            if not isinstance(json.loads(encoded), dict):
                raise ValueError("Event must be a JSON object.")
            return encoded
        except (TypeError, ValueError, UnicodeError):
            raise ValueError("Event must be a JSON object.") from None

    @classmethod
    def _fits_event_frame(cls, event: dict[str, Any]) -> bool:
        record = {"seq": MAX_SAFE_SEQUENCE, "event": event}
        event_frame = {"event": record}
        read_result = {
            "cursor": MAX_SAFE_SEQUENCE,
            "latest": MAX_SAFE_SEQUENCE,
            "oldest": MAX_SAFE_SEQUENCE + 1,
            "reset": False,
            "events": [record],
        }
        read_response = {"id": "x" * 128, "ok": True, "result": read_result}
        return (
            len(cls._json_bytes(event_frame)) <= MAX_EVENT_FRAME_BYTES
            and len(cls._json_bytes(read_response)) <= MAX_EVENT_FRAME_BYTES
        )

    @staticmethod
    def _json_bytes(value: Any) -> bytes:
        return json.dumps(
            value,
            ensure_ascii=False,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
