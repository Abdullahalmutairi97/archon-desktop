import json
import os
import socket

from fastapi.testclient import TestClient

from archon_server.app import create_app
from archon_server.config import Settings
from archon_server.local_pairing import LOCAL_PAIRING_AUDIENCE


def pair(path):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(3)
        connection.connect(str(path))
        stream = connection.makefile("rwb", buffering=0)
        stream.write(json.dumps({"op": "challenge", "audience": LOCAL_PAIRING_AUDIENCE}).encode() + b"\n")
        challenge = json.loads(stream.readline())["challenge"]
        stream.write(json.dumps({
            "op": "redeem", "audience": LOCAL_PAIRING_AUDIENCE, "nonce": challenge["nonce"],
        }).encode() + b"\n")
        return json.loads(stream.readline())["credential"]


def test_local_owner_pairing_bootstraps_existing_api_without_blank_auth(tmp_path):
    settings = Settings(
        archon_root=tmp_path,
        hermes_home=tmp_path / ".hermes",
        data_dir=tmp_path / ".data",
        auth_token="",
        local_owner_mode=True,
        start_worker=False,
    )
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/tasks").status_code == 401
        credential = pair(settings.local_pairing_socket_path)
        assert credential["server_url"] == settings.local_server_url
        headers = {"Authorization": f"Bearer {credential['access_token']}"}
        assert client.get("/api/tasks", headers=headers).status_code == 200
        owner = client.get("/api/local/owner", headers=headers)
        assert owner.status_code == 200
        assert owner.json() == {
            "principal_id": f"local-uid:{os.geteuid()}",
            "uid": os.geteuid(),
            "auth_method": "unix-peer-credentials",
        }
        assert client.get("/api/local/owner").status_code == 401
    assert not settings.local_pairing_socket_path.exists()


def test_legacy_bearer_cannot_claim_local_owner(tmp_path):
    settings = Settings(
        archon_root=tmp_path,
        hermes_home=tmp_path / ".hermes",
        data_dir=tmp_path / ".data",
        auth_token="legacy-token",
        local_owner_mode=True,
        start_worker=False,
    )
    with TestClient(create_app(settings)) as client:
        legacy = {"Authorization": "Bearer legacy-token"}
        assert client.get("/api/tasks", headers=legacy).status_code == 200
        assert client.get("/api/local/owner", headers=legacy).status_code == 401
        paired = pair(settings.local_pairing_socket_path)
        headers = {"Authorization": f"Bearer {paired['access_token']}"}
        assert client.get("/api/local/owner", headers=headers).status_code == 200
