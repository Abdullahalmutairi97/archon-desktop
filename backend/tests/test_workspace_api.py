from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest
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


def test_register_existing_git_project_only_accepts_usable_checkout(tmp_path):
    settings = _settings(tmp_path)
    source = tmp_path / "register-source"
    source.mkdir()
    _git(source, "init", "--quiet")
    _git(source, "config", "user.name", "API Fixture")
    _git(source, "config", "user.email", "api-fixture@example.invalid")
    (source / "README.md").write_text("ready\n", encoding="utf-8")
    _git(source, "add", "README.md")
    _git(source, "commit", "--quiet", "-m", "fixture")
    headers = {"Authorization": "Bearer workspace-api-token"}
    plain = tmp_path / "not-git"
    plain.mkdir()
    absent = tmp_path / "absent"

    with TestClient(create_app(settings)) as client:
        for path in (plain, absent):
            response = client.post("/api/projects", headers=headers, json={
                "name": path.name, "path": str(path), "existing_git": True,
            })
            assert response.status_code in (400, 409)
        relative = client.post("/api/projects", headers=headers, json={
            "name": "relative", "path": "register-source", "existing_git": True,
        })
        assert relative.status_code == 400
        assert not absent.exists()
        assert client.get("/api/projects", headers=headers).json()["projects"] == []

        response = client.post("/api/projects", headers=headers, json={
            "name": "Registered source", "path": str(source), "existing_git": True,
        })
        assert response.status_code == 200
        project = response.json()["project"]
        assert project["primary_path"] == str(source)
        head = client.get(f"/api/projects/{project['id']}/head", headers=headers)
        assert head.json()["revision"] == _git(source, "rev-parse", "HEAD")


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
        workspace = response.json()["workspace"]
        detail_response = client.get(f"/api/workspaces/{workspace['workspace_id']}", headers=headers)
        list_response = client.get("/api/workspaces", headers=headers)

    assert response.status_code == 200
    assert detail_response.status_code == 200
    assert detail_response.json() == {"workspace": workspace}
    assert list_response.status_code == 200
    assert list_response.json() == {"workspaces": [workspace]}
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


def test_workspace_task_is_bound_to_the_provisioned_checkout_and_attempt(tmp_path):
    settings = _settings(tmp_path)
    project, revision, _source = _registered_git_project(tmp_path, settings)
    headers = {"Authorization": "Bearer workspace-api-token"}

    with TestClient(create_app(settings, runner=object())) as client:
        provision = client.post(
            "/api/workspaces", headers=headers,
            json={"project_id": project["id"], "revision": revision},
        )
        workspace = provision.json()["workspace"]
        submitted = client.post(
            "/api/workspace-tasks", headers=headers,
            json={
                "workspace_id": workspace["workspace_id"],
                "workspace_generation": workspace["generation"],
                "prompt": "Inspect the checkout and summarize its README.",
            },
        )
        assert submitted.status_code == 202, submitted.text
        task = submitted.json()["task"]
        assert task["cwd"] == workspace["root"]
        assert task["project_id"] == project["id"]
        assert task["runtime_id"] == "prime"
        assert task["profile"] == "prime"
        assert task["approval_mode"] == "auto"
        assert task["workspace_id"] == workspace["workspace_id"]
        assert task["workspace_generation"] == workspace["generation"]
        assert task["session_id"]

        # The same owner/project/root/generation checks run immediately before
        # dispatch; then the attempt durably snapshots the workspace identity.
        client.app.state.engine.preflight(task)
        claimed = client.app.state.store.claim_next()
        assert claimed["id"] == task["id"]
        with client.app.state.store.db.connect() as conn:
            attempt = conn.execute(
                "SELECT workspace_id,workspace_generation FROM task_attempts WHERE task_id=?",
                (task["id"],),
            ).fetchone()
        assert tuple(attempt) == (workspace["workspace_id"], workspace["generation"])
        with client.app.state.store.db.transaction() as conn:
            conn.execute(
                "UPDATE workspaces SET generation=generation+1 WHERE workspace_id=?",
                (workspace["workspace_id"],),
            )
        with pytest.raises(ValueError, match="generation"):
            client.app.state.engine.preflight(claimed)


def test_workspace_task_rejects_stale_generation_and_client_paths(tmp_path):
    settings = _settings(tmp_path)
    project, revision, _source = _registered_git_project(tmp_path, settings)
    headers = {"Authorization": "Bearer workspace-api-token"}

    with TestClient(create_app(settings)) as client:
        provision = client.post(
            "/api/workspaces", headers=headers,
            json={"project_id": project["id"], "revision": revision},
        )
        workspace = provision.json()["workspace"]
        body = {
            "workspace_id": workspace["workspace_id"],
            "workspace_generation": workspace["generation"],
            "prompt": "Run in the selected checkout.",
        }
        stale = client.post(
            "/api/workspace-tasks", headers=headers,
            json={**body, "workspace_generation": workspace["generation"] + 1},
        )
        client_cwd = client.post(
            "/api/workspace-tasks", headers=headers,
            json={**body, "cwd": str(tmp_path)},
        )
        client_session = client.post(
            "/api/workspace-tasks", headers=headers,
            json={**body, "session_id": "attacker-selected"},
        )

    assert stale.status_code == 409
    assert client_cwd.status_code == 422
    assert client_session.status_code == 422


def test_project_head_api_returns_safe_registered_full_commit_without_checkout(tmp_path):
    settings = _settings(tmp_path)
    project, revision, source = _registered_git_project(tmp_path, settings)
    headers = {"Authorization": "Bearer workspace-api-token"}

    with TestClient(create_app(settings)) as client:
        unauthorized = client.get(f"/api/projects/{project['id']}/head")
        response = client.get(f"/api/projects/{project['id']}/head", headers=headers)
        missing = client.get("/api/projects/project-unknown/head", headers=headers)
        _git(source, "config", "core.sshCommand", "echo should-not-run")
        unsafe = client.get(f"/api/projects/{project['id']}/head", headers=headers)

    assert unauthorized.status_code == 401
    assert response.status_code == 200
    assert response.json() == {"revision": revision}
    assert len(response.json()["revision"]) in {40, 64}
    assert missing.status_code == 404
    assert unsafe.status_code == 409
    assert not (settings.data_dir / "workspaces").exists()


def test_workspace_reads_hide_workspaces_owned_by_another_server_identity(tmp_path):
    settings = _settings(tmp_path)
    foreign_root = tmp_path / "foreign-workspace-root"
    foreign_root.mkdir(mode=0o700)
    database = Database(settings.database_path)
    foreign = database.create_workspace(
        workspace_id="workspace-foreign-owner",
        root=str(foreign_root),
        owner_id="different-server-owner",
        project_id="project-foreign",
        base_revision="a" * 40,
        head_revision="a" * 40,
        generation=1,
        isolation_profile="git-checkout",
    )
    headers = {"Authorization": "Bearer workspace-api-token"}

    with TestClient(create_app(settings)) as client:
        detail_response = client.get(f"/api/workspaces/{foreign['workspace_id']}", headers=headers)
        list_response = client.get(
            "/api/workspaces?owner_id=different-server-owner", headers=headers,
        )

    assert detail_response.status_code == 404
    assert list_response.status_code == 200
    assert list_response.json() == {"workspaces": []}
