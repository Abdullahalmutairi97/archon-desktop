from __future__ import annotations

import asyncio
import fcntl
import os
import pty
import re
import struct
import subprocess
import termios
from pathlib import Path

from fastapi import WebSocket

from .commands import CommandRunner


_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,47}$")


class TmuxService:
    prefix = "archon-desktop-"

    def __init__(self, root: Path, commands: CommandRunner):
        self.root = Path(root).resolve()
        self.commands = commands

    def _cwd(self, relative: str) -> Path:
        raw = Path(relative).expanduser()
        path = raw.resolve() if raw.is_absolute() else (self.root / raw).resolve()
        try:
            path.relative_to(self.root)
        except ValueError as exc:
            raise PermissionError("Terminal working directory is outside the configured root") from exc
        if not path.is_dir():
            raise NotADirectoryError(str(path))
        return path

    def normalize(self, label: str) -> str:
        slug = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")[:32] or "shell"
        return self.prefix + slug

    def validate(self, name: str) -> str:
        if not name.startswith(self.prefix):
            name = self.normalize(name)
        suffix = name[len(self.prefix):]
        if not _NAME_RE.fullmatch(suffix):
            raise ValueError("Invalid terminal session name")
        return name

    async def create(self, label: str, cwd: str = ".") -> dict:
        name = self.normalize(label)
        path = self._cwd(cwd)
        existing = await self.commands.run(["tmux", "has-session", "-t", name], timeout=5)
        if existing["returncode"] == 0:
            return {"name": name, "cwd": str(path), "persistent": True}
        result = await self.commands.run(
            ["tmux", "new-session", "-d", "-s", name, "-c", str(path)],
            detach_stdio=True,
            timeout=10,
        )
        if result["returncode"] and "duplicate session" not in result["stderr"].lower():
            raise RuntimeError(result["stderr"] or "Could not create terminal session")
        return {"name": name, "cwd": str(path), "persistent": True}

    async def list(self) -> list[dict]:
        result = await self.commands.run(["tmux", "list-sessions", "-F", "#{session_name}|#{session_windows}|#{session_created}"])
        if result["returncode"]:
            return []
        sessions = []
        for line in result["stdout"].splitlines():
            parts = line.split("|")
            if len(parts) != 3 or not parts[0].startswith(self.prefix):
                continue
            sessions.append({"name": parts[0], "windows": int(parts[1]), "created_at_epoch": int(parts[2]), "persistent": True})
        return sessions

    async def kill(self, name: str, *, confirm: bool) -> None:
        if not confirm:
            raise PermissionError("Explicit confirmation is required")
        name = self.validate(name)
        result = await self.commands.run(["tmux", "kill-session", "-t", name])
        if result["returncode"]:
            raise RuntimeError(result["stderr"] or "Could not stop terminal session")

    async def bridge(self, websocket: WebSocket, name: str) -> None:
        name = self.validate(name)
        master, slave = pty.openpty()
        env = {**os.environ, "TERM": "xterm-256color"}
        process = subprocess.Popen(
            ["tmux", "attach-session", "-t", name], stdin=slave, stdout=slave, stderr=slave,
            start_new_session=True, close_fds=True, env=env,
        )
        os.close(slave)

        async def output_loop():
            while process.poll() is None:
                try:
                    data = await asyncio.to_thread(os.read, master, 8192)
                except OSError:
                    break
                if not data:
                    break
                await websocket.send_bytes(data)

        async def input_loop():
            while True:
                message = await websocket.receive()
                if message.get("type") == "websocket.disconnect":
                    break
                if message.get("bytes") is not None:
                    os.write(master, message["bytes"])
                    continue
                text = message.get("text")
                if text is None:
                    continue
                if text.startswith('{"resize":'):
                    import json
                    size = json.loads(text)["resize"]
                    rows = max(5, min(int(size.get("rows", 24)), 300))
                    cols = max(20, min(int(size.get("cols", 80)), 500))
                    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
                else:
                    os.write(master, text.encode())

        reader = asyncio.create_task(output_loop())
        writer = asyncio.create_task(input_loop())
        done, pending = await asyncio.wait({reader, writer}, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        process.terminate()
        try:
            await asyncio.to_thread(process.wait, 2)
        except subprocess.TimeoutExpired:
            process.kill()
        os.close(master)
