import stat

import pytest
from fastapi.testclient import TestClient

from archon_server.app import LOCAL_TASK_RUNNER_ID, create_app
from archon_server.config import Settings
from archon_server.db import Database
from archon_server.runner_journal import RunnerJournal, RunnerJournalError
from archon_server.tasks import TaskStore


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
    with pytest.raises(RunnerJournalError, match="journal is missing") as error:
        create_app(settings)
    assert "read-only recovery diagnostic" in str(error.value)
    assert "recovery_action=not_performed" in str(error.value)


def test_missing_journal_reports_uncertain_task_without_recovering_it(tmp_path):
    settings = Settings(
        archon_root=tmp_path,
        hermes_home=tmp_path / ".hermes",
        data_dir=tmp_path / ".data",
        auth_token="test",
        start_worker=False,
    )
    store = TaskStore(Database(settings.database_path))
    task = store.submit("review after lost journal", cwd="/workspace")
    attempt_id = store.mark_running(task["id"])
    store._deliver_runner_journal_event(
        LOCAL_TASK_RUNNER_ID,
        1,
        1,
        task_id=task["id"],
        attempt_id=attempt_id,
        event_type="progress",
        data={"message": "started"},
    )
    before_events = store.events(task["id"])

    with pytest.raises(RunnerJournalError, match="journal is missing") as error:
        create_app(settings)

    detail = str(error.value)
    assert "coordinator_generation=1" in detail
    assert "coordinator_last_runner_seq=1" in detail
    assert "server_wide_uncertain_tasks=1" in detail
    assert "no generation was advanced and no task was interrupted" in detail
    assert "verify the old runner and its native children are stopped" in detail
    assert store.runner_generation_state(LOCAL_TASK_RUNNER_ID) == {
        "runner_id": LOCAL_TASK_RUNNER_ID,
        "active_generation": 1,
        "last_runner_seq": 1,
    }
    assert store.get(task["id"])["status"] == "running"
    assert store.events(task["id"]) == before_events


def test_restored_old_journal_reports_mismatch_without_fencing_or_interrupting(tmp_path):
    settings = Settings(
        archon_root=tmp_path,
        hermes_home=tmp_path / ".hermes",
        data_dir=tmp_path / ".data",
        auth_token="test",
        start_worker=False,
    )
    store = TaskStore(Database(settings.database_path))
    task = store.submit("review after journal restore", cwd="/workspace")
    attempt_id = store.mark_running(task["id"])
    store._deliver_runner_journal_event(
        LOCAL_TASK_RUNNER_ID,
        1,
        1,
        task_id=task["id"],
        attempt_id=attempt_id,
        event_type="progress",
        data={"message": "first generation"},
    )
    observed = store.runner_generation_state(LOCAL_TASK_RUNNER_ID)
    store.activate_runner_generation(
        LOCAL_TASK_RUNNER_ID,
        expected_generation=observed["active_generation"],
        expected_last_runner_seq=observed["last_runner_seq"],
    )
    settings.runner_journal_path.parent.mkdir(mode=0o700, parents=True)
    restored = RunnerJournal(settings.runner_journal_path, LOCAL_TASK_RUNNER_ID, 1)
    restored.append("restored-old-entry", {"message": "old journal"})
    before_events = store.events(task["id"])

    with pytest.raises(RunnerJournalError, match="generations disagree") as error:
        create_app(settings)

    detail = str(error.value)
    assert "coordinator_generation=2" in detail
    assert "coordinator_last_runner_seq=0" in detail
    assert "server_wide_uncertain_tasks=1" in detail
    assert "recovery_action=not_performed" in detail
    assert store.runner_generation_state(LOCAL_TASK_RUNNER_ID) == {
        "runner_id": LOCAL_TASK_RUNNER_ID,
        "active_generation": 2,
        "last_runner_seq": 0,
    }
    assert store.get(task["id"])["status"] == "running"
    assert store.events(task["id"]) == before_events
