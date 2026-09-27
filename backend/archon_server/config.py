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
        # Production configuration is supplied by the service manager's external
        # EnvironmentFile. Never load a repository-local .env implicitly.
        env_file=None,
        extra="ignore",
    )

    archon_root: Path = Field(default_factory=_account_home)
    # Explicit solo scratch registration; None uses the configured archon_root.
    task_scratch_root: Path | None = None
    runtime_profile_aliases: dict[str, str] = Field(default_factory=dict)
    hermes_home: Path = Field(default_factory=lambda: _account_home() / ".hermes")
    data_dir: Path = Field(default_factory=lambda: _account_home() / ".local" / "share" / "archon-desktop")
    profile: str = "archon"
    hermes_executable: Path = Field(default_factory=lambda: _account_home() / ".local" / "bin" / "hermes")
    prime_executable: Path = Field(default_factory=lambda: _account_home() / ".local" / "bin" / "prime-agent")
    pi_executable: Path = Field(default_factory=lambda: _account_home() / ".local" / "bin" / "pi")
    prime_agent_session_dir: Path = Field(default_factory=lambda: _account_home() / ".prime" / "agent" / "sessions")
    pi_agent_session_dir: Path = Field(default_factory=lambda: _account_home() / ".pi" / "agent" / "sessions")
    resource_node_executable: str = "node"
    resource_home: Path = Field(default_factory=_account_home)
    prime_resources_dir: Path = Field(default_factory=lambda: _account_home() / ".prime" / "agent")
    pi_resources_dir: Path = Field(default_factory=lambda: _account_home() / ".pi" / "agent")
    prime_runtime_dir: Path = Field(default_factory=lambda: _account_home() / ".local" / "lib" / "node_modules" / "prime-agent" / "dist")
    pi_runtime_dir: Path = Field(default_factory=lambda: _account_home() / ".local" / "lib" / "node_modules" / "@earendil-works" / "pi-coding-agent" / "dist")
    resource_package_roots: list[Path] = Field(default_factory=lambda: [_account_home() / ".local" / "lib" / "node_modules", Path("/usr/local/lib/node_modules"), Path("/usr/lib/node_modules")])
    pi_mcp_config_paths: list[Path] = Field(default_factory=list)
    prime_auth_path: Path = Field(default_factory=lambda: _account_home() / ".prime" / "agent" / "auth.json")
    prime_bundled_skills_dir: Path = Field(default_factory=lambda: _account_home() / ".local" / "lib" / "node_modules" / "prime-agent" / "dist" / "skills")
    prime_user_skills_dir: Path = Field(default_factory=lambda: _account_home() / ".prime" / "agent" / "skills")
    prime_agent_artifact_dir: Path = Field(default_factory=lambda: _account_home() / ".prime" / "agent" / "session-artifacts")
    auth_token: str = Field(default="", repr=False)
    telegram_bot_token: str = Field(default="", repr=False)
    telegram_allowed_user_id: int | None = None
    bind_host: str = "127.0.0.1"
    bind_port: int = Field(default=8787, ge=1, le=65535)
    fixture_mode: bool = False
    # Enables same-user local owner pairing over a protected Unix socket. It
    # never turns a blank bearer token into an HTTP credential.
    local_owner_mode: bool = False
    remote_access_mode: str = "disabled"
    remote_base_url: str | None = None
    backup_dir: Path = Field(default_factory=lambda: _account_home() / "backups")
    backup_script: Path = Field(default_factory=lambda: _account_home() / ".hermes" / "scripts" / "archon-backup.sh")
    restore_script: Path = Field(default_factory=lambda: _account_home() / ".hermes" / "scripts" / "archon-restore.sh")
    desktop_artifact: Path | None = None
    desktop_version: str = "0.3.0"
    start_worker: bool = True
    # How many tasks run at once. Each worker claims one task and awaits it to
    # completion, so this is literally the number of concurrent agent process
    # groups. 2 suits this host: 2 cores, no swap, and agent turns are mostly
    # network-bound. Raise with ARCHON_DESKTOP_WORKER_COUNT, and watch RAM rather
    # than CPU — with no swap, exhausting memory means the OOM killer rather
    # than a graceful slowdown.
    worker_count: int = Field(default=2, ge=1)
    worker_poll_seconds: float = 0.5
    # Compatibility setting only: started tasks are never automatically replayed.
    quota_retry_seconds: float = Field(default=18000, ge=1)

    @property
    def telegram_enabled(self) -> bool:
        return bool(self.telegram_bot_token and self.telegram_allowed_user_id is not None)

    @property
    def profile_home(self) -> Path:
        return self.hermes_home / "profiles" / self.profile

    @property
    def kanban_db(self) -> Path:
        return self.hermes_home / "kanban.db"

    @property
    def config_path(self) -> Path:
        return self.profile_home / "config.yaml"

    @property
    def skills_dir(self) -> Path:
        return self.profile_home / "skills"

    @property
    def database_path(self) -> Path:
        return self.data_dir / "archon-desktop.db"

    @property
    def runner_journal_path(self) -> Path:
        return self.data_dir / "runner-journal" / "runner.sqlite3"

    @property
    def local_pairing_socket_path(self) -> Path:
        return self.runner_journal_path.parent / "pairing.sock"

    @property
    def local_server_url(self) -> str:
        host = f"[{self.bind_host}]" if ":" in self.bind_host else self.bind_host
        return f"http://{host}:{self.bind_port}"
