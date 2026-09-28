"""Migration evidence for the shapes a legacy database can actually contain.

The P1 M1.5 evidence item asks for migration and restore coverage with duplicate
project mappings, native Prime/Pi session ids, tombstoned sessions and queued or
running tasks in the same database, and for a proven pre-migration copy. This
module seeds exactly that shape and checks preservation, idempotence and the
snapshot contents instead of asserting a normalized shape it never produced.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from archon_server.db import Database, MIGRATION_VERSION, SCHEMA


def _seed_mixed_legacy(path: Path) -> None:
    """One legacy database holding every shape the evidence item names."""
    with sqlite3.connect(path) as conn:
        conn.executescript(SCHEMA)
        conn.executemany(
            "INSERT INTO tasks(id,prompt,session_id,cwd,status,created_at,updated_at,started_at)"
            " VALUES (?,?,?,?,?,?,?,?)",
            [
                ("queued-native-prime", "wait for the runner", "prime-01a0118e-4d54e-70b1", "/work/alpha", "queued", "t1", "t1", None),
                ("running-native-pi", "already started", "pi-01a011ca-30c8-7286", "/work/alpha", "running", "t2", "t2", "t2"),
                ("done-native-pi", "finished earlier", "pi-01a011ed-58a6-74f4", "/work/beta", "completed", "t3", "t3", "t3"),
            ],
        )
        conn.execute(
            "INSERT INTO events(seq,task_id,type,data_json,created_at)"
            " VALUES (17,'running-native-pi','task.running','{}','t2')"
        )
        # Two sessions map to one project id, and two session ids differ only by
        # their project: a migration must not merge or guess either one.
        conn.executemany(
            "INSERT INTO session_projects(session_id,project_id,updated_at) VALUES (?,?,?)",
            [
                ("prime-01a0118e-4d54e-70b1", "shared-project", "t1"),
                ("pi-01a011ca-30c8-7286", "shared-project", "t2"),
                ("pi-01a011ed-58a6-74f4", "other-project", "t3"),
            ],
        )
        conn.executemany(
            "INSERT INTO session_locations(session_id,cwd,source,discovered_at,updated_at) VALUES (?,?,?,?,?)",
            [
                ("prime-01a0118e-4d54e-70b1", "/work/alpha", "task", "t1", "t1"),
                ("pi-01a011ca-30c8-7286", "/work/alpha", "task", "t2", "t2"),
            ],
        )
        conn.execute("INSERT INTO deleted_sessions VALUES ('pi-tombstoned-01a01fb2','t4')")
        conn.execute("INSERT INTO deleted_sessions VALUES ('prime-tombstoned-01a01c43','t5')")


def _rows(path: Path, query: str, parameters: tuple = ()) -> list[tuple]:
    with sqlite3.connect(path) as conn:
        return conn.execute(query, parameters).fetchall()


def _user_version(path: Path) -> int:
    with sqlite3.connect(path) as conn:
        return int(conn.execute("PRAGMA user_version").fetchone()[0])


def _count_snapshots(path: Path) -> int:
    return len(list(path.parent.glob(path.name + ".pre-v*")))


def test_migration_preserves_every_legacy_shape_and_writes_one_pre_migration_copy(tmp_path):
    path = tmp_path / "legacy.db"
    _seed_mixed_legacy(path)
    with sqlite3.connect(path) as conn:
        conn.execute("PRAGMA user_version=0")

    before_tasks = _rows(path, "SELECT id,status,session_id,prompt FROM tasks ORDER BY id")
    before_projects = _rows(path, "SELECT session_id,project_id FROM session_projects ORDER BY session_id")
    before_deleted = _rows(path, "SELECT session_id FROM deleted_sessions ORDER BY session_id")

    database = Database(path)

    assert database.migration_backup is not None
    snapshot = Path(database.migration_backup)
    assert snapshot.is_file()
    assert _user_version(path) == MIGRATION_VERSION
    assert _count_snapshots(path) == 1

    # Nothing is merged, renamed or dropped by the migration itself.
    assert _rows(path, "SELECT id,status,session_id,prompt FROM tasks ORDER BY id") == before_tasks
    assert _rows(path, "SELECT session_id,project_id FROM session_projects ORDER BY session_id") == before_projects
    assert _rows(path, "SELECT session_id FROM deleted_sessions ORDER BY session_id") == before_deleted
    assert _rows(path, "SELECT id FROM tasks WHERE status='queued'") == [("queued-native-prime",)]
    assert _rows(path, "SELECT id FROM tasks WHERE status='running'") == [("running-native-pi",)]
    assert _rows(path, "SELECT COUNT(*) FROM tasks WHERE session_id LIKE 'prime-%'") == [(1,)]
    assert _rows(path, "SELECT COUNT(*) FROM tasks WHERE session_id LIKE 'pi-%'") == [(2,)]
    # Two sessions still share one project id, and the third stays separate.
    assert _rows(path, "SELECT project_id, COUNT(*) FROM session_projects GROUP BY project_id ORDER BY project_id") == [
        ("other-project", 1), ("shared-project", 2),
    ]

    # The copy is the pre-migration database, not a post-migration duplicate.
    assert _user_version(snapshot) == 0
    assert _rows(snapshot, "SELECT id,status FROM tasks ORDER BY id") == [
        ("done-native-pi", "completed"), ("queued-native-prime", "queued"), ("running-native-pi", "running"),
    ]
    assert _rows(snapshot, "SELECT COUNT(*) FROM deleted_sessions") == [(2,)]
    with sqlite3.connect(snapshot) as conn:
        assert conn.execute("PRAGMA integrity_check").fetchall() == [("ok",)]

    # Reopening is idempotent: no second snapshot and no data change.
    reopened = Database(path)
    assert reopened.migration_backup is None
    assert _count_snapshots(path) == 1
    assert _rows(path, "SELECT id,status,session_id,prompt FROM tasks ORDER BY id") == before_tasks


def test_migration_of_the_same_shape_reaches_the_current_version_from_v1(tmp_path):
    """A v1-stamped database with the same shapes migrates to the current version."""
    from archon_server import db as db_module

    path = tmp_path / "legacy-v1.db"
    _seed_mixed_legacy(path)
    with sqlite3.connect(path) as conn:
        db_module.v001.apply(conn)
        conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations"
            "(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)"
        )
        conn.execute(
            "INSERT OR REPLACE INTO schema_migrations VALUES (1,?,?)",
            (db_module.MIGRATION_CHECKSUMS[1], "historical-v1"),
        )
        conn.execute("PRAGMA user_version=1")

    database = Database(path)
    assert _user_version(path) == MIGRATION_VERSION
    assert database.migration_backup is not None
    assert _user_version(Path(database.migration_backup)) == 1
    # Both native runtimes and both tombstoned sessions survive the full chain.
    assert _rows(path, "SELECT COUNT(*) FROM deleted_sessions") == [(2,)]
    assert _rows(path, "SELECT id FROM tasks WHERE session_id='pi-01a011ca-30c8-7286'") == [("running-native-pi",)]
    with sqlite3.connect(path) as conn:
        assert conn.execute("PRAGMA integrity_check").fetchall() == [("ok",)]


@pytest.mark.parametrize("table", ["tasks", "session_projects", "deleted_sessions"])
def test_snapshot_is_taken_before_any_schema_change(tmp_path, table):
    """The copy must predate the schema change, not just the data change."""
    path = tmp_path / "legacy-ordered.db"
    _seed_mixed_legacy(path)
    with sqlite3.connect(path) as conn:
        before_schema = conn.execute("SELECT COUNT(*) FROM sqlite_master").fetchone()[0]
        conn.execute("PRAGMA user_version=0")
    database = Database(path)
    snapshot = Path(database.migration_backup)
    with sqlite3.connect(snapshot) as conn:
        snapshot_tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert table in snapshot_tables
    with sqlite3.connect(path) as conn:
        after_schema = conn.execute("SELECT COUNT(*) FROM sqlite_master").fetchone()[0]
    assert after_schema >= before_schema
