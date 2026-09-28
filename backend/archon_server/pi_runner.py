from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, Callable

from .child_env import build_child_env
from .sandbox import RuntimeConfinement
from .runtimes import execution_cwd, validate_execution_mode

from .hermes_runner import RunnerCancelled, ProcessIdentity, capture_process_identity, release_supervised_target, abort_supervised_start, abort_uncaptured_process, supervised_argv, terminate_process_tree

VALID_ID = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")
_READ_CHUNK_SIZE = 64 * 1024
MAX_JSONL_RECORD_BYTES = 32 * 1024 * 1024


async def _stdout_jsonl_records(stream):
    """Read bounded JSONL records without asyncio's default 64 KiB line cap."""
    pending = bytearray()
    while chunk := await stream.read(_READ_CHUNK_SIZE):
        pending.extend(chunk)
        while (newline := pending.find(b"\n")) >= 0:
            if newline > MAX_JSONL_RECORD_BYTES:
                raise RuntimeError(f"Pi JSONL record exceeds {MAX_JSONL_RECORD_BYTES} bytes")
            yield bytes(pending[:newline])
            del pending[:newline + 1]
        if len(pending) > MAX_JSONL_RECORD_BYTES:
            raise RuntimeError(f"Pi JSONL record exceeds {MAX_JSONL_RECORD_BYTES} bytes")
    if pending:
        yield bytes(pending)


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

    def __init__(self, executable: Path | str | None = None, session_root: Path | None = None,
                 default_cwd: Path | None = None, isolation: RuntimeConfinement | None = None):
        self.executable = Path(executable or (Path.home() / ".local/bin/pi")).expanduser().absolute()
        self.session_root = Path(session_root or (Path.home() / ".local/share/archon-desktop/pi-sessions")).expanduser()
        self.default_cwd = Path(default_cwd or Path.home()).expanduser()
        # Off by default; see RuntimeConfinement for what is and is not qualified.
        self.isolation = isolation or RuntimeConfinement()
        self._active: dict[str, asyncio.subprocess.Process] = {}
        self._identities: dict[str, ProcessIdentity] = {}
        self._active_attempts: dict[str, str] = {}
        self._run_attempts: dict[str, str] = {}
        self._cancelled: set[str] = set()
        self.preflight: Callable[[dict[str, Any]], None] | None = None

    @staticmethod
    def _attempt_key(task: dict[str, Any], task_id: str) -> str:
        attempt_id = task.get("current_attempt_id")
        if isinstance(attempt_id, str) and attempt_id:
            return f"attempt:{attempt_id}"
        return f"task:{task_id}"

    def _cancellation_requested(self, task: dict[str, Any], task_id: str, attempt_key: str) -> bool:
        is_active = task.get("_attempt_active")
        if is_active is not None and not callable(is_active):
            raise TypeError("Task _attempt_active must be a synchronous callable")
        if callable(is_active):
            if not is_active():
                return True
        return attempt_key in self._cancelled or task_id in self._cancelled

    def _consume_cancellation(self, task_id: str, attempt_key: str) -> None:
        self._cancelled.discard(attempt_key)
        self._cancelled.discard(task_id)

    def _clear_active(self, task_id: str, attempt_key: str) -> None:
        if self._active_attempts.get(task_id) == attempt_key:
            self._active_attempts.pop(task_id, None)
            self._active.pop(task_id, None)
            self._identities.pop(task_id, None)

    async def run(self, task: dict[str, Any], emit) -> dict[str, Any]:
        validate_execution_mode(task)
        task_id = str(task["id"])
        attempt_key = self._attempt_key(task, task_id)
        session_id = str(task.get("session_id") or f"prime-{task_id}")
        if not session_id or any(ch not in VALID_ID for ch in session_id):
            raise ValueError("Invalid session id")
        self._run_attempts[task_id] = attempt_key
        try:
            if self._cancellation_requested(task, task_id, attempt_key):
                self._consume_cancellation(task_id, attempt_key)
                raise RunnerCancelled(task_id)
            if not self.executable.exists():
                raise RuntimeError(f"Pi executable was not found at {self.executable}")

            session_dir = self.session_root / session_id
            session_dir.mkdir(parents=True, exist_ok=True)
            if self.preflight is not None:
                self.preflight(task)
            if self._cancellation_requested(task, task_id, attempt_key):
                self._consume_cancellation(task_id, attempt_key)
                raise RunnerCancelled(task_id)
            cwd = execution_cwd(task.get("cwd") or self.default_cwd, require_canonical=bool(task.get("cwd")))
            prompt = str(task.get("prompt") or "")
            argv = [str(self.executable), "--print", "--mode", "json", "--session-dir", str(session_dir), "--session-id", session_id]
            if task.get("provider") and task.get("model"):
                argv += ["--provider", str(task["provider"]), "--model", str(task["model"])]
            for skill in task.get("skills") or []:
                argv += ["--skill", str(skill)]
            argv.append(prompt)
            if self._cancellation_requested(task, task_id, attempt_key):
                self._consume_cancellation(task_id, attempt_key)
                raise RunnerCancelled(task_id)

            child_env = build_child_env("pi")
            if self.isolation.enabled:
                # Confine the runtime child in the workspace and its own session
                # directory; a private temp directory keeps scratch writes bounded.
                temp_root = session_dir / "tmp"
                temp_root.mkdir(parents=True, exist_ok=True)
                argv = self.isolation.command(argv=argv, cwd=cwd, writable_roots=[session_dir, temp_root])
                child_env["TMPDIR"] = str(temp_root)
            process = await asyncio.create_subprocess_exec(
                *supervised_argv(argv), cwd=str(cwd), env=child_env,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                stdin=asyncio.subprocess.PIPE, start_new_session=True,
            )
            identity: ProcessIdentity | None = None
            answer = ""
            failure = ""
            try:
                identity = capture_process_identity(process)
                self._active[task_id] = process
                self._identities[task_id] = identity
                self._active_attempts[task_id] = attempt_key
                if self._cancellation_requested(task, task_id, attempt_key):
                    self._consume_cancellation(task_id, attempt_key)
                    raise RunnerCancelled(task_id)
                await release_supervised_target(process)
                if self._cancellation_requested(task, task_id, attempt_key):
                    self._consume_cancellation(task_id, attempt_key)
                    raise RunnerCancelled(task_id)
                await emit("session", {"session_id": session_id})
            except BaseException as exc:
                try:
                    if identity is not None:
                        try:
                            await abort_supervised_start(process, identity)
                        finally:
                            identity.close()
                    else:
                        await abort_uncaptured_process(process)
                finally:
                    self._clear_active(task_id, attempt_key)
                cancelled = self._cancellation_requested(task, task_id, attempt_key)
                if cancelled:
                    self._consume_cancellation(task_id, attempt_key)
                    if isinstance(exc, RunnerCancelled):
                        raise
                    raise RunnerCancelled(task_id) from exc
                raise

            async def read_stderr() -> str:
                if not process.stderr:
                    return ""
                data = await process.stderr.read()
                return data.decode(errors="replace")[-8000:]

            stderr_task = asyncio.create_task(read_stderr())
            try:
                assert process.stdout is not None
                async for line in _stdout_jsonl_records(process.stdout):
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
                if self._cancellation_requested(task, task_id, attempt_key):
                    self._consume_cancellation(task_id, attempt_key)
                    raise RunnerCancelled(task_id)
                if rc != 0:
                    raise RuntimeError(stderr or f"Pi exited with status {rc}")
                if failure:
                    raise RuntimeError(failure)
                return {"text": answer, "session_id": session_id}
            except BaseException:
                await terminate_process_tree(process, identity)
                await asyncio.gather(stderr_task, return_exceptions=True)
                raise
            finally:
                self._clear_active(task_id, attempt_key)
                identity.close()
        except RunnerCancelled as exc:
            self._consume_cancellation(task_id, attempt_key)
            raise RunnerCancelled(task_id) from exc
        finally:
            if self._run_attempts.get(task_id) == attempt_key:
                self._run_attempts.pop(task_id, None)

    async def cancel(self, task_id: str) -> None:
        attempt_key = self._run_attempts.get(task_id, task_id)
        self._cancelled.add(attempt_key)
        process = self._active.get(task_id)
        identity = self._identities.get(task_id)
        if process is None or self._active_attempts.get(task_id) != attempt_key:
            return
        if identity is not None:
            await terminate_process_tree(process, identity)
        else:
            process.terminate()
