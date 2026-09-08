from __future__ import annotations

import re
import sqlite3
import subprocess
from pathlib import Path
from typing import Any

# Board statuses the Hermes kanban kernel uses, in the order a card moves through them.
COLUMNS = ["triage", "todo", "ready", "running", "blocked", "scheduled", "done"]

_TASK_ID = re.compile(r"^t_[0-9a-f]{6,32}$")


class KanbanService:
    """Read the Hermes board directly; mutate it only through `hermes kanban`.

    Reads are plain read-only SQLite. Writes go through the CLI because the kernel
    owns atomic claim, dependency links, the failure counter and block-recurrence
    routing — a direct UPDATE bypasses all of it.
    """

    def __init__(self, db_path: Path, hermes_executable: Path, agents):
        self.db_path = Path(db_path)
        self.hermes = Path(hermes_executable)
        self.agents = agents

    # ---------- reads ----------

    def _connect(self) -> sqlite3.Connection:
        if not self.db_path.exists():
            raise RuntimeError(f"kanban database not found at {self.db_path}")
        conn = sqlite3.connect(f"file:{self.db_path}?mode=ro", uri=True, timeout=15)
        conn.row_factory = sqlite3.Row
        return conn

    @staticmethod
    def _task_id(task_id: str) -> str:
        if not _TASK_ID.match(task_id or ""):
            raise ValueError(f"malformed task id: {task_id}")
        return task_id

    def list(self, limit: int = 300, include_archived: bool = False) -> list[dict[str, Any]]:
        where = "" if include_archived else "WHERE status != 'archived'"
        with self._connect() as conn:
            rows = conn.execute(
                f"""SELECT id, title, body, assignee, status, priority, created_by,
                           created_at, started_at, completed_at, consecutive_failures,
                           last_failure_error, block_kind, workspace_kind, model_override
                    FROM tasks {where}
                    ORDER BY priority DESC, created_at DESC LIMIT ?""",
                (limit,),
            ).fetchall()
            runs = {}
            if rows:
                task_ids = [str(row["id"]) for row in rows]
                placeholders = ",".join("?" for _ in task_ids)
                runs = {
                    r["task_id"]: dict(r)
                    for r in conn.execute(
                        f"""SELECT r.task_id, r.outcome, r.summary, r.profile,
                                   r.started_at, r.ended_at
                            FROM task_runs AS r
                            JOIN (
                                SELECT task_id, MAX(id) AS id
                                FROM task_runs
                                WHERE task_id IN ({placeholders})
                                GROUP BY task_id
                            ) AS latest ON latest.id = r.id""",
                        task_ids,
                    ).fetchall()
                }
        out = []
        for row in rows:
            item = dict(row)
            item["last_run"] = runs.get(item["id"])
            out.append(item)
        return out

    def show(self, task_id: str) -> dict[str, Any]:
        tid = self._task_id(task_id)
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM tasks WHERE id=?", (tid,)).fetchone()
            if row is None:
                raise KeyError(task_id)
            comments = [dict(r) for r in conn.execute(
                "SELECT author, body, created_at FROM task_comments WHERE task_id=? ORDER BY created_at", (tid,)
            )]
            events = [dict(r) for r in conn.execute(
                "SELECT kind, payload, created_at FROM task_events WHERE task_id=? ORDER BY id DESC LIMIT 60", (tid,)
            )]
            runs = [dict(r) for r in conn.execute(
                """SELECT id, profile, status, outcome, summary, error, started_at, ended_at
                   FROM task_runs WHERE task_id=? ORDER BY id""", (tid,)
            )]
            children = [r[0] for r in conn.execute("SELECT child_id FROM task_links WHERE parent_id=?", (tid,))]
            parents = [r[0] for r in conn.execute("SELECT parent_id FROM task_links WHERE child_id=?", (tid,))]
        return {"task": dict(row), "comments": comments, "events": events,
                "runs": runs, "children": children, "parents": parents}

    def stats(self) -> dict[str, Any]:
        with self._connect() as conn:
            by_status = {r[0]: r[1] for r in conn.execute(
                "SELECT status, COUNT(*) FROM tasks WHERE status != 'archived' GROUP BY status")}
            by_assignee = {r[0] or "(unassigned)": r[1] for r in conn.execute(
                "SELECT assignee, COUNT(*) FROM tasks WHERE status != 'archived' GROUP BY assignee")}
            runs = conn.execute("SELECT COUNT(*) FROM task_runs").fetchone()[0]
        return {"by_status": by_status, "by_assignee": by_assignee, "total_runs": runs,
                "columns": COLUMNS}

    # ---------- writes ----------

    def _run(self, args: list[str]) -> dict[str, Any]:
        proc = subprocess.run(  # noqa: S603 -- argv is a fixed list, ids and profiles are validated
            [str(self.hermes), "kanban", *args],
            capture_output=True, text=True, timeout=90,
        )
        if proc.returncode != 0:
            raise RuntimeError((proc.stderr or proc.stdout or "kanban command failed").strip()[:600])
        return {"ok": True, "output": (proc.stdout or "").strip()[:4000]}

    def create(self, title: str, body: str = "", assignee: str | None = None,
               priority: int = 0, workspace: str = "scratch") -> dict[str, Any]:
        who = self.agents.resolve(assignee)
        args = ["create", title, "--assignee", who, "--workspace", workspace]
        if body:
            args += ["--body", body]
        if priority:
            args += ["--priority", str(int(priority))]
        return self._run(args)

    def assign(self, task_id: str, assignee: str) -> dict[str, Any]:
        return self._run(["assign", self._task_id(task_id), self.agents.resolve(assignee)])

    def comment(self, task_id: str, body: str) -> dict[str, Any]:
        return self._run(["comment", self._task_id(task_id), body])

    def action(self, task_id: str, verb: str) -> dict[str, Any]:
        if verb not in {"block", "unblock", "complete", "archive", "promote"}:
            raise ValueError(f"unsupported action: {verb}")
        return self._run([verb, self._task_id(task_id)])

    def log(self, task_id: str, tail: int = 20000) -> dict[str, Any]:
        out = self._run(["log", self._task_id(task_id), "--tail", str(int(tail))])
        return {"log": out["output"]}
