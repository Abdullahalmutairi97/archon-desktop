from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path
from typing import Any

from ..db import Database


def _connection(path: Path, *, readonly: bool = True) -> sqlite3.Connection:
    if not path.exists():
        raise FileNotFoundError(path)
    uri = f"file:{path}?mode=ro" if readonly else str(path)
    conn = sqlite3.connect(uri, uri=readonly, timeout=5)
    conn.row_factory = sqlite3.Row
    if readonly:
        conn.execute("PRAGMA query_only=ON")
    return conn


def _text(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    stripped = value.strip()
    if not stripped:
        return ""
    if stripped[:1] not in "[{":
        return stripped
    try:
        parsed = json.loads(stripped)
    except json.JSONDecodeError:
        return stripped
    if isinstance(parsed, dict):
        return str(parsed.get("text") or parsed.get("content") or stripped)
    if isinstance(parsed, list):
        parts = []
        for item in parsed:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict) and item.get("type") in {"text", "input_text", "output_text"}:
                parts.append(str(item.get("text") or item.get("content") or ""))
        return "\n".join(part for part in parts if part).strip()
    return stripped


def _is_internal_message(value: str) -> bool:
    text = value.lstrip()
    return text.startswith((
        "[PRIOR CONTEXT",
        "[CONTEXT COMPACTION",
        "[Your active task list was preserved",
        "[Your context window is",
        "[SYSTEM MESSAGE",
        "You've reached the maximum number of tool-calling iterations allowed.",
    ))


class ProjectService:
    def __init__(self, database_path: Path):
        self.database_path = Path(database_path)

    def list(self) -> list[dict[str, Any]]:
        if not self.database_path.exists():
            return []
        with _connection(self.database_path) as conn:
            rows = conn.execute(
                """SELECT id,slug,name,description,icon,color,primary_path
                   FROM projects WHERE COALESCE(archived,0)=0 ORDER BY name COLLATE NOCASE"""
            ).fetchall()
            folders = conn.execute(
                """SELECT project_id,path,label,is_primary FROM project_folders
                   ORDER BY project_id,is_primary DESC,path"""
            ).fetchall()
        grouped: dict[str, list[dict[str, Any]]] = {}
        for folder in folders:
            grouped.setdefault(folder["project_id"], []).append(
                {"path": folder["path"], "label": folder["label"], "is_primary": bool(folder["is_primary"])}
            )
        return [
            {
                "id": row["id"], "slug": row["slug"], "name": row["name"],
                "description": row["description"] or "", "icon": row["icon"] or "folder",
                "color": row["color"] or "", "primary_path": row["primary_path"] or "",
                "folders": grouped.get(row["id"], []),
            }
            for row in rows
        ]

    def project_for_path(self, cwd: str | None) -> str | None:
        if not cwd:
            return None
        normalized = os.path.abspath(cwd)
        winner: tuple[int, str] | None = None
        for project in self.list():
            for folder in project["folders"]:
                root = os.path.abspath(folder["path"])
                if normalized == root or normalized.startswith(root + os.sep):
                    candidate = (len(root), project["id"])
                    if winner is None or candidate[0] > winner[0]:
                        winner = candidate
        return winner[1] if winner else None


class SessionService:
    CHAT_SOURCES = ("archon-desktop", "cli", "tui", "telegram", "dashboard", "desktop")

    def __init__(self, database_path: Path, projects: ProjectService, locations: Database | None = None):
        self.database_path = Path(database_path)
        self.projects = projects
        self.locations = locations

    def list(self, limit: int = 120, project_id: str | None = None) -> list[dict[str, Any]]:
        if not self.database_path.exists():
            return []
        placeholders = ",".join("?" for _ in self.CHAT_SOURCES)
        with _connection(self.database_path) as conn:
            rows = conn.execute(
                f"""SELECT s.id,s.source,s.title,s.model,s.cwd,s.started_at,s.ended_at,s.message_count,
                    COALESCE((SELECT MAX(m.timestamp) FROM messages m WHERE m.session_id=s.id),s.ended_at,s.started_at) AS last_active,
                    (SELECT m.content FROM messages m WHERE m.session_id=s.id AND m.role='user'
                       AND COALESCE(m.active,1)=1 ORDER BY m.id DESC LIMIT 1) AS preview
                    FROM sessions s
                    WHERE COALESCE(s.archived,0)=0 AND s.source IN ({placeholders})
                    ORDER BY last_active DESC LIMIT ?""",
                (*self.CHAT_SOURCES, max(1, min(limit, 500))),
            ).fetchall()
        tracked = self.locations.session_locations([str(row["id"]) for row in rows]) if self.locations else {}
        result = []
        for row in rows:
            session_id = str(row["id"])
            reported_cwd = str(row["cwd"] or "").strip()
            remembered = tracked.get(session_id)
            if self.locations and reported_cwd and not remembered:
                # This discovers sessions that predate the task ledger. Once
                # captured, a future Hermes blank cwd cannot orphan the session.
                self.locations.remember_session_location(session_id, reported_cwd, "hermes")
                remembered = {"cwd": reported_cwd, "source": "hermes"}
            cwd = str(remembered["cwd"]) if remembered else reported_cwd
            resolved_project = self.projects.project_for_path(cwd)
            if project_id and resolved_project != project_id:
                continue
            preview = _text(row["preview"])
            if _is_internal_message(preview):
                preview = ""
            title = (row["title"] or "").strip()
            if _is_internal_message(title):
                title = ""
            title = title or (preview[:80] if preview else "Untitled session")
            result.append(
                {
                    "id": row["id"], "source": row["source"], "title": title,
                    "model": row["model"] or "", "cwd": cwd,
                    "project_id": resolved_project, "started_at": row["started_at"],
                    "last_active": row["last_active"], "message_count": row["message_count"] or 0,
                    "active": row["ended_at"] is None, "preview": preview[:180],
                    "location_source": remembered["source"] if remembered else "",
                }
            )
        return result

    def messages(self, session_id: str, limit: int = 500) -> list[dict[str, Any]]:
        if not session_id or len(session_id) > 200 or any(char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-." for char in session_id):
            raise ValueError("Invalid session id")
        with _connection(self.database_path) as conn:
            exists = conn.execute("SELECT 1 FROM sessions WHERE id=?", (session_id,)).fetchone()
            if not exists:
                raise KeyError(session_id)
            rows = conn.execute(
                """SELECT id,role,content,timestamp FROM messages
                   WHERE session_id=? AND role IN ('user','assistant')
                     AND COALESCE(active,1)=1 AND COALESCE(compacted,0)=0
                   ORDER BY id ASC LIMIT ?""",
                (session_id, max(1, min(limit, 2000))),
            ).fetchall()
        messages = []
        for row in rows:
            content = _text(row["content"])
            if not content or _is_internal_message(content):
                continue
            messages.append({"id": row["id"], "role": row["role"], "content": content, "timestamp": row["timestamp"]})
        return messages

    def delete(self, session_id: str) -> bool:
        return bool(self.delete_many([session_id]))

    def delete_many(self, session_ids: list[str]) -> list[str]:
        unique_ids = list(dict.fromkeys(session_ids))
        if not unique_ids:
            raise ValueError("At least one session id is required")
        for session_id in unique_ids:
            if not session_id or len(session_id) > 200 or any(char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-." for char in session_id):
                raise ValueError("Invalid session id")
        placeholders = ",".join("?" for _ in unique_ids)
        with _connection(self.database_path, readonly=False) as conn:
            conn.execute("BEGIN IMMEDIATE")
            found = {row["id"] for row in conn.execute(f"SELECT id FROM sessions WHERE id IN ({placeholders})", unique_ids)}
            if len(found) != len(unique_ids):
                conn.rollback()
                return []
            conn.execute(f"DELETE FROM messages WHERE session_id IN ({placeholders})", unique_ids)
            conn.execute(f"DELETE FROM sessions WHERE id IN ({placeholders})", unique_ids)
            conn.commit()
        return unique_ids
