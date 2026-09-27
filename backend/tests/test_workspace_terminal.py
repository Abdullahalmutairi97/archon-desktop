from __future__ import annotations

import json
import os
import socket
import stat
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from archon_server.db import Database
from archon_server.app import create_app
from archon_server.config import Settings
from archon_server.local_pairing import LOCAL_PAIRING_AUDIENCE
from archon_server.services.workspace_terminal import (
    WorkspaceTerminalCapacity,
    WorkspaceTerminalInterruptOutcomeUnknown,
    WorkspaceTerminalService,
    WorkspaceTerminalUnavailable,
)


OWNER_ID = "local-uid:1000"
WORKSPACE_ID = "workspace-0123456789abcdef0123456789abcdef"


def _fake_tmux(tmp_path: Path) -> Path:
    state_file = tmp_path / "tmux-state.json"
    hang_start_file = tmp_path / "hang-start"
    fail_enter_file = tmp_path / "fail-enter"
    fail_interrupt_file = tmp_path / "fail-interrupt"
    pane_file = tmp_path / "pane.txt"
    input_file = tmp_path / "input.json"
    pane_file.write_text("fake pane output\n", encoding="utf-8")
    script = tmp_path / "fake-tmux"
    script.write_text(
        "#!" + sys.executable + "\n"
        + "import json, os, socket, sys\n"
        + f"state_file = {str(state_file)!r}\n"
        + f"hang_start_file = {str(hang_start_file)!r}\n"
        + f"fail_enter_file = {str(fail_enter_file)!r}\n"
        + f"fail_interrupt_file = {str(fail_interrupt_file)!r}\n"
        + f"pane_file = {str(pane_file)!r}\n"
        + f"input_file = {str(input_file)!r}\n"
        + "args = sys.argv[1:]\n"
        + "if len(args) < 3 or args[0] != '-S':\n"
        + "    print('bad argv', file=sys.stderr); raise SystemExit(64)\n"
        + "socket_path, action = args[1], args[2]\n"
        + "try:\n"
        + "    with open(state_file, encoding='utf-8') as handle: state = json.load(handle)\n"
        + "except FileNotFoundError:\n"
        + "    state = {}\n"
        + "if action == 'new-session':\n"
        + "    if len(args) != 8 or args[3] != '-d' or args[4] != '-s' or args[6] != '-c':\n"
        + "        print('new-session must be detached and server-built', file=sys.stderr); raise SystemExit(64)\n"
        + "    if os.path.exists(hang_start_file):\n"
        + "        import time; time.sleep(10)\n"
        + "    name, cwd = args[5], args[7]\n"
        + "    if name in state.get(socket_path, []):\n"
        + "        print('duplicate session', file=sys.stderr); raise SystemExit(1)\n"
        + "    os.makedirs(os.path.dirname(socket_path), exist_ok=True)\n"
        + "    if not os.path.exists(socket_path):\n"
        + "        listener = socket.socket(socket.AF_UNIX); listener.bind(socket_path); listener.close(); os.chmod(socket_path, 0o600)\n"
        + "    state.setdefault(socket_path, []).append(name)\n"
        + "elif action == 'list-panes':\n"
        + "    if len(args) != 6 or args[3:5] != ['-a', '-F']:\n"
        + "        print('bad list-panes argv', file=sys.stderr); raise SystemExit(64)\n"
        + "    for name in state.get(socket_path, []): print(f'{name}|1|1|%0')\n"
        + "elif action == 'list-sessions':\n"
        + "    if socket_path not in state:\n"
        + "        print('no server running on socket', file=sys.stderr); raise SystemExit(1)\n"
        + "    for name in state[socket_path]: print(name)\n"
        + "elif action == 'kill-session':\n"
        + "    if len(args) != 5 or args[3] != '-t' or not args[4].startswith('='):\n"
        + "        print('kill must use exact target', file=sys.stderr); raise SystemExit(64)\n"
        + "    name = args[4][1:]\n"
        + "    if socket_path not in state or name not in state[socket_path]:\n"
        + "        print('session not found', file=sys.stderr); raise SystemExit(1)\n"
        + "    state[socket_path].remove(name)\n"
        + "    if not state[socket_path]:\n"
        + "        del state[socket_path]\n"
        + "        try: os.unlink(socket_path)\n"
        + "        except FileNotFoundError: pass\n"
        + "elif action == 'capture-pane':\n"
        + "    if len(args) != 8 or args[3] != '-p' or args[4] != '-S' or args[6] != '-t':\n"
        + "        print('bad capture-pane argv', file=sys.stderr); raise SystemExit(64)\n"
        + "    if args[7] != '%0' or not state.get(socket_path, []):\n"
        + "        print('session not found', file=sys.stderr); raise SystemExit(1)\n"
        + "    with open(pane_file, 'rb') as handle: sys.stdout.buffer.write(handle.read())\n"
        + "elif action == 'send-keys':\n"
        + "    if len(args) < 6 or args[3] != '-t' or args[4] != '%0':\n"
        + "        print('bad send-keys argv', file=sys.stderr); raise SystemExit(64)\n"
        + "    if not state.get(socket_path, []):\n"
        + "        print('session not found', file=sys.stderr); raise SystemExit(1)\n"
        + "    if len(args) == 8 and args[5:7] == ['-l', '--']:\n"
        + "        event = {'type': 'literal', 'value': args[7]}\n"
        + "    elif len(args) == 6 and args[5] == 'Enter':\n"
        + "        if os.path.exists(fail_enter_file):\n"
        + "            print('simulated enter failure', file=sys.stderr); raise SystemExit(1)\n"
        + "        event = {'type': 'enter'}\n"
        + "    elif len(args) == 6 and args[5] == 'C-c':\n"
        + "        event = {'type': 'interrupt'}\n"
        + "    else:\n"
        + "        print('bad send-keys form', file=sys.stderr); raise SystemExit(64)\n"
        + "    try:\n"
        + "        with open(input_file, encoding='utf-8') as handle: inputs = json.load(handle)\n"
        + "    except FileNotFoundError:\n"
        + "        inputs = []\n"
        + "    inputs.append(event)\n"
        + "    with open(input_file, 'w', encoding='utf-8') as handle: json.dump(inputs, handle)\n"
        + "    if args[5] == 'C-c' and os.path.exists(fail_interrupt_file):\n"
        + "        print('simulated ambiguous interrupt', file=sys.stderr); raise SystemExit(1)\n"
        + "else:\n"
        + "    print('unknown action', file=sys.stderr); raise SystemExit(64)\n"
        + "with open(state_file, 'w', encoding='utf-8') as handle: json.dump(state, handle)\n",
        encoding="utf-8",
    )
    script.chmod(0o700)
    return script


def _service(tmp_path: Path, *, owner_id: str = OWNER_ID, max_sessions: int = 16,
             executable: Path | str | None = None,
             timeout_seconds: float = 10.0) -> tuple[WorkspaceTerminalService, Path]:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir(exist_ok=True)
    database = Database(tmp_path / "database.sqlite3")
    try:
        database.get_workspace(WORKSPACE_ID)
    except KeyError:
        database.create_workspace(
            workspace_id=WORKSPACE_ID,
            root=str(workspace_root),
            owner_id=OWNER_ID,
            project_id="project-test",
            generation=1,
            isolation_profile="git-checkout",
        )
    service = WorkspaceTerminalService(
        database,
        owner_id=owner_id,
        metadata_root=tmp_path / "private-state",
        socket_root=tmp_path / "s",
        tmux_executable=str(executable or _fake_tmux(tmp_path)),
        max_sessions=max_sessions,
        timeout_seconds=timeout_seconds,
    )
    return service, workspace_root


def _paired_owner_headers(socket_path: Path) -> dict[str, str]:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(3)
        connection.connect(str(socket_path))
        stream = connection.makefile("rwb", buffering=0)
        stream.write(json.dumps({"op": "challenge", "audience": LOCAL_PAIRING_AUDIENCE}).encode() + b"\n")
        challenge = json.loads(stream.readline())["challenge"]
        stream.write(json.dumps({
            "op": "redeem",
            "audience": LOCAL_PAIRING_AUDIENCE,
            "nonce": challenge["nonce"],
        }).encode() + b"\n")
        credential = json.loads(stream.readline())["credential"]
    return {"Authorization": f"Bearer {credential['access_token']}"}


@pytest.mark.asyncio
async def test_detached_session_is_listed_after_service_relaunch_and_can_be_terminated(tmp_path):
    fake = _fake_tmux(tmp_path)
    service, workspace_root = _service(tmp_path, executable=fake)

    created = await service.create(WORKSPACE_ID, expected_generation=1)
    assert set(created) == {"sessionId", "state", "createdAt"}
    assert created["state"] == "running"
    assert created["sessionId"].startswith("wterm-")

    metadata_path = next((tmp_path / "private-state").glob("*.json"))
    metadata_stat = metadata_path.stat()
    assert stat.S_IMODE(metadata_stat.st_mode) == 0o600
    assert metadata_stat.st_uid == os.geteuid()
    socket_directory = tmp_path / "s"
    assert stat.S_IMODE(socket_directory.stat().st_mode) == 0o700
    socket_files = list(socket_directory.glob("*.sock"))
    assert len(socket_files) == 1
    assert stat.S_ISSOCK(socket_files[0].lstat().st_mode)

    # A new service object models backend relaunch. The detached tmux session
    # and bounded metadata are both recovered without sending a shell command.
    relaunched, _ = _service(tmp_path, executable=fake)
    rows = await relaunched.list(WORKSPACE_ID)
    assert rows == [created]
    await relaunched.terminate(WORKSPACE_ID, created["sessionId"], confirm=True)
    assert await relaunched.list(WORKSPACE_ID) == []

    state = json.loads((tmp_path / "tmux-state.json").read_text(encoding="utf-8"))
    assert state == {}
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    assert metadata["workspaceId"] == WORKSPACE_ID
    assert metadata["root"] == str(workspace_root)
    assert metadata["generation"] == 1
    assert metadata["sessions"] == []


@pytest.mark.asyncio
async def test_workspace_owner_and_generation_are_server_fenced(tmp_path):
    service, _ = _service(tmp_path, owner_id="local-uid:other")
    with pytest.raises(PermissionError, match="owner"):
        await service.list(WORKSPACE_ID)

    service, _ = _service(tmp_path)
    await service.create(WORKSPACE_ID, expected_generation=1)
    database = Database(tmp_path / "database.sqlite3")
    with database.transaction() as conn:
        conn.execute(
            "UPDATE workspaces SET generation=2,updated_at='later' WHERE workspace_id=?",
            (WORKSPACE_ID,),
        )
    with pytest.raises(ValueError, match="generation"):
        await service.list(WORKSPACE_ID)


@pytest.mark.asyncio
async def test_missing_tmux_fails_closed_without_creating_metadata(tmp_path):
    missing = tmp_path / "missing-tmux"
    service, _ = _service(tmp_path, executable=missing)
    with pytest.raises(WorkspaceTerminalUnavailable, match="tmux"):
        await service.create(WORKSPACE_ID, expected_generation=1)
    assert list((tmp_path / "private-state").glob("*.json")) == []


def test_tmux_basename_is_resolved_from_service_path(tmp_path, monkeypatch):
    fake = _fake_tmux(tmp_path)
    monkeypatch.setenv("PATH", str(tmp_path))

    service, _ = _service(tmp_path, executable=fake.name)

    assert service.tmux_executable == str(fake.resolve())


@pytest.mark.asyncio
async def test_capacity_is_bounded_and_reconciliation_releases_finished_session(tmp_path):
    fake = _fake_tmux(tmp_path)
    service, _ = _service(tmp_path, executable=fake, max_sessions=1)
    first = await service.create(WORKSPACE_ID, expected_generation=1)
    with pytest.raises(WorkspaceTerminalCapacity):
        await service.create(WORKSPACE_ID, expected_generation=1)

    # Simulate the detached shell exiting on its own: the next owner readback
    # reconciles its metadata and returns the slot to the bounded pool.
    state_file = tmp_path / "tmux-state.json"
    state = json.loads(state_file.read_text(encoding="utf-8"))
    state.clear()
    state_file.write_text(json.dumps(state), encoding="utf-8")
    for path in (tmp_path / "s").glob("*.sock"):
        path.unlink()
    assert await service.list(WORKSPACE_ID) == []
    second = await service.create(WORKSPACE_ID, expected_generation=1)
    assert second["sessionId"] != first["sessionId"]


@pytest.mark.asyncio
async def test_unconfirmed_termination_is_rejected(tmp_path):
    service, _ = _service(tmp_path)
    created = await service.create(WORKSPACE_ID, expected_generation=1)
    with pytest.raises(PermissionError, match="confirmation"):
        await service.terminate(WORKSPACE_ID, created["sessionId"], confirm=False)
    assert await service.list(WORKSPACE_ID) == [created]


@pytest.mark.asyncio
async def test_confirmed_termination_resolves_absent_starting_reservation(tmp_path):
    fake = _fake_tmux(tmp_path)
    (tmp_path / "hang-start").touch()
    service, _ = _service(tmp_path, executable=fake, max_sessions=1, timeout_seconds=0.05)

    with pytest.raises(WorkspaceTerminalUnavailable, match="timed out"):
        await service.create(WORKSPACE_ID, expected_generation=1)
    rows = await service.list(WORKSPACE_ID)
    assert len(rows) == 1 and rows[0]["state"] == "starting"

    with pytest.raises(PermissionError, match="confirmation"):
        await service.terminate(WORKSPACE_ID, rows[0]["sessionId"], confirm=False)
    assert await service.list(WORKSPACE_ID) == rows

    await service.terminate(WORKSPACE_ID, rows[0]["sessionId"], confirm=True)
    assert await service.list(WORKSPACE_ID) == []
    metadata_path = next((tmp_path / "private-state").glob("*.json"))
    assert json.loads(metadata_path.read_text(encoding="utf-8"))["sessions"] == []


@pytest.mark.asyncio
async def test_screen_and_single_line_input_are_bounded_and_literal(tmp_path):
    fake = _fake_tmux(tmp_path)
    service, _ = _service(tmp_path, executable=fake)
    terminal = await service.create(WORKSPACE_ID, expected_generation=1)

    assert await service.screen(WORKSPACE_ID, terminal["sessionId"], lines=3) == {
        "text": "fake pane output\n",
        "truncated": False,
    }
    await service.send_line(WORKSPACE_ID, terminal["sessionId"], "echo '-- literal ; text'")
    input_events = json.loads((tmp_path / "input.json").read_text(encoding="utf-8"))
    assert input_events == [
        {"type": "literal", "value": "echo '-- literal ; text'"},
        {"type": "enter"},
    ]

    (tmp_path / "pane.txt").write_text("z" * (25 * 1024), encoding="utf-8")
    captured = await service.screen(WORKSPACE_ID, terminal["sessionId"], lines=120)
    assert captured["truncated"] is True
    assert len(captured["text"].encode("utf-8")) <= 24 * 1024
    (tmp_path / "pane.txt").write_bytes(b"\xff" * 10_000)
    invalid_utf8 = await service.screen(WORKSPACE_ID, terminal["sessionId"], lines=120)
    assert invalid_utf8["truncated"] is True
    assert len(invalid_utf8["text"].encode("utf-8")) <= 24 * 1024

    for invalid in ("two\nlines", "return\r", "nul\x00", "escape\x1b"):
        with pytest.raises(ValueError, match="line"):
            await service.send_line(WORKSPACE_ID, terminal["sessionId"], invalid)
    with pytest.raises(ValueError, match="4096"):
        await service.send_line(WORKSPACE_ID, terminal["sessionId"], "x" * 4097)


@pytest.mark.asyncio
async def test_interrupt_sends_one_ctrl_c_to_the_active_ledger_pane_without_retry(tmp_path):
    fake = _fake_tmux(tmp_path)
    service, _ = _service(tmp_path, executable=fake)
    terminal = await service.create(WORKSPACE_ID, expected_generation=1)

    assert await service.interrupt(WORKSPACE_ID, terminal["sessionId"]) == {"sent": True}
    event_path = tmp_path / "input.json"
    assert json.loads(event_path.read_text(encoding="utf-8")) == [{"type": "interrupt"}]

    # The fake records delivery before returning failure, simulating an
    # ambiguous tmux response. The service reports uncertainty and does not retry.
    (tmp_path / "fail-interrupt").touch()
    with pytest.raises(WorkspaceTerminalInterruptOutcomeUnknown, match="outcome is unknown"):
        await service.interrupt(WORKSPACE_ID, terminal["sessionId"])
    assert json.loads(event_path.read_text(encoding="utf-8")) == [
        {"type": "interrupt"}, {"type": "interrupt"},
    ]


@pytest.mark.asyncio
async def test_create_requires_current_expected_generation(tmp_path):
    service, _ = _service(tmp_path)
    with pytest.raises(ValueError, match="generation"):
        await service.create(WORKSPACE_ID, expected_generation=2)


def test_local_owner_workspace_terminal_api_contract(tmp_path, monkeypatch):
    fake = _fake_tmux(tmp_path)
    monkeypatch.setenv(
        "ARCHON_DESKTOP_LOCAL_WORKSPACE_TERMINAL_TMUX_EXECUTABLE",
        str(fake),
    )
    settings = Settings(
        archon_root=tmp_path,
        hermes_home=tmp_path / ".hermes",
        data_dir=tmp_path / ".data",
        auth_token="legacy-token",
        local_owner_mode=True,
        start_worker=False,
    )
    assert settings.local_workspace_terminal_tmux_executable == str(fake)
    with TestClient(create_app(settings)) as client:
        assert client.app.state.local_workspace_terminals.tmux_executable == str(fake.resolve())
        assert client.get(f"/api/local/workspaces/{WORKSPACE_ID}/terminals").status_code == 401
        assert client.post(
            f"/api/local/workspaces/{WORKSPACE_ID}/terminals/"
            "wterm-0123456789abcdef0123456789abcdef/interrupt",
        ).status_code == 401
        legacy = {"Authorization": "Bearer legacy-token"}
        assert client.get(f"/api/local/workspaces/{WORKSPACE_ID}/terminals", headers=legacy).status_code == 401
        headers = _paired_owner_headers(settings.local_pairing_socket_path)

        workspace_root = tmp_path / "registered-checkout"
        workspace_root.mkdir()
        workspace_id = "workspace-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        client.app.state.store.db.create_workspace(
            workspace_id=workspace_id,
            root=str(workspace_root),
            owner_id=f"local-uid:{os.geteuid()}",
            project_id="project-api-test",
            generation=2,
            isolation_profile="git-checkout",
        )
        collection_url = f"/api/local/workspaces/{workspace_id}/terminals"
        stale = client.post(collection_url, headers=headers, json={"expectedGeneration": 1})
        assert stale.status_code == 409
        bad_create = client.post(
            collection_url,
            headers=headers,
            json={"expectedGeneration": 2, "cwd": "/etc"},
        )
        assert bad_create.status_code == 422

        created = client.post(collection_url, headers=headers, json={"expectedGeneration": 2})
        assert created.status_code == 201
        terminal = created.json()["terminal"]
        assert set(terminal) == {"sessionId", "state", "createdAt"}
        assert terminal["state"] == "running"
        assert terminal["sessionId"].startswith("wterm-")
        assert isinstance(terminal["createdAt"], str) and terminal["createdAt"].endswith("+00:00")

        listed = client.get(collection_url, headers=headers)
        assert listed.status_code == 200
        assert listed.json() == {"terminals": [terminal]}
        session_url = f"{collection_url}/{terminal['sessionId']}"
        screen = client.get(f"{session_url}/screen?lines=120", headers=headers)
        assert screen.status_code == 200
        assert screen.json() == {"text": "fake pane output\n", "truncated": False}
        assert screen.headers["cache-control"] == "no-store"
        assert client.get(f"{session_url}/screen?lines=121", headers=headers).status_code == 422

        interrupted = client.post(f"{session_url}/interrupt", headers=headers)
        assert interrupted.status_code == 200 and interrupted.json() == {"sent": True}
        assert interrupted.headers["cache-control"] == "no-store"
        (tmp_path / "fail-interrupt").touch()
        uncertain_interrupt = client.post(f"{session_url}/interrupt", headers=headers)
        assert uncertain_interrupt.status_code == 504
        assert uncertain_interrupt.json() == {
            "detail": "Terminal interrupt outcome is unknown; do not retry automatically",
            "code": "workspace_terminal_interrupt_outcome_unknown",
        }

        sent = client.post(f"{session_url}/input", headers=headers, json={"line": "echo 'from owner'"})
        assert sent.status_code == 200 and sent.json() == {"sent": True}
        assert client.post(f"{session_url}/input", headers=headers, json={"line": "echo a\necho b"}).status_code == 422

        (tmp_path / "fail-enter").touch()
        uncertain = client.post(
            f"{session_url}/input",
            headers=headers,
            json={"line": "echo outcome-unknown"},
        )
        assert uncertain.status_code == 504
        assert uncertain.json() == {
            "detail": "Terminal input outcome is unknown; do not retry automatically",
            "code": "workspace_terminal_input_outcome_unknown",
        }

        assert client.request(
            "DELETE", session_url, headers=headers, json={"confirm": False},
        ).status_code == 403
        deleted = client.request("DELETE", session_url, headers=headers, json={"confirm": True})
        assert deleted.status_code == 200 and deleted.json() == {"ok": True}
        assert client.get(collection_url, headers=headers).json() == {"terminals": []}

        client.app.state.local_workspace_terminals.tmux_executable = None
        unavailable = client.get(collection_url, headers=headers)
        assert unavailable.status_code == 503
