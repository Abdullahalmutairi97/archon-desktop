from pathlib import Path

from archon_server.config import Settings


def test_desktop_release_default_matches_verified_baseline(monkeypatch):
    import json

    monkeypatch.delenv("ARCHON_DESKTOP_DESKTOP_VERSION", raising=False)
    baseline = Path(__file__).resolve().parents[2] / "current" / "baseline.json"
    assert Settings(_env_file=None).desktop_version == json.loads(baseline.read_text())["version"]


def test_paths_are_derived_from_config_for_mini_pc_migration(tmp_path):
    home = tmp_path / "new-machine"
    settings = Settings(
        archon_root=home,
        hermes_home=home / ".hermes",
        data_dir=home / ".archon-desktop",
        profile="portable",
        start_worker=False,
    )

    assert settings.profile_home == home / ".hermes" / "profiles" / "portable"
    assert settings.database_path == home / ".archon-desktop" / "archon-desktop.db"
    assert str(settings.archon_root) == str(home)


def test_defaults_follow_account_home_not_hermes_overridden_home(monkeypatch):
    import os
    import pwd

    monkeypatch.setenv("HOME", "/tmp/hermes-profile-home")
    settings = Settings(_env_file=None)
    expected = Path(pwd.getpwuid(os.getuid()).pw_dir)

    assert settings.archon_root == expected
    assert settings.backup_dir == expected / "backups"
    assert settings.hermes_home == expected / ".hermes"
