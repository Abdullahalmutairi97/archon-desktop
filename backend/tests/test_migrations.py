import concurrent.futures
import fcntl
import sqlite3
import stat

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
        assert conn.execute('PRAGMA user_version').fetchone()[0] == 1
        ledger = conn.execute('SELECT version,checksum FROM schema_migrations').fetchall()
        assert [(r[0], r[1]) for r in ledger] == [(1, db_module.MIGRATION_CHECKSUM)]
        assert conn.execute('SELECT request_hash FROM tasks').fetchall()[0][0] is None
        assert [tuple(r) for r in conn.execute('SELECT id,status,session_id FROM tasks ORDER BY id')] == [
            ('active', 'running', 'prime-active'), ('pending', 'queued', 'native-session-123')]
    snapshots = list(tmp_path.glob('state.db.pre-v1-*.sqlite3'))
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
    assert list(tmp_path.glob('state.db.pre-v1-*.sqlite3')) == snapshots


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
            conn.execute('UPDATE schema_migrations SET version=2')
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
    assert len(rows(path, 'schema_migrations')) == 1
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
