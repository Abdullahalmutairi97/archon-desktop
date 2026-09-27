import pytest

from archon_server.db import Database


def test_workspace_and_native_session_identity_reject_ambiguous_resume(tmp_path):
    db = Database(tmp_path / "state.db")
    root = tmp_path / "workspace"
    root.mkdir()
    cwd = root / "project"
    cwd.mkdir()
    other_cwd = root / "other"
    other_cwd.mkdir()

    workspace = db.create_workspace(
        workspace_id="workspace-1",
        root=str(root / "."),
        owner_id="local-owner",
        generation=1,
        isolation_profile="exclusive",
    )
    assert workspace["root"] == str(root.resolve())
    assert (workspace["project_id"], workspace["base_revision"], workspace["head_revision"]) == (
        None, None, None,
    )
    with pytest.raises(ValueError, match="root already has an authoritative workspace id"):
        db.create_workspace(
            workspace_id="workspace-2",
            root=str(root),
            owner_id="local-owner",
            generation=1,
            isolation_profile="exclusive",
        )
    project_root = tmp_path / "project-workspace"
    project_root.mkdir()
    project_workspace = db.create_workspace(
        workspace_id="workspace-project",
        root=str(project_root),
        owner_id="local-owner",
        generation=1,
        isolation_profile="worktree",
        project_id="project-1",
        base_revision="base-commit",
        head_revision="head-commit",
    )
    assert (project_workspace["project_id"], project_workspace["base_revision"],
            project_workspace["head_revision"]) == ("project-1", "base-commit", "head-commit")
    mapping = db.map_native_session(
        "workspace-1", "native-session-1", runtime_id="prime", cwd=str(cwd),
    )
    assert mapping["runtime_id"] == "prime"
    assert mapping["cwd"] == str(cwd.resolve())

    resolved = db.resolve_native_session(
        "native-session-1", runtime_id="prime", cwd=str(cwd),
    )
    assert resolved["workspace_id"] == "workspace-1"
    assert resolved["owner_id"] == "local-owner"
    assert resolved["generation"] == 1

    with pytest.raises(ValueError, match="conflicts"):
        db.map_native_session(
            "workspace-1", "native-session-1", runtime_id="prime", cwd=str(other_cwd),
        )
    pi_mapping = db.map_native_session(
        "workspace-1", "native-session-1", runtime_id="pi", cwd=str(other_cwd),
    )
    assert pi_mapping["cwd"] == str(other_cwd.resolve())
    with pytest.raises(ValueError, match="does not match"):
        db.resolve_native_session(
            "native-session-1", runtime_id="pi", cwd=str(cwd),
        )


def test_native_session_import_respects_legacy_verified_and_review_required_ownership(tmp_path):
    db = Database(tmp_path / "state.db")
    root = tmp_path / "workspace"
    root.mkdir()
    cwd = root / "project"
    cwd.mkdir()
    workspace = db.create_workspace(
        workspace_id="workspace-1",
        root=str(root),
        owner_id="local-owner",
        generation=1,
        isolation_profile="exclusive",
    )
    with db.transaction() as conn:
        conn.executemany(
            """INSERT INTO session_ownership
               (session_id,runtime_id,cwd,state,reason,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?)""",
            [
                ("verified-session", "prime", str(cwd), "verified", None, "a", "a"),
                ("review-session", None, None, "review_required", "ambiguous", "a", "a"),
            ],
        )

    with pytest.raises(ValueError, match="verified legacy"):
        db.map_native_session(
            workspace["workspace_id"], "verified-session", runtime_id="pi", cwd=str(cwd),
        )
    verified_mapping = db.map_native_session(
        workspace["workspace_id"], "verified-session", runtime_id="prime", cwd=str(cwd),
    )
    assert verified_mapping["runtime_id"] == "prime"
    with pytest.raises(ValueError, match="requires review"):
        db.map_native_session(
            workspace["workspace_id"], "review-session", runtime_id="prime", cwd=str(cwd),
        )
    with db.connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM workspace_native_sessions").fetchone()[0] == 1
