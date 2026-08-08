"""Archon Desktop control-stream callbacks for one-shot Hermes runs.

This module is loaded by Hermes only when ``ARCHON_DESKTOP_CONTROL_MODULE`` is
set by :class:`HermesRunner`.  It writes compact, bounded control records to
stderr; the runner converts those records into persisted task events.
"""

from __future__ import annotations

import difflib
import json
import re
import sys
import threading
import time
from pathlib import Path
from typing import Any

CONTROL_PREFIX = "@@archon "
MAX_DELTA = 4096
MAX_DETAIL = 4000
MAX_TARGET = 1000
MAX_ID = 200
MAX_TOOL = 100
MAX_SNAPSHOT_BYTES = 1024 * 1024
_EDIT_TOOLS = {"patch", "write_file"}
_SHELL_TOOLS = {"terminal", "execute_code"}
_REASONING_TITLE = re.compile(r"\*\*(.+?)\*\*", re.DOTALL)
_SECRET_ASSIGNMENT = re.compile(
    r"(?i)\b(api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)"
    r"(\s*[:=]\s*)([^\s,;]+)"
)


def _bounded(text: Any, limit: int, *, tail: bool = False) -> str:
    value = str(text or "")
    if len(value) <= limit:
        return value
    marker = "\n…[truncated]"
    room = max(limit - len(marker), 0)
    clipped = value[-room:] if tail and room else value[:room]
    return (marker + clipped) if tail else (clipped + marker)


def _redact(text: Any) -> str:
    return _SECRET_ASSIGNMENT.sub(lambda match: f"{match.group(1)}{match.group(2)}[REDACTED]", str(text or ""))


def _chunks(text: str, limit: int = MAX_DELTA):
    for start in range(0, len(text), limit):
        yield text[start : start + limit]


def _parse_result(result: Any) -> Any:
    if isinstance(result, (dict, list)):
        return result
    if isinstance(result, str):
        try:
            return json.loads(result)
        except (json.JSONDecodeError, TypeError):
            return result
    return result


def _exit_code(result: Any) -> int:
    parsed = _parse_result(result)
    if isinstance(parsed, dict):
        value = parsed.get("exit_code")
        if isinstance(value, bool):
            return int(value)
        if isinstance(value, (int, float)):
            return int(value)
        if parsed.get("error") or parsed.get("errors"):
            return 1
        return 0
    text = str(parsed or "").lstrip().lower()
    return 1 if text.startswith(("error", "failed", "traceback")) else 0


def _result_detail(result: Any, *, tail: bool) -> str:
    parsed = _parse_result(result)
    if isinstance(parsed, dict):
        for key in ("output", "content", "result", "error", "message"):
            if parsed.get(key) is not None:
                return _bounded(_redact(parsed[key]), MAX_DETAIL, tail=tail)
        rendered = json.dumps(parsed, ensure_ascii=False, separators=(",", ":"), default=str)
    elif isinstance(parsed, list):
        rendered = json.dumps(parsed, ensure_ascii=False, separators=(",", ":"), default=str)
    else:
        rendered = str(parsed or "")
    return _bounded(_redact(rendered), MAX_DETAIL, tail=tail)


def _resolve_path(raw_path: str) -> Path:
    path = Path(raw_path).expanduser()
    return path if path.is_absolute() else Path.cwd() / path


def _patch_paths(patch_text: str) -> list[str]:
    paths: list[str] = []
    for line in str(patch_text or "").splitlines():
        match = re.match(r"^\*\*\* (?:Update|Add|Delete) File: (.+)$", line)
        if match and match.group(1) not in paths:
            paths.append(match.group(1))
    return paths


def _edit_paths(function_name: str, args: dict[str, Any]) -> list[str]:
    if function_name == "write_file" and args.get("path"):
        return [str(args["path"])]
    if function_name == "patch":
        if args.get("path"):
            return [str(args["path"])]
        return _patch_paths(str(args.get("patch") or ""))
    return []


def _read_snapshot(raw_path: str) -> str | None:
    path = _resolve_path(raw_path)
    try:
        if not path.exists():
            return ""
        if not path.is_file() or path.stat().st_size > MAX_SNAPSHOT_BYTES:
            return None
        return path.read_text(errors="replace")
    except OSError:
        return None


def _capture(paths: list[str]) -> dict[str, str | None]:
    return {path: _read_snapshot(path) for path in paths}


def _diff(before: dict[str, str | None], paths: list[str]) -> tuple[int, int, str]:
    added = 0
    removed = 0
    rendered: list[str] = []
    for raw_path in paths:
        old = before.get(raw_path)
        new = _read_snapshot(raw_path)
        if old is None or new is None:
            rendered.append(f"Diff omitted for {raw_path}: file unavailable or larger than {MAX_SNAPSHOT_BYTES} bytes.\n")
            continue
        old_lines = old.splitlines(keepends=True)
        new_lines = new.splitlines(keepends=True)
        matcher = difflib.SequenceMatcher(a=old_lines, b=new_lines, autojunk=False)
        for tag, i1, i2, j1, j2 in matcher.get_opcodes():
            if tag in {"replace", "delete"}:
                removed += i2 - i1
            if tag in {"replace", "insert"}:
                added += j2 - j1
        rendered.extend(
            difflib.unified_diff(
                old_lines,
                new_lines,
                fromfile=f"a/{raw_path}",
                tofile=f"b/{raw_path}",
                lineterm="",
            )
        )
    detail = "\n".join(line.rstrip("\n") for line in rendered)
    return added, removed, _bounded(_redact(detail), MAX_DETAIL)


def _tool_kind(function_name: str) -> str:
    if function_name in _SHELL_TOOLS:
        return "shell"
    if function_name in _EDIT_TOOLS:
        return "edit"
    return _bounded(function_name or "tool", MAX_TOOL)


def _target(function_name: str, args: dict[str, Any], paths: list[str]) -> str:
    if function_name == "terminal":
        value = args.get("command") or "terminal"
    elif function_name == "execute_code":
        value = "python"
    elif paths:
        value = ", ".join(paths)
    else:
        value = (
            args.get("path")
            or args.get("url")
            or args.get("query")
            or args.get("name")
            or function_name
        )
    return _bounded(_redact(value), MAX_TARGET)


class ControlStream:
    def __init__(self, agent: Any):
        self.agent = agent
        self._lock = threading.Lock()
        self._message_started = False
        self._done = False
        self._reasoning_buffer = ""
        self._reasoning_seen: set[str] = set()
        self._calls: dict[str, dict[str, Any]] = {}
        self._previous_tool_start = getattr(agent, "tool_start_callback", None)
        self._previous_tool_complete = getattr(agent, "tool_complete_callback", None)

    def _emit(self, payload: dict[str, Any]) -> None:
        line = CONTROL_PREFIX + json.dumps(
            payload, ensure_ascii=False, separators=(",", ":"), default=str
        )
        with self._lock:
            print(line, file=sys.stderr, flush=True)

    def on_delta(self, text: Any) -> None:
        if text is None:
            return
        value = str(text)
        if not value:
            return
        self._message_started = True
        for fragment in _chunks(value):
            self._emit({"event": "message.delta", "text": fragment})

    def on_reasoning(self, text: Any) -> None:
        if not text:
            return
        self._reasoning_buffer += str(text)
        matches = list(_REASONING_TITLE.finditer(self._reasoning_buffer))
        for match in matches:
            title = " ".join(match.group(1).split())
            if not title or title in self._reasoning_seen:
                continue
            self._reasoning_seen.add(title)
            self._emit({"event": "output", "text": f"**{_bounded(title, 500)}**"})
        if matches:
            self._reasoning_buffer = self._reasoning_buffer[matches[-1].end() :]
        elif len(self._reasoning_buffer) > MAX_DELTA:
            self._reasoning_buffer = self._reasoning_buffer[-MAX_DELTA:]

    def on_tool_start(self, tool_call_id: Any, function_name: Any, function_args: Any) -> None:
        call_id = _bounded(tool_call_id or f"tool-{time.monotonic_ns()}", MAX_ID)
        name = str(function_name or "tool")
        args = function_args if isinstance(function_args, dict) else {}
        paths = _edit_paths(name, args)
        target = _target(name, args, paths)
        self._calls[call_id] = {
            "started": time.monotonic(),
            "name": name,
            "args": args,
            "paths": paths,
            "target": target,
            "before": _capture(paths) if paths else {},
        }
        self._emit(
            {
                "event": "tool",
                "id": call_id,
                "phase": "start",
                "tool": _tool_kind(name),
                "target": target,
            }
        )
        if self._previous_tool_start is not None:
            try:
                self._previous_tool_start(tool_call_id, function_name, function_args)
            except Exception:
                pass

    def on_tool_complete(
        self,
        tool_call_id: Any,
        function_name: Any,
        function_args: Any,
        function_result: Any,
    ) -> None:
        call_id = _bounded(tool_call_id or "tool", MAX_ID)
        name = str(function_name or "tool")
        args = function_args if isinstance(function_args, dict) else {}
        call = self._calls.pop(call_id, None) or {
            "started": time.monotonic(),
            "name": name,
            "args": args,
            "paths": _edit_paths(name, args),
            "target": _target(name, args, _edit_paths(name, args)),
            "before": {},
        }
        duration = round(max(0.0, time.monotonic() - float(call["started"])), 2)
        kind = _tool_kind(str(call["name"]))
        payload: dict[str, Any] = {
            "event": "tool",
            "id": call_id,
            "phase": "end",
            "tool": kind,
            "target": call["target"],
            "duration": duration,
            "exit_code": _exit_code(function_result),
        }
        if kind == "edit":
            added, removed, detail = _diff(call["before"], call["paths"])
            payload.update({"added": added, "removed": removed, "detail": detail})
        else:
            payload["detail"] = _result_detail(function_result, tail=True)
        self._emit(payload)
        if self._previous_tool_complete is not None:
            try:
                self._previous_tool_complete(
                    tool_call_id, function_name, function_args, function_result
                )
            except Exception:
                pass

    def done(self) -> None:
        if self._done:
            return
        self._done = True
        if self._message_started:
            self._emit({"event": "message.done"})


def install(agent: Any) -> ControlStream:
    control = ControlStream(agent)
    agent.stream_delta_callback = control.on_delta
    agent.reasoning_callback = control.on_reasoning
    agent.tool_start_callback = control.on_tool_start
    agent.tool_complete_callback = control.on_tool_complete
    return control
