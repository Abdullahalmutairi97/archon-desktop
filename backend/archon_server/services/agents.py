from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml


class AgentService:
    """Reads the Hermes profile roster: who exists, what they are for, how they run.

    A profile name reaches a subprocess argv, so `resolve` is an allowlist against
    directories that actually exist rather than a passthrough.
    """

    def __init__(self, hermes_home: Path, default_profile: str):
        self.hermes_home = Path(hermes_home)
        self.default_profile = default_profile

    @property
    def profiles_dir(self) -> Path:
        return self.hermes_home / "profiles"

    def names(self) -> list[str]:
        if not self.profiles_dir.is_dir():
            return [self.default_profile]
        found = sorted(
            p.name for p in self.profiles_dir.iterdir()
            if p.is_dir() and (p / "config.yaml").is_file()
        )
        return found or [self.default_profile]

    def resolve(self, profile: str | None) -> str:
        """Return a profile name safe to pass to `hermes --profile`."""
        if not profile:
            return self.default_profile
        candidate = profile.strip()
        if candidate not in self.names():
            raise ValueError(f"unknown profile: {profile}")
        return candidate

    def _orchestrator(self) -> str:
        try:
            root = yaml.safe_load((self.hermes_home / "config.yaml").read_text()) or {}
            return (root.get("kanban") or {}).get("orchestrator_profile") or self.default_profile
        except OSError:
            return self.default_profile

    def _describe(self, name: str) -> str:
        try:
            data = yaml.safe_load((self.profiles_dir / name / "profile.yaml").read_text()) or {}
            return (data.get("description") or "").strip()
        except OSError:
            return ""

    def list(self) -> list[dict[str, Any]]:
        orchestrator = self._orchestrator()
        agents: list[dict[str, Any]] = []
        for name in self.names():
            cfg: dict[str, Any] = {}
            try:
                cfg = yaml.safe_load((self.profiles_dir / name / "config.yaml").read_text()) or {}
            except OSError:
                pass
            model = (cfg.get("model") or {})
            mcps = (cfg.get("mcp_servers") or {})
            agents.append({
                "name": name,
                "description": self._describe(name),
                "model": model.get("default") or "",
                "provider": model.get("provider") or "",
                "reasoning_effort": (cfg.get("agent") or {}).get("reasoning_effort") or "",
                "toolsets": sorted((cfg.get("platform_toolsets") or {}).get("cli") or []),
                "mcps": sorted(k for k, v in mcps.items() if isinstance(v, dict) and v.get("enabled")),
                "orchestrator": name == orchestrator,
            })
        return agents
