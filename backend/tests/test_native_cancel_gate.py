import asyncio
import json
import os
import signal
import sys
from pathlib import Path

import pytest

from archon_server import pi_runner as pi_module
from archon_server import prime_runner as prime_module
from archon_server.hermes_runner import RunnerCancelled
from archon_server.pi_runner import PiRunner
from archon_server.prime_runner import PrimeRunner


def _write_python(path: Path, body: str) -> Path:
    path.write_text(f"#!{sys.executable}\n{body}")
    path.chmod(0o755)
    return path


async def _emit(_kind, _data):
    return None


@pytest.mark.asyncio
async def test_prime_cancel_while_waiting_for_session_lease_aborts_without_launch(tmp_path):
    marker = tmp_path / "target-started"
    executable = _write_python(
        tmp_path / "fake-prime",
        f"import pathlib, time\npathlib.Path({str(marker)!r}).write_text('started')\ntime.sleep(60)\n",
    )
    runner = PrimeRunner(executable, tmp_path / "sessions", tmp_path)
    lease = await prime_module._acquire_session_lease(tmp_path / "sessions", "shared")
    task = asyncio.create_task(
        runner.run(
            {"id": "lease-cancel", "session_id": "shared", "approval_mode": "auto", "prompt": "fixture"},
            _emit,
        )
    )
    try:
        await asyncio.sleep(0.02)
        assert await runner.cancel("lease-cancel") is False
        with pytest.raises(RunnerCancelled):
            await asyncio.wait_for(task, timeout=1)
        assert not marker.exists()
    finally:
        prime_module._release_session_lease(lease)
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_prime_attempt_invalidation_while_waiting_for_session_lease_closes_fd(tmp_path, monkeypatch):
    marker = tmp_path / "target-started"
    executable = _write_python(
        tmp_path / "fake-prime",
        f"import pathlib, time\npathlib.Path({str(marker)!r}).write_text('started')\ntime.sleep(60)\n",
    )
    sessions = tmp_path / "sessions"
    runner = PrimeRunner(executable, sessions, tmp_path)
    holder = await prime_module._acquire_session_lease(sessions, "shared")
    lock_path = sessions / ".shared.lock"
    original_inode = lock_path.stat().st_ino
    attempt_active = {"value": True}
    lock_contended = asyncio.Event()
    original_flock = prime_module.fcntl.flock

    def observed_flock(fd, operation):
        try:
            return original_flock(fd, operation)
        except BlockingIOError:
            lock_contended.set()
            raise

    task = asyncio.create_task(
        runner.run(
            {
                "id": "predicate-lease-cancel",
                "session_id": "shared",
                "current_attempt_id": "lease-attempt",
                "_attempt_active": lambda: attempt_active["value"],
                "approval_mode": "auto",
                "prompt": "fixture",
            },
            _emit,
        )
    )
    try:
        with monkeypatch.context() as patch:
            patch.setattr(prime_module.fcntl, "flock", observed_flock)
            await asyncio.wait_for(lock_contended.wait(), timeout=2)
            attempt_active["value"] = False
            with pytest.raises(RunnerCancelled):
                await asyncio.wait_for(task, timeout=1)
        assert not marker.exists()
        assert lock_path.stat().st_ino == original_inode
    finally:
        prime_module._release_session_lease(holder)
        await asyncio.gather(task, return_exceptions=True)

    successor = await prime_module._acquire_session_lease(sessions, "shared", timeout=0.2)
    try:
        assert lock_path.stat().st_ino == original_inode
    finally:
        prime_module._release_session_lease(successor)


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["prime", "pi"])
async def test_cancel_while_supervisor_is_ready_aborts_before_target_release(tmp_path, monkeypatch, kind):
    marker = tmp_path / f"{kind}-target-started"
    executable = _write_python(
        tmp_path / f"fake-{kind}",
        f"import pathlib, time\npathlib.Path({str(marker)!r}).write_text('started')\ntime.sleep(60)\n",
    )
    module = prime_module if kind == "prime" else pi_module
    original_release = module.release_supervised_target
    supervisor_ready = asyncio.Event()
    allow_release = asyncio.Event()

    async def gated_release(process):
        supervisor_ready.set()
        await allow_release.wait()
        await original_release(process)

    monkeypatch.setattr(module, "release_supervised_target", gated_release)
    if kind == "prime":
        runner = PrimeRunner(executable, tmp_path / "prime-sessions", tmp_path)
    else:
        runner = PiRunner(executable, tmp_path / "pi-sessions", tmp_path)
    task_id = f"{kind}-ready-cancel"
    running = asyncio.create_task(
        runner.run({"id": task_id, "approval_mode": "auto", "prompt": "fixture"}, _emit)
    )
    try:
        await asyncio.wait_for(supervisor_ready.wait(), timeout=2)
        # The captured supervisor must be cancellable while it still waits on
        # its startup pipe.
        assert task_id in runner._active
        result = runner.cancel(task_id)
        if asyncio.iscoroutine(result):
            await result
        allow_release.set()
        with pytest.raises(RunnerCancelled):
            await asyncio.wait_for(running, timeout=2)
        assert not marker.exists()
        assert task_id not in runner._active
        assert task_id not in runner._identities
    finally:
        allow_release.set()
        if not running.done():
            result = runner.cancel(task_id)
            if asyncio.iscoroutine(result):
                await result
        await asyncio.gather(running, return_exceptions=True)
        if marker.exists():
            try:
                os.kill(int(marker.read_text()), signal.SIGKILL)
            except (ValueError, ProcessLookupError):
                pass


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["prime", "pi"])
async def test_attempt_invalidation_after_supervisor_spawn_reaps_before_release(tmp_path, monkeypatch, kind):
    target_marker = tmp_path / f"{kind}-cancelled-target"
    later_marker = tmp_path / f"{kind}-later-target"
    executable = _write_python(
        tmp_path / f"fake-{kind}",
        "import json, pathlib, sys, time\n"
        f"target = pathlib.Path({str(target_marker)!r})\n"
        f"later = pathlib.Path({str(later_marker)!r})\n"
        "if sys.argv[-1] == 'blocked':\n"
        "    target.write_text('started')\n"
        "    time.sleep(60)\n"
        "else:\n"
        "    later.write_text('started')\n"
        "    print(json.dumps({'type': 'agent_end', 'messages': []}), flush=True)\n",
    )
    module = prime_module if kind == "prime" else pi_module
    original_create = module.asyncio.create_subprocess_exec
    supervisor_created = asyncio.Event()
    return_from_spawn = asyncio.Event()
    supervisors = []

    async def gated_create(*args, **kwargs):
        process = await original_create(*args, **kwargs)
        supervisors.append(process)
        supervisor_created.set()
        await return_from_spawn.wait()
        return process

    runner = (
        PrimeRunner(executable, tmp_path / "prime-sessions", tmp_path)
        if kind == "prime"
        else PiRunner(executable, tmp_path / "pi-sessions", tmp_path)
    )
    attempt_active = {"value": True}
    task_id = f"{kind}-spawned-cancel"
    blocked = {
        "id": task_id,
        "current_attempt_id": f"{kind}-attempt",
        "_attempt_active": lambda: attempt_active["value"],
        "approval_mode": "auto",
        "prompt": "blocked",
    }
    running = None
    try:
        with monkeypatch.context() as patch:
            patch.setattr(module.asyncio, "create_subprocess_exec", gated_create)
            running = asyncio.create_task(runner.run(blocked, _emit))
            await asyncio.wait_for(supervisor_created.wait(), timeout=2)
            assert task_id not in runner._active
            assert task_id not in runner._identities
            attempt_active["value"] = False
            return_from_spawn.set()
            with pytest.raises(RunnerCancelled):
                await asyncio.wait_for(running, timeout=2)

        assert len(supervisors) == 1
        assert supervisors[0].returncode is not None
        assert not target_marker.exists()
        assert task_id not in runner._active
        assert task_id not in runner._identities
        assert task_id not in runner._active_attempts
        assert task_id not in runner._run_attempts
        assert not runner._cancelled

        later = {
            "id": f"{kind}-later-task",
            "current_attempt_id": f"{kind}-later-attempt",
            "_attempt_active": lambda: True,
            "approval_mode": "auto",
            "prompt": "later",
        }
        await asyncio.wait_for(runner.run(later, _emit), timeout=2)
        assert later_marker.exists()
    finally:
        return_from_spawn.set()
        if running is not None and not running.done():
            await asyncio.gather(running, return_exceptions=True)
        for process in supervisors:
            if process.returncode is None:
                process.kill()
                await process.wait()


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["prime", "pi"])
async def test_active_native_cancel_waits_for_process_tree_teardown(tmp_path, kind):
    marker = tmp_path / f"{kind}-target.pid"
    executable = _write_python(
        tmp_path / f"fake-{kind}",
        f"import os, pathlib, time\npathlib.Path({str(marker)!r}).write_text(str(os.getpid()))\ntime.sleep(60)\n",
    )
    runner = (
        PrimeRunner(executable, tmp_path / "prime-sessions", tmp_path)
        if kind == "prime"
        else PiRunner(executable, tmp_path / "pi-sessions", tmp_path)
    )
    task_id = f"{kind}-active-cancel"
    running = asyncio.create_task(
        runner.run({"id": task_id, "approval_mode": "auto", "prompt": "fixture"}, _emit)
    )
    try:
        for _ in range(200):
            if marker.exists():
                break
            await asyncio.sleep(0.01)
        assert marker.exists()
        native_pid = int(marker.read_text())
        result = runner.cancel(task_id)
        if asyncio.iscoroutine(result):
            await result
        with pytest.raises(RunnerCancelled):
            await asyncio.wait_for(running, timeout=3)
        with pytest.raises(ProcessLookupError):
            os.kill(native_pid, 0)
        assert task_id not in runner._active
        assert task_id not in runner._identities
    finally:
        if not running.done():
            result = runner.cancel(task_id)
            if asyncio.iscoroutine(result):
                await result
            await asyncio.gather(running, return_exceptions=True)
        if marker.exists():
            try:
                os.kill(int(marker.read_text()), signal.SIGKILL)
            except ProcessLookupError:
                pass


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["prime", "pi"])
async def test_inactive_attempt_cannot_launch_and_does_not_poison_later_task(tmp_path, kind):
    marker = tmp_path / f"{kind}-target-started"
    executable = _write_python(
        tmp_path / f"fake-{kind}",
        f"import json, pathlib\npathlib.Path({str(marker)!r}).write_text('started')\n"
        "print(json.dumps({'type': 'agent_end', 'messages': []}), flush=True)\n",
    )
    runner = (
        PrimeRunner(executable, tmp_path / "prime-sessions", tmp_path)
        if kind == "prime"
        else PiRunner(executable, tmp_path / "pi-sessions", tmp_path)
    )
    inactive = {
        "id": f"{kind}-cancelled-attempt",
        "current_attempt_id": "attempt-old",
        "_attempt_active": lambda: False,
        "approval_mode": "auto",
        "prompt": "fixture",
    }
    result = runner.cancel(inactive["id"])
    if asyncio.iscoroutine(result):
        await result
    with pytest.raises(RunnerCancelled):
        await runner.run(inactive, _emit)
    assert not marker.exists()
    assert inactive["id"] not in runner._cancelled

    public_cancel_id = f"{kind}-public-cancel-with-active-predicate"
    result = runner.cancel(public_cancel_id)
    if asyncio.iscoroutine(result):
        await result
    with pytest.raises(RunnerCancelled):
        await runner.run(
            {
                "id": public_cancel_id,
                "current_attempt_id": f"{kind}-public-cancel-attempt",
                "_attempt_active": lambda: True,
                "approval_mode": "auto",
                "prompt": "fixture",
            },
            _emit,
        )
    assert not marker.exists()
    assert public_cancel_id not in runner._cancelled

    pending_id = f"{kind}-public-cancel-before-run"
    result = runner.cancel(pending_id)
    if asyncio.iscoroutine(result):
        await result
    with pytest.raises(RunnerCancelled):
        await runner.run(
            {"id": pending_id, "approval_mode": "auto", "prompt": "fixture"},
            _emit,
        )
    assert not marker.exists()

    next_task = {
        "id": f"{kind}-different-task",
        "current_attempt_id": "attempt-next",
        "_attempt_active": lambda: True,
        "approval_mode": "auto",
        "prompt": "fixture",
    }
    await asyncio.wait_for(runner.run(next_task, _emit), timeout=2)
    assert marker.exists()
    assert f"{kind}-different-task" not in runner._cancelled
