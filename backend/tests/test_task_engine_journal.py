import pytest

from archon_server.db import Database
from archon_server.runner_journal import RunnerJournal
from archon_server.tasks import TaskEngine, TaskStore


class EmittingRunner:
    async def run(self, task, emit):
        await emit("progress", {"message": "working"})
        await emit("progress", {"message": "working"})
        return {"text": "done"}


class InvalidEventRunner:
    def __init__(self, event_type, data):
        self.event_type = event_type
        self.data = data

    async def run(self, task, emit):
        await emit(self.event_type, self.data)
        return {"text": "done"}


def _engine(tmp_path, runner=None):
    store = TaskStore(Database(tmp_path / "state.db"))
    journal = RunnerJournal(tmp_path / "runner.sqlite3", "runner-test", 1)
    engine = TaskEngine(store, runner if runner is not None else EmittingRunner(), journal=journal)
    return store, journal, engine


@pytest.mark.asyncio
async def test_runner_events_are_journaled_before_delivery_then_acked(tmp_path):
    store, journal, engine = _engine(tmp_path)
    task = store.submit("emit progress", cwd=str(tmp_path))
    original_deliver = store._deliver_runner_journal_event
    observed = []

    def check_then_deliver(runner_id, generation, sequence, **event):
        pending = journal.replay_unacked()
        assert len(pending) == 1
        entry = pending[0]
        assert entry.runner_id == runner_id
        assert entry.journal_generation == generation
        assert entry.runner_seq == sequence
        assert entry.payload == {
            "task_id": task["id"],
            "attempt_id": store.get(task["id"])["current_attempt_id"],
            "event_type": "progress",
            "data": {"message": "working"},
        }
        observed.append(entry.event_key)
        return original_deliver(runner_id, generation, sequence, **event)

    store._deliver_runner_journal_event = check_then_deliver
    await engine.run_once()

    assert len(observed) == 2
    assert len(set(observed)) == 2
    assert journal.replay_unacked() == []
    assert [event["data"] for event in store.events(task["id"]) if event["type"] == "progress"] == [
        {"message": "working"},
        {"message": "working"},
    ]


@pytest.mark.asyncio
async def test_delivery_failure_keeps_entry_for_startup_replay(tmp_path):
    store, journal, engine = _engine(tmp_path)
    task = store.submit("recover event", cwd=str(tmp_path))
    original_deliver = store._deliver_runner_journal_event

    def fail_delivery(*args, **kwargs):
        raise RuntimeError("injected coordinator delivery failure")

    store._deliver_runner_journal_event = fail_delivery
    await engine.run_once()

    pending = journal.replay_unacked()
    assert len(pending) == 1
    assert pending[0].payload["task_id"] == task["id"]

    queued = store.submit("wait for event replay", cwd=str(tmp_path))
    with pytest.raises(RuntimeError, match="injected coordinator delivery failure"):
        await engine.run_once()
    assert store.get(queued["id"])["status"] == "queued"

    store._deliver_runner_journal_event = original_deliver
    assert engine.replay_unacked() == 1
    assert journal.replay_unacked() == []
    with store.db.connect() as conn:
        receipt = conn.execute(
            "SELECT disposition FROM runner_event_receipts "
            "WHERE runner_id=? AND journal_generation=1 AND runner_seq=1",
            (journal.runner_id,),
        ).fetchone()
    assert receipt["disposition"] == "stale"


@pytest.mark.parametrize(
    ("event_type", "data"),
    [
        ("progress", {"text": "x" * (64 * 1024)}),
        ("task.completed", {}),
    ],
)
@pytest.mark.asyncio
async def test_invalid_events_are_rejected_before_journal_append(tmp_path, event_type, data):
    runner = InvalidEventRunner(event_type, data)
    store, journal, engine = _engine(tmp_path, runner)
    task = store.submit("reject invalid event", cwd=str(tmp_path))

    await engine.run_once()

    assert store.get(task["id"])["status"] == "failed"
    assert journal.replay_unacked() == []
    with store.db.connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM runner_generation_state").fetchone()[0] == 0
