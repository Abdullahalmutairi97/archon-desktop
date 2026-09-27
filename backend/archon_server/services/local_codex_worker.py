"""Supervise the opt-in desktop-owned Codex JSONL worker.

This process boundary deliberately carries only the worker protocol. It does not
write Codex metadata, retry a started turn, or log request/response bodies.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from collections import deque
from pathlib import Path
from typing import Any

from ..local_codex_event_journal import LocalCodexEventJournal


MAX_WORKER_FRAME_BYTES = 128 * 1024
MAX_RETAINED_EVENTS = 256
MAX_IN_FLIGHT_REQUESTS = 32
MAX_SAFE_REQUEST_ID = (1 << 53) - 1
_METHODS = frozenset({
    "listProjects",
    "listSessions",
    "registerWorkspaceRoot",
    "startTurn",
    "cancelTurn",
    "answerApproval",
    "events",
})
_SAFE_ERROR_CODE = re.compile(r"^[a-z0-9_:-]{1,64}$")
_LOCAL_TASK_ID = re.compile(r"^codex-task:[A-Za-z0-9._:-]{1,245}$")
_LOCAL_PROJECT_ID = re.compile(r"^codex-project:[A-Za-z0-9._:-]{1,242}$")
_LOCAL_APPROVAL_ID = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
_TERMINAL_EVENTS = frozenset({"turn.completed", "turn.failed", "turn.cancelled"})


class LocalCodexWorkerError(RuntimeError):
    """Base error with a safe message suitable for an API response."""

    code = "local_codex_unavailable"
    public_message = "Local Codex is unavailable"


class LocalCodexWorkerUnavailable(LocalCodexWorkerError):
    pass


class LocalCodexOutcomeUnknown(LocalCodexWorkerUnavailable):
    code = "local_codex_outcome_unknown"
    public_message = "Local Codex start outcome is unknown; do not retry this turn"


class LocalCodexRequestRejected(LocalCodexWorkerError):
    code = "local_codex_request_rejected"
    public_message = "Local Codex rejected the request"

    def __init__(self, worker_code: str):
        self.worker_code = worker_code
        super().__init__(self.public_message)


class LocalCodexWorkerProtocolError(LocalCodexWorkerUnavailable):
    code = "local_codex_protocol_error"


class LocalCodexWorkerClient:
    """One supervised worker process with concurrent request/reply correlation."""

    def __init__(
        self,
        *,
        node_executable: str,
        worker_script: Path,
        metadata_root: Path,
        home_directory: Path,
        codex_home_directory: Path,
        codex_executable: Path | None = None,
        event_journal: LocalCodexEventJournal | None = None,
        request_timeout_seconds: float = 15.0,
        start_timeout_seconds: float = 60.0,
    ) -> None:
        self.node_executable = node_executable
        self.worker_script = worker_script.expanduser().resolve()
        self.metadata_root = metadata_root.expanduser().resolve()
        self.home_directory = home_directory.expanduser().resolve()
        self.codex_home_directory = codex_home_directory.expanduser().resolve()
        self.codex_executable = codex_executable.expanduser().resolve() if codex_executable else None
        self.event_journal = event_journal
        self.request_timeout_seconds = request_timeout_seconds
        self.start_timeout_seconds = start_timeout_seconds

        self._process: asyncio.subprocess.Process | None = None
        self._reader_task: asyncio.Task[None] | None = None
        self._pending: dict[int, tuple[str, asyncio.Future[Any]]] = {}
        self._write_lock = asyncio.Lock()
        self._state_lock = asyncio.Lock()
        self._next_id = 1
        self._failure: LocalCodexWorkerError | None = None
        self._closed = False
        self._events: deque[dict[str, Any]] = deque(maxlen=MAX_RETAINED_EVENTS)
        self._last_worker_event_sequence = 0
        self._last_public_event_sequence = 0
        self._active_turn_ids: set[str] = set()

    @property
    def pending_request_count(self) -> int:
        return len(self._pending)

    @property
    def running(self) -> bool:
        return self._process is not None and self._process.returncode is None and self._failure is None

    def events_after(self, sequence: int) -> list[dict[str, Any]]:
        """Return retained unsolicited events after a sequence for diagnostics/tests."""
        return [event for event in self._events if event["seq"] > sequence]

    async def start(self) -> None:
        async with self._state_lock:
            if self._closed:
                raise LocalCodexWorkerUnavailable()
            if self._process is not None:
                if self._process.returncode is None and self._failure is None:
                    return
                raise self._failure or LocalCodexWorkerUnavailable()

            argv = [
                self.node_executable,
                str(self.worker_script),
                "--metadata-root", str(self.metadata_root),
                "--home-directory", str(self.home_directory),
                "--codex-home-directory", str(self.codex_home_directory),
            ]
            if self.codex_executable is not None:
                argv.extend(("--codex-executable", str(self.codex_executable)))

            env = self._worker_environment()
            try:
                process = await asyncio.create_subprocess_exec(
                    *argv,
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    # Worker diagnostics can contain user data. Discard stderr
                    # rather than retaining it in service logs or API output.
                    stderr=asyncio.subprocess.DEVNULL,
                    cwd=str(self.home_directory),
                    env=env,
                    limit=MAX_WORKER_FRAME_BYTES + 1,
                )
            except (OSError, ValueError):
                self._failure = LocalCodexWorkerUnavailable()
                raise self._failure from None
            self._process = process
            self._reader_task = asyncio.create_task(self._read_stdout(), name="local-codex-worker-stdout")

    async def close(self) -> None:
        """Stop the worker owned by this backend process.

        Quitting the Electron window leaves this backend and its worker alive.
        Restarting the backend closes the worker process, so an active local turn
        is not guaranteed to survive a backend restart.
        """
        self._closed = True
        process = self._process
        if process is None:
            return
        if process.stdin is not None:
            try:
                process.stdin.close()
            except (BrokenPipeError, RuntimeError):
                pass
        if process.returncode is None:
            try:
                await asyncio.wait_for(process.wait(), timeout=2.0)
            except TimeoutError:
                try:
                    process.terminate()
                except ProcessLookupError:
                    pass
                try:
                    await asyncio.wait_for(process.wait(), timeout=2.0)
                except TimeoutError:
                    try:
                        process.kill()
                    except ProcessLookupError:
                        pass
                    await process.wait()
        reader = self._reader_task
        if reader is not None:
            try:
                await asyncio.wait_for(reader, timeout=1.0)
            except (TimeoutError, asyncio.CancelledError):
                reader.cancel()
                try:
                    await reader
                except asyncio.CancelledError:
                    pass
        self._mark_active_turns_unknown()
        self._fail_pending(LocalCodexWorkerUnavailable())

    async def request(self, method: str, params: dict[str, Any]) -> Any:
        if method not in _METHODS or not isinstance(params, dict):
            raise LocalCodexWorkerProtocolError()
        process = self._process
        if process is None or process.returncode is not None or self._failure is not None or self._closed:
            raise self._failure or LocalCodexWorkerUnavailable()
        if process.stdin is None:
            raise LocalCodexWorkerUnavailable()
        if len(self._pending) >= MAX_IN_FLIGHT_REQUESTS:
            raise LocalCodexRequestRejected("busy")

        if self._next_id > MAX_SAFE_REQUEST_ID:
            self._next_id = 1
        request_id = self._next_id
        while request_id in self._pending:
            request_id += 1
            if request_id > MAX_SAFE_REQUEST_ID:
                request_id = 1
        self._next_id = request_id + 1
        frame = self._encode_frame({"id": request_id, "method": method, "params": params})
        future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = (method, future)
        try:
            async with self._write_lock:
                if process.returncode is not None or self._failure is not None:
                    raise self._failure or LocalCodexWorkerUnavailable()
                process.stdin.write(frame)
                await asyncio.wait_for(process.stdin.drain(), timeout=min(self.request_timeout_seconds, 5.0))
        except (BrokenPipeError, ConnectionError, OSError, TimeoutError):
            self._pending.pop(request_id, None)
            if method == "startTurn":
                raise LocalCodexOutcomeUnknown() from None
            raise LocalCodexWorkerUnavailable() from None
        except LocalCodexWorkerError:
            self._pending.pop(request_id, None)
            raise

        timeout = self.start_timeout_seconds if method == "startTurn" else self.request_timeout_seconds
        try:
            return await asyncio.wait_for(asyncio.shield(future), timeout=timeout)
        except TimeoutError:
            self._pending.pop(request_id, None)
            if not future.done():
                future.cancel()
            if method == "startTurn":
                raise LocalCodexOutcomeUnknown() from None
            raise LocalCodexWorkerUnavailable() from None
        finally:
            self._pending.pop(request_id, None)

    async def _read_stdout(self) -> None:
        process = self._process
        reader = process.stdout if process is not None else None
        if reader is None:
            return
        failure: LocalCodexWorkerError = LocalCodexWorkerUnavailable()
        try:
            while True:
                try:
                    line = await reader.readline()
                except (ValueError, asyncio.LimitOverrunError):
                    failure = LocalCodexWorkerProtocolError()
                    break
                if not line:
                    break
                if len(line) > MAX_WORKER_FRAME_BYTES or not line.endswith(b"\n"):
                    failure = LocalCodexWorkerProtocolError()
                    break
                try:
                    message = json.loads(line.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    failure = LocalCodexWorkerProtocolError()
                    break
                try:
                    if self._consume_event(message):
                        continue
                    self._consume_reply(message)
                except LocalCodexWorkerProtocolError as exc:
                    failure = exc
                    break
        except asyncio.CancelledError:
            self._mark_active_turns_unknown()
            return
        except Exception:
            failure = LocalCodexWorkerUnavailable()
        self._mark_active_turns_unknown()
        self._failure = failure
        self._fail_pending(failure)

    def _consume_event(self, message: Any) -> bool:
        if not isinstance(message, dict) or "event" not in message:
            return False
        if set(message) != {"event"}:
            raise LocalCodexWorkerProtocolError()
        event = message["event"]
        if not isinstance(event, dict) or set(event) != {"seq", "event"}:
            raise LocalCodexWorkerProtocolError()
        sequence = event["seq"]
        if isinstance(sequence, bool) or not isinstance(sequence, int) or not 1 <= sequence <= MAX_SAFE_REQUEST_ID:
            raise LocalCodexWorkerProtocolError()
        if not isinstance(event["event"], dict):
            raise LocalCodexWorkerProtocolError()
        if sequence <= self._last_worker_event_sequence:
            # The event stream is ordered and monotonic. Duplicate delivery or
            # rollback makes cursor semantics unsafe, so retire this worker.
            raise LocalCodexWorkerProtocolError()
        payload = event["event"]
        if not _valid_local_codex_event(payload):
            raise LocalCodexWorkerProtocolError()
        if self.event_journal is None:
            public_sequence = sequence
        else:
            # The durable journal owns public sequence numbers, which continue
            # across worker restarts even when a fresh worker begins at seq 1.
            # Do not retain or acknowledge the event until the append commits.
            pending_start = any(method == "startTurn" for method, _future in self._pending.values())
            public_sequence = self.event_journal.append(
                payload,
                provisional_terminal=pending_start and payload.get("type") in _TERMINAL_EVENTS,
            )
            if (
                isinstance(public_sequence, bool)
                or not isinstance(public_sequence, int)
                or not 1 <= public_sequence <= MAX_SAFE_REQUEST_ID
                or public_sequence <= self._last_public_event_sequence
            ):
                raise LocalCodexWorkerProtocolError()
        self._last_worker_event_sequence = sequence
        self._last_public_event_sequence = public_sequence
        self._events.append({"seq": public_sequence, "event": payload})
        if payload.get("type") in _TERMINAL_EVENTS:
            self._active_turn_ids.discard(payload["taskId"])
        return True

    def _consume_reply(self, message: Any) -> None:
        if not isinstance(message, dict) or set(message) not in (
            {"id", "ok", "result"}, {"id", "ok", "error"},
        ):
            raise LocalCodexWorkerProtocolError()
        request_id = message["id"]
        if (
            isinstance(request_id, bool)
            or not isinstance(request_id, int)
            or not 1 <= request_id <= MAX_SAFE_REQUEST_ID
        ):
            raise LocalCodexWorkerProtocolError()
        pending = self._pending.get(request_id)
        if pending is None:
            # Late replies are expected after a bounded timeout. The request
            # has already been retired and must never be replayed.
            return
        method, future = pending
        if future.done():
            return
        if message["ok"] is True and "result" in message:
            result = message["result"]
            if method == "startTurn" and self.event_journal is not None:
                try:
                    status = self.event_journal.record_accepted_start(result)
                except (LocalCodexEventJournalError, ValueError):
                    # The native acknowledgement may represent a started turn,
                    # but without a durable identity we must not claim success
                    # or invite the caller to retry it.
                    future.set_exception(LocalCodexOutcomeUnknown())
                    return
                if status["state"] == "running":
                    self._active_turn_ids.add(status["taskId"])
            future.set_result(result)
            return
        if message["ok"] is False and "error" in message:
            error = message["error"]
            code = error.get("code") if isinstance(error, dict) else None
            safe_code = code if isinstance(code, str) and _SAFE_ERROR_CODE.fullmatch(code) else "worker_rejected"
            # Do not retain worker-provided prose: it may include a prompt or
            # user data. The HTTP surface uses only this opaque bounded code.
            if method == "startTurn":
                future.set_exception(LocalCodexOutcomeUnknown())
                return
            future.set_exception(LocalCodexRequestRejected(safe_code))
            return
        raise LocalCodexWorkerProtocolError()

    def _fail_pending(self, failure: LocalCodexWorkerError) -> None:
        for method, future in tuple(self._pending.values()):
            if future.done():
                continue
            if method == "startTurn":
                future.set_exception(LocalCodexOutcomeUnknown())
            else:
                future.set_exception(failure)

    def _mark_active_turns_unknown(self) -> None:
        task_ids = tuple(self._active_turn_ids)
        if not task_ids:
            return
        self._active_turn_ids.clear()
        if self.event_journal is None:
            return
        try:
            self.event_journal.mark_turns_outcome_unknown(task_ids)
        except (LocalCodexEventJournalError, ValueError):
            # Startup reconciliation retries the same one-way transition if
            # the journal could not be updated as this worker retired.
            pass

    @staticmethod
    def _encode_frame(value: dict[str, Any]) -> bytes:
        try:
            frame = json.dumps(value, ensure_ascii=True, separators=(",", ":")).encode("utf-8") + b"\n"
        except (TypeError, ValueError, UnicodeEncodeError):
            raise LocalCodexWorkerProtocolError() from None
        if len(frame) > MAX_WORKER_FRAME_BYTES:
            raise LocalCodexWorkerProtocolError()
        return frame

    def _worker_environment(self) -> dict[str, str]:
        # Do not leak the backend's bearer token or unrelated credentials into
        # the native worker. Provider authentication is read from CODEX_HOME.
        allowed = {
            "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TMP",
            "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
            "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
        }
        env = {key: value for key, value in os.environ.items() if key in allowed}
        env["HOME"] = str(self.home_directory)
        env["CODEX_HOME"] = str(self.codex_home_directory)
        return env


def _bounded_text(value: Any, maximum: int, *, allow_empty: bool = False) -> bool:
    if not isinstance(value, str) or (not allow_empty and not value) or "\x00" in value:
        return False
    try:
        # The renderer validates JavaScript strings by UTF-16 code units.
        return len(value.encode("utf-16-le")) // 2 <= maximum
    except UnicodeEncodeError:
        return False


def _canonical_absolute_path(value: Any) -> bool:
    if not _bounded_text(value, 16_000) or not value.startswith("/"):
        return False
    if any(ord(char) < 0x20 or 0x7F <= ord(char) <= 0x9F for char in value):
        return False
    if value == "/":
        return True
    if value.endswith("/"):
        return False
    return all(part not in ("", ".", "..") for part in value[1:].split("/"))


def _valid_local_approval(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    required = {"approvalId", "taskId", "projectId", "kind", "reason", "cwd", "paths"}
    if not required.issubset(value) or set(value) - (required | {"command", "changes"}):
        return False
    if (
        not isinstance(value.get("approvalId"), str)
        or not _LOCAL_APPROVAL_ID.fullmatch(value["approvalId"])
        or not isinstance(value.get("taskId"), str)
        or not _LOCAL_TASK_ID.fullmatch(value["taskId"])
        or not isinstance(value.get("projectId"), str)
        or not _LOCAL_PROJECT_ID.fullmatch(value["projectId"])
        or value.get("kind") not in ("command", "file")
        or not _bounded_text(value.get("reason"), 4096, allow_empty=True)
        or not _canonical_absolute_path(value.get("cwd"))
    ):
        return False
    paths = value.get("paths")
    if not isinstance(paths, list) or len(paths) > 64 or not all(_canonical_absolute_path(path) for path in paths):
        return False
    if value["kind"] == "command":
        return (
            "changes" not in value
            and not paths
            and _bounded_text(value.get("command"), 8000)
        )
    if "command" in value or not paths:
        return False
    changes = value.get("changes")
    if not isinstance(changes, list) or not 1 <= len(changes) <= 16:
        return False
    changed_paths: list[str] = []
    for change in changes:
        if not isinstance(change, dict) or set(change) - {"path", "kind", "diff", "movePath"}:
            return False
        if not {"path", "kind", "diff"}.issubset(change):
            return False
        if (
            not _canonical_absolute_path(change.get("path"))
            or change.get("kind") not in ("add", "delete", "update")
            or not _bounded_text(change.get("diff"), 16_000)
        ):
            return False
        diff = change["diff"]
        if any((ord(char) < 0x20 and char not in "\t\n\r") or ord(char) == 0x7F for char in diff):
            return False
        move_path = change.get("movePath")
        if "movePath" in change:
            if change["kind"] != "update" or not _canonical_absolute_path(move_path):
                return False
            changed_paths.extend((change["path"], move_path))
        else:
            changed_paths.append(change["path"])
    if len(set(changed_paths)) != len(changed_paths) or paths != changed_paths:
        return False
    try:
        return len(json.dumps(changes, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) <= 24 * 1024
    except (TypeError, ValueError, UnicodeEncodeError):
        return False


def _valid_local_codex_event(event: Any) -> bool:
    if not isinstance(event, dict):
        return False
    event_type = event.get("type")
    if event_type in ("turn.completed", "turn.cancelled"):
        valid = set(event) == {"type", "taskId"} and isinstance(event.get("taskId"), str) and bool(
            _LOCAL_TASK_ID.fullmatch(event["taskId"])
        )
    elif event_type == "turn.output":
        valid = (
            set(event) == {"type", "taskId", "text"}
            and isinstance(event.get("taskId"), str)
            and bool(_LOCAL_TASK_ID.fullmatch(event["taskId"]))
            and _bounded_text(event.get("text"), 8000, allow_empty=True)
        )
    elif event_type == "turn.failed":
        valid = (
            set(event) == {"type", "taskId", "message"}
            and isinstance(event.get("taskId"), str)
            and bool(_LOCAL_TASK_ID.fullmatch(event["taskId"]))
            and _bounded_text(event.get("message"), 512)
        )
    elif event_type == "approval.requested":
        valid = set(event) == {"type", "approval"} and _valid_local_approval(event.get("approval"))
    else:
        return False
    if not valid:
        return False
    try:
        return len(json.dumps(event, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) <= 64 * 1024
    except (TypeError, ValueError, UnicodeEncodeError):
        return False
