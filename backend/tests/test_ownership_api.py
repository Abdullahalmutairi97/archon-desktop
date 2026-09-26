import asyncio
import json
import sqlite3

from fastapi.testclient import TestClient

from archon_server.app import create_app
from archon_server.config import Settings


class RecordingRunner:
    def __init__(self):
        self.calls = []

    async def run(self, task, emit):
        self.calls.append(task['id'])
        return {'text': 'fixture result'}


def _app(tmp_path, runners, aliases=None):
    root = tmp_path / 'workspace'
    root.mkdir()
    settings = Settings(
        archon_root=root, hermes_home=root / '.hermes', data_dir=root / '.data',
        prime_agent_session_dir=root / '.prime/sessions',
        pi_agent_session_dir=root / '.pi/sessions',
        auth_token='test', start_worker=False,
        runtime_profile_aliases=aliases or {},
    )
    return create_app(settings, runner=runners), root


def _write_native_header(path, session_id, cwd):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({
        'type': 'session', 'id': session_id, 'cwd': str(cwd),
        'timestamp': '2026-09-26T00:00:00Z',
    }) + '\n')


def test_http_tasks_keep_bound_runtime_after_alias_change_and_picker_change(tmp_path):
    prime = RecordingRunner()
    pi = RecordingRunner()
    app, root = _app(tmp_path, {'prime': prime, 'pi': pi}, {'pi-fast': 'pi'})
    with TestClient(app) as client:
        client.headers['Authorization'] = 'Bearer test'
        first = client.post('/api/tasks', json={
            'prompt': 'start Pi session', 'approval_mode': 'auto',
            'profile': 'pi-fast', 'cwd': str(root),
        })
        assert first.status_code == 202, first.text
        first_task = first.json()['task']
        assert first_task['runtime_id'] == 'pi'
        assert app.state.store.session_owner(first_task['session_id'])['runtime_id'] == 'pi'

        # A profile alias is mutable configuration, and the client may submit
        # a different or stale picker value while replying to an existing chat.
        app.state.runtimes.aliases['pi-fast'] = 'prime'
        resumed = client.post('/api/tasks', json={
            'prompt': 'continue the Pi session', 'approval_mode': 'auto',
            'profile': 'removed-picker-alias', 'session_id': first_task['session_id'],
        })
        assert resumed.status_code == 202, resumed.text
        second_task = resumed.json()['task']
        assert second_task['runtime_id'] == 'pi'

        assert asyncio.run(app.state.engine.run_once())
        assert asyncio.run(app.state.engine.run_once())

    assert len(pi.calls) == 2
    assert prime.calls == []


def test_ambiguous_legacy_owner_is_visible_and_blocks_resume_and_dispatch(tmp_path):
    prime = RecordingRunner()
    pi = RecordingRunner()
    app, root = _app(tmp_path, {'prime': prime, 'pi': pi})
    second_cwd = root / 'other'
    second_cwd.mkdir()
    with TestClient(app) as client:
        client.headers['Authorization'] = 'Bearer test'
        first = client.post('/api/tasks', json={
            'prompt': 'original', 'approval_mode': 'auto', 'cwd': str(root),
        })
        assert first.status_code == 202, first.text
        task = first.json()['task']
        with app.state.store.db.transaction() as conn:
            conn.execute(
                """INSERT INTO tasks
                   (id,prompt,cwd,session_id,profile,runtime_id,project_id,approval_mode,
                    chat_only,skills_json,status,created_at,updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                ('conflicting-history', 'legacy conflicting turn', str(second_cwd),
                 task['session_id'], 'pi', 'pi', None, 'auto', 0, '[]', 'completed',
                 '2026-09-26T00:00:00Z', '2026-09-26T00:00:00Z'),
            )

        rows = client.get('/api/sessions').json()['sessions']
        visible = next(row for row in rows if row['id'] == task['session_id'])
        assert visible['ownership_state'] == 'review_required'
        assert visible['runtime'] is None
        assert visible['cwd'] is None
        assert visible['ownership_reason']

        resume = client.post('/api/tasks', json={
            'prompt': 'resume conflicting history', 'approval_mode': 'auto',
            'session_id': task['session_id'],
        })
        assert resume.status_code == 409
        assert 'review' in resume.json()['detail'].lower()

        assert asyncio.run(app.state.engine.run_once())
        assert app.state.store.get(task['id'])['status'] == 'failed'

    assert prime.calls == []
    assert pi.calls == []


def test_ambiguous_project_root_keeps_sessions_visible_and_blocks_resume(tmp_path):
    prime = RecordingRunner()
    app, root = _app(tmp_path, {'prime': prime})
    ambiguous_id = 'ambiguous-native'
    healthy_id = 'healthy-native'
    ambiguous_cwd = root / 'shared-root'
    ambiguous_cwd.mkdir()
    healthy_cwd = tmp_path / 'healthy-workspace'
    healthy_cwd.mkdir()

    with TestClient(app) as client:
        client.headers['Authorization'] = 'Bearer test'
        projects = app.state.services['projects']
        first = projects.create('First root', ambiguous_cwd)
        second_root = tmp_path / 'second-project-root'
        second_root.mkdir()
        second = projects.create('Second root', second_root)
        with sqlite3.connect(projects.database_path) as conn:
            conn.execute(
                "INSERT INTO project_folders(project_id,path,label,is_primary,added_at) VALUES (?,?,?,?,?)",
                (second['id'], str(ambiguous_cwd), 'Shared root', 0, '2026-09-26T00:00:00Z'),
            )
        _write_native_header(
            root / '.prime' / 'sessions' / f'{ambiguous_id}.jsonl', ambiguous_id, ambiguous_cwd,
        )
        _write_native_header(
            root / '.prime' / 'sessions' / f'{healthy_id}.jsonl', healthy_id, healthy_cwd,
        )

        response = client.get('/api/sessions')

        assert response.status_code == 200, response.text
        rows = {row['id']: row for row in response.json()['sessions']}
        assert ambiguous_id in rows
        assert rows[ambiguous_id]['ownership_state'] == 'review_required'
        assert rows[ambiguous_id]['project_ownership_ambiguous'] is True
        assert rows[ambiguous_id]['ownership_reason']
        assert healthy_id in rows
        assert rows[healthy_id]['ownership_state'] == 'verified'
        assert rows[healthy_id]['cwd'] == str(healthy_cwd)

        resume = client.post('/api/tasks', json={
            'prompt': 'do not run', 'approval_mode': 'auto', 'session_id': ambiguous_id,
        })

    assert resume.status_code == 409
    assert prime.calls == []


def test_known_native_session_stays_visible_when_its_header_becomes_malformed(tmp_path):
    prime = RecordingRunner()
    pi = RecordingRunner()
    app, root = _app(tmp_path, {'prime': prime, 'pi': pi})
    session_id = 'native-known'
    native_path = root / '.prime' / 'sessions' / f'{session_id}.jsonl'
    cwd = tmp_path / 'native-workspace'
    cwd.mkdir()
    _write_native_header(native_path, session_id, cwd)

    with TestClient(app) as client:
        client.headers['Authorization'] = 'Bearer test'
        first = client.get('/api/sessions')
        assert first.status_code == 200, first.text
        first_rows = {row['id']: row for row in first.json()['sessions']}
        assert first_rows[session_id]['ownership_state'] == 'verified'

        # The candidate ID and verified owner are durable even if the file can
        # no longer provide a usable native header on the next refresh.
        native_path.write_text('{ malformed native record\n')
        second = client.get('/api/sessions')
        assert second.status_code == 200, second.text
        second_rows = {row['id']: row for row in second.json()['sessions']}
        assert session_id in second_rows
        assert second_rows[session_id]['ownership_state'] == 'review_required'
        assert second_rows[session_id]['runtime'] is None
        assert second_rows[session_id]['cwd'] is None
        assert second_rows[session_id]['ownership_reason']

        resume = client.post('/api/tasks', json={
            'prompt': 'do not launch from damaged evidence', 'approval_mode': 'auto',
            'session_id': session_id,
        })

    assert resume.status_code == 409
    assert prime.calls == []
    assert pi.calls == []


def test_filename_header_mismatch_does_not_publish_a_second_session_alias(tmp_path):
    prime = RecordingRunner()
    app, root = _app(tmp_path, {'prime': prime})
    native_root = root / '.prime' / 'sessions'
    _write_native_header(native_root / 'stale-filename.jsonl', 'canonical-native-id', root)

    with TestClient(app) as client:
        client.headers['Authorization'] = 'Bearer test'
        response = client.get('/api/sessions')

    assert response.status_code == 200, response.text
    session_ids = {row['id'] for row in response.json()['sessions']}
    assert 'canonical-native-id' in session_ids
    assert 'stale-filename' not in session_ids
