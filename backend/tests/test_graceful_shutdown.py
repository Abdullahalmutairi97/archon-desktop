import asyncio

import pytest

from archon_server.app import create_app
from archon_server.config import Settings


class BlockingRunner:
    def __init__(self):
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def run(self, task, emit):
        self.started.set()
        await self.release.wait()
        return {"text": "finished safely", "session_id": task.get("session_id") or f"prime-{task['id']}"}


@pytest.mark.asyncio
async def test_shutdown_waits_for_active_task_instead_of_cancelling_it(tmp_path):
    runner = BlockingRunner()
    app = create_app(Settings(
        data_dir=tmp_path, auth_token="test", worker_count=1,
        worker_poll_seconds=0.01,
    ), runner=runner)
    lifespan = app.router.lifespan_context(app)
    await lifespan.__aenter__()
    task = app.state.store.submit("finish before restart")
    await asyncio.wait_for(runner.started.wait(), timeout=1)
    queued = app.state.store.submit("wait until the next startup")

    shutdown = asyncio.create_task(lifespan.__aexit__(None, None, None))
    await asyncio.sleep(0.05)

    assert not shutdown.done(), "shutdown cancelled the active Archon turn"
    runner.release.set()
    await asyncio.wait_for(shutdown, timeout=1)
    assert app.state.store.get(task["id"])["status"] == "completed"
    assert app.state.store.get(queued["id"])["status"] == "queued"
    assert app.state.store.get(queued["id"])["started_at"] is None
    assert [event["type"] for event in app.state.store.events(task["id"])] == [
        "task.queued", "task.running", "task.completed",
    ]


@pytest.mark.asyncio
async def test_shutdown_drains_queued_telegram_turn_before_stopping_workers(tmp_path, monkeypatch):
    import archon_server.app as app_module

    class Telegram:
        def __init__(self):
            self.returned = False
            self.sent = []

        async def get_updates(self, offset, timeout=30):
            if self.returned:
                await asyncio.Event().wait()
            self.returned = True
            return [{
                "update_id": 1,
                "message": {"from": {"id": 42}, "chat": {"id": 99}, "text": "telegram turn"},
            }]

        async def send_message(self, chat_id, text):
            self.sent.append((chat_id, text))

    class FirstTurnBlocks:
        def __init__(self):
            self.calls = 0
            self.started = asyncio.Event()
            self.release = asyncio.Event()

        async def run(self, task, emit):
            self.calls += 1
            if self.calls == 1:
                self.started.set()
                await self.release.wait()
            return {"text": "done", "session_id": task.get("session_id") or f"prime-{task['id']}"}

    telegram = Telegram()
    runner = FirstTurnBlocks()
    monkeypatch.setattr(app_module, "TelegramBotClient", lambda _token: telegram)
    app = create_app(Settings(
        data_dir=tmp_path, auth_token="test", worker_count=1,
        worker_poll_seconds=0.01, telegram_bot_token="token", telegram_allowed_user_id=42,
    ), runner=runner)
    lifespan = app.router.lifespan_context(app)
    await lifespan.__aenter__()
    first = app.state.store.submit("already active")
    await asyncio.wait_for(runner.started.wait(), timeout=1)
    for _ in range(100):
        if len(app.state.store.list()) == 2:
            break
        await asyncio.sleep(0.01)
    assert len(app.state.store.list()) == 2

    shutdown = asyncio.create_task(lifespan.__aexit__(None, None, None))
    await asyncio.sleep(0.05)
    assert not shutdown.done()
    runner.release.set()
    await asyncio.wait_for(shutdown, timeout=2)

    assert app.state.store.get(first["id"])["status"] == "completed"
    assert all(task["status"] == "completed" for task in app.state.store.list())
    assert telegram.sent == [
        (99, "Prime received your request and is working. I will send the result here."),
        (99, "done"),
    ]


@pytest.mark.asyncio
async def test_shutdown_still_stops_engine_when_telegram_poll_failed(tmp_path, monkeypatch):
    import archon_server.app as app_module

    class BrokenTelegram:
        async def get_updates(self, offset, timeout=30):
            raise RuntimeError("network down")

        async def send_message(self, chat_id, text):
            raise AssertionError("no message should be sent")

    monkeypatch.setattr(app_module, "TelegramBotClient", lambda _token: BrokenTelegram())
    app = create_app(Settings(
        data_dir=tmp_path, auth_token="test", worker_count=1,
        worker_poll_seconds=0.01, telegram_bot_token="token", telegram_allowed_user_id=42,
    ), runner=BlockingRunner())
    lifespan = app.router.lifespan_context(app)
    await lifespan.__aenter__()
    await asyncio.sleep(0)

    await lifespan.__aexit__(None, None, None)

    assert app.state.engine._stop.is_set()
