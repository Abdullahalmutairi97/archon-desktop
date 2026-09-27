import sqlite3

import pytest

from archon_server.db import Database
from archon_server.tasks import TaskStore


def _store(tmp_path):
    return TaskStore(Database(tmp_path / "state.db"))


def _running_task(store):
    task = store.submit("deliver journal event", cwd="/workspace")
    attempt_id = store.mark_running(task["id"])
    return task["id"], attempt_id


def _deliver(store, task_id, attempt_id, *, seq=1, generation=1, event_type="progress", data=None):
    return store._deliver_runner_journal_event(
        "prime-runner-1", generation, seq, task_id=task_id, attempt_id=attempt_id,
        event_type=event_type, data={} if data is None else data,
    )


def test_first_generation_delivery_commits_event_receipt_and_high_water_together(tmp_path):
    store = _store(tmp_path)
    task_id, attempt_id = _running_task(store)

    outcome = _deliver(store, task_id, attempt_id, data={"message": "working"})

    assert outcome["disposition"] == "accepted"
    assert outcome["event_seq"] is not None
    saved_event = store.events(task_id)[-1]
    assert saved_event["seq"] == outcome["event_seq"]
    assert saved_event["task_id"] == task_id
    assert saved_event["type"] == "progress"
    assert saved_event["data"] == {"message": "working"}
    assert saved_event["attempt_id"] == attempt_id
    with store.db.connect() as conn:
        state = conn.execute(
            "SELECT active_generation,last_runner_seq FROM runner_generation_state WHERE runner_id=?",
            ("prime-runner-1",),
        ).fetchone()
        receipt = conn.execute(
            "SELECT envelope_json,disposition,event_seq FROM runner_event_receipts "
            "WHERE runner_id=? AND journal_generation=1 AND runner_seq=1",
            ("prime-runner-1",),
        ).fetchone()
    assert tuple(state) == (1, 1)
    assert receipt["disposition"] == "accepted"
    assert receipt["event_seq"] == outcome["event_seq"]
    assert '"attempt_id":"' + attempt_id + '"' in receipt["envelope_json"]
    assert '"task_id":"' + task_id + '"' in receipt["envelope_json"]


def test_exact_duplicate_is_order_independent_and_never_appends_twice(tmp_path):
    store = _store(tmp_path)
    task_id, attempt_id = _running_task(store)
    first = _deliver(store, task_id, attempt_id, data={"a": 1, "b": 2})
    events_before = store.latest_event_seq()

    duplicate = _deliver(store, task_id, attempt_id, data={"b": 2, "a": 1})

    assert duplicate == first
    assert store.latest_event_seq() == events_before


def test_runner_event_envelope_is_bounded_and_rejects_non_json_data(tmp_path):
    store = _store(tmp_path)
    task_id, attempt_id = _running_task(store)

    with pytest.raises(ValueError, match="64 KiB"):
        _deliver(store, task_id, attempt_id, data={"text": "x" * (64 * 1024)})
    with pytest.raises(ValueError, match="JSON values"):
        _deliver(store, task_id, attempt_id, data={"number": float("nan")})

    with store.db.connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM runner_generation_state").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM runner_event_receipts").fetchone()[0] == 0


@pytest.mark.parametrize(
    ("event_type", "message"),
    [
        ("progress\r\nevent: forged", "safe ASCII"),
        ("tool\x7f", "safe ASCII"),
        ("task.completed", "reserved task.*"),
    ],
)
def test_journal_delivery_rejects_unsafe_and_coordinator_event_names(tmp_path, event_type, message):
    store = _store(tmp_path)
    task_id, attempt_id = _running_task(store)

    with pytest.raises(ValueError, match=message):
        _deliver(store, task_id, attempt_id, event_type=event_type)

    with store.db.connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM runner_generation_state").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM runner_event_receipts").fetchone()[0] == 0


def test_journal_delivery_requires_a_captured_attempt_id(tmp_path):
    store = _store(tmp_path)
    task_id, _attempt_id = _running_task(store)

    with pytest.raises(ValueError, match="captured non-empty attempt id"):
        _deliver(store, task_id, None)

    with store.db.connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM runner_generation_state").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM runner_event_receipts").fetchone()[0] == 0


def test_same_sequence_with_different_envelope_conflicts(tmp_path):
    store = _store(tmp_path)
    task_id, attempt_id = _running_task(store)
    _deliver(store, task_id, attempt_id, data={"message": "first"})
    events_before = store.latest_event_seq()

    with pytest.raises(ValueError, match="conflict"):
        _deliver(store, task_id, attempt_id, data={"message": "different"})

    assert store.latest_event_seq() == events_before


@pytest.mark.parametrize(
    ("seq", "generation", "message"),
    [(2, 1, "gap"), (1, 2, "generation"), (0, 1, "sequence")],
)
def test_delivery_rejects_sequence_gaps_invalid_sequences_and_generation_advance(
    tmp_path, seq, generation, message,
):
    store = _store(tmp_path)
    task_id, attempt_id = _running_task(store)

    with pytest.raises(ValueError, match=message):
        _deliver(store, task_id, attempt_id, seq=seq, generation=generation)

    with store.db.connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM runner_generation_state").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM runner_event_receipts").fetchone()[0] == 0


def test_runner_must_start_at_generation_one_and_missing_old_receipt_is_rejected(tmp_path):
    store = _store(tmp_path)
    task_id, attempt_id = _running_task(store)

    with pytest.raises(ValueError, match="generation"):
        _deliver(store, task_id, attempt_id, generation=3)
    _deliver(store, task_id, attempt_id)
    with store.db.transaction() as conn:
        conn.execute(
            "DELETE FROM runner_event_receipts WHERE runner_id=? AND journal_generation=1 AND runner_seq=1",
            ("prime-runner-1",),
        )

    with pytest.raises(ValueError, match="receipt"):
        _deliver(store, task_id, attempt_id)


def test_existing_generation_is_not_advanced_implicitly(tmp_path):
    store = _store(tmp_path)
    task_id, attempt_id = _running_task(store)
    _deliver(store, task_id, attempt_id)

    with pytest.raises(ValueError, match="generation"):
        _deliver(store, task_id, attempt_id, generation=2, seq=2)

    with store.db.connect() as conn:
        state = conn.execute(
            "SELECT active_generation,last_runner_seq FROM runner_generation_state WHERE runner_id=?",
            ("prime-runner-1",),
        ).fetchone()
    assert tuple(state) == (1, 1)


def test_inactive_attempt_gets_a_durable_stale_receipt_without_an_event(tmp_path):
    store = _store(tmp_path)
    task_id, attempt_id = _running_task(store)
    assert store.complete(task_id, {"text": "done"}, attempt_id=attempt_id)
    events_before = store.latest_event_seq()

    stale = _deliver(store, task_id, attempt_id, event_type="late", data={"message": "ignored"})
    duplicate = _deliver(store, task_id, attempt_id, event_type="late", data={"message": "ignored"})

    assert stale == duplicate
    assert stale["disposition"] == "stale"
    assert stale["event_seq"] is None
    assert store.latest_event_seq() == events_before
    with store.db.connect() as conn:
        assert conn.execute(
            "SELECT last_runner_seq FROM runner_generation_state WHERE runner_id=?",
            ("prime-runner-1",),
        ).fetchone()[0] == 1


def test_deleted_task_delivery_is_receipted_stale_without_a_task_history_fk(tmp_path):
    store = _store(tmp_path)
    task_id, attempt_id = _running_task(store)
    with store.db.transaction() as conn:
        conn.execute("DELETE FROM tasks WHERE id=?", (task_id,))

    outcome = _deliver(store, task_id, attempt_id, data={"message": "after purge"})

    assert outcome["disposition"] == "stale"
    assert outcome["event_seq"] is None
    with store.db.connect() as conn:
        assert conn.execute(
            "SELECT disposition,event_seq FROM runner_event_receipts "
            "WHERE runner_id=? AND journal_generation=1 AND runner_seq=1",
            ("prime-runner-1",),
        ).fetchone()[:] == ("stale", None)


def test_rejected_provisional_session_rolls_back_partial_binding_side_effects(tmp_path):
    store = _store(tmp_path)
    task_id, attempt_id = _running_task(store)
    with store.db.transaction() as conn:
        # Simulate an invariant change during attachment, after its provisional
        # session-project insert but before its conditional task update.
        conn.execute(
            """CREATE TRIGGER make_attachment_stale AFTER INSERT ON session_projects
               WHEN NEW.session_id='announced-session'
               BEGIN UPDATE tasks SET status='completed' WHERE id='{}'; END""".format(task_id)
        )
    events_before = store.latest_event_seq()

    outcome = _deliver(
        store, task_id, attempt_id, event_type="session", data={"session_id": "announced-session"},
    )

    assert outcome["disposition"] == "stale"
    assert outcome["event_seq"] is None
    assert store.latest_event_seq() == events_before
    assert store.get(task_id)["status"] == "running"
    with store.db.connect() as conn:
        assert conn.execute(
            "SELECT 1 FROM session_projects WHERE session_id='announced-session'"
        ).fetchone() is None
        assert conn.execute(
            "SELECT last_runner_seq FROM runner_generation_state WHERE runner_id=?",
            ("prime-runner-1",),
        ).fetchone()[0] == 1
    assert store.db.session_locations(["announced-session"]) == {}


def test_event_failure_rolls_back_first_state_receipt_and_delivery_together(tmp_path):
    store = _store(tmp_path)
    task_id, attempt_id = _running_task(store)
    with store.db.transaction() as conn:
        conn.execute(
            """CREATE TRIGGER fail_journal_event BEFORE INSERT ON events
               WHEN NEW.type='fail-this'
               BEGIN SELECT RAISE(ABORT, 'injected event write failure'); END"""
        )
    events_before = store.latest_event_seq()

    with pytest.raises(sqlite3.IntegrityError, match="injected event write failure"):
        _deliver(store, task_id, attempt_id, event_type="fail-this")

    assert store.latest_event_seq() == events_before
    with store.db.connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM runner_generation_state").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM runner_event_receipts").fetchone()[0] == 0
