from pathlib import Path

import pytest

from archon_server.admission import (
    SessionWorkspace,
    admit_provisioned_workspace,
    admit_workspace,
    revalidate_workspace,
)


def project(root: Path, project_id: str = "p1", *extra_roots: Path) -> dict:
    return {
        "id": project_id,
        "primary_path": str(root),
        "folders": [{"path": str(path)} for path in (root, *extra_roots)],
    }


def test_new_projectless_task_defaults_to_registered_scratch(tmp_path):
    admitted = admit_workspace(scratch_root=tmp_path, projects=[])
    assert admitted.cwd == str(tmp_path)
    assert admitted.project_id is None
    assert admitted.authorized_roots == (str(tmp_path),)


def test_projectless_child_is_canonicalized(tmp_path):
    child = tmp_path / "child"
    child.mkdir()
    alias = tmp_path / "alias"
    alias.symlink_to(child, target_is_directory=True)
    admitted = admit_workspace(scratch_root=tmp_path, projects=[], cwd=str(alias))
    assert admitted.cwd == str(child)


def test_projectless_task_cannot_use_unselected_project_outside_scratch(tmp_path):
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    root = tmp_path / "project"
    root.mkdir()
    with pytest.raises(ValueError, match="outside"):
        admit_workspace(scratch_root=scratch, projects=[project(root)], cwd=str(root))


@pytest.mark.parametrize("target", ["missing", "file", "relative", "empty"])
def test_invalid_requested_cwd_is_rejected(tmp_path, target):
    file = tmp_path / "file"
    file.write_text("not a directory")
    value = {
        "missing": str(tmp_path / "missing"),
        "file": str(file),
        "relative": "relative/path",
        "empty": "",
    }[target]
    with pytest.raises(ValueError):
        admit_workspace(scratch_root=tmp_path, projects=[], cwd=value)


def test_symlink_escape_and_sibling_prefix_are_rejected(tmp_path):
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    outside = tmp_path / "scratch-other"
    outside.mkdir()
    alias = scratch / "alias"
    alias.symlink_to(outside, target_is_directory=True)
    for cwd in (outside, alias):
        with pytest.raises(ValueError, match="outside"):
            admit_workspace(scratch_root=scratch, projects=[], cwd=str(cwd))


def test_selected_project_defaults_to_primary_outside_scratch(tmp_path):
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    root = tmp_path / "project"
    root.mkdir()
    admitted = admit_workspace(
        scratch_root=scratch, projects=[project(root)], project_id="p1"
    )
    assert admitted.cwd == str(root)
    assert admitted.project_id == "p1"
    assert admitted.authorized_roots == (str(root),)


def test_selected_project_can_use_registered_secondary_folder(tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    secondary = tmp_path / "secondary"
    secondary.mkdir()
    child = secondary / "child"
    child.mkdir()
    admitted = admit_workspace(
        scratch_root=tmp_path,
        projects=[project(root, "p1", secondary)],
        project_id="p1",
        cwd=str(child),
    )
    assert admitted.cwd == str(child)
    assert admitted.authorized_roots == (str(root), str(secondary))


def test_selected_project_rejects_cwd_in_other_project_or_scratch(tmp_path):
    first = tmp_path / "first"
    first.mkdir()
    second = tmp_path / "second"
    second.mkdir()
    projects = [project(first), project(second, "p2")]
    for cwd in (tmp_path, second):
        with pytest.raises(ValueError, match="outside"):
            admit_workspace(
                scratch_root=tmp_path, projects=projects, project_id="p1", cwd=str(cwd)
            )


def test_unknown_and_duplicate_project_ids_are_rejected(tmp_path):
    for projects in ([], [project(tmp_path), project(tmp_path)]):
        with pytest.raises(ValueError):
            admit_workspace(scratch_root=tmp_path, projects=projects, project_id="p1")


def test_provisioned_checkout_admission_uses_only_current_server_identity(tmp_path):
    base = tmp_path / "workspaces"
    root = base / ("workspace-" + "a" * 32)
    root.mkdir(parents=True)
    identity = {
        "workspace_id": root.name,
        "root": str(root),
        "owner_id": "local-uid:1000",
        "project_id": "project-1",
        "generation": 3,
        "isolation_profile": "git-checkout",
    }
    admitted = admit_provisioned_workspace(
        workspace=identity, workspace_root=base,
        expected_owner_id="local-uid:1000", expected_generation=3,
    )
    assert admitted.cwd == str(root)
    assert admitted.project_id == "project-1"
    assert admitted.authorized_roots == (str(root),)
    assert admitted.workspace_id == root.name
    assert admitted.workspace_generation == 3


@pytest.mark.parametrize(
    "changes,owner,generation",
    [
        ({"root": "/tmp/attacker"}, "local-uid:1000", 3),
        ({}, "local-uid:2000", 3),
        ({}, "local-uid:1000", 4),
        ({"isolation_profile": "sandboxed"}, "local-uid:1000", 3),
    ],
)
def test_provisioned_checkout_admission_rejects_mismatched_identity(
    tmp_path, changes, owner, generation,
):
    base = tmp_path / "workspaces"
    workspace_id = "workspace-" + "b" * 32
    root = base / workspace_id
    root.mkdir(parents=True)
    identity = {
        "workspace_id": workspace_id,
        "root": str(root),
        "owner_id": "local-uid:1000",
        "project_id": "project-1",
        "generation": 3,
        "isolation_profile": "git-checkout",
        **changes,
    }
    with pytest.raises(ValueError):
        admit_provisioned_workspace(
            workspace=identity, workspace_root=base,
            expected_owner_id=owner, expected_generation=generation,
        )


def test_project_without_unambiguous_default_requires_cwd(tmp_path):
    first = tmp_path / "first"
    first.mkdir()
    second = tmp_path / "second"
    second.mkdir()
    projects = [{"id": "p1", "folders": [{"path": str(first)}, {"path": str(second)}]}]
    with pytest.raises(ValueError, match="primary"):
        admit_workspace(scratch_root=tmp_path, projects=projects, project_id="p1")
    assert admit_workspace(
        scratch_root=tmp_path, projects=projects, project_id="p1", cwd=str(first)
    ).cwd == str(first)


def test_missing_scratch_and_project_roots_fail_closed(tmp_path):
    with pytest.raises(ValueError):
        admit_workspace(scratch_root=tmp_path / "missing", projects=[])
    with pytest.raises(ValueError):
        admit_workspace(
            scratch_root=tmp_path, projects=[project(tmp_path / "missing")], project_id="p1"
        )


def test_resumed_session_keeps_stored_cwd_and_project(tmp_path):
    child = tmp_path / "child"
    child.mkdir()
    admitted = admit_workspace(
        scratch_root=tmp_path,
        projects=[project(tmp_path)],
        session=SessionWorkspace(cwd=str(child), project_id="p1"),
    )
    assert admitted.cwd == str(child)
    assert admitted.project_id == "p1"


def test_resumed_session_accepts_alias_to_same_canonical_cwd(tmp_path):
    child = tmp_path / "child"
    child.mkdir()
    alias = tmp_path / "alias"
    alias.symlink_to(child, target_is_directory=True)
    admitted = admit_workspace(
        scratch_root=tmp_path,
        projects=[],
        cwd=str(alias),
        session=SessionWorkspace(cwd=str(child)),
    )
    assert admitted.cwd == str(child)


def test_resumed_session_rejects_explicit_cwd_change(tmp_path):
    child = tmp_path / "child"
    child.mkdir()
    with pytest.raises(ValueError, match="session"):
        admit_workspace(
            scratch_root=tmp_path,
            projects=[],
            cwd=str(tmp_path),
            session=SessionWorkspace(cwd=str(child)),
        )


@pytest.mark.parametrize("owner_project", [None, "p2"])
def test_resumed_session_rejects_project_change(tmp_path, owner_project):
    with pytest.raises(ValueError, match="session"):
        admit_workspace(
            scratch_root=tmp_path,
            projects=[project(tmp_path)],
            project_id="p1",
            session=SessionWorkspace(cwd=str(tmp_path), project_id=owner_project),
        )


def test_resumed_session_without_cwd_does_not_fallback(tmp_path):
    with pytest.raises(ValueError, match="session"):
        admit_workspace(
            scratch_root=tmp_path,
            projects=[],
            cwd=str(tmp_path),
            session=SessionWorkspace(cwd=None),
        )


def test_resumed_session_rejects_noncanonical_owner_path(tmp_path):
    child = tmp_path / "child"
    child.mkdir()
    alias = tmp_path / "alias"
    alias.symlink_to(child, target_is_directory=True)
    with pytest.raises(ValueError, match="canonical"):
        admit_workspace(
            scratch_root=tmp_path,
            projects=[],
            session=SessionWorkspace(cwd=str(alias)),
        )


def test_revalidate_rejects_removed_cwd(tmp_path):
    child = tmp_path / "child"
    child.mkdir()
    admitted = admit_workspace(scratch_root=tmp_path, projects=[], cwd=str(child))
    child.rmdir()
    with pytest.raises(ValueError):
        revalidate_workspace(admitted.cwd, admitted.authorized_roots)


def test_revalidate_rejects_cwd_replaced_by_symlink_even_inside_root(tmp_path):
    child = tmp_path / "child"
    child.mkdir()
    replacement = tmp_path / "replacement"
    replacement.mkdir()
    admitted = admit_workspace(scratch_root=tmp_path, projects=[], cwd=str(child))
    child.rmdir()
    child.symlink_to(replacement, target_is_directory=True)
    with pytest.raises(ValueError, match="canonical"):
        revalidate_workspace(admitted.cwd, admitted.authorized_roots)


def test_revalidate_rejects_authorized_root_replaced_by_symlink(tmp_path):
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    child = scratch / "child"
    child.mkdir()
    admitted = admit_workspace(scratch_root=scratch, projects=[], cwd=str(child))
    moved = tmp_path / "moved"
    scratch.rename(moved)
    scratch.symlink_to(moved, target_is_directory=True)
    with pytest.raises(ValueError, match="canonical"):
        revalidate_workspace(admitted.cwd, admitted.authorized_roots)


def test_revalidate_requires_nonempty_authorization(tmp_path):
    with pytest.raises(ValueError, match="root"):
        revalidate_workspace(str(tmp_path), ())


def test_revalidate_unchanged_admission(tmp_path):
    admitted = admit_workspace(scratch_root=tmp_path, projects=[])
    assert revalidate_workspace(admitted.cwd, admitted.authorized_roots) == str(tmp_path)
