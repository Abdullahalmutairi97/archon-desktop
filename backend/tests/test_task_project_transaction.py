import pytest

from archon_server.db import Database
from archon_server.tasks import TaskStore


def test_task_and_project_assignment_commit_together(tmp_path):
    store = TaskStore(Database(tmp_path / 'state.db'))
    task = store.submit('work', project_id='project-1')
    with store.db.connect() as conn:
        row = conn.execute('SELECT project_id FROM session_projects WHERE session_id=?',
                           (task['session_id'],)).fetchone()
    assert row['project_id'] == 'project-1'
    assert store.events(task['id'])[0]['type'] == 'task.queued'


def test_project_assignment_failure_rolls_back_task_and_event(tmp_path):
    store = TaskStore(Database(tmp_path / 'state.db'))
    with store.db.transaction() as conn:
        conn.execute("CREATE TRIGGER reject_assignment BEFORE INSERT ON session_projects "
                     "BEGIN SELECT RAISE(ABORT, 'fixture rejects assignment'); END")
    with pytest.raises(Exception, match='fixture rejects assignment'):
        store.submit('work', project_id='project-1')
    assert store.list() == []
    assert store.all_events(0) == []


def test_explicit_projectless_admission_persists_null_binding(tmp_path):
    store = TaskStore(Database(tmp_path / 'state.db'))
    task = store.submit('projectless work', project_id=None)
    with store.db.connect() as conn:
        row = conn.execute('SELECT project_id FROM session_projects WHERE session_id=?',
                           (task['session_id'],)).fetchone()
    assert row is not None
    assert row['project_id'] is None


def test_changed_project_binding_rolls_back_task_and_event(tmp_path):
    store = TaskStore(Database(tmp_path / 'state.db'))
    first = store.submit('original work', project_id='project-1')
    original_events = store.all_events(0)
    # Reproduce a reassignment after HTTP admission but before durable submit.
    with store.db.transaction() as conn:
        conn.execute('UPDATE session_projects SET project_id=? WHERE session_id=?',
                     ('project-2', first['session_id']))
    with pytest.raises(ValueError, match='project'):
        store.submit('must not be acknowledged', session_id=first['session_id'],
                     project_id='project-1')
    assert [task['id'] for task in store.list()] == [first['id']]
    assert store.all_events(0) == original_events
    with store.db.connect() as conn:
        row = conn.execute('SELECT project_id FROM session_projects WHERE session_id=?',
                           (first['session_id'],)).fetchone()
    assert row['project_id'] == 'project-2'


@pytest.mark.parametrize('initial,incoming', [(None, 'project-1'), ('project-1', None)])
def test_explicit_projectless_identity_cannot_change_on_submit(tmp_path, initial, incoming):
    store = TaskStore(Database(tmp_path / 'state.db'))
    first = store.submit('original work', project_id=initial)
    with pytest.raises(ValueError, match='project'):
        store.submit('must not change identity', session_id=first['session_id'], project_id=incoming)
    assert len(store.list()) == 1
    assert len(store.all_events(0)) == 1
