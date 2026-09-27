from __future__ import annotations

import json
import socket
import sys
import time

import pytest
from fastapi.testclient import TestClient

from archon_server.app import create_app
from archon_server.config import Settings
from archon_server.local_pairing import LOCAL_PAIRING_AUDIENCE
from archon_server.local_codex_event_journal import MAX_PROVISIONAL_TURNS
from archon_server.services.local_codex_worker import (
    LocalCodexOutcomeUnknown,
    LocalCodexWorkerClient,
)


def _fake_worker(path, body: str) -> None:
    path.write_text(body)


def _pair(path):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(3)
        connection.connect(str(path))
        stream = connection.makefile("rwb", buffering=0)
        stream.write(json.dumps({"op": "challenge", "audience": LOCAL_PAIRING_AUDIENCE}).encode() + b"\n")
        challenge = json.loads(stream.readline())["challenge"]
        stream.write(json.dumps({
            "op": "redeem", "audience": LOCAL_PAIRING_AUDIENCE, "nonce": challenge["nonce"],
        }).encode() + b"\n")
        return json.loads(stream.readline())["credential"]["access_token"]


def _settings(tmp_path, worker_script, **overrides):
    values = {
        "archon_root": tmp_path,
        "hermes_home": tmp_path / ".hermes",
        "data_dir": tmp_path / "data",
        "auth_token": "legacy-token",
        "start_worker": False,
        "local_owner_mode": True,
        "local_codex_enabled": True,
        "local_codex_metadata_root": tmp_path / "codex-metadata",
        "local_codex_worker_script": worker_script,
        "local_codex_node_executable": sys.executable,
        "local_codex_home_directory": tmp_path,
        "local_codex_home": tmp_path / ".codex",
        "local_codex_request_timeout_seconds": 1.0,
        "local_codex_start_timeout_seconds": 1.0,
    }
    values.update(overrides)
    return Settings(**values)


def test_local_codex_requires_owner_mode_and_explicit_absolute_metadata_root(tmp_path):
    with pytest.raises(ValueError, match="LOCAL_OWNER_MODE"):
        Settings(local_codex_enabled=True, auth_token="token", start_worker=False)
    with pytest.raises(ValueError, match="METADATA_ROOT"):
        Settings(local_codex_enabled=True, local_owner_mode=True, auth_token="token", start_worker=False)
    with pytest.raises(ValueError, match="absolute path"):
        Settings(
            local_codex_enabled=True, local_owner_mode=True,
            local_codex_metadata_root="relative-codex", auth_token="token", start_worker=False,
        )


@pytest.mark.asyncio
async def test_supervisor_uses_bounded_jsonl_and_returns_unsolicited_events(tmp_path):
    script = tmp_path / "worker.py"
    _fake_worker(script, '''
import json, sys
for line in sys.stdin:
    req = json.loads(line)
    if req["method"] == "listProjects":
        print(json.dumps({"event": {"seq": 1, "event": {"type": "turn.completed", "taskId": "codex-task:task-1"}}}), flush=True)
        result = [{"id": "codex-project:project-1", "name": "Project", "rootPath": "/work/project"}]
    elif req["method"] == "startTurn":
        result = {"taskId": "codex-task:task-1", "projectId": "codex-project:project-1", "sessionId": "codex:session-1", "state": "running"}
    else:
        result = {"cursor": 0, "oldest": 1, "reset": False, "events": []}
    print(json.dumps({"id": req["id"], "ok": True, "result": result}), flush=True)
''')
    client = LocalCodexWorkerClient(
        node_executable=sys.executable,
        worker_script=script,
        metadata_root=tmp_path / "metadata",
        home_directory=tmp_path,
        codex_home_directory=tmp_path / ".codex",
        request_timeout_seconds=1,
        start_timeout_seconds=1,
    )
    await client.start()
    try:
        projects = await client.request("listProjects", {})
        assert projects[0]["id"] == "codex-project:project-1"
        turn = await client.request("startTurn", {
            "projectId": "codex-project:project-1", "prompt": "do work",
        })
        assert turn["state"] == "running"
        assert client.events_after(0) == [{
            "seq": 1,
            "event": {"type": "turn.completed", "taskId": "codex-task:task-1"},
        }]
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_start_turn_timeout_is_unknown_and_never_retried(tmp_path):
    script = tmp_path / "worker.py"
    marker = tmp_path / "start-calls"
    _fake_worker(script, '''
import json, sys, time
for line in sys.stdin:
    request = json.loads(line)
    if request["method"] == "startTurn":
        open(MARKER_PATH, "a").write("start\\n")
        time.sleep(3)
    print(json.dumps({"id": request["id"], "ok": True, "result": {"unexpected": True}}), flush=True)
'''.replace("MARKER_PATH", repr(str(marker))))
    client = LocalCodexWorkerClient(
        node_executable=sys.executable, worker_script=script,
        metadata_root=tmp_path / "metadata", home_directory=tmp_path,
        codex_home_directory=tmp_path / ".codex", request_timeout_seconds=1,
        start_timeout_seconds=0.5,
    )
    await client.start()
    try:
        with pytest.raises(LocalCodexOutcomeUnknown):
            await client.request("startTurn", {"projectId": "codex-project:p", "prompt": "secret prompt"})
        assert client.pending_request_count == 0
        assert marker.read_text() == "start\n"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_start_turn_worker_error_is_unknown_without_returning_worker_text(tmp_path):
    script = tmp_path / "worker.py"
    _fake_worker(script, '''
import json, sys
for line in sys.stdin:
    request = json.loads(line)
    if request["method"] == "startTurn":
        print(json.dumps({"id": request["id"], "ok": False, "error": {
            "code": "request_failed", "message": "private prompt content",
        }}), flush=True)
    else:
        print(json.dumps({"id": request["id"], "ok": True, "result": []}), flush=True)
''')
    client = LocalCodexWorkerClient(
        node_executable=sys.executable, worker_script=script,
        metadata_root=tmp_path / "metadata", home_directory=tmp_path,
        codex_home_directory=tmp_path / ".codex", request_timeout_seconds=1,
        start_timeout_seconds=1,
    )
    await client.start()
    try:
        await client.request("listProjects", {})
        with pytest.raises(LocalCodexOutcomeUnknown) as outcome:
            await client.request("startTurn", {
                "projectId": "codex-project:project-1", "prompt": "private prompt content",
            })
        assert "private prompt" not in str(outcome.value)
    finally:
        await client.close()


def test_local_codex_api_uses_only_paired_owner_auth_and_preserves_start_ack(tmp_path):
    script = tmp_path / "worker.py"
    _fake_worker(script, '''
import json, sys
for line in sys.stdin:
    req = json.loads(line)
    method = req["method"]
    if method == "listProjects": result = [{"id": "codex-project:project-1", "name": "Project", "rootPath": "/work/project"}]
    elif method == "listSessions": result = []
    elif method == "registerWorkspaceRoot": result = {"id": "codex-project:project-1", "name": "Project", "rootPath": req["params"]["rootPath"]}
    elif method == "startTurn": result = {"taskId": "codex-task:task-1", "projectId": "codex-project:project-1", "sessionId": "codex:session-1", "state": "running"}
    elif method == "cancelTurn": result = True
    elif method == "answerApproval": result = True
    else: result = {"cursor": 0, "latest": 0, "oldest": 1, "reset": False, "events": []}
    print(json.dumps({"id": req["id"], "ok": True, "result": result}), flush=True)
''')
    settings = _settings(tmp_path, script)
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/local/codex/projects", headers={
            "Authorization": "Bearer legacy-token",
        }).status_code == 401
        token = _pair(settings.local_pairing_socket_path)
        headers = {"Authorization": f"Bearer {token}"}
        assert client.get("/api/local/codex/turns").status_code == 401
        assert client.get("/api/local/codex/turns", headers=headers).json() == {"turns": []}
        projects = client.get("/api/local/codex/projects", headers=headers)
        assert projects.status_code == 200
        assert projects.json() == {"projects": [{
            "id": "codex-project:project-1", "name": "Project", "rootPath": "/work/project",
        }]}
        assert client.get(
            "/api/local/codex/projects/codex-project%3Aproject-1/sessions", headers=headers,
        ).json() == {"sessions": []}
        registered = client.post("/api/local/codex/workspaces/register", headers=headers, json={
            "rootPath": "/work/new-project",
        })
        assert registered.status_code == 200
        assert registered.json() == {
            "id": "codex-project:project-1", "name": "Project", "rootPath": "/work/new-project",
        }
        response = client.post("/api/local/codex/turns", headers=headers, json={
            "projectId": "codex-project:project-1", "prompt": "hello",
        })
        assert response.status_code == 200
        assert response.json() == {
            "taskId": "codex-task:task-1", "projectId": "codex-project:project-1",
            "sessionId": "codex:session-1", "state": "running",
        }
        status = client.get("/api/local/codex/turns/codex-task%3Atask-1", headers=headers)
        assert status.status_code == 200
        assert status.json() == response.json()
        assert "prompt" not in status.json()
        assert client.get("/api/local/codex/turns?limit=1", headers=headers).json() == {
            "turns": [response.json()],
        }
        assert client.post(
            "/api/local/codex/turns/codex-task%3Atask-1/cancel", headers=headers,
        ).json() == {"cancelled": True}
        assert client.post(
            "/api/local/codex/approvals/approval-1", headers=headers, json={"allow": True},
        ).json() == {"answered": True}
        assert client.get("/api/local/codex/events", headers=headers).json() == {
            "cursor": 0, "latest": 0, "oldest": 1, "reset": False, "events": [],
        }


def test_local_codex_event_journal_replays_monotonic_public_sequences_after_worker_restart(tmp_path):
    script = tmp_path / "worker.py"
    generation_marker = tmp_path / "worker-generation"
    _fake_worker(script, '''
import json, pathlib, sys
marker = pathlib.Path(MARKER_PATH)
generation = int(marker.read_text()) + 1 if marker.exists() else 1
marker.write_text(str(generation))
for line in sys.stdin:
    req = json.loads(line)
    if req["method"] == "listProjects":
        print(json.dumps({"event": {"seq": 1, "event": {
            "type": "turn.completed", "taskId": "codex-task:task-1",
        }}}), flush=True)
        result = []
    else:
        result = {}
    print(json.dumps({"id": req["id"], "ok": True, "result": result}), flush=True)
'''.replace("MARKER_PATH", repr(str(generation_marker))))
    settings = _settings(tmp_path, script)

    with TestClient(create_app(settings)) as first_client:
        first_token = _pair(settings.local_pairing_socket_path)
        first_events = first_client.get("/api/local/codex/events", headers={
            "Authorization": f"Bearer {first_token}",
        })
        assert first_events.status_code == 200
        first_batch = first_events.json()
        assert first_batch["latest"] == 1
        assert first_batch["events"] == [{
            "seq": 1,
            "event": {"type": "turn.completed", "taskId": "codex-task:task-1"},
        }]

    # A new backend and new worker both start their worker-local event sequence
    # at 1. Public cursors come from the durable journal and continue at 2.
    with TestClient(create_app(settings)) as second_client:
        second_token = _pair(settings.local_pairing_socket_path)
        replay = second_client.get("/api/local/codex/events?after=1", headers={
            "Authorization": f"Bearer {second_token}",
        })
        assert replay.status_code == 200
        assert replay.json() == {
            "cursor": 2,
            "latest": 2,
            "oldest": 1,
            "reset": False,
            "events": [{
                "seq": 2,
                "event": {"type": "turn.completed", "taskId": "codex-task:task-1"},
            }],
        }
    assert generation_marker.read_text() == "2"


def test_fast_terminal_event_before_start_ack_is_bound_and_completed_survives_restart(tmp_path):
    script = tmp_path / "worker.py"
    _fake_worker(script, '''
import json, sys
for request_line in sys.stdin:
    request = json.loads(request_line)
    if request["method"] == "startTurn":
        print(json.dumps({"event": {"seq": 1, "event": {
            "type": "turn.completed", "taskId": "codex-task:task-fast",
        }}}), flush=True)
        result = {
            "taskId": "codex-task:task-fast", "projectId": "codex-project:project-fast",
            "sessionId": "codex:session-fast", "state": "running",
        }
    elif request["method"] == "listProjects":
        result = []
    else:
        result = {}
    print(json.dumps({"id": request["id"], "ok": True, "result": result}), flush=True)
''')
    settings = _settings(tmp_path, script)
    with TestClient(create_app(settings)) as client:
        token = _pair(settings.local_pairing_socket_path)
        headers = {"Authorization": f"Bearer {token}"}
        start = client.post("/api/local/codex/turns", headers=headers, json={
            "projectId": "codex-project:project-fast", "prompt": "private prompt",
        })
        assert start.status_code == 200
        assert start.json()["state"] == "running"
        status = client.get("/api/local/codex/turns/codex-task%3Atask-fast", headers=headers)
        assert status.status_code == 200
        assert status.json() == {
            "taskId": "codex-task:task-fast",
            "projectId": "codex-project:project-fast",
            "sessionId": "codex:session-fast",
            "state": "completed",
        }
        assert "private prompt" not in status.text
        events = client.get("/api/local/codex/events", headers=headers).json()
        assert events["events"] == [{
            "seq": 1,
            "event": {"type": "turn.completed", "taskId": "codex-task:task-fast"},
        }]

    # A clean worker/backend restart leaves already-terminal state intact.
    with TestClient(create_app(settings)) as client:
        token = _pair(settings.local_pairing_socket_path)
        status = client.get("/api/local/codex/turns/codex-task%3Atask-fast", headers={
            "Authorization": f"Bearer {token}",
        })
        assert status.status_code == 200
        assert status.json()["state"] == "completed"


def test_active_turn_becomes_outcome_unknown_on_backend_restart(tmp_path):
    script = tmp_path / "worker.py"
    _fake_worker(script, '''
import json, sys
for request_line in sys.stdin:
    request = json.loads(request_line)
    if request["method"] == "listProjects":
        result = []
    elif request["method"] == "startTurn":
        result = {
            "taskId": "codex-task:task-active", "projectId": "codex-project:project-active",
            "sessionId": "codex:session-active", "state": "running",
        }
    else:
        result = {}
    print(json.dumps({"id": request["id"], "ok": True, "result": result}), flush=True)
''')
    settings = _settings(tmp_path, script)
    with TestClient(create_app(settings)) as client:
        token = _pair(settings.local_pairing_socket_path)
        headers = {"Authorization": f"Bearer {token}"}
        start = client.post("/api/local/codex/turns", headers=headers, json={
            "projectId": "codex-project:project-active", "prompt": "private prompt",
        })
        assert start.status_code == 200
        assert client.get(
            "/api/local/codex/turns/codex-task%3Atask-active", headers=headers,
        ).json()["state"] == "running"

    # The new backend owns the journal before marking an accepted active turn
    # outcome-unknown; it never claims whether a native process survived.
    with TestClient(create_app(settings)) as client:
        token = _pair(settings.local_pairing_socket_path)
        status = client.get("/api/local/codex/turns/codex-task%3Atask-active", headers={
            "Authorization": f"Bearer {token}",
        })
        assert status.status_code == 200
        assert status.json()["state"] == "outcome_unknown"
        assert client.get("/api/local/codex/turns?limit=1", headers={
            "Authorization": f"Bearer {token}",
        }).json() == {"turns": [status.json()]}


def test_worker_retirement_marks_only_its_active_turns_outcome_unknown(tmp_path):
    script = tmp_path / "worker.py"
    _fake_worker(script, '''
import json, sys
for request_line in sys.stdin:
    request = json.loads(request_line)
    if request["method"] == "listProjects":
        result = []
    elif request["method"] == "startTurn":
        if request["params"].get("sessionId") == "codex:session-finished":
            result = {
                "taskId": "codex-task:task-finished", "projectId": "codex-project:project",
                "sessionId": "codex:session-finished", "state": "running",
            }
            print(json.dumps({"id": request["id"], "ok": True, "result": result}), flush=True)
            print(json.dumps({"event": {"seq": 1, "event": {
                "type": "turn.completed", "taskId": "codex-task:task-finished",
            }}}), flush=True)
            continue
        result = {
            "taskId": "codex-task:task-active", "projectId": "codex-project:project",
            "sessionId": "codex:session-active", "state": "running",
        }
        print(json.dumps({"id": request["id"], "ok": True, "result": result}), flush=True)
        sys.exit(0)
    else:
        result = {}
    print(json.dumps({"id": request["id"], "ok": True, "result": result}), flush=True)
''')
    settings = _settings(tmp_path, script)
    with TestClient(create_app(settings)) as client:
        token = _pair(settings.local_pairing_socket_path)
        headers = {"Authorization": f"Bearer {token}"}
        finished = client.post("/api/local/codex/turns", headers=headers, json={
            "projectId": "codex-project:project", "sessionId": "codex:session-finished",
            "prompt": "finish",
        })
        assert finished.status_code == 200
        deadline = time.monotonic() + 2
        finished_status = None
        while time.monotonic() < deadline:
            finished_status = client.get(
                "/api/local/codex/turns/codex-task%3Atask-finished", headers=headers,
            )
            if finished_status.json().get("state") == "completed":
                break
            time.sleep(0.01)
        assert finished_status is not None
        assert finished_status.json()["state"] == "completed"

        active = client.post("/api/local/codex/turns", headers=headers, json={
            "projectId": "codex-project:project", "sessionId": "codex:session-active",
            "prompt": "still processing",
        })
        assert active.status_code == 200
        deadline = time.monotonic() + 2
        active_status = None
        while time.monotonic() < deadline:
            active_status = client.get(
                "/api/local/codex/turns/codex-task%3Atask-active", headers=headers,
            )
            if active_status.json().get("state") == "outcome_unknown":
                break
            time.sleep(0.01)
        assert active_status is not None
        assert active_status.json()["state"] == "outcome_unknown"


def test_provisional_overflow_during_start_returns_unknown_without_false_running_status(tmp_path):
    script = tmp_path / "worker.py"
    _fake_worker(script, '''
import json, sys
for request_line in sys.stdin:
    request = json.loads(request_line)
    if request["method"] == "listProjects":
        result = []
    elif request["method"] == "startTurn":
        for index in range(EVENT_LIMIT + 1):
            task_id = "codex-task:task-fast" if index == EVENT_LIMIT else f"codex-task:orphan-{index}"
            print(json.dumps({"event": {"seq": index + 1, "event": {
                "type": "turn.completed", "taskId": task_id,
            }}}), flush=True)
        result = {
            "taskId": "codex-task:task-fast", "projectId": "codex-project:project",
            "sessionId": "codex:session-fast", "state": "running",
        }
    else:
        result = {}
    print(json.dumps({"id": request["id"], "ok": True, "result": result}), flush=True)
'''.replace("EVENT_LIMIT", str(MAX_PROVISIONAL_TURNS)))
    settings = _settings(tmp_path, script)
    with TestClient(create_app(settings)) as client:
        token = _pair(settings.local_pairing_socket_path)
        headers = {"Authorization": f"Bearer {token}"}
        response = client.post("/api/local/codex/turns", headers=headers, json={
            "projectId": "codex-project:project", "prompt": "private prompt",
        })
        assert response.status_code == 504
        assert response.json()["code"] == "local_codex_outcome_unknown"
        assert "private prompt" not in response.text
        assert client.get(
            "/api/local/codex/turns/codex-task%3Atask-fast", headers=headers,
        ).status_code == 404
        assert client.get("/api/local/codex/events", headers=headers).json()["latest"] == MAX_PROVISIONAL_TURNS


def test_local_codex_api_returns_unknown_outcome_on_start_turn_timeout(tmp_path):
    script = tmp_path / "worker.py"
    _fake_worker(script, '''
import json, sys, time
for line in sys.stdin:
    req = json.loads(line)
    if req["method"] == "startTurn": time.sleep(3)
    result = [] if req["method"] == "listProjects" else {}
    print(json.dumps({"id": req["id"], "ok": True, "result": result}), flush=True)
''')
    settings = _settings(tmp_path, script, local_codex_start_timeout_seconds=0.05)
    with TestClient(create_app(settings)) as client:
        token = _pair(settings.local_pairing_socket_path)
        response = client.post("/api/local/codex/turns", headers={
            "Authorization": f"Bearer {token}",
        }, json={"projectId": "codex-project:project-1", "prompt": "private prompt"})
    assert response.status_code == 504
    assert response.json() == {
        "detail": "Local Codex start outcome is unknown; do not retry this turn",
        "code": "local_codex_outcome_unknown",
    }
    assert "private prompt" not in response.text


def test_local_codex_api_treats_worker_eof_during_start_as_unknown_outcome(tmp_path):
    script = tmp_path / "worker.py"
    _fake_worker(script, '''
import json, sys
for line in sys.stdin:
    request = json.loads(line)
    if request["method"] == "startTurn": sys.exit(0)
    result = [] if request["method"] == "listProjects" else {}
    print(json.dumps({"id": request["id"], "ok": True, "result": result}), flush=True)
''')
    settings = _settings(tmp_path, script)
    with TestClient(create_app(settings)) as client:
        token = _pair(settings.local_pairing_socket_path)
        response = client.post("/api/local/codex/turns", headers={
            "Authorization": f"Bearer {token}",
        }, json={"projectId": "codex-project:project-1", "prompt": "private prompt"})
    assert response.status_code == 504
    assert response.json()["code"] == "local_codex_outcome_unknown"
    assert "private prompt" not in response.text
