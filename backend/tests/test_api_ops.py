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
    prime_skills = root / ".prime/bundled-skills/health"
    prime_skills.mkdir(parents=True)
    (prime_skills / "SKILL.md").write_text("---\nname: health\ndescription: health checks\n---\n")
    (profile / "config.yaml").write_text(yaml.safe_dump({"model": {"provider": "openai-codex", "default": "gpt-5.6-sol"}}))
    prime_auth = root / ".prime/agent/auth.json"
    prime_auth.parent.mkdir(parents=True)
    prime_auth.write_text(json.dumps({"openai-codex": {"access": "test-token"}}))
    cron_dir = profile / "cron"
    cron_dir.mkdir()
    (cron_dir / "jobs.json").write_text(json.dumps({"jobs": [{"id": "abc123def456", "name": "Daily", "enabled": True, "schedule_display": "0 7 * * *"}]}))
    (backups / "archon-backup-20260724_040000.tar.gz").write_bytes(b"backup")
    settings = Settings(
        archon_root=root, hermes_home=root / ".hermes", data_dir=root / ".data",
        backup_dir=backups, auth_token="token", start_worker=False, profile="archon",
        prime_auth_path=prime_auth,
        prime_bundled_skills_dir=prime_skills.parent,
        prime_user_skills_dir=root / ".prime/user-skills",
    )

    with TestClient(create_app(settings)) as client:
        headers = {"Authorization": "Bearer token"}
        assert client.get("/api/status", headers=headers).json()["hostname"]
        names = [item["name"] for item in client.get("/api/files", headers=headers).json()["items"]]
        assert ".hermes" in names
        assert client.get("/api/files", params={"path": "hello.txt"}, headers=headers).status_code == 400
        assert client.get("/api/files/read", params={"path": "hello.txt"}, headers=headers).json()["content"] == "hello"
        assert client.get("/api/models", headers=headers).json()["current"]["model"] == "gpt-5.6-sol"
        assert client.get("/api/skills", headers=headers).json()["skills"][0]["name"] == "health"
        assert client.get("/api/backups", headers=headers).json()["backups"][0]["id"] == "20260724_040000"
        assert client.get("/api/cron", headers=headers).json()["jobs"][0]["id"] == "abc123def456"
        manifest = client.get("/api/migration/manifest", headers=headers).json()
        assert manifest["portable"] is True
        assert "secrets" not in json.dumps(manifest).lower() or manifest["secrets_included"] is False


def test_file_write_and_destructive_routes_require_confirmation(tmp_path):
    root = tmp_path / "host"
    root.mkdir()
    settings = Settings(archon_root=root, hermes_home=root / ".hermes", data_dir=root / ".data", auth_token="token", start_worker=False, profile="archon")
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


def test_project_creation_creates_registered_folder(tmp_path):
    root = tmp_path / "host"
    root.mkdir()
    settings = Settings(
        archon_root=root, hermes_home=root / ".hermes", data_dir=root / ".data",
        auth_token="token", start_worker=False, profile="archon",
        prime_agent_session_dir=root / ".prime/agent/sessions",
    )
    headers = {"Authorization": "Bearer token"}
    session_id = "01a0-project-assignment-test"
    settings.prime_agent_session_dir.mkdir(parents=True)
    records = [
        {"type": "session", "id": session_id, "parentId": None, "timestamp": "2026-08-19T10:00:00Z", "cwd": str(root / "elsewhere")},
        {"type": "message", "id": "u", "parentId": session_id, "timestamp": "2026-08-19T10:00:01Z", "message": {"role": "user", "content": [{"type": "text", "text": "test"}]}},
        {"type": "message", "id": "a", "parentId": "u", "timestamp": "2026-08-19T10:00:02Z", "message": {"role": "assistant", "content": [{"type": "text", "text": "done"}]}},
    ]
    (settings.prime_agent_session_dir / f"{session_id}.jsonl").write_text("\n".join(json.dumps(row) for row in records) + "\n")
    app = create_app(settings)

    with TestClient(app) as client:
        queued = app.state.store.submit("queued", session_id=session_id)
        active_row = next(row for row in client.get("/api/sessions", headers=headers).json()["sessions"] if row["id"] == session_id)
        assert active_row["active"] is True
        app.state.store.complete(queued["id"], {"text": "done"})
        idle_row = next(row for row in client.get("/api/sessions", headers=headers).json()["sessions"] if row["id"] == session_id)
        assert idle_row["active"] is False

        created = client.post("/api/projects", json={"name": "Demo Project"}, headers=headers)
        assert created.status_code == 200
        project = created.json()["project"]
        assert project["name"] == "Demo Project"
        assert project["primary_path"] == str(root / "demo-project")
        assert (root / "demo-project").is_dir()
        assert client.get("/api/projects", headers=headers).json()["projects"] == [project]
        assert client.post("/api/projects", json={"name": "Demo Project"}, headers=headers).status_code == 409
        orphan = root / "orphan-on-conflict"
        assert client.post(
            "/api/projects", json={"name": "Demo Project", "path": str(orphan)}, headers=headers
        ).status_code == 409
        assert not orphan.exists()
        assert client.post(
            "/api/projects", json={"name": "Outside", "path": str(tmp_path.parent / "outside")}, headers=headers
        ).status_code == 400

        attached = client.put(
            f"/api/sessions/{session_id}/project", json={"project_id": project["id"]}, headers=headers
        )
        assert attached.status_code == 200
        session = next(row for row in client.get("/api/sessions", headers=headers).json()["sessions"] if row["id"] == session_id)
        assert session["project_id"] == project["id"]

        detached = client.put(f"/api/sessions/{session_id}/project", json={"project_id": None}, headers=headers)
        assert detached.status_code == 200
        session = next(row for row in client.get("/api/sessions", headers=headers).json()["sessions"] if row["id"] == session_id)
        assert session["project_id"] is None

        assert client.put(
            f"/api/sessions/{session_id}/project", json={"project_id": project["id"]}, headers=headers
        ).status_code == 200
        deleted = client.delete(f"/api/projects/{project['id']}", headers=headers)
        assert deleted.status_code == 200
        assert deleted.json()["files_preserved"] is True
        assert (root / "demo-project").is_dir()
        assert client.get("/api/projects", headers=headers).json()["projects"] == []
        session = next(row for row in client.get("/api/sessions", headers=headers).json()["sessions"] if row["id"] == session_id)
        assert session["project_id"] is None


def test_new_task_reserves_project_before_prime_session_exists(tmp_path):
    executable = tmp_path / "fake-prime"
    executable.write_text("#!/bin/sh\nexit 99\n")
    executable.chmod(0o700)
    root = tmp_path / "host"
    root.mkdir()
    settings = Settings(
        archon_root=root, hermes_home=root / ".hermes", data_dir=root / ".data",
        auth_token="token", start_worker=False, profile="archon",
        prime_agent_session_dir=root / ".prime/agent/sessions",
        prime_executable=executable,
    )
    headers = {"Authorization": "Bearer token"}
    app = create_app(settings)
    with TestClient(app) as client:
        project = client.post("/api/projects", json={"name": "Tracked Project"}, headers=headers).json()["project"]
        response = client.post("/api/tasks", json={
            "prompt": "long regression prompt", "cwd": project["primary_path"],
            "project_id": project["id"], "approval_mode": "auto",
        }, headers=headers)
        assert response.status_code == 202
        task = response.json()["task"]
        predicted = f"prime-{task['id']}"
        with app.state.store.db.connect() as conn:
            row = conn.execute("SELECT project_id FROM session_projects WHERE session_id=?", (predicted,)).fetchone()
        assert row["project_id"] == project["id"]


def test_logs_honor_source_and_minimum_level_filters(tmp_path):
    root = tmp_path / "host"
    root.mkdir()
    settings = Settings(
        archon_root=root, hermes_home=root / ".hermes", data_dir=root / ".data",
        auth_token="token", start_worker=False, profile="archon",
        prime_agent_session_dir=root / ".prime/agent/sessions",
    )
    headers = {"Authorization": "Bearer token"}
    app = create_app(settings)
    with TestClient(app) as client:
        queued = app.state.store.submit("ok")
        app.state.store.complete(queued["id"], {"text": "done"})
        failed = app.state.store.submit("bad")
        app.state.store.fail(failed["id"], "failure")

        assert len(client.get("/api/logs", headers=headers).json()["logs"]) == 4
        assert client.get("/api/logs", params={"sources": "agent"}, headers=headers).json()["logs"] == []
        errors = client.get("/api/logs", params={"level": "ERROR"}, headers=headers).json()["logs"]
        assert len(errors) == 1 and errors[0]["level"] == "ERROR"


def test_upload_uses_safe_atomic_temp_file_and_rejects_outside_path(tmp_path):
    root = tmp_path / "host"
    root.mkdir()
    settings = Settings(archon_root=root, hermes_home=root / ".hermes", data_dir=root / ".data", auth_token="token", start_worker=False, profile="archon")
    headers = {"Authorization": "Bearer token"}
    with TestClient(create_app(settings)) as client:
        uploaded = client.post("/api/files/upload", params={"path": "nested/file.txt"}, files={"upload": ("file.txt", b"hello", "text/plain")}, headers=headers)
        assert uploaded.status_code == 200
        assert uploaded.json()["size"] == 5
        assert (root / "nested/file.txt").read_bytes() == b"hello"
        outside = client.post("/api/files/upload", params={"path": "../escape.txt"}, files={"upload": ("file.txt", b"no", "text/plain")}, headers=headers)
        assert outside.status_code == 400
        assert not (root.parent / "escape.txt").exists()
