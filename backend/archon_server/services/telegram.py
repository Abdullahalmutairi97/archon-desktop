from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Any, Protocol
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from ..db import Database
from ..tasks import TaskStore, hash_request_payload


logger = logging.getLogger(__name__)


class TelegramClient(Protocol):
    async def get_updates(self, offset: int, timeout: int = 30) -> list[dict[str, Any]]: ...
    async def send_message(self, chat_id: int, text: str) -> None: ...


@dataclass
class TelegramBotClient:
    """Minimal Telegram Bot API client using only the Python standard library."""

    token: str

    async def get_updates(self, offset: int, timeout: int = 30) -> list[dict[str, Any]]:
        response = await self._request("getUpdates", {"offset": offset, "timeout": timeout})
        return response if isinstance(response, list) else []

    async def send_message(self, chat_id: int, text: str) -> None:
        await self._request("sendMessage", {"chat_id": chat_id, "text": text})

    async def _request(self, method: str, data: dict[str, Any]) -> Any:
        def request() -> Any:
            body = urlencode(data).encode()
            url = f"https://api.telegram.org/bot{self.token}/{method}"
            with urlopen(Request(url, data=body, method="POST"), timeout=40) as response:
                try:
                    payload = json.loads(response.read())
                except json.JSONDecodeError as exc:
                    raise RuntimeError(f"Telegram {method} returned invalid JSON") from exc
            if not isinstance(payload, dict) or not payload.get("ok"):
                raise RuntimeError(f"Telegram {method} request failed")
            return payload.get("result")

        return await asyncio.to_thread(request)


class TelegramBridge:
    """Relays allowlisted Telegram messages through Archon's durable task queue."""

    def __init__(self, db: Database, tasks: TaskStore, telegram: TelegramClient, allowed_user_id: int,
                 default_cwd: str | None = None):
        self.db = db
        self.tasks = tasks
        self.telegram = telegram
        self.allowed_user_id = allowed_user_id
        self.default_cwd = default_cwd
        self._stop = asyncio.Event()
        with self.db.connect() as conn:
            conn.execute("""CREATE TABLE IF NOT EXISTS telegram_conversations (
                chat_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )""")
            conn.execute("""CREATE TABLE IF NOT EXISTS telegram_cursor (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                next_offset INTEGER NOT NULL DEFAULT 0
            )""")

    def next_update_offset(self) -> int:
        with self.db.connect() as conn:
            row = conn.execute("SELECT next_offset FROM telegram_cursor WHERE id=1").fetchone()
        return int(row["next_offset"]) if row else 0

    def _remember_update_offset(self, offset: int) -> None:
        with self.db.transaction() as conn:
            conn.execute(
                "INSERT INTO telegram_cursor(id,next_offset) VALUES (1,?) "
                "ON CONFLICT(id) DO UPDATE SET next_offset=MAX(next_offset, excluded.next_offset)",
                (max(0, offset),),
            )

    def session_for_chat(self, chat_id: int) -> str | None:
        with self.db.connect() as conn:
            row = conn.execute("SELECT session_id FROM telegram_conversations WHERE chat_id=?", (str(chat_id),)).fetchone()
            if row and conn.execute("SELECT 1 FROM deleted_sessions WHERE session_id=?", (row["session_id"],)).fetchone():
                return None
        return str(row["session_id"]) if row else None

    def _remember_session(self, chat_id: int, session_id: str) -> None:
        with self.db.transaction() as conn:
            conn.execute(
                """INSERT INTO telegram_conversations(chat_id,session_id,updated_at)
                   VALUES (?,?,CURRENT_TIMESTAMP)
                   ON CONFLICT(chat_id) DO UPDATE SET session_id=excluded.session_id, updated_at=excluded.updated_at""",
                (str(chat_id), session_id),
            )

    async def handle_update(self, update: dict[str, Any], request_id: str | None = None) -> None:
        message = update.get("message") or {}
        sender = message.get("from") or {}
        chat = message.get("chat") or {}
        text = message.get("text")
        if sender.get("id") != self.allowed_user_id or not isinstance(chat.get("id"), int):
            return
        if not isinstance(text, str) or not text.strip():
            await self.telegram.send_message(chat["id"], "Send a text message to create an Archon task.")
            return

        chat_id = chat["id"]
        command = text.strip().split()[0].split("@")[0].lower()
        if command in {"/start", "/help"}:
            await self._send_text(chat_id, "Prime is connected. Send a task in plain text. /status checks this bridge; /new starts a fresh conversation. Tools can change files on the mini-PC.")
            return
        if command == "/status":
            await self._send_text(chat_id, "Prime Telegram bridge is online. " + ("A conversation is available." if self.session_for_chat(chat_id) else "Your next task starts a new conversation."))
            return
        if command == "/new":
            with self.db.transaction() as conn:
                conn.execute("DELETE FROM telegram_conversations WHERE chat_id=?", (str(chat_id),))
            await self._send_text(chat_id, "New Prime conversation ready. Previous history has not been deleted.")
            return
        submit_kwargs = dict(
            cwd=self.default_cwd, model=None, provider=None, skills=[],
            session_id=self.session_for_chat(chat_id), approval_mode="approve",
            chat_only=False, profile=None, runtime_id="prime",
        )
        if request_id is not None:
            submit_kwargs["request_id"] = request_id
            # Completing a turn advances session_for_chat before reply delivery.
            # A delivery retry must retain the immutable inbound request identity
            # rather than fingerprinting that now-changed conversation state.
            submit_kwargs["request_hash"] = hash_request_payload({
                "transport": "telegram", "sender_id": sender["id"],
                "chat_id": chat_id, "text": text, "update_id": update.get("update_id"),
            })
        task = self.tasks.submit(text.strip(), **submit_kwargs)
        if task.get("status") in {"queued", "running"}:
            await self.telegram.send_message(chat_id, "Prime received your request and is working. I will send the result here.")
        result = await self._wait_for_task(task["id"])
        if result["status"] == "completed":
            task_result = result.get("result") or {}
            session_id = task_result.get("session_id")
            if isinstance(session_id, str) and session_id:
                self._remember_session(chat_id, session_id)
            reply = task_result.get("text")
            if not isinstance(reply, str) or not reply.strip():
                logger.warning("Prime returned no text for Telegram task (task=%s)", task["id"])
                reply = "Prime exited without a text reply. I cannot confirm the requested outcome. The task was not automatically rerun; check its history before repeating any action."
        else:
            reply = f"Task {result['status']}: {result.get('error') or 'no details available'}"
        await self._send_text(chat_id, str(reply))
        logger.info("Telegram task reply delivered (task=%s, status=%s)", task["id"], result["status"])

    async def _wait_for_task(self, task_id: str) -> dict[str, Any]:
        while True:
            task = self.tasks.get(task_id)
            if task["status"] in {"completed", "failed", "cancelled", "blocked"}:
                return task
            await asyncio.sleep(0.4)

    async def _send_text(self, chat_id: int, text: str) -> None:
        # Telegram accepts at most 4096 characters in one message.
        for start in range(0, max(1, len(text)), 4096):
            await self.telegram.send_message(chat_id, text[start:start + 4096])

    async def run_forever(self) -> None:
        # Persist the Telegram cursor so a graceful restart never replays a
        # side-effecting prompt.
        offset = self.next_update_offset()
        while not self._stop.is_set():
            try:
                updates = await self.telegram.get_updates(offset)
                # Shutdown may have been requested while long polling was blocked.
                # Never accept fresh work after the engine begins draining.
                if self._stop.is_set():
                    return
                for update in updates:
                    if self._stop.is_set():
                        return
                    update_id = update.get("update_id")
                    # Acknowledge only after handling AND sending the reply. A
                    # redelivery reuses TaskStore's durable request id, so failed
                    # Telegram delivery retries the reply, not the agent action.
                    await self.handle_update(update, f"telegram-{update_id}" if isinstance(update_id, int) else None)
                    if isinstance(update_id, int):
                        offset = max(offset, update_id + 1)
                        self._remember_update_offset(offset)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                # Never log exception text/URLs: HTTP errors can contain the bot token.
                logger.warning("Telegram update/reply failed; cursor retained for retry (type=%s, status=%s)", type(exc).__name__, getattr(exc, "code", "n/a"))
                # A temporary Bot API or network failure must not permanently
                # disable Telegram. Back off, but wake immediately on shutdown.
                if self._stop.is_set():
                    return
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=3)
                except TimeoutError:
                    pass

    def stop(self) -> None:
        self._stop.set()
