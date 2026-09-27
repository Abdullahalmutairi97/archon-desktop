from __future__ import annotations

import os
import subprocess
from pathlib import Path

from fastapi.testclient import TestClient

from archon_server.app import create_app
from archon_server.config import Settings
from archon_server.db import Database
from archon_server.services.workspace import ProjectService


def _git(cwd: Path, *arguments: str) -> str:
    completed = subprocess.run(
        ["git", *arguments], cwd=cwd, check=True, capture_output=True, text=True,
    )
    return completed.stdout.strip()


def _registered_git_project(tmp_path: Path, settings: Settings) -> tuple[dict, str, Path]:
    source = tmp_path / "source-project"
    source.mkdir()
    _git(source, "init", "--quiet")
    _git(source, "config", "user.name", "API Fixture")
    _git(source, "config", "user.email", "api-fixture@example.invalid")
    (source / "README.md").write_text("pinned checkout\n", encoding="utf-8")
    _git(source, "add", "README.md")
    _git(source, "commit", "--quiet", "-m", "fixture")
    revision = _git(source, "rev-parse", "HEAD")
    projects = ProjectService(settings.profile_home / "projects.db")
    project = projects.create("API fixture project", source)
    return project, revision, source


def _settings(tmp_path: Path) -> Settings:
    return Settings(
        archon_root=tmp_path,
        hermes_home=tmp_path / ".hermes",
        data_dir=tmp_path / ".data",
        auth_token="workspace-api-token",
        start_worker=False,
    )


def test_workspace_provision_api_requires_existing_bearer_auth(tmp_path):
    settings = _settings(tmp_path)
    with TestClient(create_app(settings)) as client:
        response = client.post("/api/workspaces", json={"project_id": "project-known", "revision": "a" * 40})

    assert response.status_code == 401
    assert not (settings.data_dir / "workspaces").exists()


def test_workspace_provision_api_creates_registered_revision_pinned_checkout(tmp_path):
    settings = _settings(tmp_path)
    project, revision, source = _registered_git_project(tmp_path, settings)
    headers = {"Authorization": "Bearer workspace-api-token"}

    with TestClient(create_app(settings)) as client:
        response = client.post(
            "/api/workspaces",
            headers=headers,
            json={"project_id": project["id"], "revision": revision},
        )

    assert response.status_code == 200
    workspace = response.json()["workspace"]
    root = Path(workspace["root"])
    assert root.is_relative_to((settings.data_dir / "workspaces").resolve())
    assert root != source.resolve()
    assert (root / "README.md").read_text(encoding="utf-8") == "pinned checkout\n"
    assert _git(root, "rev-parse", "HEAD") == revision
    assert not (root / ".git" / "objects" / "info" / "alternates").exists()
    assert workspace == {
        "workspace_id": workspace["workspace_id"],
        "root": str(root),
        "project_id": project["id"],
        "base_revision": revision,
        "head_revision": revision,
        "generation": 1,
    }
    persisted = Database(settings.database_path).get_workspace(workspace["workspace_id"])
    assert persisted["root"] == workspace["root"]
    assert persisted["owner_id"] == f"local-uid:{os.geteuid()}"
    assert persisted["isolation_profile"] == "git-checkout"


def test_workspace_provision_api_rejects_abbreviated_revision_and_client_owned_fields(tmp_path):
    settings = _settings(tmp_path)
    headers = {"Authorization": "Bearer workspace-api-token"}
    with TestClient(create_app(settings)) as client:
        abbreviated = client.post(
            "/api/workspaces", headers=headers,
            json={"project_id": "project-known", "revision": "a" * 12},
        )
        client_owned = client.post(
            "/api/workspaces", headers=headers,
            json={
                "project_id": "project-known",
                "revision": "a" * 40,
                "root": str(tmp_path / "attacker-controlled"),
                "owner_id": "attacker",
                "isolation_profile": "sandboxed",
            },
        )

    assert abbreviated.status_code == 422
    assert client_owned.status_code == 422
    assert not (tmp_path / "attacker-controlled").exists()
    assert not (settings.data_dir / "workspaces").exists()


def test_workspace_provision_api_rejects_unregistered_project(tmp_path):
    settings = _settings(tmp_path)
    headers = {"Authorization": "Bearer workspace-api-token"}
    with TestClient(create_app(settings)) as client:
        response = client.post(
            "/api/workspaces", headers=headers,
            json={"project_id": "project-from-client", "revision": "a" * 40},
        )

    assert response.status_code == 400
    assert "registered project" in response.json()["detail"]
