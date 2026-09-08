from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Iterable

class PrimeSkillService:
    """Read-only catalog of bundled and user-installed Prime Agent skills."""
    def __init__(self, root: Path, *additional_roots: Path):
        self.roots = tuple(Path(item) for item in (root, *additional_roots))

    def _files(self):
        seen: set[Path] = set()
        files = []
        for root in self.roots:
            try:
                if not root.exists():
                    continue
                candidates = sorted(root.glob('*/SKILL.md'))
            except OSError:
                continue
            for path in candidates:
                try:
                    resolved = path.resolve()
                except OSError:
                    continue
                if resolved not in seen:
                    seen.add(resolved)
                    files.append(path)
        return files
    @staticmethod
    def _field(text: str, name: str) -> str:
        found = re.search(r'^' + re.escape(name) + r':\s*[\"\']?([^\"\'\n]+)', text, re.M)
        return found.group(1).strip() if found else ''
    def list(self) -> list[dict[str, Any]]:
        result=[]
        for path in self._files():
            try:
                text = path.read_text(errors='replace')
            except OSError:
                continue
            result.append({'name': self._field(text, 'name') or path.parent.name, 'description': self._field(text, 'description'), 'category': 'Prime', 'enabled': True, 'path': str(path)})
        return result
    def inspect(self, name: str) -> dict[str, Any]:
        for item in self.list():
            if item['name'] == name:
                try:
                    item['content'] = Path(item['path']).read_text(errors='replace')
                except OSError:
                    continue
                return item
        raise KeyError(name)
