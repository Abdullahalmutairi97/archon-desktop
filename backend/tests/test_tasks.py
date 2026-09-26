import asyncio
import sqlite3

import pytest

from archon_server.db import Database
from archon_server.tasks import TaskEngine, TaskStore


class RecordingRunner:
    def __init__(self):
        self.prompts: list[str] = []

    async def run(self, task, emit):
        self.prompts.append(task["prompt"])
        await emit("progress", {"message": "working"})
        return {"text": f"finished: {task['prompt']}"}


class BlockingRunner:
    def __init__(self):
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.cancelled = asyncio.Event()

    async def run(self, task, emit):
        self.started.set()
        await self.release.wait()
        if self.cancelled.is_set():
            from archon_server.hermes_runner import RunnerCancelled
            raise RunnerCancelled(task["id"])
        return {"text": "unexpected completion"}

    async def cancel(self, task_id):
        self.cancelled.set()
        await self.release.wait()


@pytest.mark.asyncio
async def test_task_is_durable_before_worker_runs(tmp_path):
    db = Database(tmp_path / "state.db")
    store = TaskStore(db)
    runner = RecordingRunner()
    engine = TaskEngine(store, runner)

    task = store.submit("inspect the VPS", cwd=str(tmp_path), session_id="session-1")

    assert store.get(task["id"])["status"] == "queued"
    assert store.get(task["id"])["session_id"] == "session-1"
    assert runner.prompts == []

    await engine.run_once()

    saved = store.get(task["id"])
    assert saved["status"] == "completed"
    assert saved["result"]["text"] == "finished: inspect the VPS"
    assert runner.prompts == ["inspect the VPS"]


def test_completion_persists_the_new_hermes_session_id(tmp_path):
    store = TaskStore(Database(tmp_path / "state.db"))
    task = store.submit("start a chat")
    attempt_id = store.mark_running(task["id"])

    store.complete(task["id"], {"text": "ready", "session_id": "20260725_session"}, attempt_id=attempt_id)

    assert store.get(task["id"])["session_id"] == "20260725_session"


def test_completion_event_is_capped_but_task_keeps_full_result(tmp_path):
    store = TaskStore(Database(tmp_path / "state.db"))
    task = store.submit("produce a long answer")
    attempt_id = store.mark_running(task["id"])
    full_text = "x" * 9000

    store.complete(task["id"], {"text": full_text, "session_id": "session-long"}, attempt_id=attempt_id)

    saved = store.get(task["id"])
    completed = store.events(task["id"])[-1]
    assert saved["result"]["text"] == full_text
    assert completed["type"] == "task.completed"
    assert len(completed["data"]["result"]["text"]) <= 4096
    assert completed["data"]["result"]["text"].endswith("…[truncated]")
    assert completed["data"]["result"]["session_id"] == "session-long"


def test_set_session_persists_new_id_and_preserves_resumed_id(tmp_path):
    store = TaskStore(Database(tmp_path / "state.db"))
    new_task = store.submit("start a chat")
    resumed_task = store.submit("continue a chat", session_id="existing-session")
    new_attempt = store.mark_running(new_task["id"])
    resumed_attempt = store.mark_running(resumed_task["id"])

    store.set_session(new_task["id"], "new-session", attempt_id=new_attempt)
    store.set_session(resumed_task["id"], "late-announcement", attempt_id=resumed_attempt)

    assert store.get(new_task["id"])["session_id"] == "new-session"
    assert store.get(resumed_task["id"])["session_id"] == "existing-session"


@pytest.mark.asyncio
async def test_engine_persists_announced_session_while_task_is_running(tmp_path):
    class SessionAnnouncingRunner:
        def __init__(self):
            self.announced = asyncio.Event()
            self.release = asyncio.Event()

        async def run(self, task, emit):
            await emit("session", {"session_id": "running-session"})
            self.announced.set()
            await self.release.wait()
            return {"text": "done", "session_id": "running-session"}

    store = TaskStore(Database(tmp_path / "state.db"))
    runner = SessionAnnouncingRunner()
    engine = TaskEngine(store, runner)
    task = store.submit("start a chat")
    worker = asyncio.create_task(engine.run_once())
    await asyncio.wait_for(runner.announced.wait(), timeout=2)

    running = store.get(task["id"])
    assert running["status"] == "running"
    assert running["session_id"] == "running-session"
    assert any(event["type"] == "session" for event in store.events(task["id"]))

    runner.release.set()
    await asyncio.wait_for(worker, timeout=2)


def test_existing_database_is_migrated_without_losing_tasks(tmp_path):
    path = tmp_path / "legacy.db"
    with sqlite3.connect(path) as conn:
        conn.executescript("""
            CREATE TABLE tasks (
                id TEXT PRIMARY KEY, prompt TEXT NOT NULL, cwd TEXT, model TEXT,
                provider TEXT, skills_json TEXT NOT NULL DEFAULT '[]',
                status TEXT NOT NULL, result_json TEXT, error TEXT,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                started_at TEXT, completed_at TEXT
            );
            INSERT INTO tasks (id,prompt,status,created_at,updated_at)
            VALUES ('legacy','keep me','queued','2026-07-25','2026-07-25');
        """)

    store = TaskStore(Database(path))

    migrated = store.get("legacy")
    assert migrated["prompt"] == "keep me"
    assert migrated["approval_mode"] == "approve"
    assert migrated["chat_only"] == 0
    assert migrated["session_id"] is None


@pytest.mark.asyncio
async def test_events_replay_after_last_seen_sequence(tmp_path):
    store = TaskStore(Database(tmp_path / "state.db"))
    task = store.submit("build it")
    store.append_event(task["id"], "progress", {"message": "one"})
    store.append_event(task["id"], "progress", {"message": "two"})

    all_events = store.events(task["id"], after=0)
    replay = store.events(task["id"], after=all_events[1]["seq"])

    assert [event["type"] for event in all_events] == ["task.queued", "progress", "progress"]
    assert [event["data"]["message"] for event in replay] == ["two"]
    assert all_events[0]["seq"] < all_events[1]["seq"] < all_events[2]["seq"]


def test_inflight_tasks_require_review_after_server_restart(tmp_path):
    store = TaskStore(Database(tmp_path / "state.db"))
    task = store.submit("survive a restart")
    store.mark_running(task["id"])

    recovered = store.recover_inflight()

    assert recovered == 1
    saved = store.get(task["id"])
    assert saved["status"] == "failed"
    assert saved["result"]["recovery"]["review_required"] is True
    assert store.events(task["id"])[-1]["type"] == "task.failed"


def test_global_events_replay_in_one_ordered_cursor(tmp_path):
    store = TaskStore(Database(tmp_path / "state.db"))
    first = store.submit("first")
    second = store.submit("second")
    store.append_event(first["id"], "progress", {"message": "three"})

    events = store.all_events(after=0)
    replay = store.all_events(after=events[0]["seq"])

    assert [event["task_id"] for event in events] == [first["id"], second["id"], first["id"]]
    assert replay == events[1:]
    assert store.latest_event_seq() == events[-1]["seq"]


def test_latest_event_seq_is_zero_for_an_empty_ledger(tmp_path):
    store = TaskStore(Database(tmp_path / "state.db"))

    assert store.latest_event_seq() == 0


@pytest.mark.asyncio
async def test_running_cancel_is_not_committed_until_runner_is_reaped(tmp_path):
    store = TaskStore(Database(tmp_path / "state.db"))
    runner = BlockingRunner()
    engine = TaskEngine(store, runner)
    task = store.submit("cancel honestly")
    worker = asyncio.create_task(engine.run_once())
    await runner.started.wait()

    cancellation = asyncio.create_task(engine.cancel(task["id"]))
    await runner.cancelled.wait()

    assert store.get(task["id"])["status"] == "running"

    runner.release.set()
    await asyncio.gather(cancellation, worker)

    assert store.get(task["id"])["status"] == "cancelled"
    assert store.events(task["id"])[-1]["type"] == "task.cancelled"


@pytest.mark.asyncio
async def test_failed_task_keeps_error_and_events(tmp_path):
    class FailingRunner:
        async def run(self, task, emit):
            await emit("progress", {"message": "started"})
            raise RuntimeError("runner stopped")

    store = TaskStore(Database(tmp_path / "state.db"))
    engine = TaskEngine(store, FailingRunner())
    task = store.submit("fail safely")

    await engine.run_once()

    saved = store.get(task["id"])
    assert saved["status"] == "failed"
    assert saved["error"] == "runner stopped"
    assert store.events(task["id"])[-1]["type"] == "task.failed"


@pytest.mark.asyncio
async def test_engine_does_not_retry_prime_disconnect_without_output(tmp_path):
    class DisconnectOnceRunner:
        def __init__(self):
            self.calls = 0

        async def run(self, task, emit):
            self.calls += 1
            if self.calls == 1:
                raise RuntimeError("Daemon worker client closed")
            return {"text": "answer after reconnect", "session_id": task["session_id"]}

    store = TaskStore(Database(tmp_path / "state.db"))
    runner = DisconnectOnceRunner()
    engine = TaskEngine(store, runner)
    task = store.submit("do not make me type twice", session_id="prime-retry")
    await engine.run_once()

    saved = store.get(task["id"])
    assert runner.calls == 1
    assert saved["status"] == "failed"
    assert saved["result"]["recovery"]["reason"] == "runner_disconnected"
    assert saved["result"]["recovery"]["automatic_retry"] is False



def test_submit_request_id_is_idempotent(tmp_path):
    store = TaskStore(Database(tmp_path / "state.db"))

    first = store.submit("side effect", request_id="telegram-17")
    replay = store.submit("side effect", request_id="telegram-17")

    assert replay["id"] == first["id"]
    assert len(store.list()) == 1
    assert [event["type"] for event in store.events(first["id"])] == ["task.queued"]


def test_quota_error_is_detected_but_ordinary_errors_are_not():
    from archon_server.tasks import is_quota_error
    assert is_quota_error("429 Too Many Requests")
    assert is_quota_error("subscription usage limit reached")
    assert not is_quota_error("tool failed: file not found")


@pytest.mark.asyncio
async def test_quota_failure_requires_review_instead_of_replay(tmp_path):
    class QuotaRunner:
        async def run(self, task, emit):
            raise RuntimeError("provider usage limit reached")

    store = TaskStore(Database(tmp_path / "state.db"))
    engine = TaskEngine(store, QuotaRunner(), quota_retry_seconds=60)
    task = store.submit("continue the work", session_id="same-session")

    await engine.run_once()

    saved = store.get(task["id"])
    assert saved["status"] == "failed"
    assert saved["retry_at"] is None
    assert saved["result"]["recovery"]["reason"] == "provider_limit"
    assert store.events(task["id"])[-1]["type"] == "task.failed"
    assert store.claim_next() is None
    with store.db.transaction() as conn:
        conn.execute("UPDATE tasks SET retry_at=? WHERE id=?", ("2000-01-01T00:00:00+00:00", task["id"]))
    assert store.claim_next() is None


def test_decode_tolerates_corrupt_json_fields():
    from archon_server.tasks import _decode

    item = _decode({"id": "t1", "skills_json": "not-json", "result_json": "{bad"})

    assert item["skills"] == []
    assert item["result"] is None


def test_event_queries_tolerate_corrupt_payload():
    from archon_server.tasks import _decode_event

    item = _decode_event({"seq": 1, "task_id": "t1", "type": "progress", "data_json": "{bad", "created_at": "now"})

    assert item["data"] == {}


def test_quota_defer_does_not_append_after_cancellation(tmp_path):
    store = TaskStore(Database(tmp_path / "state.db"))
    task = store.submit("quota race")
    attempt_id = store.mark_running(task["id"])
    assert store.request_cancel(task["id"], attempt_id=attempt_id)
    assert store.cancel(task["id"], attempt_id=attempt_id)

    store.defer_for_quota(task["id"], 60, attempt_id=attempt_id)

    assert store.get(task["id"])["status"] == "cancelled"
    assert [event["type"] for event in store.events(task["id"])] == [
        "task.queued", "task.running", "task.cancel_requested", "task.cancelled"
    ]


def test_terminal_write_cannot_resurrect_cancelled_task(tmp_path):
    store = TaskStore(Database(tmp_path / "state.db"))
    task = store.submit("cancel race")
    attempt_id = store.mark_running(task["id"])
    assert store.request_cancel(task["id"], attempt_id=attempt_id)
    assert store.cancel(task["id"], attempt_id=attempt_id)

    assert store.complete(task["id"], {"text": "late answer"}, attempt_id=attempt_id) is False
    assert store.fail(task["id"], "late failure", attempt_id=attempt_id) is False

    assert store.get(task["id"])["status"] == "cancelled"
    assert [event["type"] for event in store.events(task["id"])] == [
        "task.queued", "task.running", "task.cancel_requested", "task.cancelled"
    ]


def test_cancel_queued_reports_transaction_result(tmp_path):
    store = TaskStore(Database(tmp_path / "state.db"))
    task = store.submit("cancel me")

    assert store.cancel_queued(task["id"]) is True
    assert store.cancel_queued(task["id"]) is False
    assert store.get(task["id"])["status"] == "cancelled"


@pytest.mark.asyncio
async def test_engine_does_not_retry_disconnect_after_streamed_output(tmp_path):
    class PartialDisconnectRunner:
        def __init__(self):
            self.calls = 0

        async def run(self, task, emit):
            self.calls += 1
            await emit("output", {"text": "partial code"})
            raise RuntimeError("Daemon worker client closed")

    store = TaskStore(Database(tmp_path / "state.db"))
    runner = PartialDisconnectRunner()
    engine = TaskEngine(store, runner)
    task = store.submit("run once")
    await engine.run_once()

    saved = store.get(task["id"])
    assert runner.calls == 1
    assert saved["status"] == "failed"
    assert "Daemon worker client closed" in saved["error"]
    assert not any("retrying this turn once" in str(event["data"].get("text", ""))
                   for event in store.events(task["id"]))


@pytest.mark.asyncio
async def test_engine_does_not_retry_disconnect_after_thinking_or_code(tmp_path):
    class PartialDisconnectRunner:
        def __init__(self):
            self.calls = 0

        async def run(self, task, emit):
            self.calls += 1
            await emit("thinking", {"text": "checking"})
            await emit("code", {"text": "print(1)"})
            raise RuntimeError("Daemon worker client closed")

    store = TaskStore(Database(tmp_path / "state.db"))
    runner = PartialDisconnectRunner()
    engine = TaskEngine(store, runner)
    task = store.submit("do not duplicate side effects")
    await engine.run_once()

    assert runner.calls == 1
    assert store.get(task["id"])["status"] == "failed"


def test_global_event_cursor_preserves_order_across_many_sessions(tmp_path):
    store = TaskStore(Database(tmp_path / "state.db"))
    tasks = [store.submit(f"session-{index}") for index in range(4)]
    for index in range(80):
        store.append_event(tasks[index % 4]["id"], "message.delta", {"index": index})

    events = store.all_events(after=0, limit=500)
    replay = store.all_events(after=events[37]["seq"], limit=500)

    assert len(events) == 84
    assert [event["seq"] for event in events] == sorted(event["seq"] for event in events)
    assert [event["seq"] for event in replay] == [event["seq"] for event in events[38:]]
