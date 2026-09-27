from __future__ import annotations

import json
import socket
import sys

import pytest
from fastapi.testclient import TestClient

from archon_server.app import create_app
from archon_server.config import Settings
from archon_server.local_pairing import LOCAL_PAIRING_AUDIENCE
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
