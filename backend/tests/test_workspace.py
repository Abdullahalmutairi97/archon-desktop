import json
import sqlite3
from pathlib import Path

from archon_server.services.workspace import ProjectService, SessionService


def make_state(path: Path) -> None:
    conn = sqlite3.connect(path)
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
    conn.executemany(
        "INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?)",
        [
            ("chat-1", "archon-desktop", "Desktop rebuild", "gpt-test", "/work/project", "2026-07-24T10:00:00Z", None, 2, 0),
            ("cron-1", "cron", "Daily check", "gpt-test", "/work", "2026-07-24T09:00:00Z", None, 1, 0),
            ("old-1", "cli", "Archived", "gpt-test", "/work", "2026-07-23T09:00:00Z", None, 1, 1),
        ],
    )
    conn.executemany(
        "INSERT INTO messages(session_id,role,content,timestamp,active,compacted) VALUES (?,?,?,?,?,?)",
        [
            ("chat-1", "user", "Rebuild the interface", "2026-07-24T10:00:00Z", 1, 0),
            ("chat-1", "assistant", "Done cleanly", "2026-07-24T10:01:00Z", 1, 0),
            ("chat-1", "tool", "secret tool noise", "2026-07-24T10:00:30Z", 1, 0),
            ("chat-1", "assistant", "[PRIOR CONTEXT — internal]", "2026-07-24T10:00:40Z", 1, 0),
            ("chat-1", "user", "[Your active task list was preserved across context compression]", "2026-07-24T10:00:50Z", 1, 0),
            ("chat-1", "user", "You've reached the maximum number of tool-calling iterations allowed. Please provide a final response.", "2026-07-24T10:00:55Z", 1, 0),
            ("chat-1", "user", "Make it smooth", "2026-07-24T10:01:10Z", 1, 0),
        ],
    )
    conn.commit()
    conn.close()


def make_projects(path: Path) -> None:
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        CREATE TABLE projects (id TEXT PRIMARY KEY, slug TEXT, name TEXT, description TEXT, icon TEXT, color TEXT, board_slug TEXT, primary_path TEXT, created_at TEXT, archived INTEGER DEFAULT 0);
        CREATE TABLE project_folders (project_id TEXT, path TEXT, label TEXT, is_primary INTEGER, added_at TEXT);
        """
    )
    conn.execute("INSERT INTO projects VALUES (?,?,?,?,?,?,?,?,?,?)", ("p1", "studio", "Studio", "Main product", "box", "#7158e2", None, "/work/project", "2026-07-20", 0))
    conn.execute("INSERT INTO project_folders VALUES (?,?,?,?,?)", ("p1", "/work/project", "Main", 1, "2026-07-20"))
    conn.commit()
    conn.close()


def test_project_service_lists_real_project_folders(tmp_path):
    path = tmp_path / "projects.db"
    make_projects(path)
    projects = ProjectService(path).list()
    assert projects == [{
        "id": "p1", "slug": "studio", "name": "Studio", "description": "Main product",
        "icon": "box", "color": "#7158e2", "primary_path": "/work/project",
        "folders": [{"path": "/work/project", "label": "Main", "is_primary": True}],
    }]


def test_session_service_lists_chat_sessions_and_resolves_projects(tmp_path):
    state = tmp_path / "state.db"
    projects = tmp_path / "projects.db"
    make_state(state)
    make_projects(projects)
    service = SessionService(state, ProjectService(projects))
    rows = service.list()
    assert [row["id"] for row in rows] == ["chat-1"]
    assert rows[0]["project_id"] == "p1"
    assert rows[0]["preview"] == "Make it smooth"
    assert rows[0]["last_active"] == "2026-07-24T10:01:10Z"


def test_session_service_returns_only_user_and_assistant_messages(tmp_path):
    state = tmp_path / "state.db"
    projects = tmp_path / "projects.db"
    make_state(state)
    make_projects(projects)
    messages = SessionService(state, ProjectService(projects)).messages("chat-1")
    assert [message["role"] for message in messages] == ["user", "assistant", "user"]
    assert "secret tool noise" not in json.dumps(messages)
    assert "tool-calling iterations" not in json.dumps(messages)
