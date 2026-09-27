from __future__ import annotations

import os
from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from archon_server.app import create_app
from archon_server.config import Settings
from archon_server.db import Database
from archon_server import workspace_files


TOKEN = "workspace-files-test-token"
HEADERS = {"Authorization": f"Bearer {TOKEN}"}


def _settings(tmp_path: Path) -> Settings:
    return Settings(
        archon_root=tmp_path,
        hermes_home=tmp_path / ".hermes",
        data_dir=tmp_path / ".data",
        auth_token=TOKEN,
        start_worker=False,
    )


def _register_workspace(settings: Settings, workspace_id: str = "workspace-files-test") -> Path:
    root = settings.data_dir / "workspaces" / workspace_id
    root.mkdir(parents=True)
    root.chmod(0o700)
    Database(settings.database_path).create_workspace(
        workspace_id=workspace_id,
        root=str(root),
        owner_id=f"local-uid:{os.geteuid()}",
        project_id="project-test",
        base_revision="a" * 40,
        head_revision="a" * 40,
        generation=1,
        isolation_profile="git-checkout",
    )
    return root


def test_workspace_file_endpoints_require_auth_and_registered_owner(tmp_path):
    settings = _settings(tmp_path)
    root = _register_workspace(settings)
    foreign_root = settings.data_dir / "workspaces" / "foreign-root"
    foreign_root.mkdir()
    Database(settings.database_path).create_workspace(
        workspace_id="workspace-foreign",
        root=str(foreign_root),
        owner_id="different-server-owner",
        project_id="project-test",
        base_revision="b" * 40,
        head_revision="b" * 40,
        generation=1,
        isolation_profile="git-checkout",
    )
    (root / "readme.txt").write_text("registered checkout", encoding="utf-8")

    with TestClient(create_app(settings)) as client:
        anonymous = client.get("/api/workspaces/workspace-files-test/files")
        unknown = client.get("/api/workspaces/not-registered/files", headers=HEADERS)
        foreign = client.get("/api/workspaces/workspace-foreign/files", headers=HEADERS)
        valid = client.get("/api/workspaces/workspace-files-test/files/read?path=readme.txt", headers=HEADERS)

    assert anonymous.status_code == 401
    assert unknown.status_code == 404
    assert foreign.status_code == 404
    assert valid.status_code == 200
    assert valid.json() == {
        "path": "readme.txt",
        "content": "registered checkout",
        "truncated": False,
    }


def test_workspace_listing_and_text_read_are_bounded_and_hide_sensitive_entries(tmp_path):
    settings = _settings(tmp_path)
    root = _register_workspace(settings)
    (root / "README.md").write_text("visible", encoding="utf-8")
    (root / "src").mkdir()
    (root / "src" / "main.py").write_text("hello world", encoding="utf-8")
    (root / ".git").mkdir()
    (root / ".git" / "config").write_text("git internals", encoding="utf-8")
    (root / ".env").write_text("PASSWORD=private", encoding="utf-8")
    (root / ".env.production").write_text("TOKEN=private", encoding="utf-8")
    (root / "credentials.json").write_text('{"token":"private"}', encoding="utf-8")
    (root / "id_rsa").write_text("PRIVATE KEY", encoding="utf-8")
    (root / "visible-extra.txt").write_text("extra", encoding="utf-8")

    with TestClient(create_app(settings)) as client:
        listing = client.get("/api/workspaces/workspace-files-test/files?limit=1", headers=HEADERS)
        nested = client.get(
            "/api/workspaces/workspace-files-test/files/read?path=src%2Fmain.py&max_bytes=5",
            headers=HEADERS,
        )
        full = client.get(
            "/api/workspaces/workspace-files-test/files/read?path=src%2Fmain.py",
            headers=HEADERS,
        )

    assert listing.status_code == 200
    listing_body = listing.json()
    assert len(listing_body["entries"]) == 1
    assert listing_body["truncated"] is True
    listed_names = {entry["name"] for entry in listing_body["entries"]}
    assert not listed_names.intersection({".git", ".env", ".env.production", "credentials.json", "id_rsa"})
    assert nested.status_code == 200
    assert nested.json() == {"path": "src/main.py", "content": "hello", "truncated": True}
    assert full.json()["content"] == "hello world"
    assert full.json()["truncated"] is False


def test_workspace_file_paths_cannot_escape_or_read_protected_or_binary_files(tmp_path):
    settings = _settings(tmp_path)
    root = _register_workspace(settings)
    (root / "ordinary.txt").write_text("safe", encoding="utf-8")
    (root / "binary.bin").write_bytes(b"\x00\x01\x02")
    (root / "credentials.txt").write_text("secret", encoding="utf-8")
    (root / ".git").mkdir()
    (root / ".git" / "config").write_text("secret", encoding="utf-8")

    with TestClient(create_app(settings)) as client:
        traversal = client.get(
            "/api/workspaces/workspace-files-test/files/read?path=..%2Foutside.txt", headers=HEADERS,
        )
        absolute = client.get(
            "/api/workspaces/workspace-files-test/files/read?path=%2Fetc%2Fpasswd", headers=HEADERS,
        )
        git_metadata = client.get(
            "/api/workspaces/workspace-files-test/files/read?path=.git%2Fconfig", headers=HEADERS,
        )
        credential = client.get(
            "/api/workspaces/workspace-files-test/files/read?path=credentials.txt", headers=HEADERS,
        )
        binary = client.get(
            "/api/workspaces/workspace-files-test/files/read?path=binary.bin", headers=HEADERS,
        )

    assert traversal.status_code == 400
    assert absolute.status_code == 400
    assert git_metadata.status_code == 404
    assert credential.status_code == 404
    assert binary.status_code == 415


def test_workspace_file_api_hides_common_container_cloud_and_terraform_credentials(tmp_path):
    settings = _settings(tmp_path)
    root = _register_workspace(settings)
    (root / "visible.txt").write_text("visible", encoding="utf-8")
    for directory in (".docker", ".kube"):
        secret_dir = root / directory
        secret_dir.mkdir()
        (secret_dir / "config.json" if directory == ".docker" else secret_dir / "config").write_text(
            "credential material", encoding="utf-8",
        )
    (root / "terraform.tfstate").write_text("state credentials", encoding="utf-8")
    (root / "terraform.tfstate.backup").write_text("backup credentials", encoding="utf-8")

    with TestClient(create_app(settings)) as client:
        listing = client.get("/api/workspaces/workspace-files-test/files", headers=HEADERS)
        docker_config = client.get(
            "/api/workspaces/workspace-files-test/files/read?path=.docker%2Fconfig.json", headers=HEADERS,
        )
        kube_config = client.get(
            "/api/workspaces/workspace-files-test/files/read?path=.kube%2Fconfig", headers=HEADERS,
        )
        terraform_state = client.get(
            "/api/workspaces/workspace-files-test/files/read?path=terraform.tfstate", headers=HEADERS,
        )
        terraform_backup = client.get(
            "/api/workspaces/workspace-files-test/files/read?path=terraform.tfstate.backup", headers=HEADERS,
        )

    assert listing.status_code == 200
    assert {entry["name"] for entry in listing.json()["entries"]} == {"visible.txt"}
    assert docker_config.status_code == 404
    assert kube_config.status_code == 404
    assert terraform_state.status_code == 404
    assert terraform_backup.status_code == 404


def test_workspace_file_api_never_follows_tree_or_root_symlinks(tmp_path):
    settings = _settings(tmp_path)
    root = _register_workspace(settings)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("must not be returned", encoding="utf-8")
    (root / "linked-directory").symlink_to(outside, target_is_directory=True)
    (root / "linked-file.txt").symlink_to(outside / "secret.txt")
    (root / "visible.txt").write_text("visible", encoding="utf-8")

    with TestClient(create_app(settings)) as client:
        listing = client.get("/api/workspaces/workspace-files-test/files", headers=HEADERS)
        linked_directory = client.get(
            "/api/workspaces/workspace-files-test/files?path=linked-directory", headers=HEADERS,
        )
        linked_file = client.get(
            "/api/workspaces/workspace-files-test/files/read?path=linked-file.txt", headers=HEADERS,
        )

        moved = root.with_name("workspace-files-test-moved")
        root.rename(moved)
        root.symlink_to(outside, target_is_directory=True)
        replaced_root = client.get("/api/workspaces/workspace-files-test/files", headers=HEADERS)

    assert listing.status_code == 200
    assert {entry["name"] for entry in listing.json()["entries"]} == {"visible.txt"}
    assert linked_directory.status_code == 404
    assert linked_file.status_code == 404
    assert replaced_root.status_code == 404
    assert "must not be returned" not in replaced_root.text


def test_workspace_file_api_rejects_workspace_root_that_is_not_private(tmp_path):
    settings = _settings(tmp_path)
    root = _register_workspace(settings)
    (root / "visible.txt").write_text("visible", encoding="utf-8")
    root.chmod(0o755)

    with TestClient(create_app(settings)) as client:
        response = client.get("/api/workspaces/workspace-files-test/files", headers=HEADERS)

    assert response.status_code == 404
    assert "visible.txt" not in response.text


def test_deep_workspace_paths_are_rejected_before_opening_component_fds(tmp_path, monkeypatch):
    settings = _settings(tmp_path)
    root = _register_workspace(settings)
    deep_path = "/".join(f"d{index}" for index in range(workspace_files.MAX_COMPONENT_DEPTH))

    with TestClient(create_app(settings)) as client:
        response = client.get(
            "/api/workspaces/workspace-files-test/files",
            headers=HEADERS,
            params={"path": deep_path},
        )

    opened = []
    real_open = workspace_files.os.open

    def tracking_open(*args, **kwargs):
        opened.append(args[0] if args else None)
        return real_open(*args, **kwargs)

    monkeypatch.setattr(workspace_files.os, "open", tracking_open)
    with pytest.raises(workspace_files.WorkspaceFilesError) as error:
        workspace_files.WorkspaceFileService().list_directory(str(root), deep_path)

    assert response.status_code == 400
    assert response.json()["detail"] == "Workspace path is too deep"
    assert error.value.status_code == 400
    assert opened == []
