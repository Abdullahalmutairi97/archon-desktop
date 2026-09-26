from concurrent.futures import ThreadPoolExecutor
import sqlite3
from threading import Barrier

import pytest

from archon_server import db as db_module
from archon_server.db import Database
from archon_server.migrations import v001
from archon_server.tasks import TaskStore, hash_request_payload


@pytest.fixture
def store(tmp_path):
    return TaskStore(Database(tmp_path / 'tasks.db'))


def test_payload_hash_is_stable_and_preserves_list_order():
    first = hash_request_payload({'prompt': 'مرحبا', 'skills': ['one', 'two']})
    assert len(first) == 64
    assert first == hash_request_payload({'skills': ['one', 'two'], 'prompt': 'مرحبا'})
    assert first != hash_request_payload({'prompt': 'مرحبا', 'skills': ['two', 'one']})


def test_same_request_returns_original_after_completion_without_new_event(store):
    first = store.submit('perform side effect', request_id='telegram-17', project_id=None)
    attempt_id = store.mark_running(first['id'])
    store.complete(first['id'], {'text': 'finished'}, attempt_id=attempt_id)
    events = store.all_events(0)
    again = store.submit('perform side effect', request_id='telegram-17', project_id=None)
    assert again['id'] == first['id']
    assert again['session_id'] == first['session_id']
    assert again['status'] == 'completed'
    assert again['result'] == {'text': 'finished'}
    assert len(store.list()) == 1
    assert store.all_events(0) == events
    assert 'request_hash' not in again
    assert 'request_hash' not in store.list()[0]


BASE_PAYLOAD = {
    'prompt': 'perform side effect', 'cwd': '/workspace/first', 'model': 'model-1',
    'provider': 'provider-1', 'skills': ['one', 'two'], 'session_id': 'prime-existing',
    'approval_mode': 'auto', 'chat_only': False, 'profile': 'prime', 'project_id': 'p1',
}


@pytest.mark.parametrize('field,value', [
    ('prompt', 'different side effect'), ('cwd', '/workspace/other'), ('model', 'model-2'),
    ('provider', 'provider-2'), ('skills', ['two', 'one']), ('session_id', 'prime-other'),
    ('approval_mode', 'plan'), ('chat_only', True), ('profile', 'pi'),
    ('project_id', None), ('project_id', 'p2'),
])
def test_changed_semantic_payload_conflicts_without_creating_work(store, field, value):
    first = store.submit(**BASE_PAYLOAD, request_id='request-1')
    changed = {**BASE_PAYLOAD, field: value}
    with pytest.raises(ValueError, match='payload|different|conflict'):
        store.submit(**changed, request_id='request-1')
    assert store.get(first['id'])['prompt'] == BASE_PAYLOAD['prompt']
    assert len(store.list()) == 1
    assert len(store.all_events(0)) == 1


@pytest.mark.parametrize('first_specified', [True, False])
def test_project_binding_presence_is_part_of_request_identity(store, first_specified):
    explicit = {'project_id': None}
    first = explicit if first_specified else {}
    changed = {} if first_specified else explicit
    store.submit('work', request_id='request-1', **first)
    with pytest.raises(ValueError, match='payload|different|conflict'):
        store.submit('work', request_id='request-1', **changed)


def test_no_request_key_never_deduplicates(store):
    first = store.submit('same work')
    second = store.submit('same work')
    assert first['id'] != second['id']
    assert first['session_id'] != second['session_id']
    with store.db.connect() as conn:
        assert [row['request_hash'] for row in conn.execute('SELECT request_hash FROM tasks')] == [None, None]


def test_lookup_returns_original_for_server_payload_before_workspace_admission(store):
    request_hash = hash_request_payload({'prompt': 'work', 'cwd': 'original request'})
    assert store.lookup_request('request-1', request_hash) is None
    first = store.submit('work', cwd='/resolved/workspace', request_id='request-1', request_hash=request_hash)
    looked_up = store.lookup_request('request-1', request_hash)
    assert looked_up['id'] == first['id']
    assert looked_up['cwd'] == '/resolved/workspace'
    assert 'request_hash' not in looked_up
    with pytest.raises(ValueError, match='payload|different|conflict'):
        store.lookup_request('request-1', hash_request_payload({'prompt': 'other work'}))


def test_explicit_server_hash_normalizes_hex_case(store):
    fingerprint = hash_request_payload({'prompt': 'work'})
    first = store.submit('work', request_id='request-1', request_hash=fingerprint.upper())
    assert store.lookup_request('request-1', fingerprint)['id'] == first['id']


@pytest.mark.parametrize('request_id', ['', 'has space', 'path/slash', 'k' * 201])
def test_invalid_request_keys_fail_before_persistence(store, request_id):
    with pytest.raises(ValueError, match='request'):
        store.submit('work', request_id=request_id)
    with pytest.raises(ValueError, match='request'):
        store.lookup_request(request_id, 'a' * 64)
    assert store.list() == []


@pytest.mark.parametrize('fingerprint', ['', 'a' * 63, 'a' * 65, 'g' * 64])
def test_invalid_server_hash_fails_before_persistence(store, fingerprint):
    with pytest.raises(ValueError, match='hash'):
        store.submit('work', request_id='request-1', request_hash=fingerprint)
    with pytest.raises(ValueError, match='hash'):
        store.lookup_request('request-1', fingerprint)
    assert store.list() == []


def test_server_hash_requires_explicit_request_key(store):
    with pytest.raises(ValueError, match='request'):
        store.submit('work', request_hash='a' * 64)
    assert store.list() == []


def test_v1_internal_fingerprint_retries_after_v2_migration(tmp_path):
    path = tmp_path / 'v1-internal.db'
    request_id = 'v1-internal'
    fields = {
        'prompt': 'retry preserved v1 task', 'cwd': '/workspace', 'model': 'model-1',
        'provider': 'provider-1', 'skills': ['one'], 'session_id': 'prime-existing',
        'approval_mode': 'approve', 'chat_only': False, 'profile': 'prime',
        'project_binding': {'specified': True, 'project_id': 'project-a'},
    }
    # This is the published v1 implicit TaskStore fingerprint: canonical
    # runtime identity was represented by the profile field, not a new field.
    legacy_fingerprint = hash_request_payload(fields)
    with sqlite3.connect(path) as conn:
        v001.apply(conn)
        conn.execute(
            'CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)'
        )
        conn.execute(
            'INSERT INTO schema_migrations VALUES (1,?,?)',
            (db_module.MIGRATION_CHECKSUM, 'historical-v1'),
        )
        conn.execute(
            """INSERT INTO tasks
               (id,prompt,cwd,model,provider,session_id,profile,approval_mode,chat_only,skills_json,
                status,result_json,created_at,updated_at,request_hash)
               VALUES (?,?,?,?,?,?,?,?,?,?,'completed',?,?,?,?)""",
            (request_id, fields['prompt'], fields['cwd'], fields['model'], fields['provider'],
             fields['session_id'], fields['profile'], fields['approval_mode'], int(fields['chat_only']),
             '["one"]', '{"text":"already done"}', 'created', 'updated', legacy_fingerprint),
        )
        conn.execute(
            "INSERT INTO session_projects(session_id,project_id,updated_at) VALUES (?,?,?)",
            (fields['session_id'], 'project-a', 'updated'),
        )
        conn.execute(
            "INSERT INTO events(task_id,type,data_json,created_at) VALUES (?,?,?,?)",
            (request_id, 'task.queued', '{"status":"queued"}', 'created'),
        )
        conn.execute('PRAGMA user_version=1')

    store = TaskStore(Database(path))
    before_events = store.all_events(0)
    retried = store.submit(
        fields['prompt'], cwd=fields['cwd'], model=fields['model'], provider=fields['provider'],
        skills=fields['skills'], session_id=fields['session_id'], approval_mode=fields['approval_mode'],
        chat_only=fields['chat_only'], profile='prime', runtime_id='prime', request_id=request_id,
        project_id='project-a',
    )
    assert retried['id'] == request_id
    assert retried['status'] == 'completed'
    assert retried['result'] == {'text': 'already done'}
    assert store.all_events(0) == before_events


def test_runtime_identity_cannot_change_under_same_internal_request_key(store):
    store.submit('runtime scoped', request_id='canonical-profile', profile='prime', runtime_id='prime')
    with pytest.raises(ValueError, match='runtime id must match'):
        store.submit('runtime scoped', request_id='canonical-profile', profile='prime', runtime_id='pi')

    store.submit('runtime scoped', request_id='explicit-runtime', runtime_id='prime')
    with pytest.raises(ValueError, match='different request payload'):
        store.submit('runtime scoped', request_id='explicit-runtime', runtime_id='pi')


def test_legacy_task_without_hash_cannot_be_reinterpreted_as_retry(store):
    legacy = store.submit('legacy work')
    fingerprint = hash_request_payload({'prompt': 'legacy work'})
    with pytest.raises(ValueError, match='legacy|fingerprint|hash'):
        store.lookup_request(legacy['id'], fingerprint)
    with pytest.raises(ValueError, match='legacy|fingerprint|hash'):
        store.submit('legacy work', request_id=legacy['id'])
    assert len(store.list()) == 1
    assert len(store.all_events(0)) == 1


def test_concurrent_same_key_and_payload_create_one_task_and_event(store):
    barrier = Barrier(8)

    def submit():
        barrier.wait(timeout=10)
        return store.submit('one side effect', request_id='concurrent-request', project_id=None)

    with ThreadPoolExecutor(max_workers=8) as workers:
        results = list(workers.map(lambda _: submit(), range(8)))
    assert {task['id'] for task in results} == {'concurrent-request'}
    assert len(store.list()) == 1
    assert len(store.all_events(0)) == 1


def test_concurrent_same_key_different_payload_has_one_winner(store):
    barrier = Barrier(2)

    def submit(prompt):
        barrier.wait(timeout=10)
        try:
            return store.submit(prompt, request_id='conflicting-request')['prompt']
        except ValueError:
            return 'conflict'

    with ThreadPoolExecutor(max_workers=2) as workers:
        results = list(workers.map(submit, ['first payload', 'second payload']))
    assert results.count('conflict') == 1
    assert len(store.list()) == 1
    assert len(store.all_events(0)) == 1


def test_failed_project_binding_does_not_reserve_request_key(store):
    request_hash = hash_request_payload({'prompt': 'work'})
    with store.db.transaction() as conn:
        conn.execute("CREATE TRIGGER reject_binding BEFORE INSERT ON session_projects "
                     "BEGIN SELECT RAISE(ABORT, 'binding rejected'); END")
    with pytest.raises(Exception, match='binding rejected'):
        store.submit('work', request_id='request-1', request_hash=request_hash, project_id=None)
    assert store.lookup_request('request-1', request_hash) is None
    assert store.all_events(0) == []
    with store.db.transaction() as conn:
        conn.execute('DROP TRIGGER reject_binding')
    task = store.submit('work', request_id='request-1', request_hash=request_hash, project_id=None)
    assert task['id'] == 'request-1'
    assert len(store.all_events(0)) == 1
