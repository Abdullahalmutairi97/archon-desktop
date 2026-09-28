from __future__ import annotations

import os
import pwd
import ipaddress
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator, model_validator
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
    runtime_isolation_profile: Literal["none", "workspace-only"] = "none"
    code_server_executable: Path = Field(default_factory=lambda: _account_home() / ".local" / "bin" / "code-server")
    code_server_extensions_dir: Path = Field(
        default_factory=lambda: _account_home() / ".local" / "share" / "code-server" / "extensions"
    )
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
    # The native local Codex runner shares its metadata directory with the
    # user's desktop process. Keep it opt-in and require an explicitly chosen
    # metadata root so the server never guesses or migrates Codex state.
    local_codex_enabled: bool = False
    local_codex_metadata_root: Path | None = None
    local_codex_worker_script: Path = Field(
        default_factory=lambda: Path(__file__).resolve().parents[2] / "desktop" / "out" / "runner" / "runner" / "worker.js"
    )
    local_codex_node_executable: str = "node"
    local_codex_home_directory: Path = Field(default_factory=_account_home)
    local_codex_home: Path = Field(default_factory=lambda: _account_home() / ".codex")
    local_codex_executable: Path | None = None
    local_codex_request_timeout_seconds: float = Field(default=15.0, ge=0.05, le=120.0)
    local_codex_start_timeout_seconds: float = Field(default=60.0, ge=0.05, le=300.0)
    local_workspace_terminal_tmux_executable: str = Field(default="tmux", min_length=1, max_length=4096)
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

    @field_validator("local_workspace_terminal_tmux_executable")
    @classmethod
    def validate_local_workspace_terminal_tmux_executable(cls, value: str) -> str:
        if "\x00" in value:
            raise ValueError("ARCHON_DESKTOP_LOCAL_WORKSPACE_TERMINAL_TMUX_EXECUTABLE must not contain NUL")
        if not Path(value).is_absolute() and ("/" in value or "\\" in value):
            raise ValueError(
                "ARCHON_DESKTOP_LOCAL_WORKSPACE_TERMINAL_TMUX_EXECUTABLE must be an absolute path or a basename"
            )
        return value

    @model_validator(mode="after")
    def validate_local_codex_settings(self) -> "Settings":
        if self.local_codex_enabled:
            if not self.local_owner_mode:
                raise ValueError("ARCHON_DESKTOP_LOCAL_CODEX_ENABLED requires ARCHON_DESKTOP_LOCAL_OWNER_MODE")
            if self.remote_access_mode != "disabled":
                raise ValueError("ARCHON_DESKTOP_LOCAL_CODEX_ENABLED requires remote access to be disabled")
            if self.local_codex_metadata_root is None:
                raise ValueError("ARCHON_DESKTOP_LOCAL_CODEX_METADATA_ROOT must be explicitly configured")
            if not self.local_codex_metadata_root.is_absolute():
                raise ValueError("ARCHON_DESKTOP_LOCAL_CODEX_METADATA_ROOT must be an absolute path")
        return self

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
        host_value = self.bind_host
        try:
            address = ipaddress.ip_address(host_value)
            if address.version == 6 and address.is_loopback:
                host_value = "::1"
        except ValueError:
            pass
        host = f"[{host_value}]" if ":" in host_value else host_value
        return f"http://{host}:{self.bind_port}"
