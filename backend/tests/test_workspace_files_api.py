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


def test_workspace_search_is_owner_scoped_text_only_and_hides_protected_entries(tmp_path):
    settings = _settings(tmp_path)
    root = _register_workspace(settings)
    (root / "README.md").write_text("An agent wrote this.\n", encoding="utf-8")
    source = root / "src"
    source.mkdir()
    (source / "agent.py").write_text("def run_agent():\n    return 'ready'\n", encoding="utf-8")
    (root / "credentials.json").write_text('{"agent": "private"}', encoding="utf-8")
    (source / "binary.bin").write_bytes(b"agent\x00binary")
    foreign_root = settings.data_dir / "workspaces" / "foreign-search"
    foreign_root.mkdir()
    Database(settings.database_path).create_workspace(
        workspace_id="workspace-search-foreign",
        root=str(foreign_root),
        owner_id="different-server-owner",
        project_id="project-test",
        base_revision="b" * 40,
        head_revision="b" * 40,
        generation=1,
        isolation_profile="git-checkout",
    )

    with TestClient(create_app(settings)) as client:
        found = client.get("/api/workspaces/workspace-files-test/files/search?q=agent", headers=HEADERS)
        anonymous = client.get("/api/workspaces/workspace-files-test/files/search?q=agent")
        foreign = client.get("/api/workspaces/workspace-search-foreign/files/search?q=agent", headers=HEADERS)
        blank = client.get("/api/workspaces/workspace-files-test/files/search?q=%20%20", headers=HEADERS)

    assert found.status_code == 200
    result = found.json()
    assert result["hits"] == [
        {"path": "README.md", "line": 1},
        {"path": "src/agent.py", "line": 1},
    ]
    assert result["files_scanned"] == 3
    assert result["bytes_scanned"] == len((root / "README.md").read_bytes()) + len((source / "agent.py").read_bytes())
    assert result["truncated"] is False
    assert "content" not in result["hits"][0]
    assert anonymous.status_code == 401
    assert foreign.status_code == 404
    assert blank.status_code == 400


def test_workspace_search_stops_at_global_file_cap_without_returning_source_text(tmp_path, monkeypatch):
    service = workspace_files.WorkspaceFileService()
    entries = [
        {"name": f"file-{index}.py", "path": f"file-{index}.py", "kind": "file", "size": 20}
        for index in range(3)
    ]
    reads = []
    monkeypatch.setattr(workspace_files, "MAX_SEARCH_FILES", 2)
    monkeypatch.setattr(service, "list_directory", lambda _root, _path, _limit: {
        "path": "", "entries": entries, "truncated": False,
    })

    def read_text(_root, path, _max_bytes):
        reads.append(path)
        return {"path": path, "content": "agent result", "truncated": False}

    monkeypatch.setattr(service, "read_text", read_text)
    result = service.search_text("/unused-in-this-test", "agent")

    assert reads == ["file-0.py", "file-1.py"]
    assert result == {
        "hits": [
            {"path": "file-0.py", "line": 1},
            {"path": "file-1.py", "line": 1},
        ],
        "files_scanned": 2,
        "bytes_scanned": len("agent result") * 2,
        "truncated": True,
    }


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
