from __future__ import annotations

import asyncio
import json
import os
import signal
import sys
import uuid
from dataclasses import dataclass
from pathlib import Path


CONTROL_PREFIX = "@@archon "
MAX_EVENT_TEXT = 4096
MAX_TOOL_DETAIL = 4000
MAX_TOOL_TARGET = 1000


_SUPERVISOR_CODE = r"""
import os
import subprocess
import sys
import time

if not sys.stdin.buffer.read(1):
    raise SystemExit(125)
child = subprocess.Popen(sys.argv[1:])
exit_code = child.wait()
leader_pid = os.getpid()
pgid = os.getpgrp()
while True:
    active = False
    for name in os.listdir('/proc'):
        if not name.isdigit() or int(name) == leader_pid:
            continue
        try:
            rest = open(f'/proc/{name}/stat', 'rb').read().rsplit(b')', 1)[1].strip().split()
            if len(rest) >= 3 and rest[0] != b'Z' and int(rest[2]) == pgid:
                active = True
                break
        except (OSError, ValueError, IndexError):
            pass
    if not active:
        raise SystemExit(exit_code)
    time.sleep(0.05)
"""


def supervised_argv(argv: list[str]) -> list[str]:
    return [sys.executable, "-c", _SUPERVISOR_CODE, *argv]


class RunnerCancelled(RuntimeError):
    pass


def _process_info(pid: int) -> tuple[str, int, str] | None:
    try:
        rest = Path(f"/proc/{pid}/stat").read_bytes().rsplit(b")", 1)[1].strip().split()
        if len(rest) < 20:
            return None
        return rest[0].decode("ascii"), int(rest[2]), rest[19].decode("ascii")
    except (OSError, ValueError, IndexError):
        return None


@dataclass
class ProcessIdentity:
    pid: int
    pgid: int
    start_time: str
    pidfd: int
    closed: bool = False

    def send(self, sig: signal.Signals | int) -> bool:
        if self.closed:
            return False
        try:
            signal.pidfd_send_signal(self.pidfd, sig)
            return True
        except ProcessLookupError:
            return False

    def close(self) -> None:
        if not self.closed:
            os.close(self.pidfd)
            self.closed = True


def capture_process_identity(process: asyncio.subprocess.Process) -> ProcessIdentity:
    pidfd: int | None = None
    try:
        pidfd = os.pidfd_open(process.pid)
        signal.pidfd_send_signal(pidfd, 0)
        info = _process_info(process.pid)
        signal.pidfd_send_signal(pidfd, 0)
        if info is None or process.returncode is not None:
            raise RuntimeError("Could not capture subprocess identity")
        return ProcessIdentity(
            pid=process.pid,
            pgid=info[1],
            start_time=info[2],
            pidfd=pidfd,
        )
    except BaseException:
        if pidfd is not None:
            try:
                signal.pidfd_send_signal(pidfd, signal.SIGKILL)
            except OSError:
                pass
            finally:
                os.close(pidfd)
        raise


def _group_members(pgid: int, parent_pid: int) -> dict[int, tuple[str, str]]:
    """Return PID -> (start time, state) for members of one process group."""
    members: dict[int, tuple[str, str]] = {}
    try:
        entries = Path("/proc").iterdir()
    except OSError:
        return members
    for entry in entries:
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        if pid == parent_pid:
            continue
        info = _process_info(pid)
        if info is not None and info[1] == pgid:
            members[pid] = (info[2], info[0])
    return members


def _signal_if_same_process(pid: int, pgid: int, start_time: str, sig: signal.Signals) -> None:
    try:
        pidfd = os.pidfd_open(pid)
    except ProcessLookupError:
        return
    try:
        info = _process_info(pid)
        if info is None or info[0] == "Z" or info[1] != pgid or info[2] != start_time:
            return
        signal.pidfd_send_signal(pidfd, sig)
    except ProcessLookupError:
        pass
    finally:
        os.close(pidfd)


async def _stop_group_members(
    pgid: int,
    parent_pid: int,
    graceful_timeout: float = 0.75,
    hard_timeout: float = 0.75,
) -> None:
    """Rescan a group until descendants, including late forks, are gone."""
    loop = asyncio.get_running_loop()
    graceful_deadline = loop.time() + graceful_timeout
    hard_deadline = graceful_deadline + hard_timeout
    term_sent: set[tuple[int, str]] = set()
    while loop.time() < hard_deadline:
        members = _group_members(pgid, parent_pid)
        if not members:
            return
        hard = loop.time() >= graceful_deadline
        for pid, (start_time, state) in members.items():
            identity = (pid, start_time)
            if state == "Z" or (not hard and identity in term_sent):
                continue
            _signal_if_same_process(pid, pgid, start_time, signal.SIGKILL if hard else signal.SIGTERM)
            term_sent.add(identity)
        await asyncio.sleep(0.02)


async def _confirm_captured_leader_stopped(identity: ProcessIdentity, timeout: float = 0.5) -> bool:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        try:
            status = os.waitid(
                os.P_PIDFD,
                identity.pidfd,
                os.WSTOPPED | os.WEXITED | os.WNOHANG | os.WNOWAIT,
            )
        except (ChildProcessError, OSError):
            status = None
        if status is not None:
            return status.si_code == os.CLD_STOPPED
        await asyncio.sleep(0.01)
    # SIGSTOP is non-maskable; signal 0 confirms the captured leader still
    # exists and therefore still anchors its original process group.
    return identity.send(0)


def _close_process_pipes(process: asyncio.subprocess.Process) -> None:
    for stream in (process.stdout, process.stderr):
        transport = getattr(stream, "_transport", None)
        if transport is not None:
            transport.close()


async def _bounded_process_wait(process: asyncio.subprocess.Process, timeout: float) -> bool:
    wait_task = asyncio.create_task(process.wait())
    try:
        await asyncio.wait_for(asyncio.shield(wait_task), timeout=timeout)
        return True
    except TimeoutError:
        _close_process_pipes(process)
        try:
            await asyncio.wait_for(asyncio.shield(wait_task), timeout=0.5)
            return True
        except TimeoutError:
            wait_task.cancel()
            return False


def _emergency_kill(identity: ProcessIdentity, anchored: bool) -> None:
    if anchored:
        try:
            os.killpg(identity.pgid, signal.SIGKILL)
            return
        except ProcessLookupError:
            pass
    identity.send(signal.SIGKILL)


async def abort_supervised_start(
    process: asyncio.subprocess.Process,
    identity: ProcessIdentity,
) -> None:
    # Never resume a supervisor after a failed release: the release byte may
    # already be queued. A synchronous finally guarantees repeated cancellation
    # cannot bypass the final kill once the original group is anchored.
    anchored = identity.send(signal.SIGSTOP)
    try:
        if anchored and await _confirm_captured_leader_stopped(identity):
            await _stop_group_members(identity.pgid, identity.pid)
    finally:
        _emergency_kill(identity, anchored)
        _close_process_pipes(process)
    await _bounded_process_wait(process, 0.5)


async def abort_uncaptured_process(process: asyncio.subprocess.Process) -> None:
    if process.returncode is None:
        try:
            process.kill()
        except ProcessLookupError:
            pass
    await _bounded_process_wait(process, 0.5)


async def release_supervised_target(process: asyncio.subprocess.Process) -> None:
    if process.stdin is None:
        raise RuntimeError("Supervisor startup pipe is unavailable")
    process.stdin.write(b"1")
    await process.stdin.drain()
    process.stdin.close()


async def terminate_process_tree(
    process: asyncio.subprocess.Process,
    identity: ProcessIdentity,
) -> None:
    """Terminate a captured subprocess and its stable supervised process group."""
    if process.returncode is not None:
        await _bounded_process_wait(process, 0.5)
        return
    anchored = identity.send(signal.SIGSTOP)
    try:
        if not anchored or not await _confirm_captured_leader_stopped(identity):
            _emergency_kill(identity, anchored)
            await _bounded_process_wait(process, 0.5)
            return
        # SIGSTOP keeps the original leader alive as a kernel-owned PGID anchor
        # for the full duration of all numeric group scans.
        await _stop_group_members(identity.pgid, identity.pid)
        # Let the supervisor resume, reap the terminated target, and exit naturally.
        identity.send(signal.SIGCONT)
        if await _bounded_process_wait(process, 1.0):
            return
        identity.send(signal.SIGTERM)
        identity.send(signal.SIGCONT)
        if not await _bounded_process_wait(process, 1.0):
            identity.send(signal.SIGKILL)
            await _bounded_process_wait(process, 0.5)
    except BaseException:
        _emergency_kill(identity, anchored)
        _close_process_pipes(process)
        raise


class HermesRunner:
    def __init__(self, executable: Path, profile: str = "archon", default_cwd: Path | None = None):
        self.executable = Path(executable)
        self.profile = profile
        self.default_cwd = Path(default_cwd) if default_cwd else Path.home()
        self._active: dict[str, asyncio.subprocess.Process] = {}
        self._identities: dict[str, ProcessIdentity] = {}
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
            *supervised_argv(argv),
            cwd=cwd,
            env=child_env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        task_id = task["id"]
        identity: ProcessIdentity | None = None
        try:
            identity = capture_process_identity(process)
            await release_supervised_target(process)
        except BaseException:
            if identity is not None:
                try:
                    await abort_supervised_start(process, identity)
                finally:
                    identity.close()
            else:
                await abort_uncaptured_process(process)
            raise
        self._active[task_id] = process
        self._identities[task_id] = identity
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
        except BaseException:
            await terminate_process_tree(process, identity)
            raise
        finally:
            self._active.pop(task_id, None)
            self._identities.pop(task_id, None)
            identity.close()
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
        identity = self._identities.get(task_id)
        if identity is None:
            return False
        await terminate_process_tree(process, identity)
        return True
