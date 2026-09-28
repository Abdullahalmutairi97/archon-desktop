"""Explicit resume after an interrupted attempt is a new task, not a replay.

The P1 M1.6 evidence item asks for failure after a side effect and before result
commit, restart, an explicit resume as a new attempt, and stale completion. The
store-level cases exist already; this module exercises the same path through the
HTTP admission API an operator uses, and checks that the interrupted attempt
stays recorded and cannot complete the resumed work.
"""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from archon_server.app import create_app
from archon_server.config import Settings

TOKEN = "resume-evidence-token"
HEADERS = {"Authorization": f"Bearer {TOKEN}"}


def _settings(tmp_path: Path) -> Settings:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    return Settings(
        archon_root=tmp_path,
        hermes_home=tmp_path / ".hermes",
        data_dir=tmp_path / ".data",
        auth_token=TOKEN,
        start_worker=False,
    )


def _attempts(store, task_id: str) -> list[dict]:
    with store.db.connect() as conn:
        return [
            dict(row) for row in conn.execute(
                "SELECT id,ordinal,state,error FROM task_attempts WHERE task_id=? ORDER BY ordinal",
                (task_id,),
            )
        ]


@pytest.mark.asyncio
async def test_resume_after_interruption_admits_a_new_task_and_refuses_stale_completion(tmp_path):
    settings = _settings(tmp_path)
    effects = tmp_path / "effects.txt"

    class SideEffectThenVanish:
        """Records a durable effect, then vanishes without any outcome."""

        async def run(self, task, emit):
            with effects.open("a", encoding="utf-8") as output:
                output.write(task["prompt"] + "\n")
            if task["prompt"] == "one effect":
                raise asyncio.CancelledError
            return {"text": f"completed {task['prompt']}"}

    app = create_app(settings, runner=SideEffectThenVanish())
    with TestClient(app) as client:
        assert client.post("/api/tasks", json={}).status_code == 401
        admitted = client.post("/api/tasks", headers=HEADERS, json={
            "prompt": "one effect", "cwd": str(settings.archon_root),
            "approval_mode": "auto", "profile": "prime",
        })
        assert admitted.status_code == 202, admitted.text
        first_task = admitted.json()["task"]
        session_id = first_task["session_id"]

        with pytest.raises(asyncio.CancelledError):
            await app.state.engine.run_once()
        assert app.state.store.get(first_task["id"])["status"] == "running"

        # A restart reconciles the started attempt instead of repeating it.
        assert app.state.store.recover_inflight() == 1
        interrupted = app.state.store.get(first_task["id"])
        assert interrupted["status"] == "failed"
        assert interrupted["result"]["recovery"]["review_required"] is True
        assert interrupted["result"]["recovery"]["automatic_retry"] is False
        first_attempts = _attempts(app.state.store, first_task["id"])
        assert len(first_attempts) == 1 and first_attempts[0]["state"] == "interrupted"
        old_attempt = first_attempts[0]["id"]
        assert effects.read_text(encoding="utf-8").splitlines() == ["one effect"]

        # The explicit resume is a new task for the same session.
        resumed = client.post("/api/tasks", headers=HEADERS, json={
            "prompt": "resume", "session_id": session_id, "approval_mode": "auto", "profile": "prime",
        })
        assert resumed.status_code == 202, resumed.text
        resumed_task = resumed.json()["task"]
        assert resumed_task["id"] != first_task["id"]
        assert resumed_task["session_id"] == first_task["session_id"]

        assert await app.state.engine.run_once() is True
        completed = app.state.store.get(resumed_task["id"])
        assert completed["status"] == "completed"
        assert completed["result"]["text"] == "completed resume"
        resumed_attempts = _attempts(app.state.store, resumed_task["id"])
        assert [row["ordinal"] for row in resumed_attempts] == [1]
        assert resumed_attempts[0]["state"] == "completed"
        assert effects.read_text(encoding="utf-8").splitlines() == ["one effect", "resume"]

        # The interrupted attempt stays recorded and cannot touch the resumed task.
        assert _attempts(app.state.store, first_task["id"]) == first_attempts
        before_events = app.state.store.latest_event_seq()
        assert app.state.store.complete(
            resumed_task["id"], {"text": "late result"}, attempt_id=old_attempt,
        ) is False
        assert app.state.store.append_running_event(
            resumed_task["id"], "progress", {"message": "late"}, attempt_id=old_attempt,
        ) is False
        assert app.state.store.fail(resumed_task["id"], "late failure", attempt_id=old_attempt) is False
        assert app.state.store.latest_event_seq() == before_events
        after = app.state.store.get(resumed_task["id"])
        assert after["status"] == "completed" and after["result"]["text"] == "completed resume"
        assert _attempts(app.state.store, resumed_task["id"]) == resumed_attempts


@pytest.mark.asyncio
async def test_an_interrupted_task_cannot_be_resumed_by_replaying_its_own_attempt(tmp_path):
    """A second admission for the same session never reuses the interrupted attempt."""
    settings = _settings(tmp_path)

    class Vanish:
        async def run(self, task, emit):
            raise asyncio.CancelledError

    app = create_app(settings, runner=Vanish())
    with TestClient(app) as client:
        admitted = client.post("/api/tasks", headers=HEADERS, json={
            "prompt": "one effect", "cwd": str(settings.archon_root),
            "approval_mode": "auto", "profile": "prime",
        })
        task = admitted.json()["task"]
        with pytest.raises(asyncio.CancelledError):
            await app.state.engine.run_once()
        assert app.state.store.recover_inflight() == 1
        old_attempt = _attempts(app.state.store, task["id"])[0]["id"]

        # The failed task is not claimable again, so its attempt cannot restart.
        assert app.state.store.claim_next() is None
        assert app.state.store.get(task["id"])["status"] == "failed"
        assert app.state.store.get(task["id"])["current_attempt_id"] == old_attempt
