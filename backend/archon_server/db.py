from __future__ import annotations

import fcntl
import hashlib
import os
import sqlite3
import stat
import tempfile
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

from .migrations import v001

SCHEMA = v001.SCHEMA
MIGRATION_VERSION = 1
MIGRATION_CHECKSUM = hashlib.sha256(Path(v001.__file__).read_bytes()).hexdigest()
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
    entries = conn.execute("SELECT version,checksum FROM schema_migrations ORDER BY version").fetchall()
    if any(entry[0] > MIGRATION_VERSION for entry in entries):
        raise RuntimeError("Database migration ledger contains a newer version")
    if version != MIGRATION_VERSION or [entry[0] for entry in entries] != [1]:
        raise RuntimeError("Database version and migration ledger are inconsistent or contain gaps")
    if entries[0][1] != MIGRATION_CHECKSUM:
        raise RuntimeError("Database migration checksum does not match the installed migration")
    if "request_hash" not in {row[1] for row in conn.execute("PRAGMA table_info(tasks)")}:
        raise RuntimeError("Database schema differs from its migration ledger")
    return version


def _snapshot(path: Path) -> Path:
    """Copy committed pages, including WAL, while another connection blocks writers."""
    fd, temporary_name = tempfile.mkstemp(prefix=path.name + ".pre-v1-", suffix=".sqlite3.tmp", dir=path.parent)
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
                    if version == 0:
                        if existed:
                            self.migration_backup = _snapshot(self.path)
                        v001.apply(conn)
                        conn.execute("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)")
                        conn.execute("INSERT INTO schema_migrations VALUES (?,?,?)", (MIGRATION_VERSION, MIGRATION_CHECKSUM, datetime.now(timezone.utc).isoformat()))
                        conn.execute("PRAGMA user_version=1")
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
