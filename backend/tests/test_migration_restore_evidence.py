"""Restore and import evidence for the P1 M1.5 migration snapshot items.

Two M1.5 bullets stay open after the existing evidence: restore/import coverage for
the mixed legacy shapes, and a tested compatibility procedure that restores the
pre-migration copy instead of opening an incompatible newer schema with an older
binary.

`test_migration_evidence.py` seeds the mixed shape (two sessions on one project id,
native Prime and Pi ids, two tombstoned sessions, queued/running/completed tasks) and
proves that the migration preserves it. `test_migrations.py` proves that the snapshot
exists, is private and restores row-for-row into a new path. The gap this module closes
is the *current* code path: the restored copy is opened by the current `Database`, must
re-migrate to `MIGRATION_VERSION`, keep every row, status, native session id, project
mapping, tombstone and reconciled owner state, write its own pre-migration copy, and
reach the same `sqlite_master` schema as a directly migrated database, while the
snapshot file itself is never mutated. The last test drives the frozen published-v1
binary from `tests/fixtures/published_v1_db.py` through the same procedure: that older
reader opens the restored pre-migration copy and refuses the migrated database.

The restore step mirrors the documented rollback procedure in
`docs/releases/phase-1c1-durable-admission.md`: SQLite's backup API into a new offline
destination, `PRAGMA integrity_check` ok, the snapshot's original `user_version`, and
mode 0600 preserved on the copy.
"""
from __future__ import annotations

import hashlib
import os
import sqlite3
import stat
import subprocess
import sys
from pathlib import Path

from archon_server import db as db_module
from archon_server.db import Database, MIGRATION_VERSION
from test_migration_evidence import _seed_mixed_legacy

# The mixed-shape seed's native session ids in id order, and its tombstones.
NATIVE_SESSION_IDS = ("pi-01a011ca-30c8-7286", "pi-01a011ed-58a6-74f4", "prime-01a0118e-4d54e-70b1")
TOMBSTONED_SESSION_IDS = ("pi-tombstoned-01a01fb2", "prime-tombstoned-01a01c43")

# Migration-invariant projections. Timestamps written by a migration (legacy
# `session_ownership` reconciliation) are excluded because two migrations of the same
# rows run at different wall-clock times; everything that identifies or classifies a
# legacy row is included.
PROJECTIONS = {
    "tasks": "SELECT id,prompt,session_id,cwd,status,started_at FROM tasks ORDER BY id",
    "events": "SELECT seq,task_id,type,data_json FROM events ORDER BY seq",
    "session_locations": "SELECT session_id,cwd,source FROM session_locations ORDER BY session_id",
    "session_projects": "SELECT session_id,project_id FROM session_projects ORDER BY session_id",
    "deleted_sessions": "SELECT session_id FROM deleted_sessions ORDER BY session_id",
    "session_ownership": "SELECT session_id,runtime_id,cwd,state,reason FROM session_ownership ORDER BY session_id",
}
LEGACY_TABLES = ("tasks", "events", "session_locations", "session_projects", "deleted_sessions")
CURRENT_TABLES = (*LEGACY_TABLES, "session_ownership")
# Tables a migration must carry over unchanged, row for row.
ROWS_PRESERVED_BY_MIGRATION = ("tasks", "events", "session_projects", "deleted_sessions")

FROZEN_PUBLISHED_V1_DB_SHA256 = "53e5be5b82a00cec36945d936efe7030f958c5bc5e9675032f75e8bf11e4fd8c"
FROZEN_PUBLISHED_V1_MIGRATION_SHA256 = "7d8a115753c61aff3eadc4058a2e0cd9482d88f6149359931697cd81a7581cf6"


def _legacy_database(path: Path) -> Path:
    """The mixed-shape version-0 database that both evidence items start from."""
    _seed_mixed_legacy(path)
    with sqlite3.connect(path) as conn:
        conn.execute("PRAGMA user_version=0")
    return path


def _read(path: Path, sql: str) -> list[tuple]:
    with sqlite3.connect(path) as conn:
        return [tuple(row) for row in conn.execute(sql)]


def _projected_rows(path: Path, tables: tuple[str, ...] = LEGACY_TABLES) -> dict[str, list[tuple]]:
    return {name: _read(path, PROJECTIONS[name]) for name in tables}


def _schema(path: Path) -> list[tuple]:
    return _read(path, "SELECT name,sql FROM sqlite_master ORDER BY name")


def _ledger(path: Path) -> list[tuple]:
    return _read(path, "SELECT version,checksum FROM schema_migrations ORDER BY version")


def _user_version(path: Path) -> int:
    with sqlite3.connect(path) as conn:
        return int(conn.execute("PRAGMA user_version").fetchone()[0])


def _integrity_ok(path: Path) -> bool:
    return _read(path, "PRAGMA integrity_check") == [("ok",)]


def _digest(path: Path) -> tuple[int, str]:
    data = path.read_bytes()
    return len(data), hashlib.sha256(data).hexdigest()


def _snapshots(path: Path) -> list[Path]:
    return sorted(path.parent.glob(path.name + ".pre-v*"))


def _session_ids(path: Path, table: str) -> list[str]:
    return [row[0] for row in _read(path, f"SELECT session_id FROM {table} ORDER BY session_id")]


def _restore_snapshot(snapshot: Path, destination: Path) -> Path:
    """Restore a verified pre-migration copy into a new offline destination.

    This is the documented rollback procedure: SQLite's backup API into a new path
    (never an in-place copy over a live database), integrity and original-version
    validation, and mode 0600 preserved on the restored copy.
    """
    with sqlite3.connect(snapshot) as source, sqlite3.connect(destination) as restored:
        source.backup(restored)
        assert _integrity_ok(destination)
        assert source.execute("PRAGMA user_version").fetchone()[0] == 0
    os.chmod(destination, 0o600)
    return destination


def test_restored_pre_migration_copy_remigrates_and_keeps_every_legacy_row(tmp_path):
    legacy = _legacy_database(tmp_path / "legacy.db")
    before = _projected_rows(legacy)
    before_schema = _schema(legacy)

    migrated = Database(legacy)
    assert migrated.migration_backup is not None
    snapshot = Path(migrated.migration_backup)
    assert snapshot.name.startswith("legacy.db.pre-v5-")
    assert stat.S_IMODE(snapshot.stat().st_mode) == 0o600

    restored = _restore_snapshot(snapshot, tmp_path / "restored.db")

    # The restored copy is the legacy database, not a post-migration duplicate.
    assert _user_version(restored) == 0
    assert _schema(restored) == before_schema
    assert _projected_rows(restored) == before
    assert stat.S_IMODE(restored.stat().st_mode) == 0o600

    # The current code imports the restored copy: it re-migrates to the current
    # version and writes its own pre-migration copy next to itself.
    imported = Database(restored)
    assert _user_version(restored) == MIGRATION_VERSION
    assert imported.migration_backup is not None
    own_snapshot = Path(imported.migration_backup)
    assert own_snapshot.name.startswith("restored.db.pre-v5-")
    assert own_snapshot != snapshot
    assert _user_version(own_snapshot) == 0
    assert _projected_rows(own_snapshot) == before
    assert _snapshots(restored) == [own_snapshot]

    imported_rows = _projected_rows(restored, CURRENT_TABLES)
    for table in ROWS_PRESERVED_BY_MIGRATION:
        assert imported_rows[table] == before[table], table
    # Migration 1 seeds the session-location registry from task history, so the seeded
    # rows must survive unchanged rather than be replaced.
    assert set(before["session_locations"]) <= set(imported_rows["session_locations"])
    # Two native session ids still share one project id and the third stays separate;
    # the imported rows keep their own ids instead of a normalized one.
    assert [row for row in imported_rows["session_projects"] if row[1] == "shared-project"] == [
        ("pi-01a011ca-30c8-7286", "shared-project"),
        ("prime-01a0118e-4d54e-70b1", "shared-project"),
    ]
    assert [row[0] for row in imported_rows["tasks"] if row[4] in {"queued", "running"}] == [
        "queued-native-prime", "running-native-pi",
    ]
    assert [row[2] for row in imported_rows["tasks"] if row[4] in {"queued", "running"}] == [
        "prime-01a0118e-4d54e-70b1", "pi-01a011ca-30c8-7286",
    ]
    assert [row[0] for row in imported_rows["deleted_sessions"]] == list(TOMBSTONED_SESSION_IDS)

    # Legacy ownership reconciliation runs on the imported rows, and tombstoned
    # sessions never become owner records.
    ownership = imported_rows["session_ownership"]
    assert [row[0] for row in ownership] == list(NATIVE_SESSION_IDS)
    assert {row[3] for row in ownership} == {"review_required"}
    assert not {row[0] for row in ownership} & set(TOMBSTONED_SESSION_IDS)

    # Reopening the restored database is idempotent and keeps the imported rows.
    Database(restored)
    assert _snapshots(restored) == [own_snapshot]
    assert _user_version(restored) == MIGRATION_VERSION
    assert _projected_rows(restored, CURRENT_TABLES) == imported_rows


def test_restored_import_reaches_the_same_schema_and_ledger_as_a_direct_migration(tmp_path):
    legacy = _legacy_database(tmp_path / "legacy.db")
    direct = Database(legacy)
    assert direct.migration_backup is not None

    restored = _restore_snapshot(Path(direct.migration_backup), tmp_path / "restored.db")
    Database(restored)

    assert _user_version(legacy) == MIGRATION_VERSION
    assert _user_version(restored) == MIGRATION_VERSION
    # Same objects with the same SQL text, including indexes and triggers.
    assert _schema(restored) == _schema(legacy)
    assert _ledger(restored) == _ledger(legacy)
    assert [row[0] for row in _ledger(restored)] == list(range(1, MIGRATION_VERSION + 1))
    assert _ledger(restored)[0][1] == db_module.MIGRATION_CHECKSUM
    assert _integrity_ok(legacy) and _integrity_ok(restored)
    # The import is not a private variant of the schema: both lineages agree on the
    # projected rows, including the reconciled owner state.
    imported_rows = _projected_rows(restored, CURRENT_TABLES)
    assert imported_rows == _projected_rows(legacy, CURRENT_TABLES)
    assert _session_ids(restored, "session_ownership") == list(NATIVE_SESSION_IDS)


def test_restore_and_import_never_mutate_the_pre_migration_snapshot(tmp_path):
    legacy = _legacy_database(tmp_path / "legacy.db")
    database = Database(legacy)
    assert database.migration_backup is not None
    snapshot = Path(database.migration_backup)
    before = (_digest(snapshot), stat.S_IMODE(snapshot.stat().st_mode), _projected_rows(snapshot))
    assert _integrity_ok(snapshot)

    restored = _restore_snapshot(snapshot, tmp_path / "restored.db")
    Database(restored)
    Database(restored)

    assert (_digest(snapshot), stat.S_IMODE(snapshot.stat().st_mode), _projected_rows(snapshot)) == before
    assert _user_version(snapshot) == 0
    assert _integrity_ok(snapshot)
    # Restoring and importing leave no WAL/SHM family beside the snapshot.
    assert sorted(snapshot.parent.glob(snapshot.name + "-*")) == []


def _published_v1_package(tmp_path: Path) -> Path:
    """Materialize the hash-checked frozen published-v1 database code as a package."""
    fixtures = Path(__file__).resolve().parent / "fixtures"
    published_db = fixtures / "published_v1_db.py"
    published_migration = Path(db_module.v001.__file__)
    assert hashlib.sha256(published_db.read_bytes()).hexdigest() == FROZEN_PUBLISHED_V1_DB_SHA256
    assert hashlib.sha256(published_migration.read_bytes()).hexdigest() == FROZEN_PUBLISHED_V1_MIGRATION_SHA256
    package_root = tmp_path / "published-v1"
    package = package_root / "archon_server"
    (package / "migrations").mkdir(parents=True)
    (package / "__init__.py").write_text("")
    (package / "migrations" / "__init__.py").write_text("")
    (package / "db.py").write_text(published_db.read_text())
    (package / "migrations" / "v001.py").write_text(published_migration.read_text())
    return package_root


def test_older_published_binary_opens_the_restored_copy_and_refuses_the_migrated_one(tmp_path):
    legacy = _legacy_database(tmp_path / "legacy.db")
    current = Database(legacy)
    assert current.migration_backup is not None
    snapshot = Path(current.migration_backup)
    opened_by_old_code = _restore_snapshot(snapshot, tmp_path / "restored-legacy.db")
    rejected_by_old_code = _restore_snapshot(snapshot, tmp_path / "restored-migrated.db")
    Database(rejected_by_old_code)
    assert _user_version(rejected_by_old_code) == MIGRATION_VERSION

    environment = {**os.environ, "PYTHONPATH": str(_published_v1_package(tmp_path))}
    invoke = [sys.executable, "-c", "import sys; from archon_server.db import Database; Database(sys.argv[1])"]

    # The published prior binary opens the restored pre-migration copy and upgrades it
    # to its own final version: the documented rollback destination stays readable.
    opened = subprocess.run([*invoke, str(opened_by_old_code)], cwd=tmp_path, env=environment,
                            text=True, capture_output=True, timeout=60)
    assert opened.returncode == 0, opened.stderr
    assert _user_version(opened_by_old_code) == 1
    old_snapshots = _snapshots(opened_by_old_code)
    assert len(old_snapshots) == 1
    assert ".pre-v1-" in old_snapshots[0].name
    assert _projected_rows(opened_by_old_code)["tasks"] == _projected_rows(legacy)["tasks"]

    # The same older binary refuses the migrated database instead of opening a newer
    # schema, and the refusal changes nothing: no snapshot and no byte changed.
    snapshots_before = _snapshots(rejected_by_old_code)
    before = (_schema(rejected_by_old_code), _ledger(rejected_by_old_code), _digest(rejected_by_old_code))
    refused = subprocess.run([*invoke, str(rejected_by_old_code)], cwd=tmp_path, env=environment,
                             text=True, capture_output=True, timeout=60)
    assert refused.returncode != 0
    assert "newer than this server supports" in refused.stderr
    assert (_schema(rejected_by_old_code), _ledger(rejected_by_old_code),
            _digest(rejected_by_old_code)) == before
    assert _snapshots(rejected_by_old_code) == snapshots_before
