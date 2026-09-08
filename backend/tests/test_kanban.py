import sqlite3
from pathlib import Path

from archon_server.services.kanban import KanbanService


class _Agents:
    def resolve(self, assignee):
        return assignee or "default"


def _db(path: Path):
    conn = sqlite3.connect(path)
    conn.executescript("""
        CREATE TABLE tasks (id TEXT, title TEXT, body TEXT, assignee TEXT, status TEXT,
            priority INTEGER, created_by TEXT, created_at TEXT, started_at TEXT,
            completed_at TEXT, consecutive_failures INTEGER, last_failure_error TEXT,
            block_kind TEXT, workspace_kind TEXT, model_override TEXT);
        CREATE TABLE task_runs (id INTEGER PRIMARY KEY, task_id TEXT, outcome TEXT,
            summary TEXT, profile TEXT, started_at TEXT, ended_at TEXT);
    """)
    conn.execute("INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                 ("t_abcdef", "title", "", "agent", "todo", 1, "agent", "now", None, None, 0, None, None, None, None))
    conn.executemany("INSERT INTO task_runs(task_id,outcome) VALUES (?,?)",
                     [("t_abcdef", "old"), ("t_abcdef", "latest")])
    conn.commit(); conn.close()


def test_list_returns_latest_run_for_page_tasks(tmp_path):
    path = tmp_path / "kanban.db"
    _db(path)
    service = KanbanService(path, Path("/bin/true"), _Agents())

    cards = service.list()

    assert cards[0]["last_run"]["outcome"] == "latest"
