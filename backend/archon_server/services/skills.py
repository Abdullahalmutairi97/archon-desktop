from __future__ import annotations

import os
from pathlib import Path

import yaml


class SkillService:
    def __init__(self, skills_dir: Path, config_path: Path):
        self.skills_dir = Path(skills_dir)
        self.config_path = Path(config_path)

    def _config(self) -> dict:
        if not self.config_path.exists():
            return {}
        return yaml.safe_load(self.config_path.read_text()) or {}

    def list(self) -> list[dict]:
        config = self._config()
        disabled = set((config.get("skills") or {}).get("disabled") or [])
        result = []
        if not self.skills_dir.exists():
            return result
        for path in self.skills_dir.rglob("SKILL.md"):
            try:
                text = path.read_text(errors="replace")
                frontmatter = {}
                if text.startswith("---"):
                    _, raw, _ = text.split("---", 2)
                    frontmatter = yaml.safe_load(raw) or {}
                name = str(frontmatter.get("name") or path.parent.name)
                result.append({
                    "name": name,
                    "description": str(frontmatter.get("description") or ""),
                    "category": str(path.parent.parent.relative_to(self.skills_dir)) if path.parent.parent != self.skills_dir else "",
                    "path": str(path),
                    "enabled": name not in disabled,
                })
            except (OSError, ValueError, yaml.YAMLError):
                continue
        return sorted(result, key=lambda item: (item["category"], item["name"]))

    def inspect(self, name: str) -> dict:
        for skill in self.list():
            if skill["name"] == name:
                return {**skill, "content": Path(skill["path"]).read_text(errors="replace")}
        raise KeyError(name)

    def set_enabled(self, name: str, enabled: bool) -> dict:
        installed = {skill["name"] for skill in self.list()}
        if name not in installed:
            raise KeyError(name)
        config = self._config()
        skills = config.setdefault("skills", {})
        disabled = set(skills.get("disabled") or [])
        if enabled:
            disabled.discard(name)
        else:
            disabled.add(name)
        skills["disabled"] = sorted(disabled)
        self.config_path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.config_path.with_suffix(".yaml.archon-tmp")
        temp.write_text(yaml.safe_dump(config, sort_keys=False, allow_unicode=True))
        os.replace(temp, self.config_path)
        return self.inspect(name)
