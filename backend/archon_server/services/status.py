from __future__ import annotations

import os
import platform
import shutil
import socket
import time
from pathlib import Path

import psutil


class StatusService:
    def __init__(self, root: Path):
        self.root = Path(root)

    def snapshot(self) -> dict:
        memory = psutil.virtual_memory()
        swap = psutil.swap_memory()
        disk = shutil.disk_usage(self.root)
        boot = psutil.boot_time()
        load = os.getloadavg() if hasattr(os, "getloadavg") else (0.0, 0.0, 0.0)
        return {
            "hostname": socket.gethostname(), "system": platform.system(), "architecture": platform.machine(),
            "kernel": platform.release(), "uptime_seconds": max(0, int(time.time() - boot)),
            "cpu": {"percent": psutil.cpu_percent(interval=0.1), "cores": psutil.cpu_count(), "load_1": load[0], "load_5": load[1], "load_15": load[2]},
            "memory": {"total": memory.total, "used": memory.used, "available": memory.available, "percent": memory.percent},
            "swap": {"total": swap.total, "used": swap.used, "percent": swap.percent},
            "disk": {"path": str(self.root), "total": disk.total, "used": disk.used, "free": disk.free, "percent": round(disk.used / disk.total * 100, 1) if disk.total else 0},
        }
