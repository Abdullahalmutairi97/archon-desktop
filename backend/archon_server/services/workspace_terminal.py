"""Private, workspace-scoped detached tmux sessions.

This service only accepts a persisted workspace ID. It resolves the owner,
canonical root, and generation from the server database, and never accepts a
shell command or working directory from a caller. A tmux client detaching does
not imply that the host or tmux server survives a reboot or process failure.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import shutil
import socket
import stat
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..child_env import build_child_env
from ..db import Database


_WORKSPACE_ID = re.compile(r"workspace-[0-9a-f]{32}\Z")
_SESSION_ID = re.compile(r"wterm-[0-9a-f]{32}\Z")
_TMUX_NAME = re.compile(r"archon-ws-[0-9a-f]{32}\Z")
_PANE_ID = re.compile(r"%[0-9]+\Z")
_MAX_METADATA_BYTES = 16 * 1024
_DEFAULT_MAX_SESSIONS = 16
_MAX_SCREEN_BYTES = 24 * 1024
_MAX_INPUT_BYTES = 4096


class WorkspaceTerminalError(RuntimeError):
    """Base error for workspace terminal operations."""


class WorkspaceTerminalUnavailable(WorkspaceTerminalError):
    """tmux is missing, unhealthy, or returned an unrecognized failure."""


class WorkspaceTerminalCapacity(WorkspaceTerminalError):
    """The bounded session ledger has reached its configured limit."""


class WorkspaceTerminalInputOutcomeUnknown(WorkspaceTerminalUnavailable):
    """tmux may have accepted some or all of one input line."""


def _private_directory(path: str | os.PathLike[str], *, label: str) -> Path:
    candidate = Path(path)
    if not candidate.is_absolute():
        raise ValueError(f"{label} must be an absolute server-owned path")
    was_present = candidate.exists() or candidate.is_symlink()
    try:
        candidate.mkdir(parents=True, mode=0o700, exist_ok=True)
    except OSError as exc:
        raise WorkspaceTerminalUnavailable(f"Could not prepare private {label}") from exc
    try:
        info = candidate.lstat()
    except OSError as exc:
        raise WorkspaceTerminalUnavailable(f"Could not inspect private {label}") from exc
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid()
            or (was_present and stat.S_IMODE(info.st_mode) != 0o700)
            or (stat.S_IMODE(info.st_mode) & 0o077)):
        raise WorkspaceTerminalUnavailable(f"{label} must be a private directory owned by this user")
    if not was_present and stat.S_IMODE(info.st_mode) != 0o700:
        try:
            os.chmod(candidate, 0o700, follow_symlinks=False)
        except OSError as exc:
            raise WorkspaceTerminalUnavailable(f"Could not secure private {label}") from exc
        info = candidate.lstat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid()
                or stat.S_IMODE(info.st_mode) != 0o700):
            raise WorkspaceTerminalUnavailable(f"Could not secure private {label}")
    # Keep the resolved path stable and reject a symlink at the configured leaf.
    if candidate.resolve(strict=True) != candidate.absolute():
        raise WorkspaceTerminalUnavailable(f"{label} must not be a symlink")
    return candidate.absolute()


class WorkspaceTerminalService:
    """Manage a bounded line console for persisted workspaces.

    This is a trusted same-user shell interface, not process or filesystem
    isolation and not a full interactive terminal. It accepts one line of
    shell input and returns a bounded plain-text screen capture. Callers should
    keep one service instance behind the backend's exclusive runner ownership
    lock.
    """

    def __init__(
        self,
        database: Database,
        *,
        owner_id: str,
        metadata_root: str | os.PathLike[str],
        socket_root: str | os.PathLike[str],
        tmux_executable: str | os.PathLike[str] = "tmux",
        max_sessions: int = _DEFAULT_MAX_SESSIONS,
        timeout_seconds: float = 10.0,
    ):
        if not isinstance(owner_id, str) or not owner_id.strip() or len(owner_id) > 200:
            raise ValueError("owner_id is invalid")
        if isinstance(max_sessions, bool) or not isinstance(max_sessions, int) or not 1 <= max_sessions <= 64:
            raise ValueError("max_sessions must be between 1 and 64")
        if (isinstance(timeout_seconds, bool) or not isinstance(timeout_seconds, (int, float))
                or timeout_seconds <= 0 or timeout_seconds > 60):
            raise ValueError("timeout_seconds must be positive and at most 60")
        self.database = database
        self.owner_id = owner_id
        self.metadata_root = _private_directory(metadata_root, label="workspace terminal metadata root")
        self.socket_root = _private_directory(socket_root, label="workspace terminal socket root")
        if len(os.fsencode(self.socket_root)) + 28 >= 108:
            raise ValueError("socket_root is too long for private tmux socket paths")
        self.max_sessions = max_sessions
        self.timeout_seconds = float(timeout_seconds)
        requested = os.fspath(tmux_executable)
        if os.path.isabs(requested) or os.sep in requested:
            try:
                resolved = Path(requested).resolve(strict=True)
            except OSError:
                resolved = None
        else:
            located = shutil.which(requested)
            resolved = Path(located).resolve(strict=True) if located else None
        self.tmux_executable = str(resolved) if resolved is not None else None
        self._lock = asyncio.Lock()

    async def create(self, workspace_id: str, *, expected_generation: int) -> dict[str, str]:
        """Create a detached default-shell session at the DB-resolved workspace root."""
        if (isinstance(expected_generation, bool) or not isinstance(expected_generation, int)
                or expected_generation < 1):
            raise ValueError("expected_generation must be a positive integer")
        async with self._lock:
            workspace = self._resolve_workspace(workspace_id)
            if workspace["generation"] != expected_generation:
                raise ValueError("Workspace generation changed; refresh before creating a terminal")
            self._assert_tmux_available()
            record = self._load_record(workspace)
            await self._reconcile(workspace, record)
            if len(record["sessions"]) >= self.max_sessions:
                raise WorkspaceTerminalCapacity("Workspace terminal session limit reached")

            session_id = "wterm-" + uuid.uuid4().hex
            name = "archon-ws-" + uuid.uuid4().hex
            created_at = datetime.now(timezone.utc).isoformat()
            reservation = {
                "sessionId": session_id,
                "name": name,
                "state": "starting",
                "createdAt": created_at,
            }
            record["sessions"].append(reservation)
            self._save_record(workspace, record)

            socket_path = self._socket_path(workspace)
            try:
                result = await self._run_tmux(
                    socket_path,
                    "new-session", "-d", "-s", name, "-c", workspace["root"],
                )
            except WorkspaceTerminalUnavailable:
                # Keep the durable reservation: the tmux client may have timed
                # out after the detached session started. Listing will reconcile it.
                raise
            current = self._resolve_workspace(workspace_id)
            if current != workspace:
                # The workspace was fenced while the command ran. This generated
                # session belongs to the old identity and must not be exposed.
                try:
                    await self._run_tmux(socket_path, "kill-session", "-t", "=" + name)
                except WorkspaceTerminalUnavailable:
                    pass
                raise ValueError("Workspace identity or generation changed during terminal creation")
            if result["returncode"] != 0:
                live_names = await self._external_sessions(socket_path)
                if name not in live_names:
                    record["sessions"] = [row for row in record["sessions"] if row["sessionId"] != session_id]
                    self._save_record(workspace, record)
                    raise WorkspaceTerminalUnavailable("tmux could not create the workspace terminal")
            live_names = await self._external_sessions(socket_path)
            if name not in live_names:
                # A successful client response without a live session is not
                # presented as a running terminal.
                record["sessions"] = [row for row in record["sessions"] if row["sessionId"] != session_id]
                self._save_record(workspace, record)
                raise WorkspaceTerminalUnavailable("tmux did not retain the workspace terminal")
            reservation["state"] = "running"
            self._save_record(workspace, record)
            return self._public_row(reservation)

    async def list(self, workspace_id: str) -> list[dict[str, str]]:
        """Return bounded status metadata for the server-owned workspace."""
        async with self._lock:
            workspace = self._resolve_workspace(workspace_id)
            self._assert_tmux_available()
            record = self._load_record(workspace)
            await self._reconcile(workspace, record)
            return [self._public_row(row) for row in record["sessions"]]

    async def terminate(self, workspace_id: str, session_id: str, *, confirm: bool) -> None:
        """Stop one ledger-owned session after explicit confirmation."""
        if confirm is not True:
            raise PermissionError("Explicit confirmation is required to terminate a workspace terminal")
        if not isinstance(session_id, str) or not _SESSION_ID.fullmatch(session_id):
            raise ValueError("session_id is invalid")
        async with self._lock:
            workspace = self._resolve_workspace(workspace_id)
            self._assert_tmux_available()
            record = self._load_record(workspace)
            await self._reconcile(workspace, record)
            row = next((item for item in record["sessions"] if item["sessionId"] == session_id), None)
            if row is None:
                raise KeyError(session_id)
            socket_path = self._socket_path(workspace)
            # A timed-out create remains `starting` until the caller explicitly
            # resolves it. Recheck the private tmux server immediately before
            # cleanup; an unrecognized tmux error raises and keeps the row.
            if row["state"] == "starting":
                live_names = await self._external_sessions(socket_path)
                if row["name"] not in live_names:
                    if self._resolve_workspace(workspace_id) != workspace:
                        raise ValueError("Workspace identity or generation changed during terminal cleanup")
                    record["sessions"] = [item for item in record["sessions"] if item["sessionId"] != session_id]
                    self._save_record(workspace, record)
                    return
                row["state"] = "running"
                self._save_record(workspace, record)
            result = await self._run_tmux(socket_path, "kill-session", "-t", "=" + row["name"])
            if result["returncode"] != 0:
                raise WorkspaceTerminalUnavailable("tmux could not terminate the workspace terminal")
            record["sessions"] = [item for item in record["sessions"] if item["sessionId"] != session_id]
            self._save_record(workspace, record)

    async def screen(self, workspace_id: str, session_id: str, *, lines: int = 80) -> dict[str, Any]:
        """Capture a bounded plain-text tail from one live pane."""
        if isinstance(lines, bool) or not isinstance(lines, int) or not 1 <= lines <= 120:
            raise ValueError("lines must be between 1 and 120")
        if not isinstance(session_id, str) or not _SESSION_ID.fullmatch(session_id):
            raise ValueError("session_id is invalid")
        async with self._lock:
            workspace = self._resolve_workspace(workspace_id)
            self._assert_tmux_available()
            record = self._load_record(workspace)
            await self._reconcile(workspace, record)
            row = next((item for item in record["sessions"] if item["sessionId"] == session_id), None)
            if row is None:
                raise KeyError(session_id)
            if row["state"] != "running":
                raise ValueError("Workspace terminal is not ready")
            socket_path = self._socket_path(workspace)
            pane_id = await self._active_pane(socket_path, row["name"])
            result = await self._run_tmux(
                socket_path,
                "capture-pane", "-p", "-S", f"-{lines}", "-t", pane_id,
                stdout_limit=_MAX_SCREEN_BYTES,
            )
            if result["returncode"] != 0:
                raise WorkspaceTerminalUnavailable("tmux could not capture the workspace terminal")
            return {"text": result["stdout"], "truncated": result["stdoutTruncated"]}

    async def send_line(self, workspace_id: str, session_id: str, line: str) -> dict[str, bool]:
        """Send one literal line and Enter; never retries an ambiguous tmux send."""
        if not isinstance(line, str) or not line:
            raise ValueError("line must be a non-empty string")
        try:
            line_bytes = line.encode("utf-8", errors="strict")
        except UnicodeEncodeError as exc:
            raise ValueError("line must be valid UTF-8") from exc
        if len(line_bytes) > _MAX_INPUT_BYTES:
            raise ValueError("line must be at most 4096 UTF-8 bytes")
        if any(ord(char) < 32 or ord(char) == 127 for char in line):
            raise ValueError("line must not contain control characters")
        if not isinstance(session_id, str) or not _SESSION_ID.fullmatch(session_id):
            raise ValueError("session_id is invalid")
        async with self._lock:
            workspace = self._resolve_workspace(workspace_id)
            self._assert_tmux_available()
            record = self._load_record(workspace)
            await self._reconcile(workspace, record)
            row = next((item for item in record["sessions"] if item["sessionId"] == session_id), None)
            if row is None:
                raise KeyError(session_id)
            if row["state"] != "running":
                raise ValueError("Workspace terminal is not ready")
            socket_path = self._socket_path(workspace)
            pane_id = await self._active_pane(socket_path, row["name"])
            try:
                typed = await self._run_tmux(
                    socket_path,
                    "send-keys", "-t", pane_id, "-l", "--", line,
                )
                if typed["returncode"] != 0:
                    raise WorkspaceTerminalInputOutcomeUnknown(
                        "Terminal input outcome is unknown; do not retry automatically"
                    )
                entered = await self._run_tmux(
                    socket_path,
                    "send-keys", "-t", pane_id, "Enter",
                )
                if entered["returncode"] != 0:
                    raise WorkspaceTerminalInputOutcomeUnknown(
                        "Terminal input outcome is unknown; do not retry automatically"
                    )
            except WorkspaceTerminalUnavailable as exc:
                if isinstance(exc, WorkspaceTerminalInputOutcomeUnknown):
                    raise
                raise WorkspaceTerminalInputOutcomeUnknown(
                    "Terminal input outcome is unknown; do not retry automatically"
                ) from exc
            return {"sent": True}

    async def _active_pane(self, socket_path: Path, session_name: str) -> str:
        """Resolve exactly one active pane from the target generated session."""
        result = await self._run_tmux(
            socket_path,
            "list-panes", "-a", "-F",
            "#{session_name}|#{window_active}|#{pane_active}|#{pane_id}",
        )
        if result["returncode"] != 0 or result["stdoutTruncated"]:
            raise WorkspaceTerminalUnavailable("tmux could not resolve the workspace terminal pane")
        active: list[str] = []
        for line in result["stdout"].splitlines():
            parts = line.split("|")
            if (len(parts) != 4 or not _TMUX_NAME.fullmatch(parts[0])
                    or parts[1] not in {"0", "1"} or parts[2] not in {"0", "1"}
                    or not _PANE_ID.fullmatch(parts[3])):
                raise WorkspaceTerminalUnavailable("tmux returned an invalid workspace pane identity")
            if parts[0] == session_name and parts[1] == "1" and parts[2] == "1":
                active.append(parts[3])
        if len(active) != 1:
            raise WorkspaceTerminalUnavailable("tmux did not identify one active workspace pane")
        return active[0]

    def _resolve_workspace(self, workspace_id: str) -> dict[str, Any]:
        if not isinstance(workspace_id, str) or not _WORKSPACE_ID.fullmatch(workspace_id):
            raise ValueError("workspace_id is invalid")
        workspace = self.database.get_workspace(workspace_id)
        if workspace.get("owner_id") != self.owner_id:
            raise PermissionError("Workspace does not belong to this backend owner")
        root_text = workspace.get("root")
        generation = workspace.get("generation")
        if workspace.get("isolation_profile") != "git-checkout" or not isinstance(workspace.get("project_id"), str):
            raise ValueError("Workspace is not a registered project checkout")
        if (not isinstance(root_text, str) or not root_text or not Path(root_text).is_absolute()
                or isinstance(generation, bool) or not isinstance(generation, int) or generation < 1):
            raise ValueError("Workspace identity is invalid")
        root = Path(root_text)
        try:
            resolved_root = root.resolve(strict=True)
            root_info = root.lstat()
        except OSError as exc:
            raise ValueError("Workspace root is unavailable") from exc
        if (str(resolved_root) != root_text or not stat.S_ISDIR(root_info.st_mode)
                or not os.access(root, os.R_OK | os.X_OK)):
            raise ValueError("Workspace root is not a canonical available directory")
        return {
            "workspace_id": workspace_id,
            "owner_id": self.owner_id,
            "root": root_text,
            "generation": generation,
        }

    def _metadata_path(self, workspace: dict[str, Any]) -> Path:
        digest = hashlib.sha256(workspace["workspace_id"].encode("ascii")).hexdigest()
        return self.metadata_root / (digest + ".json")

    def _socket_path(self, workspace: dict[str, Any]) -> Path:
        identity = f"{workspace['workspace_id']}\0{workspace['generation']}".encode("ascii")
        digest = hashlib.sha256(identity).hexdigest()[:20]
        path = self.socket_root / (digest + ".sock")
        if len(os.fsencode(path)) >= 108:
            raise ValueError("tmux socket path exceeds the operating system limit")
        return path

    def _load_record(self, workspace: dict[str, Any]) -> dict[str, Any]:
        path = self._metadata_path(workspace)
        try:
            descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0))
        except FileNotFoundError:
            return self._empty_record(workspace)
        except OSError as exc:
            raise WorkspaceTerminalUnavailable("Workspace terminal metadata cannot be opened safely") from exc
        try:
            info = os.fstat(descriptor)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                    or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > _MAX_METADATA_BYTES):
                raise WorkspaceTerminalUnavailable("Workspace terminal metadata is unsafe or oversized")
            payload = bytearray()
            while len(payload) <= _MAX_METADATA_BYTES:
                chunk = os.read(descriptor, min(4096, _MAX_METADATA_BYTES + 1 - len(payload)))
                if not chunk:
                    break
                payload.extend(chunk)
            if len(payload) > _MAX_METADATA_BYTES:
                raise WorkspaceTerminalUnavailable("Workspace terminal metadata is oversized")
        finally:
            os.close(descriptor)
        try:
            data = json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise WorkspaceTerminalUnavailable("Workspace terminal metadata is malformed") from exc
        if not isinstance(data, dict) or set(data) != {
            "version", "workspaceId", "root", "generation", "sessions",
        } or data.get("version") != 1:
            raise WorkspaceTerminalUnavailable("Workspace terminal metadata has an unsupported schema")
        if (data.get("workspaceId") != workspace["workspace_id"]
                or data.get("root") != workspace["root"]
                or data.get("generation") != workspace["generation"]):
            raise ValueError("Workspace root or generation changed; refusing stale terminal metadata")
        rows = data.get("sessions")
        if not isinstance(rows, list) or len(rows) > self.max_sessions:
            raise WorkspaceTerminalUnavailable("Workspace terminal metadata exceeds its session bound")
        for row in rows:
            if (not isinstance(row, dict) or set(row) != {"sessionId", "name", "state", "createdAt"}
                    or not isinstance(row.get("sessionId"), str) or not _SESSION_ID.fullmatch(row["sessionId"])
                    or not isinstance(row.get("name"), str) or not _TMUX_NAME.fullmatch(row["name"])
                    or row.get("state") not in {"starting", "running"}
                    or not isinstance(row.get("createdAt"), str) or len(row["createdAt"]) > 64):
                raise WorkspaceTerminalUnavailable("Workspace terminal metadata contains an invalid session")
        if len({row["sessionId"] for row in rows}) != len(rows) or len({row["name"] for row in rows}) != len(rows):
            raise WorkspaceTerminalUnavailable("Workspace terminal metadata contains duplicate sessions")
        return data

    @staticmethod
    def _empty_record(workspace: dict[str, Any]) -> dict[str, Any]:
        return {
            "version": 1,
            "workspaceId": workspace["workspace_id"],
            "root": workspace["root"],
            "generation": workspace["generation"],
            "sessions": [],
        }

    def _save_record(self, workspace: dict[str, Any], record: dict[str, Any]) -> None:
        payload = json.dumps(record, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
        if len(payload) > _MAX_METADATA_BYTES or len(record["sessions"]) > self.max_sessions:
            raise WorkspaceTerminalCapacity("Workspace terminal metadata limit reached")
        destination = self._metadata_path(workspace)
        temporary = self.metadata_root / ("." + uuid.uuid4().hex + ".tmp")
        descriptor = -1
        try:
            descriptor = os.open(
                temporary,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0),
                0o600,
            )
            view = memoryview(payload)
            while view:
                written = os.write(descriptor, view)
                if written <= 0:
                    raise OSError("short metadata write")
                view = view[written:]
            os.fsync(descriptor)
            os.close(descriptor)
            descriptor = -1
            os.replace(temporary, destination)
            directory_fd = os.open(self.metadata_root, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        except OSError as exc:
            raise WorkspaceTerminalUnavailable("Workspace terminal metadata could not be persisted") from exc
        finally:
            if descriptor >= 0:
                os.close(descriptor)
            temporary.unlink(missing_ok=True)

    async def _reconcile(self, workspace: dict[str, Any], record: dict[str, Any]) -> None:
        live_names = await self._external_sessions(self._socket_path(workspace))
        updated: list[dict[str, str]] = []
        changed = False
        for row in record["sessions"]:
            if row["name"] in live_names:
                if row["state"] != "running":
                    row["state"] = "running"
                    changed = True
                updated.append(row)
            elif row["state"] == "starting":
                # A prior tmux client may have timed out after asking the server
                # to create the session. Keep it bounded and uncertain until an
                # explicit terminate or another matching server record resolves it.
                updated.append(row)
            else:
                changed = True
        if changed:
            record["sessions"] = updated
            self._save_record(workspace, record)

    async def _external_sessions(self, socket_path: Path) -> set[str]:
        self._validate_socket(socket_path)
        if not socket_path.exists():
            return set()
        result = await self._run_tmux(socket_path, "list-sessions", "-F", "#{session_name}")
        if result["returncode"] != 0:
            detail = result["stderr"].lower()
            if "no server running" in detail or "no current server" in detail:
                return set()
            if not socket_path.exists():
                return set()
            raise WorkspaceTerminalUnavailable("tmux could not list workspace terminals")
        output = result["stdout"]
        if result["stdoutTruncated"]:
            raise WorkspaceTerminalUnavailable("tmux returned too many workspace sessions")
        names = set()
        for line in output.splitlines():
            if _TMUX_NAME.fullmatch(line):
                names.add(line)
        return names

    @staticmethod
    def _validate_socket(socket_path: Path) -> None:
        try:
            info = socket_path.lstat()
        except FileNotFoundError:
            return
        except OSError as exc:
            raise WorkspaceTerminalUnavailable("Could not inspect workspace tmux socket") from exc
        if (not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.geteuid()
                or stat.S_IMODE(info.st_mode) & 0o077):
            raise WorkspaceTerminalUnavailable("Workspace tmux socket is unsafe")

    async def _run_tmux(
        self, socket_path: Path, *args: str, stdout_limit: int = 8192,
    ) -> dict[str, Any]:
        self._assert_tmux_available()
        argv = [self.tmux_executable, "-S", str(socket_path), *args]
        try:
            process = await asyncio.create_subprocess_exec(
                *argv,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=build_child_env("terminal", overrides={"TERM": "dumb"}),
            )
        except (FileNotFoundError, PermissionError, OSError) as exc:
            raise WorkspaceTerminalUnavailable("tmux could not be started") from exc
        stdout_task = asyncio.create_task(self._read_bounded(process.stdout, stdout_limit))
        stderr_task = asyncio.create_task(self._read_bounded(process.stderr, 4096))
        wait_task = asyncio.create_task(process.wait())
        try:
            (stdout, stdout_truncated), (stderr, _), returncode = await asyncio.wait_for(
                asyncio.gather(stdout_task, stderr_task, wait_task),
                timeout=self.timeout_seconds,
            )
        except TimeoutError as exc:
            process.kill()
            await process.wait()
            await asyncio.gather(stdout_task, stderr_task, return_exceptions=True)
            raise WorkspaceTerminalUnavailable("tmux command timed out") from exc
        text, decoded_truncated = self._decode_bounded(stdout, stdout_limit)
        return {
            "returncode": returncode,
            "stdout": text,
            "stdoutTruncated": stdout_truncated or decoded_truncated,
            "stderr": stderr.decode("utf-8", errors="replace"),
        }

    @staticmethod
    async def _read_bounded(stream: asyncio.StreamReader, limit: int) -> tuple[bytes, bool]:
        content = bytearray()
        truncated = False
        while True:
            chunk = await stream.read(8192)
            if not chunk:
                break
            content.extend(chunk)
            if len(content) > limit:
                overflow = len(content) - limit
                del content[:overflow]
                truncated = True
        return bytes(content), truncated

    @staticmethod
    def _decode_bounded(content: bytes, limit: int) -> tuple[str, bool]:
        text = content.decode("utf-8", errors="replace")
        encoded = text.encode("utf-8")
        if len(encoded) <= limit:
            return text, False
        kept_bytes = 0
        start = len(text)
        for index in range(len(text) - 1, -1, -1):
            size = len(text[index].encode("utf-8"))
            if kept_bytes + size > limit:
                break
            kept_bytes += size
            start = index
        return text[start:], True

    def _assert_tmux_available(self) -> None:
        if self.tmux_executable is None:
            raise WorkspaceTerminalUnavailable("tmux is unavailable")
        try:
            info = os.stat(self.tmux_executable)
        except OSError as exc:
            raise WorkspaceTerminalUnavailable("tmux is unavailable") from exc
        if not stat.S_ISREG(info.st_mode) or not os.access(self.tmux_executable, os.X_OK):
            raise WorkspaceTerminalUnavailable("tmux is unavailable")

    @staticmethod
    def _public_row(row: dict[str, Any]) -> dict[str, str]:
        # Intentionally expose only generated identity, lifecycle, and timestamp.
        return {
            "sessionId": row["sessionId"],
            "state": row["state"],
            "createdAt": row["createdAt"],
        }
