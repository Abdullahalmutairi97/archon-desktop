from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime, timezone
from typing import Any, Protocol

from .db import Database
from .hermes_runner import RunnerCancelled


MAX_EVENT_TEXT = 4096
_EVENT_TRUNCATION_MARKER = "\n…[truncated]"


def _cap_event_text(value: str) -> str:
    if len(value) <= MAX_EVENT_TEXT:
        return value
    room = MAX_EVENT_TEXT - len(_EVENT_TRUNCATION_MARKER)
    return value[:room] + _EVENT_TRUNCATION_MARKER


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def _decode(row) -> dict[str, Any]:
    item = dict(row)
    item["skills"] = json.loads(item.pop("skills_json") or "[]")
    item["result"] = json.loads(item.pop("result_json")) if item.get("result_json") else None
    return item


class Runner(Protocol):
    async def run(self, task: dict[str, Any], emit) -> dict[str, Any]: ...


class TaskStore:
    def __init__(self, db: Database):
        self.db = db

    def submit(self, prompt: str, cwd: str | None = None, model: str | None = None,
               provider: str | None = None, skills: list[str] | None = None,
               session_id: str | None = None, approval_mode: str = "approve",
               chat_only: bool = False, profile: str | None = None) -> dict[str, Any]:
        task_id = uuid.uuid4().hex
        now = utcnow()
        with self.db.transaction() as conn:
            conn.execute(
                """INSERT INTO tasks
                   (id,prompt,cwd,model,provider,session_id,profile,approval_mode,chat_only,skills_json,status,created_at,updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,'queued',?,?)""",
                (task_id, prompt, cwd, model, provider, session_id, profile, approval_mode, int(chat_only), json.dumps(skills or []), now, now),
            )
            self._append_event(conn, task_id, "task.queued", {"status": "queued"})
        return self.get(task_id)

    def _append_event(self, conn, task_id: str, event_type: str, data: dict[str, Any]) -> int:
        cur = conn.execute(
            "INSERT INTO events(task_id,type,data_json,created_at) VALUES (?,?,?,?)",
            (task_id, event_type, json.dumps(data), utcnow()),
        )
        return int(cur.lastrowid)

    def append_event(self, task_id: str, event_type: str, data: dict[str, Any]) -> int:
        with self.db.transaction() as conn:
            return self._append_event(conn, task_id, event_type, data)

    def get(self, task_id: str) -> dict[str, Any]:
        with self.db.connect() as conn:
            row = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        if row is None:
            raise KeyError(task_id)
        return _decode(row)

    def list(self, limit: int = 100) -> list[dict[str, Any]]:
        with self.db.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?", (max(1, min(limit, 500)),)
            ).fetchall()
        return [_decode(row) for row in rows]

    def has_running_session(self, session_id: str) -> bool:
        with self.db.connect() as conn:
            return conn.execute(
                "SELECT 1 FROM tasks WHERE session_id=? AND status='running' LIMIT 1", (session_id,)
            ).fetchone() is not None

    def running_sessions(self, session_ids: list[str]) -> list[str]:
        unique_ids = list(dict.fromkeys(session_ids))
        if not unique_ids:
            return []
        placeholders = ",".join("?" for _ in unique_ids)
        with self.db.connect() as conn:
            rows = conn.execute(
                f"SELECT DISTINCT session_id FROM tasks WHERE status='running' AND session_id IN ({placeholders})",
                unique_ids,
            ).fetchall()
        return [row["session_id"] for row in rows]

    def purge_session(self, session_id: str) -> None:
        """Delete all backend task history associated with a deleted Hermes session."""
        self.purge_sessions([session_id])

    def purge_sessions(self, session_ids: list[str]) -> None:
        """Delete backend task history for a batch of deleted Hermes sessions."""
        unique_ids = list(dict.fromkeys(session_ids))
        if not unique_ids:
            return
        placeholders = ",".join("?" for _ in unique_ids)
        with self.db.transaction() as conn:
            conn.execute(
                f"DELETE FROM events WHERE task_id IN (SELECT id FROM tasks WHERE session_id IN ({placeholders}))",
                unique_ids,
            )
            conn.execute(f"DELETE FROM tasks WHERE session_id IN ({placeholders})", unique_ids)
            conn.execute(f"DELETE FROM session_locations WHERE session_id IN ({placeholders})", unique_ids)

    def events(self, task_id: str, after: int = 0, limit: int = 1000) -> list[dict[str, Any]]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """SELECT seq,task_id,type,data_json,created_at FROM events
                   WHERE task_id=? AND seq>? ORDER BY seq ASC LIMIT ?""",
                (task_id, after, max(1, min(limit, 5000))),
            ).fetchall()
        return [
            {"seq": row["seq"], "task_id": row["task_id"], "type": row["type"],
             "data": json.loads(row["data_json"]), "created_at": row["created_at"]}
            for row in rows
        ]

    def all_events(self, after: int = 0, limit: int = 1000) -> list[dict[str, Any]]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """SELECT seq,task_id,type,data_json,created_at FROM events
                   WHERE seq>? ORDER BY seq ASC LIMIT ?""",
                (after, max(1, min(limit, 5000))),
            ).fetchall()
        return [
            {"seq": row["seq"], "task_id": row["task_id"], "type": row["type"],
             "data": json.loads(row["data_json"]), "created_at": row["created_at"]}
            for row in rows
        ]

    def mark_running(self, task_id: str) -> None:
        now = utcnow()
        with self.db.transaction() as conn:
            conn.execute(
                "UPDATE tasks SET status='running',started_at=?,updated_at=? WHERE id=?",
                (now, now, task_id),
            )
            self._append_event(conn, task_id, "task.running", {"status": "running"})

    def claim_next(self) -> dict[str, Any] | None:
        now = utcnow()
        with self.db.transaction() as conn:
            row = conn.execute(
                "SELECT id FROM tasks WHERE status='queued' ORDER BY created_at ASC LIMIT 1"
            ).fetchone()
            if row is None:
                return None
            changed = conn.execute(
                """UPDATE tasks SET status='running',started_at=COALESCE(started_at,?),updated_at=?
                   WHERE id=? AND status='queued'""",
                (now, now, row["id"]),
            ).rowcount
            if not changed:
                return None
            self._append_event(conn, row["id"], "task.running", {"status": "running"})
        return self.get(row["id"])

    def set_session(self, task_id: str, session_id: str) -> None:
        """Attach a session to a task while it is still running.

        COALESCE keeps whatever is already there, so a resumed task never has its
        session rewritten by a late announcement.
        """
        now = utcnow()
        with self.db.transaction() as conn:
            existing = conn.execute("SELECT session_id,cwd FROM tasks WHERE id=?", (task_id,)).fetchone()
            if existing is None:
                raise KeyError(task_id)
            conn.execute(
                "UPDATE tasks SET session_id=COALESCE(session_id,?),updated_at=? WHERE id=?",
                (session_id, now, task_id),
            )
            # Only a task that opened a session is allowed to establish its
            # location. A resumed task may inherit a process cwd, but it must not
            # move the existing Hermes session to a different project.
            if not existing["session_id"]:
                self.db.remember_session_location(session_id, existing["cwd"], "task", conn=conn)

    def complete(self, task_id: str, result: dict[str, Any]) -> None:
        now = utcnow()
        event_result = dict(result)
        if isinstance(event_result.get("text"), str):
            event_result["text"] = _cap_event_text(event_result["text"])
        with self.db.transaction() as conn:
            existing = conn.execute("SELECT session_id,cwd FROM tasks WHERE id=?", (task_id,)).fetchone()
            if existing is None:
                raise KeyError(task_id)
            conn.execute(
                """UPDATE tasks SET status='completed',result_json=?,error=NULL,
                   session_id=COALESCE(?,session_id),completed_at=?,updated_at=? WHERE id=?""",
                (json.dumps(result), result.get("session_id"), now, now, task_id),
            )
            if not existing["session_id"]:
                self.db.remember_session_location(str(result.get("session_id") or ""), existing["cwd"], "task", conn=conn)
            self._append_event(
                conn,
                task_id,
                "task.completed",
                {"status": "completed", "result": event_result},
            )

    def fail(self, task_id: str, error: str) -> None:
        now = utcnow()
        with self.db.transaction() as conn:
            conn.execute(
                """UPDATE tasks SET status='failed',error=?,completed_at=?,updated_at=? WHERE id=?""",
                (error[:4000], now, now, task_id),
            )
            self._append_event(conn, task_id, "task.failed", {"status": "failed", "error": error[:4000]})

    def cancel(self, task_id: str) -> None:
        now = utcnow()
        with self.db.transaction() as conn:
            changed = conn.execute(
                "UPDATE tasks SET status='cancelled',completed_at=?,updated_at=? WHERE id=? AND status IN ('queued','running')",
                (now, now, task_id),
            ).rowcount
            if changed:
                self._append_event(conn, task_id, "task.cancelled", {"status": "cancelled"})

    def recover_inflight(self) -> int:
        now = utcnow()
        with self.db.transaction() as conn:
            rows = conn.execute("SELECT id FROM tasks WHERE status='running'").fetchall()
            for row in rows:
                conn.execute(
                    "UPDATE tasks SET status='queued',updated_at=? WHERE id=?", (now, row["id"])
                )
                self._append_event(conn, row["id"], "task.recovered", {"status": "queued"})
        return len(rows)


class TaskEngine:
    def __init__(self, store: TaskStore, runner: Runner, poll_seconds: float = 0.5):
        self.store = store
        self.runner = runner
        self.poll_seconds = poll_seconds
        self._stop = asyncio.Event()

    async def run_once(self) -> bool:
        task = self.store.claim_next()
        if task is None:
            return False

        async def emit(event_type: str, data: dict[str, Any]) -> None:
            # Hermes announces its session id on stderr as soon as it has one,
            # long before the task finishes. Persist it the moment it arrives so
            # the row is addressable while it is still running — otherwise every
            # follow-up prompt has no session to continue and opens a new one.
            if event_type == "session" and data.get("session_id"):
                self.store.set_session(task["id"], str(data["session_id"]))
            self.store.append_event(task["id"], event_type, data)

        try:
            result = await self.runner.run(task, emit)
        except RunnerCancelled:
            self.store.cancel(task["id"])
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.store.fail(task["id"], str(exc))
        else:
            self.store.complete(task["id"], result)
        return True

    async def cancel(self, task_id: str) -> None:
        task = self.store.get(task_id)
        if task["status"] == "queued":
            self.store.cancel(task_id)
            return
        if task["status"] != "running":
            return
        cancel = getattr(self.runner, "cancel", None)
        if cancel is None:
            raise RuntimeError("The active runner cannot cancel process groups")
        await cancel(task_id)
        self.store.cancel(task_id)

    async def run_forever(self) -> None:
        self.store.recover_inflight()
        while not self._stop.is_set():
            worked = await self.run_once()
            if not worked:
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=self.poll_seconds)
                except TimeoutError:
                    pass

    def stop(self) -> None:
        self._stop.set()
