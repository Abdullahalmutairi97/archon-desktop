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
