from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from pathlib import Path
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


def _process_start_identity(pid: int) -> str | None:
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().split()
        return fields[21] if len(fields) > 21 else None
    except (OSError, ValueError):
        return None


def _owner_alive(pid: int, start: str) -> bool:
    try:
        os.kill(pid, 0)
    except (ProcessLookupError, PermissionError):
        return False
    except OSError:
        return False
    return bool(start) and _process_start_identity(pid) == start


async def _acquire_session_lease(root: Path, session_id: str, timeout: float = 30.0):
    lease = root / f".{session_id}.lock"
    root.mkdir(parents=True, exist_ok=True)
    owner = {"pid": os.getpid(), "start": _process_start_identity(os.getpid()) or "", "token": uuid.uuid4().hex}
    deadline = time.monotonic() + timeout
    while True:
        try:
            lease.mkdir()
            (lease / "owner.json").write_text(json.dumps(owner), encoding="utf-8")
            return lease, owner["token"]
        except FileExistsError:
            try:
                current = json.loads((lease / "owner.json").read_text(encoding="utf-8"))
                dead = not _owner_alive(int(current.get("pid", -1)), str(current.get("start", "")))
            except (OSError, ValueError, TypeError, json.JSONDecodeError):
                dead = False
            if dead:
                try: lease.rmdir()
                except OSError: pass
                continue
            if time.monotonic() >= deadline:
                raise RuntimeError(f"Timed out waiting for session lease: {session_id}")
            await asyncio.sleep(0.05)


def _release_session_lease(lease: Path, token: str) -> None:
    try:
        owner = json.loads((lease / "owner.json").read_text(encoding="utf-8"))
        if owner.get("token") != token: return
        (lease / "owner.json").unlink(missing_ok=True)
        lease.rmdir()
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return


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
    ):
        self.executable = Path(executable)
        self.session_root = Path(session_root or (Path.home() / '.local/share/archon-desktop/prime-sessions'))
        self.default_cwd = Path(default_cwd or Path.home())
        self.agent_session_root = Path(agent_session_root or (Path.home() / '.prime/agent/sessions'))
        self._active: dict[str, asyncio.subprocess.Process] = {}
        self._identities: dict[str, ProcessIdentity] = {}
        self._cancelled: set[str] = set()
        # Prime permits only one active process per native session.
        self._session_locks: dict[str, asyncio.Lock] = {}

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
        session_id = str(task.get("session_id") or f"prime-{task['id']}")
        if not session_id or any(char not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-' for char in session_id):
            raise ValueError('Invalid session id')
        lock = self._session_locks.setdefault(session_id, asyncio.Lock())
        async with lock:
            lease, token = await _acquire_session_lease(self.session_root, session_id)
            try:
                return await self._run_once(task, emit)
            finally:
                _release_session_lease(lease, token)

    async def _run_once(self, task: dict, emit) -> dict:
        """Run Prime in its structured JSON mode.

        Text mode writes the final reply to stdout. Treating stdout as live
        activity made the desktop place a second copy of the answer in the
        thought-process panel. JSON mode separates genuine thinking/tool events
        from the final assistant text, so only actual work appears in that panel.
        """
        task_id = str(task['id'])
        session_id = str(task.get('session_id') or f'prime-{task_id}')
        if not session_id or any(char not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-' for char in session_id):
            raise ValueError('Invalid session id')
        # Sessions started in Prime Agent's CLI/TUI are single JSONL files in its
        # native store. Resume those by exact id; Archon-owned sessions continue
        # to use their isolated per-session directories.
        agent_path = self._agent_session_path(session_id) if task.get('session_id') else None
        agent_session = agent_path is not None
        session_dir = self.session_root / session_id
        if not agent_session:
            session_dir.mkdir(parents=True, exist_ok=True)
        prompt = task['prompt']
        mode = task.get('approval_mode') or 'auto'
        if mode == 'plan':
            prompt = 'Planning only: do not edit files or run destructive commands. Return an actionable implementation plan.\n\n' + prompt
        elif mode == 'approve':
            prompt = 'Do not perform destructive or production actions without explicit approval. Explain proposed actions first.\n\n' + prompt
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
        requested_cwd = Path(str(saved_cwd or self.default_cwd))
        cwd = requested_cwd if requested_cwd.is_dir() else self.default_cwd
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
        process = await asyncio.create_subprocess_exec(
            *supervised_argv(argv), cwd=str(cwd), env=os.environ.copy(), stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, start_new_session=True,
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
            # Publish while still inside the cleanup guard. Let the child get
            # scheduled first so a failing event sink cannot interrupt process
            # startup before the runner can clean it up.
            session_event = asyncio.create_task(emit('session', {'session_id': session_id}))
            await asyncio.sleep(0.1)
            await session_event
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

        async def pump_json() -> None:
            nonlocal final_text
            async for raw in stdout_lines():
                line = raw.decode(errors='replace').strip()
                try:
                    event = __import__('json').loads(line)
                except ValueError:
                    # Never present an unstructured final reply as thought.
                    continue
                event_type = event.get('type')
                if event_type == 'message_update':
                    update = event.get('assistantMessageEvent') or {}
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
                        content = event.get('message', {}).get('content', [])
                        index = int(update.get('contentIndex', 0))
                        thought = content[index].get('thinking', '') if index < len(content) else ''
                        # Older Prime versions may only emit thinking_end. Newer
                        # versions already streamed the block as thinking_delta.
                        if index not in streamed_thinking and str(thought).strip():
                            await emit('output', {'text': str(thought).strip()})
                elif event_type == 'tool_execution_start':
                    args = event.get('args') or {}
                    target = str(args.get('code') or args.get('path') or args.get('url') or '')
                    await emit('tool', {'phase': 'start', 'id': str(event.get('toolCallId', '')), 'tool': str(event.get('toolName', 'tool')), 'target': target})
                elif event_type == 'tool_execution_end':
                    result = event.get('result') or {}
                    details = result.get('details') or {}
                    chunks = result.get('content') or []
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
                    if message.get('role') == 'assistant':
                        text = text_content(message)
                        if text:
                            final_text = text
                elif event_type == 'agent_end':
                    for message in reversed(event.get('messages') or []):
                        if message.get('role') == 'assistant':
                            text = text_content(message)
                            if text:
                                final_text = text
                                break

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
            self._active.pop(task_id, None)
            self._identities.pop(task_id, None)
            identity.close()
        if task_id in self._cancelled:
            self._cancelled.discard(task_id)
            raise RunnerCancelled(task_id)
        if code:
            raise RuntimeError('\n'.join(stderr[-50:]) or f'Prime exited with code {code}')
        return {'text': final_text, 'exit_code': code, 'session_id': session_id}

    async def cancel(self, task_id: str) -> bool:
        # Record intent before looking up the process. Startup can be between
        # spawn and _active registration; that window must not lose cancel.
        self._cancelled.add(task_id)
        process = self._active.get(task_id)
        if process is None: return False
        identity = self._identities.get(task_id)
        if identity is None:
            return False
        await terminate_process_tree(process, identity)
        return True
