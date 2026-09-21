from __future__ import annotations

import asyncio
import json
import uuid
import re
from datetime import datetime, timezone
from typing import Any, Protocol, Mapping

from .db import Database
from .hermes_runner import RunnerCancelled


MAX_EVENT_TEXT = 4096
_EVENT_TRUNCATION_MARKER = "\n…[truncated]"
_RECOVERY_GUIDANCE = (
    "Side effects are unknown. Review the workspace and agent session and confirm "
    "the previous runner has stopped before submitting another task. "
    "This task will not be retried automatically."
)


def _cap_event_text(value: str) -> str:
    if len(value) <= MAX_EVENT_TEXT:
        return value
    room = MAX_EVENT_TEXT - len(_EVENT_TRUNCATION_MARKER)
    return value[:room] + _EVENT_TRUNCATION_MARKER


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def is_quota_error(error: str) -> bool:
    """Recognise provider exhaustion without confusing ordinary task failures."""
    text = error.lower()
    return bool(re.search(r"\b(?:rate[ -]?limit|quota|usage limit|too many requests|429)\b", text))


def _decode(row) -> dict[str, Any]:
    item = dict(row)
    try:
        skills = json.loads(item.pop("skills_json") or "[]")
    except (TypeError, json.JSONDecodeError):
        skills = []
    item["skills"] = skills if isinstance(skills, list) else []
    try:
        result = json.loads(item.pop("result_json")) if item.get("result_json") else None
    except (TypeError, json.JSONDecodeError):
        result = None
    item["result"] = result
    return item


def _decode_event(row) -> dict[str, Any]:
    try:
        data = json.loads(row["data_json"])
    except (TypeError, json.JSONDecodeError):
        data = {}
    return {"seq": row["seq"], "task_id": row["task_id"], "type": row["type"],
            "data": data, "created_at": row["created_at"]}


class Runner(Protocol):
    async def run(self, task: dict[str, Any], emit) -> dict[str, Any]: ...


class TaskStore:
    def __init__(self, db: Database):
        self.db = db

    def submit(self, prompt: str, cwd: str | None = None, model: str | None = None,
               provider: str | None = None, skills: list[str] | None = None,
               session_id: str | None = None, approval_mode: str = "approve",
               chat_only: bool = False, profile: str | None = None,
               request_id: str | None = None) -> dict[str, Any]:
        if request_id and (
            len(request_id) > 200
            or any(char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-" for char in request_id)
        ):
            raise ValueError("Invalid task request id")
        task_id = request_id or uuid.uuid4().hex
        # Reserve the deterministic Prime session at enqueue time. The runner uses
        # the same id, so the UI can open it immediately instead of waiting for
        # the first worker event to finish creating session metadata.
        session_id = session_id or f"prime-{task_id}"
        now = utcnow()
        with self.db.transaction() as conn:
            if request_id and conn.execute("SELECT 1 FROM tasks WHERE id=?", (task_id,)).fetchone():
                # Durable idempotency for external transports such as Telegram:
                # a redelivered update observes the original task instead of
                # repeating a potentially side-effecting prompt.
                pass
            else:
                if session_id and conn.execute(
                    "SELECT 1 FROM deleted_sessions WHERE session_id=? LIMIT 1", (session_id,)
                ).fetchone():
                    raise ValueError("Session has been deleted")
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

    def append_running_event(self, task_id: str, event_type: str, data: dict[str, Any]) -> None:
        """Discard stale runner notifications after a terminal transition."""
        with self.db.transaction() as conn:
            if conn.execute(
                "SELECT 1 FROM tasks WHERE id=? AND status='running'", (task_id,)
            ).fetchone():
                self._append_event(conn, task_id, event_type, data)

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
                "SELECT 1 FROM tasks WHERE session_id=? AND status IN ('queued','running','cancelling') LIMIT 1", (session_id,)
            ).fetchone() is not None

    def running_sessions(self, session_ids: list[str]) -> list[str]:
        unique_ids = list(dict.fromkeys(session_ids))
        if not unique_ids:
            return []
        placeholders = ",".join("?" for _ in unique_ids)
        with self.db.connect() as conn:
            rows = conn.execute(
                f"SELECT DISTINCT session_id FROM tasks WHERE status IN ('queued','running','cancelling') AND session_id IN ({placeholders})",
                unique_ids,
            ).fetchall()
        return [row["session_id"] for row in rows]

    def prepare_session_deletion(self, session_ids: list[str]) -> list[str]:
        """Atomically block future turns and purge idle task history.

        Returns session ids that still have accepted queued/running work; when the
        list is non-empty nothing is changed.
        """
        unique_ids = list(dict.fromkeys(session_ids))
        if not unique_ids:
            return []
        placeholders = ",".join("?" for _ in unique_ids)
        with self.db.transaction() as conn:
            active = [row["session_id"] for row in conn.execute(
                f"SELECT DISTINCT session_id FROM tasks WHERE status IN ('queued','running','cancelling') AND session_id IN ({placeholders})",
                unique_ids,
            )]
            if active:
                return active
            now = utcnow()
            conn.executemany(
                "INSERT INTO deleted_sessions(session_id,deleted_at) VALUES (?,?) "
                "ON CONFLICT(session_id) DO UPDATE SET deleted_at=excluded.deleted_at",
                [(session_id, now) for session_id in unique_ids],
            )
            conn.execute(
                f"DELETE FROM events WHERE task_id IN (SELECT id FROM tasks WHERE session_id IN ({placeholders}))",
                unique_ids,
            )
            conn.execute(f"DELETE FROM tasks WHERE session_id IN ({placeholders})", unique_ids)
            conn.execute(f"DELETE FROM session_locations WHERE session_id IN ({placeholders})", unique_ids)
            conn.execute(f"DELETE FROM session_projects WHERE session_id IN ({placeholders})", unique_ids)
        return []

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
            conn.execute(f"DELETE FROM session_projects WHERE session_id IN ({placeholders})", unique_ids)

    def events(self, task_id: str, after: int = 0, limit: int = 1000) -> list[dict[str, Any]]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """SELECT seq,task_id,type,data_json,created_at FROM events
                   WHERE task_id=? AND seq>? ORDER BY seq ASC LIMIT ?""",
                (task_id, after, max(1, min(limit, 5000))),
            ).fetchall()
        return [_decode_event(row) for row in rows]

    def all_events(self, after: int = 0, limit: int = 1000) -> list[dict[str, Any]]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """SELECT seq,task_id,type,data_json,created_at FROM events
                   WHERE seq>? ORDER BY seq ASC LIMIT ?""",
                (after, max(1, min(limit, 5000))),
            ).fetchall()
        return [_decode_event(row) for row in rows]

    def event_summaries(self, after: int = 0, limit: int = 1000) -> list[dict[str, Any]]:
        """Return log fields without loading unused event payloads."""
        with self.db.connect() as conn:
            rows = conn.execute(
                """SELECT seq, type, created_at FROM events
                   WHERE seq>? ORDER BY seq ASC LIMIT ?""",
                (after, max(1, min(limit, 5000))),
            ).fetchall()
        return [{"seq": row["seq"], "type": row["type"], "created_at": row["created_at"]}
                for row in rows]

    def latest_event_seq(self) -> int:
        """Return the durable global event cursor without replaying the ledger."""
        with self.db.connect() as conn:
            row = conn.execute("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").fetchone()
        return int(row["seq"] if row else 0)

    def mark_running(self, task_id: str) -> None:
        now = utcnow()
        with self.db.transaction() as conn:
            changed = conn.execute(
                """UPDATE tasks SET status='running',started_at=?,updated_at=?
                   WHERE id=? AND status='queued' AND started_at IS NULL""",
                (now, now, task_id),
            ).rowcount
            if changed:
                self._append_event(conn, task_id, "task.running", {"status": "running"})

    def defer_for_quota(self, task_id: str, retry_seconds: float) -> None:
        """Compatibility entry point: a quota error cannot prove no work happened.

        Keep the former call signature for integrations, but never queue a
        started task again without an explicit, reviewed new submission.
        """
        self.interrupt(task_id, "provider_limit", "Provider limit reached.")

    def claim_next(self) -> dict[str, Any] | None:
        now = utcnow()
        with self.db.transaction() as conn:
            row = conn.execute(
                """SELECT candidate.id FROM tasks AS candidate
                   WHERE candidate.status='queued'
                     AND candidate.started_at IS NULL
                     AND (candidate.retry_at IS NULL OR candidate.retry_at <= ?)
                     AND (candidate.session_id IS NULL OR NOT EXISTS (
                       SELECT 1 FROM tasks AS active
                       WHERE active.session_id=candidate.session_id AND active.status='running'
                     ))
                   ORDER BY candidate.created_at ASC LIMIT 1""", (utcnow(),)
            ).fetchone()
            if row is None:
                return None
            changed = conn.execute(
                """UPDATE tasks SET status='running',started_at=COALESCE(started_at,?),retry_at=NULL,error=NULL,updated_at=?
                   WHERE id=? AND status='queued' AND started_at IS NULL""",
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
            existing = conn.execute("SELECT session_id,cwd,status FROM tasks WHERE id=?", (task_id,)).fetchone()
            if existing is None:
                raise KeyError(task_id)
            if existing["status"] not in {"queued", "running"}:
                return
            provisional = f"prime-{task_id}"
            attached = existing["session_id"]
            if not attached or attached == provisional:
                attached = session_id
            conn.execute(
                "UPDATE tasks SET session_id=?,updated_at=? WHERE id=?",
                (attached, now, task_id),
            )
            # Only a task that opened a session is allowed to establish its
            # location. A resumed task may inherit a process cwd, but it must not
            # move the existing Hermes session to a different project.
            if not existing["session_id"] or existing["session_id"] == f"prime-{task_id}":
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
            changed = conn.execute(
                """UPDATE tasks SET status='completed',result_json=?,error=NULL,
                   session_id=CASE WHEN session_id IS NULL OR session_id=? THEN COALESCE(?,session_id) ELSE session_id END,completed_at=?,updated_at=?
                   WHERE id=? AND status IN ('queued','running')""",
                (json.dumps(result), f"prime-{task_id}", result.get("session_id"), now, now, task_id),
            ).rowcount
            if not changed:
                return
            if not existing["session_id"] or existing["session_id"] == f"prime-{task_id}":
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
            changed = conn.execute(
                """UPDATE tasks SET status='failed',error=?,completed_at=?,updated_at=?
                   WHERE id=? AND status IN ('queued','running')""",
                (error[:4000], now, now, task_id),
            ).rowcount
            if changed:
                self._append_event(conn, task_id, "task.failed", {"status": "failed", "error": error[:4000]})

    def cancel(self, task_id: str) -> bool:
        now = utcnow()
        with self.db.transaction() as conn:
            changed = conn.execute(
                "UPDATE tasks SET status='cancelled',completed_at=?,updated_at=? WHERE id=? AND status IN ('queued','running','cancelling')",
                (now, now, task_id),
            ).rowcount
            if changed:
                self._append_event(conn, task_id, "task.cancelled", {"status": "cancelled"})
        return bool(changed)

    def recover_inflight(self) -> int:
        """Record unknown outcomes without replaying potentially applied effects.

        A former version also put quota-limited tasks back into the queue after
        execution started. Only queued rows with no started_at are safe to keep
        eligible on startup. No claim is made that an orphaned runner stopped.
        """
        with self.db.transaction() as conn:
            rows = conn.execute(
                """SELECT id,status FROM tasks WHERE status IN ('running','cancelling')
                   OR (status='queued' AND started_at IS NOT NULL)"""
            ).fetchall()
            for row in rows:
                self._interrupt(
                    conn, row["id"], row["status"], "server_restart",
                    "Server restarted before an execution outcome was recorded.",
                )
        return len(rows)

    def interrupt(self, task_id: str, reason: str, error: str) -> None:
        """Finish a started task in the current clients' failed-status envelope."""
        with self.db.transaction() as conn:
            row = conn.execute("SELECT status FROM tasks WHERE id=?", (task_id,)).fetchone()
            if row is not None and row["status"] in {"running", "cancelling"}:
                self._interrupt(conn, task_id, row["status"], reason, error)

    def _interrupt(self, conn, task_id: str, previous_status: str, reason: str, error: str) -> None:
        now = utcnow()
        recovery = {
            "reason": reason,
            "previous_status": previous_status,
            "side_effects": "unknown",
            "review_required": True,
            "automatic_retry": False,
        }
        error = f"{error[:3500]} {_RECOVERY_GUIDANCE}"
        # Use the supported terminal status/event instead of inventing an
        # interrupted status that existing clients would continue polling.
        changed = conn.execute(
            """UPDATE tasks SET status='failed',result_json=?,error=?,retry_at=NULL,
               completed_at=?,updated_at=? WHERE id=? AND status=?""",
            (json.dumps({"recovery": recovery}), error, now, now, task_id, previous_status),
        ).rowcount
        if changed:
            self._append_event(conn, task_id, "task.failed", {
                "status": "failed", "error": error, "recovery": recovery,
            })


class TaskEngine:
    def __init__(self, store: TaskStore, runner: Runner | Mapping[str, Runner], poll_seconds: float = 0.5, quota_retry_seconds: float = 18000):
        self.store = store
        self.runner = runner
        self.poll_seconds = poll_seconds
        # Retain the constructor argument for callers; started work is no longer
        # replayed automatically after a provider error.
        self.quota_retry_seconds = quota_retry_seconds
        self._stop = asyncio.Event()
        self._recovered = False

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
            self.store.append_running_event(task["id"], event_type, data)

        runner = self._runner_for(task)
        try:
            # Missing output does not prove that the runner made no side effects.
            # Each claim invokes the runner once, including transport failures.
            result = await runner.run(task, emit)
        except RunnerCancelled:
            self.store.cancel(task["id"])
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            message = str(exc)
            if is_quota_error(message):
                self.store.interrupt(task["id"], "provider_limit", message)
            elif "Daemon worker client closed" in message:
                self.store.interrupt(task["id"], "runner_disconnected", message)
            else:
                self.store.fail(task["id"], message)
        else:
            self.store.complete(task["id"], result)
        return True

    def _runner_for(self, task: dict[str, Any]) -> Runner:
        if isinstance(self.runner, Mapping):
            return self.runner.get(str(task.get("profile") or ""), self.runner["default"])
        return self.runner

    async def cancel(self, task_id: str) -> None:
        task = self.store.get(task_id)
        if task["status"] == "queued":
            if self.store.cancel(task_id):
                return
            # The worker may have claimed the task between the initial read and
            # the transactional cancellation. Re-check and cancel its process
            # instead of silently allowing the turn to run.
            task = self.store.get(task_id)
            if task["status"] != "running":
                return
        if task["status"] != "running":
            return
        cancel = getattr(self._runner_for(task), "cancel", None)
        if cancel is None:
            raise RuntimeError("The active runner cannot cancel process groups")
        await cancel(task_id)
        self.store.cancel(task_id)

    async def run_forever(self) -> None:
        # Multiple workers share one engine. Recover only once; repeating this
        # operation lets one worker interrupt tasks already claimed by another.
        if not self._recovered:
            self._recovered = True
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
