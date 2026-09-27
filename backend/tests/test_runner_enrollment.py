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
from archon_server.runner_enrollment import (
    RunnerAuthenticationError,
    RunnerEnrollmentError,
    RunnerEnrollmentService,
    RunnerNotFound,
)


def _service(tmp_path: Path) -> RunnerEnrollmentService:
    return RunnerEnrollmentService(tmp_path / "runner-state")


def test_enroll_list_authenticate_and_revoke(tmp_path):
    service = _service(tmp_path)
    enrolled = service.enroll("laptop-two")
    assert enrolled["runnerId"].startswith("runner-")
    assert enrolled["name"] == "laptop-two"
    assert isinstance(enrolled["secret"], str) and len(enrolled["secret"]) > 20

    listed = service.list()
    assert [row["name"] for row in listed] == ["laptop-two"]
    # The secret must never be returned by list().
    assert all("secret" not in json.dumps(row) for row in listed)

    assert service.authenticate(enrolled["runnerId"], enrolled["secret"])["name"] == "laptop-two"
    with pytest.raises(RunnerAuthenticationError):
        service.authenticate(enrolled["runnerId"], "wrong-secret")
    with pytest.raises(RunnerAuthenticationError):
        service.authenticate(enrolled["runnerId"], "")
    with pytest.raises(RunnerAuthenticationError):
        service.authenticate("runner-" + "0" * 32, enrolled["secret"])

    service.revoke(enrolled["runnerId"])
    assert service.list() == []
    with pytest.raises(RunnerAuthenticationError):
        service.authenticate(enrolled["runnerId"], enrolled["secret"])
    with pytest.raises(RunnerNotFound):
        service.revoke(enrolled["runnerId"])


def test_enrollment_is_bounded_and_names_are_unique(tmp_path):
    service = RunnerEnrollmentService(tmp_path / "runner-state", max_runners=2)
    service.enroll("a")
    with pytest.raises(RunnerEnrollmentError):
        service.enroll("a")
    service.enroll("b")
    with pytest.raises(RunnerEnrollmentError):
        service.enroll("c")
    with pytest.raises(ValueError):
        service.enroll("Bad Name")


def test_enrollment_ledger_is_private_and_rejects_tampering(tmp_path):
    service = _service(tmp_path)
    service.enroll("runner-one")
    ledger = tmp_path / "runner-state" / "runners.json"
    assert (ledger.stat().st_mode & 0o077) == 0
    ledger.write_text(json.dumps({"version": 1, "runners": [{"bogus": True}]}))
    with pytest.raises(Exception):
        service.list()


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


def test_runner_enrollment_api_contract(tmp_path):
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
        assert client.get("/api/local/runners").status_code == 401
        created = client.post("/api/local/runners", headers=headers, json={"name": "second-pc"})
        assert created.status_code == 201
        runner = created.json()["runner"]
        assert runner["name"] == "second-pc"

        listed = client.get("/api/local/runners", headers=headers)
        assert listed.status_code == 200
        assert [row["name"] for row in listed.json()["runners"]] == ["second-pc"]
        assert "secret" not in listed.text

        # The runner channel authenticates with the runner secret, not the owner token.
        good = client.post(
            f"/api/runners/{runner['runnerId']}/heartbeat",
            headers={"Authorization": f"Bearer {runner['secret']}"},
        )
        assert good.status_code == 200 and good.json()["name"] == "second-pc"
        assert client.post(f"/api/runners/{runner['runnerId']}/heartbeat").status_code == 401
        assert client.post(
            f"/api/runners/{runner['runnerId']}/heartbeat",
            headers={"Authorization": "Bearer wrong"},
        ).status_code == 401
        assert client.post(
            f"/api/runners/{runner['runnerId']}/heartbeat",
            headers=headers,
        ).status_code == 401

        revoked = client.delete(f"/api/local/runners/{runner['runnerId']}", headers=headers)
        assert revoked.status_code == 200
        assert client.get("/api/local/runners", headers=headers).json() == {"runners": []}
        assert client.post(
            f"/api/runners/{runner['runnerId']}/heartbeat",
            headers={"Authorization": f"Bearer {runner['secret']}"},
        ).status_code == 401
