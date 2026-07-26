from __future__ import annotations

import asyncio
import os
import signal
from pathlib import Path


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
        argv = [str(self.executable), "--profile", self.profile, "chat", "-q", prompt, "-Q", "--source", "archon-desktop"]
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
        process = await asyncio.create_subprocess_exec(
            *argv, cwd=cwd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        task_id = task["id"]
        self._active[task_id] = process
        stdout_lines: list[str] = []
        stderr_lines: list[str] = []

        async def pump(stream, sink, event_type):
            while True:
                raw = await stream.readline()
                if not raw:
                    break
                text = raw.decode(errors="replace").rstrip("\r\n")
                sink.append(text)
                if text:
                    await emit(event_type, {"text": text})

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
