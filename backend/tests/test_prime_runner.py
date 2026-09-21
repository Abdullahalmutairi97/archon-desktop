import asyncio
import errno
import json
import multiprocessing
import os
import signal
from pathlib import Path

import pytest

import archon_server.hermes_runner as hermes_runner_module
import archon_server.prime_runner as prime_runner_module
from archon_server.hermes_runner import (
    ProcessIdentity,
    _process_info,
    capture_process_identity,
    terminate_process_tree,
)
from archon_server.prime_runner import PrimeRunner


async def _wait_for_path(path: Path, timeout: float = 2.0):
    deadline = asyncio.get_running_loop().time() + timeout
    while not path.exists() and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.01)
    assert path.exists(), f"Timed out waiting for {path}"



@pytest.mark.asyncio
async def test_prime_runner_streams_native_text_and_returns_session(tmp_path):
    executable = tmp_path / "fake-prime"
    args = tmp_path / "args"
    events = [
        {"type": "message_update", "assistantMessageEvent": {"type": "thinking_delta", "contentIndex": 0, "delta": "checking"}},
        {"type": "message_update", "assistantMessageEvent": {"type": "thinking_end", "contentIndex": 0}},
        {"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": "res"}},
        {"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": "ponse"}},
        {"type": "message_update", "assistantMessageEvent": {"type": "text_end"}},
        {"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": "response"}]}},
    ]
    lines = "\n".join(json.dumps(event) for event in events)
    executable.write_text(f"#!/bin/sh\nprintf '%s\n' \"$@\" > {args}\ncat <<'EOF'\n{lines}\nEOF\n")
    executable.chmod(0o755)
    emitted = []

    async def emit(kind, data):
        emitted.append((kind, data))

    result = await PrimeRunner(executable, tmp_path / "sessions", tmp_path).run(
        {"id": "task-1", "approval_mode": "auto", "prompt": "implement", "cwd": str(tmp_path)}, emit
    )

    assert result["text"] == "response"
    assert result["session_id"] == "prime-task-1"
    assert "--print" in args.read_text().splitlines()
    assert [data["text"] for kind, data in emitted if kind == "output"] == ["checking"]
    deltas = [data for kind, data in emitted if kind == "message.delta"]
    assert [data["text"] for data in deltas] == ["res", "ponse"]
    assert {data["session_id"] for data in deltas} == {"prime-task-1"}
    done = next(data for kind, data in emitted if kind == "message.done")
    assert done["session_id"] == "prime-task-1"


@pytest.mark.asyncio
async def test_prime_runner_resumes_native_agent_session_by_exact_id(tmp_path):
    executable = tmp_path / "fake-prime"
    args = tmp_path / "args"
    executable.write_text(
        f"#!/bin/sh\nprintf '%s\n' \"$@\" > {args}\n"
        "printf '%s\n' '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"continued\"}]}}'\n"
    )
    executable.chmod(0o755)
    agent_sessions = tmp_path / "agent-sessions"
    agent_sessions.mkdir()
    session_id = "01a0198a-557f-7211-b307-571850f70815"
    native_cwd = tmp_path / "native-project"
    native_cwd.mkdir()
    (agent_sessions / f"{session_id}.jsonl").write_text(
        json.dumps({"type": "session", "id": session_id, "cwd": str(native_cwd)}) + "\n"
    )

    async def emit(_kind, _data):
        pass

    result = await PrimeRunner(
        executable, tmp_path / "archon-sessions", tmp_path, agent_sessions
    ).run({"id": "task-2", "approval_mode": "auto", "prompt": "continue", "session_id": session_id}, emit)

    argv = args.read_text().splitlines()
    assert argv[argv.index("--resume") + 1] == session_id
    assert argv[argv.index("--cwd") + 1] == str(native_cwd)
    assert "--session-dir" not in argv
    assert "--continue" not in argv
    assert result == {"text": "continued", "exit_code": 0, "session_id": session_id}


@pytest.mark.asyncio
async def test_prime_runner_cancel_reaps_tool_children(tmp_path):
    executable = tmp_path / "fake-prime"
    parent_file = tmp_path / "parent.pid"
    child_file = tmp_path / "child.pid"
    executable.write_text(
        f"#!/usr/bin/env bash\nprintf '%s' \"$$\" > {parent_file}\n"
        f"sleep 60 &\nchild=$!\nprintf '%s' \"$child\" > {child_file}\nwait \"$child\"\n"
    )
    executable.chmod(0o755)
    runner = PrimeRunner(executable, tmp_path / "sessions", tmp_path, tmp_path / "agent-sessions")
    running = asyncio.create_task(runner.run({"id": "cancel-prime", "approval_mode": "auto", "prompt": "wait"}, lambda _kind, _data: asyncio.sleep(0)))
    for _ in range(100):
        if child_file.exists():
            break
        await asyncio.sleep(0.02)
    assert child_file.exists()
    parent_pid = int(parent_file.read_text())
    child_pid = int(child_file.read_text())

    assert await runner.cancel("cancel-prime") is True
    with pytest.raises(Exception) as cancelled:
        await running
    assert cancelled.value.__class__.__name__ == "RunnerCancelled"
    for pid in (parent_pid, child_pid):
        with pytest.raises(ProcessLookupError):
            os.kill(pid, 0)


@pytest.mark.asyncio
async def test_prime_runner_handles_tool_result_larger_than_previous_limit(tmp_path):
    executable = tmp_path / "fake-prime"
    oversized_detail = "x" * (17 * 1024 * 1024)
    events = [
        {
            "type": "tool_execution_end",
            "toolCallId": "large-tool",
            "toolName": "ipython",
            "result": {"content": [{"type": "text", "text": oversized_detail}]},
        },
        {
            "type": "message_end",
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": "finished"}],
            },
        },
    ]
    lines = "\n".join(json.dumps(event) for event in events)
    executable.write_text(f"#!/bin/sh\ncat <<'EOF'\n{lines}\nEOF\n")
    executable.chmod(0o755)
    emitted = []

    async def emit(kind, data):
        emitted.append((kind, data))

    result = await PrimeRunner(executable, tmp_path / "sessions", tmp_path).run(
        {"id": "large-result", "approval_mode": "auto", "prompt": "inspect"}, emit
    )

    assert result["text"] == "finished"
    tool_event = next(data for kind, data in emitted if kind == "tool")
    assert tool_event["detail"].endswith("…[truncated]")
    assert len(tool_event["detail"]) <= 4096


@pytest.mark.asyncio
async def test_prime_runner_terminates_process_when_event_handling_fails(tmp_path):
    executable = tmp_path / "fake-prime"
    pid_file = tmp_path / "prime.pid"
    event = json.dumps(
        {
            "type": "tool_execution_end",
            "toolCallId": "tool-1",
            "toolName": "ipython",
            "result": {"content": [{"type": "text", "text": "result"}]},
        }
    )
    executable.write_text(
        f"#!/usr/bin/env bash\nprintf '%s' \"$$\" > {pid_file}\n"
        f"printf '%s\n' '{event}'\nsleep 60\n"
    )
    executable.chmod(0o755)

    async def broken_emit(_kind, _data):
        await _wait_for_path(pid_file)
        raise RuntimeError("event store unavailable")

    runner = PrimeRunner(executable, tmp_path / "sessions", tmp_path)
    try:
        with pytest.raises(RuntimeError, match="event store unavailable"):
            await runner.run({"id": "emit-failure", "approval_mode": "auto", "prompt": "inspect"}, broken_emit)

        await _wait_for_path(pid_file)
        pid = int(pid_file.read_text())
        with pytest.raises(ProcessLookupError):
            os.kill(pid, 0)
    finally:
        if pid_file.exists():
            try:
                os.killpg(int(pid_file.read_text()), signal.SIGKILL)
            except ProcessLookupError:
                pass


@pytest.mark.asyncio
async def test_prime_runner_rejects_record_over_configured_memory_bound(tmp_path, monkeypatch):
    executable = tmp_path / "fake-prime"
    executable.write_text(
        "#!/usr/bin/env python3\n"
        "import sys\n"
        "sys.stdout.write('x' * 2048)\n"
    )
    executable.chmod(0o755)
    monkeypatch.setattr(prime_runner_module, "MAX_JSONL_RECORD_BYTES", 1024, raising=False)

    async def emit(_kind, _data):
        pass

    with pytest.raises(RuntimeError, match="Prime JSONL record exceeds 1024 bytes"):
        await PrimeRunner(executable, tmp_path / "sessions", tmp_path).run(
            {"id": "oversized-record", "approval_mode": "auto", "prompt": "inspect"}, emit
        )


@pytest.mark.asyncio
async def test_process_cleanup_reaps_descendant_forked_during_sigterm(tmp_path):
    executable = tmp_path / "fake-prime"
    child_script = tmp_path / "fork-on-term.py"
    ready_file = tmp_path / "child.ready"
    late_file = tmp_path / "late.pid"
    parent_file = tmp_path / "parent.pid"
    child_script.write_text(
        "import signal, subprocess, sys, time\n"
        f"ready = {str(ready_file)!r}\n"
        f"late = {str(late_file)!r}\n"
        "def on_term(_signum, _frame):\n"
        "    spawned = subprocess.Popen(['sleep', '60'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\n"
        "    open(late, 'w').write(str(spawned.pid))\n"
        "    sys.exit(0)\n"
        "signal.signal(signal.SIGTERM, on_term)\n"
        "open(ready, 'w').write('ready')\n"
        "while True: time.sleep(1)\n"
    )
    event = json.dumps(
        {
            "type": "tool_execution_end",
            "toolCallId": "tool-1",
            "toolName": "ipython",
            "result": {"content": [{"type": "text", "text": "result"}]},
        }
    )
    executable.write_text(
        f"#!/usr/bin/env bash\nprintf '%s' \"$$\" > {parent_file}\n"
        f"python3 {child_script} &\n"
        f"while [ ! -f {ready_file} ]; do sleep 0.01; done\n"
        f"printf '%s\n' '{event}'\nsleep 60\n"
    )
    executable.chmod(0o755)

    async def broken_emit(_kind, _data):
        await _wait_for_path(ready_file)
        raise RuntimeError("event store unavailable")

    try:
        runner = PrimeRunner(executable, tmp_path / "sessions", tmp_path)
        with pytest.raises(RuntimeError, match="event store unavailable"):
            await runner.run({"id": "late-fork", "approval_mode": "auto", "prompt": "inspect"}, broken_emit)

        await _wait_for_path(late_file)
        late_pid = int(late_file.read_text())
        with pytest.raises(ProcessLookupError):
            os.kill(late_pid, 0)
    finally:
        if parent_file.exists():
            try:
                os.killpg(int(parent_file.read_text()), signal.SIGKILL)
            except ProcessLookupError:
                pass


def test_process_info_accepts_non_utf8_linux_process_name(monkeypatch):
    fields = [b"S", b"1", b"77", b"77"] + [b"0"] * 15 + [b"999"]
    raw_stat = b"123 (name-\xff) " + b" ".join(fields)

    def undecodable_text(_path):
        raise UnicodeDecodeError("utf-8", b"\xff", 0, 1, "invalid start byte")

    monkeypatch.setattr(Path, "read_text", undecodable_text)
    monkeypatch.setattr(Path, "read_bytes", lambda _path: raw_stat)

    assert _process_info(123) == ("S", 77, "999")


@pytest.mark.asyncio
async def test_process_cleanup_kills_leader_when_pidfd_stop_fails(monkeypatch):
    stopped = asyncio.Event()

    class FakeProcess:
        pid = 123
        returncode = None
        stdout = None
        stderr = None

        async def wait(self):
            await stopped.wait()
            self.returncode = 0
            return 0

    async def unexpected_group_scan(*_args, **_kwargs):
        pytest.fail("unanchored process group must not be scanned")

    process = FakeProcess()
    identity = ProcessIdentity(pid=123, pgid=123, start_time="original", pidfd=os.open("/dev/null", os.O_RDONLY))
    sent = []

    def safe_signal(sig):
        sent.append(sig)
        if sig == signal.SIGKILL:
            stopped.set()
            return True
        return False

    identity.send = safe_signal
    monkeypatch.setattr(hermes_runner_module, "_stop_group_members", unexpected_group_scan)
    try:
        await asyncio.wait_for(terminate_process_tree(process, identity), timeout=0.5)
        assert sent == [signal.SIGSTOP, signal.SIGKILL]
    finally:
        identity.close()


def test_capture_process_identity_opens_pidfd_before_reading_proc(monkeypatch):
    class FakeProcess:
        pid = 123
        returncode = None

    calls = []
    pidfd = os.open("/dev/null", os.O_RDONLY)

    def open_pidfd(_pid):
        calls.append("pidfd")
        return pidfd

    def process_info(_pid):
        calls.append("proc")
        return ("S", 123, "original")

    monkeypatch.setattr(os, "pidfd_open", open_pidfd)
    monkeypatch.setattr(signal, "pidfd_send_signal", lambda _fd, _sig: None)
    monkeypatch.setattr(hermes_runner_module, "_process_info", process_info)
    identity = capture_process_identity(FakeProcess())
    try:
        assert calls == ["pidfd", "proc"]
    finally:
        identity.close()


@pytest.mark.asyncio
async def test_prime_runner_reaps_child_that_emits_after_target_exits(tmp_path):
    executable = tmp_path / "fake-prime"
    child_file = tmp_path / "child.pid"
    event = json.dumps(
        {
            "type": "tool_execution_end",
            "toolCallId": "late-tool",
            "toolName": "ipython",
            "result": {"content": [{"type": "text", "text": "late"}]},
        }
    )
    executable.write_text(
        "#!/usr/bin/env bash\n"
        f"( sleep 0.2; printf '%s\n' '{event}'; sleep 60 ) &\n"
        f"printf '%s' \"$!\" > {child_file}\n"
        "exit 0\n"
    )
    executable.chmod(0o755)

    async def broken_emit(_kind, _data):
        await _wait_for_path(child_file)
        raise RuntimeError("event store unavailable")

    try:
        runner = PrimeRunner(executable, tmp_path / "sessions", tmp_path)
        with pytest.raises(RuntimeError, match="event store unavailable"):
            await runner.run({"id": "late-child-output", "approval_mode": "auto", "prompt": "inspect"}, broken_emit)

        # The shell may publish the background PID just after the target exits.
        # Wait briefly for that handoff instead of racing the child setup.
        for _ in range(50):
            if child_file.exists():
                break
            await asyncio.sleep(0.01)
        assert child_file.exists()
        child_pid = int(child_file.read_text())
        with pytest.raises(ProcessLookupError):
            os.kill(child_pid, 0)
    finally:
        if child_file.exists():
            try:
                os.kill(int(child_file.read_text()), signal.SIGKILL)
            except ProcessLookupError:
                pass


@pytest.mark.asyncio
async def test_prime_runner_aborts_supervisor_before_target_when_identity_capture_fails(tmp_path, monkeypatch):
    executable = tmp_path / "fake-prime"
    target_started = tmp_path / "target-started"
    executable.write_text(
        f"#!/usr/bin/env bash\nprintf 'started' > {target_started}\nsleep 60\n"
    )
    executable.chmod(0o755)

    def fail_capture(_process):
        raise OSError(errno.EMFILE, "too many open files")

    monkeypatch.setattr(prime_runner_module, "capture_process_identity", fail_capture)
    runner = PrimeRunner(executable, tmp_path / "sessions", tmp_path)
    with pytest.raises(OSError, match="too many open files"):
        await asyncio.wait_for(
            runner.run({"id": "pidfd-failure", "approval_mode": "auto", "prompt": "inspect"}, lambda _kind, _data: asyncio.sleep(0)),
            timeout=2,
        )

    assert not target_started.exists()


@pytest.mark.asyncio
async def test_prime_runner_aborts_without_resuming_after_release_failure(tmp_path, monkeypatch):
    executable = tmp_path / "fake-prime"
    target_pid_file = tmp_path / "target.pid"
    executable.write_text(
        f"#!/usr/bin/env bash\nprintf '%s' \"$$\" > {target_pid_file}\nsleep 60\n"
    )
    executable.chmod(0o755)

    async def fail_after_queueing_release(process):
        process.stdin.write(b"1")
        raise RuntimeError("release failed")

    monkeypatch.setattr(prime_runner_module, "release_supervised_target", fail_after_queueing_release)
    runner = PrimeRunner(executable, tmp_path / "sessions", tmp_path)
    with pytest.raises(RuntimeError, match="release failed"):
        await asyncio.wait_for(
            runner.run({"id": "release-failure", "approval_mode": "auto", "prompt": "inspect"}, lambda _kind, _data: asyncio.sleep(0)),
            timeout=4,
        )

    if target_pid_file.exists():
        with pytest.raises(ProcessLookupError):
            os.kill(int(target_pid_file.read_text()), 0)


def test_agent_session_path_ignores_non_object_records(tmp_path):
    from archon_server.prime_runner import PrimeRunner

    sessions = tmp_path / "sessions"
    sessions.mkdir()
    artifacts = tmp_path / "session-artifacts" / "parent"
    artifacts.mkdir(parents=True)
    path = artifacts / "child.jsonl"
    path.write_text("[1]\n{\"type\": \"session\", \"id\": \"wanted\"}\n")
    runner = PrimeRunner(tmp_path / "prime", agent_session_root=sessions)

    assert runner._agent_session_path("wanted") == path


@pytest.mark.asyncio
async def test_same_session_runs_serialize_but_distinct_sessions_overlap(tmp_path):
    from archon_server.prime_runner import PrimeRunner

    runner = PrimeRunner(tmp_path / "prime", tmp_path / "sessions", tmp_path, tmp_path / "agent-sessions")
    active = 0
    maximum = 0

    async def fake_run(task, emit, lease):
        nonlocal active, maximum
        active += 1
        maximum = max(maximum, active)
        await asyncio.sleep(0.02)
        active -= 1
        return {"id": task["id"]}

    runner._run_once = fake_run
    same = [{"id": "one", "approval_mode": "auto", "session_id": "shared"}, {"id": "two", "approval_mode": "auto", "session_id": "shared"}]
    await asyncio.gather(*(runner.run(task, None) for task in same))
    assert maximum == 1

    maximum = 0
    distinct = [{"id": "a", "approval_mode": "auto", "session_id": "a"}, {"id": "b", "approval_mode": "auto", "session_id": "b"}]
    await asyncio.gather(*(runner.run(task, None) for task in distinct))
    assert maximum == 2


def _cross_process_prime_worker(root, active, maximum):
    from archon_server.prime_runner import PrimeRunner
    async def go():
        runner = PrimeRunner(Path(root) / "prime", Path(root) / "sessions", Path(root), Path(root) / "agent-sessions")
        async def fake(task, emit, lease):
            with active.get_lock():
                active.value += 1
                maximum.value = max(maximum.value, active.value)
            await asyncio.sleep(0.05)
            with active.get_lock(): active.value -= 1
        runner._run_once = fake
        await runner.run({"id": "task", "approval_mode": "auto", "session_id": "shared"}, None)
    asyncio.run(go())


def test_cross_process_session_runs_serialize(tmp_path):
    active = multiprocessing.Value("i", 0)
    maximum = multiprocessing.Value("i", 0)
    processes = [multiprocessing.Process(target=_cross_process_prime_worker, args=(str(tmp_path), active, maximum)) for _ in range(2)]
    for process in processes: process.start()
    for process in processes: process.join()
    assert all(process.exitcode == 0 for process in processes)
    assert maximum.value == 1
