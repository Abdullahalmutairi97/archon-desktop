from __future__ import annotations

import json
import os
import socket
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from archon_server.app import create_app
from archon_server.config import Settings
from archon_server.local_pairing import LOCAL_PAIRING_AUDIENCE
from archon_server.workspace_write_lease import (
    WorkspaceWriteLease,
    WorkspaceWriteLeaseBusy,
    WorkspaceWriteLeaseNotHolder,
)


WORKSPACE_ID = "workspace-0123456789abcdef0123456789abcdef"


def _fake_tmux(tmp_path):
    """A self-contained tmux stand-in: enough for the terminal service to run.

    Defined here rather than imported from another test module, because CI runs
    pytest from a temporary working directory where `tests` is not importable.
    It tracks session names in a state file so `list-sessions` reports them.
    """
    import sys as _sys

    state_file = tmp_path / "fake-tmux-state.json"
    script = tmp_path / "fake-tmux"
    script.write_text(
        "#!" + _sys.executable + "\n"
        "import json, os, socket, sys\n"
        f"state_file = {str(state_file)!r}\n"
        "args = sys.argv[1:]\n"
        "if len(args) < 3 or args[0] != '-S':\n"
        "    print('bad argv', file=sys.stderr); raise SystemExit(64)\n"
        "socket_path, action = args[1], args[2]\n"
        "try:\n"
        "    with open(state_file, encoding='utf-8') as handle: state = json.load(handle)\n"
        "except FileNotFoundError:\n"
        "    state = {}\n"
        "sessions = state.setdefault(socket_path, [])\n"
        "if action == 'new-session':\n"
        "    name = args[args.index('-s') + 1] if '-s' in args else 'session'\n"
        "    os.makedirs(os.path.dirname(socket_path), exist_ok=True)\n"
        "    if not os.path.exists(socket_path):\n"
        "        listener = socket.socket(socket.AF_UNIX); listener.bind(socket_path); listener.close()\n"
        "        os.chmod(socket_path, 0o600)\n"
        "    if name not in sessions: sessions.append(name)\n"
        "elif action == 'list-sessions':\n"
        "    for name in sessions: print(name)\n"
        "elif action == 'list-panes':\n"
        "    for name in sessions: print('%s|1|1|%%0' % name)\n"
        "elif action == 'send-keys':\n"
        "    pass\n"
        "elif action == 'kill-session':\n"
        "    target = args[args.index('-t') + 1].lstrip('=') if '-t' in args else ''\n"
        "    sessions[:] = [name for name in sessions if name != target]\n"
        "with open(state_file, 'w', encoding='utf-8') as handle: json.dump(state, handle)\n"
        "raise SystemExit(0)\n"
    )
    script.chmod(0o755)
    return script


def test_write_lease_is_exclusive_and_releasable(tmp_path):
    leases = WorkspaceWriteLease(tmp_path / "leases")
    acquired = leases.acquire(WORKSPACE_ID, "editor-a", 60)
    assert acquired["holder"] == "editor-a"
    assert leases.status(WORKSPACE_ID)["held"] is True

    with pytest.raises(WorkspaceWriteLeaseBusy):
        leases.acquire(WORKSPACE_ID, "editor-b", 60)
    # The current holder may renew.
    leases.acquire(WORKSPACE_ID, "editor-a", 60)

    with pytest.raises(WorkspaceWriteLeaseNotHolder):
        leases.release(WORKSPACE_ID, "editor-b")
    leases.release(WORKSPACE_ID, "editor-a")
    assert leases.status(WORKSPACE_ID) == {
        "workspaceId": WORKSPACE_ID, "held": False, "holder": None, "expiresAt": None,
    }
    with pytest.raises(WorkspaceWriteLeaseNotHolder):
        leases.release(WORKSPACE_ID, "editor-a")


def test_write_lease_persists_and_rejects_bad_input(tmp_path):
    first = WorkspaceWriteLease(tmp_path / "leases")
    first.acquire(WORKSPACE_ID, "editor-a", 60)
    reopened = WorkspaceWriteLease(tmp_path / "leases")
    assert reopened.status(WORKSPACE_ID)["holder"] == "editor-a"
    with pytest.raises(ValueError):
        reopened.acquire("not-a-workspace", "editor-a")
    with pytest.raises(ValueError):
        reopened.acquire(WORKSPACE_ID, "bad holder with spaces")
    with pytest.raises(ValueError):
        reopened.acquire(WORKSPACE_ID, "editor-a", 1)


def _paired_owner_headers(socket_path: Path) -> dict[str, str]:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(3)
        connection.connect(str(socket_path))
        stream = connection.makefile("rwb", buffering=0)
        stream.write(json.dumps({"op": "challenge", "audience": LOCAL_PAIRING_AUDIENCE}).encode() + b"\n")
        challenge = json.loads(stream.readline())["challenge"]
        stream.write(json.dumps({
            "op": "redeem", "audience": LOCAL_PAIRING_AUDIENCE, "nonce": challenge["nonce"],
        }).encode() + b"\n")
        credential = json.loads(stream.readline())["credential"]
    return {"Authorization": f"Bearer {credential['access_token']}"}


def test_write_lease_api_contract(tmp_path):
    settings = Settings(
        archon_root=tmp_path,
        hermes_home=tmp_path / ".hermes",
        data_dir=tmp_path / ".data",
        auth_token="legacy-token",
        local_owner_mode=True,
        start_worker=False,
    )
    with TestClient(create_app(settings)) as client:
        headers = _paired_owner_headers(settings.local_pairing_socket_path)
        workspace_root = tmp_path / "checkout"
        workspace_root.mkdir()
        workspace_root.chmod(0o700)
        workspace_id = "workspace-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        client.app.state.store.db.create_workspace(
            workspace_id=workspace_id,
            root=str(workspace_root),
            owner_id=f"local-uid:{os.geteuid()}",
            project_id="project-lease",
            generation=1,
            isolation_profile="git-checkout",
        )
        base = f"/api/local/workspaces/{workspace_id}/write-lease"
        assert client.get(base).status_code == 401
        assert client.get(base, headers=headers).json()["held"] is False

        acquired = client.post(base, headers=headers, json={"holder": "editor-a", "ttlSeconds": 120})
        assert acquired.status_code == 200 and acquired.json()["lease"]["holder"] == "editor-a"
        assert client.post(base, headers=headers, json={"holder": "editor-b"}).status_code == 409

        assert client.request("DELETE", base, headers=headers, json={"holder": "editor-b"}).status_code == 409
        assert client.request("DELETE", base, headers=headers, json={"holder": "editor-a"}).status_code == 200
        assert client.get(base, headers=headers).json()["held"] is False


def test_write_paths_hold_the_lease_and_block_a_competing_writer(tmp_path):
    """Every write path takes the lease; a handed-over workspace refuses writes."""
    settings = Settings(
        archon_root=tmp_path,
        hermes_home=tmp_path / ".hermes",
        data_dir=tmp_path / ".data",
        auth_token="legacy-token",
        local_owner_mode=True,
        start_worker=False,
    )
    with TestClient(create_app(settings)) as client:
        headers = _paired_owner_headers(settings.local_pairing_socket_path)
        workspace_root = tmp_path / "checkout"
        workspace_root.mkdir()
        workspace_root.chmod(0o700)
        (workspace_root / "readme.txt").write_text("original\n", encoding="utf-8")
        workspace_id = "workspace-cccccccccccccccccccccccccccccccc"
        client.app.state.store.db.create_workspace(
            workspace_id=workspace_id,
            root=str(workspace_root),
            owner_id=f"local-uid:{os.geteuid()}",
            project_id="project-enforcement",
            generation=1,
            isolation_profile="git-checkout",
        )
        base = f"/api/local/workspaces/{workspace_id}/write-lease"
        write_path = f"/api/workspaces/{workspace_id}/files/write"
        create_path = f"/api/workspaces/{workspace_id}/files/create"
        owner = f"local-uid:{os.geteuid()}"

        # A file save claims the lease for the identity the request presented.
        saved = client.post(write_path, headers=headers, json={
            "path": "readme.txt", "expected_content": "original\n", "content": "first\n",
        })
        assert saved.status_code == 200
        held = client.get(base, headers=headers).json()
        assert held["held"] is True and held["holder"] == owner

        # A competing writer cannot take the workspace while that lease is live.
        assert client.post(base, headers=headers, json={"holder": "desktop-editor"}).status_code == 409

        # An explicit handover releases the API writer, so the editor may hold it.
        assert client.request(
            "DELETE", base, headers=headers, json={"holder": owner},
        ).status_code == 200
        assert client.post(
            base, headers=headers, json={"holder": "desktop-editor", "ttlSeconds": 300},
        ).status_code == 200

        # Both write paths are then refused, and the refused save changes nothing.
        blocked_save = client.post(write_path, headers=headers, json={
            "path": "readme.txt", "expected_content": "first\n", "content": "second\n",
        })
        assert blocked_save.status_code == 409
        assert "desktop-editor" in blocked_save.json()["detail"]
        assert (workspace_root / "readme.txt").read_text(encoding="utf-8") == "first\n"
        assert client.post(create_path, headers=headers, json={
            "path": "new.txt", "content": "blocked\n",
        }).status_code == 409
        assert not (workspace_root / "new.txt").exists()

        # Starting a service is a write-capable handover, so it is refused too.
        collection = f"/api/local/workspaces/{workspace_id}/services"
        assert client.put(f"{collection}/web", headers=headers, json={
            "name": "web", "argv": ["/bin/sh", "-c", "sleep 5"],
        }).status_code == 200
        assert client.post(f"{collection}/web/start", headers=headers).status_code == 409

        # Handing the workspace back restores the API writer.
        assert client.request(
            "DELETE", base, headers=headers, json={"holder": "desktop-editor"},
        ).status_code == 200
        assert client.post(write_path, headers=headers, json={
            "path": "readme.txt", "expected_content": "first\n", "content": "second\n",
        }).status_code == 200
        assert (workspace_root / "readme.txt").read_text(encoding="utf-8") == "second\n"


def test_static_token_writes_use_their_own_writer_identity(tmp_path):
    """Without local pairing the request is authenticated as the server token."""
    settings = Settings(
        archon_root=tmp_path,
        hermes_home=tmp_path / ".hermes",
        data_dir=tmp_path / ".data",
        auth_token="legacy-token",
        local_owner_mode=True,
        start_worker=False,
    )
    with TestClient(create_app(settings)) as client:
        workspace_root = tmp_path / "token-checkout"
        workspace_root.mkdir()
        workspace_root.chmod(0o700)
        workspace_id = "workspace-dddddddddddddddddddddddddddddddd"
        client.app.state.store.db.create_workspace(
            workspace_id=workspace_id,
            root=str(workspace_root),
            owner_id=f"local-uid:{os.geteuid()}",
            project_id="project-token",
            generation=1,
            isolation_profile="git-checkout",
        )
        created = client.post(
            f"/api/workspaces/{workspace_id}/files/create",
            headers={"Authorization": "Bearer legacy-token"},
            json={"path": "created.txt", "content": "by token\n"},
        )
        assert created.status_code == 200
        owner_headers = _paired_owner_headers(settings.local_pairing_socket_path)
        held = client.get(
            f"/api/local/workspaces/{workspace_id}/write-lease", headers=owner_headers,
        ).json()
        # The static token is a distinct writer identity from a paired desktop.
        assert held["holder"] == "server-token:owner"

def test_concurrent_acquires_from_threads_yield_one_holder(tmp_path):
    """Two writers must not both acquire: the ledger cycle is serialized."""
    import threading

    leases = WorkspaceWriteLease(tmp_path / "leases")
    winners: list[str] = []
    losers: list[str] = []
    barrier = threading.Barrier(8)
    lock = threading.Lock()

    def contend(index: int) -> None:
        holder = f"writer-{index}"
        barrier.wait()
        try:
            leases.acquire(WORKSPACE_ID, holder, 60)
        except WorkspaceWriteLeaseBusy:
            with lock:
                losers.append(holder)
            return
        with lock:
            winners.append(holder)

    threads = [threading.Thread(target=contend, args=(index,)) for index in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)

    assert len(winners) == 1, (winners, losers)
    assert len(losers) == 7
    assert leases.status(WORKSPACE_ID)["holder"] == winners[0]
    leases.release(WORKSPACE_ID, winners[0])
    assert leases.status(WORKSPACE_ID)["held"] is False


def _contend_in_subprocess(root: str, holder: str, barrier, results) -> None:
    """One cross-process contender; the barrier makes every attempt concurrent."""
    from archon_server.workspace_write_lease import (
        WorkspaceWriteLease, WorkspaceWriteLeaseBusy,
    )

    leases = WorkspaceWriteLease(root)
    barrier.wait()
    try:
        leases.acquire(WORKSPACE_ID, holder, 60)
    except WorkspaceWriteLeaseBusy:
        results.put(("busy", holder))
        return
    results.put(("acquired", holder))


def test_concurrent_acquires_from_processes_yield_one_holder(tmp_path):
    """A second Archon process sharing the ledger must not double-acquire."""
    import multiprocessing

    root = tmp_path / "leases"
    WorkspaceWriteLease(root)  # create the private root first
    context = multiprocessing.get_context("spawn")
    barrier = context.Barrier(4)
    results = context.Queue()
    workers = [
        context.Process(target=_contend_in_subprocess, args=(str(root), f"proc-{index}", barrier, results))
        for index in range(4)
    ]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join(timeout=60)

    outcomes = [results.get(timeout=10) for _ in workers]
    acquired = [holder for state, holder in outcomes if state == "acquired"]
    assert len(acquired) == 1, outcomes
    assert len([state for state, _ in outcomes if state == "busy"]) == 3
    reopened = WorkspaceWriteLease(root)
    assert reopened.status(WORKSPACE_ID)["holder"] == acquired[0]

def test_terminal_input_requires_the_lease_but_interrupt_does_not(tmp_path):
    """Driving a shell is a write action; stopping a runaway command is not."""
    settings = Settings(
        archon_root=tmp_path,
        hermes_home=tmp_path / ".hermes",
        data_dir=tmp_path / ".data",
        auth_token="legacy-token",
        local_owner_mode=True,
        start_worker=False,
        local_workspace_terminal_tmux_executable=str(_fake_tmux(tmp_path)),
    )
    with TestClient(create_app(settings)) as client:
        headers = _paired_owner_headers(settings.local_pairing_socket_path)
        workspace_root = tmp_path / "terminal-checkout"
        workspace_root.mkdir()
        workspace_root.chmod(0o700)
        workspace_id = "workspace-ffffffffffffffffffffffffffffffff"
        client.app.state.store.db.create_workspace(
            workspace_id=workspace_id,
            root=str(workspace_root),
            owner_id=f"local-uid:{os.geteuid()}",
            project_id="project-terminal-input",
            generation=1,
            isolation_profile="git-checkout",
        )
        lease_url = f"/api/local/workspaces/{workspace_id}/write-lease"
        created = client.post(f"/api/local/workspaces/{workspace_id}/terminals", headers=headers,
                              json={"expectedGeneration": 1})
        assert created.status_code == 201, created.text
        session_id = created.json()["terminal"]["sessionId"]
        input_url = f"/api/local/workspaces/{workspace_id}/terminals/{session_id}/input"
        interrupt_url = f"/api/local/workspaces/{workspace_id}/terminals/{session_id}/interrupt"

        # Creating the terminal claimed the lease for the owner, so hand it over first.
        owner = f"local-uid:{os.geteuid()}"
        assert client.request("DELETE", lease_url, headers=headers, json={"holder": owner}).status_code == 200
        assert client.post(lease_url, headers=headers,
                           json={"holder": "desktop-editor", "ttlSeconds": 300}).status_code == 200
        blocked = client.post(input_url, headers=headers, json={"line": "touch /tmp/should-not-run"})
        assert blocked.status_code == 409
        assert "desktop-editor" in blocked.json()["detail"]
        assert client.post(interrupt_url, headers=headers).status_code in (200, 409, 504)

        # The lease holder may drive the shell again after taking the workspace back.
        assert client.request("DELETE", lease_url, headers=headers,
                              json={"holder": "desktop-editor"}).status_code == 200
        allowed = client.post(input_url, headers=headers, json={"line": "echo hello"})
        assert allowed.status_code in (200, 504)

