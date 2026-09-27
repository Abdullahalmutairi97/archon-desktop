import stat

import pytest
from fastapi.testclient import TestClient

from archon_server.app import LOCAL_TASK_RUNNER_ID, create_app
from archon_server.config import Settings
from archon_server.runner_journal import RunnerJournal, RunnerJournalError


def test_startup_replays_without_workers_and_fails_closed_if_journal_is_lost(tmp_path):
    settings = Settings(
        archon_root=tmp_path,
        hermes_home=tmp_path / ".hermes",
        data_dir=tmp_path / ".data",
        auth_token="test",
        start_worker=False,
    )
    settings.runner_journal_path.parent.mkdir(mode=0o700, parents=True)
    journal = RunnerJournal(settings.runner_journal_path, LOCAL_TASK_RUNNER_ID, 1)
    journal.append(
        "startup-event-1",
        {
            "task_id": "task-from-interrupted-run",
            "attempt_id": "attempt-from-interrupted-run",
            "event_type": "progress",
            "data": {"message": "committed before delivery"},
        },
    )

    app = create_app(settings)
    assert stat.S_IMODE(settings.runner_journal_path.parent.stat().st_mode) == 0o700
    with TestClient(app):
        assert app.state.store.runner_generation_state(LOCAL_TASK_RUNNER_ID) == {
            "runner_id": LOCAL_TASK_RUNNER_ID,
            "active_generation": 1,
            "last_runner_seq": 1,
        }
    assert journal.replay_unacked() == []

    settings.runner_journal_path.unlink()
    with pytest.raises(RunnerJournalError, match="journal is missing"):
        create_app(settings)
