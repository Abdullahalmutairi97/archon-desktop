"""Immutable migration 2: durable runtime ownership and execution attempts.

The migration uses only backend SQLite facts. In particular, it does not read
current provider files, mutable profile aliases, or the current project catalog.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _columns(conn, table: str) -> set[str]:
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}


def _reconcile_legacy_ownership(conn) -> None:
    """Mark only exact, canonical legacy evidence verified; keep the rest for review."""
    tombstones = {
        row[0] for row in conn.execute("SELECT session_id FROM deleted_sessions")
    }
    evidence: dict[str, list[tuple[str | None, str | None]]] = defaultdict(list)
    for session_id_value, profile_value, cwd_value in conn.execute("SELECT session_id,profile,cwd FROM tasks"):
        session_id = session_id_value if isinstance(session_id_value, str) else ""
        if session_id.strip() and session_id not in tombstones:
            evidence[session_id].append((profile_value, cwd_value))
    for row in conn.execute("SELECT session_id FROM session_projects"):
        session_id = row[0] if isinstance(row[0], str) else ""
        if session_id.strip() and session_id not in tombstones:
            evidence.setdefault(session_id, [])

    now = _now()
    for session_id, items in evidence.items():
        profiles = [profile if isinstance(profile, str) and profile.strip() else None
                    for profile, _cwd in items]
        cwds = [cwd if isinstance(cwd, str) and cwd.strip() else None
                for _profile, cwd in items]
        known_profiles = {profile for profile in profiles if profile in {"prime", "pi"}}
        has_unknown_profile = any(profile not in {"prime", "pi"} for profile in profiles)
        known_cwds = {cwd for cwd in cwds if cwd is not None}
        complete_cwd = bool(cwds) and all(cwd is not None for cwd in cwds)

        reason_parts: list[str] = []
        if has_unknown_profile or len(known_profiles) != 1:
            reason_parts.append("Legacy runtime evidence is missing, alias-based, or conflicting.")
        if not complete_cwd or len(known_cwds) != 1:
            reason_parts.append("Legacy working-directory evidence is missing or conflicting.")
        verified = not reason_parts
        runtime_id = next(iter(known_profiles)) if len(known_profiles) == 1 else None
        cwd = next(iter(known_cwds)) if complete_cwd and len(known_cwds) == 1 else None
        conn.execute(
            """INSERT INTO session_ownership
               (session_id,runtime_id,cwd,state,reason,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?)""",
            (session_id, runtime_id, cwd, "verified" if verified else "review_required",
             None if verified else " ".join(reason_parts), now, now),
        )


def apply(conn) -> None:
    task_columns = _columns(conn, "tasks")
    required_task_columns = {"id", "prompt", "cwd", "status", "created_at", "updated_at",
                             "session_id", "profile", "request_hash"}
    if not required_task_columns.issubset(task_columns):
        raise RuntimeError("Migration 2 requires the verified migration 1 tasks schema")

    for name, declaration in (
        ("runtime_id", "TEXT CHECK(runtime_id IS NULL OR runtime_id IN ('prime','pi'))"),
        ("project_id", "TEXT"),
        ("current_attempt_id", "TEXT"),
    ):
        if name not in task_columns:
            conn.execute(f"ALTER TABLE tasks ADD COLUMN {name} {declaration}")
    conn.execute("UPDATE tasks SET runtime_id=profile WHERE profile IN ('prime','pi')")
    conn.execute(
        """UPDATE tasks SET project_id=(
             SELECT session_projects.project_id FROM session_projects
             WHERE session_projects.session_id=tasks.session_id
           ) WHERE session_id IS NOT NULL"""
    )

    conn.execute(
        """CREATE TABLE task_attempts (
             id TEXT PRIMARY KEY,
             task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
             ordinal INTEGER NOT NULL CHECK(ordinal > 0),
             state TEXT NOT NULL CHECK(state IN
               ('claimed','running','completed','failed','cancelled','interrupted')),
             claimed_at TEXT NOT NULL,
             started_at TEXT,
             finished_at TEXT,
             cancel_requested_at TEXT,
             runtime_id TEXT CHECK(runtime_id IS NULL OR runtime_id IN ('prime','pi')),
             session_id TEXT,
             cwd TEXT,
             project_id TEXT,
             error TEXT,
             UNIQUE(task_id,ordinal)
           )"""
    )
    conn.execute("CREATE INDEX idx_task_attempts_task_ordinal ON task_attempts(task_id,ordinal)")
    conn.execute(
        """CREATE TRIGGER task_attempt_snapshots_immutable
           BEFORE UPDATE OF runtime_id,session_id,cwd,project_id ON task_attempts
           BEGIN
             SELECT RAISE(ABORT, 'task attempt snapshots are immutable');
           END"""
    )
    conn.execute(
        """CREATE TRIGGER task_admission_snapshots_immutable
           BEFORE UPDATE OF runtime_id,project_id ON tasks
           WHEN NEW.runtime_id IS NOT OLD.runtime_id OR NEW.project_id IS NOT OLD.project_id
           BEGIN
             SELECT RAISE(ABORT, 'task runtime and project snapshots are immutable');
           END"""
    )

    conn.execute(
        """CREATE TABLE session_ownership (
             session_id TEXT PRIMARY KEY,
             runtime_id TEXT CHECK(runtime_id IS NULL OR runtime_id IN ('prime','pi')),
             cwd TEXT,
             state TEXT NOT NULL CHECK(state IN ('verified','review_required')),
             reason TEXT,
             created_at TEXT NOT NULL,
             updated_at TEXT NOT NULL
           )"""
    )
    conn.execute(
        """CREATE TRIGGER session_owner_verified_snapshot_immutable
           BEFORE UPDATE OF runtime_id,cwd ON session_ownership
           WHEN OLD.state='verified'
             AND (NEW.runtime_id IS NOT OLD.runtime_id OR NEW.cwd IS NOT OLD.cwd)
           BEGIN
             SELECT RAISE(ABORT, 'verified session ownership is immutable');
           END"""
    )
    event_columns = _columns(conn, "events")
    if not {"seq", "task_id", "type", "data_json", "created_at"}.issubset(event_columns):
        raise RuntimeError("Migration 2 requires the verified migration 1 events schema")
    conn.execute(
        "ALTER TABLE events ADD COLUMN attempt_id TEXT REFERENCES task_attempts(id) ON DELETE SET NULL"
    )
    _reconcile_legacy_ownership(conn)
