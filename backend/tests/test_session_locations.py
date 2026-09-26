import sqlite3
from pathlib import Path

from archon_server.db import Database
from archon_server.services.workspace import ProjectService, SessionService
from archon_server.tasks import TaskStore


def make_state(path: Path, cwd: str = "") -> None:
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
            ("tracked-session", "archon-desktop", "Tracked", "gpt-test", cwd, "2026-08-04T10:00:00Z", None, 1, 0),
        )
        conn.execute(
            "INSERT INTO messages(session_id,role,content,timestamp) VALUES (?,?,?,?)",
            ("tracked-session", "user", "Keep this location", "2026-08-04T10:01:00Z"),
        )


def make_projects(path: Path) -> None:
    with sqlite3.connect(path) as conn:
        conn.executescript(
            """
            CREATE TABLE projects (id TEXT PRIMARY KEY, slug TEXT, name TEXT, description TEXT, icon TEXT, color TEXT, board_slug TEXT, primary_path TEXT, created_at TEXT, archived INTEGER DEFAULT 0);
            CREATE TABLE project_folders (project_id TEXT, path TEXT, label TEXT, is_primary INTEGER, added_at TEXT);
            """
        )
        conn.execute(
            "INSERT INTO projects VALUES (?,?,?,?,?,?,?,?,?,?)",
            ("project-1", "tracked", "Tracked project", "", "folder", "", None, "/work/project", "2026-08-04", 0),
        )
        conn.execute(
            "INSERT INTO project_folders VALUES (?,?,?,?,?)",
            ("project-1", "/work/project", "Main", 1, "2026-08-04"),
        )


def test_announced_session_keeps_dispatch_location_when_hermes_cwd_is_blank(tmp_path):
    state = tmp_path / "state.db"
    projects = tmp_path / "projects.db"
    make_state(state)
    make_projects(projects)
    store = TaskStore(Database(tmp_path / "desktop.db"))
    task = store.submit("build here", cwd="/work/project")
    attempt_id = store.mark_running(task["id"])

    store.set_session(task["id"], "tracked-session", attempt_id=attempt_id)

    rows = SessionService(state, ProjectService(projects), store.db).list()
    assert rows[0]["cwd"] == "/work/project"
    assert rows[0]["project_id"] == "project-1"


def test_session_location_is_retained_after_hermes_stops_reporting_cwd(tmp_path):
    state = tmp_path / "state.db"
    projects = tmp_path / "projects.db"
    make_state(state, cwd="/work/project")
    make_projects(projects)
    database = Database(tmp_path / "desktop.db")
    service = SessionService(state, ProjectService(projects), database)

    assert service.list()[0]["cwd"] == "/work/project"
    with sqlite3.connect(state) as conn:
        conn.execute("UPDATE sessions SET cwd='' WHERE id='tracked-session'")

    rows = service.list()
    assert rows[0]["cwd"] == "/work/project"
    assert rows[0]["project_id"] == "project-1"
