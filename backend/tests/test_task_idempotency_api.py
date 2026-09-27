from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from archon_server.app import create_app
from archon_server.config import Settings


class Runner:
    async def run(self, task, emit):
        raise AssertionError('Admission tests never launch a runner')


@pytest.fixture
def api(tmp_path):
    settings = Settings(archon_root=tmp_path, hermes_home=tmp_path / '.hermes',
                        data_dir=tmp_path / '.data', auth_token='test', start_worker=False)
    app = create_app(settings, runner=Runner())
    with TestClient(app) as client:
        client.headers['Authorization'] = 'Bearer test'
        yield client, app, tmp_path


def submit(client, key='request-1', **changes):
    return client.post('/api/tasks', headers={'Idempotency-Key': key},
                       json={'prompt': 'work', 'approval_mode': 'auto', **changes})


def test_identical_retry_returns_original_task_and_single_event(api):
    client, app, _ = api
    first = submit(client)
    second = submit(client)
    assert first.status_code == second.status_code == 202
    assert first.json() == second.json()
    assert len(app.state.store.list()) == len(app.state.store.all_events(0)) == 1
    assert 'request_hash' not in first.json()['task']


@pytest.mark.parametrize('change', [{'prompt': 'different'}, {'approval_mode': 'plan'},
                                   {'skills': ['new']}, {'profile': 'pi'}, {'chat_only': True}])
def test_same_key_with_changed_payload_conflicts_without_admission(api, change):
    client, app, _ = api
    assert submit(client).status_code == 202
    denied = submit(client, **change)
    assert denied.status_code == 409, denied.text
    assert len(app.state.store.list()) == len(app.state.store.all_events(0)) == 1


def test_retry_returns_accepted_task_even_if_workspace_disappeared(api):
    client, app, root = api
    folder = root / 'working'
    folder.mkdir()
    first = submit(client, cwd=str(folder))
    assert first.status_code == 202
    folder.rmdir()
    retry = submit(client, cwd=str(folder))
    assert retry.status_code == 202, retry.text
    assert retry.json() == first.json()
    assert len(app.state.store.list()) == 1


def test_concurrent_retries_commit_one_task(api):
    client, app, _ = api
    with ThreadPoolExecutor(max_workers=4) as pool:
        responses = list(pool.map(lambda _: submit(client), range(8)))
    assert {response.status_code for response in responses} == {202}
    assert len({response.json()['task']['id'] for response in responses}) == 1
    assert len(app.state.store.list()) == len(app.state.store.all_events(0)) == 1


@pytest.mark.parametrize('key', ['', 'bad key', 'a' * 201])
def test_invalid_idempotency_keys_are_rejected(api, key):
    client, app, _ = api
    response = submit(client, key=key)
    assert response.status_code == 409, response.text
    assert app.state.store.list() == []


def test_idempotency_lookup_remains_authenticated(api):
    client, app, _ = api
    assert submit(client).status_code == 202
    client.headers.pop('Authorization')
    assert submit(client).status_code == 401
    assert len(app.state.store.list()) == 1


def test_longest_key_produces_a_resumable_session(api):
    client, _, _ = api
    first = submit(client, key='a' * 200)
    assert first.status_code == 202, first.text
    session_id = first.json()['task']['session_id']
    assert len(session_id) <= 200
    assert client.get(f'/api/sessions/{session_id}/messages').status_code == 200

    # Distinct keys with a long shared prefix must not alias after bounding the
    # generated session identity.
    other = submit(client, key='a' * 199 + 'b')
    assert other.status_code == 202, other.text
    assert other.json()['task']['id'] != first.json()['task']['id']
    assert other.json()['task']['session_id'] != session_id

    # A later short key can equal the long key's hash suffix. It remains its
    # own task and receives a separate session identity instead of aliasing.
    short_key = session_id.removeprefix('prime-')
    short = submit(client, key=short_key)
    assert short.status_code == 202, short.text
    assert short.json()['task']['id'] == short_key
    assert short.json()['task']['session_id'] != session_id

    resumed = submit(client, key='follow-up', session_id=session_id)
    assert resumed.status_code == 202, resumed.text
    assert resumed.json()['task']['session_id'] == session_id
