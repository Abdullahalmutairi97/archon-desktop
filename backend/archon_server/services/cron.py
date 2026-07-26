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
        raw = json.loads(self.jobs_path.read_text())
        result = []
        for job in raw.get("jobs", []):
            result.append({
                "id": job.get("id"), "name": job.get("name") or "Untitled",
                "enabled": bool(job.get("enabled")), "state": job.get("state"),
                "schedule": job.get("schedule_display") or (job.get("schedule") or {}).get("display"),
                "next_run_at": job.get("next_run_at"), "last_run_at": job.get("last_run_at"),
                "last_status": job.get("last_status"), "last_error": job.get("last_error"),
                "deliver": job.get("deliver"), "prompt": job.get("prompt") or "",
                "skills": job.get("skills") or [], "model": job.get("model"),
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
        argv = self._base() + ["edit", job_id]
        for key, flag in allowed.items():
            if key in fields and fields[key] is not None:
                argv += [flag, str(fields[key])]
        if len(argv) == 5:
            raise ValueError("No editable fields supplied")
        return await self._execute(argv)
