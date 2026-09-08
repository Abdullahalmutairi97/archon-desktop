from __future__ import annotations

import json
import os
import uuid
from pathlib import Path
import yaml

# Prime currently has a single authenticated provider on this host. Keep this
# allowlist deliberate: the desktop must never advertise a model that cannot run.
OPENAI_CODEX_MODELS = [
    "gpt-6-astra",
    "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5",
    "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark",
    "gpt-5.6-sol-pro", "gpt-5.6-terra-pro", "gpt-5.6-luna-pro",
]

class ModelService:
    def __init__(self, config_path: Path, provider_cache_path: Path | None = None, auth_path: Path | None = None):
        self.config_path = Path(config_path)
        self.auth_path = Path(auth_path or Path.home() / ".prime" / "agent" / "auth.json")

    def _load(self) -> dict:
        if not self.config_path.exists():
            return {}
        try:
            parsed = yaml.safe_load(self.config_path.read_text())
        except (OSError, yaml.YAMLError):
            return {}
        return parsed if isinstance(parsed, dict) else {}

    def _authenticated(self) -> set[str]:
        try:
            data = json.loads(self.auth_path.read_text())
        except (OSError, json.JSONDecodeError):
            return set()
        if not isinstance(data, dict):
            return set()
        return {name for name, value in data.items()
                if isinstance(name, str) and isinstance(value, dict) and value.get("access")}

    def _providers(self) -> list[dict]:
        return [{"id": "openai-codex", "models": OPENAI_CODEX_MODELS}] if "openai-codex" in self._authenticated() else []

    def get(self) -> dict:
        config = self._load(); model_cfg = config.get("model") or {}
        if not isinstance(model_cfg, dict):
            model_cfg = {}
        providers = self._providers()
        current_model = model_cfg.get("default") if model_cfg.get("provider") == "openai-codex" else None
        if not current_model or current_model not in OPENAI_CODEX_MODELS:
            current_model = "gpt-5.6-terra" if providers else None
        current = {"provider": "openai-codex" if providers else None, "model": current_model, "base_url_configured": bool(providers)}
        choices = [{"provider": p["id"], "model": m} for p in providers for m in p["models"]]
        return {"current": current, "fallback": None, "providers": providers, "choices": choices}

    def set_default(self, provider: str, model: str) -> dict:
        if provider != "openai-codex" or provider not in self._authenticated() or model not in OPENAI_CODEX_MODELS:
            raise ValueError("Model is not available through a signed-in Prime provider")
        config = self._load()
        if not isinstance(config.get("model"), dict):
            config["model"] = {}
        config["model"].update(provider=provider, default=model)
        self.config_path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.config_path.with_name(f".{self.config_path.name}.{uuid.uuid4().hex}.archon-tmp")
        try:
            temp.write_text(yaml.safe_dump(config, sort_keys=False, allow_unicode=True))
            os.replace(temp, self.config_path)
        finally:
            temp.unlink(missing_ok=True)
        return self.get()
