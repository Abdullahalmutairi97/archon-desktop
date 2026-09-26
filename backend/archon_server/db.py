from __future__ import annotations

import fcntl
import hashlib
import os
import re
import sqlite3
import stat
import tempfile
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

from .migrations import v001, v002

SCHEMA = v001.SCHEMA
MIGRATION_VERSION = 2
MIGRATION_CHECKSUM = hashlib.sha256(Path(v001.__file__).read_bytes()).hexdigest()
MIGRATION_CHECKSUMS = {
    1: MIGRATION_CHECKSUM,
    2: hashlib.sha256(Path(v002.__file__).read_bytes()).hexdigest(),
}
MIGRATIONS = {1: v001, 2: v002}
MIGRATION_LOCK_TIMEOUT = 30.0
SNAPSHOT_TIMEOUT = 30.0


@contextmanager
def _migration_lock(path: Path):
    lock_path = path.with_name(path.name + ".migrate.lock")
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode):
            raise RuntimeError("Database migration lock must be a regular file")
        deadline = time.monotonic() + MIGRATION_LOCK_TIMEOUT
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise RuntimeError("Timed out waiting for database migration lock")
                time.sleep(min(0.05, remaining))
        current = lock_path.stat(follow_symlinks=False)
        if (current.st_dev, current.st_ino) != (opened.st_dev, opened.st_ino):
            raise RuntimeError("Database migration lock was replaced while waiting")
        yield
    finally:
        os.close(fd)


def _schema_version(conn: sqlite3.Connection) -> int:
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    ledger_exists = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").fetchone()
    if version > MIGRATION_VERSION:
        raise RuntimeError("Database schema version is newer than this server supports")
    if not ledger_exists:
        if version != 0:
            raise RuntimeError("Database version has no matching migration ledger")
        return 0
    _validate_columns(conn, "schema_migrations", {"version", "checksum", "applied_at"})
    _require_table_primary_key(conn, "schema_migrations", ("version",))
    entries = conn.execute("SELECT version,checksum FROM schema_migrations ORDER BY version").fetchall()
    if any(entry[0] > MIGRATION_VERSION for entry in entries):
        raise RuntimeError("Database migration ledger contains a newer version")
    if version == 0 or [entry[0] for entry in entries] != list(range(1, version + 1)):
        raise RuntimeError("Database version and migration ledger are inconsistent or contain gaps")
    for entry in entries:
        expected = MIGRATION_CHECKSUMS.get(entry[0])
        if expected is None or entry[1] != expected:
            raise RuntimeError(f"Database migration checksum does not match migration {entry[0]}")
    _validate_schema_shape(conn, version)
    return version


def _validate_columns(conn: sqlite3.Connection, table: str, required: set[str]) -> None:
    if not conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone():
        raise RuntimeError(f"Database schema differs from its migration ledger: missing {table}")
    actual = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
    if not required.issubset(actual):
        raise RuntimeError(f"Database schema differs from its migration ledger: malformed {table}")


def _sql_tokens(value: str | None) -> str:
    """Normalize only SQL whitespace and keyword/identifier case for comparisons."""
    tokens = re.findall(
        r"'(?:''|[^'])*'|\"(?:\"\"|[^\"])*\"|[A-Za-z_][A-Za-z0-9_]*|<=|>=|<>|!=|==|[^\s]",
        value or "",
    )
    return " ".join(token if token.startswith(("'", '"')) else token.casefold() for token in tokens)


def _table_sql(conn: sqlite3.Connection, table: str) -> str:
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,),
    ).fetchone()
    return row[0] if row else ""


def _require_table_primary_key(conn: sqlite3.Connection, table: str, columns: tuple[str, ...]) -> None:
    info = conn.execute(f"PRAGMA table_info({table})").fetchall()
    actual = tuple(row[1] for row in sorted((row for row in info if row[5]), key=lambda row: row[5]))
    if actual != columns:
        raise RuntimeError(f"Database schema differs from its migration ledger: malformed {table} primary key")


def _has_unique_index(conn: sqlite3.Connection, table: str, columns: tuple[str, ...]) -> bool:
    for index in conn.execute(f"PRAGMA index_list({table})").fetchall():
        if not index[2] or (len(index) > 4 and index[4]):
            continue
        escaped = str(index[1]).replace('"', '""')
        indexed = conn.execute(f'PRAGMA index_info("{escaped}")').fetchall()
        names = tuple(row[2] for row in sorted(indexed, key=lambda row: row[0]))
        if names == columns:
            return True
    return False


def _foreign_keys(conn: sqlite3.Connection, table: str) -> set[tuple[str, str, str, str, str]]:
    return {
        (row[2], row[3], row[4], str(row[5]).upper(), str(row[6]).upper())
        for row in conn.execute(f"PRAGMA foreign_key_list({table})").fetchall()
    }


def _require_trigger(conn: sqlite3.Connection, name: str, expected_sql: str) -> None:
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?", (name,),
    ).fetchone()
    if row is None or _sql_tokens(row[0]) != _sql_tokens(expected_sql):
        raise RuntimeError(f"Database schema differs from its migration ledger: missing or altered immutable trigger {name}")


def _validate_schema_shape(conn: sqlite3.Connection, version: int) -> None:
    _validate_columns(conn, "tasks", {
        "id", "prompt", "cwd", "model", "provider", "status", "result_json", "error",
        "created_at", "updated_at", "started_at", "completed_at", "retry_at", "session_id",
        "profile", "approval_mode", "chat_only", "skills_json", "request_hash",
    })
    _validate_columns(conn, "events", {"seq", "task_id", "type", "data_json", "created_at"})
    _validate_columns(conn, "app_settings", {"key", "value_json", "updated_at"})
    _validate_columns(conn, "session_locations", {
        "session_id", "cwd", "source", "discovered_at", "updated_at",
    })
    _validate_columns(conn, "session_projects", {"session_id", "project_id", "updated_at"})
    _validate_columns(conn, "deleted_sessions", {"session_id", "deleted_at"})
    for table, columns in (
        ("tasks", ("id",)),
        ("events", ("seq",)),
        ("app_settings", ("key",)),
        ("session_locations", ("session_id",)),
        ("session_projects", ("session_id",)),
        ("deleted_sessions", ("session_id",)),
    ):
        _require_table_primary_key(conn, table, columns)
    event_fks = _foreign_keys(conn, "events")
    task_fk = ("tasks", "task_id", "id", "NO ACTION", "CASCADE")
    if task_fk not in event_fks:
        raise RuntimeError("Database schema differs from its migration ledger: missing events task relationship")
    if version == 1 and event_fks != {task_fk}:
        raise RuntimeError("Database schema differs from its migration ledger: malformed events foreign keys")
    if version >= 2:
        _validate_columns(conn, "tasks", {"runtime_id", "project_id", "current_attempt_id"})
        _validate_columns(conn, "events", {"attempt_id"})
        _validate_columns(conn, "task_attempts", {
            "id", "task_id", "ordinal", "state", "claimed_at", "started_at", "finished_at",
            "cancel_requested_at", "runtime_id", "session_id", "cwd", "project_id", "error",
        })
        _validate_columns(conn, "session_ownership", {
            "session_id", "runtime_id", "cwd", "state", "reason", "created_at", "updated_at",
        })
        if not _has_unique_index(conn, "task_attempts", ("task_id", "ordinal")):
            raise RuntimeError("Database schema differs from its migration ledger: missing task attempt ordinal uniqueness")
        _require_table_primary_key(conn, "task_attempts", ("id",))
        _require_table_primary_key(conn, "session_ownership", ("session_id",))
        if _foreign_keys(conn, "task_attempts") != {
            ("tasks", "task_id", "id", "NO ACTION", "CASCADE"),
        }:
            raise RuntimeError("Database schema differs from its migration ledger: malformed task attempt relationship")
        if _foreign_keys(conn, "events") != {
            ("tasks", "task_id", "id", "NO ACTION", "CASCADE"),
            ("task_attempts", "attempt_id", "id", "NO ACTION", "SET NULL"),
        }:
            raise RuntimeError("Database schema differs from its migration ledger: malformed event attempt relationship")

        task_sql = _sql_tokens(_table_sql(conn, "tasks"))
        runtime_check = _sql_tokens("CHECK(runtime_id IS NULL OR runtime_id IN ('prime','pi'))")
        if runtime_check not in task_sql:
            raise RuntimeError("Database schema differs from its migration ledger: missing canonical task runtime constraint")

        attempts_sql = _sql_tokens(_table_sql(conn, "task_attempts"))
        for constraint in (
            "CHECK(ordinal > 0)",
            "CHECK(state IN ('claimed','running','completed','failed','cancelled','interrupted'))",
            "CHECK(runtime_id IS NULL OR runtime_id IN ('prime','pi'))",
        ):
            if _sql_tokens(constraint) not in attempts_sql:
                raise RuntimeError("Database schema differs from its migration ledger: malformed task_attempts constraints")
        owner_sql = _sql_tokens(_table_sql(conn, "session_ownership"))
        for constraint in (
            "CHECK(runtime_id IS NULL OR runtime_id IN ('prime','pi'))",
            "CHECK(state IN ('verified','review_required'))",
        ):
            if _sql_tokens(constraint) not in owner_sql:
                raise RuntimeError("Database schema differs from its migration ledger: malformed session_ownership constraints")

        _require_trigger(conn, "task_attempt_snapshots_immutable", """
            CREATE TRIGGER task_attempt_snapshots_immutable
            BEFORE UPDATE OF runtime_id,session_id,cwd,project_id ON task_attempts
            BEGIN SELECT RAISE(ABORT, 'task attempt snapshots are immutable'); END
        """)
        _require_trigger(conn, "task_admission_snapshots_immutable", """
            CREATE TRIGGER task_admission_snapshots_immutable
            BEFORE UPDATE OF runtime_id,project_id ON tasks
            WHEN NEW.runtime_id IS NOT OLD.runtime_id OR NEW.project_id IS NOT OLD.project_id
            BEGIN SELECT RAISE(ABORT, 'task runtime and project snapshots are immutable'); END
        """)
        _require_trigger(conn, "session_owner_verified_snapshot_immutable", """
            CREATE TRIGGER session_owner_verified_snapshot_immutable
            BEFORE UPDATE OF runtime_id,cwd ON session_ownership
            WHEN OLD.state='verified'
              AND (NEW.runtime_id IS NOT OLD.runtime_id OR NEW.cwd IS NOT OLD.cwd)
            BEGIN SELECT RAISE(ABORT, 'verified session ownership is immutable'); END
        """)


def _snapshot(path: Path, destination_version: int) -> Path:
    """Copy committed pages, including WAL, while another connection blocks writers."""
    prefix = path.name + f".pre-v{destination_version}-"
    fd, temporary_name = tempfile.mkstemp(prefix=prefix, suffix=".sqlite3.tmp", dir=path.parent)
    os.close(fd)
    temporary = Path(temporary_name)
    destination = temporary.with_suffix("")
    deadline = time.monotonic() + SNAPSHOT_TIMEOUT
    def progress(_status, _remaining, _total):
        if time.monotonic() > deadline:
            raise RuntimeError("Timed out creating database migration snapshot")
    try:
        source = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=30)
        try:
            backup = sqlite3.connect(temporary, isolation_level=None)
            try:
                source.backup(backup, pages=256, progress=progress, sleep=0.05)
                backup.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
                if backup.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
                    raise RuntimeError("Database migration snapshot failed integrity verification")
            finally:
                backup.close()
        finally:
            source.close()
        with temporary.open("rb") as handle:
            os.fsync(handle.fileno())
        # Publish without replacing any existing file, then persist its name.
        os.link(temporary, destination)
        temporary.unlink()
        os.chmod(destination, 0o600)
        directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        return destination
    finally:
        temporary.unlink(missing_ok=True)


class Database:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.migration_backup: Path | None = None
        with _migration_lock(self.path):
            existed = self.path.exists() and self.path.stat().st_size > 0
            # Validate before changing persistent pragmas, creating schema, or
            # applying the old bootstrap. executescript would auto-commit DDL.
            conn = sqlite3.connect(self.path, timeout=30, isolation_level=None)
            try:
                conn.execute("PRAGMA foreign_keys=ON")
                conn.execute("BEGIN IMMEDIATE")
                try:
                    version = _schema_version(conn)
                    if version < MIGRATION_VERSION:
                        if existed:
                            self.migration_backup = _snapshot(self.path, MIGRATION_VERSION)
                        conn.execute("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)")
                        for destination_version in range(version + 1, MIGRATION_VERSION + 1):
                            migration = MIGRATIONS[destination_version]
                            migration.apply(conn)
                            conn.execute(
                                "INSERT INTO schema_migrations VALUES (?,?,?)",
                                (destination_version, MIGRATION_CHECKSUMS[destination_version], datetime.now(timezone.utc).isoformat()),
                            )
                            conn.execute(f"PRAGMA user_version={destination_version}")
                    conn.commit()
                except BaseException:
                    conn.rollback()
                    raise
                conn.execute("PRAGMA journal_mode=WAL")
            finally:
                conn.close()

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=30000")
        try:
            yield conn
        finally:
            conn.close()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                yield conn
            except Exception:
                conn.rollback()
                raise
            else:
                conn.commit()

    def session_locations(self, session_ids: list[str]) -> dict[str, dict[str, str]]:
        """Return durable working directories by Hermes session id."""
        unique_ids = list(dict.fromkeys(session_id for session_id in session_ids if session_id))
        if not unique_ids:
            return {}
        placeholders = ",".join("?" for _ in unique_ids)
        with self.connect() as conn:
            rows = conn.execute(
                f"SELECT session_id,cwd,source FROM session_locations WHERE session_id IN ({placeholders})",
                unique_ids,
            ).fetchall()
        return {row["session_id"]: {"cwd": row["cwd"], "source": row["source"]} for row in rows}

    def remember_session_location(
        self,
        session_id: str,
        cwd: str | None,
        source: str,
        *,
        conn: sqlite3.Connection | None = None,
    ) -> None:
        """Persist the first known session working directory without losing task truth.

        A task's requested working directory is authoritative. Hermes can omit its
        saved cwd after compaction or an upgrade, so a later read from Hermes must
        never replace a task-proven location.
        """
        normalized_id = session_id.strip()
        normalized_cwd = (cwd or "").strip()
        if not normalized_id or not normalized_cwd:
            return
        if source not in {"task", "hermes"}:
            raise ValueError("Invalid session location source")
        timestamp = datetime.now(timezone.utc).isoformat()

        def write(target: sqlite3.Connection) -> None:
            target.execute(
                """INSERT INTO session_locations(session_id,cwd,source,discovered_at,updated_at)
                   VALUES (?,?,?,?,?)
                   ON CONFLICT(session_id) DO UPDATE SET
                     cwd=CASE
                       WHEN session_locations.source='task' AND excluded.source='hermes'
                         THEN session_locations.cwd
                       ELSE excluded.cwd
                     END,
                     source=CASE
                       WHEN session_locations.source='task' AND excluded.source='hermes'
                         THEN session_locations.source
                       ELSE excluded.source
                     END,
                     updated_at=excluded.updated_at""",
                (normalized_id, normalized_cwd, source, timestamp, timestamp),
            )

        if conn is not None:
            write(conn)
            return
        with self.transaction() as transaction:
            write(transaction)
