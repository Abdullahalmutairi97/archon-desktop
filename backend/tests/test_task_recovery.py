import asyncio

import pytest

from archon_server.db import Database
from archon_server.tasks import TaskEngine, TaskStore


@pytest.mark.asyncio
async def test_restart_after_side_effect_never_replays_started_task(tmp_path):
    database_path = tmp_path / "state.db"
    effects = tmp_path / "effects.txt"

    class CrashAfterEffect:
        async def run(self, task, emit):
            with effects.open("a") as output:
                output.write(task["prompt"] + "\n")
            # The process vanished before it could record any output or outcome.
            raise asyncio.CancelledError

    store = TaskStore(Database(database_path))
    interrupted = store.submit("one effect", request_id="durable-request")
    queued = store.submit("unstarted work")
    with pytest.raises(asyncio.CancelledError):
        await TaskEngine(store, CrashAfterEffect()).run_once()

    recovered_store = TaskStore(Database(database_path))
    assert recovered_store.recover_inflight() == 1

    class CompleteQueuedWork:
        async def run(self, task, emit):
            with effects.open("a") as output:
                output.write(task["prompt"] + "\n")
            return {"text": "done"}

    restarted = TaskEngine(recovered_store, CompleteQueuedWork())
    assert await restarted.run_once() is True
    assert await restarted.run_once() is False
    assert effects.read_text().splitlines() == ["one effect", "unstarted work"]
    assert recovered_store.get(queued["id"])["status"] == "completed"
    failed = recovered_store.get(interrupted["id"])
    assert failed["status"] == "failed"
    assert failed["started_at"] is not None
    assert failed["completed_at"] is not None
    assert "review" in failed["error"].lower()
    assert failed["result"]["recovery"] == {
        "reason": "server_restart",
        "previous_status": "running",
        "side_effects": "unknown",
        "review_required": True,
        "automatic_retry": False,
    }
    event = recovered_store.events(interrupted["id"])[-1]
    assert event["type"] == "task.failed"
    assert event["data"]["status"] == "failed"
    assert event["data"]["recovery"] == failed["result"]["recovery"]
    assert recovered_store.submit("one effect", request_id="durable-request") == failed


def test_recovery_preserves_unstarted_queue_and_is_idempotent(tmp_path):
    store = TaskStore(Database(tmp_path / "state.db"))
    interrupted = store.submit("claimed")
    store.mark_running(interrupted["id"])
    queued = store.submit("still waiting")
    queued_before = store.get(queued["id"])
    queued_events = store.events(queued["id"])

    assert store.recover_inflight() == 1
    recovered_before = store.get(interrupted["id"])
    recovered_events = store.events(interrupted["id"])
    assert store.recover_inflight() == 0
    assert store.get(interrupted["id"]) == recovered_before
    assert store.events(interrupted["id"]) == recovered_events
    assert store.get(queued["id"]) == queued_before
    assert store.events(queued["id"]) == queued_events


def test_recovery_stops_previously_started_legacy_quota_queue(tmp_path):
    store = TaskStore(Database(tmp_path / "state.db"))
    task = store.submit("old automatically retried task")
    store.mark_running(task["id"])
    # Simulate an existing database from the former automatic retry behavior.
    with store.db.transaction() as conn:
        conn.execute(
            "UPDATE tasks SET status='queued', retry_at=? WHERE id=?",
            ("2000-01-01T00:00:00+00:00", task["id"]),
        )

    # Even callers that claim work before startup recovery must not replay it.
    legacy = store.get(task["id"])
    assert store.claim_next() is None
    store.mark_running(task["id"])
    assert store.get(task["id"]) == legacy
    assert store.recover_inflight() == 1
    saved = store.get(task["id"])
    assert saved["status"] == "failed"
    assert saved["retry_at"] is None
    assert saved["result"]["recovery"]["previous_status"] == "queued"
    assert store.claim_next() is None


def test_late_writes_and_cancel_cannot_overwrite_recovery(tmp_path):
    store = TaskStore(Database(tmp_path / "state.db"))
    task = store.submit("unknown outcome", cwd=str(tmp_path))
    store.mark_running(task["id"])
    store.recover_inflight()
    recovered = store.get(task["id"])
    events = store.events(task["id"])

    store.complete(task["id"], {"text": "late success", "session_id": "late-session"})
    store.fail(task["id"], "late failure")
    assert store.cancel(task["id"]) is False
    store.defer_for_quota(task["id"], 60)
    store.mark_running(task["id"])
    store.set_session(task["id"], "late-session")

    assert store.get(task["id"]) == recovered
    assert store.events(task["id"]) == events
    assert store.db.session_locations(["late-session"]) == {}


@pytest.mark.asyncio
@pytest.mark.parametrize("error,reason", [
    ("Daemon worker client closed", "runner_disconnected"),
    ("provider usage limit reached", "provider_limit"),
])
async def test_errors_after_silent_side_effect_never_trigger_retry(tmp_path, error, reason):
    effects = tmp_path / "effects.txt"

    class SilentSideEffect:
        async def run(self, task, emit):
            with effects.open("a") as output:
                output.write("effect\n")
            raise RuntimeError(error)

    store = TaskStore(Database(tmp_path / "state.db"))
    task = store.submit("do this once")
    engine = TaskEngine(store, SilentSideEffect(), quota_retry_seconds=0)
    assert await engine.run_once() is True
    assert await engine.run_once() is False
    assert effects.read_text() == "effect\n"
    saved = store.get(task["id"])
    assert saved["status"] == "failed"
    assert error in saved["error"]
    assert saved["result"]["recovery"]["reason"] == reason
    assert saved["result"]["recovery"]["side_effects"] == "unknown"


@pytest.mark.asyncio
async def test_shared_workers_recover_only_before_claiming_new_work(tmp_path):
    store = TaskStore(Database(tmp_path / "state.db"))
    old = store.submit("old interrupted turn")
    store.mark_running(old["id"])
    new = store.submit("new turn")
    started = asyncio.Event()
    release = asyncio.Event()

    class BlockingRunner:
        async def run(self, task, emit):
            assert task["id"] == new["id"]
            started.set()
            await release.wait()
            return {"text": "done"}

    engine = TaskEngine(store, BlockingRunner(), poll_seconds=0.01)
    workers = [asyncio.create_task(engine.run_forever()) for _ in range(2)]
    try:
        await asyncio.wait_for(started.wait(), timeout=1)
        assert store.get(old["id"])["status"] == "failed"
        assert store.get(new["id"])["status"] == "running"
    finally:
        engine.stop()
        release.set()
        await asyncio.wait_for(asyncio.gather(*workers), timeout=1)
    assert store.get(new["id"])["status"] == "completed"


@pytest.mark.asyncio
async def test_late_runner_notifications_do_not_follow_recovery_event(tmp_path):
    store = TaskStore(Database(tmp_path / "state.db"))
    task = store.submit("late runner")
    started = asyncio.Event()
    release = asyncio.Event()

    class LateRunner:
        async def run(self, task, emit):
            started.set()
            await release.wait()
            await emit("session", {"session_id": "late-session"})
            await emit("output", {"text": "late answer"})
            return {"text": "done", "session_id": "late-session"}

    worker = asyncio.create_task(TaskEngine(store, LateRunner()).run_once())
    try:
        await asyncio.wait_for(started.wait(), timeout=1)
        # A stale process can still report after its durable row was recovered.
        store.recover_inflight()
        recovered = store.get(task["id"])
        events = store.events(task["id"])
    finally:
        release.set()
        await asyncio.wait_for(worker, timeout=1)
    assert store.get(task["id"]) == recovered
    assert store.events(task["id"]) == events
