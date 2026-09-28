from __future__ import annotations

import asyncio
import fcntl
import json
import math
import os
import stat
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from .child_env import build_child_env
from .native_diagnostics import NativeEventDiagnostics
from .sandbox import RuntimeConfinement
from .prime_session_lease import (
    LEASE_ENABLED_ENV as PRIME_LEASE_ENABLED_ENV,
    PrimeSessionAlreadyActive,
    PrimeSessionLease,
    PrimeSessionLeaseUnavailable,
    acquire_session_lease,
    release_session_lease,
)
from .runtimes import execution_cwd, validate_execution_mode
from .hermes_runner import (
    MAX_EVENT_TEXT,
    ProcessIdentity,
    RunnerCancelled,
    _bounded_process_wait,
    abort_supervised_start,
    abort_uncaptured_process,
    capture_process_identity,
    release_supervised_target,
    supervised_argv,
    terminate_process_tree,
)


_READ_CHUNK_SIZE = 64 * 1024
MAX_JSONL_RECORD_BYTES = 32 * 1024 * 1024
_EVENT_TRUNCATION_MARKER = "\n…[truncated]"


@dataclass
class _SessionLease:
    """One open description of a persistent Linux advisory lock file."""

    _fd: int | None

    def fileno(self) -> int:
        if self._fd is None:
            raise ValueError("Session lease is closed")
        return self._fd

    def close(self) -> None:
        if self._fd is not None:
            fd, self._fd = self._fd, None
            # Do not LOCK_UN: a surviving supervisor may still hold a copy of
            # this open description while the native process finishes.
            os.close(fd)


async def _acquire_session_lease(
    root: Path, session_id: str, timeout: float = 30.0,
    cancel_check: Callable[[], bool] | None = None,
    cancel_task_id: str | None = None,
) -> _SessionLease:
    if not session_id or any(char not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-' for char in session_id):
        raise ValueError('Invalid session id')
    if timeout < 0 or not math.isfinite(timeout):
        raise ValueError("Session lease timeout must be finite and nonnegative")

    def check_cancelled() -> None:
        if cancel_check is not None and cancel_check():
            raise RunnerCancelled(cancel_task_id or session_id)

    check_cancelled()
    path = root / f".{session_id}.lock"
    root.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    except IsADirectoryError as exc:
        # Old runners use mkdir/rmdir, not flock. Never remove a live or
        # uncertain legacy lease, even when its owner metadata looks stale.
        raise RuntimeError(
            f"Legacy session lease for {session_id}; quiesce all Archon and native Prime "
            "processes using this session, then archive its legacy lock directory before retrying"
        ) from exc
    lease = _SessionLease(fd)
    try:
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode):
            raise RuntimeError(f"Session lease is not a regular file: {session_id}")
        deadline = time.monotonic() + timeout
        while True:
            check_cancelled()
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise RuntimeError(f"Timed out waiting for session lease: {session_id}")
                await asyncio.sleep(min(0.05, remaining))
        check_cancelled()
        current = path.stat(follow_symlinks=False)
        if (current.st_dev, current.st_ino) != (opened.st_dev, opened.st_ino):
            raise RuntimeError(f"Session lease file was replaced while waiting: {session_id}")
        # Diagnostic only. Kernel ownership, not PID or JSON contents, decides
        # whether another runner may enter. Never unlink or replace this inode.
        os.ftruncate(fd, 0)
        with os.fdopen(os.dup(fd), "w", encoding="utf-8") as metadata:
            json.dump({"pid": os.getpid(), "acquired_at": time.time()}, metadata)
        return lease
    except BaseException:
        lease.close()
        raise


def _release_session_lease(lease: _SessionLease) -> None:
    lease.close()


class PrimeRunner:
    """Runner adapter for the native prime-agent CLI.

    Prime keeps its own session files; Archon only stores a stable session key and
    task output. This deliberately does not translate Prime's native transcript.
    """
    def __init__(
        self,
        executable: Path,
        session_root: Path | None = None,
        default_cwd: Path | None = None,
        agent_session_root: Path | None = None,
        isolation: RuntimeConfinement | None = None,
    ):
        self.executable = Path(executable).expanduser().absolute()
        self.session_root = Path(session_root or (Path.home() / '.local/share/archon-desktop/prime-sessions'))
        self.default_cwd = Path(default_cwd or Path.home())
        self.agent_session_root = Path(agent_session_root or (Path.home() / '.prime/agent/sessions'))
        # Off by default; see RuntimeConfinement for what is and is not qualified.
        self.isolation = isolation or RuntimeConfinement()
        self._active: dict[str, asyncio.subprocess.Process] = {}
        # Native session path per active attempt, resolved by run() so the native
        # lease and the process-wide lease cover the same run window.
        self._agent_paths: dict[str, Path | None] = {}
        self._identities: dict[str, ProcessIdentity] = {}
        self._active_attempts: dict[str, str] = {}
        self._released_attempts: dict[str, str] = {}
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
            self._released_attempts.pop(task_id, None)
            self._active.pop(task_id, None)
            self._identities.pop(task_id, None)

    def _acquire_native_lease(self, agent_path: Path | None, session_id: str) -> PrimeSessionLease | None:
        """Take Prime's own session lease for a native session, or fail closed."""
        if agent_path is None:
            return None
        try:
            return acquire_session_lease(
                agent_path,
                self.agent_session_root.parent,
                active_session_id=f"archon:{session_id}",
            )
        except PrimeSessionAlreadyActive as exc:
            raise RuntimeError(
                f"Session '{session_id}' is already active in a native Prime process. "
                "Close that session, then retry."
            ) from exc
        except PrimeSessionLeaseUnavailable as exc:
            raise RuntimeError(
                f"Session '{session_id}' could not be leased safely, so no turn was started: {exc}"
            ) from exc

    def _agent_session_path(self, session_id: str) -> Path | None:
        direct = self.agent_session_root / f"{session_id}.jsonl"
        if direct.is_file():
            return direct
        artifacts = self.agent_session_root.parent / "session-artifacts"
        if not artifacts.is_dir():
            return None
        for path in artifacts.rglob("*.jsonl"):
            try:
                for line in path.open(errors="replace"):
                    try:
                        item = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(item, dict):
                        continue
                    if item.get("type") == "session" and str(item.get("id") or "") == session_id:
                        return path
                    if item.get("type") == "session":
                        break
            except OSError:
                continue
        return None

    async def run(self, task: dict, emit) -> dict:
        validate_execution_mode(task)
        session_id = str(task.get("session_id") or f"prime-{task['id']}")
        task_id = str(task["id"])
        attempt_key = self._attempt_key(task, task_id)
        if not session_id or any(char not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-' for char in session_id):
            raise ValueError('Invalid session id')
        self._run_attempts[task_id] = attempt_key
        # flock also serializes separate opens in this process, so every
        # contender uses the same bounded, cancellable acquisition path.
        try:
            if self._cancellation_requested(task, task_id, attempt_key):
                self._consume_cancellation(task_id, attempt_key)
                raise RunnerCancelled(task_id)
            agent_path = self._agent_session_path(session_id) if task.get("session_id") else None
            native_lease = self._acquire_native_lease(agent_path, session_id) if agent_path is not None else None
            if agent_path is not None:
                self._agent_paths[attempt_key] = agent_path
            try:
                lease = await _acquire_session_lease(
                    self.session_root,
                    session_id,
                    cancel_check=lambda: self._cancellation_requested(task, task_id, attempt_key),
                    cancel_task_id=task_id,
                )
                try:
                    if self._cancellation_requested(task, task_id, attempt_key):
                        self._consume_cancellation(task_id, attempt_key)
                        raise RunnerCancelled(task_id)
                    return await self._run_once(task, emit, lease)
                finally:
                    _release_session_lease(lease)
            finally:
                self._agent_paths.pop(attempt_key, None)
                if native_lease is not None:
                    release_session_lease(native_lease)
        except RunnerCancelled as exc:
            self._consume_cancellation(task_id, attempt_key)
            raise RunnerCancelled(task_id) from exc
        finally:
            if self._run_attempts.get(task_id) == attempt_key:
                self._run_attempts.pop(task_id, None)

    async def _run_once(self, task: dict, emit, lease: _SessionLease) -> dict:
        """Run Prime in its structured JSON mode.

        Text mode writes the final reply to stdout. Treating stdout as live
        activity made the desktop place a second copy of the answer in the
        thought-process panel. JSON mode separates genuine thinking/tool events
        from the final assistant text, so only actual work appears in that panel.
        """
        task_id = str(task['id'])
        session_id = str(task.get('session_id') or f'prime-{task_id}')
        attempt_key = self._attempt_key(task, task_id)
        if self._cancellation_requested(task, task_id, attempt_key):
            self._consume_cancellation(task_id, attempt_key)
            raise RunnerCancelled(task_id)
        if not session_id or any(char not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-' for char in session_id):
            raise ValueError('Invalid session id')
        # Sessions started in Prime Agent's CLI/TUI are single JSONL files in its
        # native store. Resume those by exact id; Archon-owned sessions continue
        # to use their isolated per-session directories.
        # A session that Prime Agent owns is protected by Prime's own lease
        # directory, which run() holds for this whole attempt; the path is
        # resolved there once so it is never scanned twice.
        agent_path = self._agent_paths.get(attempt_key)
        if agent_path is None and task.get('session_id'):
            agent_path = self._agent_session_path(session_id)
        agent_session = agent_path is not None
        session_dir = self.session_root / session_id
        if not agent_session:
            session_dir.mkdir(parents=True, exist_ok=True)
        prompt = task['prompt']
        saved_cwd = task.get('cwd')
        if agent_session and not saved_cwd:
            try:
                for line in agent_path.read_text(errors='replace').splitlines():
                    item = json.loads(line)
                    if not isinstance(item, dict):
                        continue
                    if item.get('type') == 'session' and item.get('cwd'):
                        saved_cwd = item['cwd']
                        break
            except (OSError, json.JSONDecodeError):
                pass
        if self.preflight is not None:
            self.preflight(task)
        if self._cancellation_requested(task, task_id, attempt_key):
            self._consume_cancellation(task_id, attempt_key)
            raise RunnerCancelled(task_id)
        cwd = execution_cwd(saved_cwd or self.default_cwd, require_canonical=bool(saved_cwd))
        argv = [str(self.executable), '--print', '--mode', 'json', '--cwd', str(cwd)]
        if agent_session:
            argv += ['--resume', session_id]
        else:
            argv += ['--session-dir', str(session_dir)]
            if task.get('session_id'):
                argv.append('--continue')
        # Only expose the authenticated Prime provider; stale legacy picker values
        # cannot make a queued turn fail before it starts.
        if task.get('provider') == 'openai-codex' and task.get('model'):
            argv += ['--provider', 'openai-codex', '--model', str(task['model'])]
        if task.get('skills'):
            for skill in task['skills']:
                argv += ['--skill', str(skill)]
        argv.append(prompt)
        if self._cancellation_requested(task, task_id, attempt_key):
            self._consume_cancellation(task_id, attempt_key)
            raise RunnerCancelled(task_id)
        # When this run holds Prime's own lease for a resumed native session, the
        # child must not try to take the same lease and abort its own turn.
        child_env = build_child_env(
            "prime",
            overrides=(
                {PRIME_LEASE_ENABLED_ENV: "0"}
                if self._agent_paths.get(attempt_key) is not None else None
            ),
        )
        if self.isolation.enabled:
            # Confine the runtime child to the workspace, its own session state and a
            # private temp directory. A resumed native session binds that one session
            # file rather than the whole native session store, so the sandbox cannot
            # rewrite another session's transcript. Prime may write beside the file
            # (artifacts, caches); those writes fail closed here and a real provider
            # turn inside the profile has not been run, which is why the profile is
            # off by default.
            temp_root = self.session_root / session_id / "tmp"
            temp_root.mkdir(parents=True, exist_ok=True)
            writable = [agent_path if agent_session else session_dir, temp_root]
            argv = self.isolation.command(argv=argv, cwd=cwd, writable_roots=writable)
            child_env["TMPDIR"] = str(temp_root)
        process = await asyncio.create_subprocess_exec(
            *supervised_argv(argv), cwd=str(cwd), env=child_env, stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, start_new_session=True,
            # The supervisor keeps the lease if the backend is killed. The
            # native CLI is launched by the supervisor with close_fds=True.
            pass_fds=(lease.fileno(),),
        )
        identity: ProcessIdentity | None = None
        target_released = False
        try:
            identity = capture_process_identity(process)
            self._active[task_id] = process
            self._identities[task_id] = identity
            self._active_attempts[task_id] = attempt_key
            if self._cancellation_requested(task, task_id, attempt_key):
                self._consume_cancellation(task_id, attempt_key)
                raise RunnerCancelled(task_id)
            await release_supervised_target(process)
            # A failed release can leave byte delivery ambiguous, so only
            # select normal teardown after the helper has drained and closed it.
            target_released = True
            if self._active_attempts.get(task_id) == attempt_key:
                self._released_attempts[task_id] = attempt_key
            if self._cancellation_requested(task, task_id, attempt_key):
                self._consume_cancellation(task_id, attempt_key)
                raise RunnerCancelled(task_id)
            # Publish while still inside the cleanup guard. Let the child get
            # scheduled first so a failing event sink cannot interrupt process
            # startup before the runner can clean it up.
            session_event = asyncio.create_task(emit('session', {'session_id': session_id}))
            await asyncio.sleep(0.1)
            await session_event
        except BaseException as exc:
            try:
                if identity is not None:
                    try:
                        if target_released:
                            # Once the supervisor has released the native
                            # process, let it resume after terminating the
                            # process group so it can reap its child. The
                            # startup abort path deliberately kills a blocked
                            # supervisor and is only safe before release.
                            await terminate_process_tree(process, identity)
                        else:
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
        stderr: list[str] = []
        final_text = ''
        streamed_thinking: set[int] = set()

        def text_content(message: dict) -> str:
            return '\n'.join(str(item.get('text', '')) for item in message.get('content', []) if item.get('type') == 'text').strip()

        async def stdout_lines():
            pending = bytearray()
            while chunk := await process.stdout.read(_READ_CHUNK_SIZE):
                pending.extend(chunk)
                while (newline := pending.find(b'\n')) >= 0:
                    if newline > MAX_JSONL_RECORD_BYTES:
                        raise RuntimeError(
                            f"Prime JSONL record exceeds {MAX_JSONL_RECORD_BYTES} bytes"
                        )
                    yield bytes(pending[:newline])
                    del pending[:newline + 1]
                if len(pending) > MAX_JSONL_RECORD_BYTES:
                    raise RuntimeError(
                        f"Prime JSONL record exceeds {MAX_JSONL_RECORD_BYTES} bytes"
                    )
            if pending:
                yield bytes(pending)

        diagnostics = NativeEventDiagnostics('prime')
        handled_types = {
            'message_update', 'tool_execution_start', 'tool_execution_end', 'message_end', 'agent_end',
        }

        async def report_diagnostic(row: dict[str, Any] | None) -> None:
            if row is not None:
                await emit('diagnostic', row)

        async def pump_json() -> None:
            nonlocal final_text
            async for raw in stdout_lines():
                line = raw.decode(errors='replace').strip()
                if not line:
                    continue
                try:
                    event = __import__('json').loads(line)
                except ValueError:
                    # Never present an unstructured record as thought or as an outcome.
                    await report_diagnostic(diagnostics.note_malformed(f"line is not JSON ({len(line)} bytes)"))
                    continue
                if not isinstance(event, dict):
                    await report_diagnostic(diagnostics.note_malformed("record is not a JSON object"))
                    continue
        async def handle_event(event: dict) -> None:
            nonlocal final_text
            event_type = event.get('type')
            if event_type not in handled_types:
                await report_diagnostic(diagnostics.note_unknown(event_type))
            if event_type == 'message_update':
                update = event.get('assistantMessageEvent') or {}
                if not isinstance(update, dict):
                    raise TypeError('assistantMessageEvent is not an object')
                update_type = update.get('type')
                if update_type == 'text_delta':
                    delta = update.get('delta', '')
                    if isinstance(delta, str) and delta:
                        await emit('message.delta', {
                            'message_id': f'prime-reply-{task_id}',
                            'session_id': session_id,
                            'text': delta,
                        })
                elif update_type == 'text_end':
                    await emit('message.done', {
                        'message_id': f'prime-reply-{task_id}',
                        'session_id': session_id,
                    })
                elif update_type == 'thinking_delta':
                    index = int(update.get('contentIndex', 0))
                    delta = update.get('delta', '')
                    if isinstance(delta, str) and delta:
                        streamed_thinking.add(index)
                        await emit('output', {'text': delta})
                elif update_type == 'thinking_end':
                    message = event.get('message') or {}
                    if not isinstance(message, dict):
                        raise TypeError('message is not an object')
                    content = message.get('content') or []
                    if not isinstance(content, list):
                        raise TypeError('message content is not a list')
                    index = int(update.get('contentIndex', 0))
                    block = content[index] if 0 <= index < len(content) else None
                    thought = block.get('thinking', '') if isinstance(block, dict) else ''
                    # Older Prime versions may only emit thinking_end. Newer
                    # versions already streamed the block as thinking_delta.
                    if index not in streamed_thinking and str(thought).strip():
                        await emit('output', {'text': str(thought).strip()})
            elif event_type == 'tool_execution_start':
                args = event.get('args') or {}
                if not isinstance(args, dict):
                    raise TypeError('tool args are not an object')
                target = str(args.get('code') or args.get('path') or args.get('url') or '')
                await emit('tool', {'phase': 'start', 'id': str(event.get('toolCallId', '')), 'tool': str(event.get('toolName', 'tool')), 'target': target})
            elif event_type == 'tool_execution_end':
                result = event.get('result') or {}
                if not isinstance(result, dict):
                    raise TypeError('tool result is not an object')
                details = result.get('details') or {}
                details = details if isinstance(details, dict) else {}
                chunks = result.get('content') or []
                chunks = chunks if isinstance(chunks, list) else []
                detail = '\n'.join(str(chunk.get('text', '')) for chunk in chunks if isinstance(chunk, dict)).strip()
                if len(detail) > MAX_EVENT_TEXT:
                    room = MAX_EVENT_TEXT - len(_EVENT_TRUNCATION_MARKER)
                    detail = detail[:room] + _EVENT_TRUNCATION_MARKER
                await emit('tool', {
                    'phase': 'end', 'id': str(event.get('toolCallId', '')), 'tool': str(event.get('toolName', 'tool')),
                    'target': '', 'detail': detail, 'duration': (details.get('durationMs') or 0) / 1000,
                    'exit_code': 1 if event.get('isError') else 0,
                })
            elif event_type == 'message_end':
                message = event.get('message') or {}
                if not isinstance(message, dict):
                    raise TypeError('message is not an object')
                if message.get('role') == 'assistant':
                    text = text_content(message)
                    if text:
                        final_text = text
            elif event_type == 'agent_end':
                messages = event.get('messages') or []
                if not isinstance(messages, list):
                    raise TypeError('messages is not a list')
                for message in reversed(messages):
                    if not isinstance(message, dict):
                        continue
                    if message.get('role') == 'assistant':
                        text = text_content(message)
                        if text:
                            final_text = text
                            break

        async def pump_json() -> None:
            async for raw in stdout_lines():
                line = raw.decode(errors='replace').strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except ValueError:
                    # Never present an unstructured record as thought or as an outcome.
                    await report_diagnostic(diagnostics.note_malformed(f"line is not JSON ({len(line)} bytes)"))
                    continue
                if not isinstance(event, dict):
                    await report_diagnostic(diagnostics.note_malformed("record is not a JSON object"))
                    continue
                try:
                    await handle_event(event)
                except (AttributeError, TypeError, ValueError, IndexError, KeyError):
                    # A record whose fields have the wrong shape is a diagnostic too:
                    # reading it must never raise out of the stream reader.
                    await report_diagnostic(diagnostics.note_malformed(
                        f"record of type {event.get('type')!r} has an unexpected shape"
                    ))

        async def pump_stderr() -> None:
            while raw := await process.stderr.readline():
                stderr.append(raw.decode(errors='replace').rstrip('\r\n'))

        try:
            await asyncio.gather(pump_json(), pump_stderr())
            code = await process.wait()
        except BaseException:
            await terminate_process_tree(process, identity)
            raise
        finally:
            self._clear_active(task_id, attempt_key)
            identity.close()
        if self._cancellation_requested(task, task_id, attempt_key):
            self._consume_cancellation(task_id, attempt_key)
            raise RunnerCancelled(task_id)
        if code:
            raise RuntimeError('\n'.join(stderr[-50:]) or f'Prime exited with code {code}')
        if not final_text and diagnostics.malformed:
            # The runtime succeeded but part of its output could not be read at
            # all, so this turn has no verified answer. Fail closed instead of
            # reporting an empty completion. An unhandled record *type* is only a
            # diagnostic: the stream was readable, it simply carried nothing this
            # runner interprets.
            raise RuntimeError(
                f"Prime produced no readable answer ({diagnostics.malformed} malformed, "
                f"{diagnostics.unknown} unhandled records)"
            )
        return {'text': final_text, 'exit_code': code, 'session_id': session_id}

    async def cancel(self, task_id: str) -> bool:
        # Record intent before looking up the process. Startup can be between
        # spawn and _active registration; that window must not lose cancel.
        attempt_key = self._run_attempts.get(task_id, task_id)
        self._cancelled.add(attempt_key)
        process = self._active.get(task_id)
        if process is None or self._active_attempts.get(task_id) != attempt_key:
            return False
        released = self._released_attempts.get(task_id) == attempt_key
        identity = self._identities.get(task_id)
        if identity is None:
            return False
        await terminate_process_tree(process, identity)
        return released
