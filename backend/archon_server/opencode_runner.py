from __future__ import annotations

import asyncio
import json
import os
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .hermes_runner import (
    ProcessIdentity, RunnerCancelled, abort_supervised_start, abort_uncaptured_process,
    capture_process_identity, release_supervised_target, supervised_argv, terminate_process_tree,
)

VALID_ID = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")
TRANSCRIPT = "opencode.jsonl"
STATE = "opencode-session.json"
MAX_TOOL_OUTPUT = 20_000
# `opencode run` auto-rejects a permission set to "ask", so these restrictions are
# enforced by OpenCode itself rather than being requests written into the prompt.
READ_ONLY = {"permission": {"edit": "ask", "bash": "ask", "webfetch": "allow"}}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class OpenCodeRunner:
    """Runner adapter for the OpenCode CLI installed on the Archon host.

    Each turn is `opencode run --format json`. The conversation is mirrored into
    Archon's session store in the same JSONL shape Prime and Pi use, so listing,
    history, projects and deletion work unchanged. OpenCode's own session id is
    kept beside it so a follow-up continues the same OpenCode session.
    """

    def __init__(self, executable: Path | str | None = None, session_root: Path | None = None,
                 default_cwd: Path | None = None, default_model: str = "opencode/big-pickle",
                 default_model_source=None):
        self.executable = Path(executable or (Path.home() / ".local/bin/opencode")).expanduser()
        self.session_root = Path(session_root or (Path.home() / ".local/share/archon-desktop/prime-sessions")).expanduser()
        self.default_cwd = Path(default_cwd or Path.home()).expanduser()
        self.default_model = default_model
        self.default_model_source = default_model_source
        self._active: dict[str, asyncio.subprocess.Process] = {}
        self._identities: dict[str, ProcessIdentity] = {}
        self._cancelled: set[str] = set()

    def model_for(self, task: dict[str, Any]) -> str | None:
        model = str(task.get("model") or "")
        if task.get("provider") == "opencode" and "/" in model:
            return model
        chosen = self.default_model_source() if self.default_model_source else None
        return chosen or self.default_model or None

    def _argv(self, task: dict[str, Any], native_session: str | None) -> tuple[list[str], dict[str, str]]:
        argv = [str(self.executable), "run", "--format", "json"]
        env = os.environ.copy()
        mode = task.get("approval_mode") or "approve"
        if task.get("chat_only") or mode == "plan":
            argv += ["--agent", "plan"]
        elif mode == "auto":
            argv.append("--auto")
        else:
            env["OPENCODE_CONFIG_CONTENT"] = json.dumps(READ_ONLY)
        model = self.model_for(task)
        if model:
            argv += ["--model", model]
        if native_session:
            argv += ["--session", native_session]
        argv += ["--", str(task.get("prompt") or "")]
        return argv, env

    def _record(self, path: Path, record: dict[str, Any]) -> str:
        record.setdefault("id", f"oc-{time.time_ns()}")
        record.setdefault("timestamp", _now())
        with path.open("a") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
        return record["id"]

    async def run(self, task: dict[str, Any], emit) -> dict[str, Any]:
        task_id = str(task["id"])
        session_id = str(task.get("session_id") or f"prime-{task_id}")
        if not session_id or any(ch not in VALID_ID for ch in session_id):
            raise ValueError("Invalid session id")
        if not self.executable.exists():
            raise RuntimeError(f"OpenCode executable was not found at {self.executable}")

        session_dir = self.session_root / session_id
        session_dir.mkdir(parents=True, exist_ok=True)
        transcript, state_path = session_dir / TRANSCRIPT, session_dir / STATE
        requested_cwd = Path(str(task.get("cwd") or self.default_cwd)).expanduser()
        if not requested_cwd.is_absolute():
            requested_cwd = self.default_cwd / requested_cwd
        cwd = requested_cwd if requested_cwd.is_dir() else self.default_cwd
        try:
            native_session = json.loads(state_path.read_text()).get("session")
        except (OSError, json.JSONDecodeError, AttributeError):
            native_session = None
        if not transcript.exists():
            self._record(transcript, {"type": "session", "id": session_id, "version": 3, "cwd": str(cwd), "runtime": "opencode"})
        model = self.model_for(task)
        parent = self._record(transcript, {"type": "model_change", "modelId": model or "opencode"})
        parent = self._record(transcript, {"type": "message", "parentId": parent,
                                           "message": {"role": "user", "content": [{"type": "text", "text": str(task.get("prompt") or "")}]}})

        argv, env = self._argv(task, native_session)
        process = await asyncio.create_subprocess_exec(
            *supervised_argv(argv), cwd=str(cwd), env=env,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            stdin=asyncio.subprocess.PIPE, start_new_session=True,
        )
        identity: ProcessIdentity | None = None
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
            data = await process.stderr.read() if process.stderr else b""
            return data.decode(errors="replace")[-8000:]

        stderr_task = asyncio.create_task(read_stderr())
        answer: list[str] = []
        failure = ""
        try:
            assert process.stdout is not None
            while line := await process.stdout.readline():
                try:
                    event = json.loads(line.decode(errors="replace"))
                except json.JSONDecodeError:
                    continue
                if not isinstance(event, dict):
                    continue
                kind, part = event.get("type"), event.get("part") or {}
                native = event.get("sessionID") or part.get("sessionID")
                if native and native != native_session:
                    native_session = native
                    state_path.write_text(json.dumps({"session": native_session}))
                if kind == "text" and part.get("text"):
                    text = str(part["text"])
                    answer.append(text)
                    await emit("message.delta", {"message_id": task_id, "text": text, "session_id": session_id})
                    parent = self._record(transcript, {"type": "message", "parentId": parent,
                                                       "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}})
                elif kind == "reasoning" and part.get("text"):
                    await emit("thinking", {"text": str(part["text"])})
                elif kind == "tool_use":
                    state = part.get("state") or {}
                    tool, call = str(part.get("tool") or "tool"), part.get("callID")
                    arguments = state.get("input") or {}
                    await emit("tool", {"id": call, "phase": "start", "tool": tool, "target": json.dumps(arguments)})
                    failed = state.get("status") == "error"
                    output = str(state.get("error") if failed else state.get("output") or "")[:MAX_TOOL_OUTPUT]
                    await emit("tool", {"id": call, "phase": "end", "tool": tool, "detail": output, "exit_code": 1 if failed else 0})
                    parent = self._record(transcript, {"type": "message", "parentId": parent, "message": {
                        "role": "assistant", "content": [{"type": "toolCall", "name": tool, "arguments": arguments}]}})
                    parent = self._record(transcript, {"type": "message", "parentId": parent, "message": {
                        "role": "toolResult", "content": [{"type": "text", "text": output or "(no output)"}]}})
                elif kind == "error":
                    detail = event.get("error") or part.get("error") or event
                    failure = str(detail.get("message") or detail.get("data", {}).get("message") or detail) if isinstance(detail, dict) else str(detail)
            rc = await process.wait()
            stderr = await stderr_task
            if task_id in self._cancelled:
                self._cancelled.discard(task_id)
                raise RunnerCancelled(task_id)
            if failure:
                raise RuntimeError(failure)
            if rc != 0:
                raise RuntimeError(stderr.strip() or f"OpenCode exited with status {rc}")
            await emit("message.done", {"session_id": session_id})
            # The final part is the answer; earlier parts are already in the transcript.
            return {"text": answer[-1].strip() if answer else "", "session_id": session_id}
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


class OpenCodeModels:
    """The models `opencode models` reports, cached briefly because listing is slow."""

    def __init__(self, executable: Path | str, ttl: float = 600.0):
        self.executable = Path(executable).expanduser()
        self.ttl = ttl
        self._cached: tuple[float, list[str]] | None = None

    def list(self) -> list[str]:
        if self._cached and time.monotonic() - self._cached[0] < self.ttl:
            return self._cached[1]
        models: list[str] = []
        if self.executable.exists():
            try:
                result = subprocess.run([str(self.executable), "models"], capture_output=True, text=True,
                                        timeout=30, stdin=subprocess.DEVNULL)
                models = [line.strip() for line in result.stdout.splitlines()
                          if "/" in line and " " not in line.strip() and not line.startswith("\x1b")]
            except (OSError, subprocess.TimeoutExpired):
                models = []
        self._cached = (time.monotonic(), models)
        return models
