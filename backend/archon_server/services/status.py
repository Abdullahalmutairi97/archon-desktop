from __future__ import annotations

import os
import platform
import shutil
import socket
import threading
import time
from pathlib import Path

import psutil


class StatusService:
    _ARCHON_UNITS = {"archon-desktop-prime.service", "archon-desktop-server.service"}

    def __init__(self, root: Path):
        self.root = Path(root)
        self._lock = threading.Lock()
        self._cgroup = self._cgroup_path()
        now = time.monotonic()
        self._last_system = (*self._system_cpu_totals(), now)
        self._last_archon = (self._read_cgroup_cpu(self._cgroup), now) if self._cgroup else None
        self._last_tree = (self._tree_cpu_seconds(), now)

    @classmethod
    def _cgroup_path(cls) -> Path | None:
        """Resolve only an explicit Archon systemd service cgroup."""
        try:
            for line in Path("/proc/self/cgroup").read_text().splitlines():
                hierarchy, controllers, relative = line.split(":", 2)
                if hierarchy != "0" or controllers:
                    continue
                base = Path("/sys/fs/cgroup").resolve()
                path = (base / relative.lstrip("/")).resolve()
                path.relative_to(base)
                if path.name in cls._ARCHON_UNITS and (path / "cpu.stat").is_file():
                    return path
        except (OSError, ValueError):
            pass
        return None

    @staticmethod
    def _read_cgroup_cpu(cgroup: Path) -> float:
        try:
            lines = (cgroup / "cpu.stat").read_text().splitlines()
        except OSError as exc:
            raise ValueError("cpu.stat is unavailable") from exc
        for line in lines:
            fields = line.split(maxsplit=1)
            if len(fields) != 2 or fields[0] != "usage_usec":
                continue
            try:
                return max(0.0, int(fields[1]) / 1_000_000)
            except ValueError:
                continue
        raise ValueError("cpu.stat has no valid usage_usec")

    @staticmethod
    def _system_cpu_totals() -> tuple[float, float]:
        values = psutil.cpu_times()._asdict()
        # guest time is already included in user/nice on Linux.
        total = sum(value for key, value in values.items() if key not in {"guest", "guest_nice"})
        idle = values.get("idle", 0.0) + values.get("iowait", 0.0)
        return max(0.0, total - idle), total

    @staticmethod
    def _process_tree() -> list[psutil.Process]:
        root = psutil.Process()
        try:
            return [root, *root.children(recursive=True)]
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            return [root]

    def _tree_cpu_seconds(self) -> float:
        total = 0.0
        for process in self._process_tree():
            try:
                cpu = process.cpu_times()
                total += cpu.user + cpu.system
            except (psutil.NoSuchProcess, psutil.ZombieProcess, psutil.AccessDenied):
                pass
        return total

    def _tree_memory(self) -> tuple[int, int]:
        used = 0
        alive = 0
        for process in self._process_tree():
            try:
                used += process.memory_info().rss
                alive += 1
            except (psutil.NoSuchProcess, psutil.ZombieProcess, psutil.AccessDenied):
                pass
        return used, alive

    @staticmethod
    def _percent(delta_cpu: float, delta_wall: float, cores: int) -> float:
        if delta_cpu < 0 or delta_wall <= 0:
            return 0.0
        return max(0.0, min(100.0, delta_cpu / delta_wall / cores * 100))

    def snapshot(self) -> dict:
        memory = psutil.virtual_memory()
        swap = psutil.swap_memory()
        disk = shutil.disk_usage(self.root)
        boot = psutil.boot_time()
        load = os.getloadavg() if hasattr(os, "getloadavg") else (0.0, 0.0, 0.0)
        cores = max(1, psutil.cpu_count() or 1)
        now = time.monotonic()

        with self._lock:
            busy, total = self._system_cpu_totals()
            last_busy, last_total, _ = self._last_system
            system_delta = total - last_total
            system_cpu = (busy - last_busy) / system_delta * 100 if system_delta > 0 else 0.0
            self._last_system = (busy, total, now)

            cgroup = self._cgroup
            if cgroup:
                try:
                    cpu_now = self._read_cgroup_cpu(cgroup)
                    last_cpu, last_at = self._last_archon or (cpu_now, now)
                    archon_cpu = self._percent(cpu_now - last_cpu, now - last_at, cores)
                    self._last_archon = (cpu_now, now)
                    archon_memory = int((cgroup / "memory.current").read_text().strip())
                    archon_processes = len((cgroup / "cgroup.procs").read_text().splitlines())
                    accounting = "systemd-cgroup"
                except (OSError, ValueError):
                    cgroup = None
                    self._cgroup = None
            if not cgroup:
                cpu_now = self._tree_cpu_seconds()
                last_cpu, last_at = self._last_tree
                archon_cpu = self._percent(cpu_now - last_cpu, now - last_at, cores)
                self._last_tree = (cpu_now, now)
                archon_memory, archon_processes = self._tree_memory()
                accounting = "process-tree"

        archon_memory_percent = archon_memory / memory.total * 100 if memory.total else 0.0
        return {
            "hostname": socket.gethostname(), "system": platform.system(), "architecture": platform.machine(),
            "kernel": platform.release(), "uptime_seconds": max(0, int(time.time() - boot)),
            "cpu": {"percent": round(max(0.0, min(100.0, system_cpu)), 1), "cores": cores, "load_1": load[0], "load_5": load[1], "load_15": load[2]},
            "memory": {"total": memory.total, "used": memory.used, "available": memory.available, "percent": memory.percent},
            "swap": {"total": swap.total, "used": swap.used, "percent": swap.percent},
            "disk": {"path": str(self.root), "total": disk.total, "used": disk.used, "free": disk.free, "percent": round(disk.used / disk.total * 100, 1) if disk.total else 0},
            "archon": {"cpu_percent": round(archon_cpu, 1), "memory_used": archon_memory, "memory_percent": round(archon_memory_percent, 1), "processes": archon_processes, "accounting": accounting},
        }
