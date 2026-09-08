from __future__ import annotations

import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from .commands import CommandRunner


_BACKUP_RE = re.compile(r"^archon-backup-(\d{8}_\d{6})\.tar\.gz(?:\.age)?$")
_CALENDAR_RE = re.compile(r"^[A-Za-z0-9*,:./+_@~ -]{3,120}$")


class BackupService:
    def __init__(self, backup_dir: Path, backup_script: Path, restore_script: Path, commands: CommandRunner):
        self.backup_dir = Path(backup_dir)
        self.backup_script = Path(backup_script)
        self.restore_script = Path(restore_script)
        self.commands = commands

    def list(self) -> list[dict]:
        grouped: dict[str, dict] = {}
        try:
            paths = list(self.backup_dir.iterdir()) if self.backup_dir.exists() else []
        except OSError:
            return []
        for path in paths:
            match = _BACKUP_RE.match(path.name)
            try:
                is_file = path.is_file()
            except OSError:
                continue
            if not match or not is_file:
                continue
            backup_id = match.group(1)
            item = grouped.setdefault(backup_id, {
                "id": backup_id, "created_at": datetime.strptime(backup_id, "%Y%m%d_%H%M%S").replace(tzinfo=timezone.utc).isoformat(),
                "plain_path": None, "encrypted_path": None, "plain_size": None,
                "encrypted_size": None, "encrypted": False,
            })
            try:
                size = path.stat().st_size
            except OSError:
                continue
            if path.name.endswith(".age"):
                item["encrypted_path"] = str(path)
                item["encrypted_size"] = size
                item["encrypted"] = True
            else:
                item["plain_path"] = str(path)
                item["plain_size"] = size
        return sorted(grouped.values(), key=lambda item: item["id"], reverse=True)

    async def create(self, *, confirm: bool) -> dict:
        if not confirm:
            raise PermissionError("Explicit confirmation is required")
        result = await self.commands.run([str(self.backup_script)], timeout=1800)
        if result["returncode"]:
            raise RuntimeError(result["stderr"] or result["stdout"] or "Backup failed")
        return {"ok": True, "output": result["stdout"], "backups": self.list()}

    async def inspect(self, source: str) -> dict:
        path = Path(source).resolve()
        if self.backup_dir.resolve() not in path.parents:
            raise PermissionError("Backup source is outside the configured backup directory")
        result = await self.commands.run([str(self.restore_script), "--source", str(path), "--list"], timeout=300)
        if result["returncode"]:
            raise RuntimeError(result["stderr"] or "Backup inspection failed")
        return {"source": str(path), "contents": result["stdout"]}

    async def restore(self, source: str, paths: list[str], *, confirm: bool, all_files: bool = False) -> dict:
        if not confirm:
            raise PermissionError("Explicit confirmation is required")
        source_path = Path(source).resolve()
        if self.backup_dir.resolve() not in source_path.parents:
            raise PermissionError("Backup source is outside the configured backup directory")
        argv = [str(self.restore_script), "--source", str(source_path), "--apply"]
        argv.extend(["--all"] if all_files else paths)
        result = await self.commands.run(argv, timeout=1800)
        if result["returncode"]:
            raise RuntimeError(result["stderr"] or "Restore failed")
        return {"ok": True, "output": result["stdout"]}


class BackupScheduleService:
    def __init__(self, commands: CommandRunner, *, override_path: Path = Path("/etc/systemd/system/archon-backup.timer.d/archon-desktop.conf")):
        self.commands = commands
        self.override_path = Path(override_path)

    async def status(self) -> dict:
        result = await self.commands.run([
            "systemctl", "show", "archon-backup.timer",
            "--property=ActiveState,UnitFileState,NextElapseUSecRealtime,LastTriggerUSec",
        ])
        values = {}
        for line in result["stdout"].splitlines():
            if "=" in line:
                key, value = line.split("=", 1)
                values[key] = value
        calendar = None
        try:
            override_lines = self.override_path.read_text().splitlines() if self.override_path.exists() else []
        except OSError:
            override_lines = []
        for line in override_lines:
            if line.startswith("OnCalendar=") and line != "OnCalendar=":
                calendar = line.split("=", 1)[1]
        return {"calendar": calendar, **values}

    async def set_schedule(self, calendar: str, *, confirm: bool) -> dict:
        if not confirm:
            raise PermissionError("Explicit confirmation is required")
        if not _CALENDAR_RE.fullmatch(calendar) or "\n" in calendar:
            raise ValueError("Invalid systemd calendar expression")
        content = f"[Timer]\nOnCalendar=\nOnCalendar={calendar}\n"
        try:
            self.override_path.parent.mkdir(parents=True, exist_ok=True)
            self.override_path.write_text(content)
        except PermissionError:
            with tempfile.NamedTemporaryFile("w", delete=False) as handle:
                handle.write(content)
                temp_path = Path(handle.name)
            try:
                result = await self.commands.run(["sudo", "install", "-D", "-m", "0644", str(temp_path), str(self.override_path)])
            finally:
                temp_path.unlink(missing_ok=True)
            if result["returncode"]:
                raise RuntimeError(result["stderr"] or "Could not install timer override")
        for argv in (["sudo", "systemctl", "daemon-reload"], ["sudo", "systemctl", "restart", "archon-backup.timer"]):
            result = await self.commands.run(argv)
            if result["returncode"]:
                raise RuntimeError(result["stderr"] or "Could not reload backup timer")
        return {"calendar": calendar, "updated": True}
