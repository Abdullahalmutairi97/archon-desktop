"""Small durable outbox for a single runner.

The journal bounds unacknowledged events by count and encoded payload bytes.
Idempotency receipts are retained for the active journal file so a retry after
acknowledgement cannot acquire a new sequence; receipt storage therefore grows
with the number of events and their serialized payload sizes. A generation can
advance only after its outbox is empty. Durability is limited to SQLite's local
filesystem commit; this module does not provide runner lifecycle or UI-close
guarantees.
"""

from __future__ import annotations

import json
import os
import sqlite3
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_APPLICATION_ID = 0x524A4E4C  # "RJNL"
_SCHEMA_VERSION = 1
_BUSY_TIMEOUT_SECONDS = 5.0
_MAX_IDENTIFIER_BYTES = 256
_TABLE_DDL = {
    "runner_journal_state": """CREATE TABLE runner_journal_state (
           singleton INTEGER PRIMARY KEY CHECK(singleton=1),
           runner_id TEXT NOT NULL,
           journal_generation INTEGER NOT NULL CHECK(journal_generation > 0),
           last_runner_seq INTEGER NOT NULL CHECK(last_runner_seq >= 0)
       )""",
    "runner_journal_events": """CREATE TABLE runner_journal_events (
           runner_id TEXT NOT NULL,
           journal_generation INTEGER NOT NULL,
           runner_seq INTEGER NOT NULL PRIMARY KEY,
           event_key TEXT NOT NULL,
           payload_json TEXT NOT NULL,
           payload_bytes INTEGER NOT NULL CHECK(payload_bytes >= 0),
           UNIQUE(runner_id,journal_generation,event_key)
       )""",
    "runner_journal_receipts": """CREATE TABLE runner_journal_receipts (
           runner_id TEXT NOT NULL,
           journal_generation INTEGER NOT NULL,
           event_key TEXT NOT NULL,
           runner_seq INTEGER NOT NULL UNIQUE,
           payload_json TEXT NOT NULL,
           PRIMARY KEY(runner_id,journal_generation,event_key)
       )""",
}


class RunnerJournalError(RuntimeError):
    """Base error for journal identity and state violations."""


class StaleJournalGeneration(RunnerJournalError):
    """Raised when this handle no longer owns the active generation."""


class PendingJournalEntries(RunnerJournalError):
    """Raised when a generation change would strand unacknowledged events."""


class AppendConflict(RunnerJournalError):
    """Raised when an event key is retried with a different payload."""


class OutboxFull(RunnerJournalError):
    """Raised when appending would exceed either outbox bound."""


class InvalidAcknowledgement(RunnerJournalError):
    """Raised when an acknowledgement does not identify a committed event."""


class UnsafeJournalPath(PermissionError):
    """Raised when the journal file or its containing directory is unsafe."""


@dataclass(frozen=True)
class JournalEntry:
    runner_id: str
    journal_generation: int
    runner_seq: int
    event_key: str
    payload: Any


class RunnerJournal:
    """A private SQLite journal with generation fencing and a bounded outbox."""

    def __init__(
        self,
        path: str | os.PathLike[str],
        runner_id: str,
        journal_generation: int,
        *,
        max_unacked_events: int = 1024,
        max_unacked_bytes: int = 16 * 1024 * 1024,
    ) -> None:
        _validate_identifier(runner_id, "runner_id")
        if isinstance(journal_generation, bool) or not isinstance(journal_generation, int) or journal_generation < 1:
            raise ValueError("journal_generation must be a positive integer")
        if isinstance(max_unacked_events, bool) or not isinstance(max_unacked_events, int) or max_unacked_events < 1:
            raise ValueError("max_unacked_events must be a positive integer")
        if isinstance(max_unacked_bytes, bool) or not isinstance(max_unacked_bytes, int) or max_unacked_bytes < 1:
            raise ValueError("max_unacked_bytes must be a positive integer")

        self.path = Path(os.path.abspath(os.fspath(path)))
        self.runner_id = runner_id
        self.journal_generation = journal_generation
        self.max_unacked_events = max_unacked_events
        self.max_unacked_bytes = max_unacked_bytes
        self._prepare_private_path()
        self._initialize()

    def append(self, event_key: str, payload: Any) -> JournalEntry:
        """Commit an event before returning its sequence to the caller.

        ``event_key`` is unique within a generation. An exact retry returns
        the original entry, including after its outbox row has been acked.
        """
        if not isinstance(event_key, str) or not event_key:
            raise ValueError("event_key must be a non-empty string")
        _validate_identifier(event_key, "event_key")
        payload_json = _canonical_json(payload)
        payload_bytes = len(payload_json.encode("utf-8"))
        if payload_bytes > self.max_unacked_bytes:
            raise OutboxFull("event payload exceeds the unacknowledged outbox byte limit")
        connection = self._connect()
        entry: JournalEntry
        try:
            connection.execute("BEGIN IMMEDIATE")
            state = self._active_state(connection)
            receipt = connection.execute(
                """SELECT runner_seq,payload_json FROM runner_journal_receipts
                   WHERE runner_id=? AND journal_generation=? AND event_key=?""",
                (self.runner_id, self.journal_generation, event_key),
            ).fetchone()
            if receipt is not None:
                if receipt[1] != payload_json:
                    raise AppendConflict(f"event key {event_key!r} already has a different payload")
                entry = JournalEntry(
                    self.runner_id,
                    self.journal_generation,
                    int(receipt[0]),
                    event_key,
                    json.loads(payload_json),
                )
            else:
                count, current_bytes = connection.execute(
                    """SELECT COUNT(*),COALESCE(SUM(payload_bytes),0)
                       FROM runner_journal_events WHERE runner_id=? AND journal_generation=?""",
                    (self.runner_id, self.journal_generation),
                ).fetchone()
                if count >= self.max_unacked_events or current_bytes + payload_bytes > self.max_unacked_bytes:
                    raise OutboxFull("unacknowledged runner event outbox is full")
                runner_seq = int(state[2]) + 1
                connection.execute(
                    """INSERT INTO runner_journal_events
                       (runner_id,journal_generation,runner_seq,event_key,payload_json,payload_bytes)
                       VALUES (?,?,?,?,?,?)""",
                    (self.runner_id, self.journal_generation, runner_seq, event_key, payload_json, payload_bytes),
                )
                connection.execute(
                    """INSERT INTO runner_journal_receipts
                       (runner_id,journal_generation,event_key,runner_seq,payload_json)
                       VALUES (?,?,?,?,?)""",
                    (self.runner_id, self.journal_generation, event_key, runner_seq, payload_json),
                )
                connection.execute(
                    "UPDATE runner_journal_state SET last_runner_seq=? WHERE singleton=1",
                    (runner_seq,),
                )
                entry = JournalEntry(
                    self.runner_id,
                    self.journal_generation,
                    runner_seq,
                    event_key,
                    json.loads(payload_json),
                )
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()
        return entry

    def replay_unacked(self) -> list[JournalEntry]:
        """Return committed, unacknowledged entries in runner sequence order."""
        connection = self._connect()
        try:
            connection.execute("BEGIN")
            self._active_state(connection)
            rows = connection.execute(
                """SELECT runner_seq,event_key,payload_json
                   FROM runner_journal_events
                   WHERE runner_id=? AND journal_generation=?
                   ORDER BY runner_seq""",
                (self.runner_id, self.journal_generation),
            ).fetchall()
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()
        return [
            JournalEntry(self.runner_id, self.journal_generation, int(seq), key, json.loads(payload))
            for seq, key, payload in rows
        ]

    def acknowledge(self, runner_seq: int) -> None:
        """Prune one committed event from this active generation.

        Exact acknowledgements avoid accidentally advancing over a sequence
        hole. Repeated acknowledgements of an already-pruned event are safe.
        """
        if isinstance(runner_seq, bool) or not isinstance(runner_seq, int) or runner_seq < 1:
            raise ValueError("runner_seq must be a positive integer")
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            self._active_state(connection)
            receipt = connection.execute(
                """SELECT journal_generation FROM runner_journal_receipts
                   WHERE runner_id=? AND runner_seq=?""",
                (self.runner_id, runner_seq),
            ).fetchone()
            if receipt is None or int(receipt[0]) != self.journal_generation:
                raise InvalidAcknowledgement("acknowledgement does not identify a committed current-generation event")
            connection.execute(
                """DELETE FROM runner_journal_events
                   WHERE runner_id=? AND journal_generation=? AND runner_seq=?""",
                (self.runner_id, self.journal_generation, runner_seq),
            )
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    @property
    def last_sequence(self) -> int:
        connection = self._connect()
        try:
            connection.execute("BEGIN")
            state = self._active_state(connection)
            connection.commit()
            return int(state[2])
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    def _initialize(self) -> None:
        connection = self._connect()
        try:
            application_id = int(connection.execute("PRAGMA application_id").fetchone()[0])
            user_version = int(connection.execute("PRAGMA user_version").fetchone()[0])
            if application_id not in (0, _APPLICATION_ID):
                raise RunnerJournalError("SQLite file belongs to a different application")
            if application_id == 0:
                if user_version != 0:
                    raise RunnerJournalError("refusing to initialize a SQLite file with an unknown schema version")
                schema_objects = connection.execute(
                    "SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"
                ).fetchall()
                if schema_objects:
                    raise RunnerJournalError("refusing to initialize a non-empty SQLite file")
            elif user_version != _SCHEMA_VERSION:
                raise RunnerJournalError("runner journal schema version is unsupported")
            else:
                self._validate_existing_schema(connection)
            connection.execute("PRAGMA journal_mode=WAL")

            connection.execute("BEGIN IMMEDIATE")
            if application_id == 0:
                for statement in _TABLE_DDL.values():
                    connection.execute(statement)
                connection.execute(f"PRAGMA application_id={_APPLICATION_ID}")
                connection.execute(f"PRAGMA user_version={_SCHEMA_VERSION}")
                connection.execute(
                    """INSERT INTO runner_journal_state
                       (singleton,runner_id,journal_generation,last_runner_seq) VALUES (1,?,?,0)""",
                    (self.runner_id, self.journal_generation),
                )
            state = connection.execute(
                "SELECT runner_id,journal_generation,last_runner_seq FROM runner_journal_state WHERE singleton=1"
            ).fetchone()
            if state is None:
                raise RunnerJournalError("runner journal singleton state is missing")
            else:
                if state[0] != self.runner_id:
                    raise RunnerJournalError("journal is already owned by a different runner_id")
                active_generation = int(state[1])
                self._validate_sequence_state(connection, int(state[2]))
                if self.journal_generation < active_generation:
                    raise StaleJournalGeneration("journal generation is stale")
                if self.journal_generation > active_generation:
                    pending_count = connection.execute(
                        "SELECT COUNT(*) FROM runner_journal_events WHERE runner_id=?",
                        (self.runner_id,),
                    ).fetchone()[0]
                    if pending_count:
                        raise PendingJournalEntries("cannot advance generation while events remain unacknowledged")
                    connection.execute(
                        "UPDATE runner_journal_state SET journal_generation=? WHERE singleton=1",
                        (self.journal_generation,),
                    )
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    def _validate_existing_schema(self, connection: sqlite3.Connection) -> None:
        schema_objects = connection.execute(
            "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"
        ).fetchall()
        if {row[1] for row in schema_objects} != set(_TABLE_DDL) or any(row[0] != "table" for row in schema_objects):
            raise RunnerJournalError("runner journal schema is incomplete or contains unknown objects")
        actual_sql = {row[1]: _normalize_sql(row[2]) for row in schema_objects}
        if any(actual_sql[name] != _normalize_sql(expected) for name, expected in _TABLE_DDL.items()):
            raise RunnerJournalError("runner journal table definition is malformed")
        state = connection.execute(
            "SELECT runner_id,journal_generation,last_runner_seq FROM runner_journal_state WHERE singleton=1"
        ).fetchone()
        if state is None:
            raise RunnerJournalError("runner journal singleton state is missing")

    def _validate_sequence_state(self, connection: sqlite3.Connection, last_runner_seq: int) -> None:
        count, first, last = connection.execute(
            "SELECT COUNT(*),MIN(runner_seq),MAX(runner_seq) FROM runner_journal_receipts"
        ).fetchone()
        if last_runner_seq == 0:
            valid = count == 0
        else:
            valid = count == last_runner_seq and first == 1 and last == last_runner_seq
        if not valid:
            raise RunnerJournalError("runner sequence state does not match its idempotency receipts")
        orphaned_event = connection.execute(
            """SELECT 1 FROM runner_journal_events AS event
               LEFT JOIN runner_journal_receipts AS receipt
                 ON receipt.runner_id=event.runner_id
                AND receipt.journal_generation=event.journal_generation
                AND receipt.event_key=event.event_key
                AND receipt.runner_seq=event.runner_seq
                AND receipt.payload_json=event.payload_json
               WHERE receipt.runner_seq IS NULL LIMIT 1"""
        ).fetchone()
        if orphaned_event:
            raise RunnerJournalError("runner outbox event has no matching committed receipt")

    def _active_state(self, connection: sqlite3.Connection) -> tuple[str, int, int]:
        row = connection.execute(
            "SELECT runner_id,journal_generation,last_runner_seq FROM runner_journal_state WHERE singleton=1"
        ).fetchone()
        if row is None or row[0] != self.runner_id:
            raise RunnerJournalError("journal runner identity changed")
        if int(row[1]) != self.journal_generation:
            raise StaleJournalGeneration("journal generation is stale")
        return str(row[0]), int(row[1]), int(row[2])

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=_BUSY_TIMEOUT_SECONDS)
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute(f"PRAGMA busy_timeout={int(_BUSY_TIMEOUT_SECONDS * 1000)}")
        return connection

    def _prepare_private_path(self) -> None:
        effective_uid = os.geteuid()
        for ancestor in (self.path.parent, *self.path.parent.parents):
            try:
                info = ancestor.stat(follow_symlinks=False)
            except OSError as exc:
                raise UnsafeJournalPath("cannot inspect journal directory ancestry") from exc
            if not stat.S_ISDIR(info.st_mode):
                raise UnsafeJournalPath("journal path traverses a non-directory or symlink")
            mode = stat.S_IMODE(info.st_mode)
            if ancestor == self.path.parent:
                if info.st_uid != effective_uid or mode != 0o700:
                    raise UnsafeJournalPath("journal parent must be owned by the current user and mode 0700")
            elif mode & (stat.S_IWGRP | stat.S_IWOTH) and not mode & stat.S_ISVTX:
                raise UnsafeJournalPath("journal directory ancestry is writable by other users")

        flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
        flags |= getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NONBLOCK", 0)
        try:
            descriptor = os.open(self.path, flags, 0o600)
        except OSError as exc:
            raise UnsafeJournalPath("cannot safely open journal file") from exc
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != effective_uid or info.st_nlink != 1:
                raise UnsafeJournalPath("journal path must be a singly-linked regular file owned by the current user")
            os.fchmod(descriptor, 0o600)
        finally:
            os.close(descriptor)


def _canonical_json(payload: Any) -> str:
    try:
        return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise ValueError("payload must be JSON serializable") from exc


def _validate_identifier(value: Any, name: str) -> None:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be a non-empty string")
    try:
        encoded = value.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise ValueError(f"{name} must be valid UTF-8") from exc
    if len(encoded) > _MAX_IDENTIFIER_BYTES:
        raise ValueError(f"{name} must be at most {_MAX_IDENTIFIER_BYTES} UTF-8 bytes")


def _normalize_sql(statement: str | None) -> str:
    return " ".join((statement or "").casefold().split())
