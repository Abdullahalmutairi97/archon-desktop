"""Remote runner agent: claim, execute and acknowledge work over the network.

The agent runs on a second machine. It authenticates with its own enrolled
secret, claims durable work items, executes them with a configured runtime
executable, reports the bounded outcome and acknowledges the exact sequence.
``run_once`` returns after a single claim cycle so a caller (CLI, timer or test)
controls the loop; nothing is acknowledged unless the result was reported first.
"""
from __future__ import annotations

import asyncio
import json
import subprocess
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Awaitable, Callable


class RunnerAgentError(RuntimeError):
    """Base error for the remote runner agent."""


Executor = Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]


def _request(method: str, url: str, *, secret: str, body: dict[str, Any] | None, timeout: float) -> dict[str, Any]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("Authorization", f"Bearer {secret}")
    request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        raise RunnerAgentError(f"runner request failed with status {exc.code}") from exc
    except (urllib.error.URLError, OSError) as exc:
        raise RunnerAgentError("runner request could not be completed") from exc


class RemoteRunnerClient:
    """Minimal authenticated client for the coordinator's runner endpoints."""

    def __init__(self, server_url: str, runner_id: str, secret: str, *, timeout: float = 30.0):
        if not server_url.startswith(("http://", "https://")):
            raise ValueError("server_url must be an http(s) URL")
        if not runner_id or not secret:
            raise ValueError("runner id and secret are required")
        self._base = server_url.rstrip("/")
        self._runner = runner_id
        self._secret = secret
        self._timeout = float(timeout)

    async def claim(self, limit: int) -> list[dict[str, Any]]:
        result = await asyncio.to_thread(
            _request, "POST", f"{self._base}/api/runners/{self._runner}/claim",
            secret=self._secret, body={"limit": limit}, timeout=self._timeout,
        )
        events = result.get("events")
        if not isinstance(events, list):
            raise RunnerAgentError("claim response was malformed")
        return events

    async def report(self, event_key: str, status: str, output: str | None) -> None:
        await asyncio.to_thread(
            _request, "POST", f"{self._base}/api/runners/{self._runner}/result",
            secret=self._secret, body={"eventKey": event_key, "status": status, "output": output},
            timeout=self._timeout,
        )

    async def acknowledge(self, runner_seq: int) -> None:
        await asyncio.to_thread(
            _request, "POST", f"{self._base}/api/runners/{self._runner}/ack",
            secret=self._secret, body={"runnerSeq": runner_seq}, timeout=self._timeout,
        )


class RunnerAgent:
    """Claim a bounded batch, execute each item, report and acknowledge it."""

    def __init__(self, client: RemoteRunnerClient, executor: Executor, *, max_claim: int = 8):
        if isinstance(max_claim, bool) or not isinstance(max_claim, int) or not 1 <= max_claim <= 64:
            raise ValueError("max_claim must be between 1 and 64")
        self._client = client
        self._executor = executor
        self._max_claim = max_claim

    async def run_once(self) -> int:
        handled = 0
        for entry in await self._client.claim(self._max_claim):
            event_key = entry.get("eventKey")
            runner_seq = entry.get("runnerSeq")
            if not isinstance(event_key, str) or not isinstance(runner_seq, int):
                continue
            try:
                result = await self._executor(entry.get("payload") or {})
                status = "ok" if result.get("status") == "ok" else "error"
                output = result.get("output")
            except Exception as exc:  # a failed item is reported, never silently dropped
                status = "error"
                output = f"{type(exc).__name__}: {exc}"[:2000]
            await self._client.report(event_key, status, output if isinstance(output, str) else None)
            await self._client.acknowledge(runner_seq)
            handled += 1
        return handled


def make_runtime_executor(executable: str, work_root: str | Path, *, timeout: float = 600.0) -> Executor:
    """Execute a `prompt` work item with a runtime CLI's non-interactive mode."""
    root = Path(work_root)
    if not root.is_absolute():
        raise ValueError("work_root must be an absolute path")

    async def executor(payload: dict[str, Any]) -> dict[str, Any]:
        if payload.get("kind") != "prompt":
            raise RunnerAgentError("unsupported work kind")
        prompt = payload.get("prompt")
        if not isinstance(prompt, str) or not prompt.strip():
            raise RunnerAgentError("prompt is required")
        cwd = (root / str(payload.get("cwd", "."))).resolve()
        if not str(cwd).startswith(str(root.resolve())):
            raise RunnerAgentError("work directory escapes the work root")
        cwd.mkdir(parents=True, exist_ok=True)
        completed = await asyncio.to_thread(
            subprocess.run,
            [executable, "-p", prompt],
            cwd=str(cwd), capture_output=True, timeout=timeout,
        )
        output = (completed.stdout or completed.stderr).decode("utf-8", "replace")[:8000]
        return {"status": "ok" if completed.returncode == 0 else "error", "output": output}

    return executor
