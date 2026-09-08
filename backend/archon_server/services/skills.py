from __future__ import annotations

import os
import uuid
from pathlib import Path

import yaml


class SkillService:
    def __init__(self, skills_dir: Path, config_path: Path):
        self.skills_dir = Path(skills_dir)
        self.config_path = Path(config_path)

    def _config(self) -> dict:
        if not self.config_path.exists():
            return {}
        try:
            parsed = yaml.safe_load(self.config_path.read_text())
        except (OSError, yaml.YAMLError):
            return {}
        return parsed if isinstance(parsed, dict) else {}

    def list(self) -> list[dict]:
        config = self._config()
        skill_config = config.get("skills")
        disabled_values = skill_config.get("disabled") if isinstance(skill_config, dict) else []
        disabled = {str(name) for name in disabled_values} if isinstance(disabled_values, list) else set()
        result = []
        if not self.skills_dir.exists():
            return result
        for path in self.skills_dir.rglob("SKILL.md"):
            try:
                text = path.read_text(errors="replace")
                frontmatter = {}
                if text.startswith("---"):
                    _, raw, _ = text.split("---", 2)
                    parsed = yaml.safe_load(raw)
                    frontmatter = parsed if isinstance(parsed, dict) else {}
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
                try:
                    content = Path(skill["path"]).read_text(errors="replace")
                except OSError:
                    continue
                return {**skill, "content": content}
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
        temp = self.config_path.with_name(f".{self.config_path.name}.{uuid.uuid4().hex}.archon-tmp")
        try:
            temp.write_text(yaml.safe_dump(config, sort_keys=False, allow_unicode=True))
            os.replace(temp, self.config_path)
        finally:
            temp.unlink(missing_ok=True)
        return self.inspect(name)
