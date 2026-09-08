import json
from pathlib import Path

import pytest
import yaml

from archon_server.services.backups import BackupScheduleService, BackupService
from archon_server.services.cron import CronService
from archon_server.services.files import FileService, RestrictedPath
from archon_server.services.migration import MigrationService
from archon_server.services.models import ModelService, OPENAI_CODEX_MODELS
from archon_server.services.skills import SkillService


class FakeCommands:
    def __init__(self):
        self.calls = []
        self.result = {"returncode": 0, "stdout": "ok", "stderr": ""}

    async def run(self, argv, **kwargs):
        self.calls.append(list(argv))
        return self.result


def test_file_service_browses_and_edits_inside_configured_root(tmp_path):
    root = tmp_path / "host"
    root.mkdir()
    (root / "hello.txt").write_text("hello")
    service = FileService(root)

    listing = service.list_dir(".")
    assert listing[0]["name"] == "hello.txt"
    assert service.read_text("hello.txt")["content"] == "hello"

    service.write_text("folder/new.txt", "new")
    assert (root / "folder/new.txt").read_text() == "new"


def test_file_service_blocks_escape_and_secret_reads(tmp_path):
    root = tmp_path / "host"
    root.mkdir()
    (root / ".env").write_text("TOKEN=secret")
    service = FileService(root)

    with pytest.raises(RestrictedPath):
        service.read_text("../outside")
    with pytest.raises(RestrictedPath):
        service.read_text(".env")


def test_file_service_blocks_symlink_escape(tmp_path):
    root = tmp_path / "host"
    root.mkdir()
    outside = tmp_path / "outside.txt"
    outside.write_text("secret")
    (root / "link.txt").symlink_to(outside)
    service = FileService(root)

    with pytest.raises(RestrictedPath):
        service.read_text("link.txt")


def test_backup_service_groups_plain_and_encrypted_artifacts(tmp_path):
    plain = tmp_path / "archon-backup-20260724_040000.tar.gz"
    encrypted = tmp_path / "archon-backup-20260724_040000.tar.gz.age"
    plain.write_bytes(b"plain")
    encrypted.write_bytes(b"encrypted")

    backups = BackupService(tmp_path, Path("/bin/true"), Path("/bin/true"), FakeCommands()).list()

    assert len(backups) == 1
    assert backups[0]["id"] == "20260724_040000"
    assert backups[0]["encrypted"] is True
    assert backups[0]["plain_size"] == 5
    assert backups[0]["encrypted_size"] == 9


@pytest.mark.asyncio
async def test_backup_creation_requires_confirmation(tmp_path):
    commands = FakeCommands()
    service = BackupService(tmp_path, Path("/opt/backup.sh"), Path("/opt/restore.sh"), commands)

    with pytest.raises(PermissionError):
        await service.create(confirm=False)
    assert commands.calls == []

    await service.create(confirm=True)
    assert commands.calls == [["/opt/backup.sh"]]


@pytest.mark.asyncio
async def test_backup_schedule_change_requires_confirmation(tmp_path):
    commands = FakeCommands()
    service = BackupScheduleService(commands, override_path=tmp_path / "override.conf")

    with pytest.raises(PermissionError):
        await service.set_schedule("*-*-* 04:00:00", confirm=False)
    assert commands.calls == []

    await service.set_schedule("*-*-* 05:30:00", confirm=True)
    assert (tmp_path / "override.conf").read_text().endswith("OnCalendar=*-*-* 05:30:00\n")
    assert commands.calls[-2:] == [["sudo", "systemctl", "daemon-reload"], ["sudo", "systemctl", "restart", "archon-backup.timer"]]


def test_cron_list_reads_exact_store_without_mutating_it(tmp_path):
    jobs_path = tmp_path / "jobs.json"
    jobs_path.write_text(json.dumps({"jobs": [{"id": "abc123def456", "name": "Check", "enabled": True, "schedule_display": "0 6 * * *", "next_run_at": "tomorrow", "last_status": "ok", "prompt": "do it", "deliver": "local"}]}))
    commands = FakeCommands()
    service = CronService(Path("/usr/bin/hermes"), "archon", jobs_path, commands)

    jobs = service.list()

    assert jobs[0]["id"] == "abc123def456"
    assert jobs[0]["schedule"] == "0 6 * * *"
    assert commands.calls == []


@pytest.mark.asyncio
async def test_cron_mutations_require_explicit_confirmation(tmp_path):
    jobs_path = tmp_path / "jobs.json"
    jobs_path.write_text('{"jobs": []}')
    commands = FakeCommands()
    service = CronService(Path("/usr/bin/hermes"), "archon", jobs_path, commands)

    with pytest.raises(PermissionError):
        await service.action("pause", "abc123def456", confirm=False)
    assert commands.calls == []

    await service.action("pause", "abc123def456", confirm=True)
    assert commands.calls == [["/usr/bin/hermes", "--profile", "archon", "cron", "pause", "abc123def456"]]


def test_model_service_updates_only_model_fields_atomically(tmp_path):
    config_path = tmp_path / "config.yaml"
    cache_path = tmp_path / "provider_models_cache.json"
    cache_path.write_text(json.dumps({"openai-codex": {"models": ["gpt-5.6-sol", "gpt-5.4"]}}))
    config_path.write_text(yaml.safe_dump({"model": {"provider": "old", "default": "old/model"}, "memory": {"enabled": True}}))
    auth_path = tmp_path / "auth.json"
    auth_path.write_text(json.dumps({"openai-codex": {"access": "test-token"}}))
    service = ModelService(config_path, cache_path, auth_path)

    service.set_default("openai-codex", "gpt-5.6-sol")
    saved = yaml.safe_load(config_path.read_text())

    assert saved["model"] == {"provider": "openai-codex", "default": "gpt-5.6-sol"}
    assert saved["memory"] == {"enabled": True}
    assert service.get()["providers"] == [{"id": "openai-codex", "models": OPENAI_CODEX_MODELS}]

    with pytest.raises(ValueError):
        service.set_default("openai-codex", "typed-by-hand")


def test_skill_service_lists_and_toggles_config(tmp_path):
    skills_dir = tmp_path / "skills"
    skill_dir = skills_dir / "ops" / "health"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text("---\nname: health\ndescription: VPS health\n---\n# Health")
    config_path = tmp_path / "config.yaml"
    config_path.write_text("{}")
    service = SkillService(skills_dir, config_path)

    assert service.list()[0]["enabled"] is True
    service.set_enabled("health", False)
    assert service.list()[0]["enabled"] is False
    assert yaml.safe_load(config_path.read_text())["skills"]["disabled"] == ["health"]


def test_migration_manifest_has_paths_but_never_secret_values(tmp_path):
    root = tmp_path / "host"
    profile = root / ".hermes/profiles/archon"
    profile.mkdir(parents=True)
    (profile / ".env").write_text("TOKEN=very-secret")
    (profile / "config.yaml").write_text("model: test")
    service = MigrationService(root, root / ".hermes", "archon")

    manifest = service.manifest()
    rendered = json.dumps(manifest)

    assert "config.yaml" in rendered
    assert "very-secret" not in rendered
    assert manifest["portable"] is True
