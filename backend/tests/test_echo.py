from fastapi.testclient import TestClient

from archon_server.app import create_app
from archon_server.config import Settings


def client(tmp_path):
    return TestClient(create_app(Settings(data_dir=tmp_path, auth_token="token", start_worker=False)))


def test_echo_normalizes_valid_messages_and_requires_auth(tmp_path):
    with client(tmp_path) as api:
        assert api.post("/api/echo", json={"message": " hello "}).status_code == 401
        response = api.post(
            "/api/echo",
            json={"message": "  hello  "},
            headers={"Authorization": "Bearer token"},
        )
        assert response.status_code == 200
        assert response.json() == {"message": "hello"}

        boundary = "x" * 200
        assert api.post("/api/echo", json={"message": boundary}, headers={"Authorization": "Bearer token"}).json() == {"message": boundary}


def test_echo_rejects_invalid_messages_without_side_effects(tmp_path):
    with client(tmp_path) as api:
        headers = {"Authorization": "Bearer token"}
        for payload in ({"message": ""}, {"message": "   "}, {"message": "x" * 201}, {}, {"message": 7}, {"message": "ok", "extra": True}, [], None):
            response = api.post("/api/echo", json=payload, headers=headers)
            assert response.status_code == 422
            assert "detail" in response.json()

        malformed = api.post("/api/echo", content="{", headers={**headers, "Content-Type": "application/json"})
        assert malformed.status_code == 422
        assert "detail" in malformed.json()
