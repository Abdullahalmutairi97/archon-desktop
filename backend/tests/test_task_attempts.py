import concurrent.futures
import sqlite3
import asyncio

import pytest

from archon_server.db import Database
from archon_server.tasks import TaskEngine, TaskStore


def new_store(tmp_path):
    return TaskStore(Database(tmp_path / "state.db"))


def test_claim_persists_one_attempt_and_running_event_atomically(tmp_path):
    store = new_store(tmp_path)
    task = store.submit("once", runtime_id="prime", cwd="/workspace", project_id="project-a")

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        claims = list(pool.map(lambda _: store.claim_next(), range(2)))

    claimed = [item for item in claims if item is not None]
    assert len(claimed) == 1
    attempt_id = claimed[0]["current_attempt_id"]
    assert attempt_id
    assert claimed[0]["id"] == task["id"]
    with store.db.connect() as conn:
        attempt = conn.execute("SELECT * FROM task_attempts WHERE id=?", (attempt_id,)).fetchone()
        running = conn.execute(
            "SELECT attempt_id FROM events WHERE task_id=? AND type='task.running'", (task["id"],)
        ).fetchall()
    assert attempt["task_id"] == task["id"]
    assert attempt["ordinal"] == 1
    assert attempt["state"] == "claimed"
    assert attempt["started_at"] is None
    assert (attempt["runtime_id"], attempt["cwd"], attempt["project_id"]) == (
        "prime", "/workspace", "project-a"
    )
    assert [row["attempt_id"] for row in running] == [attempt_id]
    assert store.claim_next() is None


def test_claim_rolls_back_task_attempt_and_event_together(tmp_path, monkeypatch):
    store = new_store(tmp_path)
    task = store.submit("rollback")

    def fail(*_args, **_kwargs):
        raise RuntimeError("injected event failure")

    monkeypatch.setattr(store, "_append_event", fail)
    with pytest.raises(RuntimeError, match="injected"):
        store.claim_next()

    saved = store.get(task["id"])
    assert saved["status"] == "queued"
    assert saved["current_attempt_id"] is None
    with store.db.connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM task_attempts").fetchone()[0] == 0
        assert conn.execute(
            "SELECT COUNT(*) FROM events WHERE task_id=? AND type='task.running'", (task["id"],)
        ).fetchone()[0] == 0


def test_attempt_ordinals_survive_replacement_and_delete_with_task(tmp_path):
    store = new_store(tmp_path)
    task = store.submit("first try")
    first = store.claim_next()
    first_id = first["current_attempt_id"]
    assert store.complete(task["id"], {"text": "finished"}, attempt_id=first_id)

    # Isolate the same-task replacement case even though no public retry exists.
    with store.db.transaction() as conn:
        conn.execute(
            "UPDATE tasks SET status='queued',started_at=NULL,completed_at=NULL,result_json=NULL,error=NULL WHERE id=?",
            (task["id"],),
        )
    second = store.claim_next()
    second_id = second["current_attempt_id"]
    assert second_id != first_id
    with store.db.connect() as conn:
        rows = conn.execute(
            "SELECT id,ordinal,state FROM task_attempts WHERE task_id=? ORDER BY ordinal", (task["id"],)
        ).fetchall()
    assert [(r["id"], r["ordinal"], r["state"]) for r in rows] == [
        (first_id, 1, "completed"), (second_id, 2, "claimed")
    ]

    with store.db.transaction() as conn:
        conn.execute("DELETE FROM tasks WHERE id=?", (task["id"],))
    with store.db.connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM task_attempts WHERE task_id=?", (task["id"],)).fetchone()[0] == 0


def test_stale_and_missing_attempt_tokens_cannot_mutate_replacement(tmp_path):
    store = new_store(tmp_path)
    task = store.submit("replacement", cwd="/workspace", runtime_id="prime")
    old_id = store.claim_next()["current_attempt_id"]
    assert store.complete(task["id"], {"text": "first outcome"}, attempt_id=old_id)
    with store.db.transaction() as conn:
        conn.execute(
            "UPDATE tasks SET status='queued',started_at=NULL,completed_at=NULL,result_json=NULL,error=NULL WHERE id=?",
            (task["id"],),
        )
    current_id = store.claim_next()["current_attempt_id"]
    assert current_id != old_id
    before_events = store.latest_event_seq()

    assert store.append_running_event(task["id"], "progress", {"message": "late"}, attempt_id=old_id) is False
    assert store.append_running_event(task["id"], "progress", {"message": "missing"}) is False
    assert store.set_session(task["id"], "late-session", attempt_id=old_id) is False
    assert store.set_session(task["id"], "missing-session") is False
    assert store.complete(task["id"], {"text": "late"}, attempt_id=old_id) is False
    assert store.complete(task["id"], {"text": "missing"}) is False
    assert store.fail(task["id"], "late", attempt_id=old_id) is False
    assert store.fail(task["id"], "missing") is False
    assert store.interrupt(task["id"], "late", "late", attempt_id=old_id) is False
    assert store.interrupt(task["id"], "missing", "missing") is False
    assert store.request_cancel(task["id"], attempt_id=old_id) is False
    assert store.request_cancel(task["id"]) is False
    assert store.cancel(task["id"], attempt_id=old_id) is False
    assert store.cancel(task["id"]) is False

    assert store.latest_event_seq() == before_events
    assert store.get(task["id"])["current_attempt_id"] == current_id
    assert store.get(task["id"])["status"] == "running"
    assert store.db.session_locations(["late-session"]) == {}
    with store.db.connect() as conn:
        assert conn.execute(
            "SELECT COUNT(*) FROM session_ownership WHERE session_id='late-session'"
        ).fetchone()[0] == 0


def test_cancel_intent_blocks_completion_until_teardown_finalizes(tmp_path):
    store = new_store(tmp_path)
    task = store.submit("cancel race")
    attempt_id = store.claim_next()["current_attempt_id"]
    assert store.mark_attempt_running(task["id"], attempt_id=attempt_id)

    assert store.request_cancel(task["id"], attempt_id=attempt_id)
    assert store.attempt_active(task["id"], attempt_id) is False
    assert store.complete(task["id"], {"text": "completion raced intent"}, attempt_id=attempt_id) is False
    assert store.append_running_event(task["id"], "progress", {}, attempt_id=attempt_id) is False
    assert store.get(task["id"])["status"] == "running"
    with store.db.connect() as conn:
        row = conn.execute("SELECT cancel_requested_at,state FROM task_attempts WHERE id=?", (attempt_id,)).fetchone()
    assert row["cancel_requested_at"]
    assert row["state"] == "running"

    assert store.cancel(task["id"], attempt_id=attempt_id)
    assert store.get(task["id"])["status"] == "cancelled"
    with store.db.connect() as conn:
        row = conn.execute("SELECT state,finished_at FROM task_attempts WHERE id=?", (attempt_id,)).fetchone()
    assert row["state"] == "cancelled"
    assert row["finished_at"]


def test_cancel_teardown_failure_keeps_intent_and_denies_late_output(tmp_path):
    store = new_store(tmp_path)
    task = store.submit("cancel failure")
    attempt_id = store.claim_next()["current_attempt_id"]
    assert store.request_cancel(task["id"], attempt_id=attempt_id)

    # A failing adapter teardown never calls cancel/finalize; durable intent
    # keeps the task reviewable and fences late completion after process state is unknown.
    assert store.complete(task["id"], {"text": "late output"}, attempt_id=attempt_id) is False
    assert store.get(task["id"])["status"] == "running"
    assert store.cancel(task["id"], attempt_id="another-attempt") is False
    with store.db.connect() as conn:
        attempt = conn.execute("SELECT cancel_requested_at,state FROM task_attempts WHERE id=?", (attempt_id,)).fetchone()
    assert attempt["cancel_requested_at"]
    assert attempt["state"] == "claimed"


@pytest.mark.parametrize("runtime_id", ["prime", "pi"])
def test_canonical_session_identity_is_frozen_at_admission(tmp_path, runtime_id):
    store = new_store(tmp_path)
    task = store.submit("announce", cwd="/workspace", profile=runtime_id, runtime_id=runtime_id,
                        project_id="project-a")
    attempt_id = store.claim_next()["current_attempt_id"]
    assert store.mark_attempt_running(task["id"], attempt_id=attempt_id)
    captured_session = task["session_id"]

    assert store.append_running_event(
        task["id"], "session", {"session_id": "foreign-session"}, attempt_id=attempt_id
    ) is False
    assert store.append_running_event(
        task["id"], "session", {"session_id": captured_session}, attempt_id=attempt_id
    ) is True
    assert store.get(task["id"])["session_id"] == captured_session
    with store.db.connect() as conn:
        owner = conn.execute(
            "SELECT runtime_id,cwd,state FROM session_ownership WHERE session_id=?", (captured_session,)
        ).fetchone()
        session_event = conn.execute(
            "SELECT attempt_id FROM events WHERE task_id=? AND type='session' ORDER BY seq DESC LIMIT 1",
            (task["id"],),
        ).fetchone()
        assert conn.execute(
            "SELECT COUNT(*) FROM session_ownership WHERE session_id='foreign-session'"
        ).fetchone()[0] == 0
    assert (owner["runtime_id"], owner["cwd"], owner["state"]) == (runtime_id, "/workspace", "verified")
    assert session_event["attempt_id"] == attempt_id


def test_legacy_provisional_attachment_binds_projectless_session_and_location_atomically(tmp_path):
    store = new_store(tmp_path)
    task = store.submit("legacy injected session", cwd="/workspace", project_id=None)
    attempt_id = store.claim_next()["current_attempt_id"]
    assert store.mark_attempt_running(task["id"], attempt_id=attempt_id)

    assert store.append_running_event(
        task["id"], "session", {"session_id": "new-legacy-session"}, attempt_id=attempt_id
    ) is True
    with store.db.connect() as conn:
        binding = conn.execute(
            "SELECT project_id FROM session_projects WHERE session_id='new-legacy-session'"
        ).fetchone()
        event = conn.execute(
            "SELECT attempt_id FROM events WHERE task_id=? AND type='session' ORDER BY seq DESC LIMIT 1",
            (task["id"],),
        ).fetchone()
        owner = conn.execute(
            "SELECT 1 FROM session_ownership WHERE session_id='new-legacy-session'"
        ).fetchone()
    assert binding is not None and binding["project_id"] is None
    assert store.db.session_locations(["new-legacy-session"])["new-legacy-session"]["cwd"] == "/workspace"
    assert event["attempt_id"] == attempt_id
    assert owner is None
    assert store.get(task["id"])["session_id"] == "new-legacy-session"


def test_provisional_attachment_rejects_running_project_owner_collision_without_partial_writes(tmp_path):
    store = new_store(tmp_path)
    occupant = store.submit("other project", cwd="/workspace", profile="prime", runtime_id="prime",
                            session_id="owned-other", project_id="project-b")
    occupant_attempt = store.claim_next()["current_attempt_id"]
    assert store.mark_attempt_running(occupant["id"], attempt_id=occupant_attempt)
    candidate = store.submit("new project", cwd="/workspace", project_id="project-a")
    candidate_attempt = store.mark_running(candidate["id"])
    assert candidate_attempt

    before_seq = store.latest_event_seq()
    before_locations = store.db.session_locations(["owned-other"])
    with store.db.connect() as conn:
        before_projects = [tuple(row) for row in conn.execute(
            "SELECT session_id,project_id,updated_at FROM session_projects ORDER BY session_id"
        )]
        before_owners = [tuple(row) for row in conn.execute(
            "SELECT session_id,runtime_id,cwd,state FROM session_ownership ORDER BY session_id"
        )]

    assert store.append_running_event(
        candidate["id"], "session", {"session_id": "owned-other"}, attempt_id=candidate_attempt
    ) is False
    assert store.latest_event_seq() == before_seq
    assert store.get(candidate["id"])["session_id"] == candidate["session_id"]
    assert store.db.session_locations(["owned-other"]) == before_locations
    with store.db.connect() as conn:
        assert [tuple(row) for row in conn.execute(
            "SELECT session_id,project_id,updated_at FROM session_projects ORDER BY session_id"
        )] == before_projects
        assert [tuple(row) for row in conn.execute(
            "SELECT session_id,runtime_id,cwd,state FROM session_ownership ORDER BY session_id"
        )] == before_owners


def test_provisional_attachment_rejects_project_mismatch_and_native_pi_ids(tmp_path):
    store = new_store(tmp_path)
    task = store.submit("legacy provisional", cwd="/workspace", project_id="project-a")
    attempt_id = store.claim_next()["current_attempt_id"]
    assert store.mark_attempt_running(task["id"], attempt_id=attempt_id)
    with store.db.transaction() as conn:
        conn.execute(
            "INSERT INTO session_projects(session_id,project_id,updated_at) VALUES ('project-conflict','project-b','existing')"
        )
    before_seq = store.latest_event_seq()
    assert store.append_running_event(
        task["id"], "session", {"session_id": "project-conflict"}, attempt_id=attempt_id
    ) is False
    assert store.append_running_event(
        task["id"], "session", {"session_id": "pi-native-read-only"}, attempt_id=attempt_id
    ) is False
    assert store.latest_event_seq() == before_seq
    assert store.get(task["id"])["session_id"] == task["session_id"]
    assert store.db.session_locations(["project-conflict", "pi-native-read-only"]) == {}


@pytest.mark.asyncio
async def test_invalid_canonical_result_session_fails_captured_attempt(tmp_path):
    class ForeignSessionRunner:
        async def run(self, task, _emit):
            return {"text": "should not complete", "session_id": "different-session"}

    store = new_store(tmp_path)
    task = store.submit("bad result", cwd="/workspace", profile="prime", runtime_id="prime")
    engine = TaskEngine(store, ForeignSessionRunner())
    assert await engine.run_once()

    saved = store.get(task["id"])
    attempt_id = saved["current_attempt_id"]
    assert saved["status"] == "failed"
    assert "admitted identity" in saved["error"]
    with store.db.connect() as conn:
        attempt = conn.execute("SELECT state,error FROM task_attempts WHERE id=?", (attempt_id,)).fetchone()
    assert attempt["state"] == "failed"
    assert attempt["error"] == saved["error"]
    failure = store.events(task["id"])[-1]
    assert failure["type"] == "task.failed"
    assert failure["attempt_id"] == attempt_id
    assert store.latest_event_seq() == 3


@pytest.mark.asyncio
async def test_failed_engine_teardown_keeps_intent_and_denies_late_result(tmp_path):
    class TeardownFailureRunner:
        def __init__(self):
            self.started = asyncio.Event()
            self.release = asyncio.Event()
            self.task = None

        async def run(self, task, emit):
            self.task = task
            self.started.set()
            await self.release.wait()
            assert task["_attempt_active"]() is False
            await emit("progress", {"message": "after cancel intent"})
            return {"text": "late completion"}

        async def cancel(self, _task_id):
            raise RuntimeError("fixture teardown failed")

    store = new_store(tmp_path)
    runner = TeardownFailureRunner()
    engine = TaskEngine(store, runner)
    task = store.submit("retain review state")
    worker = asyncio.create_task(engine.run_once())
    await asyncio.wait_for(runner.started.wait(), timeout=2)

    with pytest.raises(RuntimeError, match="teardown failed"):
        await engine.cancel(task["id"])
    active = store.get(task["id"])
    assert active["status"] == "running"
    attempt_id = active["current_attempt_id"]
    with store.db.connect() as conn:
        attempt = conn.execute(
            "SELECT cancel_requested_at,state FROM task_attempts WHERE id=?", (attempt_id,)
        ).fetchone()
    assert attempt["cancel_requested_at"]
    assert attempt["state"] == "running"

    runner.release.set()
    await asyncio.wait_for(worker, timeout=2)
    assert store.get(task["id"])["status"] == "running"
    assert [event["type"] for event in store.events(task["id"])] == [
        "task.queued", "task.running", "task.cancel_requested",
    ]
