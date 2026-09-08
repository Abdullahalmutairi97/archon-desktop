from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator


SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    prompt TEXT NOT NULL,
    cwd TEXT,
    model TEXT,
    provider TEXT,
    session_id TEXT,
    profile TEXT,
    approval_mode TEXT NOT NULL DEFAULT 'approve' CHECK(approval_mode IN ('auto','approve','plan')),
    chat_only INTEGER NOT NULL DEFAULT 0,
    skills_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled','blocked')),
    result_json TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    retry_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_at);
CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_task_seq ON events(task_id, seq);
CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_locations (
    session_id TEXT PRIMARY KEY,
    cwd TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('task','hermes')),
    discovered_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_locations_updated ON session_locations(updated_at DESC);
CREATE TABLE IF NOT EXISTS session_projects (
    session_id TEXT PRIMARY KEY,
    project_id TEXT,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_projects_project ON session_projects(project_id);
CREATE TABLE IF NOT EXISTS deleted_sessions (
    session_id TEXT PRIMARY KEY,
    deleted_at TEXT NOT NULL
);
"""


class Database:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as conn:
            conn.executescript(SCHEMA)
            columns = {row[1] for row in conn.execute("PRAGMA table_info(tasks)")}
            if "session_id" not in columns:
                conn.execute("ALTER TABLE tasks ADD COLUMN session_id TEXT")
            if "approval_mode" not in columns:
                conn.execute("ALTER TABLE tasks ADD COLUMN approval_mode TEXT NOT NULL DEFAULT 'approve'")
            if "chat_only" not in columns:
                conn.execute("ALTER TABLE tasks ADD COLUMN chat_only INTEGER NOT NULL DEFAULT 0")
            if "profile" not in columns:
                conn.execute("ALTER TABLE tasks ADD COLUMN profile TEXT")
            if "retry_at" not in columns:
                conn.execute("ALTER TABLE tasks ADD COLUMN retry_at TEXT")
            # Create this only after legacy tasks tables have gained session_id.
            conn.execute("CREATE INDEX IF NOT EXISTS idx_tasks_session_updated ON tasks(session_id, updated_at DESC, id DESC)")
            location_columns = {row[1] for row in conn.execute("PRAGMA table_info(session_locations)")}
            if "source" not in location_columns:
                conn.execute("ALTER TABLE session_locations ADD COLUMN source TEXT NOT NULL DEFAULT 'hermes'")
            if "discovered_at" not in location_columns:
                conn.execute("ALTER TABLE session_locations ADD COLUMN discovered_at TEXT NOT NULL DEFAULT ''")
            if "updated_at" not in location_columns:
                conn.execute("ALTER TABLE session_locations ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''")
            # Sessions created before this registry existed already have their
            # dispatch directory in the task ledger. Seed the durable registry
            # once from those records, without overwriting a newer live mapping.
            conn.execute(
                """INSERT OR IGNORE INTO session_locations(session_id,cwd,source,discovered_at,updated_at)
                   SELECT session_id,cwd,'task',created_at,updated_at
                   FROM tasks
                   WHERE NULLIF(TRIM(session_id),'') IS NOT NULL
                     AND NULLIF(TRIM(cwd),'') IS NOT NULL
                   ORDER BY created_at ASC"""
            )

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
