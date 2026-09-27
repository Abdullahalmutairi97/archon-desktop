"""Native-compatible Prime session leases: ownership, refusal and reclamation."""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import pytest

from archon_server.prime_session_lease import (
    LEASE_ENABLED_ENV,
    PrimeSessionAlreadyActive,
    PrimeSessionLease,
    PrimeSessionLeaseUnavailable,
    acquire_session_lease,
    canonical_session_path,
    lease_directory,
    lease_owner,
    read_lease_owner,
    release_session_lease,
)

NATIVE_MODULE = Path.home() / ".local/lib/node_modules/prime-agent/dist/core/session-lease.js"
NATIVE_DRIVER = Path(__file__).parent / "fixtures" / "native-prime-session-lease.mjs"


def _session(tmp_path: Path, session_id: str = "sess-a") -> tuple[Path, Path]:
    agent = tmp_path / "agent"
    (agent / "sessions").mkdir(parents=True)
    session = agent / "sessions" / f"{session_id}.jsonl"
    session.write_text(json.dumps({"type": "session", "id": session_id}) + "\n", encoding="utf-8")
    return agent, session


def test_lease_is_exclusive_within_one_owner_and_releasable(tmp_path):
    agent, session = _session(tmp_path)
    lease = acquire_session_lease(session, agent, active_session_id="archon:run-1")
    assert isinstance(lease, PrimeSessionLease)
    directory = lease_directory(agent, canonical_session_path(session))
    assert directory.is_dir()
    assert os.stat(directory).st_mode & 0o777 == 0o700
    owner = lease_owner(agent, session)
    assert owner is not None
    assert owner["activeSessionId"] == "archon:run-1"
    assert owner["sessionPath"] == canonical_session_path(session)
    assert os.stat(directory / "owner.json").st_mode & 0o777 == 0o600
    assert str(os.getpid()) == str(owner["pid"])

    # This process already owns it, so a second acquire is refused, not merged.
    with pytest.raises(PrimeSessionAlreadyActive):
        acquire_session_lease(session, agent)

    release_session_lease(lease)
    assert not directory.exists()
    assert lease_owner(agent, session) is None


def test_a_live_owner_blocks_and_a_dead_owner_is_reclaimed(tmp_path):
    agent, session = _session(tmp_path)
    directory = lease_directory(agent, canonical_session_path(session))
    directory.parent.mkdir(parents=True, exist_ok=True)
    directory.mkdir(mode=0o700)
    # A live owner: this test process, with its real start identity.
    start = Path(f"/proc/{os.getpid()}/stat").read_bytes().rsplit(b")", 1)[1].strip().split()[19].decode()
    (directory / "owner.json").write_text(json.dumps({
        "version": 1, "token": "held", "pid": os.getpid(), "processStartId": f"proc:{start}",
        "activeSessionId": "native:tui", "sessionPath": canonical_session_path(session),
        "createdAt": "2026-01-01T00:00:00+00:00",
    }), encoding="utf-8")
    with pytest.raises(PrimeSessionAlreadyActive) as blocked:
        acquire_session_lease(session, agent)
    assert "native:tui" in str(blocked.value) or "already active" in str(blocked.value)

    # A dead owner is reclaimed: the pid is gone, so nobody can be working.
    dead = subprocess.Popen([sys.executable, "-c", "pass"])
    dead.wait(timeout=30)
    (directory / "owner.json").write_text(json.dumps({
        "version": 1, "token": "stale", "pid": dead.pid, "processStartId": "proc:1",
        "sessionPath": canonical_session_path(session), "createdAt": "2026-01-01T00:00:00+00:00",
    }), encoding="utf-8")
    lease = acquire_session_lease(session, agent)
    assert lease_owner(agent, session)["token"] == lease.token
    release_session_lease(lease)

    # A recycled pid whose start identity differs is also reclaimed.
    directory.mkdir(mode=0o700)
    (directory / "owner.json").write_text(json.dumps({
        "version": 1, "token": "recycled", "pid": os.getpid(), "processStartId": "proc:0",
        "sessionPath": canonical_session_path(session), "createdAt": "2026-01-01T00:00:00+00:00",
    }), encoding="utf-8")
    lease = acquire_session_lease(session, agent)
    release_session_lease(lease)


def test_unjudgeable_owner_records_fail_closed(tmp_path):
    agent, session = _session(tmp_path)
    directory = lease_directory(agent, canonical_session_path(session))
    directory.parent.mkdir(parents=True, exist_ok=True)
    directory.mkdir(mode=0o700)
    for payload in (b"not json", b'{"version": 2, "token": "x", "pid": 1, "sessionPath": "/a", "createdAt": "c"}'):
        (directory / "owner.json").write_bytes(payload)
        with pytest.raises((PrimeSessionLeaseUnavailable, PrimeSessionAlreadyActive)):
            acquire_session_lease(session, agent)
        assert directory.exists()
    # An empty lease directory carries no owner at all, so the atomic rename
    # replaces it exactly as the native implementation's rename does.
    (directory / "owner.json").unlink()
    lease = acquire_session_lease(session, agent)
    assert lease_owner(agent, session)["token"] == lease.token
    release_session_lease(lease)
    assert not directory.exists()


def test_release_ignores_a_lease_owned_by_someone_else(tmp_path):
    agent, session = _session(tmp_path)
    lease = acquire_session_lease(session, agent)
    foreign = PrimeSessionLease(session_path=lease.session_path, directory=lease.directory, token="not-the-token")
    release_session_lease(foreign)
    assert lease.directory.exists()
    release_session_lease(lease)
    assert not lease.directory.exists()


def test_twenty_contenders_produce_one_owner(tmp_path):
    import threading

    agent, session = _session(tmp_path)
    winners: list[PrimeSessionLease] = []
    refusals: list[str] = []
    barrier = threading.Barrier(20)
    lock = threading.Lock()

    def contend() -> None:
        barrier.wait()
        try:
            lease = acquire_session_lease(session, agent)
        except PrimeSessionAlreadyActive:
            with lock:
                refusals.append("busy")
            return
        except PrimeSessionLeaseUnavailable as exc:
            with lock:
                refusals.append(f"unavailable:{exc}")
            return
        with lock:
            winners.append(lease)

    threads = [threading.Thread(target=contend) for _ in range(20)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
    assert len(winners) == 1, refusals
    assert refusals == ["busy"] * 19
    release_session_lease(winners[0])
    assert lease_owner(agent, session) is None


def test_child_environment_cannot_take_the_lease_the_server_holds(tmp_path):
    from archon_server.child_env import build_child_env

    env = build_child_env("prime", source={LEASE_ENABLED_ENV: "1", "PATH": "/usr/bin"}, overrides={})
    assert env.get(LEASE_ENABLED_ENV) is None
    assert build_child_env("prime", source={}, overrides={LEASE_ENABLED_ENV: "0"})[LEASE_ENABLED_ENV] == "0"
    with pytest.raises(ValueError):
        build_child_env("prime", source={}, overrides={LEASE_ENABLED_ENV: "1"})
    with pytest.raises(ValueError):
        build_child_env("hermes", source={}, overrides={LEASE_ENABLED_ENV: "0"})


def _native_driver() -> subprocess.CompletedProcess[str] | None:
    node = Path("/home/archonminipc/.local/share/prime-node/node-v24.21.0/bin/node")
    if not NATIVE_MODULE.is_file() or not NATIVE_DRIVER.is_file() or not node.is_file():
        return None
    return subprocess.CompletedProcess([], 0, "", "")


@pytest.mark.skipif(
    not NATIVE_MODULE.is_file() or not NATIVE_DRIVER.is_file(),
    reason="the installed Prime Agent session-lease module is unavailable on this host",
)
def test_native_prime_lease_is_mutually_exclusive_with_this_module(tmp_path):
    """Drive the installed Prime Agent implementation, not a copy of the protocol."""
    node = Path("/home/archonminipc/.local/share/prime-node/node-v24.21.0/bin/node")
    if not node.is_file():
        pytest.skip("the pinned Node 24 runtime is unavailable on this host")
    agent, session = _session(tmp_path)

    def run_native(mode: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [str(node), str(NATIVE_DRIVER), str(session), str(agent), mode],
            capture_output=True, text=True, timeout=60, cwd=str(NATIVE_DRIVER.parent),
        )

    # While this module holds the lease, native Prime must refuse the session.
    lease = acquire_session_lease(session, agent, active_session_id="archon:cross-check")
    refused = run_native("try")
    assert "REFUSED" in refused.stdout, refused.stdout + refused.stderr
    assert "session_already_active" in refused.stdout
    assert "archon:cross-check" in refused.stdout
    release_session_lease(lease)

    # While native Prime holds the lease, this module must refuse the session.
    holder = subprocess.Popen(
        [str(node), str(NATIVE_DRIVER), str(session), str(agent), "acquire-hold"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, cwd=str(NATIVE_DRIVER.parent),
    )
    try:
        assert holder.stdout is not None
        assert holder.stdout.readline().startswith("ACQUIRED")
        with pytest.raises(PrimeSessionAlreadyActive):
            acquire_session_lease(session, agent)
    finally:
        holder.kill()
        holder.wait(timeout=30)
    time.sleep(0.3)
    # A killed native owner is reclaimed, because no live process can still be
    # working the session.
    reclaimed = acquire_session_lease(session, agent)
    release_session_lease(reclaimed)
    assert lease_owner(agent, session) is None


def test_read_lease_owner_reports_absent_for_a_missing_directory(tmp_path):
    agent, session = _session(tmp_path)
    assert read_lease_owner(lease_directory(agent, canonical_session_path(session))) is None


@pytest.mark.skipif(
    not NATIVE_MODULE.is_file() or not NATIVE_DRIVER.is_file(),
    reason="the installed Prime Agent session-lease module is unavailable on this host",
)
@pytest.mark.asyncio
async def test_runner_refuses_a_native_held_session_and_accepts_it_after_release(tmp_path):
    """The runner must fail closed on a native holder, then run once it is gone."""
    from archon_server.prime_runner import PrimeRunner

    node = Path("/home/archonminipc/.local/share/prime-node/node-v24.21.0/bin/node")
    if not node.is_file():
        pytest.skip("the pinned Node 24 runtime is unavailable on this host")
    agent, session = _session(tmp_path)
    agent_root = agent / "sessions"
    events = [
        {"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": "ok"}},
        {"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": "ok"}]}},
    ]
    executable = tmp_path / "fake-prime"
    executable.write_text(
        "#!/bin/sh\ncat <<'EOF'\n" + "\n".join(json.dumps(event) for event in events) + "\nEOF\n"
    )
    executable.chmod(0o755)
    task = {
        "id": "native-block", "approval_mode": "auto", "prompt": "hi",
        "session_id": "sess-a", "cwd": str(tmp_path),
    }

    holder = subprocess.Popen(
        [str(node), str(NATIVE_DRIVER), str(session), str(agent), "acquire-hold"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, cwd=str(NATIVE_DRIVER.parent),
    )
    try:
        assert holder.stdout is not None
        assert holder.stdout.readline().startswith("ACQUIRED")
        runner = PrimeRunner(executable, tmp_path / "sessions", tmp_path, agent_root)
        emitted: list[tuple[str, dict]] = []

        async def emit(kind, data):
            emitted.append((kind, data))

        with pytest.raises(RuntimeError) as refused:
            await runner.run(task, emit)
        assert "already active" in str(refused.value)
        assert emitted == []
    finally:
        holder.kill()
        holder.wait(timeout=30)
    time.sleep(0.3)

    runner = PrimeRunner(executable, tmp_path / "sessions", tmp_path, agent_root)

    async def quiet_emit(*_args) -> None:
        return None

    result = await runner.run(task, quiet_emit)
    assert result["session_id"] == "sess-a"
    # The run released the native lease again.
    assert lease_owner(agent, session) is None
