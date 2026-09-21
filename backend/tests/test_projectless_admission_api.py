import asyncio

import pytest
from fastapi.testclient import TestClient

from archon_server.app import create_app
from archon_server.config import Settings


class UnusedRunner:
    async def run(self, task, emit):
        raise AssertionError('This admission-only test must not launch a runner')


def test_registering_project_does_not_reassign_existing_projectless_session(tmp_path):
    root = tmp_path / 'workspace'
    cwd = root / 'scratch-job'
    cwd.mkdir(parents=True)
    settings = Settings(
        archon_root=root,
        hermes_home=root / '.hermes',
        data_dir=root / '.data',
        prime_agent_session_dir=root / '.prime/sessions',
        pi_agent_session_dir=root / '.pi/sessions',
        auth_token='test',
        start_worker=False,
    )
    app = create_app(settings, runner=UnusedRunner())
    with TestClient(app) as client:
        client.headers['Authorization'] = 'Bearer test'
        first = client.post('/api/tasks', json={
            'prompt': 'projectless work', 'approval_mode': 'auto', 'cwd': str(cwd),
        })
        assert first.status_code == 202, first.text
        task = first.json()['task']
        created = client.post('/api/projects', json={'name': 'Registered later', 'path': str(cwd)})
        assert created.status_code == 200, created.text
        project = created.json()['project']
        reassignment = client.post('/api/tasks', json={
            'prompt': 'must not reassign', 'approval_mode': 'auto',
            'session_id': task['session_id'], 'project_id': project['id'],
        })
        assert reassignment.status_code == 409, reassignment.text
        assert len(client.get('/api/tasks').json()['tasks']) == 1
        resumed = client.post('/api/tasks', json={
            'prompt': 'continue projectless', 'approval_mode': 'auto',
            'session_id': task['session_id'],
        })
        assert resumed.status_code == 202, resumed.text
        with app.state.store.db.connect() as conn:
            binding = conn.execute('SELECT project_id FROM session_projects WHERE session_id=?',
                                   (task['session_id'],)).fetchone()
        assert binding is not None
        assert binding['project_id'] is None


@pytest.fixture
def guarded_api(tmp_path):
    root = tmp_path / 'workspace'
    root.mkdir()
    settings = Settings(
        archon_root=root, hermes_home=root / '.hermes', data_dir=root / '.data',
        prime_agent_session_dir=root / '.prime/sessions',
        pi_agent_session_dir=root / '.pi/sessions', auth_token='test', start_worker=False,
    )
    runner = RecordingRunner()
    app = create_app(settings, runner=runner)
    with TestClient(app) as client:
        client.headers['Authorization'] = 'Bearer test'
        yield client, app, runner


class RecordingRunner:
    def __init__(self):
        self.calls = []

    async def run(self, task, emit):
        self.calls.append(task['id'])
        return {'text': 'fixture result'}


def test_deleting_project_preserves_binding_and_blocks_queued_execution(guarded_api):
    client, app, runner = guarded_api
    project = client.post('/api/projects', json={'name': 'Original'}).json()['project']
    submitted = client.post('/api/tasks', json={
        'prompt': 'project work', 'approval_mode': 'auto', 'project_id': project['id'],
    })
    assert submitted.status_code == 202, submitted.text
    task = submitted.json()['task']
    deleted = client.delete(f"/api/projects/{project['id']}")
    assert deleted.status_code == 200, deleted.text
    # A later registration at the same path must not adopt the old session.
    replacement = client.post('/api/projects', json={
        'name': 'Replacement', 'path': project['primary_path'],
    })
    assert replacement.status_code == 200, replacement.text
    rows = client.get('/api/sessions').json()['sessions']
    assert next(row for row in rows if row['id'] == task['session_id'])['project_id'] is None
    asyncio.run(app.state.engine.run_once())
    finished = app.state.store.get(task['id'])
    assert finished['status'] == 'failed'
    assert 'project' in finished['error'].lower()
    assert runner.calls == []
    with app.state.store.db.connect() as conn:
        binding = conn.execute('SELECT project_id FROM session_projects WHERE session_id=?',
                               (task['session_id'],)).fetchone()
    assert binding['project_id'] == project['id']


@pytest.mark.parametrize('status', ['queued', 'running'])
@pytest.mark.parametrize('detach', [False, True])
def test_busy_session_cannot_change_project_assignment(guarded_api, status, detach):
    client, app, _ = guarded_api
    first = client.post('/api/projects', json={'name': 'First'}).json()['project']
    second = client.post('/api/projects', json={'name': 'Second'}).json()['project']
    task = client.post('/api/tasks', json={
        'prompt': 'project work', 'approval_mode': 'auto', 'project_id': first['id'],
    }).json()['task']
    (app.state.settings.data_dir / 'prime-sessions' / task['session_id']).mkdir(parents=True)
    if status == 'running':
        app.state.store.mark_running(task['id'])
    response = client.put(f"/api/sessions/{task['session_id']}/project", json={
        'project_id': None if detach else second['id'],
    })
    assert response.status_code == 409, response.text
    with app.state.store.db.connect() as conn:
        binding = conn.execute('SELECT project_id FROM session_projects WHERE session_id=?',
                               (task['session_id'],)).fetchone()
    assert binding['project_id'] == first['id']
