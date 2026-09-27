from __future__ import annotations

import os
import subprocess
from pathlib import Path

from fastapi.testclient import TestClient

from archon_server.app import create_app
from archon_server.config import Settings
from archon_server.db import Database
from archon_server import workspace_git_diff


TOKEN = "workspace-git-diff-test-token"
HEADERS = {"Authorization": f"Bearer {TOKEN}"}
WORKSPACE_ID = "workspace-git-diff-test"


def _settings(tmp_path: Path) -> Settings:
    return Settings(
        archon_root=tmp_path,
        hermes_home=tmp_path / ".hermes",
        data_dir=tmp_path / ".data",
        auth_token=TOKEN,
        start_worker=False,
    )


def _register_workspace(settings: Settings) -> Path:
    root = settings.data_dir / "workspaces" / WORKSPACE_ID
    root.mkdir(parents=True)
    root.chmod(0o700)
    Database(settings.database_path).create_workspace(
        workspace_id=WORKSPACE_ID,
        root=str(root),
        owner_id=f"local-uid:{os.geteuid()}",
        project_id="project-test",
        base_revision="a" * 40,
        head_revision="a" * 40,
        generation=1,
        isolation_profile="git-checkout",
    )
    return root


def _init_git(root: Path, file_name: str = "README.md", content: str = "before\n") -> Path:
    subprocess.run(["git", "init", "-q", str(root)], check=True)
    subprocess.run(["git", "-C", str(root), "config", "user.name", "Test"], check=True)
    subprocess.run(["git", "-C", str(root), "config", "user.email", "test@example.invalid"], check=True)
    target = root / file_name
    target.write_text(content, encoding="utf-8")
    subprocess.run(["git", "-C", str(root), "add", file_name], check=True)
    subprocess.run(["git", "-C", str(root), "commit", "-qm", "initial"], check=True)
    return target


def _diff(client: TestClient, path: str):
    return client.get(
        f"/api/workspaces/{WORKSPACE_ID}/files/diff",
        params={"path": path},
        headers=HEADERS,
    )


def test_workspace_file_diff_returns_tracked_change(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    root = _register_workspace(settings)
    target = _init_git(root)
    target.write_text("after\n", encoding="utf-8")

    with TestClient(create_app(settings)) as client:
        response = _diff(client, "README.md")

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"path", "diff", "truncated"}
    assert body["path"] == "README.md"
    assert body["truncated"] is False
    assert "-before" in body["diff"]
    assert "+after" in body["diff"]


def test_workspace_file_diff_rejects_protected_names_and_symlinks(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    root = _register_workspace(settings)
    _init_git(root)
    secret = root / ".env"
    secret.write_text("TOKEN=secret\n", encoding="utf-8")
    outside = tmp_path / "outside.txt"
    outside.write_text("private\n", encoding="utf-8")
    (root / "linked.txt").symlink_to(outside)

    with TestClient(create_app(settings)) as client:
        protected = _diff(client, ".env")
        symlink = _diff(client, "linked.txt")

    assert protected.status_code == 404
    assert symlink.status_code == 404
    assert outside.read_text(encoding="utf-8") == "private\n"


def test_workspace_file_diff_caps_output_and_disables_external_diff(tmp_path: Path, monkeypatch) -> None:
    settings = _settings(tmp_path)
    root = _register_workspace(settings)
    target = _init_git(root)
    target.write_text("after\n" * 500, encoding="utf-8")
    marker = tmp_path / "external-diff-ran"
    external = root / "external-diff.sh"
    external.write_text(f"#!/bin/sh\necho ran > {marker}\n", encoding="utf-8")
    external.chmod(0o700)
    # Git config is repository-local and can otherwise name an arbitrary helper.
    subprocess.run(
        ["git", "-C", str(root), "config", "diff.external", str(external)],
        check=True,
    )
    monkeypatch.setattr(workspace_git_diff, "MAX_DIFF_BYTES", 256)

    with TestClient(create_app(settings)) as client:
        response = _diff(client, "README.md")

    assert response.status_code == 200
    body = response.json()
    assert body["truncated"] is True
    assert len(body["diff"].encode("utf-8")) <= 256
    assert not marker.exists()
