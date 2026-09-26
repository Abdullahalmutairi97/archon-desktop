import asyncio

import pytest

from archon_server.db import Database
from archon_server.tasks import TaskEngine, TaskStore


class ControlledRunner:
    def __init__(self):
        self.active = set()
        self.cancel_requested = asyncio.Event()
        self.release_cancel = asyncio.Event()
        self.cancelled = []

    async def cancel(self, task_id):
        self.cancel_requested.set()
        await self.release_cancel.wait()
        self.active.remove(task_id)
        self.cancelled.append(task_id)


def test_cancel_queued_commits_once_and_prevents_claim(tmp_path):
    store = TaskStore(Database(tmp_path / "state.db"))
    task = store.submit("never started")
    assert store.cancel_queued(task["id"]) is True
    assert store.cancel_queued(task["id"]) is False
    assert store.claim_next() is None
    saved = store.get(task["id"])
    assert saved["status"] == "cancelled"
    assert saved["started_at"] is None
    assert saved["completed_at"] is not None
    assert [event["type"] for event in store.events(task["id"])] == [
        "task.queued", "task.cancelled",
    ]


@pytest.mark.parametrize("status", ["running", "completed", "failed", "cancelled", "queued"])
def test_cancel_queued_never_relabels_a_started_or_terminal_task(tmp_path, status):
    store = TaskStore(Database(tmp_path / "state.db"))
    task = store.submit("may have started")
    with store.db.transaction() as conn:
        conn.execute(
            "UPDATE tasks SET status=?,started_at=? WHERE id=?",
            (status, "2026-01-01T00:00:00+00:00", task["id"]),
        )
    original = store.get(task["id"])
    events = store.events(task["id"])
    assert store.cancel_queued(task["id"]) is False
    assert store.get(task["id"]) == original
    assert store.events(task["id"]) == events


@pytest.mark.asyncio
async def test_cancel_routes_claim_race_to_owner_and_waits_for_runner(tmp_path, monkeypatch):
    store = TaskStore(Database(tmp_path / "state.db"))
    owner = ControlledRunner()
    other = ControlledRunner()
    engine = TaskEngine(store, {"pi": owner, "default": other})
    task = store.submit("claimed during cancellation", profile="pi")
    original_get = store.get
    raced = False

    def get_then_claim(task_id):
        nonlocal raced
        observed = original_get(task_id)
        if not raced and observed["status"] == "queued":
            raced = True
            attempt_id = store.mark_running(task_id)
            owner.active.add(task_id)
        return observed

    monkeypatch.setattr(store, "get", get_then_claim)
    cancellation = asyncio.create_task(engine.cancel(task["id"]))
    try:
        await asyncio.wait_for(owner.cancel_requested.wait(), timeout=1)
        assert not cancellation.done()
        assert original_get(task["id"])["status"] == "running"
        assert owner.active == {task["id"]}
        assert not other.cancel_requested.is_set()
        owner.release_cancel.set()
        await asyncio.wait_for(cancellation, timeout=1)
        assert not owner.active
        assert owner.cancelled == [task["id"]]
        assert original_get(task["id"])["status"] == "cancelled"
        # Repeated API cancellation cannot duplicate the terminal event.
        await engine.cancel(task["id"])
        assert [event["type"] for event in store.events(task["id"])] == [
            "task.queued", "task.running", "task.cancel_requested", "task.cancelled",
        ]
    finally:
        owner.release_cancel.set()
        await asyncio.gather(cancellation, return_exceptions=True)


@pytest.mark.asyncio
async def test_queued_fast_cancel_never_invokes_runner(tmp_path):
    store = TaskStore(Database(tmp_path / "state.db"))
    runner = ControlledRunner()
    engine = TaskEngine(store, runner)
    task = store.submit("never launch")
    await engine.cancel(task["id"])
    assert not runner.cancel_requested.is_set()
    assert store.get(task["id"])["status"] == "cancelled"
    assert store.claim_next() is None


@pytest.mark.asyncio
async def test_cancel_race_preserves_already_completed_outcome(tmp_path, monkeypatch):
    store = TaskStore(Database(tmp_path / "state.db"))
    runner = ControlledRunner()
    engine = TaskEngine(store, runner)
    task = store.submit("completed during cancellation")
    original_get = store.get
    raced = False

    def get_then_finish(task_id):
        nonlocal raced
        observed = original_get(task_id)
        if not raced and observed["status"] == "queued":
            raced = True
            attempt_id = store.mark_running(task_id)
            store.complete(task_id, {"text": "already finished"}, attempt_id=attempt_id)
        return observed

    monkeypatch.setattr(store, "get", get_then_finish)
    await engine.cancel(task["id"])
    assert original_get(task["id"])["status"] == "completed"
    assert not runner.cancel_requested.is_set()
    assert [event["type"] for event in store.events(task["id"])] == [
        "task.queued", "task.running", "task.completed",
    ]


@pytest.mark.asyncio
async def test_claim_race_does_not_report_cancelled_when_runner_stop_fails(tmp_path, monkeypatch):
    class FailedStopRunner:
        async def cancel(self, task_id):
            raise RuntimeError("fixture process still active")

    store = TaskStore(Database(tmp_path / "state.db"))
    engine = TaskEngine(store, FailedStopRunner())
    task = store.submit("must retain active status")
    original_get = store.get
    raced = False

    def get_then_claim(task_id):
        nonlocal raced
        observed = original_get(task_id)
        if not raced and observed["status"] == "queued":
            raced = True
            store.mark_running(task_id)
        return observed

    monkeypatch.setattr(store, "get", get_then_claim)
    with pytest.raises(RuntimeError, match="still active"):
        await engine.cancel(task["id"])
    assert original_get(task["id"])["status"] == "running"
    assert [event["type"] for event in store.events(task["id"])] == [
        "task.queued", "task.running", "task.cancel_requested",
    ]
