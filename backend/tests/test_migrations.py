import concurrent.futures
import fcntl
import hashlib
import os
import sqlite3
import stat
import subprocess
import sys
from pathlib import Path

import pytest

from archon_server import db as db_module
from archon_server.db import Database, SCHEMA


def seed_legacy(path):
    with sqlite3.connect(path) as conn:
        conn.executescript(SCHEMA)
        conn.executemany(
            'INSERT INTO tasks(id,prompt,session_id,cwd,status,created_at,updated_at,started_at) VALUES (?,?,?,?,?,?,?,?)',
            [('pending', 'keep queued', 'native-session-123', '/workspace', 'queued', 'a', 'a', None),
             ('active', 'unknown effects', 'prime-active', '/workspace', 'running', 'b', 'b', 'b')],
        )
        conn.execute("INSERT INTO events(seq,task_id,type,data_json,created_at) VALUES (17,'active','task.running','{}','b')")
        conn.execute("INSERT INTO deleted_sessions VALUES ('deleted-native','c')")
        conn.execute("INSERT INTO session_projects VALUES ('native-session-123',NULL,'a')")


def rows(path, table):
    with sqlite3.connect(path) as conn:
        return conn.execute(f'SELECT * FROM {table}').fetchall()


def schema(path):
    with sqlite3.connect(path) as conn:
        return conn.execute('SELECT name,sql FROM sqlite_master ORDER BY name').fetchall()


def test_versioned_migration_preserves_history_and_verifiable_backup_restores_legacy(tmp_path):
    path = tmp_path / 'state.db'
    seed_legacy(path)
    original = {table: rows(path, table) for table in ['tasks', 'events', 'deleted_sessions', 'session_projects']}
    original_schema = schema(path)
    db = Database(path)
    with db.connect() as conn:
        assert conn.execute('PRAGMA user_version').fetchone()[0] == 2
        ledger = conn.execute('SELECT version,checksum FROM schema_migrations').fetchall()
        assert [(r[0], r[1]) for r in ledger] == [
            (1, db_module.MIGRATION_CHECKSUM), (2, db_module.MIGRATION_CHECKSUMS[2])
        ]
        assert conn.execute('SELECT request_hash FROM tasks').fetchall()[0][0] is None
        assert [tuple(r) for r in conn.execute('SELECT id,status,session_id FROM tasks ORDER BY id')] == [
            ('active', 'running', 'prime-active'), ('pending', 'queued', 'native-session-123')]
    snapshots = list(tmp_path.glob('state.db.pre-v2-*.sqlite3'))
    assert len(snapshots) == 1
    assert stat.S_IMODE(snapshots[0].stat().st_mode) == 0o600
    assert db.migration_backup == snapshots[0]
    # Restore into a new, offline destination using SQLite's backup API. The
    # deployment procedure archives the old DB/WAL/SHM family before installing it.
    restored = tmp_path / 'restored.db'
    with sqlite3.connect(snapshots[0]) as source, sqlite3.connect(restored) as destination:
        source.backup(destination)
        assert destination.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        assert destination.execute('PRAGMA user_version').fetchone()[0] == 0
    assert schema(restored) == original_schema
    for table, expected in original.items():
        assert rows(restored, table) == expected
    Database(path)
    assert list(tmp_path.glob('state.db.pre-v2-*.sqlite3')) == snapshots


def test_new_database_needs_no_snapshot(tmp_path):
    Database(tmp_path / 'new.db')
    assert list(tmp_path.glob('*.sqlite3')) == []


def test_old_ad_hoc_schema_normalized_atomically(tmp_path):
    path = tmp_path / 'legacy.db'
    with sqlite3.connect(path) as conn:
        conn.execute('CREATE TABLE tasks(id TEXT PRIMARY KEY,prompt TEXT,cwd TEXT,model TEXT,provider TEXT,skills_json TEXT,status TEXT,result_json TEXT,error TEXT,created_at TEXT,updated_at TEXT,started_at TEXT,completed_at TEXT)')
        conn.execute("INSERT INTO tasks(id,prompt,status,created_at,updated_at) VALUES ('old','preserved','queued','a','a')")
        conn.execute('CREATE TABLE session_locations(session_id TEXT PRIMARY KEY,cwd TEXT)')
        conn.execute("INSERT INTO session_locations VALUES ('native-old','/old')")
    db = Database(path)
    with db.connect() as conn:
        row = conn.execute('SELECT * FROM tasks').fetchone()
        assert row['prompt'] == 'preserved'
        assert row['approval_mode'] == 'approve'
        assert row['request_hash'] is None
        assert conn.execute('SELECT source FROM session_locations').fetchone()[0] == 'hermes'


@pytest.mark.parametrize('tamper', ['newer', 'checksum', 'gap', 'version_mismatch'])
def test_invalid_version_or_ledger_rejected_without_schema_mutation(tmp_path, tamper):
    path = tmp_path / 'state.db'
    Database(path)
    with sqlite3.connect(path) as conn:
        if tamper == 'newer':
            conn.execute('PRAGMA user_version=999')
        elif tamper == 'checksum':
            conn.execute("UPDATE schema_migrations SET checksum='modified'")
        elif tamper == 'gap':
            conn.execute('DELETE FROM schema_migrations WHERE version=1')
        else:
            conn.execute('PRAGMA user_version=0')
    before = schema(path)
    ledger = rows(path, 'schema_migrations')
    with pytest.raises(RuntimeError, match='version|checksum|ledger'):
        Database(path)
    assert schema(path) == before
    assert rows(path, 'schema_migrations') == ledger
    assert list(tmp_path.glob('*.sqlite3')) == []


def test_failed_migration_rolls_back_all_schema_and_data(tmp_path, monkeypatch):
    path = tmp_path / 'state.db'
    seed_legacy(path)
    before = schema(path)
    before_tasks = rows(path, 'tasks')
    def fail_after_alter(conn):
        conn.execute('ALTER TABLE tasks ADD COLUMN request_hash TEXT')
        conn.execute("UPDATE tasks SET prompt='should roll back'")
        raise RuntimeError('injected migration failure')
    monkeypatch.setattr(db_module.v001, 'apply', fail_after_alter)
    with pytest.raises(RuntimeError, match='injected'):
        Database(path)
    assert schema(path) == before
    assert rows(path, 'tasks') == before_tasks
    with sqlite3.connect(path) as conn:
        assert conn.execute('PRAGMA user_version').fetchone()[0] == 0
    assert len(list(tmp_path.glob('*.sqlite3'))) == 1


def test_v1_upgrade_creates_one_pre_v2_wal_inclusive_snapshot(tmp_path):
    path = tmp_path / 'v1.db'
    seed_legacy(path)
    with sqlite3.connect(path) as conn:
        db_module.v001.apply(conn)
        conn.execute('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)')
        conn.execute(
            'INSERT INTO schema_migrations VALUES (1,?,?)',
            (db_module.MIGRATION_CHECKSUM, 'historical-v1'),
        )
        conn.execute('PRAGMA user_version=1')
        conn.execute('PRAGMA journal_mode=WAL')
        conn.execute('PRAGMA wal_autocheckpoint=0')
        conn.execute("UPDATE tasks SET prompt='committed in v1 WAL' WHERE id='pending'")
        conn.commit()

    db = Database(path)
    assert db.migration_backup is not None
    assert db.migration_backup.name.startswith('v1.db.pre-v2-')
    assert stat.S_IMODE(db.migration_backup.stat().st_mode) == 0o600
    with sqlite3.connect(db.migration_backup) as backup:
        assert backup.execute('PRAGMA user_version').fetchone()[0] == 1
        assert backup.execute("SELECT prompt FROM tasks WHERE id='pending'").fetchone()[0] == 'committed in v1 WAL'
    assert len(list(tmp_path.glob('v1.db.pre-v2-*.sqlite3'))) == 1
    Database(path)
    assert len(list(tmp_path.glob('v1.db.pre-v2-*.sqlite3'))) == 1


def test_v2_migration_failure_rolls_back_v1_schema_and_ledger(tmp_path, monkeypatch):
    path = tmp_path / 'v1.db'
    seed_legacy(path)
    with sqlite3.connect(path) as conn:
        db_module.v001.apply(conn)
        conn.execute('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)')
        conn.execute(
            'INSERT INTO schema_migrations VALUES (1,?,?)',
            (db_module.MIGRATION_CHECKSUM, 'historical-v1'),
        )
        conn.execute('PRAGMA user_version=1')
    before = schema(path)
    before_tasks = rows(path, 'tasks')

    def fail_after_alter(conn):
        conn.execute('ALTER TABLE tasks ADD COLUMN runtime_id TEXT')
        conn.execute("UPDATE tasks SET prompt='should roll back'")
        raise RuntimeError('injected v2 failure')

    monkeypatch.setattr(db_module.v002, 'apply', fail_after_alter)
    with pytest.raises(RuntimeError, match='injected v2'):
        Database(path)
    assert schema(path) == before
    assert rows(path, 'tasks') == before_tasks
    assert rows(path, 'schema_migrations') == [(1, db_module.MIGRATION_CHECKSUM, 'historical-v1')]
    with sqlite3.connect(path) as conn:
        assert conn.execute('PRAGMA user_version').fetchone()[0] == 1


def test_v2_ledger_shape_and_old_v1_binary_are_checked_before_mutation(tmp_path, monkeypatch):
    path = tmp_path / 'state.db'
    Database(path)
    before = schema(path)
    with sqlite3.connect(path) as conn:
        conn.execute("UPDATE schema_migrations SET checksum='bad' WHERE version=2")
    bad_ledger = rows(path, 'schema_migrations')
    with pytest.raises(RuntimeError, match='checksum'):
        Database(path)
    assert schema(path) == before
    assert rows(path, 'schema_migrations') == bad_ledger

    with sqlite3.connect(path) as conn:
        conn.execute('UPDATE schema_migrations SET checksum=? WHERE version=2', (db_module.MIGRATION_CHECKSUMS[2],))
        conn.execute('ALTER TABLE task_attempts RENAME TO task_attempts_broken')
    malformed = schema(path)
    with pytest.raises(RuntimeError, match='schema'):
        Database(path)
    assert schema(path) == malformed

    # The v1 implementation reports its supported version as 1 and rejects a
    # v2 database before it can create, migrate, or otherwise alter any schema.
    with sqlite3.connect(path) as conn:
        conn.execute('ALTER TABLE task_attempts_broken RENAME TO task_attempts')
    before = schema(path)
    monkeypatch.setattr(db_module, 'MIGRATION_VERSION', 1)
    with pytest.raises(RuntimeError, match='newer'):
        Database(path)
    assert schema(path) == before


@pytest.mark.parametrize("trigger", [
    "task_attempt_snapshots_immutable",
    "task_admission_snapshots_immutable",
    "session_owner_verified_snapshot_immutable",
])
def test_v2_reopen_rejects_missing_immutable_trigger_without_repair(tmp_path, trigger):
    path = tmp_path / "state.db"
    Database(path)
    with sqlite3.connect(path) as conn:
        conn.execute(f"DROP TRIGGER {trigger}")
    before = schema(path)
    ledger = rows(path, "schema_migrations")

    with pytest.raises(RuntimeError, match="trigger"):
        Database(path)

    assert schema(path) == before
    assert rows(path, "schema_migrations") == ledger


def test_v2_reopen_rejects_trigger_with_changed_semantics_without_repair(tmp_path):
    path = tmp_path / "state.db"
    Database(path)
    with sqlite3.connect(path) as conn:
        conn.execute("DROP TRIGGER task_admission_snapshots_immutable")
        conn.execute(
            """CREATE TRIGGER task_admission_snapshots_immutable
               BEFORE UPDATE OF runtime_id,project_id ON tasks
               BEGIN SELECT 1; END"""
        )
    before = schema(path)
    ledger = rows(path, "schema_migrations")

    with pytest.raises(RuntimeError, match="altered"):
        Database(path)

    assert schema(path) == before
    assert rows(path, "schema_migrations") == ledger


def test_v2_reopen_rejects_missing_core_column_without_repair(tmp_path):
    path = tmp_path / "state.db"
    Database(path)
    with sqlite3.connect(path) as conn:
        conn.execute("ALTER TABLE tasks DROP COLUMN model")
    before = schema(path)
    ledger = rows(path, "schema_migrations")

    with pytest.raises(RuntimeError, match="malformed tasks"):
        Database(path)

    assert schema(path) == before
    assert rows(path, "schema_migrations") == ledger


def test_v2_reopen_rejects_missing_attempt_uniqueness_without_repair(tmp_path):
    path = tmp_path / "state.db"
    Database(path)
    with sqlite3.connect(path) as conn:
        conn.execute("PRAGMA foreign_keys=OFF")
        conn.execute("ALTER TABLE events RENAME TO events_old")
        conn.execute("ALTER TABLE task_attempts RENAME TO task_attempts_old")
        conn.execute(
            """CREATE TABLE task_attempts (
                 id TEXT PRIMARY KEY,
                 task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                 ordinal INTEGER NOT NULL CHECK(ordinal > 0),
                 state TEXT NOT NULL CHECK(state IN
                   ('claimed','running','completed','failed','cancelled','interrupted')),
                 claimed_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
                 cancel_requested_at TEXT,
                 runtime_id TEXT CHECK(runtime_id IS NULL OR runtime_id IN ('prime','pi')),
                 session_id TEXT, cwd TEXT, project_id TEXT, error TEXT
               )"""
        )
        conn.execute(
            """CREATE TABLE events (
                 seq INTEGER PRIMARY KEY AUTOINCREMENT,
                 task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                 type TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL,
                 attempt_id TEXT REFERENCES task_attempts(id) ON DELETE SET NULL
               )"""
        )
        conn.execute("DROP TABLE events_old")
        conn.execute("DROP TABLE task_attempts_old")
    before = schema(path)
    ledger = rows(path, "schema_migrations")

    with pytest.raises(RuntimeError, match="uniqueness"):
        Database(path)

    assert schema(path) == before
    assert rows(path, "schema_migrations") == ledger


def test_frozen_v1_database_code_accepts_v1_snapshot_and_refuses_v2_database(tmp_path):
    fixtures = Path(__file__).resolve().parent / "fixtures"
    old_db_path = fixtures / "published_v1_db.py"
    old_db = old_db_path.read_text()
    old_v001_path = Path(db_module.v001.__file__)
    old_v001 = old_v001_path.read_text()
    assert hashlib.sha256(old_db_path.read_bytes()).hexdigest() == (
        "53e5be5b82a00cec36945d936efe7030f958c5bc5e9675032f75e8bf11e4fd8c"
    )
    assert hashlib.sha256(old_v001_path.read_bytes()).hexdigest() == (
        "7d8a115753c61aff3eadc4058a2e0cd9482d88f6149359931697cd81a7581cf6"
    )
    package_root = tmp_path / "published-v1"
    package = package_root / "archon_server"
    migrations = package / "migrations"
    migrations.mkdir(parents=True)
    (package / "__init__.py").write_text("")
    (migrations / "__init__.py").write_text("")
    (package / "db.py").write_text(old_db)
    (migrations / "v001.py").write_text(old_v001)

    path = tmp_path / "legacy.db"
    seed_legacy(path)
    with sqlite3.connect(path) as conn:
        db_module.v001.apply(conn)
        conn.execute(
            "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)"
        )
        conn.execute(
            "INSERT INTO schema_migrations VALUES (1,?,?)",
            (db_module.MIGRATION_CHECKSUM, "historical-v1"),
        )
        conn.execute("PRAGMA user_version=1")
    upgraded = Database(path)
    assert upgraded.migration_backup is not None
    frozen_env = {**os.environ, "PYTHONPATH": str(package_root)}
    invoke = [sys.executable, "-c", "import sys; from archon_server.db import Database; Database(sys.argv[1])"]

    restored = tmp_path / "restored-v1.db"
    with sqlite3.connect(upgraded.migration_backup) as source, sqlite3.connect(restored) as destination:
        source.backup(destination)
    opened_snapshot = subprocess.run(
        [*invoke, str(restored)], cwd=tmp_path, env=frozen_env, text=True, capture_output=True,
    )
    assert opened_snapshot.returncode == 0, opened_snapshot.stderr
    with sqlite3.connect(restored) as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 1

    before = schema(path)
    ledger = rows(path, "schema_migrations")
    rejected_v2 = subprocess.run(
        [*invoke, str(path)], cwd=tmp_path, env=frozen_env, text=True, capture_output=True,
    )
    assert rejected_v2.returncode != 0
    assert "newer than this server supports" in rejected_v2.stderr
    assert schema(path) == before
    assert rows(path, "schema_migrations") == ledger


def test_legacy_owner_backfill_verifies_only_canonical_consistent_evidence(tmp_path):
    path = tmp_path / 'owners.db'
    with sqlite3.connect(path) as conn:
        conn.executescript(SCHEMA)
        rows_to_insert = [
            ('canonical-1', 'canonical', 'prime', '/same', 'queued'),
            ('canonical-2', 'canonical', 'prime', '/same', 'completed'),
            ('alias', 'alias', 'prime-default', '/alias', 'completed'),
            ('mixed-prime', 'mixed', 'prime', '/mixed', 'completed'),
            ('mixed-pi', 'mixed', 'pi', '/mixed', 'completed'),
            ('cwd-one', 'cwd conflict', 'pi', '/one', 'completed'),
            ('cwd-two', 'cwd conflict', 'pi', '/two', 'completed'),
            ('tombstoned', 'deleted', 'prime', '/deleted', 'completed'),
        ]
        conn.executemany(
            "INSERT INTO tasks(id,prompt,session_id,profile,cwd,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
            [(task_id, task_id, session_id, profile, cwd, status, 'a', 'a')
             for task_id, session_id, profile, cwd, status in rows_to_insert],
        )
        conn.execute("INSERT INTO deleted_sessions VALUES ('deleted','a')")
        conn.executemany(
            "INSERT INTO session_projects(session_id,project_id,updated_at) VALUES (?,?,?)",
            [('canonical', 'project-id-one', 'a'), ('alias', 'project-id-two', 'a')],
        )

    Database(path)
    with sqlite3.connect(path) as conn:
        conn.row_factory = sqlite3.Row
        owners = {row['session_id']: dict(row) for row in conn.execute('SELECT * FROM session_ownership')}
        task_projects = {row['id']: row['project_id'] for row in conn.execute('SELECT id,project_id FROM tasks')}
    assert owners['canonical']['state'] == 'verified'
    assert (owners['canonical']['runtime_id'], owners['canonical']['cwd']) == ('prime', '/same')
    for unresolved in ('alias', 'mixed', 'cwd conflict'):
        assert owners[unresolved]['state'] == 'review_required'
    assert owners['alias']['runtime_id'] is None
    assert 'deleted' not in owners
    assert task_projects['canonical-1'] == 'project-id-one'
    assert task_projects['alias'] == 'project-id-two'


def test_snapshot_includes_committed_wal_rows(tmp_path):
    path = tmp_path / 'wal.db'
    seed_legacy(path)
    writer = sqlite3.connect(path)
    try:
        writer.execute('PRAGMA journal_mode=WAL')
        writer.execute('PRAGMA wal_autocheckpoint=0')
        writer.execute("UPDATE tasks SET prompt='committed in WAL' WHERE id='pending'")
        writer.commit()
        db = Database(path)
        with sqlite3.connect(db.migration_backup) as backup:
            assert backup.execute("SELECT prompt FROM tasks WHERE id='pending'").fetchone()[0] == 'committed in WAL'
    finally:
        writer.close()


def test_parallel_initializers_migrate_only_once(tmp_path):
    path = tmp_path / 'state.db'
    seed_legacy(path)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda _: Database(path), range(4)))
    assert len(rows(path, 'schema_migrations')) == 2
    assert len(list(tmp_path.glob('*.sqlite3'))) == 1


def test_migration_sidecar_lock_is_bounded_and_rejects_symlink(tmp_path, monkeypatch):
    path = tmp_path / 'state.db'
    lock = tmp_path / 'state.db.migrate.lock'
    lock.touch(mode=0o600)
    monkeypatch.setattr(db_module, 'MIGRATION_LOCK_TIMEOUT', 0.02)
    with lock.open('r+') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with pytest.raises(RuntimeError, match='Timed out'):
            Database(path)
    lock.unlink()
    target = tmp_path / 'other'
    target.write_text('untouched')
    lock.symlink_to(target)
    with pytest.raises(OSError):
        Database(path)
    assert target.read_text() == 'untouched'


def test_unknown_future_database_is_rejected_before_legacy_bootstrap(tmp_path):
    path = tmp_path / 'future.db'
    with sqlite3.connect(path) as conn:
        conn.execute('CREATE TABLE future_marker(value TEXT)')
        conn.execute("INSERT INTO future_marker VALUES ('preserve')")
        conn.execute('PRAGMA user_version=99')
    before = schema(path)
    with pytest.raises(RuntimeError, match='newer'):
        Database(path)
    assert schema(path) == before
    assert rows(path, 'future_marker') == [('preserve',)]
    assert list(tmp_path.glob('*.sqlite3')) == []


def test_failed_snapshot_aborts_before_schema_change_and_cleans_partial_file(tmp_path, monkeypatch):
    path = tmp_path / 'state.db'
    seed_legacy(path)
    before = schema(path)
    monkeypatch.setattr(db_module, 'SNAPSHOT_TIMEOUT', -1)
    with pytest.raises(RuntimeError, match='snapshot'):
        Database(path)
    assert schema(path) == before
    assert list(tmp_path.glob('*.sqlite3*')) == []
    assert stat.S_IMODE((tmp_path / 'state.db.migrate.lock').stat().st_mode) == 0o600


def test_minimal_supported_legacy_task_decodes_after_migration(tmp_path):
    from archon_server.tasks import TaskStore
    path = tmp_path / 'minimal.db'
    with sqlite3.connect(path) as conn:
        conn.execute('CREATE TABLE tasks(id TEXT PRIMARY KEY,prompt TEXT NOT NULL,cwd TEXT,status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)')
        conn.execute("INSERT INTO tasks VALUES ('legacy','keep me','/workspace','completed','a','a')")
    task = TaskStore(Database(path)).get('legacy')
    assert task['prompt'] == 'keep me'
    assert task['status'] == 'completed'
    assert task['cwd'] == '/workspace'
    assert task['skills'] == []
    assert task['result'] is None
    assert task['model'] is None
    assert task['provider'] is None
    assert task['started_at'] is None
    assert task['completed_at'] is None
    with sqlite3.connect(path) as conn:
        assert conn.execute("SELECT request_hash FROM tasks WHERE id='legacy'").fetchone()[0] is None


def test_unrecognizable_legacy_schema_is_rejected_without_changes(tmp_path):
    path = tmp_path / 'unknown.db'
    with sqlite3.connect(path) as conn:
        conn.execute('CREATE TABLE tasks(id TEXT PRIMARY KEY,unrelated TEXT)')
        conn.execute("INSERT INTO tasks VALUES ('one','preserve')")
    before = schema(path)
    with pytest.raises(RuntimeError, match='Unsupported legacy'):
        Database(path)
    assert schema(path) == before
    assert rows(path, 'tasks') == [('one', 'preserve')]
