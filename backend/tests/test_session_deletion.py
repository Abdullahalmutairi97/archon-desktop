import sqlite3

import pytest
from fastapi.testclient import TestClient

from archon_server.app import create_app
from archon_server.config import Settings


def _seed_state(path, session_id: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as conn:
        conn.executescript(
            """
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY, source TEXT, title TEXT, model TEXT, cwd TEXT,
                started_at TEXT, ended_at TEXT, message_count INTEGER, archived INTEGER DEFAULT 0
            );
            CREATE TABLE messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT,
                content TEXT, timestamp TEXT, active INTEGER DEFAULT 1, compacted INTEGER DEFAULT 0
            );
            """
        )
        conn.execute(
            "INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?)",
            (session_id, "archon-desktop", "Delete me", "test", "/work", "2026-08-01", None, 1, 0),
        )
        conn.execute(
            "INSERT INTO messages(session_id,role,content,timestamp) VALUES (?,?,?,?)",
            (session_id, "user", "delete this chat", "2026-08-01"),
        )


def _settings(tmp_path):
    root = tmp_path / "host"
    return Settings(
        archon_root=root,
        hermes_home=root / ".hermes",
        data_dir=root / ".data",
        auth_token="token",
        start_worker=False,
    )


def _count(path, table: str, where: str = "", params: tuple = ()) -> int:
    with sqlite3.connect(path) as conn:
        return conn.execute(f"SELECT COUNT(*) FROM {table} {where}", params).fetchone()[0]


def test_delete_session_purges_its_backend_tasks_and_events(tmp_path):
    settings = _settings(tmp_path)
    session_id = "delete-session"
    _seed_state(settings.profile_home / "state.db", session_id)
    headers = {"Authorization": "Bearer token"}
    app = create_app(settings)

    with TestClient(app) as client:
        task = app.state.store.submit("delete this chat", session_id=session_id, chat_only=True)
        app.state.store.append_event(task["id"], "progress", {"message": "saved"})
        app.state.store.complete(task["id"], {"text": "done"})

        response = client.delete(f"/api/sessions/{session_id}", headers=headers)
        with pytest.raises(ValueError, match="deleted"):
            app.state.store.submit("late turn", session_id=session_id)

    assert response.status_code == 200
    assert _count(settings.profile_home / "state.db", "sessions", "WHERE id=?", (session_id,)) == 0
    assert _count(settings.profile_home / "state.db", "messages", "WHERE session_id=?", (session_id,)) == 0
    assert _count(settings.database_path, "tasks", "WHERE session_id=?", (session_id,)) == 0
    assert _count(settings.database_path, "events", "WHERE task_id=?", (task["id"],)) == 0


def test_delete_running_session_refuses_and_leaves_both_databases_intact(tmp_path):
    settings = _settings(tmp_path)
    session_id = "running-session"
    _seed_state(settings.profile_home / "state.db", session_id)
    headers = {"Authorization": "Bearer token"}
    app = create_app(settings)

    with TestClient(app) as client:
        task = app.state.store.submit("still running", session_id=session_id, chat_only=True)
        app.state.store.mark_running(task["id"])

        response = client.delete(f"/api/sessions/{session_id}", headers=headers)

    assert response.status_code == 409
    assert _count(settings.profile_home / "state.db", "sessions", "WHERE id=?", (session_id,)) == 1
    assert _count(settings.profile_home / "state.db", "messages", "WHERE session_id=?", (session_id,)) == 1
    assert _count(settings.database_path, "tasks", "WHERE session_id=?", (session_id,)) == 1
    assert _count(settings.database_path, "events", "WHERE task_id=?", (task["id"],)) == 2


def test_delete_unknown_session_keeps_backend_task_history(tmp_path):
    settings = _settings(tmp_path)
    _seed_state(settings.profile_home / "state.db", "existing-session")
    headers = {"Authorization": "Bearer token"}
    app = create_app(settings)

    with TestClient(app) as client:
        task = app.state.store.submit("keep this history", session_id="missing-session", chat_only=True)
        response = client.delete("/api/sessions/missing-session", headers=headers)

    assert response.status_code == 404
    assert _count(settings.database_path, "tasks", "WHERE id=?", (task["id"],)) == 1
    assert _count(settings.database_path, "events", "WHERE task_id=?", (task["id"],)) == 1


def test_delete_multiple_sessions_purges_all_selected_session_history(tmp_path):
    settings = _settings(tmp_path)
    first, second = "first-session", "second-session"
    _seed_state(settings.profile_home / "state.db", first)
    with sqlite3.connect(settings.profile_home / "state.db") as conn:
        conn.execute(
            "INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?)",
            (second, "archon-desktop", "Delete me too", "test", "/work", "2026-08-01", None, 1, 0),
        )
        conn.execute(
            "INSERT INTO messages(session_id,role,content,timestamp) VALUES (?,?,?,?)",
            (second, "user", "delete this chat too", "2026-08-01"),
        )
    headers = {"Authorization": "Bearer token"}
    app = create_app(settings)

    with TestClient(app) as client:
        first_task = app.state.store.submit("first history", session_id=first, chat_only=True)
        second_task = app.state.store.submit("second history", session_id=second, chat_only=True)
        app.state.store.complete(first_task["id"], {"text": "done"})
        app.state.store.complete(second_task["id"], {"text": "done"})
        response = client.request(
            "DELETE", "/api/sessions", headers=headers, json={"session_ids": [first, second]}
        )

    assert response.status_code == 200
    assert response.json() == {"ok": True, "deleted": [first, second]}
    assert _count(settings.profile_home / "state.db", "sessions") == 0
    assert _count(settings.profile_home / "state.db", "messages") == 0
    assert _count(settings.database_path, "tasks") == 0
    assert _count(settings.database_path, "events", "WHERE task_id IN (?,?)", (first_task["id"], second_task["id"])) == 0


def test_delete_multiple_sessions_refuses_the_entire_batch_when_one_is_running(tmp_path):
    settings = _settings(tmp_path)
    first, second = "queued-session", "running-session"
    _seed_state(settings.profile_home / "state.db", first)
    with sqlite3.connect(settings.profile_home / "state.db") as conn:
        conn.execute(
            "INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?)",
            (second, "archon-desktop", "Still running", "test", "/work", "2026-08-01", None, 1, 0),
        )
        conn.execute(
            "INSERT INTO messages(session_id,role,content,timestamp) VALUES (?,?,?,?)",
            (second, "user", "keep this chat", "2026-08-01"),
        )
    headers = {"Authorization": "Bearer token"}
    app = create_app(settings)

    with TestClient(app) as client:
        queued_task = app.state.store.submit("queued history", session_id=first, chat_only=True)
        running_task = app.state.store.submit("running history", session_id=second, chat_only=True)
        app.state.store.mark_running(running_task["id"])
        response = client.request(
            "DELETE", "/api/sessions", headers=headers, json={"session_ids": [first, second]}
        )

    assert response.status_code == 409
    assert _count(settings.profile_home / "state.db", "sessions") == 2
    assert _count(settings.profile_home / "state.db", "messages") == 2
    assert _count(settings.database_path, "tasks", "WHERE id IN (?,?)", (queued_task["id"], running_task["id"])) == 2


def test_delete_queued_session_is_refused_without_losing_the_turn(tmp_path):
    settings = _settings(tmp_path)
    session_id = "queued-delete-session"
    _seed_state(settings.profile_home / "state.db", session_id)
    headers = {"Authorization": "Bearer token"}
    app = create_app(settings)

    with TestClient(app) as client:
        task = app.state.store.submit("accepted turn", session_id=session_id, chat_only=True)
        response = client.delete(f"/api/sessions/{session_id}", headers=headers)

    assert response.status_code == 409
    assert _count(settings.profile_home / "state.db", "sessions", "WHERE id=?", (session_id,)) == 1
    assert _count(settings.database_path, "tasks", "WHERE id=?", (task["id"],)) == 1
