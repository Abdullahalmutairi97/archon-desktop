from __future__ import annotations

import json
import re
from pathlib import Path

from .commands import CommandRunner


_JOB_ID_RE = re.compile(r"^[a-f0-9]{12}$")


class CronService:
    def __init__(self, hermes: Path, profile: str, jobs_path: Path, commands: CommandRunner):
        self.hermes = Path(hermes)
        self.profile = profile
        self.jobs_path = Path(jobs_path)
        self.commands = commands

    def list(self) -> list[dict]:
        if not self.jobs_path.exists():
            return []
        try:
            raw = json.loads(self.jobs_path.read_text())
        except (OSError, json.JSONDecodeError):
            return []
        if not isinstance(raw, dict):
            return []
        result = []
        jobs = raw.get("jobs", [])
        if not isinstance(jobs, list):
            return []
        for job in jobs:
            if not isinstance(job, dict):
                continue
            schedule = job.get("schedule")
            schedule_display = schedule.get("display") if isinstance(schedule, dict) else None
            result.append({
                "id": job.get("id"), "name": job.get("name") or "Untitled",
                "enabled": bool(job.get("enabled")), "state": job.get("state"),
                "schedule": job.get("schedule_display") or schedule_display,
                "next_run_at": job.get("next_run_at"), "last_run_at": job.get("last_run_at"),
                "last_status": job.get("last_status"), "last_error": job.get("last_error"),
                "deliver": job.get("deliver"), "prompt": job.get("prompt") or "",
                "skills": job.get("skills") if isinstance(job.get("skills"), list) else [],
                "model": job.get("model"),
                "provider": job.get("provider"), "script": job.get("script"),
                "no_agent": bool(job.get("no_agent")),
            })
        return result

    def _base(self) -> list[str]:
        return [str(self.hermes), "--profile", self.profile, "cron"]

    async def _execute(self, argv: list[str]) -> dict:
        result = await self.commands.run(argv, timeout=300)
        if result["returncode"]:
            raise RuntimeError(result["stderr"] or result["stdout"] or "Cron command failed")
        return {"ok": True, "output": result["stdout"], "jobs": self.list()}

    async def action(self, action: str, job_id: str, *, confirm: bool) -> dict:
        if not confirm:
            raise PermissionError("Explicit confirmation is required")
        if action not in {"pause", "resume", "run", "remove"}:
            raise ValueError("Unsupported cron action")
        if not _JOB_ID_RE.fullmatch(job_id):
            raise ValueError("Invalid cron job id")
        return await self._execute(self._base() + [action, job_id])

    async def create(self, schedule: str, prompt: str, *, name: str = "", deliver: str = "local", confirm: bool) -> dict:
        if not confirm:
            raise PermissionError("Explicit confirmation is required")
        if not schedule or len(schedule) > 120 or "\n" in schedule:
            raise ValueError("Invalid schedule")
        if not prompt or len(prompt) > 100_000:
            raise ValueError("Invalid prompt")
        if len(name) > 300 or len(deliver) > 64:
            raise ValueError("Cron field is too long")
        argv = self._base() + ["create", schedule, prompt, "--deliver", deliver]
        if name:
            argv += ["--name", name]
        return await self._execute(argv)

    async def edit(self, job_id: str, fields: dict, *, confirm: bool) -> dict:
        if not confirm:
            raise PermissionError("Explicit confirmation is required")
        if not _JOB_ID_RE.fullmatch(job_id):
            raise ValueError("Invalid cron job id")
        allowed = {"schedule": "--schedule", "prompt": "--prompt", "name": "--name", "deliver": "--deliver"}
        limits = {"schedule": 120, "prompt": 100_000, "name": 300, "deliver": 64}
        for key, value in fields.items():
            if key not in allowed or value is None:
                continue
            text = str(value)
            if len(text) > limits[key] or (key == "schedule" and (not text or "\n" in text)):
                raise ValueError(f"Invalid cron {key}")
        argv = self._base() + ["edit", job_id]
        changed = False
        for key, flag in allowed.items():
            if key in fields and fields[key] is not None:
                argv += [flag, str(fields[key])]
                changed = True
        if not changed:
            raise ValueError("No editable fields supplied")
        return await self._execute(argv)
