import asyncio
import json
import multiprocessing
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

import archon_server.prime_runner as prime_runner


def _contend(root, start, active, maximum, completed):
    async def run():
        await asyncio.to_thread(start.wait)
        lease = await prime_runner._acquire_session_lease(Path(root), "shared", timeout=10)
        try:
            with active.get_lock():
                active.value += 1
                maximum.value = max(maximum.value, active.value)
            await asyncio.sleep(0.01)
            with active.get_lock():
                active.value -= 1
                completed.value += 1
        finally:
            prime_runner._release_session_lease(lease)
    asyncio.run(run())


def _hold_until_killed(root, ready):
    async def run():
        lease = await prime_runner._acquire_session_lease(Path(root), "shared")
        ready.set()
        try:
            await asyncio.Event().wait()
        finally:
            prime_runner._release_session_lease(lease)
    asyncio.run(run())


def _run_native_fixture(root):
    root = Path(root)
    runner = prime_runner.PrimeRunner(root / "fake-prime", root / "sessions", root, root / "agent-sessions")
    asyncio.run(runner.run({"id": "fixture", "session_id": "shared", "prompt": "wait"}, lambda *_args: asyncio.sleep(0)))


@pytest.mark.asyncio
async def test_release_preserves_stable_inode_and_is_idempotent(tmp_path):
    lease = await prime_runner._acquire_session_lease(tmp_path, "shared")
    path = tmp_path / ".shared.lock"
    identity = path.stat().st_ino
    fd = lease.fileno()
    assert not os.get_inheritable(fd)
    prime_runner._release_session_lease(lease)
    # A second release must not close a newly reused descriptor.
    unrelated_fd = os.open(tmp_path / "unrelated", os.O_CREAT | os.O_RDWR, 0o600)
    try:
        prime_runner._release_session_lease(lease)
        os.fstat(unrelated_fd)
    finally:
        os.close(unrelated_fd)
    assert path.is_file()
    assert path.stat().st_ino == identity
    again = await prime_runner._acquire_session_lease(tmp_path, "shared", timeout=0)
    prime_runner._release_session_lease(again)
    assert path.stat().st_ino == identity


@pytest.mark.asyncio
@pytest.mark.parametrize("metadata", ["not json", "{}", '{"pid": -1}', '{"pid": 1, "start": "stale"}'])
async def test_unlocked_file_metadata_never_blocks_acquisition(tmp_path, metadata):
    path = tmp_path / ".shared.lock"
    path.write_text(metadata)
    identity = path.stat().st_ino
    lease = await prime_runner._acquire_session_lease(tmp_path, "shared", timeout=0.08)
    prime_runner._release_session_lease(lease)
    assert path.stat().st_ino == identity


@pytest.mark.asyncio
@pytest.mark.parametrize("metadata", [None, "not json", '{"pid": -1}', '{"pid": 1, "start": "stale"}'])
async def test_legacy_directory_requires_quiesced_migration(tmp_path, metadata):
    path = tmp_path / ".shared.lock"
    path.mkdir()
    if metadata is not None:
        (path / "owner.json").write_text(metadata)
    with pytest.raises(RuntimeError, match="[Ll]egacy.*quiesce"):
        await prime_runner._acquire_session_lease(tmp_path, "shared", timeout=0.08)
    assert path.is_dir()
    if metadata is not None:
        assert (path / "owner.json").read_text() == metadata


@pytest.mark.asyncio
async def test_wait_timeout_yields_to_heartbeat(tmp_path):
    holder = await prime_runner._acquire_session_lease(tmp_path, "shared")
    ticks = 0

    async def heartbeat():
        nonlocal ticks
        for _ in range(15):
            await asyncio.sleep(0.01)
            ticks += 1

    started = time.monotonic()
    pulsing = asyncio.create_task(heartbeat())
    try:
        with pytest.raises(RuntimeError, match="Timed out waiting"):
            await prime_runner._acquire_session_lease(tmp_path, "shared", timeout=0.12)
        assert 0.10 <= time.monotonic() - started < 0.6
        assert ticks >= 5
    finally:
        prime_runner._release_session_lease(holder)
        await pulsing


@pytest.mark.asyncio
async def test_cancelled_waiter_closes_descriptor_without_releasing_holder(tmp_path, monkeypatch):
    holder = await prime_runner._acquire_session_lease(tmp_path, "shared")
    opened = []
    real_open = os.open

    def record_open(*args, **kwargs):
        fd = real_open(*args, **kwargs)
        opened.append(fd)
        return fd

    monkeypatch.setattr(prime_runner.os, "open", record_open)
    waiter = asyncio.create_task(prime_runner._acquire_session_lease(tmp_path, "shared"))
    await asyncio.sleep(0.02)
    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter
    assert opened
    for fd in opened:
        with pytest.raises(OSError):
            os.fstat(fd)
    try:
        with pytest.raises(RuntimeError, match="Timed out waiting"):
            await prime_runner._acquire_session_lease(tmp_path, "shared", timeout=0)
    finally:
        prime_runner._release_session_lease(holder)
    successor = await prime_runner._acquire_session_lease(tmp_path, "shared", timeout=0)
    prime_runner._release_session_lease(successor)


@pytest.mark.asyncio
async def test_killed_owner_releases_kernel_lock(tmp_path):
    context = multiprocessing.get_context("spawn")
    ready = context.Event()
    owner = context.Process(target=_hold_until_killed, args=(str(tmp_path), ready))
    owner.start()
    try:
        assert await asyncio.to_thread(ready.wait, 5)
        owner.kill()
        await asyncio.to_thread(owner.join, 5)
        assert owner.exitcode == -signal.SIGKILL
        successor = await prime_runner._acquire_session_lease(tmp_path, "shared", timeout=0.5)
        prime_runner._release_session_lease(successor)
    finally:
        if owner.is_alive():
            owner.kill()
        owner.join(5)


def test_twenty_process_contenders_are_exclusive(tmp_path):
    context = multiprocessing.get_context("spawn")
    start = context.Event()
    active = context.Value("i", 0)
    maximum = context.Value("i", 0)
    completed = context.Value("i", 0)
    processes = [context.Process(target=_contend, args=(str(tmp_path), start, active, maximum, completed)) for _ in range(20)]
    try:
        for process in processes:
            process.start()
        start.set()
        deadline = time.monotonic() + 15
        for process in processes:
            process.join(max(0, deadline - time.monotonic()))
        assert all(process.exitcode == 0 for process in processes)
        assert maximum.value == 1
        assert active.value == 0
        assert completed.value == 20
    finally:
        for process in processes:
            if process.is_alive():
                process.kill()
            process.join(5)


@pytest.mark.asyncio
async def test_passed_descriptor_retains_lock_after_parent_closes_it(tmp_path):
    lease = await prime_runner._acquire_session_lease(tmp_path, "shared")
    fd = lease.fileno()
    # Like the Prime supervisor, this child keeps the open file description
    # while work continues. Closing in the backend must not unlock the child.
    child = subprocess.Popen(
        [sys.executable, "-c", "import sys; sys.stdin.buffer.read()"],
        stdin=subprocess.PIPE, pass_fds=(fd,),
    )
    prime_runner._release_session_lease(lease)
    try:
        with pytest.raises(RuntimeError, match="Timed out waiting"):
            await prime_runner._acquire_session_lease(tmp_path, "shared", timeout=0.08)
    finally:
        child.stdin.close()
        await asyncio.to_thread(child.wait, 5)
    successor = await prime_runner._acquire_session_lease(tmp_path, "shared", timeout=0)
    prime_runner._release_session_lease(successor)


@pytest.mark.asyncio
async def test_native_supervisor_holds_lock_after_backend_is_killed(tmp_path):
    ready = tmp_path / "native-ready.json"
    finish = tmp_path / "finish"
    executable = tmp_path / "fake-prime"
    executable.write_text(
        f"#!{sys.executable}\n"
        "import json, os, pathlib, time\n"
        f"pathlib.Path({str(ready)!r}).write_text(json.dumps({{'supervisor': os.getppid()}}))\n"
        f"while not pathlib.Path({str(finish)!r}).exists(): time.sleep(0.01)\n"
    )
    executable.chmod(0o755)
    context = multiprocessing.get_context("spawn")
    backend = context.Process(target=_run_native_fixture, args=(str(tmp_path),))
    backend.start()
    supervisor = None
    try:
        deadline = time.monotonic() + 5
        while not ready.exists() and time.monotonic() < deadline:
            await asyncio.sleep(0.01)
        assert ready.exists()
        supervisor = json.loads(ready.read_text())["supervisor"]
        backend.kill()
        await asyncio.to_thread(backend.join, 5)
        assert backend.exitcode == -signal.SIGKILL
        with pytest.raises(RuntimeError, match="Timed out waiting"):
            await prime_runner._acquire_session_lease(tmp_path / "sessions", "shared", timeout=0.1)
        finish.touch()
        successor = await prime_runner._acquire_session_lease(tmp_path / "sessions", "shared", timeout=2)
        prime_runner._release_session_lease(successor)
    finally:
        finish.touch()
        if backend.is_alive():
            backend.kill()
        backend.join(5)
        if supervisor is not None:
            try:
                os.killpg(supervisor, signal.SIGKILL)
            except ProcessLookupError:
                pass


@pytest.mark.asyncio
async def test_cancelled_runner_releases_lease_before_next_task(tmp_path):
    runner = prime_runner.PrimeRunner(tmp_path / "prime", tmp_path / "sessions", tmp_path, tmp_path / "agent-sessions")
    entered = asyncio.Event()

    async def wait_forever(_task, _emit, _lease):
        entered.set()
        await asyncio.Event().wait()

    runner._run_once = wait_forever
    running = asyncio.create_task(runner.run({"id": "first", "session_id": "shared"}, None))
    await asyncio.wait_for(entered.wait(), 1)
    running.cancel()
    with pytest.raises(asyncio.CancelledError):
        await running
    successor = await prime_runner._acquire_session_lease(tmp_path / "sessions", "shared", timeout=0)
    prime_runner._release_session_lease(successor)


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["symlink", "fifo"])
async def test_non_regular_lock_path_fails_without_touching_target(tmp_path, kind):
    path = tmp_path / ".shared.lock"
    target = tmp_path / "target"
    target.write_text("unchanged")
    if kind == "symlink":
        path.symlink_to(target)
    else:
        os.mkfifo(path)
    with pytest.raises((OSError, RuntimeError)):
        await prime_runner._acquire_session_lease(tmp_path, "shared", timeout=0.08)
    assert target.read_text() == "unchanged"


@pytest.mark.asyncio
async def test_lock_io_failure_releases_descriptor(tmp_path, monkeypatch):
    def fail_metadata(_fd, _length):
        raise OSError("fixture metadata failure")

    with monkeypatch.context() as patch:
        patch.setattr(prime_runner.os, "ftruncate", fail_metadata)
        with pytest.raises(OSError, match="fixture metadata failure"):
            await prime_runner._acquire_session_lease(tmp_path, "shared")
    successor = await prime_runner._acquire_session_lease(tmp_path, "shared", timeout=0)
    prime_runner._release_session_lease(successor)
