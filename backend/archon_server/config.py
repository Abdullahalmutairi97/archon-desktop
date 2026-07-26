from __future__ import annotations

import os
import pwd
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


def _account_home() -> Path:
    """Return the OS account home even when Hermes overrides $HOME per profile."""
    return Path(pwd.getpwuid(os.getuid()).pw_dir)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="ARCHON_DESKTOP_",
        env_file=".env",
        extra="ignore",
    )

    archon_root: Path = Field(default_factory=_account_home)
    hermes_home: Path = Field(default_factory=lambda: _account_home() / ".hermes")
    data_dir: Path = Field(default_factory=lambda: _account_home() / ".local" / "share" / "archon-desktop")
    profile: str = "archon"
    hermes_executable: Path = Field(default_factory=lambda: _account_home() / ".local" / "bin" / "hermes")
    auth_token: str = ""
    bind_host: str = "127.0.0.1"
    bind_port: int = 8787
    backup_dir: Path = Field(default_factory=lambda: _account_home() / "backups")
    backup_script: Path = Field(default_factory=lambda: _account_home() / ".hermes" / "scripts" / "archon-backup.sh")
    restore_script: Path = Field(default_factory=lambda: _account_home() / ".hermes" / "scripts" / "archon-restore.sh")
    desktop_artifact: Path | None = None
    desktop_version: str = "0.6.1"
    start_worker: bool = True
    worker_poll_seconds: float = 0.5

    @property
    def profile_home(self) -> Path:
        return self.hermes_home / "profiles" / self.profile

    @property
    def config_path(self) -> Path:
        return self.profile_home / "config.yaml"

    @property
    def skills_dir(self) -> Path:
        return self.profile_home / "skills"

    @property
    def database_path(self) -> Path:
        return self.data_dir / "archon-desktop.db"
