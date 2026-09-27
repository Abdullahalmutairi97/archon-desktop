from __future__ import annotations

import json
import socket
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from archon_server.app import create_app
from archon_server.config import Settings
from archon_server.local_pairing import LOCAL_PAIRING_AUDIENCE
from archon_server.runner_enrollment import RunnerEnrollmentService
from archon_server.runner_outbox import RunnerOutbox, RunnerOutboxError


def test_outbox_claims_and_acknowledges_with_dedup(tmp_path):
    outbox = RunnerOutbox(tmp_path / "outbox")
    runner_id = "runner-" + "a" * 32

    first = outbox.enqueue(runner_id, "task:one", {"prompt": "hello"})
    assert first["runnerSeq"] == 1
    # An exact retry returns the original sequence, not a new one.
    assert outbox.enqueue(runner_id, "task:one", {"prompt": "hello"})["runnerSeq"] == 1
    with pytest.raises(RunnerOutboxError):
        outbox.enqueue(runner_id, "task:one", {"prompt": "different"})

    outbox.enqueue(runner_id, "task:two", {"prompt": "world"})
    claimed = outbox.claim(runner_id, 10)
    assert [entry["eventKey"] for entry in claimed] == ["task:one", "task:two"]

    outbox.acknowledge(runner_id, claimed[0]["runnerSeq"])
    remaining = outbox.claim(runner_id, 10)
    assert [entry["eventKey"] for entry in remaining] == ["task:two"]

    # A fresh outbox on the same root still sees the unacknowledged entry.
    reopened = RunnerOutbox(tmp_path / "outbox")
    assert [entry["eventKey"] for entry in reopened.claim(runner_id, 10)] == ["task:two"]

    with pytest.raises(ValueError):
        outbox.claim("not-a-runner", 1)
    with pytest.raises(ValueError):
        outbox.enqueue(runner_id, "bad key with spaces", {})


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


def test_runner_outbox_api_contract(tmp_path):
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
        runner = client.post("/api/local/runners", headers=headers, json={"name": "worker-a"}).json()["runner"]
        auth = {"Authorization": f"Bearer {runner['secret']}"}

        assert client.post(
            f"/api/local/runners/{runner['runnerId']}/enqueue", headers=headers,
            json={"eventKey": "task:1", "payload": {"prompt": "do work"}},
        ).status_code == 201
        assert client.post(
            f"/api/local/runners/runner-{'0' * 32}/enqueue", headers=headers,
            json={"eventKey": "task:1", "payload": {}},
        ).status_code == 404

        assert client.post(f"/api/runners/{runner['runnerId']}/claim", json={"limit": 10}).status_code == 401
        claimed = client.post(f"/api/runners/{runner['runnerId']}/claim", headers=auth, json={"limit": 10})
        assert claimed.status_code == 200
        events = claimed.json()["events"]
        assert [entry["eventKey"] for entry in events] == ["task:1"]
        assert events[0]["payload"] == {"prompt": "do work"}

        assert client.post(
            f"/api/runners/{runner['runnerId']}/ack", headers=auth, json={"runnerSeq": events[0]["runnerSeq"]},
        ).status_code == 200
        assert client.post(f"/api/runners/{runner['runnerId']}/claim", headers=auth, json={"limit": 10}).json() == {"events": []}
