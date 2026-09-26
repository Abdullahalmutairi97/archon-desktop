import json
from pathlib import Path

import pytest

from archon_server.db import Database
from archon_server.ownership import SessionOwnershipService
from archon_server.services.workspace import PrimeSessionService
from archon_server.tasks import TaskStore


def _native_services(tmp_path):
    agent_root = tmp_path / 'prime-agent-sessions'
    agent_root.mkdir()
    pi_root = tmp_path / 'pi-agent-sessions'
    pi_root.mkdir()
    desktop_root = tmp_path / 'desktop-sessions'
    desktop_root.mkdir()
    store = TaskStore(Database(tmp_path / 'tasks.db'))
    sessions = PrimeSessionService(
        store.db, desktop_root, agent_root,
        pi_session_root=pi_root,
    )
    return store, sessions, agent_root, pi_root


def _write_header(path, session_id, cwd):
    path.write_text(json.dumps({
        'type': 'session', 'id': session_id, 'cwd': str(cwd),
        'timestamp': '2026-09-26T00:00:00Z',
    }) + '\n')


def test_unique_native_prime_header_verifies_empty_session(tmp_path):
    store, sessions, agent_root, _pi_root = _native_services(tmp_path)
    cwd = tmp_path / 'project'
    cwd.mkdir()
    session_id = 'native-prime-1'
    _write_header(agent_root / f'{session_id}.jsonl', session_id, cwd)
    ownership = SessionOwnershipService(store, sessions)

    result = ownership.reconcile(session_id)

    assert result['state'] == 'verified'
    assert result['runtime_id'] == 'prime'
    assert result['cwd'] == str(cwd)


def test_duplicate_native_prime_headers_require_review(tmp_path):
    store, sessions, agent_root, _pi_root = _native_services(tmp_path)
    first_cwd = tmp_path / 'first'
    second_cwd = tmp_path / 'second'
    first_cwd.mkdir()
    second_cwd.mkdir()
    session_id = 'native-prime-ambiguous'
    _write_header(agent_root / f'{session_id}.jsonl', session_id, first_cwd)
    _write_header(agent_root / 'duplicate.jsonl', session_id, second_cwd)
    ownership = SessionOwnershipService(store, sessions)

    result = ownership.reconcile(session_id)

    assert result['state'] == 'review_required'
    assert result['runtime_id'] is None
    assert result['cwd'] is None
    assert 'header' in result['reason'].lower() or 'ambiguous' in result['reason'].lower()


@pytest.mark.parametrize('header_id', [None, 'bad/slash', 17])
def test_malformed_native_header_for_existing_filename_requires_review(tmp_path, header_id):
    store, sessions, agent_root, _pi_root = _native_services(tmp_path)
    first_cwd = tmp_path / 'first'
    conflicting_cwd = tmp_path / 'conflicting'
    first_cwd.mkdir()
    conflicting_cwd.mkdir()
    session_id = 'native-existing'
    native_file = agent_root / f'{session_id}.jsonl'
    _write_header(native_file, session_id, first_cwd)
    task = store.submit('original', cwd=str(first_cwd), session_id=session_id,
                        profile='prime', runtime_id='prime', project_id=None)
    ownership = SessionOwnershipService(store, sessions)

    assert ownership.reconcile(task['session_id'])['state'] == 'verified'
    malformed = {'type': 'session', 'cwd': str(conflicting_cwd)}
    if header_id is not None:
        malformed['id'] = header_id
    native_file.write_text(json.dumps(malformed) + '\n')

    result = ownership.reconcile(task['session_id'])

    assert result['state'] == 'review_required'
    assert result['runtime_id'] == 'prime'
    assert result['cwd'] == str(first_cwd)
    assert 'header' in result['reason'].lower() or 'ambiguous' in result['reason'].lower()


def test_invalid_json_native_file_for_existing_owner_requires_review(tmp_path):
    store, sessions, agent_root, _pi_root = _native_services(tmp_path)
    first_cwd = tmp_path / 'first'
    first_cwd.mkdir()
    session_id = 'native-invalid-json'
    native_file = agent_root / f'{session_id}.jsonl'
    _write_header(native_file, session_id, first_cwd)
    task = store.submit('original', cwd=str(first_cwd), session_id=session_id,
                        profile='prime', runtime_id='prime', project_id=None)
    ownership = SessionOwnershipService(store, sessions)
    assert ownership.reconcile(task['session_id'])['state'] == 'verified'

    native_file.write_text('{"type":"session",\n')

    result = ownership.reconcile(task['session_id'])

    assert result['state'] == 'review_required'
    assert 'malformed' in result['reason'].lower()


def test_unreadable_native_file_for_existing_owner_requires_review(tmp_path, monkeypatch):
    store, sessions, agent_root, _pi_root = _native_services(tmp_path)
    first_cwd = tmp_path / 'first'
    first_cwd.mkdir()
    session_id = 'native-unreadable'
    native_file = agent_root / f'{session_id}.jsonl'
    _write_header(native_file, session_id, first_cwd)
    task = store.submit('original', cwd=str(first_cwd), session_id=session_id,
                        profile='prime', runtime_id='prime', project_id=None)
    ownership = SessionOwnershipService(store, sessions)
    assert ownership.reconcile(task['session_id'])['state'] == 'verified'

    original_open = Path.open

    def fail_native_read(path, *args, **kwargs):
        if path == native_file:
            raise OSError('fixture unreadable')
        return original_open(path, *args, **kwargs)

    monkeypatch.setattr(Path, 'open', fail_native_read)

    result = ownership.reconcile(task['session_id'])

    assert result['state'] == 'review_required'
    assert 'unreadable' in result['reason'].lower()


def test_unknown_legacy_profile_stays_review_required_even_with_prime_header(tmp_path):
    store, sessions, agent_root, _pi_root = _native_services(tmp_path)
    cwd = tmp_path / 'project'
    cwd.mkdir()
    session_id = 'legacy-alias-session'
    _write_header(agent_root / f'{session_id}.jsonl', session_id, cwd)
    store.submit('legacy', cwd=str(cwd), session_id=session_id,
                 profile='old-prime-alias', project_id=None)
    ownership = SessionOwnershipService(store, sessions)

    result = ownership.reconcile(session_id)

    assert result['state'] == 'review_required'
    assert result['runtime_id'] is None
    assert 'alias' in result['reason'].lower() or 'runtime' in result['reason'].lower()


def test_conflicting_task_runtime_marks_verified_owner_for_review_without_rebinding(tmp_path):
    store, sessions, _agent_root, _pi_root = _native_services(tmp_path)
    first_cwd = tmp_path / 'first'
    second_cwd = tmp_path / 'second'
    first_cwd.mkdir()
    second_cwd.mkdir()
    task = store.submit('original', cwd=str(first_cwd), session_id='owned-session',
                        profile='prime', runtime_id='prime', project_id=None)
    with store.db.transaction() as conn:
        conn.execute(
            """INSERT INTO tasks
               (id,prompt,cwd,session_id,profile,runtime_id,project_id,status,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            ('conflict', 'conflicting history', str(second_cwd), 'owned-session',
             'pi', 'pi', None, 'completed', '2026-09-26T00:00:01Z', '2026-09-26T00:00:01Z'),
        )
    ownership = SessionOwnershipService(store, sessions)

    result = ownership.reconcile(task['session_id'])

    assert result['state'] == 'review_required'
    assert result['runtime_id'] == 'prime'
    assert result['cwd'] == str(first_cwd)


def test_tombstoned_session_cannot_become_verified_again(tmp_path):
    store, sessions, agent_root, _pi_root = _native_services(tmp_path)
    cwd = tmp_path / 'project'
    cwd.mkdir()
    session_id = 'deleted-prime-session'
    _write_header(agent_root / f'{session_id}.jsonl', session_id, cwd)
    with store.db.transaction() as conn:
        conn.execute(
            "INSERT INTO deleted_sessions(session_id,deleted_at) VALUES (?,?)",
            (session_id, '2026-09-26T00:00:00Z'),
        )
    ownership = SessionOwnershipService(store, sessions)

    result = ownership.reconcile(session_id)

    assert result['state'] == 'review_required'
    assert 'deleted' in result['reason'].lower()


def test_native_pi_header_is_bound_to_pi_and_remains_read_only(tmp_path):
    store, sessions, _agent_root, pi_root = _native_services(tmp_path)
    cwd = tmp_path / 'project'
    cwd.mkdir()
    session_id = 'pi-history-1'
    _write_header(pi_root / f'{session_id}.jsonl', session_id, cwd)
    ownership = SessionOwnershipService(store, sessions)

    result = ownership.reconcile(f'pi-native-{session_id}')

    assert result['state'] == 'verified'
    assert result['runtime_id'] == 'pi'
    assert result['cwd'] == str(cwd)
    assert result['read_only'] is True
