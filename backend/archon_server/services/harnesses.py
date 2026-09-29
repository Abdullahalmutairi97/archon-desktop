"""Inventory and control of the agent harnesses installed on this host.

A harness is a coding-agent CLI Archon can run: Prime, Pi or OpenCode. The
manager reports what is installed, which version, which providers each is
signed in to (provider names only, never credential values) and how many
sessions use it. It turns a harness on or off for new work, sets OpenCode's
default model, and updates npm-installed harnesses when the user confirms.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

logger = logging.getLogger(__name__)

_VERSION = re.compile(r"\d+\.\d+\.\d+[\w.+-]*")


@dataclass(frozen=True)
class Harness:
    id: str
    label: str
    description: str
    executable: Path
    auth_path: Path | None
    package: str | None  # npm package for updates; None when installed another way


class HarnessError(RuntimeError):
    pass


class HarnessService:
    def __init__(self, harnesses: list[Harness], state_path: Path, npm: str = "npm",
                 runtime_usage: Callable[[], dict[str, dict[str, int]]] | None = None):
        self.harnesses = {h.id: h for h in harnesses}
        self.state_path = Path(state_path)
        self.npm = npm
        self.runtime_usage = runtime_usage or (lambda: {})
        self._versions: dict[str, tuple[tuple[int, int], str | None]] = {}
        self._latest: dict[str, str | None] = {}
        self._updating: set[str] = set()

    # ---------- state ----------

    def _state(self) -> dict[str, Any]:
        try:
            data = json.loads(self.state_path.read_text())
        except (OSError, json.JSONDecodeError):
            return {}
        return data if isinstance(data, dict) else {}

    def _save(self, state: dict[str, Any]) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.state_path.with_name(f".{self.state_path.name}.tmp")
        temp.write_text(json.dumps(state, indent=2))
        os.replace(temp, self.state_path)

    def get(self, harness_id: str) -> Harness:
        if harness_id not in self.harnesses:
            raise KeyError(f"unknown harness: {harness_id}")
        return self.harnesses[harness_id]

    def enabled(self, harness_id: str) -> bool:
        return self._state().get(harness_id, {}).get("enabled", True) is not False

    def default_model(self, harness_id: str) -> str | None:
        value = self._state().get(harness_id, {}).get("default_model")
        return value if isinstance(value, str) and value else None

    def configure(self, harness_id: str, *, enabled: bool | None = None, default_model: str | None = None) -> dict:
        self.get(harness_id)
        state = self._state()
        entry = dict(state.get(harness_id) or {})
        if enabled is not None:
            entry["enabled"] = bool(enabled)
        if default_model is not None:
            if harness_id != "opencode":
                raise ValueError("only OpenCode has a harness default model; choose Prime and Pi models in Agents & models")
            if default_model and not re.fullmatch(r"[\w.-]+/[\w.:@/-]+", default_model):
                raise ValueError("model must look like provider/model")
            entry["default_model"] = default_model or None
        state[harness_id] = entry
        self._save(state)
        logger.info("harness %s configured: %s", harness_id, entry)
        return self.describe(harness_id)

    # ---------- inspection ----------

    @staticmethod
    def _auth(path: Path | None) -> list[str]:
        if path is None:
            return []
        try:
            data = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            return []
        return sorted(name for name, value in data.items() if isinstance(name, str) and value) if isinstance(data, dict) else []

    def _version(self, harness: Harness) -> str | None:
        try:
            stat = harness.executable.stat()
        except OSError:
            return None
        key = (stat.st_mtime_ns, stat.st_size)
        cached = self._versions.get(harness.id)
        if cached and cached[0] == key:
            return cached[1]
        version = None
        try:
            result = subprocess.run([str(harness.executable), "--version"], capture_output=True, text=True,
                                    timeout=20, stdin=subprocess.DEVNULL)
            match = _VERSION.search(result.stdout or result.stderr or "")
            version = match.group(0) if match else None
        except (OSError, subprocess.TimeoutExpired):
            version = None
        self._versions[harness.id] = (key, version)
        return version

    def describe(self, harness_id: str) -> dict:
        harness = self.get(harness_id)
        installed = harness.executable.is_file() and os.access(harness.executable, os.X_OK)
        usage = self.runtime_usage().get(harness_id, {})
        version = self._version(harness) if installed else None
        latest = self._latest.get(harness_id)
        return {
            "id": harness.id, "label": harness.label, "description": harness.description,
            "executable": str(harness.executable), "installed": installed, "version": version,
            "enabled": self.enabled(harness_id), "ready": installed and self.enabled(harness_id),
            "default_model": self.default_model(harness_id), "signed_in": self._auth(harness.auth_path),
            "sessions": int(usage.get("sessions", 0)), "running": int(usage.get("running", 0)),
            "package": harness.package, "can_update": bool(harness.package), "latest": latest,
            "update_available": bool(latest and version and latest != version),
            "updating": harness_id in self._updating,
        }

    def list(self) -> list[dict]:
        return [self.describe(harness_id) for harness_id in self.harnesses]

    # ---------- actions ----------

    async def _run(self, argv: list[str], timeout: float) -> tuple[int, str]:
        process = await asyncio.create_subprocess_exec(
            *argv, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        )
        try:
            out, _ = await asyncio.wait_for(process.communicate(), timeout)
        except TimeoutError:
            process.kill()
            await process.wait()
            raise HarnessError(f"{Path(argv[0]).name} timed out after {timeout:g}s") from None
        return process.returncode, out.decode(errors="replace")[-4000:]

    async def check(self, harness_id: str) -> dict:
        harness = self.get(harness_id)
        result = self.describe(harness_id)
        problems: list[str] = []
        if not result["installed"]:
            problems.append(f"{harness.executable} is missing or not executable")
        elif not result["version"]:
            problems.append(f"{harness.label} did not report a version")
        if harness.package:
            try:
                code, out = await self._run([self.npm, "view", harness.package, "version"], 30)
                match = _VERSION.search(out) if code == 0 else None
                self._latest[harness_id] = match.group(0) if match else None
                if not match:
                    problems.append("could not read the latest version from npm")
            except (OSError, HarnessError) as exc:
                problems.append(f"could not reach npm: {exc}")
        result = self.describe(harness_id)
        result["ok"] = not problems
        result["problems"] = problems
        return result

    async def update(self, harness_id: str, *, confirm: bool) -> dict:
        harness = self.get(harness_id)
        if not confirm:
            raise PermissionError("Updating a harness requires explicit confirmation")
        if not harness.package:
            raise ValueError(f"{harness.label} is installed by its own installer and cannot be updated here")
        if harness_id in self._updating:
            raise HarnessError(f"{harness.label} is already updating")
        if self.describe(harness_id)["running"]:
            raise HarnessError(f"{harness.label} has running work; wait for it to finish first")
        self._updating.add(harness_id)
        try:
            code, out = await self._run([self.npm, "install", "-g", f"{harness.package}@latest"], 600)
        finally:
            self._updating.discard(harness_id)
        if code != 0:
            raise HarnessError(out.strip() or f"npm exited with status {code}")
        self._versions.pop(harness_id, None)
        logger.info("harness %s updated", harness_id)
        return await self.check(harness_id)
