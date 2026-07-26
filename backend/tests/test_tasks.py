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

    store.complete(task["id"], {"text": "ready", "session_id": "20260725_session"})

    assert store.get(task["id"])["session_id"] == "20260725_session"


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


def test_inflight_tasks_requeue_after_server_restart(tmp_path):
    store = TaskStore(Database(tmp_path / "state.db"))
    task = store.submit("survive a restart")
    store.mark_running(task["id"])

    recovered = store.recover_inflight()

    assert recovered == 1
    assert store.get(task["id"])["status"] == "queued"
    assert store.events(task["id"])[-1]["type"] == "task.recovered"


def test_global_events_replay_in_one_ordered_cursor(tmp_path):
    store = TaskStore(Database(tmp_path / "state.db"))
    first = store.submit("first")
    second = store.submit("second")
    store.append_event(first["id"], "progress", {"message": "three"})

    events = store.all_events(after=0)
    replay = store.all_events(after=events[0]["seq"])

    assert [event["task_id"] for event in events] == [first["id"], second["id"], first["id"]]
    assert replay == events[1:]


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
