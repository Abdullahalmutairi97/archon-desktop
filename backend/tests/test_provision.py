import stat

import pytest

from archon_server import provision


TOKEN = "test-only-generated-token-not-for-use-1234567890"


def set_generated_token(monkeypatch):
    def fake_token_urlsafe(nbytes):
        assert nbytes == 32
        return TOKEN

    monkeypatch.setattr(provision.secrets, "token_urlsafe", fake_token_urlsafe)


def test_provision_creates_private_external_file_without_printing_secret(tmp_path, monkeypatch, capsys):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    output = tmp_path / "private" / "server.env"
    set_generated_token(monkeypatch)

    result = provision.main(
        [
            "--output",
            str(output),
            "--workspace-root",
            str(workspace),
            "--confirm-workspace-roots-complete",
        ]
    )

    captured = capsys.readouterr()
    assert result == 0
    assert TOKEN not in captured.out
    assert TOKEN not in captured.err
    assert output.read_text() == f"ARCHON_DESKTOP_AUTH_TOKEN={TOKEN}\n"
    assert stat.S_IMODE(output.stat().st_mode) == 0o600
    assert stat.S_IMODE(output.parent.stat().st_mode) == 0o700
    assert str(output) in captured.out


def test_provision_requires_an_explicit_complete_workspace_root_set(tmp_path, monkeypatch):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    output = tmp_path / "private" / "server.env"
    set_generated_token(monkeypatch)

    with pytest.raises(ValueError, match="workspace root"):
        provision.create_server_env_file(output, [workspace], confirm_workspace_roots_complete=False)

    assert not output.exists()


def test_provision_rejects_output_inside_any_resolved_workspace_root(tmp_path, monkeypatch):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    alias = tmp_path / "workspace-alias"
    alias.symlink_to(workspace, target_is_directory=True)
    output = workspace / "server.env"
    set_generated_token(monkeypatch)

    with pytest.raises(ValueError, match="outside all workspace roots"):
        provision.create_server_env_file(
            output, [alias], confirm_workspace_roots_complete=True
        )

    assert not output.exists()


def test_provision_refuses_to_overwrite_existing_files_or_follow_symlink_targets(tmp_path, monkeypatch):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    parent = tmp_path / "private"
    parent.mkdir(mode=0o700)
    existing = parent / "server.env"
    existing.write_text("existing-config\n")
    set_generated_token(monkeypatch)

    with pytest.raises(FileExistsError):
        provision.create_server_env_file(
            existing, [workspace], confirm_workspace_roots_complete=True
        )
    assert existing.read_text() == "existing-config\n"

    destination = parent / "linked.env"
    destination.symlink_to(existing)
    with pytest.raises(ValueError, match="regular file"):
        provision.create_server_env_file(
            destination, [workspace], confirm_workspace_roots_complete=True
        )
    assert destination.is_symlink()


def test_provision_rejects_a_shared_existing_parent_directory(tmp_path, monkeypatch):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    parent = tmp_path / "shared"
    parent.mkdir(mode=0o755)
    parent.chmod(0o755)
    output = parent / "server.env"
    set_generated_token(monkeypatch)

    with pytest.raises(ValueError, match="private directory"):
        provision.create_server_env_file(
            output, [workspace], confirm_workspace_roots_complete=True
        )
    assert not output.exists()


def test_provision_requires_absolute_output_and_existing_directory_roots(tmp_path, monkeypatch):
    missing = tmp_path / "missing-workspace"
    output = tmp_path / "private" / "server.env"
    set_generated_token(monkeypatch)

    with pytest.raises(ValueError, match="absolute"):
        provision.create_server_env_file(
            "relative.env", [tmp_path], confirm_workspace_roots_complete=True
        )
    with pytest.raises(ValueError, match="workspace root"):
        provision.create_server_env_file(
            output, [missing], confirm_workspace_roots_complete=True
        )
    assert not output.exists()
