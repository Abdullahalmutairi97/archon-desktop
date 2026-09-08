from fastapi.testclient import TestClient

from archon_server.app import _event_cursor, create_app
from archon_server.config import Settings


def test_api_rejects_missing_or_wrong_token(tmp_path):
    app = create_app(Settings(data_dir=tmp_path, auth_token="correct-token", start_worker=False))
    with TestClient(app) as client:
        assert client.get("/api/health").status_code == 200
        assert client.get("/api/tasks").status_code == 401
        assert client.get("/api/tasks", headers={"Authorization": "Bearer wrong"}).status_code == 401
        assert client.get("/api/tasks", headers={"Authorization": "Bearer correct-token"}).status_code == 200


def test_api_allows_requests_without_token_when_auth_is_disabled(tmp_path):
    app = create_app(Settings(data_dir=tmp_path, auth_token="", start_worker=False))
    with TestClient(app) as client:
        assert client.get("/api/tasks").status_code == 200
        assert client.get("/api/tasks", headers={"Authorization": "Bearer stale-token"}).status_code == 200


def test_cors_only_allows_electron_and_loopback_origins(tmp_path):
    app = create_app(Settings(data_dir=tmp_path, auth_token="correct-token", start_worker=False))
    preflight = {
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
    }
    with TestClient(app) as client:
        denied = client.options("/api/tasks", headers={**preflight, "Origin": "https://evil.example"})
        allowed = client.options("/api/tasks", headers={**preflight, "Origin": "null"})
    assert denied.headers.get("access-control-allow-origin") is None
    assert allowed.headers.get("access-control-allow-origin") == "null"


def test_sse_cursor_accepts_query_or_last_event_id_header():
    assert _event_cursor(8, None) == 8
    assert _event_cursor(8, "12") == 12
    assert _event_cursor(12, "8") == 12
    assert _event_cursor(5, "not-a-number") == 5


def test_authenticated_desktop_release_metadata_and_download(tmp_path):
    artifact = tmp_path / "Archon-x86_64.AppImage"
    artifact.write_bytes(b"verified-appimage")
    settings = Settings(
        data_dir=tmp_path / "data", auth_token="release-token", start_worker=False,
        desktop_artifact=artifact, desktop_version="9.8.7",
    )
    with TestClient(create_app(settings)) as client:
        headers = {"Authorization": "Bearer release-token"}
        metadata = client.get("/api/desktop/release", headers=headers)
        download = client.get("/api/desktop/update", headers=headers)
    assert metadata.status_code == 200
    assert metadata.json() == {
        "version": "9.8.7", "size": 17,
        "sha256": "565ca0065869f19fb6f475bc79597664d18402914b09becec92f44fd9af71a22",
    }
    assert download.status_code == 200
    assert download.content == b"verified-appimage"
