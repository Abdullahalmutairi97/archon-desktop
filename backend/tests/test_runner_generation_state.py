import pytest

from archon_server.db import Database
from archon_server.tasks import TaskStore


RUNNER_ID = "prime-runner-1"


def _store(tmp_path):
    return TaskStore(Database(tmp_path / "state.db"))


def _running_task(store):
    task = store.submit("deliver journal event", cwd="/workspace")
    attempt_id = store.mark_running(task["id"])
    return task["id"], attempt_id


def _deliver(store, task_id, attempt_id, generation, seq):
    return store._deliver_runner_journal_event(
        RUNNER_ID, generation, seq, task_id=task_id, attempt_id=attempt_id,
        event_type="progress", data={"generation": generation, "seq": seq},
    )


def test_explicit_generation_activation_resets_sequence_and_fences_old_generation(tmp_path):
    store = _store(tmp_path)
    task_id, attempt_id = _running_task(store)
    assert store.runner_generation_state(RUNNER_ID) is None

    _deliver(store, task_id, attempt_id, generation=1, seq=1)
    observed = store.runner_generation_state(RUNNER_ID)
    assert observed == {
        "runner_id": RUNNER_ID,
        "active_generation": 1,
        "last_runner_seq": 1,
    }

    activated = store.activate_runner_generation(
        RUNNER_ID,
        expected_generation=observed["active_generation"],
        expected_last_runner_seq=observed["last_runner_seq"],
    )
    assert activated == {
        "runner_id": RUNNER_ID,
        "active_generation": 2,
        "last_runner_seq": 0,
    }

    restarted = _deliver(store, task_id, attempt_id, generation=2, seq=1)
    assert restarted["disposition"] == "accepted"
    with pytest.raises(ValueError, match="stale or has not been activated"):
        _deliver(store, task_id, attempt_id, generation=1, seq=2)
    assert store.runner_generation_state(RUNNER_ID) == {
        "runner_id": RUNNER_ID,
        "active_generation": 2,
        "last_runner_seq": 1,
    }


def test_activation_rejects_generation_state_that_changed_after_inspection(tmp_path):
    store = _store(tmp_path)
    task_id, attempt_id = _running_task(store)
    _deliver(store, task_id, attempt_id, generation=1, seq=1)
    observed = store.runner_generation_state(RUNNER_ID)
    _deliver(store, task_id, attempt_id, generation=1, seq=2)

    with pytest.raises(ValueError, match="changed since inspection"):
        store.activate_runner_generation(
            RUNNER_ID,
            expected_generation=observed["active_generation"],
            expected_last_runner_seq=observed["last_runner_seq"],
        )

    assert store.runner_generation_state(RUNNER_ID) == {
        "runner_id": RUNNER_ID,
        "active_generation": 1,
        "last_runner_seq": 2,
    }


def test_recovery_diagnostic_is_read_only_and_reports_receipt_and_task_state(tmp_path):
    store = _store(tmp_path)
    task_id, attempt_id = _running_task(store)
    _deliver(store, task_id, attempt_id, generation=1, seq=1)
    before_task = store.get(task_id)
    before_events = store.events(task_id)

    report = store.runner_generation_recovery_diagnostic(RUNNER_ID)

    assert report == {
        "runner_id": RUNNER_ID,
        "coordinator_generation": 1,
        "coordinator_last_runner_seq": 1,
        "active_generation_receipt_count": 1,
        "active_generation_first_runner_seq": 1,
        "active_generation_last_runner_seq": 1,
        "receipt_history_consistent": True,
        "server_wide_uncertain_task_count": 1,
        "recovery_action": "not_performed",
    }
    assert store.runner_generation_state(RUNNER_ID) == {
        "runner_id": RUNNER_ID,
        "active_generation": 1,
        "last_runner_seq": 1,
    }
    assert store.get(task_id) == before_task
    assert store.events(task_id) == before_events


def test_recovery_diagnostic_flags_missing_receipt_without_mutating_task(tmp_path):
    store = _store(tmp_path)
    task_id, attempt_id = _running_task(store)
    _deliver(store, task_id, attempt_id, generation=1, seq=1)
    with store.db.transaction() as conn:
        conn.execute(
            "DELETE FROM runner_event_receipts WHERE runner_id=? AND journal_generation=1 AND runner_seq=1",
            (RUNNER_ID,),
        )

    report = store.runner_generation_recovery_diagnostic(RUNNER_ID)

    assert report["receipt_history_consistent"] is False
    assert report["coordinator_generation"] == 1
    assert report["coordinator_last_runner_seq"] == 1
    assert report["active_generation_receipt_count"] == 0
    assert report["server_wide_uncertain_task_count"] == 1
    assert store.get(task_id)["status"] == "running"
