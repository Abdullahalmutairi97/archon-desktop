from __future__ import annotations

import mimetypes
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path


class RestrictedPath(PermissionError):
    pass


_SECRET_NAMES = {
    ".env", "auth.json", ".age-backup.key", ".gh_repo_token", "credentials.json",
    "id_rsa", "id_ed25519",
}
_SECRET_SUFFIXES = {".pem", ".key", ".p12", ".pfx"}


class FileService:
    def __init__(self, root: str | Path):
        self.root = Path(root).expanduser().resolve()

    def resolve(self, relative: str | Path, *, permit_secret: bool = False) -> Path:
        raw = Path(relative).expanduser()
        candidate = raw.resolve() if raw.is_absolute() else (self.root / raw).resolve()
        try:
            candidate.relative_to(self.root)
        except ValueError as exc:
            raise RestrictedPath("Path is outside the configured Archon root") from exc
        if not permit_secret and self.is_secret(candidate):
            raise RestrictedPath("Secret-bearing files are not exposed by Archon Desktop")
        return candidate

    @staticmethod
    def is_secret(path: Path) -> bool:
        return path.name in _SECRET_NAMES or path.suffix.lower() in _SECRET_SUFFIXES

    def list_dir(self, relative: str = ".") -> list[dict]:
        path = self.resolve(relative, permit_secret=True)
        if not path.is_dir():
            raise NotADirectoryError(relative)
        items = []
        for entry in sorted(path.iterdir(), key=lambda item: (not item.is_dir(), item.name.lower())):
            try:
                stat = entry.stat()
            except OSError:
                continue
            items.append({
                "name": entry.name,
                "path": str(entry.relative_to(self.root)),
                "is_dir": entry.is_dir(),
                "is_symlink": entry.is_symlink(),
                "restricted": self.is_secret(entry),
                "size": stat.st_size,
                "modified_at": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
                "mime": None if entry.is_dir() else (mimetypes.guess_type(entry.name)[0] or "application/octet-stream"),
            })
        return items

    def read_text(self, relative: str, max_bytes: int = 2_000_000) -> dict:
        path = self.resolve(relative)
        if not path.is_file():
            raise FileNotFoundError(relative)
        size = path.stat().st_size
        if size > max_bytes:
            raise ValueError(f"File exceeds the {max_bytes} byte preview limit")
        raw = path.read_bytes()
        if b"\0" in raw[:8192]:
            raise ValueError("Binary file cannot be opened as text")
        return {"path": str(path.relative_to(self.root)), "content": raw.decode(errors="replace"), "size": size}

    def write_text(self, relative: str, content: str) -> dict:
        path = self.resolve(relative)
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_name(f".{path.name}.archon-tmp")
        temp.write_text(content)
        os.replace(temp, path)
        return self.read_text(relative)

    def mkdir(self, relative: str) -> dict:
        path = self.resolve(relative)
        path.mkdir(parents=True, exist_ok=True)
        return {"path": str(path.relative_to(self.root)), "created": True}

    def rename(self, relative: str, destination: str) -> dict:
        source = self.resolve(relative)
        target = self.resolve(destination)
        target.parent.mkdir(parents=True, exist_ok=True)
        source.rename(target)
        return {"path": str(target.relative_to(self.root))}

    def delete(self, relative: str, *, confirm: bool) -> None:
        if not confirm:
            raise PermissionError("Explicit confirmation is required")
        path = self.resolve(relative)
        if path == self.root:
            raise RestrictedPath("The configured root cannot be deleted")
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path)
        else:
            path.unlink()
