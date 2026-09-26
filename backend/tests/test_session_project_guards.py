from contextlib import contextmanager

import pytest

from archon_server.db import Database
from archon_server.services.workspace import PrimeSessionService, ProjectService
from archon_server.tasks import TaskStore


def test_project_reassignment_rechecks_busy_state_inside_write_transaction(tmp_path, monkeypatch):
    db = Database(tmp_path / 'tasks.db')
    store = TaskStore(db)
    projects = ProjectService(tmp_path / 'projects.db')
    first = projects.create('First', tmp_path / 'first')
    second = projects.create('Second', tmp_path / 'second')
    original = store.submit('finished', cwd=first['primary_path'], project_id=first['id'])
    attempt_id = store.mark_running(original['id'])
    store.complete(original['id'], {'text': 'finished'}, attempt_id=attempt_id)
    (tmp_path / 'sessions' / original['session_id']).mkdir(parents=True)
    sessions = PrimeSessionService(db, tmp_path / 'sessions', tmp_path / 'agent-sessions', projects)
    original_transaction = db.transaction

    @contextmanager
    def task_arrives_before_assignment_transaction():
        # Commit another producer's task after any out-of-transaction check,
        # immediately before the assignment transaction obtains its write lock.
        with original_transaction() as conn:
            conn.execute(
                "INSERT INTO tasks(id,prompt,cwd,session_id,status,created_at,updated_at) "
                "VALUES ('racing-task','queued work',?,?,'queued','now','now')",
                (first['primary_path'], original['session_id']),
            )
        with original_transaction() as conn:
            yield conn

    monkeypatch.setattr(db, 'transaction', task_arrives_before_assignment_transaction)
    with pytest.raises(ValueError, match='active|queued|running|busy'):
        sessions.assign_project(original['session_id'], second['id'])
    with db.connect() as conn:
        binding = conn.execute('SELECT project_id FROM session_projects WHERE session_id=?',
                               (original['session_id'],)).fetchone()
        queued = conn.execute("SELECT status FROM tasks WHERE id='racing-task'").fetchone()
    assert binding['project_id'] == first['id']
    assert queued['status'] == 'queued'
