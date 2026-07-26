from __future__ import annotations

import platform
import socket
from pathlib import Path


class MigrationService:
    def __init__(self, archon_root: Path, hermes_home: Path, profile: str):
        self.archon_root = Path(archon_root)
        self.hermes_home = Path(hermes_home)
        self.profile = profile

    def manifest(self) -> dict:
        profile_home = self.hermes_home / "profiles" / self.profile
        candidates = [
            profile_home / "config.yaml", profile_home / "state.db", profile_home / "skills",
            profile_home / "memories", profile_home / "cron", self.archon_root / "archon-vault",
            self.archon_root / "data",
        ]
        return {
            "format": "archon-desktop-migration-v1",
            "portable": True,
            "source": {"hostname": socket.gethostname(), "architecture": platform.machine(), "system": platform.system()},
            "configuration": {
                "archon_root": str(self.archon_root), "hermes_home": str(self.hermes_home),
                "profile": self.profile,
            },
            "inventory": [{"path": str(path), "exists": path.exists(), "kind": "directory" if path.is_dir() else "file"} for path in candidates],
            "secrets_included": False,
            "notes": [
                "Reconfigure host paths and bind address on the destination MiniPC.",
                "Credential values are deliberately excluded and must be restored out-of-band.",
                "Use an age-encrypted Archon backup for private state transfer.",
            ],
        }
