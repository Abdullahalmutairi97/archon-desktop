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
