"""Private, bounded durable storage for Local Codex runner events."""

from __future__ import annotations

import json
import os
import re
import sqlite3
import stat
import threading
import time
from contextlib import closing
from pathlib import Path
from typing import Any


MAX_EVENT_FRAME_BYTES = 128 * 1024
MAX_EVENT_BATCH = 64
MAX_SAFE_SEQUENCE = (1 << 53) - 1
MAX_PROVISIONAL_TURNS = 256
_APPLICATION_ID = 0x41524348  # "ARCH"
_SCHEMA_VERSION = 2
_V1_TABLE_NAMES = {"journal_events", "journal_state"}
_TABLE_NAMES = {*_V1_TABLE_NAMES, "local_turns"}
_LOCAL_TASK_ID = re.compile(r"^codex-task:[A-Za-z0-9._:-]{1,245}$")
_LOCAL_PROJECT_ID = re.compile(r"^codex-project:[A-Za-z0-9._:-]{1,242}$")
_LOCAL_SESSION_ID = re.compile(r"^codex:[A-Za-z0-9._:-]{1,250}$")
_TERMINAL_EVENT_STATES = {
    "turn.completed": "completed",
    "turn.failed": "failed",
    "turn.cancelled": "cancelled",
}


class LocalCodexEventJournalError(RuntimeError):
    """The private event journal could not be safely opened or used."""


class LocalCodexProvisionalOverflow(LocalCodexEventJournalError):
    """Too many terminal events arrived while start acknowledgements were pending."""


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
                    connection.execute("PRAGMA user_version=1")
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
                    self._migrate_v1_to_v2(connection)
                    schema_version = _SCHEMA_VERSION
                    table_names = set(_TABLE_NAMES)
                elif (
                    application_id == _APPLICATION_ID
                    and schema_version == 1
                    and table_names == _V1_TABLE_NAMES
                    and self._has_expected_schema(connection, 1)
                    and self._has_singleton_state(connection)
                ):
                    self._migrate_v1_to_v2(connection)
                    schema_version = _SCHEMA_VERSION
                    table_names = set(_TABLE_NAMES)
                elif (
                    application_id != _APPLICATION_ID
                    or schema_version != _SCHEMA_VERSION
                    or table_names != _TABLE_NAMES
                    or not self._has_expected_schema(connection, _SCHEMA_VERSION)
                ):
                    raise LocalCodexEventJournalError("Unsafe Local Codex event journal file.")
                else:
                    if not self._has_singleton_state(connection):
                        raise LocalCodexEventJournalError("Unsafe Local Codex event journal file.")
                self._evict_to_limits(connection)
                connection.commit()
        except LocalCodexEventJournalError:
            raise
        except (OSError, sqlite3.Error):
            raise LocalCodexEventJournalError("Local Codex event journal unavailable.") from None

    def append(self, event: dict[str, Any], *, provisional_terminal: bool = False) -> int:
        """Persist an event and return its durable, one-based sequence number."""
        if not isinstance(provisional_terminal, bool):
            raise ValueError("provisional_terminal must be a boolean.")
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
                    self._record_terminal_event(connection, event, sequence, provisional_terminal)
                    self._evict_to_limits(connection)
                    connection.commit()
                    return sequence
            except (ValueError, LocalCodexEventJournalError):
                raise
            except (OSError, sqlite3.Error):
                raise LocalCodexEventJournalError("Local Codex event journal unavailable.") from None

    def record_accepted_start(self, turn: dict[str, Any]) -> dict[str, Any]:
        """Durably bind the identity returned by an acknowledged startTurn.

        Only identity and lifecycle metadata are retained; the prompt and all
        other request or response fields are deliberately ignored.
        """
        identity = self._validated_start_identity(turn)
        now = int(time.time())
        with self._lock:
            try:
                with closing(self._connect()) as connection:
                    connection.execute("BEGIN IMMEDIATE")
                    existing = connection.execute(
                        "SELECT project_id, session_id FROM local_turns WHERE task_id = ?",
                        (identity["taskId"],),
                    ).fetchone()
                    if existing is not None and (
                        (existing[0] is not None and existing[0] != identity["projectId"])
                        or (existing[1] is not None and existing[1] != identity["sessionId"])
                    ):
                        raise LocalCodexEventJournalError("Conflicting Local Codex turn identity.")
                    connection.execute(
                        "INSERT INTO local_turns "
                        "(task_id, project_id, session_id, status, accepted, created_at, updated_at) "
                        "VALUES (?, ?, ?, 'running', 1, ?, ?) "
                        "ON CONFLICT(task_id) DO UPDATE SET "
                        "project_id=excluded.project_id, session_id=excluded.session_id, accepted=1, "
                        "status=CASE WHEN local_turns.status IN ('completed','failed','cancelled') "
                        "THEN local_turns.status WHEN local_turns.status='outcome_unknown' "
                        "THEN local_turns.status ELSE 'running' END, updated_at=excluded.updated_at",
                        (
                            identity["taskId"], identity["projectId"], identity["sessionId"], now, now,
                        ),
                    )
                    record = self._read_turn(connection, identity["taskId"], accepted_only=True)
                    connection.commit()
                    if record is None:
                        raise LocalCodexEventJournalError("Local Codex turn status unavailable.")
                    return record
            except LocalCodexEventJournalError:
                raise
            except (OSError, sqlite3.Error):
                raise LocalCodexEventJournalError("Local Codex event journal unavailable.") from None

    def reconcile_startup(self) -> int:
        """Prune pre-ack provisional rows and mark active turns unknown after owned restart."""
        now = int(time.time())
        with self._lock:
            try:
                with closing(self._connect()) as connection:
                    connection.execute("BEGIN IMMEDIATE")
                    connection.execute("DELETE FROM local_turns WHERE accepted=0")
                    cursor = connection.execute(
                        "UPDATE local_turns SET status='outcome_unknown', updated_at=? "
                        "WHERE accepted=1 AND status='running'",
                        (now,),
                    )
                    changed = cursor.rowcount
                    connection.commit()
                    return changed
            except (OSError, sqlite3.Error):
                raise LocalCodexEventJournalError("Local Codex event journal unavailable.") from None

    def read_latest_turns(self, limit: int) -> list[dict[str, Any]]:
        """Read accepted turns newest by durable row insertion.

        A terminal event received before its start acknowledgement creates the
        row first, so that rare turn is ordered by its first observed terminal
        event rather than by the later acknowledgement.
        """
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 16:
            raise ValueError("Invalid Local Codex turn status limit.")
        with self._lock:
            try:
                with closing(self._connect()) as connection:
                    connection.execute("BEGIN")
                    rows = connection.execute(
                        "SELECT task_id, project_id, session_id, status FROM local_turns "
                        "WHERE accepted=1 ORDER BY rowid DESC LIMIT ?",
                        (limit,),
                    ).fetchall()
                    records = []
                    for row in rows:
                        if row[1] is None or row[2] is None:
                            raise LocalCodexEventJournalError("Local Codex turn status unavailable.")
                        records.append({
                            "taskId": str(row[0]),
                            "projectId": str(row[1]),
                            "sessionId": str(row[2]),
                            "state": str(row[3]),
                        })
                    connection.commit()
                    return records
            except LocalCodexEventJournalError:
                raise
            except (OSError, sqlite3.Error):
                raise LocalCodexEventJournalError("Local Codex event journal unavailable.") from None

    def mark_turns_outcome_unknown(self, task_ids: Any) -> int:
        """Mark the supplied accepted, nonterminal turns unknown after worker retirement."""
        if isinstance(task_ids, (str, bytes)):
            raise ValueError("task_ids must be a collection of task identities.")
        try:
            identifiers = tuple(dict.fromkeys(task_ids))
        except TypeError:
            raise ValueError("task_ids must be a collection of task identities.") from None
        if any(not isinstance(task_id, str) or not _LOCAL_TASK_ID.fullmatch(task_id) for task_id in identifiers):
            raise ValueError("Invalid Local Codex task identity.")
        if not identifiers:
            return 0
        now = int(time.time())
        changed = 0
        with self._lock:
            try:
                with closing(self._connect()) as connection:
                    connection.execute("BEGIN IMMEDIATE")
                    # Stay well below SQLite builds with the traditional 999
                    # bound-parameter limit while keeping one durable transaction.
                    for offset in range(0, len(identifiers), 500):
                        page = identifiers[offset:offset + 500]
                        placeholders = ",".join("?" for _ in page)
                        cursor = connection.execute(
                            "UPDATE local_turns SET status='outcome_unknown', updated_at=? "
                            f"WHERE accepted=1 AND status='running' AND task_id IN ({placeholders})",
                            (now, *page),
                        )
                        changed += cursor.rowcount
                    connection.commit()
                    return changed
            except (OSError, sqlite3.Error):
                raise LocalCodexEventJournalError("Local Codex event journal unavailable.") from None

    def read_turn(self, task_id: str) -> dict[str, Any] | None:
        """Return one accepted turn's safe status projection, if retained."""
        if not isinstance(task_id, str) or not _LOCAL_TASK_ID.fullmatch(task_id):
            raise ValueError("Invalid Local Codex task identity.")
        with self._lock:
            try:
                with closing(self._connect()) as connection:
                    connection.execute("BEGIN")
                    record = self._read_turn(connection, task_id, accepted_only=True)
                    connection.commit()
                    return record
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
    def _has_expected_schema(connection: sqlite3.Connection, version: int) -> bool:
        expected_columns = {
            "journal_state": {"singleton", "latest_seq"},
            "journal_events": {"seq", "event_json", "event_bytes"},
        }
        if version == 2:
            expected_columns["local_turns"] = {
                "task_id", "project_id", "session_id", "status", "accepted",
                "created_at", "updated_at", "terminal_event_seq",
            }
        for table, expected in expected_columns.items():
            columns = {
                str(row[1])
                for row in connection.execute(f"PRAGMA table_info({table})").fetchall()
            }
            if columns != expected:
                return False
        return True

    @staticmethod
    def _has_singleton_state(connection: sqlite3.Connection) -> bool:
        row = connection.execute(
            "SELECT COUNT(*) FROM journal_state WHERE singleton = 1"
        ).fetchone()
        return row is not None and int(row[0]) == 1

    @staticmethod
    def _migrate_v1_to_v2(connection: sqlite3.Connection) -> None:
        connection.execute(
            "CREATE TABLE local_turns ("
            "task_id TEXT PRIMARY KEY, "
            "project_id TEXT, "
            "session_id TEXT, "
            "status TEXT NOT NULL CHECK (status IN "
            "('running','completed','failed','cancelled','outcome_unknown')), "
            "accepted INTEGER NOT NULL CHECK (accepted IN (0, 1)), "
            "created_at INTEGER NOT NULL, "
            "updated_at INTEGER NOT NULL, "
            "terminal_event_seq INTEGER CHECK (terminal_event_seq IS NULL OR terminal_event_seq > 0), "
            "CHECK (accepted = 0 OR (project_id IS NOT NULL AND session_id IS NOT NULL))"
            ")"
        )
        connection.execute(f"PRAGMA user_version={_SCHEMA_VERSION}")

    @staticmethod
    def _validated_start_identity(turn: Any) -> dict[str, str]:
        if not isinstance(turn, dict) or set(turn) != {"taskId", "projectId", "sessionId", "state"}:
            raise ValueError("Invalid Local Codex start acknowledgement.")
        if (
            not isinstance(turn.get("taskId"), str)
            or not _LOCAL_TASK_ID.fullmatch(turn["taskId"])
            or not isinstance(turn.get("projectId"), str)
            or not _LOCAL_PROJECT_ID.fullmatch(turn["projectId"])
            or not isinstance(turn.get("sessionId"), str)
            or not _LOCAL_SESSION_ID.fullmatch(turn["sessionId"])
            or turn.get("state") != "running"
        ):
            raise ValueError("Invalid Local Codex start acknowledgement.")
        return {
            "taskId": turn["taskId"],
            "projectId": turn["projectId"],
            "sessionId": turn["sessionId"],
        }

    @staticmethod
    def _read_turn(
        connection: sqlite3.Connection,
        task_id: str,
        *,
        accepted_only: bool,
    ) -> dict[str, Any] | None:
        query = (
            "SELECT task_id, project_id, session_id, status "
            "FROM local_turns WHERE task_id = ?"
        )
        if accepted_only:
            query += " AND accepted = 1"
        row = connection.execute(query, (task_id,)).fetchone()
        if row is None:
            return None
        if row[1] is None or row[2] is None:
            raise LocalCodexEventJournalError("Local Codex turn status unavailable.")
        return {
            "taskId": str(row[0]),
            "projectId": str(row[1]),
            "sessionId": str(row[2]),
            "state": str(row[3]),
        }

    @staticmethod
    def _record_terminal_event(
        connection: sqlite3.Connection,
        event: dict[str, Any],
        sequence: int,
        provisional_terminal: bool,
    ) -> None:
        state = _TERMINAL_EVENT_STATES.get(event.get("type"))
        task_id = event.get("taskId")
        if state is None or not isinstance(task_id, str) or not _LOCAL_TASK_ID.fullmatch(task_id):
            return
        now = int(time.time())
        if provisional_terminal:
            existing = connection.execute(
                "SELECT accepted FROM local_turns WHERE task_id=?", (task_id,)
            ).fetchone()
            if existing is None:
                count = connection.execute(
                    "SELECT COUNT(*) FROM local_turns WHERE accepted=0"
                ).fetchone()
                if count is None or int(count[0]) >= MAX_PROVISIONAL_TURNS:
                    # Roll back the event append too. The worker will retire,
                    # causing pending starts to return outcome_unknown instead
                    # of acknowledging without durable terminal correlation.
                    raise LocalCodexProvisionalOverflow(
                        "Local Codex provisional turn status capacity reached."
                    )
                connection.execute(
                    "INSERT INTO local_turns "
                    "(task_id, status, accepted, created_at, updated_at, terminal_event_seq) "
                    "VALUES (?, ?, 0, ?, ?, ?)",
                    (task_id, state, now, now, sequence),
                )
        connection.execute(
            "UPDATE local_turns SET status=?, updated_at=?, terminal_event_seq=? "
            "WHERE task_id=? AND status IN ('running','outcome_unknown')",
            (state, now, sequence, task_id),
        )

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
