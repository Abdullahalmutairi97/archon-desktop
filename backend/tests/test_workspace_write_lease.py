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
