from __future__ import annotations

import hashlib
import json
import subprocess
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


class AgentResourceService:
    """Read-only, per-runtime global inventory using installed native skill parsers.

    No agent, extension, MCP server, package manager or credential refresh is run.
    MCP output deliberately excludes commands, arguments, URLs, headers and env.
    """
    def __init__(self, specs: dict[str, dict], *, node: str = 'node', probe: Callable | None = None):
        self.specs = specs
        self.node = node
        self.probe = probe or self._probe

    def _probe(self, runtime: str, spec: dict) -> dict:
        result = subprocess.run(
            [self.node, str(Path(__file__).with_name('resource_probe.mjs'))],
            input=json.dumps({'runtime': runtime, **spec}), text=True,
            capture_output=True, timeout=15, check=True,
        )
        if len(result.stdout) > 5_000_000:
            raise ValueError('Inventory is too large')
        value = json.loads(result.stdout)
        if not isinstance(value, dict):
            raise ValueError('Invalid inventory')
        return value

    @staticmethod
    def _text(value: Any, limit: int = 2048) -> str:
        return value[:limit] if isinstance(value, str) else ''

    def _agent(self, runtime: str) -> dict:
        try:
            raw = self.probe(runtime, self.specs[runtime])
            skills = []
            for row in raw.get('skills', []):
                if not isinstance(row, dict) or not row.get('name') or not row.get('path'):
                    continue
                # Identifiers are tied to runtime and canonical source, never supplied paths.
                source = self._text(row['path'], 4096)
                identity = hashlib.sha256(f'{runtime}\0{source}'.encode()).hexdigest()[:24]
                skills.append({'id': identity, 'runtime': runtime, **{
                    key: self._text(row.get(key)) for key in ('name', 'description', 'scope', 'state', 'kind')
                }, 'path': source, 'manual_only': bool(row.get('manual_only'))})
            mcps = []
            for row in raw.get('mcps', []):
                if not isinstance(row, dict) or not row.get('name'):
                    continue
                mcps.append({'runtime': runtime, **{
                    key: self._text(row.get(key)) for key in ('name', 'label', 'transport', 'scope', 'state', 'config_path', 'note')
                }, 'auth_checked': False})
            return {'skills': sorted(skills, key=lambda x: x['name'].casefold()),
                    'mcps': sorted(mcps, key=lambda x: x['name'].casefold()),
                    'warnings': [self._text(x) for x in raw.get('warnings', []) if isinstance(x, str)],
                    'checked_paths': [self._text(x, 4096) for x in raw.get('checked_paths', []) if isinstance(x, str)],
                    'error': None}
        except Exception:
            # Subprocess/config errors can contain sensitive values. Never forward them.
            return {'skills': [], 'mcps': [], 'warnings': [], 'checked_paths': [],
                    'error': 'Could not inspect this runtime. Check its installation and resource paths.'}

    def inventory(self) -> dict:
        with ThreadPoolExecutor(max_workers=2) as pool:
            values = list(pool.map(self._agent, ('prime', 'pi')))
        return {'agents': dict(zip(('prime', 'pi'), values)), 'scope': 'global',
                'checked_at': datetime.now(timezone.utc).isoformat(),
                'note': 'Global MiniPC inventory. Project and per-session additions may differ. MCP connections and authentication are not tested.'}

    def inspect(self, runtime: str, skill_id: str) -> dict:
        if runtime not in ('prime', 'pi'):
            raise ValueError('Unknown runtime')
        inventory = self._agent(runtime)
        if inventory['error']:
            raise RuntimeError('Could not inspect runtime resources')
        for skill in inventory['skills']:
            if skill['id'] != skill_id:
                continue
            path = Path(skill['path'])
            if path.suffix.lower() != '.md' or not path.is_file():
                raise KeyError(skill_id)
            if path.stat().st_size > 512_000:
                raise ValueError('Skill document exceeds the preview size limit')
            return {**skill, 'content': path.read_text(errors='replace')}
        raise KeyError(skill_id)
