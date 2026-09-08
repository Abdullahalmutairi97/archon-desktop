from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any

from .hermes_runner import RunnerCancelled, ProcessIdentity, capture_process_identity, release_supervised_target, abort_supervised_start, abort_uncaptured_process, supervised_argv, terminate_process_tree

VALID_ID = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")


def _content(message: dict[str, Any]) -> str:
    value = message.get("content", "")
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            if not isinstance(item, dict):
                continue
            if isinstance(item.get("text"), str):
                parts.append(item["text"])
            elif isinstance(item.get("thinking"), str):
                parts.append(item["thinking"])
        return "\n".join(parts).strip()
    return ""


class PiRunner:
    """Runner adapter for Pi installed on the Archon MiniPC.

    The desktop selects this by sending task profile ``pi``. It still talks to the
    normal Archon server; no local desktop Pi process or direct SSH is involved.
    """

    def __init__(self, executable: Path | str | None = None, session_root: Path | None = None, default_cwd: Path | None = None):
        self.executable = Path(executable or (Path.home() / ".local/bin/pi")).expanduser()
        self.session_root = Path(session_root or (Path.home() / ".local/share/archon-desktop/pi-sessions")).expanduser()
        self.default_cwd = Path(default_cwd or Path.home()).expanduser()
        self._active: dict[str, asyncio.subprocess.Process] = {}
        self._identities: dict[str, ProcessIdentity] = {}
        self._cancelled: set[str] = set()

    async def run(self, task: dict[str, Any], emit) -> dict[str, Any]:
        task_id = str(task["id"])
        session_id = str(task.get("session_id") or f"prime-{task_id}")
        if not session_id or any(ch not in VALID_ID for ch in session_id):
            raise ValueError("Invalid session id")
        if not self.executable.exists():
            raise RuntimeError(f"Pi executable was not found at {self.executable}")

        session_dir = self.session_root / session_id
        session_dir.mkdir(parents=True, exist_ok=True)
        requested_cwd = Path(str(task.get("cwd") or self.default_cwd)).expanduser()
        cwd = requested_cwd if requested_cwd.is_dir() else self.default_cwd
        prompt = str(task.get("prompt") or "")
        mode = task.get("approval_mode") or "auto"
        if not task.get("chat_only") and mode == "plan":
            prompt = "Planning only: do not edit files or run destructive commands. Return an actionable implementation plan.\n\n" + prompt
        elif not task.get("chat_only") and mode == "approve":
            prompt = "Do not perform destructive or production actions without explicit approval. Explain proposed actions first.\n\n" + prompt

        argv = [str(self.executable), "--print", "--mode", "json", "--session-dir", str(session_dir), "--session-id", session_id]
        if task.get("chat_only"):
            argv += ["--no-tools", "--no-extensions"]
        elif mode == "plan":
            argv += ["--tools", "read,grep,find,ls", "--no-extensions"]
        if task.get("provider") and task.get("model"):
            argv += ["--provider", str(task["provider"]), "--model", str(task["model"])]
        for skill in task.get("skills") or []:
            argv += ["--skill", str(skill)]
        argv.append(prompt)

        process = await asyncio.create_subprocess_exec(
            *supervised_argv(argv), cwd=str(cwd), env=os.environ.copy(),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            stdin=asyncio.subprocess.PIPE, start_new_session=True,
        )
        identity: ProcessIdentity | None = None
        answer = ""
        failure = ""
        try:
            identity = capture_process_identity(process)
            await release_supervised_target(process)
            self._active[task_id] = process
            self._identities[task_id] = identity
            if task_id in self._cancelled:
                self._cancelled.discard(task_id)
                raise RunnerCancelled(task_id)
            await emit("session", {"session_id": session_id})
        except BaseException:
            self._active.pop(task_id, None)
            self._identities.pop(task_id, None)
            if identity is not None:
                try:
                    await abort_supervised_start(process, identity)
                finally:
                    identity.close()
            else:
                await abort_uncaptured_process(process)
            raise

        async def read_stderr() -> str:
            if not process.stderr:
                return ""
            data = await process.stderr.read()
            return data.decode(errors="replace")[-8000:]

        stderr_task = asyncio.create_task(read_stderr())
        try:
            assert process.stdout is not None
            while True:
                line = await process.stdout.readline()
                if not line:
                    break
                try:
                    event = json.loads(line.decode(errors="replace"))
                except json.JSONDecodeError:
                    continue
                typ = event.get("type")
                if typ == "session" and event.get("id"):
                    await emit("session", {"session_id": session_id})
                elif typ == "message_update":
                    delta = event.get("assistantMessageEvent") or {}
                    if delta.get("type") == "text_delta":
                        text = str(delta.get("delta") or "")
                        answer += text
                        await emit("message.delta", {"message_id": task_id, "text": text, "session_id": session_id})
                    elif delta.get("type") == "thinking_delta":
                        await emit("thinking", {"text": str(delta.get("delta") or "")})
                elif typ == "message_end":
                    msg = event.get("message") or {}
                    if msg.get("role") == "assistant":
                        if not answer:
                            answer = _content(msg)
                        if msg.get("errorMessage"):
                            failure = str(msg.get("errorMessage"))
                        await emit("message.done", {"session_id": session_id})
                elif typ == "tool_execution_start":
                    await emit("tool", {"id": event.get("toolCallId"), "phase": "start", "tool": event.get("toolName"), "target": json.dumps(event.get("args") or {})})
                elif typ == "tool_execution_end":
                    await emit("tool", {"id": event.get("toolCallId"), "phase": "end", "tool": event.get("toolName"), "detail": _content(event.get("result") or {}), "exit_code": 1 if event.get("isError") else 0})
            rc = await process.wait()
            stderr = await stderr_task
            if task_id in self._cancelled:
                self._cancelled.discard(task_id)
                raise RunnerCancelled(task_id)
            if rc != 0:
                raise RuntimeError(stderr or f"Pi exited with status {rc}")
            if failure:
                raise RuntimeError(failure)
            return {"text": answer, "session_id": session_id}
        finally:
            self._active.pop(task_id, None)
            ident = self._identities.pop(task_id, None)
            if ident is not None:
                ident.close()

    async def cancel(self, task_id: str) -> None:
        self._cancelled.add(task_id)
        process = self._active.get(task_id)
        identity = self._identities.get(task_id)
        if process is None:
            return
        if identity is not None:
            await terminate_process_tree(process, identity)
        else:
            process.terminate()
