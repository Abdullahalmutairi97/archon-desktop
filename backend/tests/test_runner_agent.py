from __future__ import annotations

import json
import socket
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from archon_server.app import create_app
from archon_server.config import Settings
from archon_server.local_pairing import LOCAL_PAIRING_AUDIENCE
from archon_server.runner_agent import RunnerAgent, RunnerAgentError, make_runtime_executor


class FakeClient:
    def __init__(self, events):
        self._events = list(events)
        self.reported = []
        self.acked = []

    async def claim(self, limit):
        return self._events

    async def report(self, event_key, status, output):
        self.reported.append((event_key, status, output))

    async def acknowledge(self, runner_seq):
        self.acked.append(runner_seq)


@pytest.mark.asyncio
async def test_agent_reports_and_acknowledges_then_handles_errors():
    events = [
        {"eventKey": "task:1", "runnerSeq": 1, "payload": {"kind": "prompt", "prompt": "hi"}},
        {"eventKey": "task:2", "runnerSeq": 2, "payload": {"kind": "prompt", "prompt": "boom"}},
    ]

    async def executor(payload):
        if payload["prompt"] == "boom":
            raise RunnerAgentError("execution failed")
        return {"status": "ok", "output": "done"}

    client = FakeClient(events)
    agent = RunnerAgent(client, executor)
    handled = await agent.run_once()
    assert handled == 2
    # Report happens before acknowledgement for each item, and a failed item is
    # still reported (never silently dropped) and acknowledged.
    assert [r[0] for r in client.reported] == ["task:1", "task:2"]
    assert client.reported[0][1] == "ok" and client.reported[0][2] == "done"
    assert client.reported[1][1] == "error" and "boom" not in (client.reported[1][2] or "")
    assert client.acked == [1, 2]


def test_runtime_executor_rejects_escapes_and_unsupported_kinds(tmp_path):
    executor = make_runtime_executor("/bin/true", tmp_path)
    import asyncio

    with pytest.raises(RunnerAgentError):
        asyncio.run(executor({"kind": "shell", "prompt": "x"}))
    with pytest.raises(RunnerAgentError):
        asyncio.run(executor({"kind": "prompt", "prompt": "x", "cwd": "../escape"}))


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


def test_remote_runner_result_api_contract(tmp_path):
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
        runner = client.post("/api/local/runners", headers=headers, json={"name": "worker-b"}).json()["runner"]
        auth = {"Authorization": f"Bearer {runner['secret']}"}

        assert client.post(
            f"/api/runners/{runner['runnerId']}/result",
            json={"eventKey": "task:1", "status": "ok", "output": "done"},
        ).status_code == 401
        reported = client.post(
            f"/api/runners/{runner['runnerId']}/result",
            headers=auth, json={"eventKey": "task:1", "status": "ok", "output": "done"},
        )
        assert reported.status_code == 200
        assert client.post(
            f"/api/runners/{runner['runnerId']}/result",
            headers=auth, json={"eventKey": "task:2", "status": "exploded", "output": "x"},
        ).status_code == 422

        results = client.get(f"/api/local/runners/{runner['runnerId']}/results", headers=headers)
        assert results.status_code == 200
        rows = results.json()["results"]
        assert rows and rows[0]["eventKey"] == "task:1" and rows[0]["status"] == "ok"
        assert client.get(f"/api/local/runners/runner-{'0' * 32}/results", headers=headers).status_code == 404

        # End-to-end dispatch: owner submits a task, the runner claims it.
        submitted = client.post(
            f"/api/local/runners/{runner['runnerId']}/tasks", headers=headers,
            json={"prompt": "build the thing", "cwd": "project-a"},
        )
        assert submitted.status_code == 201
        claimed = client.post(f"/api/runners/{runner['runnerId']}/claim", headers=auth, json={"limit": 10})
        payloads = [entry["payload"] for entry in claimed.json()["events"]]
        assert {"kind": "prompt", "prompt": "build the thing", "cwd": "project-a"} in payloads
        assert client.post(
            f"/api/local/runners/runner-{'0' * 32}/tasks", headers=headers, json={"prompt": "x"},
        ).status_code == 404
