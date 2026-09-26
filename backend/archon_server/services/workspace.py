from __future__ import annotations

import json
import os
import sqlite3
import re
from collections import Counter
import shutil
import subprocess
import uuid
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

    def _ensure(self) -> None:
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(self.database_path) as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS projects (
                    id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL UNIQUE,
                    description TEXT, icon TEXT, color TEXT, board_slug TEXT,
                    primary_path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
                    archived INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS project_folders (
                    project_id TEXT NOT NULL, path TEXT NOT NULL, label TEXT,
                    is_primary INTEGER NOT NULL DEFAULT 0, added_at TEXT NOT NULL,
                    UNIQUE(project_id,path)
                );
                """
            )

    def create(self, name: str, path: Path, description: str = "") -> dict[str, Any]:
        clean_name = name.strip()
        if not clean_name:
            raise ValueError("Project name is required")
        root = path.expanduser().resolve()
        created_folder = not root.exists()
        root.mkdir(parents=True, exist_ok=True)
        slug = re.sub(r"[^a-z0-9]+", "-", clean_name.lower()).strip("-") or "project"
        project_id = f"project-{uuid.uuid4().hex[:12]}"
        from datetime import datetime, timezone
        created = datetime.now(timezone.utc).isoformat()
        try:
            self._ensure()
            with sqlite3.connect(self.database_path) as conn:
                conn.execute(
                    "INSERT INTO projects(id,slug,name,description,icon,color,board_slug,primary_path,created_at,archived) VALUES (?,?,?,?,?,?,?,?,?,0)",
                    (project_id, slug, clean_name, description.strip(), "folder", "", None, str(root), created),
                )
                conn.execute(
                    "INSERT INTO project_folders(project_id,path,label,is_primary,added_at) VALUES (?,?,?,?,?)",
                    (project_id, str(root), "Main", 1, created),
                )
        except Exception as exc:
            if created_folder:
                try:
                    root.rmdir()  # only remove the request-created folder if still empty
                except OSError:
                    pass
            if isinstance(exc, sqlite3.IntegrityError):
                raise ValueError("A project with that name or folder already exists") from exc
            raise
        return next(project for project in self.list() if project["id"] == project_id)

    def contains(self, project_id: str) -> bool:
        if not self.database_path.exists():
            return False
        with _connection(self.database_path) as conn:
            return conn.execute(
                "SELECT 1 FROM projects WHERE id=? AND COALESCE(archived,0)=0 LIMIT 1", (project_id,)
            ).fetchone() is not None

    def delete(self, project_id: str) -> bool:
        if not self.contains(project_id):
            return False
        with _connection(self.database_path, readonly=False) as conn:
            conn.execute("DELETE FROM project_folders WHERE project_id=?", (project_id,))
            conn.execute("DELETE FROM projects WHERE id=?", (project_id,))
            conn.commit()
        return True

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

    def project_for_path(self, cwd: str | None, projects: list[dict[str, Any]] | None = None) -> str | None:
        if not cwd:
            return None
        normalized = os.path.realpath(os.path.abspath(cwd))
        best_depth = -1
        winners: set[str] = set()
        for project in self.list() if projects is None else projects:
            for folder in project["folders"]:
                root = os.path.realpath(os.path.abspath(folder["path"]))
                if normalized == root or normalized.startswith(root + os.sep):
                    depth = len(root)
                    if depth > best_depth:
                        best_depth = depth
                        winners = {project["id"]}
                    elif depth == best_depth:
                        winners.add(project["id"])
        if len(winners) > 1:
            raise ValueError("Project ownership is ambiguous: multiple projects share the longest workspace root")
        return next(iter(winners)) if winners else None


class PrimeSessionService:
    """Project Prime's native JSONL sessions into the desktop session API.

    The task ledger contains only sessions started by Archon.  Prime also keeps
    sessions created from its CLI/IDE in ``session_root``; those are discovered
    here without modifying the native files.
    """
    def __init__(
        self,
        locations: Database,
        session_root: Path,
        agent_session_root: Path | None = None,
        projects: ProjectService | None = None,
        agent_artifact_root: Path | None = None,
        prime_executable: Path | None = None,
        pi_session_root: Path | None = None,
    ):
        self.locations = locations
        self.session_root = Path(session_root).expanduser()
        self.agent_session_root = Path(agent_session_root or (Path.home() / ".prime/agent/sessions")).expanduser()
        self.projects = projects
        self.agent_artifact_root = Path(agent_artifact_root or (Path.home() / ".prime/agent/session-artifacts")).expanduser()
        self.prime_executable = Path(prime_executable).expanduser() if prime_executable else None
        self.pi_session_root = Path(pi_session_root).expanduser() if pi_session_root else None

    @staticmethod
    def _timestamp(value: str | int | float | None) -> int:
        if not value:
            return 0
        try:
            from datetime import datetime
            if isinstance(value, (int, float)):
                return int(value / 1000) if value > 10_000_000_000 else int(value)
            return int(datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp())
        except (TypeError, ValueError, OverflowError):
            return 0

    @staticmethod
    def _text(message: dict[str, Any]) -> str:
        value = message.get("content", "")
        if isinstance(value, str):
            return value
        if isinstance(value, list):
            return "\n".join(str(x.get("text", "")) for x in value if isinstance(x, dict) and x.get("type") == "text").strip()
        return ""

    @staticmethod
    def _content_title(values: list[str], limit: int = 72) -> str:
        """Create a stable, compact title from the first meaningful user turn."""
        greetings = {"hi", "hello", "hey", "test", "thanks", "thank you"}
        cleaned: list[str] = []
        for value in values:
            text = value.strip()
            if "User request:\n" in text:
                text = text.rsplit("User request:\n", 1)[-1].strip()
            text = re.sub(r"[`#*_>]", "", text)
            text = re.sub(r"\s+", " ", text).strip(" -:;,.!?")
            text = re.sub(
                r"^(?:please\s+)?(?:can|could|would|will)\s+you\s+",
                "", text, flags=re.IGNORECASE,
            )
            text = re.sub(
                r"^(?:please\s+)?(?:i\s+(?:want|need)\s+(?:you\s+)?to|help\s+me\s+(?:to\s+)?)\s+",
                "", text, flags=re.IGNORECASE,
            )
            if text:
                cleaned.append(text)
        source = next(
            (text for text in cleaned if text.casefold() not in greetings and len(re.findall(r"[\w'-]+", text)) >= 3),
            cleaned[0] if cleaned else "Prime session",
        )
        # Use the first sentence and stop on a word boundary. The result remains
        # stable as later turns arrive, unlike the old latest-prompt title.
        source = re.split(r"(?<=[.!?])\s+|\n", source, maxsplit=1)[0].strip(" -:;,.!?")
        if len(source) > limit:
            clipped = source[: limit + 1].rsplit(" ", 1)[0].rstrip(" -:;,.!?")
            source = f"{clipped}…" if clipped else f"{source[:limit].rstrip()}…"
        return source[:1].upper() + source[1:] if source else "Prime session"

    @staticmethod
    def _active_branch(path: Path) -> list[dict[str, Any]]:
        records: list[dict[str, Any]] = []
        try:
            for line in path.read_text(errors="replace").splitlines():
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    continue  # tolerate a partially-written tail record
                if isinstance(item, dict):
                    records.append(item)
        except OSError:
            return []
        indexed = {str(item["id"]): item for item in records if item.get("id")}
        # A trailing model_change/session metadata record is not a conversation
        # leaf. Prefer the latest message so metadata cannot hide the active branch.
        leaf = next((item for item in reversed(records)
                     if item.get("type") == "message" and item.get("id")), None)
        leaf = leaf or next((item for item in reversed(records) if item.get("id")), None)
        if not leaf:
            return []
        branch: list[dict[str, Any]] = []
        seen: set[str] = set()
        current: dict[str, Any] | None = leaf
        while current is not None:
            record_id = str(current.get("id") or "")
            if record_id and record_id in seen:
                break
            if record_id:
                seen.add(record_id)
            branch.append(current)
            parent_id = str(current.get("parentId") or "")
            current = indexed.get(parent_id) if parent_id else None
        branch.reverse()
        # The session header is metadata, not necessarily a parent of the
        # active message leaf. Preserve it so cwd/model/project inference still
        # works when native files contain branched or compacted transcripts.
        # Retain metadata records outside the parent-linked message branch,
        # but rebuild in one linear pass rather than using repeated index()
        # lookups on large transcripts.
        selected = {id(item) for item in branch}
        return [item for item in records if id(item) in selected or item.get("type") in {"session", "model_change"}]

    @staticmethod
    def _session_headers(path: Path) -> tuple[list[dict[str, Any]], str | None]:
        """Read every header and retain file-level parse/read failures."""
        headers: list[dict[str, Any]] = []
        malformed_json = False
        try:
            with path.open(errors="replace") as stream:
                for line in stream:
                    if not line.strip():
                        continue
                    try:
                        item = json.loads(line)
                    except json.JSONDecodeError:
                        malformed_json = True
                        continue
                    if isinstance(item, dict) and item.get("type") == "session":
                        headers.append(item)
        except OSError:
            return [], "unreadable_file"
        return headers, "malformed_json" if malformed_json else None

    def owner_evidence(self) -> dict[str, list[dict[str, Any]]]:
        """Collect all native header evidence keyed by its candidate session id.

        Prime agent headers use their actual header ID as the session ID; Pi
        native history is namespaced and read-only. Archon-created per-session
        directories can contain several native run headers, so those are kept
        as separate evidence records without treating a run ID as the logical
        session ID.
        """
        evidence: dict[str, list[dict[str, Any]]] = {}

        def add(session_id: str, row: dict[str, Any]) -> None:
            evidence.setdefault(session_id, []).append(row)

        # A Desktop session is a logical directory which may contain multiple
        # native Prime/Pi runs. The durable task ledger supplies its runtime.
        if self.session_root.is_dir():
            for directory in sorted(self.session_root.glob("prime-*"), key=lambda path: path.name):
                if not directory.is_dir() or not self._safe_id(directory.name):
                    continue
                for path in sorted(directory.glob("*.jsonl"), key=lambda item: item.name):
                    headers, file_error = self._session_headers(path)
                    if not headers or file_error:
                        add(directory.name, {
                            "session_id": directory.name,
                            "header_id": None,
                            "runtime_id": None,
                            "cwd": None,
                            "source": "desktop",
                            "identity_matches": False,
                            "evidence_error": file_error or "missing_header",
                        })
                    for header in headers:
                        raw_header_id = header.get("id")
                        header_id = raw_header_id if isinstance(raw_header_id, str) else ""
                        add(directory.name, {
                            "session_id": directory.name,
                            "header_id": header_id,
                            "runtime_id": None,
                            "cwd": str(header.get("cwd") or "") or None,
                            "source": "desktop",
                            "identity_matches": bool(self._safe_id(header_id)),
                            "evidence_error": file_error or (
                                "invalid_header_id" if not self._safe_id(header_id) else None
                            ),
                        })

        # Keep every matching source/header pair. _agent_files intentionally
        # projects a single path for display, which is insufficient for an
        # ownership decision when native evidence is duplicated or conflicting.
        candidates: set[Path] = set()

        def add_files(root: Path, *, recursive: bool) -> None:
            try:
                resolved_root = root.resolve(strict=True)
            except OSError:
                return
            paths = root.rglob("*.jsonl") if recursive else root.glob("*.jsonl")
            for path in paths:
                try:
                    if path.is_file() and path.resolve(strict=True).is_relative_to(resolved_root):
                        candidates.add(path)
                except OSError:
                    continue

        add_files(self.agent_session_root, recursive=False)
        add_files(self.agent_artifact_root, recursive=True)
        if self.pi_session_root:
            add_files(self.pi_session_root, recursive=True)

        pi_root = None
        if self.pi_session_root and self.pi_session_root.is_dir():
            try:
                pi_root = self.pi_session_root.resolve(strict=True)
            except OSError:
                pi_root = None

        for path in sorted(candidates, key=lambda item: str(item)):
            try:
                resolved = path.resolve(strict=True)
            except OSError:
                continue
            runtime_id = "pi" if pi_root is not None and resolved.is_relative_to(pi_root) else "prime"
            headers, file_error = self._session_headers(path)
            stem = path.stem
            candidate_id = f"pi-native-{stem}" if runtime_id == "pi" else stem
            if not headers and self._safe_id(stem):
                # A native session file without its required header is not
                # identity evidence. Keep that absence attached to a safe
                # filename candidate so existing ownership cannot silently
                # survive a corrupt or partially written native record.
                add(candidate_id, {
                    "session_id": candidate_id,
                    "header_id": None,
                    "runtime_id": runtime_id,
                    "cwd": None,
                    "source": "native",
                    "identity_matches": False,
                    "evidence_error": file_error or "missing_header",
                })
            for header in headers:
                raw_header_id = header.get("id")
                header_id = str(raw_header_id) if isinstance(raw_header_id, str) else ""
                if not self._safe_id(header_id):
                    # Do not accept a malformed header ID, but do not drop its
                    # runtime/cwd evidence either. Associate it with the safe
                    # filename candidate as an explicit identity mismatch.
                    if self._safe_id(stem):
                        add(candidate_id, {
                            "session_id": candidate_id,
                            "header_id": header_id or None,
                            "runtime_id": runtime_id,
                            "cwd": str(header.get("cwd") or "") or None,
                            "source": "native",
                            "identity_matches": False,
                            "evidence_error": file_error or "invalid_header_id",
                        })
                    continue
                session_id = f"pi-native-{header_id}" if runtime_id == "pi" else header_id
                add(session_id, {
                    "session_id": session_id,
                    "header_id": header_id,
                    "runtime_id": runtime_id,
                    "cwd": str(header.get("cwd") or "") or None,
                    "source": "native",
                    "identity_matches": True,
                    "evidence_error": file_error,
                })

                # A filename/header mismatch is evidence of a possible legacy
                # alias, never a second authoritative ID. Surface it as an
                # explicit mismatch if a caller asks for the filename ID.
                if self._safe_id(stem) and stem != header_id:
                    add(candidate_id, {
                        "session_id": candidate_id,
                        "header_id": header_id,
                        "runtime_id": runtime_id,
                        "cwd": str(header.get("cwd") or "") or None,
                        "source": "native",
                        "identity_matches": False,
                        "evidence_error": "filename_header_mismatch",
                    })

        return evidence

    def ownership_evidence(self, session_id: str) -> list[dict[str, Any]]:
        if not self._safe_id(session_id):
            return []
        return self.owner_evidence().get(session_id, [])

    def _agent_files(self) -> dict[str, Path]:
        """All native CLI/TUI session files, including RLM child sessions.

        Prime Agent places top-level sessions in ``sessions`` and child sessions
        in ``session-artifacts/<parent>/<child>/``.  The latter are genuine native
        sessions reported by ``prime-agent list --json`` and must not disappear
        from Desktop just because they are nested.
        """
        paths = list(self.agent_session_root.glob("*.jsonl"))
        pi_paths: set[Path] = set()
        if self.pi_session_root and self.pi_session_root.is_dir():
            root = self.pi_session_root.resolve()
            for path in self.pi_session_root.rglob("*.jsonl"):
                if path.is_file() and path.resolve().is_relative_to(root):
                    pi_paths.add(path)
            paths.extend(sorted(pi_paths))
        if self.agent_artifact_root.is_dir():
            paths.extend(self.agent_artifact_root.rglob("*.jsonl"))
        found: dict[str, Path] = {}
        for path in paths:
            try:
                for line in path.open(errors="replace"):
                    try:
                        item = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(item, dict):
                        continue
                    if item.get("type") == "session" and item.get("id"):
                        native_id = str(item["id"])
                        if self._safe_id(native_id):
                            key = f"pi-native-{native_id}" if path in pi_paths else native_id
                            found[key] = path
                        # The header id is canonical. Do not also expose the
                        # filename stem: a renamed file would otherwise appear
                        # as a second copy of the same logical session.
                        break
            except OSError:
                continue
        return found

    def _agent_path(self, session_id: str, agent_files: dict[str, Path] | None = None) -> Path | None:
        paths = self._agent_files() if agent_files is None else agent_files
        path = paths.get(session_id)
        if path is not None:
            return path
        # Keep direct access to legacy filename-based IDs without publishing
        # that alias from _ids()/list() as a duplicate logical session.
        legacy = self.agent_session_root / f"{session_id}.jsonl"
        return legacy if legacy.is_file() else None

    def _native(self, session_id: str, agent_files: dict[str, Path] | None = None) -> list[dict[str, Any]]:
        root = self.session_root / session_id
        if session_id.startswith("prime-") and root.is_dir():
            # A Desktop logical session can have multiple native Prime runs.  A
            # follow-up may create a new JSONL while the prior file receives a
            # late write, so choosing by mtime loses/reorders turns.  Project the
            # active branch from *every* file and merge them by native timestamp.
            paths = sorted(root.glob("*.jsonl"), key=lambda path: path.name)
        elif session_id and all(char in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-" for char in session_id):
            path = self._agent_path(session_id, agent_files)
            paths = [path] if path is not None else []
        else:
            paths = []
        merged: list[tuple[int, int, dict[str, Any]]] = []
        sequence = 0
        for path in paths:
            for item in self._active_branch(path):
                if item.get("type") not in {"session", "model_change"} and not (
                    item.get("type") == "message" and isinstance(item.get("message"), dict)
                ):
                    continue
                # Files may contain equal/missing timestamps; sequence retains
                # stable file-local order for those records.
                merged.append((self._timestamp(item.get("timestamp") or item.get("message", {}).get("timestamp")), sequence, item))
                sequence += 1
        merged.sort(key=lambda row: (row[0], row[1]))
        return [item for _, _, item in merged]

    def cwd_for(self, session_id: str) -> str | None:
        native = self._native(session_id)
        header = next((item for item in native if item.get("type") == "session" and item.get("cwd")), None)
        if header:
            return str(header["cwd"])
        with self.locations.connect() as conn:
            row = conn.execute(
                "SELECT cwd FROM tasks WHERE session_id=? AND NULLIF(TRIM(cwd),'') IS NOT NULL ORDER BY updated_at DESC LIMIT 1",
                (session_id,),
            ).fetchone()
        return str(row["cwd"]) if row else None

    def _ids(
        self,
        agent_files: dict[str, Path] | None = None,
        evidence: dict[str, list[dict[str, Any]]] | None = None,
    ) -> set[str]:
        native = {
            path.name for path in self.session_root.glob("prime-*")
            if path.is_dir() and self._safe_id(path.name)
        }
        current_agent_files = self._agent_files() if agent_files is None else agent_files
        native.update(current_agent_files)
        # Keep safe canonical evidence candidates visible when a native file
        # becomes unreadable or malformed. Filename-only candidates that are
        # known to disagree with a header stay suppressed, so renamed files do
        # not appear as duplicate logical sessions.
        candidates = self.owner_evidence() if evidence is None else evidence
        filename_aliases = {
            session_id for session_id, records in candidates.items()
            if records and all(
                record.get("evidence_error") == "filename_header_mismatch"
                for record in records
            )
        }
        live_evidence_ids = {
            session_id for session_id, records in candidates.items()
            if self._safe_id(session_id) and any(
                record.get("evidence_error") != "filename_header_mismatch"
                for record in records
            )
        }
        native.update(live_evidence_ids)
        live_native_ids = set(current_agent_files)
        live_native_ids.update(live_evidence_ids)
        with self.locations.connect() as conn:
            for query in (
                "SELECT DISTINCT session_id FROM tasks WHERE session_id IS NOT NULL",
                "SELECT session_id FROM session_projects",
                "SELECT session_id FROM session_ownership",
            ):
                native.update(
                    row["session_id"] for row in conn.execute(query)
                    if self._safe_id(row["session_id"])
                )
            deleted = {row["session_id"] for row in conn.execute("SELECT session_id FROM deleted_sessions")}
        visible = native - deleted - filename_aliases
        # Pi native history is a live, read-only projection. Its cached owner
        # row must not resurrect a file that has been removed or archived.
        return {
            session_id for session_id in visible
            if not session_id.startswith("pi-native-") or session_id in live_native_ids
        }

    def _project_assignments(self) -> dict[str, str | None]:
        with self.locations.connect() as conn:
            return {row["session_id"]: row["project_id"] for row in conn.execute(
                "SELECT session_id,project_id FROM session_projects"
            )}

    def assign_project_pending(self, session_id: str, project_id: str) -> bool:
        """Reserve a project for a new Prime session before its JSONL exists."""
        if not self.projects or not self.projects.contains(project_id):
            raise KeyError(project_id)
        from datetime import datetime, timezone
        with self.locations.transaction() as conn:
            conn.execute(
                "INSERT INTO session_projects(session_id,project_id,updated_at) VALUES (?,?,?) "
                "ON CONFLICT(session_id) DO UPDATE SET project_id=excluded.project_id,updated_at=excluded.updated_at",
                (session_id, project_id, datetime.now(timezone.utc).isoformat()),
            )
        return True

    def assign_project(self, session_id: str, project_id: str | None) -> bool:
        if not self.contains(session_id):
            return False
        if project_id is not None and (not self.projects or not self.projects.contains(project_id)):
            raise KeyError(project_id)
        from datetime import datetime, timezone
        with self.locations.transaction() as conn:
            # Hold the same write lock as task submission while checking and
            # updating identity, so a newly queued turn cannot race this check.
            if conn.execute(
                "SELECT 1 FROM tasks WHERE session_id=? "
                "AND status IN ('queued','running','cancelling') LIMIT 1", (session_id,),
            ).fetchone():
                raise ValueError("Session has active tasks; wait for them to finish before changing its project")
            conn.execute(
                "INSERT INTO session_projects(session_id,project_id,updated_at) VALUES (?,?,?) "
                "ON CONFLICT(session_id) DO UPDATE SET project_id=excluded.project_id,updated_at=excluded.updated_at",
                (session_id, project_id, datetime.now(timezone.utc).isoformat()),
            )
        return True

    def clear_project(self, project_id: str) -> list[str]:
        with self.locations.transaction() as conn:
            session_ids = [row["session_id"] for row in conn.execute(
                "SELECT session_id FROM session_projects WHERE project_id=?", (project_id,)
            )]
            conn.execute("DELETE FROM session_projects WHERE project_id=?", (project_id,))
        return session_ids

    def restore_project(self, project_id: str, session_ids: list[str]) -> None:
        if not session_ids:
            return
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc).isoformat()
        with self.locations.transaction() as conn:
            conn.executemany(
                "INSERT INTO session_projects(session_id,project_id,updated_at) VALUES (?,?,?) "
                "ON CONFLICT(session_id) DO UPDATE SET project_id=excluded.project_id,updated_at=excluded.updated_at",
                [(session_id, project_id, now) for session_id in session_ids],
            )

    def list(self, limit: int = 120, project_id: str | None = None) -> list[dict[str, Any]]:
        result = []
        assignments = self._project_assignments()
        project_catalog = self.projects.list() if self.projects else []
        known_project_ids = {project["id"] for project in project_catalog}
        agent_files = self._agent_files()
        evidence = self.owner_evidence()
        session_ids = self._ids(agent_files, evidence)
        # Aggregate ledger metadata once.  Avoid per-session connections and
        # avoid SQLite's variable limit when many native sessions are present.
        metadata: dict[str, sqlite3.Row] = {}
        ledger_by_session: dict[str, list[sqlite3.Row]] = {}
        if session_ids:
            with self.locations.connect() as conn:
                metadata = {
                    row["session_id"]: row
                    for row in conn.execute(
                        "SELECT session_id, MIN(created_at) started, MAX(updated_at) active, "
                        "(SELECT cwd FROM tasks latest WHERE latest.session_id=tasks.session_id "
                        " AND NULLIF(TRIM(latest.cwd),'') IS NOT NULL "
                        " ORDER BY latest.updated_at DESC, latest.id DESC LIMIT 1) cwd, "
                        "(SELECT model FROM tasks latest WHERE latest.session_id=tasks.session_id "
                        " AND NULLIF(TRIM(latest.model),'') IS NOT NULL "
                        " ORDER BY latest.updated_at DESC, latest.id DESC LIMIT 1) model, "
                        "MAX(CASE WHEN status IN ('queued','running','cancelling') THEN 1 ELSE 0 END) running "
                        "FROM tasks GROUP BY session_id"
                    )
                    if row["session_id"] in session_ids
                }
                # Restrict payload loading to the discovered sessions.  A
                # global task query would read every historical result_json on
                # every refresh, which gets expensive as the ledger grows.
                session_list = list(session_ids)
                for offset in range(0, len(session_list), 400):
                    chunk = session_list[offset:offset + 400]
                    placeholders = ",".join("?" for _ in chunk)
                    for row in conn.execute(
                        "SELECT id,session_id,prompt,status,result_json,error,created_at,completed_at,updated_at "
                        f"FROM tasks WHERE session_id IN ({placeholders}) ORDER BY created_at,id",
                        chunk,
                    ):
                        ledger_by_session.setdefault(row["session_id"], []).append(row)
        active_sessions = {
            session_id for session_id, row in metadata.items() if row["running"]
        }
        for session_id in session_ids:
            native = self._native(session_id, agent_files)
            header = next((x for x in native if x.get("type") == "session"), {})
            # Count the exact projection returned by the messages endpoint,
            # including ledger-recovered prompts/results missing from JSONL.
            projected_messages = self.messages(
                session_id, limit=None, native=native,
                task_rows=ledger_by_session.get(session_id, []),
            )
            visible_messages = [
                message for message in projected_messages
                if message.get("role") == "user" or (
                    message.get("role") == "assistant" and message.get("kind") == "text"
                )
            ]
            user_messages = [m for m in visible_messages if m.get("role") == "user"]
            user_texts = [self._text(message) for message in user_messages]
            model = next((x.get("modelId") for x in reversed(native) if x.get("type") == "model_change"), "prime-agent")
            cwd = str(header.get("cwd") or "")
            # Ledger metadata is useful for sessions created by Archon.
            row = metadata.get(session_id)
            started = self._timestamp(row["started"]) if row else 0
            active = self._timestamp(row["active"]) if row else 0
            cwd = cwd or str((row["cwd"] if row else "") or "")
            # Explicit bindings, including NULL and a removed project, suppress
            # cwd inference. A replacement project must not adopt old sessions.
            project_ambiguous = False
            if session_id in assignments:
                assigned_project = assignments[session_id]
                matched_project = (
                    assigned_project
                    if assigned_project is None or assigned_project in known_project_ids
                    else None
                )
            else:
                try:
                    matched_project = self.projects.project_for_path(cwd, project_catalog) if self.projects else None
                except ValueError:
                    # Keep unrelated and ambiguous sessions in the projection.
                    # Admission still rejects the ambiguity instead of choosing
                    # one of the competing projects.
                    matched_project = None
                    project_ambiguous = True
            if project_id and matched_project != project_id:
                continue
            title = self._content_title(user_texts)
            preview = next((text.strip() for text in reversed(user_texts) if text.strip()), title)
            origin = "pi-cli" if session_id.startswith("pi-native-") else ("prime" if (self.session_root / session_id).is_dir() else "prime-cli")
            session_row = {"id": session_id, "source": origin, "title": title, "model": str((row["model"] if row else None) or model), "cwd": cwd, "project_id": matched_project, "started_at": started or self._timestamp(header.get("timestamp")), "last_active": active or max((self._timestamp(x.get("timestamp")) for x in native), default=0), "message_count": len(visible_messages), "active": session_id in active_sessions, "preview": preview[:180]}
            if project_ambiguous:
                session_row["project_ownership_ambiguous"] = True
            result.append(session_row)
        result.sort(key=lambda x: x["last_active"], reverse=True)
        return result[:max(1, min(limit, 500))]

    def messages(
        self,
        session_id: str,
        limit: int | None = 500,
        native: list[dict[str, Any]] | None = None,
        task_rows: list[sqlite3.Row] | None = None,
    ) -> list[dict[str, Any]]:
        explicitly_projected = native is not None or task_rows is not None
        native = self._native(session_id) if native is None else native
        result = []
        for item in native:
            if item.get("type") != "message" or not isinstance(item.get("message"), dict):
                continue
            message = item["message"]
            role = str(message.get("role") or "assistant")
            timestamp = self._timestamp(item.get("timestamp") or message.get("timestamp"))
            base_id = str(item.get("id") or message.get("id") or len(result))
            blocks = message.get("content", [])
            if isinstance(blocks, str):
                blocks = [{"type": "text", "text": blocks}]
            projected: list[tuple[str, str]] = []
            # Prime can put reasoning, a tool call, and final answer in the same
            # assistant message. Project each block separately so the renderer
            # can collapse reasoning without accidentally hiding the answer.
            for block in blocks if isinstance(blocks, list) else []:
                if not isinstance(block, dict):
                    continue
                block_type = str(block.get("type") or "")
                if block_type == "text" and block.get("text"):
                    projected.append(("tool_result" if role == "toolResult" else "text", str(block["text"])))
                elif block_type == "thinking" and block.get("thinking"):
                    projected.append(("thinking", str(block["thinking"])))
                elif block_type == "toolCall":
                    arguments = block.get("arguments")
                    detail = json.dumps(arguments, ensure_ascii=False, indent=2) if isinstance(arguments, (dict, list)) else str(arguments or "")
                    projected.append(("tool", f"{str(block.get('name') or 'tool')}\n{detail}".rstrip()))
            if not projected:
                projected = [("native", "Native message record (no displayable payload)")]
            many = len(projected) > 1
            for index, (kind, content) in enumerate(projected):
                result.append({
                    "id": f"{base_id}:{index}" if many else base_id,
                    "role": role,
                    "content": content.strip(),
                    "kind": kind,
                    "timestamp": timestamp,
                })

        # The native file is occasionally finalized without an assistant text
        # row even though Prime returned and streamed a valid result.  The task
        # ledger is the durable second source of truth for Desktop-originated
        # turns. Merge missing prompts/results by timestamp so a completion
        # refresh can never erase an answer the user just watched arrive.
        if task_rows is None:
            with self.locations.connect() as conn:
                task_rows = conn.execute(
                    "SELECT id,prompt,status,result_json,error,created_at,completed_at,updated_at "
                    "FROM tasks WHERE session_id=? ORDER BY created_at,id",
                    (session_id,),
                ).fetchall()
        if not native and not task_rows and not explicitly_projected:
            raise KeyError(session_id)
        # Consume matching native records one-for-one. Repeated prompts or
        # replies are valid turns and must not be collapsed across ledger tasks.
        native_counts = Counter((str(message["role"]), str(message["content"]).strip()) for message in result)
        ledger: list[dict[str, Any]] = []
        for task in task_rows:
            # ChatPage renders these transient task exchanges itself. Keeping
            # them in the message response duplicates prompts/errors while a
            # task is queued, running, cancelling, or awaiting retry.
            if str(task["status"] or "") in {"queued", "running", "cancelling", "failed"}:
                continue
            prompt = str(task["prompt"] or "").strip()
            if prompt:
                key = ("user", prompt)
                if native_counts[key]:
                    native_counts[key] -= 1
                else:
                    ledger.append({
                        "id": f"task-{task['id']}-prompt", "role": "user", "content": prompt,
                        "kind": "text", "timestamp": self._timestamp(task["created_at"]),
                    })
            reply = ""
            if task["result_json"]:
                try:
                    payload = json.loads(task["result_json"])
                    reply = str(payload.get("text") or "").strip() if isinstance(payload, dict) else ""
                except (json.JSONDecodeError, TypeError):
                    reply = ""
            if not reply and str(task["status"] or "") == "failed" and task["error"]:
                reply = f"Task failed: {str(task['error']).strip()}"
            if reply:
                key = ("assistant", reply)
                if native_counts[key]:
                    native_counts[key] -= 1
                else:
                    ledger.append({
                        "id": f"task-{task['id']}-result", "role": "assistant", "content": reply,
                        "kind": "text", "timestamp": self._timestamp(task["completed_at"] or task["updated_at"]),
                    })
        combined = [*result, *ledger]
        # Python's sort is stable, preserving native file order when Prime emits
        # multiple records with the same second-level timestamp.
        combined.sort(key=lambda message: int(message.get("timestamp") or 0))
        if limit is None:
            return combined
        return combined[-max(1, min(limit, 2000)):]

    @staticmethod
    def _safe_id(session_id: str) -> bool:
        return bool(session_id) and all(
            char in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-" for char in session_id
        )

    def contains(self, session_id: str) -> bool:
        if not self._safe_id(session_id):
            return False
        root = self.session_root / session_id
        agent_file = self._agent_path(session_id)
        return (session_id.startswith("prime-") and root.is_dir()) or agent_file is not None

    def _stop_native_agent(self, session_id: str) -> None:
        if not self.prime_executable or not self.prime_executable.is_file():
            return
        try:
            listed = subprocess.run(
                [str(self.prime_executable), "list", "--json"],
                capture_output=True, text=True, timeout=15, check=True,
            )
            sessions = json.loads(listed.stdout).get("sessions", [])
        except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
            raise RuntimeError("Could not inspect attached Prime agents before deletion") from exc
        for agent in sessions:
            if not isinstance(agent, dict):
                continue
            if str(agent.get("sessionId") or "") != session_id:
                continue
            stopped = subprocess.run(
                [str(self.prime_executable), "stop", str(agent.get("id")), "--json"],
                capture_output=True, text=True, timeout=15,
            )
            if stopped.returncode:
                raise RuntimeError(f"Could not stop attached Prime agent {agent.get('id')}")

    def delete(self, session_id: str) -> bool:
        if not self._safe_id(session_id):
            return False
        if session_id.startswith("pi-native-"):
            native = self._agent_path(session_id)
            if native is None or not native.is_file():
                return False
            # Withdraw native CLI history without invoking Prime's process manager.
            # Keep a recovery copy outside Pi's discovery tree. No CLI process is
            # stopped here: the UI tells the operator to close a live Pi session first.
            recovery = self.session_root.parent / "deleted-native-pi"
            recovery.mkdir(parents=True, exist_ok=True, mode=0o700)
            target = recovery / f"{session_id}-{uuid.uuid4().hex}.jsonl"
            shutil.move(str(native), str(target))
            target.chmod(0o600)
            return True
        removed = False
        root = self.session_root / session_id
        agent_file = self._agent_path(session_id)
        if agent_file is not None and agent_file.is_file():
            self._stop_native_agent(session_id)
        if session_id.startswith("prime-") and root.is_dir():
            shutil.rmtree(root)
            removed = True
        if agent_file is not None and agent_file.is_file():
            agent_file.unlink()
            removed = True
        artifact_root = self.agent_artifact_root / session_id
        if artifact_root.is_dir():
            shutil.rmtree(artifact_root)
            removed = True
        return removed


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
            visible_counts: dict[str, int] = {str(row["id"]): 0 for row in rows}
            if rows:
                session_placeholders = ",".join("?" for _ in rows)
                message_rows = conn.execute(
                    f"""SELECT session_id,content FROM messages
                        WHERE session_id IN ({session_placeholders})
                          AND role IN ('user','assistant')
                          AND COALESCE(active,1)=1 AND COALESCE(compacted,0)=0""",
                    [str(row["id"]) for row in rows],
                )
                for message in message_rows:
                    content = _text(message["content"])
                    if content and not _is_internal_message(content):
                        key = str(message["session_id"])
                        visible_counts[key] = visible_counts.get(key, 0) + 1
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
                    "last_active": row["last_active"], "message_count": visible_counts.get(session_id, 0),
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

    def contains(self, session_id: str) -> bool:
        if not self.database_path.exists():
            return False
        if not session_id or len(session_id) > 200 or any(char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-." for char in session_id):
            return False
        with _connection(self.database_path) as conn:
            return conn.execute("SELECT 1 FROM sessions WHERE id=? LIMIT 1", (session_id,)).fetchone() is not None

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
