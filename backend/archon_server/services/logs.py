from __future__ import annotations

import re
from collections import deque
from datetime import datetime
from pathlib import Path


LOG_FILES = {
    "agent": "agent.log",
    "errors": "errors.log",
    "gateway": "gateway.log",
    "gui": "gui.log",
    "desktop": "desktop.log",
    "mcp": "mcp-stderr.log",
}
_TIMESTAMP = re.compile(r"^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})(?:,(\d{3}))?")
_LEVEL = re.compile(r"\s(DEBUG|INFO|WARNING|ERROR|CRITICAL)\s")
_COMPONENT = re.compile(r"\s(?:DEBUG|INFO|WARNING|ERROR|CRITICAL)(?:\s+\[[^]]+\])?\s+([^:]+):")
_SECRET_ASSIGNMENT = re.compile(r"(?i)\b(token|api[_-]?key|authorization|password|secret)\b\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+")
_BEARER = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+")


def _redact(text: str) -> str:
    text = _SECRET_ASSIGNMENT.sub(lambda match: f"{match.group(1)}=[REDACTED]", text)
    return _BEARER.sub("Bearer [REDACTED]", text)


def _tail(path: Path, limit: int) -> list[str]:
    if not path.is_file():
        return []
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        return list(deque(handle, maxlen=limit))


class LogService:
    def __init__(self, logs_dir: Path):
        self.logs_dir = Path(logs_dir)

    def list(self, *, limit: int = 500, sources: list[str] | None = None, minimum_level: str | None = None) -> list[dict]:
        selected = sources or list(LOG_FILES)
        rows: list[dict] = []
        order = {"DEBUG": 0, "INFO": 1, "WARNING": 2, "ERROR": 3, "CRITICAL": 4}
        floor = order.get((minimum_level or "DEBUG").upper(), 0)
        for source in selected:
            filename = LOG_FILES.get(source)
            if not filename:
                continue
            for index, raw in enumerate(_tail(self.logs_dir / filename, limit)):
                line = raw.rstrip("\r\n")
                timestamp_match = _TIMESTAMP.match(line)
                level_match = _LEVEL.search(line)
                level = level_match.group(1) if level_match else ("ERROR" if source == "errors" else "INFO")
                if order.get(level, 0) < floor:
                    continue
                component_match = _COMPONENT.search(line)
                timestamp = ""
                sort_time = 0.0
                if timestamp_match:
                    timestamp = timestamp_match.group(1).replace(" ", "T")
                    if timestamp_match.group(2):
                        timestamp += f".{timestamp_match.group(2)}"
                    try:
                        sort_time = datetime.fromisoformat(timestamp).timestamp()
                    except ValueError:
                        pass
                rows.append({
                    "id": f"{source}-{index}-{abs(hash(line))}",
                    "timestamp": timestamp,
                    "level": level,
                    "source": source,
                    "component": component_match.group(1).strip() if component_match else source,
                    "message": _redact(line),
                    "_sort": sort_time,
                })
        rows.sort(key=lambda row: (row["_sort"], row["source"], row["id"]))
        trimmed = rows[-limit:]
        for row in trimmed:
            row.pop("_sort", None)
        return trimmed
