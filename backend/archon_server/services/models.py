from __future__ import annotations

import json
import os
from pathlib import Path

import yaml


class ModelService:
    def __init__(self, config_path: Path, provider_cache_path: Path | None = None):
        self.config_path = Path(config_path)
        self.provider_cache_path = Path(provider_cache_path) if provider_cache_path else self.config_path.parent / "provider_models_cache.json"

    def _load(self) -> dict:
        if not self.config_path.exists():
            return {}
        return yaml.safe_load(self.config_path.read_text()) or {}

    def _providers(self) -> list[dict]:
        try:
            cache = json.loads(self.provider_cache_path.read_text())
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            cache = {}
        providers = []
        for provider_id, entry in cache.items() if isinstance(cache, dict) else []:
            if not isinstance(provider_id, str) or not isinstance(entry, dict):
                continue
            seen: set[str] = set()
            models = []
            for model in entry.get("models", []):
                if isinstance(model, str) and model.strip() and model not in seen:
                    seen.add(model)
                    models.append(model)
            if models:
                providers.append({"id": provider_id, "models": models[:500]})
        return sorted(providers, key=lambda item: item["id"].lower())

    def get(self) -> dict:
        config = self._load()
        model = config.get("model") or {}
        fallback = config.get("fallback_model") or config.get("fallback")
        current = {
            "provider": model.get("provider"),
            "model": model.get("default"),
            "base_url_configured": bool(model.get("base_url")),
        }
        providers = self._providers()
        choices = [
            {"provider": provider["id"], "model": model_id}
            for provider in providers for model_id in provider["models"]
        ]
        if current["model"] and not any(choice["provider"] == current["provider"] and choice["model"] == current["model"] for choice in choices):
            choices.insert(0, {"provider": current["provider"], "model": current["model"]})
        return {"current": current, "fallback": fallback, "providers": providers, "choices": choices}

    def set_default(self, provider: str, model: str) -> dict:
        provider = provider.strip()
        model = model.strip()
        if not provider or not model or "\n" in provider or "\n" in model:
            raise ValueError("Provider and model are required")
        providers = {item["id"]: item["models"] for item in self._providers()}
        if providers and (provider not in providers or model not in providers[provider]):
            raise ValueError("Model is not available for this provider")
        config = self._load()
        config.setdefault("model", {})["provider"] = provider
        config["model"]["default"] = model
        self.config_path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.config_path.with_suffix(".yaml.archon-tmp")
        temp.write_text(yaml.safe_dump(config, sort_keys=False, allow_unicode=True))
        os.replace(temp, self.config_path)
        return self.get()
