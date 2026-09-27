from __future__ import annotations

import os
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from archon_server.db import Database
from archon_server.services.workspace import ProjectService
from archon_server.workspace_provisioner import WorkspaceCheckoutProvisioner


def _git(cwd: Path, *arguments: str) -> str:
    completed = subprocess.run(
        ["git", *arguments], cwd=cwd, check=True, capture_output=True, text=True,
    )
    return completed.stdout.strip()


def _source(tmp_path: Path):
    source = tmp_path / "registered-project"
    source.mkdir()
    _git(source, "init", "--quiet")
    _git(source, "config", "user.name", "Fixture Author")
    _git(source, "config", "user.email", "fixture@example.invalid")
    (source / "README.md").write_text("first revision\n", encoding="utf-8")
    _git(source, "add", "README.md")
    _git(source, "commit", "--quiet", "-m", "fixture")
    revision = _git(source, "rev-parse", "HEAD")
    projects = ProjectService(tmp_path / "projects.db")
    project = projects.create("Registered project", source)
    database = Database(tmp_path / "tasks.db")
    workspace_root = tmp_path / "private-workspaces"
    provisioner = WorkspaceCheckoutProvisioner(
        database=database,
        projects=projects,
        workspace_root=workspace_root,
        owner_id="local-owner",
        isolation_profile="git-checkout",
    )
    return source, revision, projects, database, workspace_root, project, provisioner


def test_provisioner_creates_independent_checkout_and_persists_identity(tmp_path):
    source, revision, _projects, database, workspace_root, project, provisioner = _source(tmp_path)

    workspace = provisioner.provision(
        project_id=project["id"], revision=revision, generation=3,
    )

    root = Path(workspace["root"])
    assert root.is_relative_to(workspace_root.resolve())
    assert root != source.resolve()
    assert (root / "README.md").read_text(encoding="utf-8") == "first revision\n"
    assert _git(root, "rev-parse", "HEAD") == revision
    assert not (root / ".git" / "objects" / "info" / "alternates").exists()
    assert stat_mode(root) == 0o700
    assert (workspace["owner_id"], workspace["project_id"], workspace["generation"],
            workspace["isolation_profile"]) == (
        "local-owner", project["id"], 3, "git-checkout",
    )
    assert (workspace["base_revision"], workspace["head_revision"]) == (revision, revision)
    assert stat_mode(workspace_root) == 0o700
    assert database.get_workspace(workspace["workspace_id"]) == workspace


def test_provisioner_rejects_missing_or_ambiguous_project_registration(tmp_path):
    source, revision, _projects, database, workspace_root, project, _provisioner = _source(tmp_path)

    class DuplicateProjectRegistry:
        def list(self):
            row = dict(project)
            row["primary_path"] = str(source)
            row["folders"] = [{"path": str(source), "is_primary": True}]
            return [row, dict(row)]

    provisioner = WorkspaceCheckoutProvisioner(
        database=database, projects=DuplicateProjectRegistry(), workspace_root=workspace_root,
        owner_id="local-owner", isolation_profile="git-checkout",
    )
    with pytest.raises(ValueError, match="missing or ambiguous"):
        provisioner.provision(project_id=project["id"], revision=revision, generation=1)
    with pytest.raises(ValueError, match="missing or ambiguous"):
        provisioner.provision(project_id="renderer-supplied-project", revision=revision, generation=1)


def test_provisioner_rejects_source_aliased_by_another_registered_project(tmp_path):
    source, revision, _projects, database, workspace_root, project, _provisioner = _source(tmp_path)
    alias = tmp_path / "registered-alias"
    alias.symlink_to(source, target_is_directory=True)
    other_root = tmp_path / "other-project"
    other_root.mkdir()

    class AliasedProjectRegistry:
        def list(self):
            return [
                dict(project),
                {
                    "id": "other-project",
                    "primary_path": str(other_root),
                    "folders": [{"path": str(alias), "is_primary": False}],
                },
            ]

    provisioner = WorkspaceCheckoutProvisioner(
        database=database,
        projects=AliasedProjectRegistry(),
        workspace_root=workspace_root,
        owner_id="local-owner",
        isolation_profile="git-checkout",
    )
    with pytest.raises(ValueError, match="source is ambiguous"):
        provisioner.provision(project_id=project["id"], revision=revision, generation=1)


def test_provisioner_rejects_registered_source_replaced_by_symlink(tmp_path):
    source, revision, _projects, _database, _workspace_root, project, provisioner = _source(tmp_path)
    moved = source.with_name("registered-project-original")
    source.rename(moved)
    source.symlink_to(moved, target_is_directory=True)

    with pytest.raises(ValueError, match="symlink"):
        provisioner.provision(project_id=project["id"], revision=revision, generation=1)


def test_provisioner_rejects_workspace_root_overlapping_source_in_either_direction(tmp_path):
    source, revision, _projects, database, workspace_root, project, provisioner = _source(tmp_path)
    nested = WorkspaceCheckoutProvisioner(
        database=database,
        projects=_projects,
        workspace_root=source / "private-workspaces",
        owner_id="local-owner",
        isolation_profile="git-checkout",
    )
    ancestor = WorkspaceCheckoutProvisioner(
        database=database,
        projects=_projects,
        workspace_root=tmp_path,
        owner_id="local-owner",
        isolation_profile="git-checkout",
    )

    with pytest.raises(ValueError, match="must not overlap"):
        nested.provision(project_id=project["id"], revision=revision, generation=1)
    with pytest.raises(ValueError, match="must not overlap"):
        ancestor.provision(project_id=project["id"], revision=revision, generation=1)
    assert workspace_root.is_dir()


def test_provisioner_rejects_existing_destination_without_following_it(tmp_path, monkeypatch):
    source, revision, _projects, _database, workspace_root, project, provisioner = _source(tmp_path)
    fixed_id = "workspace-" + "a" * 32
    destination = workspace_root / fixed_id
    outside = tmp_path / "outside"
    outside.mkdir()
    destination.symlink_to(outside, target_is_directory=True)
    monkeypatch.setattr(
        "archon_server.workspace_provisioner.uuid.uuid4",
        lambda: SimpleNamespace(hex="a" * 32),
    )

    with pytest.raises(FileExistsError):
        provisioner.provision(project_id=project["id"], revision=revision, generation=1)
    assert destination.is_symlink()
    assert list(outside.iterdir()) == []
    assert source.is_dir()


def test_provisioner_detects_destination_replacement_during_git_setup(tmp_path, monkeypatch):
    _source_path, revision, _projects, _database, workspace_root, project, provisioner = _source(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    moved = workspace_root / "moved-checkout"
    original_git = provisioner._repo_git

    def replace_after_init(cwd: Path, arguments: list[str]):
        result = original_git(cwd, arguments)
        if "init" in arguments:
            cwd.rename(moved)
            cwd.symlink_to(outside, target_is_directory=True)
        return result

    monkeypatch.setattr(provisioner, "_repo_git", replace_after_init)
    with pytest.raises(RuntimeError, match="destination was replaced"):
        provisioner.provision(project_id=project["id"], revision=revision, generation=1)
    destinations = [path for path in workspace_root.iterdir() if path.name.startswith("workspace-")]
    assert len(destinations) == 1 and destinations[0].is_symlink()
    assert list(outside.iterdir()) == []
    assert (moved / ".git").is_dir()


def test_provisioner_rejects_unsafe_git_config_without_running_it(tmp_path):
    source, revision, _projects, _database, _workspace_root, project, provisioner = _source(tmp_path)
    marker = tmp_path / "unsafe-config-ran"
    _git(source, "config", "core.sshCommand", f"/bin/touch {marker}")

    with pytest.raises(ValueError, match="unsafe Git config"):
        provisioner.provision(project_id=project["id"], revision=revision, generation=1)
    assert not marker.exists()


def test_provisioner_cleans_partial_checkout_after_git_failure(tmp_path):
    _source_path, revision, _projects, database, workspace_root, project, provisioner = _source(tmp_path)
    original_git = provisioner._repo_git

    def fail_fetch(cwd: Path, arguments: list[str]):
        if "fetch" in arguments:
            return original_git(
                cwd,
                ["-c", "protocol.file.allow=always", "fetch", "--quiet", "/missing/local/repository", revision],
            )
        return original_git(cwd, arguments)

    provisioner._repo_git = fail_fetch

    with pytest.raises(RuntimeError, match="Git operation failed"):
        provisioner.provision(project_id=project["id"], revision=revision, generation=1)
    assert list(workspace_root.iterdir()) == []
    with database.connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM workspaces").fetchone()[0] == 0


def stat_mode(path: Path) -> int:
    return os.stat(path, follow_symlinks=False).st_mode & 0o777
