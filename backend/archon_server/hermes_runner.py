from __future__ import annotations

import asyncio
import json
import os
import signal
import uuid
from pathlib import Path


CONTROL_PREFIX = "@@archon "
MAX_EVENT_TEXT = 4096
MAX_TOOL_DETAIL = 4000
MAX_TOOL_TARGET = 1000


class RunnerCancelled(RuntimeError):
    pass


class HermesRunner:
    def __init__(self, executable: Path, profile: str = "archon", default_cwd: Path | None = None):
        self.executable = Path(executable)
        self.profile = profile
        self.default_cwd = Path(default_cwd) if default_cwd else Path.home()
        self._active: dict[str, asyncio.subprocess.Process] = {}
        self._cancelled: set[str] = set()

    async def run(self, task: dict, emit) -> dict:
        approval_mode = task.get("approval_mode") or "auto"
        prompt = task["prompt"]
        if task.get("chat_only"):
            toolset = "context_engine"
        elif approval_mode == "approve":
            toolset = "context_engine"
            prompt = (
                "APPROVE STEPS MODE: You have no callable tools in this turn. "
                "Describe only the single next tool action you need, including its exact target and arguments, "
                "why it is needed, and ask the user to approve it. Do not claim it ran.\n\n"
                f"User request:\n{prompt}"
            )
        elif approval_mode == "plan":
            toolset = "web,vision,session_search"
            prompt = (
                "PLAN MODE: Research with read-only tools only. Do not execute shell commands, edit files, "
                "change configuration, or perform external side effects. Return an actionable plan for acceptance.\n\n"
                f"User request:\n{prompt}"
            )
        else:
            toolset = ""
        argv = [str(self.executable), "--profile", task.get("profile") or self.profile, "chat", "-q", prompt, "-Q", "--source", "archon-desktop"]
        if toolset:
            # `context_engine` is Hermes' valid zero-tool toolset. Do not use
            # `safe` here: that set still exposes web, vision and image tools.
            argv += ["-t", toolset]
        if approval_mode == "auto" and not task.get("chat_only"):
            argv.append("--yolo")
        if task.get("model"):
            argv += ["-m", task["model"]]
        if task.get("provider"):
            argv += ["--provider", task["provider"]]
        if task.get("session_id"):
            argv += ["--resume", task["session_id"], "--no-restore-cwd"]
        skills = list(task.get("skills") or [])
        if approval_mode == "plan" and "plan" not in skills:
            skills.append("plan")
        if skills:
            argv += ["-s", ",".join(skills)]
        cwd = task.get("cwd") or str(self.default_cwd)
        child_env = os.environ.copy()
        child_env["ARCHON_DESKTOP_CONTROL_MODULE"] = str(
            Path(__file__).with_name("hermes_control.py")
        )
        process = await asyncio.create_subprocess_exec(
            *argv,
            cwd=cwd,
            env=child_env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        task_id = task["id"]
        self._active[task_id] = process
        stdout_lines: list[str] = []
        stderr_lines: list[str] = []

        announced_session = False
        reply_message_id = uuid.uuid4().hex

        async def emit_text(event_type: str, text: str) -> None:
            for start in range(0, len(text), MAX_EVENT_TEXT):
                await emit(event_type, {"text": text[start : start + MAX_EVENT_TEXT]})

        async def handle_control(payload: object) -> bool:
            if not isinstance(payload, dict):
                return False
            event = payload.get("event")
            if event == "message.delta":
                text = payload.get("text")
                if not isinstance(text, str):
                    return False
                for start in range(0, len(text), MAX_EVENT_TEXT):
                    await emit(
                        "message.delta",
                        {
                            "message_id": reply_message_id,
                            "text": text[start : start + MAX_EVENT_TEXT],
                        },
                    )
                return True
            if event == "message.done":
                await emit("message.done", {})
                return True
            if event == "output":
                text = payload.get("text")
                if not isinstance(text, str):
                    return False
                await emit_text("output", text)
                return True
            if event != "tool":
                return False

            call_id = payload.get("id")
            phase = payload.get("phase")
            tool = payload.get("tool")
            target = payload.get("target")
            if (
                not isinstance(call_id, str)
                or not call_id
                or not isinstance(tool, str)
                or not tool
                or not isinstance(target, str)
                or not target
            ):
                return False
            if phase not in {"start", "end"}:
                return False
            bounded: dict[str, object] = {
                "id": call_id[:200],
                "phase": phase,
                "tool": tool[:100],
                "target": target[:MAX_TOOL_TARGET],
            }
            if phase == "end":
                duration = payload.get("duration")
                exit_code = payload.get("exit_code")
                detail = payload.get("detail", "")
                if not isinstance(duration, (int, float)) or isinstance(duration, bool):
                    return False
                if not isinstance(exit_code, int) or isinstance(exit_code, bool):
                    return False
                if not isinstance(detail, str):
                    return False
                bounded.update(
                    {
                        "duration": round(max(0.0, float(duration)), 2),
                        "exit_code": exit_code,
                        "detail": detail[:MAX_TOOL_DETAIL],
                    }
                )
                for key in ("added", "removed"):
                    value = payload.get(key)
                    if value is not None:
                        if not isinstance(value, int) or isinstance(value, bool):
                            return False
                        bounded[key] = max(0, value)
            await emit("tool", bounded)
            return True

        async def pump(stream, sink, event_type):
            nonlocal announced_session
            while True:
                raw = await stream.readline()
                if not raw:
                    break
                text = raw.decode(errors="replace").rstrip("\r\n")
                if event_type == "diagnostic" and text.startswith(CONTROL_PREFIX):
                    try:
                        payload = json.loads(text[len(CONTROL_PREFIX) :])
                    except (json.JSONDecodeError, TypeError, ValueError):
                        payload = None
                    if payload is not None and await handle_control(payload):
                        continue
                sink.append(text)
                # Hermes prints "session_id: <id>" on stderr early in the run.
                # Announcing it here rather than waiting for exit is what makes a
                # running task addressable: the row gets its session immediately,
                # so follow-up prompts continue it instead of opening a new one.
                if not announced_session and text.startswith("session_id:"):
                    session_id = text.split(":", 1)[1].strip()
                    if session_id:
                        announced_session = True
                        await emit("session", {"session_id": session_id[:256]})
                if text:
                    await emit_text(event_type, text)

        try:
            await asyncio.gather(
                pump(process.stdout, stdout_lines, "output"),
                pump(process.stderr, stderr_lines, "diagnostic"),
            )
            code = await process.wait()
        finally:
            self._active.pop(task_id, None)
        if task_id in self._cancelled:
            self._cancelled.discard(task_id)
            raise RunnerCancelled(task_id)
        if code:
            error = "\n".join(stderr_lines[-50:]) or f"Hermes exited with code {code}"
            raise RuntimeError(error)
        text = "\n".join(line for line in stdout_lines if line).strip()
        result = {"text": text, "exit_code": code}
        session_line = next((line for line in reversed(stderr_lines) if line.startswith("session_id:")), "")
        if session_line:
            result["session_id"] = session_line.split(":", 1)[1].strip()
        return result

    async def cancel(self, task_id: str) -> bool:
        process = self._active.get(task_id)
        if process is None:
            return False
        self._cancelled.add(task_id)
        if process.returncode is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(asyncio.shield(process.wait()), timeout=5)
            except TimeoutError:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                await process.wait()
        else:
            await process.wait()
        return True
