"""Detached writers: processes still writing into a checkout that Archon did not start.

Every process here is a real child of this test, spawned into a temporary checkout,
and every one is stopped again in teardown. A process is only ever signalled by its
pid *and* start time, so a teardown can never hit a stranger that reused a pid.
"""
from __future__ import annotations

import json
import os
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from archon_server import workspace_detached_writers as writers_module
from archon_server.app import create_app
from archon_server.config import Settings
from archon_server.local_pairing import LOCAL_PAIRING_AUDIENCE
from archon_server.workspace_detached_writers import (
    ProcessIdentity,
    read_process_identity,
    scan_detached_writers,
    terminate_processes,
)


WRITER_SCRIPT = """\
import ctypes, os, sys, time
pid_file, target, mode = sys.argv[1], sys.argv[2], sys.argv[3]
if len(sys.argv) > 4 and sys.argv[4] == "undumpable":
    # PR_SET_DUMPABLE=0: the kernel then denies this account /proc/<pid>/cwd and fd.
    ctypes.CDLL(None).prctl(4, 0, 0, 0, 0)
handle = None if target == "-" else open(target, mode)
temporary = pid_file + ".tmp"
with open(temporary, "w") as out:
    out.write(str(os.getpid()))
os.replace(temporary, pid_file)
time.sleep(120)
"""

# A stand-in for an Archon terminal or service process: it leads its own session,
# keeps one writer as a direct child, and double-forks a second writer so that
# writer keeps only the session, not the parent chain.
SPAWNER_SCRIPT = """\
import os, subprocess, sys, time
writer, pid_dir, target = sys.argv[1], sys.argv[2], sys.argv[3]
subprocess.Popen([sys.executable, writer, os.path.join(pid_dir, "child.pid"), target, "a"])
middle = os.fork()
if middle == 0:
    subprocess.Popen([sys.executable, writer, os.path.join(pid_dir, "orphan.pid"), target, "a"])
    os._exit(0)
os.waitpid(middle, 0)
time.sleep(120)
"""


def _identity_alive(identity: ProcessIdentity) -> bool:
    try:
        raw = Path(f"/proc/{identity.pid}/stat").read_bytes()
    except OSError:
        return False
    fields = raw.rpartition(b")")[2].split()
    return int(fields[19]) == identity.start and fields[0] not in (b"Z", b"X")


class Processes:
    """Spawn real test processes and stop every one of them in teardown."""

    def __init__(self, root: Path):
        self.root = root
        self.helpers = root / "helpers"
        self.helpers.mkdir()
        self.writer = self.helpers / "writer.py"
        self.writer.write_text(WRITER_SCRIPT, encoding="utf-8")
        self.spawner = self.helpers / "spawner.py"
        self.spawner.write_text(SPAWNER_SCRIPT, encoding="utf-8")
        self._children: list[subprocess.Popen] = []
        self._identities: list[ProcessIdentity] = []
        self._counter = 0

    def pid_file(self, label: str) -> Path:
        self._counter += 1
        return self.helpers / f"{label}-{self._counter}.pid"

    def spawn_writer(self, *, cwd: Path, target: str = "-", mode: str = "r",
                     undumpable: bool = False) -> tuple[subprocess.Popen, ProcessIdentity]:
        pid_file = self.pid_file("writer")
        argv = [sys.executable, str(self.writer), str(pid_file), target, mode]
        if undumpable:
            argv.append("undumpable")
        child = subprocess.Popen(argv, cwd=cwd, start_new_session=True,
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL)
        self._children.append(child)
        identity = self.wait_for_pid(pid_file)
        assert identity.pid == child.pid
        return child, identity

    def spawn_anchor(self, *, cwd: Path, target: Path) -> tuple[subprocess.Popen, ProcessIdentity, ProcessIdentity]:
        pid_dir = self.helpers / f"anchor-{self._counter}"
        self._counter += 1
        pid_dir.mkdir()
        anchor = subprocess.Popen(
            [sys.executable, str(self.spawner), str(self.writer), str(pid_dir), str(target)],
            cwd=cwd, start_new_session=True,
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        self._children.append(anchor)
        child = self.wait_for_pid(pid_dir / "child.pid")
        orphan = self.wait_for_pid(pid_dir / "orphan.pid")
        return anchor, child, orphan

    def wait_for_pid(self, pid_file: Path, timeout: float = 20.0) -> ProcessIdentity:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if pid_file.exists():
                identity = read_process_identity(int(pid_file.read_text()))
                assert identity is not None, f"{pid_file} names a process that already exited"
                self._identities.append(identity)
                return identity
            time.sleep(0.05)
        raise AssertionError(f"{pid_file} was never written")

    def close(self) -> None:
        for identity in self._identities:
            if _identity_alive(identity):
                try:
                    os.kill(identity.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        for child in self._children:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=10)


@pytest.fixture
def processes(tmp_path):
    tracker = Processes(tmp_path)
    try:
        yield tracker
    finally:
        tracker.close()


def _checkout(tmp_path: Path, name: str = "checkout") -> Path:
    root = tmp_path / name
    root.mkdir()
    root.chmod(0o700)
    return root


def _writer_pids(scan) -> set[int]:
    return {writer.identity.pid for writer in scan.writers}


# ----------------------------------------------------------------- the scanner


def test_a_process_whose_cwd_is_inside_the_checkout_is_a_detached_writer(tmp_path, processes):
    checkout = _checkout(tmp_path)
    (checkout / "src").mkdir()
    _child, identity = processes.spawn_writer(cwd=checkout / "src")

    scan = scan_detached_writers(checkout)

    assert scan.complete is True and scan.reason is None
    [writer] = [writer for writer in scan.writers if writer.identity == identity]
    assert writer.reason == "cwd"
    assert writer.origin is None and writer.killable is False
    public = writer.public()
    assert public == {
        "kind": "detached", "pid": identity.pid, "name": public["name"], "reason": "cwd",
        "archonOwned": False, "origin": None, "blocking": True, "killable": False,
        "message": public["message"],
    }
    assert public["name"].startswith("python")
    assert "owner must close" in public["message"]


def test_a_descriptor_open_for_write_counts_and_a_reader_does_not(tmp_path, processes):
    checkout = _checkout(tmp_path)
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (checkout / "notes.txt").write_text("keep\n", encoding="utf-8")
    _writer, writer_identity = processes.spawn_writer(
        cwd=elsewhere, target=str(checkout / "build.log"), mode="a",
    )
    _reader, reader_identity = processes.spawn_writer(
        cwd=elsewhere, target=str(checkout / "notes.txt"), mode="r",
    )

    scan = scan_detached_writers(checkout)

    assert scan.complete is True
    by_pid = {writer.identity.pid: writer for writer in scan.writers}
    assert by_pid[writer_identity.pid].reason == "open-for-write"
    assert reader_identity.pid not in by_pid
    assert reader_identity.pid not in {pid for pid, _name in scan.unknown}


def test_paths_are_compared_without_following_symlinks_out_of_the_checkout(tmp_path, processes):
    checkout = _checkout(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    # A link inside the checkout that leads out of it does not pull the target in...
    (checkout / "escape").symlink_to(outside, target_is_directory=True)
    _escaped, escaped = processes.spawn_writer(
        cwd=checkout / "escape", target=str(checkout / "escape" / "out.log"), mode="a",
    )
    # ...and a link outside that leads into the checkout does not hide a writer.
    (tmp_path / "shortcut").symlink_to(checkout, target_is_directory=True)
    _inside, inside = processes.spawn_writer(cwd=tmp_path / "shortcut")

    scan = scan_detached_writers(checkout)

    assert escaped.pid not in _writer_pids(scan)
    assert inside.pid in _writer_pids(scan)


def test_the_scanning_server_process_is_never_reported(tmp_path, processes, monkeypatch):
    checkout = _checkout(tmp_path)
    monkeypatch.chdir(checkout)
    with open(checkout / "server-owned.log", "a", encoding="utf-8"):
        _child, child = processes.spawn_writer(cwd=checkout)
        scan = scan_detached_writers(checkout)
    assert os.getpid() not in _writer_pids(scan)
    assert child.pid in _writer_pids(scan)


def test_a_process_that_vanishes_mid_scan_is_tolerated(tmp_path, processes, monkeypatch):
    checkout = _checkout(tmp_path)
    listed_then_gone, listed_identity = processes.spawn_writer(cwd=checkout)
    stat_then_gone, stat_identity = processes.spawn_writer(cwd=checkout)
    _survivor, survivor = processes.spawn_writer(cwd=checkout)

    real_list = writers_module._list_pids
    real_stat = writers_module._read_stat

    def list_then_vanish(proc_root):
        pids = real_list(proc_root)
        assert listed_identity.pid in pids
        listed_then_gone.kill()
        listed_then_gone.wait(timeout=10)
        return pids

    def stat_then_vanish(proc_root, pid):
        info = real_stat(proc_root, pid)
        if pid == stat_identity.pid and stat_then_gone.poll() is None:
            stat_then_gone.kill()
            stat_then_gone.wait(timeout=10)
        return info

    monkeypatch.setattr(writers_module, "_list_pids", list_then_vanish)
    monkeypatch.setattr(writers_module, "_read_stat", stat_then_vanish)

    scan = scan_detached_writers(checkout)

    assert scan.complete is True
    assert survivor.pid in _writer_pids(scan)
    for gone in (listed_identity.pid, stat_identity.pid):
        assert gone not in _writer_pids(scan)
        assert gone not in {pid for pid, _name in scan.unknown}


def test_a_process_this_account_cannot_inspect_is_unknown_never_quiet(tmp_path, processes):
    checkout = _checkout(tmp_path)
    _hidden, hidden = processes.spawn_writer(cwd=checkout, undumpable=True)

    scan = scan_detached_writers(checkout)

    assert scan.complete is True
    assert hidden.pid not in _writer_pids(scan)
    assert hidden.pid in {pid for pid, _name in scan.unknown}
    public = scan.public()
    assert public["unknown"]["count"] >= 1
    assert hidden.pid in {row["pid"] for row in public["unknown"]["items"]}
    assert public["quiet"] is False


def test_an_unfinished_scan_says_so_instead_of_reporting_quiet(tmp_path, processes):
    checkout = _checkout(tmp_path)
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    processes.spawn_writer(cwd=checkout)
    # At least one inspected process outside the checkout, so descriptors are read.
    processes.spawn_writer(cwd=elsewhere)

    unreadable = scan_detached_writers(checkout, proc_root=str(tmp_path / "no-proc"))
    assert unreadable.complete is False and "process table" in unreadable.reason
    assert unreadable.public()["quiet"] is False

    timed_out = scan_detached_writers(checkout, deadline_seconds=0)
    assert timed_out.complete is False and "timed out" in timed_out.reason

    crowded = scan_detached_writers(checkout, max_processes=1)
    assert crowded.complete is False and "too many processes" in crowded.reason

    busy = scan_detached_writers(checkout, max_descriptors=0)
    assert busy.complete is False and "descriptors" in busy.reason

    missing = scan_detached_writers(tmp_path / "missing-checkout")
    assert missing.complete is False and "root" in missing.reason


def test_ownership_is_proven_from_the_parent_chain_or_the_session(tmp_path, processes):
    checkout = _checkout(tmp_path)
    anchor_process, child, orphan = processes.spawn_anchor(cwd=checkout, target=checkout / "out.log")
    anchor = read_process_identity(anchor_process.pid)
    assert anchor is not None
    _stranger_process, stranger = processes.spawn_writer(cwd=checkout)

    scan = scan_detached_writers(checkout, anchors={anchor: "service"}, exclude=[anchor])

    assert scan.complete is True
    by_pid = {writer.identity.pid: writer for writer in scan.writers}
    # The anchor itself is the known service, not a detached writer.
    assert anchor.pid not in by_pid
    assert by_pid[child.pid].origin == "service" and by_pid[child.pid].killable is True
    # The double-forked writer lost its parent chain but kept the anchor's session.
    assert by_pid[orphan.pid].origin == "service" and by_pid[orphan.pid].killable is True
    assert by_pid[stranger.pid].origin is None and by_pid[stranger.pid].killable is False
    assert by_pid[child.pid].public()["archonOwned"] is True

    # A pid alone is not proof: the same pid with another start time adopts nothing.
    forged = ProcessIdentity(anchor.pid, anchor.start + 1)
    unproven = scan_detached_writers(checkout, anchors={forged: "service"}, exclude=[anchor])
    assert all(writer.origin is None for writer in unproven.writers)


def test_terminate_processes_stops_only_the_named_identities(tmp_path, processes):
    checkout = _checkout(tmp_path)
    _first, first = processes.spawn_writer(cwd=checkout)
    bystander_process, bystander = processes.spawn_writer(cwd=checkout)
    stale = ProcessIdentity(bystander.pid, bystander.start + 1)

    survivors = terminate_processes([first, stale], grace_seconds=5, kill_seconds=2)

    assert survivors == []
    assert not _identity_alive(first)
    # A stale identity for a live pid is never signalled.
    assert _identity_alive(bystander) and bystander_process.poll() is None


# ------------------------------------------------------------------- the API


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


def _settings(tmp_path: Path, **overrides) -> Settings:
    return Settings(
        archon_root=tmp_path,
        hermes_home=tmp_path / ".hermes",
        data_dir=tmp_path / ".data",
        auth_token="legacy-token",
        local_owner_mode=True,
        start_worker=False,
        **overrides,
    )


def _register(client: TestClient, root: Path, workspace_id: str) -> None:
    client.app.state.store.db.create_workspace(
        workspace_id=workspace_id,
        root=str(root),
        owner_id=f"local-uid:{os.geteuid()}",
        project_id="project-" + workspace_id[-6:],
        generation=1,
        isolation_profile="git-checkout",
    )


def test_a_detached_writer_blocks_the_handover_and_is_listed_for_the_owner(tmp_path, processes):
    checkout = _checkout(tmp_path)
    settings = _settings(tmp_path)
    with TestClient(create_app(settings)) as client:
        headers = _paired_owner_headers(settings.local_pairing_socket_path)
        workspace_id = "workspace-e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1"
        _register(client, checkout, workspace_id)
        lease_url = f"/api/local/workspaces/{workspace_id}/write-lease"
        child, identity = processes.spawn_writer(cwd=checkout)

        refused = client.post(lease_url, headers=headers, json={"holder": "desktop-editor"})
        assert refused.status_code == 409, refused.text
        body = refused.json()
        assert body["code"] == "workspace_detached_writers"
        assert "owner must close" in body["detail"]
        assert body["writers"] == {"terminals": 0, "services": 0, "agentTasks": 0}
        detached = body["detachedWriters"]
        assert detached["complete"] is True and detached["count"] == 1
        [item] = detached["items"]
        assert item["pid"] == identity.pid and item["reason"] == "cwd"
        assert (item["archonOwned"], item["blocking"], item["killable"]) == (False, True, False)
        assert client.get(lease_url, headers=headers).json()["held"] is False

        # The owner sees the same writer without attempting a handover.
        status = client.get(lease_url, headers=headers).json()
        assert [row["pid"] for row in status["detachedWriters"]["items"]] == [identity.pid]
        resources = client.get(f"/api/local/workspaces/{workspace_id}/resources", headers=headers).json()
        assert resources["detachedWriters"]["count"] == 1
        assert resources["detachedWriters"]["items"][0]["pid"] == identity.pid

        # Once the owner closes it, the checkout is quiet and the handover proceeds.
        child.kill()
        child.wait(timeout=10)
        acquired = client.post(lease_url, headers=headers, json={"holder": "desktop-editor"})
        assert acquired.status_code == 200, acquired.text
        assert acquired.json()["lease"]["detachedWriters"]["count"] == 0
        assert acquired.json()["lease"]["writers"] == {"terminals": 0, "services": 0, "agentTasks": 0}


def test_quiesce_never_kills_a_writer_archon_did_not_start(tmp_path, processes):
    checkout = _checkout(tmp_path)
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (checkout / "readme.txt").write_text("hello\n", encoding="utf-8")
    settings = _settings(tmp_path)
    with TestClient(create_app(settings)) as client:
        headers = _paired_owner_headers(settings.local_pairing_socket_path)
        workspace_id = "workspace-e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2"
        _register(client, checkout, workspace_id)
        lease_url = f"/api/local/workspaces/{workspace_id}/write-lease"
        editor, editor_identity = processes.spawn_writer(
            cwd=elsewhere, target=str(checkout / "readme.txt"), mode="r+",
        )
        reader, reader_identity = processes.spawn_writer(
            cwd=elsewhere, target=str(checkout / "readme.txt"), mode="r",
        )

        refused = client.post(lease_url, headers=headers,
                              json={"holder": "desktop-editor", "quiesce": True})
        assert refused.status_code == 409, refused.text
        body = refused.json()
        assert body["code"] == "workspace_detached_writers"
        pids = {item["pid"]: item for item in body["detachedWriters"]["items"]}
        assert pids[editor_identity.pid]["reason"] == "open-for-write"
        assert pids[editor_identity.pid]["killable"] is False
        assert reader_identity.pid not in pids
        # Neither process was signalled, and no lease was recorded.
        time.sleep(0.2)
        assert editor.poll() is None and reader.poll() is None
        assert client.get(lease_url, headers=headers).json()["held"] is False


def test_quiesce_stops_a_writer_started_by_a_workspace_service(tmp_path, processes):
    checkout = _checkout(tmp_path)
    pid_dir = tmp_path / "service-pids"
    pid_dir.mkdir()
    settings = _settings(tmp_path)
    with TestClient(create_app(settings)) as client:
        headers = _paired_owner_headers(settings.local_pairing_socket_path)
        workspace_id = "workspace-e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3"
        _register(client, checkout, workspace_id)
        lease_url = f"/api/local/workspaces/{workspace_id}/write-lease"
        collection = f"/api/local/workspaces/{workspace_id}/services"
        owner = f"local-uid:{os.geteuid()}"
        assert client.put(f"{collection}/watch", headers=headers, json={
            "name": "watch",
            "argv": [sys.executable, str(processes.spawner), str(processes.writer),
                     str(pid_dir), str(checkout / "watch.log")],
        }).status_code == 200
        assert client.post(f"{collection}/watch/start", headers=headers).status_code == 200
        child = processes.wait_for_pid(pid_dir / "child.pid")
        orphan = processes.wait_for_pid(pid_dir / "orphan.pid")
        assert client.request("DELETE", lease_url, headers=headers,
                              json={"holder": owner}).status_code == 200

        refused = client.post(lease_url, headers=headers, json={"holder": "desktop-editor"})
        assert refused.status_code == 409, refused.text
        body = refused.json()
        assert body["code"] == "workspace_writers_running"
        assert "quiesce" in body["detail"]
        assert body["writers"]["services"] == 1
        items = {item["pid"]: item for item in body["detachedWriters"]["items"]}
        for identity in (child, orphan):
            assert items[identity.pid]["origin"] == "service"
            assert items[identity.pid]["killable"] is True

        # A writer Archon did not start refuses the quiesce before anything is
        # stopped, so a refusal never leaves a half-quiesced checkout behind.
        stranger, stranger_identity = processes.spawn_writer(cwd=checkout)
        mixed = client.post(lease_url, headers=headers,
                            json={"holder": "desktop-editor", "quiesce": True})
        assert mixed.status_code == 409, mixed.text
        assert mixed.json()["code"] == "workspace_detached_writers"
        assert {item["pid"] for item in mixed.json()["detachedWriters"]["items"]} == {
            child.pid, orphan.pid, stranger_identity.pid,
        }
        assert _identity_alive(child) and _identity_alive(orphan)
        assert [row["state"] for row in client.get(collection, headers=headers).json()["services"]] == ["running"]
        stranger.kill()
        stranger.wait(timeout=10)

        acquired = client.post(lease_url, headers=headers,
                               json={"holder": "desktop-editor", "quiesce": True})
        assert acquired.status_code == 200, acquired.text
        assert not _identity_alive(child) and not _identity_alive(orphan)
        assert client.get(lease_url, headers=headers).json()["holder"] == "desktop-editor"
        states = [row["state"] for row in client.get(collection, headers=headers).json()["services"]]
        assert "running" not in states and "starting" not in states


@pytest.mark.skipif(shutil.which("tmux") is None, reason="tmux is required for a real workspace shell")
def test_quiesce_stops_writers_left_behind_by_a_real_workspace_terminal(tmp_path, processes):
    checkout = _checkout(tmp_path)
    pid_dir = tmp_path / "terminal-pids"
    pid_dir.mkdir()
    settings = _settings(tmp_path)
    socket_path = None
    with TestClient(create_app(settings)) as client:
        try:
            headers = _paired_owner_headers(settings.local_pairing_socket_path)
            workspace_id = "workspace-e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4"
            _register(client, checkout, workspace_id)
            terminals = client.app.state.local_workspace_terminals
            socket_path = terminals._socket_path(terminals._resolve_workspace(workspace_id))
            lease_url = f"/api/local/workspaces/{workspace_id}/write-lease"
            owner = f"local-uid:{os.geteuid()}"
            created = client.post(f"/api/local/workspaces/{workspace_id}/terminals", headers=headers,
                                  json={"expectedGeneration": 1})
            assert created.status_code == 201, created.text
            session_id = created.json()["terminal"]["sessionId"]

            python = shlex.quote(sys.executable)
            writer = shlex.quote(str(processes.writer))
            first = shlex.quote(str(pid_dir / "nohup.pid"))
            second = shlex.quote(str(pid_dir / "subshell.pid"))
            # One job keeps the shell as its parent; the other is double-forked
            # through a subshell and keeps only the terminal's session.
            line = (f"nohup {python} {writer} {first} build.log a >/dev/null 2>&1 & "
                    f"( nohup {python} {writer} {second} - r >/dev/null 2>&1 & )")
            sent = client.post(f"/api/local/workspaces/{workspace_id}/terminals/{session_id}/input",
                               headers=headers, json={"line": line})
            assert sent.status_code == 200, sent.text
            nohup_writer = processes.wait_for_pid(pid_dir / "nohup.pid")
            subshell_writer = processes.wait_for_pid(pid_dir / "subshell.pid")
            assert client.request("DELETE", lease_url, headers=headers,
                                  json={"holder": owner}).status_code == 200

            refused = client.post(lease_url, headers=headers, json={"holder": "desktop-editor"})
            assert refused.status_code == 409, refused.text
            body = refused.json()
            assert body["code"] == "workspace_writers_running"
            assert body["writers"]["terminals"] == 1
            items = {item["pid"]: item for item in body["detachedWriters"]["items"]}
            for identity in (nohup_writer, subshell_writer):
                assert items[identity.pid]["origin"] == "terminal"
                assert items[identity.pid]["killable"] is True

            acquired = client.post(lease_url, headers=headers,
                                   json={"holder": "desktop-editor", "quiesce": True})
            assert acquired.status_code == 200, acquired.text
            # nohup ignores the hangup that closing the shell sends; quiesce still ends both.
            assert not _identity_alive(nohup_writer) and not _identity_alive(subshell_writer)
            assert client.get(f"/api/local/workspaces/{workspace_id}/terminals",
                              headers=headers).json() == {"terminals": []}
        finally:
            if socket_path is not None and socket_path.exists():
                subprocess.run([shutil.which("tmux"), "-S", str(socket_path), "kill-server"],
                               check=False, capture_output=True, timeout=10)


def test_an_unfinished_scan_refuses_the_handover(tmp_path, processes, monkeypatch):
    checkout = _checkout(tmp_path)
    settings = _settings(tmp_path)
    with TestClient(create_app(settings)) as client:
        headers = _paired_owner_headers(settings.local_pairing_socket_path)
        workspace_id = "workspace-e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5"
        _register(client, checkout, workspace_id)
        lease_url = f"/api/local/workspaces/{workspace_id}/write-lease"
        monkeypatch.setattr(writers_module, "PROC_ROOT", str(tmp_path / "no-proc"))

        for payload in ({"holder": "desktop-editor"}, {"holder": "desktop-editor", "quiesce": True}):
            refused = client.post(lease_url, headers=headers, json=payload)
            assert refused.status_code == 409, refused.text
            body = refused.json()
            assert body["code"] == "workspace_writer_scan_incomplete"
            assert "process table" in body["detail"]
            assert body["detachedWriters"]["complete"] is False
        status = client.get(lease_url, headers=headers).json()
        assert status["held"] is False
        assert status["detachedWriters"]["complete"] is False
        resources = client.get(f"/api/local/workspaces/{workspace_id}/resources", headers=headers).json()
        assert resources["detachedWriters"]["complete"] is False


def test_the_server_holding_a_checkout_file_does_not_block_its_own_handover(tmp_path, processes):
    checkout = _checkout(tmp_path)
    settings = _settings(tmp_path)
    with TestClient(create_app(settings)) as client:
        headers = _paired_owner_headers(settings.local_pairing_socket_path)
        workspace_id = "workspace-e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6"
        _register(client, checkout, workspace_id)
        with open(checkout / "server.log", "a", encoding="utf-8"):
            acquired = client.post(f"/api/local/workspaces/{workspace_id}/write-lease",
                                   headers=headers, json={"holder": "desktop-editor"})
        assert acquired.status_code == 200, acquired.text
        detached = acquired.json()["lease"]["detachedWriters"]
        assert detached["complete"] is True and detached["count"] == 0
        assert os.getpid() not in {row["pid"] for row in detached["items"]}
