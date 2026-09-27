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
        anonymous_write = client.post(
            "/api/workspaces/workspace-files-test/files/write",
            json={"path": "readme.txt", "expected_content": "registered checkout", "content": "changed"},
        )
        anonymous_create = client.post(
            "/api/workspaces/workspace-files-test/files/create",
            json={"path": "new.txt", "content": "created"},
        )
        foreign_write = client.post(
            "/api/workspaces/workspace-foreign/files/write",
            headers=HEADERS,
            json={"path": "readme.txt", "expected_content": "", "content": "changed"},
        )
        foreign_create = client.post(
            "/api/workspaces/workspace-foreign/files/create",
            headers=HEADERS,
            json={"path": "new.txt", "content": "created"},
        )

    assert anonymous.status_code == 401
    assert unknown.status_code == 404
    assert foreign.status_code == 404
    assert valid.status_code == 200
    assert anonymous_write.status_code == 401
    assert anonymous_create.status_code == 401
    assert foreign_write.status_code == 404
    assert foreign_create.status_code == 404
    assert not (root / "new.txt").exists()
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


def test_workspace_file_write_replaces_existing_text_and_rejects_stale_or_unsafe_targets(tmp_path):
    settings = _settings(tmp_path)
    root = _register_workspace(settings)
    visible = root / "visible.txt"
    visible.write_text("before\n", encoding="utf-8")
    outside = tmp_path / "outside.txt"
    outside.write_text("external", encoding="utf-8")
    (root / "linked.txt").symlink_to(outside)
    (root / ".env").write_text("TOKEN=private", encoding="utf-8")
    (root / "linked-hard.txt").write_text("shared", encoding="utf-8")
    os.link(root / "linked-hard.txt", root / "another-link.txt")

    with TestClient(create_app(settings)) as client:
        saved = client.post(
            "/api/workspaces/workspace-files-test/files/write",
            headers=HEADERS,
            json={"path": "visible.txt", "expected_content": "before\n", "content": "after\n"},
        )
        stale = client.post(
            "/api/workspaces/workspace-files-test/files/write",
            headers=HEADERS,
            json={"path": "visible.txt", "expected_content": "before\n", "content": "stale\n"},
        )
        symlink = client.post(
            "/api/workspaces/workspace-files-test/files/write",
            headers=HEADERS,
            json={"path": "linked.txt", "expected_content": "external", "content": "changed"},
        )
        protected = client.post(
            "/api/workspaces/workspace-files-test/files/write",
            headers=HEADERS,
            json={"path": ".env", "expected_content": "TOKEN=private", "content": "changed"},
        )
        hardlink = client.post(
            "/api/workspaces/workspace-files-test/files/write",
            headers=HEADERS,
            json={"path": "linked-hard.txt", "expected_content": "shared", "content": "changed"},
        )

    assert saved.status_code == 200
    assert saved.json() == {"path": "visible.txt", "content": "after\n"}
    assert visible.read_text(encoding="utf-8") == "after\n"
    assert stale.status_code == 409
    assert visible.read_text(encoding="utf-8") == "after\n"
    assert symlink.status_code == 404
    assert outside.read_text(encoding="utf-8") == "external"
    assert protected.status_code == 404
    assert hardlink.status_code == 404
    assert (root / "linked-hard.txt").read_text(encoding="utf-8") == "shared"
    assert not list(root.glob(".archon-workspace-write-*.tmp"))


def test_workspace_file_create_writes_utf8_with_private_mode(tmp_path):
    settings = _settings(tmp_path)
    root = _register_workspace(settings)

    with TestClient(create_app(settings)) as client:
        response = client.post(
            "/api/workspaces/workspace-files-test/files/create",
            headers=HEADERS,
            json={"path": "src/new.txt", "content": "hello 🌿\n"},
        )
        created = root / "src" / "new.txt"
        assert response.status_code == 404  # Parent directories are never created implicitly.
        assert not created.exists()

        (root / "src").mkdir()
        response = client.post(
            "/api/workspaces/workspace-files-test/files/create",
            headers=HEADERS,
            json={"path": "src/new.txt", "content": "hello 🌿\n"},
        )

    assert response.status_code == 200
    assert response.json() == {"path": "src/new.txt", "content": "hello 🌿\n"}
    assert created.read_bytes() == "hello 🌿\n".encode("utf-8")
    assert created.stat().st_mode & 0o777 == 0o600


def test_workspace_file_create_conflicts_on_existing_entries_and_rejects_unsafe_text(tmp_path):
    settings = _settings(tmp_path)
    root = _register_workspace(settings)
    existing = root / "existing.txt"
    existing.write_text("keep", encoding="utf-8")
    outside = tmp_path / "outside.txt"
    outside.write_text("external", encoding="utf-8")
    (root / "linked.txt").symlink_to(outside)

    with TestClient(create_app(settings)) as client:
        duplicate = client.post(
            "/api/workspaces/workspace-files-test/files/create",
            headers=HEADERS,
            json={"path": "existing.txt", "content": "overwrite"},
        )
        symlink = client.post(
            "/api/workspaces/workspace-files-test/files/create",
            headers=HEADERS,
            json={"path": "linked.txt", "content": "overwrite"},
        )
        traversal = client.post(
            "/api/workspaces/workspace-files-test/files/create",
            headers=HEADERS,
            json={"path": "../outside.txt", "content": "escape"},
        )
        control = client.post(
            "/api/workspaces/workspace-files-test/files/create",
            headers=HEADERS,
            json={"path": "control.txt", "content": "bad\x01text"},
        )
        too_many_bytes = client.post(
            "/api/workspaces/workspace-files-test/files/create",
            headers=HEADERS,
            json={"path": "large.txt", "content": "🌿" * 5_000},
        )

    assert duplicate.status_code == 409
    assert symlink.status_code == 409
    assert traversal.status_code == 400
    assert control.status_code == 400
    assert too_many_bytes.status_code == 400
    assert existing.read_text(encoding="utf-8") == "keep"
    assert outside.read_text(encoding="utf-8") == "external"
    assert not (root / "control.txt").exists()
    assert not (root / "large.txt").exists()


def test_workspace_file_create_is_blocked_while_a_task_uses_the_workspace(tmp_path):
    settings = _settings(tmp_path)
    root = _register_workspace(settings)
    with Database(settings.database_path).connect() as conn:
        conn.execute(
            "INSERT INTO tasks(id,prompt,cwd,status,created_at,updated_at) "
            "VALUES ('active-workspace-task','in progress',?,'running','now','now')",
            (str(root),),
        )

    with TestClient(create_app(settings)) as client:
        response = client.post(
            "/api/workspaces/workspace-files-test/files/create",
            headers=HEADERS,
            json={"path": "new.txt", "content": "must wait"},
        )

    assert response.status_code == 409
    assert response.json()["detail"] == "Workspace has an active task"
    assert not (root / "new.txt").exists()


def test_workspace_file_create_cleans_up_when_file_sync_fails(tmp_path, monkeypatch):
    settings = _settings(tmp_path)
    root = _register_workspace(settings)
    real_os = workspace_files.os
    fsync_calls = 0

    def fail_first_fsync(descriptor):
        nonlocal fsync_calls
        fsync_calls += 1
        if fsync_calls == 1:
            raise OSError("simulated file sync failure")
        return real_os.fsync(descriptor)

    class _CountingOs:
        """The file service's own view of `os`, so only its syncs are counted.

        Other server-owned ledgers (for example the workspace write lease) sync
        their state in the same request and must not consume this injected
        failure, which the module-global `os.fsync` patch did.
        """

        def __getattr__(self, name):
            return getattr(real_os, name)

        def fsync(self, descriptor):
            return fail_first_fsync(descriptor)

    with TestClient(create_app(settings)) as client:
        monkeypatch.setattr(workspace_files, "os", _CountingOs())
        response = client.post(
            "/api/workspaces/workspace-files-test/files/create",
            headers=HEADERS,
            json={"path": "new.txt", "content": "written before sync"},
        )

    assert response.status_code == 503
    assert not (root / "new.txt").exists()
    assert fsync_calls >= 2  # The cleanup also syncs the parent directory.


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
