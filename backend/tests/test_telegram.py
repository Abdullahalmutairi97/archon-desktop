from __future__ import annotations

import asyncio

import pytest

from archon_server.db import Database
from archon_server.services.telegram import TelegramBridge
from archon_server.tasks import TaskStore


class FakeTelegram:
    def __init__(self):
        self.sent: list[tuple[int, str]] = []

    async def send_message(self, chat_id: int, text: str) -> None:
        self.sent.append((chat_id, text))


class FakeTasks:
    def __init__(self):
        self.submissions: list[dict] = []

    def submit(self, prompt, **kwargs):
        self.submissions.append({"prompt": prompt, **kwargs})
        return {"id": "task-1"}

    def get(self, _task_id):
        return {"status": "completed", "result": {"text": "Done", "session_id": "prime-1"}}


@pytest.mark.asyncio
async def test_authorized_message_submits_approved_task_replies_and_remembers_session(tmp_path):
    tasks = FakeTasks()
    telegram = FakeTelegram()
    bridge = TelegramBridge(Database(tmp_path / "archon.db"), tasks, telegram, allowed_user_id=42)
    update = {"update_id": 1, "message": {"from": {"id": 42}, "chat": {"id": 99}, "text": "check the server"}}

    await bridge.handle_update(update)

    assert tasks.submissions == [{
        "prompt": "check the server", "cwd": None, "model": None, "provider": None,
        "skills": [], "session_id": None, "approval_mode": "approve", "chat_only": False,
        "profile": None,
    }]
    assert telegram.sent == [(99, "Done")]
    assert bridge.session_for_chat(99) == "prime-1"


@pytest.mark.asyncio
async def test_unauthorized_message_is_ignored(tmp_path):
    tasks = FakeTasks()
    telegram = FakeTelegram()
    bridge = TelegramBridge(Database(tmp_path / "archon.db"), tasks, telegram, allowed_user_id=42)

    await bridge.handle_update({"update_id": 1, "message": {"from": {"id": 7}, "chat": {"id": 99}, "text": "run this"}})

    assert tasks.submissions == []
    assert telegram.sent == []


def test_telegram_is_enabled_only_when_token_and_allowlist_are_configured(monkeypatch):
    from archon_server.config import Settings

    monkeypatch.delenv("ARCHON_DESKTOP_TELEGRAM_BOT_TOKEN", raising=False)
    monkeypatch.delenv("ARCHON_DESKTOP_TELEGRAM_ALLOWED_USER_ID", raising=False)
    assert Settings(_env_file=None).telegram_enabled is False

    monkeypatch.setenv("ARCHON_DESKTOP_TELEGRAM_BOT_TOKEN", "token")
    monkeypatch.setenv("ARCHON_DESKTOP_TELEGRAM_ALLOWED_USER_ID", "42")
    assert Settings(_env_file=None).telegram_enabled is True


@pytest.mark.asyncio
async def test_bridge_does_not_handle_update_returned_after_stop(tmp_path):
    class DelayedTelegram(FakeTelegram):
        def __init__(self):
            super().__init__()
            self.polling = asyncio.Event()
            self.release = asyncio.Event()

        async def get_updates(self, offset, timeout=30):
            self.polling.set()
            await self.release.wait()
            return [{
                "update_id": 1,
                "message": {"from": {"id": 42}, "chat": {"id": 99}, "text": "must not queue"},
            }]

    telegram = DelayedTelegram()
    tasks = TaskStore(Database(tmp_path / "tasks.db"))
    bridge = TelegramBridge(Database(tmp_path / "archon.db"), tasks, telegram, allowed_user_id=42)
    running = asyncio.create_task(bridge.run_forever())
    await telegram.polling.wait()

    bridge.stop()
    telegram.release.set()
    await asyncio.wait_for(running, timeout=1)

    assert tasks.list() == []
    assert telegram.sent == []


@pytest.mark.asyncio
async def test_graceful_restart_resumes_after_processed_update(tmp_path):
    class OneUpdateTelegram(FakeTelegram):
        def __init__(self):
            super().__init__()
            self.offsets = []
            self.sent_event = asyncio.Event()
            self.release_poll = asyncio.Event()

        async def get_updates(self, offset, timeout=30):
            self.offsets.append(offset)
            if len(self.offsets) == 1:
                return [{
                    "update_id": 17,
                    "message": {"from": {"id": 42}, "chat": {"id": 99}, "text": "do this once"},
                }]
            await self.release_poll.wait()
            return []

        async def send_message(self, chat_id, text):
            await super().send_message(chat_id, text)
            self.sent_event.set()

    database = Database(tmp_path / "archon.db")
    tasks = FakeTasks()
    telegram = OneUpdateTelegram()
    first = TelegramBridge(database, tasks, telegram, allowed_user_id=42)
    running = asyncio.create_task(first.run_forever())
    await asyncio.wait_for(telegram.sent_event.wait(), timeout=1)
    first.stop()
    telegram.release_poll.set()
    await asyncio.wait_for(running, timeout=1)

    restarted = TelegramBridge(database, tasks, FakeTelegram(), allowed_user_id=42)

    assert restarted.next_update_offset() == 18
    assert len(tasks.submissions) == 1
    assert tasks.submissions[0]["request_id"] == "telegram-17"
