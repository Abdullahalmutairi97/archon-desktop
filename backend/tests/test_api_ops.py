import json

import yaml
from fastapi.testclient import TestClient

from archon_server.app import create_app
from archon_server.config import Settings


def test_operational_pages_have_real_backing_data(tmp_path):
    root = tmp_path / "host"
    profile = root / ".hermes/profiles/archon"
    skills = profile / "skills/ops/health"
    backups = root / "backups"
    skills.mkdir(parents=True)
    backups.mkdir(parents=True)
    (root / "hello.txt").write_text("hello")
    (skills / "SKILL.md").write_text("---\nname: health\ndescription: health checks\n---\n")
    (profile / "config.yaml").write_text(yaml.safe_dump({"model": {"provider": "p", "default": "m"}}))
    cron_dir = profile / "cron"
    cron_dir.mkdir()
    (cron_dir / "jobs.json").write_text(json.dumps({"jobs": [{"id": "abc123def456", "name": "Daily", "enabled": True, "schedule_display": "0 7 * * *"}]}))
    (backups / "archon-backup-20260724_040000.tar.gz").write_bytes(b"backup")
    settings = Settings(
        archon_root=root, hermes_home=root / ".hermes", data_dir=root / ".data",
        backup_dir=backups, auth_token="token", start_worker=False,
    )

    with TestClient(create_app(settings)) as client:
        headers = {"Authorization": "Bearer token"}
        assert client.get("/api/status", headers=headers).json()["hostname"]
        names = [item["name"] for item in client.get("/api/files", headers=headers).json()["items"]]
        assert ".hermes" in names
        assert client.get("/api/files/read", params={"path": "hello.txt"}, headers=headers).json()["content"] == "hello"
        assert client.get("/api/models", headers=headers).json()["current"]["model"] == "m"
        assert client.get("/api/skills", headers=headers).json()["skills"][0]["name"] == "health"
        assert client.get("/api/backups", headers=headers).json()["backups"][0]["id"] == "20260724_040000"
        assert client.get("/api/cron", headers=headers).json()["jobs"][0]["id"] == "abc123def456"
        manifest = client.get("/api/migration/manifest", headers=headers).json()
        assert manifest["portable"] is True
        assert "secrets" not in json.dumps(manifest).lower() or manifest["secrets_included"] is False


def test_file_write_and_destructive_routes_require_confirmation(tmp_path):
    root = tmp_path / "host"
    root.mkdir()
    settings = Settings(archon_root=root, hermes_home=root / ".hermes", data_dir=root / ".data", auth_token="token", start_worker=False)
    headers = {"Authorization": "Bearer token"}

    with TestClient(create_app(settings)) as client:
        response = client.put("/api/files/text", json={"path": "note.txt", "content": "saved"}, headers=headers)
        assert response.status_code == 200
        assert (root / "note.txt").read_text() == "saved"

        blocked = client.request("DELETE", "/api/files", json={"path": "note.txt", "confirm": False}, headers=headers)
        assert blocked.status_code == 403
        deleted = client.request("DELETE", "/api/files", json={"path": "note.txt", "confirm": True}, headers=headers)
        assert deleted.status_code == 200
        assert not (root / "note.txt").exists()
