from __future__ import annotations

import mimetypes
import os
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path


class RestrictedPath(PermissionError):
    pass


_SECRET_NAMES = {
    ".env", "auth.json", ".age-backup.key", ".gh_repo_token", "credentials.json",
    "id_rsa", "id_ed25519",
}
_SECRET_SUFFIXES = {".pem", ".key", ".p12", ".pfx"}

# What the editor asks for when it does not say. Comfortably covers source,
# config and most logs.
DEFAULT_READ_BYTES = 8_000_000
# The ceiling a caller can raise it to. This much text has to be JSON-encoded,
# crossed over IPC and held in the renderer, so the limit is about what the
# client can survive rather than what the disk can supply.
MAX_READ_BYTES = 25_000_000


class FileService:
    def __init__(self, root: str | Path):
        self.root = Path(root).expanduser().resolve()

    def resolve(self, relative: str | Path, *, permit_secret: bool = False) -> Path:
        raw = Path(relative).expanduser()
        # Older desktop builds use /home/archon as a virtual workspace root.
        # Resolve that stable client-side prefix inside the configured server root
        # instead of rejecting otherwise safe clipboard/file uploads as outside it.
        virtual_root = Path("/home/archon")
        if raw == virtual_root or raw.is_relative_to(virtual_root):
            raw = Path(*raw.relative_to(virtual_root).parts)
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

    def read_text(
        self,
        relative: str,
        max_bytes: int = DEFAULT_READ_BYTES,
        *,
        allow_binary: bool = False,
    ) -> dict:
        """Read a file for the editor.

        Rather than refusing anything oversized outright, a file larger than the
        window is returned truncated and flagged. That makes a 200 MB log
        readable instead of unopenable — but `truncated` must then disable
        saving in the caller, since writing back a prefix would destroy the rest.

        `allow_binary` decodes undecodable bytes to U+FFFD so the content can be
        looked at. That is lossy and one-way: the result must never be written
        back, which is why `binary` is reported alongside it.
        """
        path = self.resolve(relative)
        if not path.is_file():
            raise FileNotFoundError(relative)
        window = max(1, min(int(max_bytes), MAX_READ_BYTES))
        size = path.stat().st_size
        with path.open("rb") as handle:
            raw = handle.read(window)
        truncated = size > len(raw)
        binary = b"\0" in raw[:8192]
        if binary and not allow_binary:
            raise ValueError("Binary file cannot be opened as text")
        return {
            "path": str(path.relative_to(self.root)),
            "content": raw.decode(errors="replace"),
            "size": size,
            "read": len(raw),
            "truncated": truncated,
            "binary": binary,
        }

    def write_text(self, relative: str, content: str) -> dict:
        path = self.resolve(relative)
        path.parent.mkdir(parents=True, exist_ok=True)
        # Keep temporary files unique so simultaneous saves cannot overwrite one
        # another's staging file.
        temp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.archon-tmp")
        try:
            temp.write_text(content)
            os.replace(temp, path)
        finally:
            temp.unlink(missing_ok=True)
        return self.read_text(relative)

    def mkdir(self, relative: str) -> dict:
        path = self.resolve(relative)
        path.mkdir(parents=True, exist_ok=True)
        return {"path": str(path.relative_to(self.root)), "created": True}

    def rename(self, relative: str, destination: str) -> dict:
        source = self.resolve(relative)
        target = self.resolve(destination)
        if not source.exists():
            raise FileNotFoundError(relative)
        # Path.rename replaces the destination silently on POSIX. A rename that
        # destroys an unrelated file because the name collided is data loss, so
        # the collision is reported instead and the caller decides.
        if target != source and target.exists():
            raise FileExistsError(destination)
        if source.is_dir() and target.is_relative_to(source):
            raise RestrictedPath("A directory cannot be moved inside itself")
        target.parent.mkdir(parents=True, exist_ok=True)
        source.rename(target)
        return {"path": str(target.relative_to(self.root))}

    def copy(self, relative: str, destination: str) -> dict:
        source = self.resolve(relative)
        target = self.resolve(destination)
        if not source.exists():
            raise FileNotFoundError(relative)
        if target.exists():
            raise FileExistsError(destination)
        # Copying a directory into itself would recurse until the disk filled.
        if source.is_dir() and target.is_relative_to(source):
            raise RestrictedPath("A directory cannot be copied into itself")
        target.parent.mkdir(parents=True, exist_ok=True)
        if source.is_dir() and not source.is_symlink():
            shutil.copytree(source, target, symlinks=True)
        else:
            shutil.copy2(source, target, follow_symlinks=False)
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
