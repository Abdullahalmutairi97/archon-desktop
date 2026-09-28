"""Registered, workspace-scoped managed services.

A service is a bounded, validated definition (an argv array, a workspace-relative
working directory, named ports and referenced environment names) that the backend
owner may launch on demand. Only definitions persisted against the current
workspace identity can run, and every child is started with the backend's
allowlisted service environment plus server-constructed port variables. This is a
same-user workspace service, not an isolation boundary; a chat URL or a port
parsed from logs never authorizes execution.

Runtime state (the live child, its exit status and a bounded log tail) lives in
memory. Definitions and their generation fence persist in a private metadata
file. A backend restart reports the previous processes as lost rather than
inventing survivors.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import urllib.request
import uuid
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable

from ..child_env import build_child_env
from ..db import Database


_WORKSPACE_ID = re.compile(r"workspace-[0-9a-f]{32}\Z")
_SERVICE_NAME = re.compile(r"[a-z][a-z0-9-]{0,31}\Z")
_PORT_NAME = re.compile(r"[a-z][a-z0-9-]{0,15}\Z")
_ENV_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")
_MAX_METADATA_BYTES = 64 * 1024
_DEFAULT_MAX_SERVICES = 8
_DEFAULT_MAX_TOTAL_MEMORY_MB = 4096
_MEMORY_PROBE_MB = 16
_MEMORY_PROBE_SCRIPT = (
    "b=[]\n"
    "for i in range(64):\n"
    " c=bytearray(1024*1024)\n"
    " for j in range(0,len(c),4096): c[j]=1\n"
    " b.append(c)\n"
    "print('allocated')\n"
)
_CPU_QUOTA_MIN_PERCENT = 1
_CPU_QUOTA_MAX_PERCENT = 1600
_TASKS_MAX_MIN = 4
_TASKS_MAX_MAX = 4096
# A 5% quota must throttle a busy loop quickly, so `nr_throttled` is the signal:
# an accepted-but-unenforced quota never throttles.
_CPU_PROBE_QUOTA_PERCENT = 5
_CPU_PROBE_SCRIPT = (
    "import time\n"
    "end=time.monotonic()+1.5\n"
    "x=0\n"
    "while time.monotonic()<end: x+=1\n"
    "path='/sys/fs/cgroup'+[l.split('::')[1].strip() for l in open('/proc/self/cgroup') if l.startswith('0::')][0]\n"
    "stat=open(path+'/cpu.stat').read()\n"
    "throttled=0\n"
    "for line in stat.splitlines():\n"
    " if line.startswith('nr_throttled'): throttled=int(line.split()[1])\n"
    "print('nr_throttled=%d' % throttled)\n"
)
_TASKS_PROBE_TASKS = 4
# `TasksMax` must refuse the fork that exceeds it with EAGAIN; a silently ignored
# property spawns every child.
_TASKS_PROBE_SCRIPT = (
    "import os\n"
    "children=[]\n"
    "refused=None\n"
    "for i in range(8):\n"
    " try:\n"
    "  pid=os.fork()\n"
    " except OSError as exc:\n"
    "  refused=exc.errno\n"
    "  break\n"
    " if pid==0:\n"
    "  import time; time.sleep(0.3); os._exit(0)\n"
    " children.append(pid)\n"
    "for pid in children:\n"
    " try: os.waitpid(pid,0)\n"
    " except ChildProcessError: pass\n"
    "print('spawned=%d refused=%s' % (len(children), refused))\n"
)
_MAX_ARGV = 32
_MAX_ARG_BYTES = 1024
_MAX_PORTS = 4
_MAX_ENV_REFS = 16
_MAX_DEPENDENCIES = 4
_MAX_LOGS_BYTES = 16 * 1024
_MAX_RESTARTS = 3
_STARTING_GRACE_SECONDS = 1.0
_HEALTH_INTERVAL_SECONDS = 2.0
_HEALTH_TIMEOUT_SECONDS = 1.5
# Server-constructed environment names a definition may request as a reference.
_ALLOWED_ENV_REFS = frozenset({"NODE_ENV", "PYTHONUNBUFFERED"})
_ALLOWED_RESTART = frozenset({"never", "on-failure"})


class WorkspaceServiceError(RuntimeError):
    """Base error for managed workspace services."""


class WorkspaceServiceUnavailable(WorkspaceServiceError):
    """The service manager or a required runtime facility is unavailable."""


class WorkspaceServiceCapacity(WorkspaceServiceError):
    """The bounded service ledger has reached its configured limit."""


class WorkspaceServiceNotFound(WorkspaceServiceError):
    """The named service is not registered for this workspace."""


class WorkspaceServiceConflict(WorkspaceServiceError):
    """The requested lifecycle transition is not valid for the current state."""


SpawnProcess = Callable[..., Awaitable[Any]]
HealthProbe = Callable[[str], Awaitable[bool]]


async def _default_health_probe(url: str) -> bool:
    """Probe a declared loopback health target with a bounded, credential-free GET."""
    def check() -> bool:
        try:
            request = urllib.request.Request(url, method="GET", headers={"User-Agent": "archon-service-health"})
            with urllib.request.urlopen(request, timeout=_HEALTH_TIMEOUT_SECONDS) as response:
                return 200 <= int(getattr(response, "status", 0)) < 400
        except Exception:
            return False

    try:
        return await asyncio.wait_for(asyncio.to_thread(check), timeout=_HEALTH_TIMEOUT_SECONDS + 0.5)
    except (TimeoutError, asyncio.TimeoutError):
        return False


def _private_directory(path: str | os.PathLike[str], *, label: str) -> Path:
    candidate = Path(path)
    if not candidate.is_absolute():
        raise ValueError(f"{label} must be an absolute server-owned path")
    was_present = candidate.exists() or candidate.is_symlink()
    try:
        candidate.mkdir(parents=True, mode=0o700, exist_ok=True)
    except OSError as exc:
        raise WorkspaceServiceUnavailable(f"Could not prepare private {label}") from exc
    info = candidate.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid()
            or (was_present and stat.S_IMODE(info.st_mode) != 0o700)
            or (stat.S_IMODE(info.st_mode) & 0o077)):
        raise WorkspaceServiceUnavailable(f"{label} must be a private directory owned by this user")
    if candidate.resolve(strict=True) != candidate.absolute():
        raise WorkspaceServiceUnavailable(f"{label} must not be a symlink")
    return candidate.absolute()


class WorkspaceServiceManager:
    """Validate, persist and supervise bounded workspace-owned services."""

    def __init__(
        self,
        database: Database,
        *,
        owner_id: str,
        state_root: str | os.PathLike[str],
        max_services: int = _DEFAULT_MAX_SERVICES,
        max_total_memory_mb: int = _DEFAULT_MAX_TOTAL_MEMORY_MB,
        spawn: SpawnProcess | None = None,
        health_probe: HealthProbe | None = None,
        memory_enforcement: bool | None = None,
        cpu_enforcement: bool | None = None,
        tasks_enforcement: bool | None = None,
    ):
        if not isinstance(owner_id, str) or not owner_id.strip() or len(owner_id) > 200:
            raise ValueError("owner_id is invalid")
        if isinstance(max_services, bool) or not isinstance(max_services, int) or not 1 <= max_services <= 32:
            raise ValueError("max_services must be between 1 and 32")
        if (isinstance(max_total_memory_mb, bool) or not isinstance(max_total_memory_mb, int)
                or not 128 <= max_total_memory_mb <= 65536):
            raise ValueError("max_total_memory_mb must be between 128 and 65536")
        self.database = database
        self.owner_id = owner_id
        self.state_root = _private_directory(state_root, label="workspace service state root")
        self.max_services = max_services
        self.max_total_memory_mb = max_total_memory_mb
        self._spawn = spawn or asyncio.create_subprocess_exec
        self._health_probe = health_probe or _default_health_probe
        self._memory_enforcement = memory_enforcement
        self._cpu_enforcement = cpu_enforcement
        self._tasks_enforcement = tasks_enforcement
        self._lock = asyncio.Lock()
        self._runtime: dict[tuple[str, str], dict[str, Any]] = {}

    # ---------------------------------------------------------------- registry

    async def list(self, workspace_id: str) -> list[dict[str, Any]]:
        """Return definitions with their current in-memory runtime state."""
        async with self._lock:
            workspace = self._resolve_workspace(workspace_id)
            record = self._load(workspace)
            return [self._public_entry(workspace_id, item) for item in record["services"]]

    async def define(self, workspace_id: str, definition: Any) -> dict[str, Any]:
        """Validate and persist one definition, replacing a same-named entry."""
        normalized = self._validate_definition(definition)
        async with self._lock:
            workspace = self._resolve_workspace(workspace_id)
            record = self._load(workspace)
            others = [item for item in record["services"] if item["name"] != normalized["name"]]
            if len(others) >= self.max_services:
                raise WorkspaceServiceCapacity("Workspace service limit reached")
            others.append(normalized)
            self._validate_graph(others)
            record["services"] = sorted(others, key=lambda item: item["name"])
            self._save(workspace, record)
            return self._public_entry(workspace_id, normalized)

    async def remove(self, workspace_id: str, name: str, *, confirm: bool) -> None:
        """Stop any live child and delete the definition after explicit confirmation."""
        if confirm is not True:
            raise PermissionError("Explicit confirmation is required to remove a workspace service")
        self._validate_name(name)
        async with self._lock:
            workspace = self._resolve_workspace(workspace_id)
            record = self._load(workspace)
            if not any(item["name"] == name for item in record["services"]):
                raise WorkspaceServiceNotFound(name)
            dependents = [item["name"] for item in record["services"]
                          if name in item.get("dependsOn", [])]
            if dependents:
                raise WorkspaceServiceConflict(
                    "Other services depend on this definition: " + ", ".join(sorted(dependents))
                )
            await self._stop_locked(workspace_id, name, missing_ok=True)
            self._runtime.pop((workspace_id, name), None)
            record["services"] = [item for item in record["services"] if item["name"] != name]
            self._save(workspace, record)

    # --------------------------------------------------------------- lifecycle

    async def start(self, workspace_id: str, name: str) -> dict[str, Any]:
        """Launch one registered definition as a supervised child process."""
        self._validate_name(name)
        async with self._lock:
            workspace = self._resolve_workspace(workspace_id)
            record = self._load(workspace)
            entry = next((item for item in record["services"] if item["name"] == name), None)
            if entry is None:
                raise WorkspaceServiceNotFound(name)
            for dependency in entry.get("dependsOn", []):
                if not any(item["name"] == dependency for item in record["services"]):
                    raise WorkspaceServiceConflict(f"Missing dependency: {dependency}")
            runtime = self._runtime.get((workspace_id, name))
            if runtime is not None and runtime["state"] in {"starting", "running"}:
                raise WorkspaceServiceConflict("Service is already running")
            if entry.get("cpuQuotaPercent") is not None and not await self._ensure_cpu_enforcement():
                raise WorkspaceServiceUnavailable(
                    "CPU quota enforcement is unavailable on this host; the service was not started"
                )
            if entry.get("tasksMax") is not None and not await self._ensure_tasks_enforcement():
                raise WorkspaceServiceUnavailable(
                    "Task limit enforcement is unavailable on this host; the service was not started"
                )
            if entry.get("memoryLimitMb") is not None:
                if not await self._ensure_memory_enforcement():
                    raise WorkspaceServiceUnavailable(
                        "Memory budget enforcement is unavailable on this host; the service was not started"
                    )
                reserved = sum(
                    item["memoryLimitMb"] for item in record["services"]
                    if item.get("memoryLimitMb") is not None
                    and (self._runtime.get((workspace_id, item["name"])) or {}).get("state") in {"starting", "running"}
                )
                if reserved + entry["memoryLimitMb"] > self.max_total_memory_mb:
                    raise WorkspaceServiceCapacity(
                        "Workspace service memory budget would be exceeded"
                    )
            cwd = self._resolve_cwd(workspace, entry["cwd"])
            await self._launch(workspace, entry, cwd)
            return self._public_entry(workspace_id, entry)

    async def stop(self, workspace_id: str, name: str, *, confirm: bool) -> None:
        """Terminate one supervised child after explicit confirmation."""
        if confirm is not True:
            raise PermissionError("Explicit confirmation is required to stop a workspace service")
        self._validate_name(name)
        async with self._lock:
            workspace = self._resolve_workspace(workspace_id)
            record = self._load(workspace)
            if not any(item["name"] == name for item in record["services"]):
                raise WorkspaceServiceNotFound(name)
            await self._stop_locked(workspace_id, name, missing_ok=False)

    async def preview_target(
        self, workspace_id: str, name: str, *, expected_generation: int, port_name: str | None = None,
    ) -> dict[str, Any]:
        """Resolve a registered service's declared port for a bounded preview."""
        self._validate_name(name)
        if (isinstance(expected_generation, bool) or not isinstance(expected_generation, int)
                or expected_generation < 1):
            raise ValueError("expected_generation must be a positive integer")
        if port_name is not None and (not isinstance(port_name, str) or not _PORT_NAME.fullmatch(port_name)):
            raise ValueError("port_name is invalid")
        async with self._lock:
            workspace = self._resolve_workspace(workspace_id)
            if workspace["generation"] != expected_generation:
                raise ValueError("Workspace generation changed; refresh before previewing")
            record = self._load(workspace)
            entry = next((item for item in record["services"] if item["name"] == name), None)
            if entry is None:
                raise WorkspaceServiceNotFound(name)
            ports = entry["ports"]
            if not ports:
                raise WorkspaceServiceConflict("Service declares no port to preview")
            if port_name is None:
                if len(ports) != 1:
                    raise WorkspaceServiceConflict("Service declares several ports; choose one")
                chosen = ports[0]
            else:
                chosen = next((port for port in ports if port["name"] == port_name), None)
                if chosen is None:
                    raise WorkspaceServiceConflict("Unknown port name")
            runtime = self._runtime.get((workspace_id, name))
            state = runtime["state"] if runtime else "registered"
            return {
                "port": chosen["port"],
                "portName": chosen["name"],
                "generation": workspace["generation"],
                "state": state,
            }

    async def resource_summary(self, workspace_id: str) -> dict[str, Any]:
        """Report registered/running services and the reserved memory budget."""
        async with self._lock:
            workspace = self._resolve_workspace(workspace_id)
            record = self._load(workspace)
            running = 0
            reserved = 0
            for item in record["services"]:
                runtime = self._runtime.get((workspace_id, item["name"]))
                if runtime is not None and runtime["state"] in {"starting", "running"}:
                    running += 1
                    if item.get("memoryLimitMb") is not None:
                        reserved += item["memoryLimitMb"]
            return {
                "services": {
                    "registered": len(record["services"]),
                    "running": running,
                    "reservedMemoryMb": reserved,
                    "maxTotalMemoryMb": self.max_total_memory_mb,
                },
            }

    async def logs(self, workspace_id: str, name: str, *, lines: int = 200) -> dict[str, Any]:
        """Return a bounded tail of the captured stdout/stderr stream."""
        if isinstance(lines, bool) or not isinstance(lines, int) or not 1 <= lines <= 400:
            raise ValueError("lines must be between 1 and 400")
        self._validate_name(name)
        async with self._lock:
            workspace = self._resolve_workspace(workspace_id)
            record = self._load(workspace)
            if not any(item["name"] == name for item in record["services"]):
                raise WorkspaceServiceNotFound(name)
            runtime = self._runtime.get((workspace_id, name))
            buffer = runtime["logs"] if runtime else deque()
            text = b"".join(buffer).decode("utf-8", errors="replace")
            rows = text.splitlines()[-lines:]
            return {"text": "\n".join(rows), "truncated": runtime["logsTruncated"] if runtime else False}

    async def shutdown(self) -> None:
        """Stop every supervised child during backend shutdown."""
        async with self._lock:
            for workspace_id, name in list(self._runtime):
                try:
                    await self._stop_locked(workspace_id, name, missing_ok=True)
                except WorkspaceServiceError:
                    continue

    # -------------------------------------------------------------- internals

    async def _launch(self, workspace: dict[str, Any], entry: dict[str, Any], cwd: Path) -> None:
        env = build_child_env("services")
        for reference in entry["env"]:
            value = os.environ.get(reference)
            if value is not None:
                env[reference] = value
        for port in entry["ports"]:
            env[f"{port['name'].upper().replace('-', '_')}_PORT"] = str(port["port"])
        runtime: dict[str, Any] = {
            "state": "starting",
            "startedAt": datetime.now(timezone.utc).isoformat(),
            "restarts": 0,
            "exitCode": None,
            "stopping": False,
            "process": None,
            "supervisor": None,
            "reader": None,
            "health": "unknown",
            "healthTask": None,
            "logs": deque(),
            "logsTruncated": False,
        }
        self._runtime[(workspace["workspace_id"], entry["name"])] = runtime
        try:
            await self._spawn_child(runtime, entry, cwd, env)
        except Exception:
            runtime["state"] = "failed"
            raise WorkspaceServiceUnavailable("Service could not be started")

    async def _ensure_memory_enforcement(self) -> bool:
        """Probe once whether a user scope actually enforces MemoryMax on this host.

        Reading `memory.max` is insufficient: some hosts set the value without
        enforcing it, so the probe runs a bounded allocation that must be killed.
        Enforcement is treated as unavailable unless that is observed. A scope
        that only caps resident memory lets swap absorb the overage, so the probe
        and the launch both disable swap for the scope.
        """
        if self._memory_enforcement is None:
            self._memory_enforcement = await self._probe_memory_enforcement()
        return self._memory_enforcement

    @staticmethod
    async def _probe_memory_enforcement() -> bool:
        if shutil.which("systemd-run") is None or shutil.which("python3") is None:
            return False

        def run() -> bool:
            try:
                result = subprocess.run(
                    [
                        "systemd-run", "--user", "--scope", "--quiet",
                        "-p", f"MemoryMax={_MEMORY_PROBE_MB}M",
                        "-p", "MemorySwapMax=0",
                        "--", "python3", "-c", _MEMORY_PROBE_SCRIPT,
                    ],
                    capture_output=True,
                    timeout=25,
                )
            except (OSError, subprocess.SubprocessError):
                return False
            return result.returncode != 0

        return await asyncio.to_thread(run)

    async def _ensure_cpu_enforcement(self) -> bool:
        """Probe once whether a user scope actually throttles a declared quota.

        A host can accept `CPUQuota` without throttling, so the probe requires the
        scope's own `cpu.stat` to report throttled periods under a small quota.
        """
        if self._cpu_enforcement is None:
            self._cpu_enforcement = await self._probe_cpu_enforcement()
        return self._cpu_enforcement

    async def _ensure_tasks_enforcement(self) -> bool:
        """Probe once whether a user scope actually refuses a fork past TasksMax."""
        if self._tasks_enforcement is None:
            self._tasks_enforcement = await self._probe_tasks_enforcement()
        return self._tasks_enforcement

    @staticmethod
    async def _probe_cpu_enforcement() -> bool:
        if shutil.which("systemd-run") is None or shutil.which("python3") is None:
            return False

        def run() -> bool:
            try:
                result = subprocess.run(
                    [
                        "systemd-run", "--user", "--scope", "--collect", "--quiet",
                        "-p", f"CPUQuota={_CPU_PROBE_QUOTA_PERCENT}%",
                        "--", "python3", "-c", _CPU_PROBE_SCRIPT,
                    ],
                    capture_output=True,
                    text=True,
                    timeout=30,
                )
            except (OSError, subprocess.SubprocessError):
                return False
            if result.returncode != 0:
                return False
            marker = [line for line in result.stdout.splitlines() if line.startswith("nr_throttled=")]
            if not marker:
                return False
            try:
                return int(marker[-1].split("=", 1)[1]) > 0
            except ValueError:
                return False

        return await asyncio.to_thread(run)

    @staticmethod
    async def _probe_tasks_enforcement() -> bool:
        if shutil.which("systemd-run") is None or shutil.which("python3") is None:
            return False

        def run() -> bool:
            try:
                result = subprocess.run(
                    [
                        "systemd-run", "--user", "--scope", "--collect", "--quiet",
                        "-p", f"TasksMax={_TASKS_PROBE_TASKS}",
                        "--", "python3", "-c", _TASKS_PROBE_SCRIPT,
                    ],
                    capture_output=True,
                    text=True,
                    timeout=30,
                )
            except (OSError, subprocess.SubprocessError):
                return False
            if result.returncode != 0:
                return False
            marker = [line for line in result.stdout.splitlines() if line.startswith("spawned=")]
            if not marker:
                return False
            fields = dict(
                item.split("=", 1) for item in marker[-1].split() if "=" in item
            )
            # errno 11 is EAGAIN, which is how a TasksMax refusal is reported.
            return fields.get("refused") == "11"

        return await asyncio.to_thread(run)

    def _scope_properties(self, entry: dict[str, Any]) -> list[str]:
        """Build the cgroup properties for every resource control a service declares."""
        properties: list[str] = []
        if entry.get("memoryLimitMb") is not None:
            properties += ["-p", f"MemoryMax={entry['memoryLimitMb']}M"]
            # Swap would otherwise absorb the overage and mask the cap.
            properties += ["-p", "MemorySwapMax=0"]
        if entry.get("cpuQuotaPercent") is not None:
            properties += ["-p", f"CPUQuota={entry['cpuQuotaPercent']}%"]
        if entry.get("tasksMax") is not None:
            properties += ["-p", f"TasksMax={entry['tasksMax']}"]
        return properties

    async def _spawn_child(self, runtime: dict[str, Any], entry: dict[str, Any], cwd: Path, env: dict[str, str]) -> None:
        command = list(entry["argv"])
        # Enforce declared resource controls with a user-scoped cgroup. This host
        # provides systemd-run and cgroup v2; a declared control is never silently
        # ignored by falling back to an unbounded process. `start()` refuses to
        # launch at all when a declared control is not enforced.
        properties = self._scope_properties(entry)
        if properties:
            command = [
                "systemd-run", "--user", "--scope", "--collect", "--quiet",
                *properties,
                "--", *command,
            ]
        process = await self._spawn(
            *command,
            cwd=str(cwd),
            env=env,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            start_new_session=True,
        )
        runtime["process"] = process
        runtime["state"] = "running"
        runtime["exitCode"] = None
        runtime["health"] = "starting" if entry.get("health") else "unknown"
        runtime["reader"] = asyncio.create_task(self._drain(runtime, process))
        runtime["supervisor"] = asyncio.create_task(self._supervise(runtime, entry, cwd, env))
        if entry.get("health"):
            runtime["healthTask"] = asyncio.create_task(self._health_loop(runtime, entry))

    async def _health_loop(self, runtime: dict[str, Any], entry: dict[str, Any]) -> None:
        ports = {port["name"]: port["port"] for port in entry["ports"]}
        health = entry.get("health")
        if not health or health["port"] not in ports:
            return
        url = f"http://127.0.0.1:{ports[health['port']]}{health['path']}"
        try:
            while not runtime["stopping"]:
                healthy = await self._health_probe(url)
                if runtime["stopping"]:
                    return
                runtime["health"] = "healthy" if healthy else "unhealthy"
                await asyncio.sleep(_HEALTH_INTERVAL_SECONDS)
        except asyncio.CancelledError:
            return

    async def _drain(self, runtime: dict[str, Any], process: Any) -> None:
        stream = getattr(process, "stdout", None)
        if stream is None:
            return
        try:
            while True:
                chunk = await stream.read(4096)
                if not chunk:
                    return
                buffer: deque[bytes] = runtime["logs"]
                buffer.append(chunk)
                total = sum(len(item) for item in buffer)
                while total > _MAX_LOGS_BYTES and buffer:
                    total -= len(buffer.popleft())
                    runtime["logsTruncated"] = True
        except (asyncio.CancelledError, OSError):
            return

    async def _supervise(self, runtime: dict[str, Any], entry: dict[str, Any], cwd: Path, env: dict[str, str]) -> None:
        process = runtime["process"]
        try:
            returncode = await process.wait()
        except asyncio.CancelledError:
            return
        if runtime["stopping"]:
            runtime["state"] = "stopped"
            runtime["exitCode"] = returncode
            return
        if (entry["restart"] == "on-failure" and returncode not in (0, None)
                and runtime["restarts"] < _MAX_RESTARTS):
            runtime["restarts"] += 1
            try:
                await asyncio.sleep(min(2.0 ** runtime["restarts"], 8.0))
            except asyncio.CancelledError:
                return
            if runtime["stopping"]:
                return
            try:
                await self._spawn_child(runtime, entry, cwd, env)
                return
            except Exception:
                runtime["state"] = "failed"
                runtime["exitCode"] = returncode
                return
        runtime["state"] = "exited" if returncode == 0 else "failed"
        runtime["exitCode"] = returncode

    async def _stop_locked(self, workspace_id: str, name: str, *, missing_ok: bool) -> None:
        runtime = self._runtime.get((workspace_id, name))
        if runtime is None:
            if missing_ok:
                return
            raise WorkspaceServiceConflict("Service is not running")
        runtime["stopping"] = True
        process = runtime["process"]
        supervisor = runtime["supervisor"]
        reader = runtime["reader"]
        health_task = runtime.get("healthTask")
        if process is not None and getattr(process, "returncode", None) is None:
            try:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), timeout=5.0)
                except (TimeoutError, asyncio.TimeoutError):
                    process.kill()
                    await process.wait()
            except ProcessLookupError:
                pass
            except OSError:
                pass
        for task in (reader, supervisor, health_task):
            if task is not None and not task.done():
                task.cancel()
        runtime["state"] = "stopped"
        runtime["exitCode"] = getattr(process, "returncode", None)
        runtime["process"] = None

    def _resolve_workspace(self, workspace_id: str) -> dict[str, Any]:
        if not isinstance(workspace_id, str) or not _WORKSPACE_ID.fullmatch(workspace_id):
            raise ValueError("workspace_id is invalid")
        workspace = self.database.get_workspace(workspace_id)
        if workspace.get("owner_id") != self.owner_id:
            raise PermissionError("Workspace does not belong to this backend owner")
        root_text = workspace.get("root")
        generation = workspace.get("generation")
        if workspace.get("isolation_profile") != "git-checkout" or not isinstance(workspace.get("project_id"), str):
            raise ValueError("Workspace is not a registered project checkout")
        if (not isinstance(root_text, str) or not root_text or not Path(root_text).is_absolute()
                or isinstance(generation, bool) or not isinstance(generation, int) or generation < 1):
            raise ValueError("Workspace identity is invalid")
        root = Path(root_text)
        resolved = root.resolve(strict=True)
        if str(resolved) != root_text or not root.is_dir():
            raise ValueError("Workspace root is not a canonical available directory")
        return {
            "workspace_id": workspace_id,
            "owner_id": self.owner_id,
            "root": root_text,
            "generation": generation,
        }

    def _resolve_cwd(self, workspace: dict[str, Any], relative: str) -> Path:
        root = Path(workspace["root"])
        candidate = (root / relative).resolve(strict=True)
        try:
            candidate.relative_to(root)
        except ValueError as exc:
            raise ValueError("Service working directory escapes the workspace root") from exc
        if not candidate.is_dir():
            raise ValueError("Service working directory is unavailable")
        return candidate

    @staticmethod
    def _validate_name(name: Any) -> str:
        if not isinstance(name, str) or not _SERVICE_NAME.fullmatch(name):
            raise ValueError("service name is invalid")
        return name

    @classmethod
    def _validate_definition(cls, definition: Any) -> dict[str, Any]:
        if not isinstance(definition, dict):
            raise ValueError("definition must be an object")
        allowed = {"name", "argv", "cwd", "env", "ports", "health", "dependsOn", "restart",
                   "memoryLimitMb", "cpuQuotaPercent", "tasksMax"}
        if set(definition) - allowed or "name" not in definition or "argv" not in definition:
            raise ValueError("definition has unsupported or missing fields")
        name = cls._validate_name(definition["name"])
        argv = definition["argv"]
        if not isinstance(argv, list) or not 1 <= len(argv) <= _MAX_ARGV:
            raise ValueError("argv must be a bounded non-empty list")
        normalized_argv = []
        for item in argv:
            if not isinstance(item, str) or not item or len(item) > _MAX_ARG_BYTES:
                raise ValueError("argv entries must be bounded strings")
            if any(ord(char) < 32 or ord(char) == 127 for char in item):
                raise ValueError("argv entries must not contain control characters")
            normalized_argv.append(item)
        cwd = definition.get("cwd", ".")
        if (not isinstance(cwd, str) or not cwd or len(cwd) > 512 or cwd.startswith("/")
                or any(ord(char) < 32 for char in cwd)):
            raise ValueError("cwd must be a workspace-relative path")
        parts = Path(cwd).parts
        if ".." in parts:
            raise ValueError("cwd must not traverse outside the workspace")
        env = definition.get("env", [])
        if not isinstance(env, list) or len(env) > _MAX_ENV_REFS:
            raise ValueError("env must be a bounded list of names")
        normalized_env = []
        for item in env:
            if not isinstance(item, str) or not _ENV_NAME.fullmatch(item):
                raise ValueError("env entries must be environment names")
            if item not in _ALLOWED_ENV_REFS:
                raise ValueError(f"env reference is not permitted: {item}")
            if item not in normalized_env:
                normalized_env.append(item)
        ports = definition.get("ports", [])
        if not isinstance(ports, list) or len(ports) > _MAX_PORTS:
            raise ValueError("ports must be a bounded list")
        normalized_ports = []
        port_names: set[str] = set()
        for item in ports:
            if not isinstance(item, dict) or set(item) != {"name", "port"}:
                raise ValueError("each port needs a name and port")
            if not isinstance(item["name"], str) or not _PORT_NAME.fullmatch(item["name"]) or item["name"] in port_names:
                raise ValueError("port names must be unique lowercase slugs")
            if (isinstance(item["port"], bool) or not isinstance(item["port"], int)
                    or not 1 <= item["port"] <= 65535):
                raise ValueError("port values must be between 1 and 65535")
            port_names.add(item["name"])
            normalized_ports.append({"name": item["name"], "port": item["port"]})
        health = definition.get("health")
        if health is not None:
            if not isinstance(health, dict) or set(health) != {"port", "path"}:
                raise ValueError("health needs a port name and path")
            if not isinstance(health["port"], str) or health["port"] not in port_names:
                raise ValueError("health.port must name a declared port")
            if (not isinstance(health["path"], str) or not health["path"].startswith("/")
                    or len(health["path"]) > 256 or any(ord(char) < 32 for char in health["path"])):
                raise ValueError("health.path must be an absolute request path")
            health = {"port": health["port"], "path": health["path"]}
        depends = definition.get("dependsOn", [])
        if not isinstance(depends, list) or len(depends) > _MAX_DEPENDENCIES:
            raise ValueError("dependsOn must be a bounded list")
        normalized_depends = []
        for item in depends:
            cls._validate_name(item)
            if item == name:
                raise ValueError("a service cannot depend on itself")
            if item not in normalized_depends:
                normalized_depends.append(item)
        restart = definition.get("restart", "never")
        if restart not in _ALLOWED_RESTART:
            raise ValueError("restart must be 'never' or 'on-failure'")
        memory = definition.get("memoryLimitMb")
        if memory is not None and (isinstance(memory, bool) or not isinstance(memory, int)
                                   or not 16 <= memory <= 65536):
            raise ValueError("memoryLimitMb must be between 16 and 65536")
        cpu_quota = definition.get("cpuQuotaPercent")
        if cpu_quota is not None and (isinstance(cpu_quota, bool) or not isinstance(cpu_quota, int)
                                      or not _CPU_QUOTA_MIN_PERCENT <= cpu_quota <= _CPU_QUOTA_MAX_PERCENT):
            raise ValueError("cpuQuotaPercent must be between 1 and 1600")
        tasks_max = definition.get("tasksMax")
        if tasks_max is not None and (isinstance(tasks_max, bool) or not isinstance(tasks_max, int)
                                      or not _TASKS_MAX_MIN <= tasks_max <= _TASKS_MAX_MAX):
            raise ValueError("tasksMax must be between 4 and 4096")
        return {
            "name": name,
            "argv": normalized_argv,
            "cwd": cwd,
            "env": normalized_env,
            "ports": normalized_ports,
            "health": health,
            "dependsOn": normalized_depends,
            "restart": restart,
            "memoryLimitMb": memory,
            "cpuQuotaPercent": cpu_quota,
            "tasksMax": tasks_max,
        }

    @staticmethod
    def _validate_graph(entries: list[dict[str, Any]]) -> None:
        names = {entry["name"] for entry in entries}
        for entry in entries:
            missing = [item for item in entry["dependsOn"] if item not in names]
            if missing:
                raise WorkspaceServiceConflict("Unknown dependency: " + ", ".join(sorted(missing)))
        # Reject dependency cycles with a bounded depth-first walk.
        edges = {entry["name"]: list(entry["dependsOn"]) for entry in entries}
        visiting: set[str] = set()
        done: set[str] = set()

        def visit(node: str) -> None:
            if node in done:
                return
            if node in visiting:
                raise WorkspaceServiceConflict("Service dependencies contain a cycle")
            visiting.add(node)
            for neighbour in edges.get(node, []):
                visit(neighbour)
            visiting.discard(node)
            done.add(node)

        for node in edges:
            visit(node)

    def _metadata_path(self, workspace: dict[str, Any]) -> Path:
        digest = hashlib.sha256(workspace["workspace_id"].encode("ascii")).hexdigest()
        return self.state_root / (digest + ".services.json")

    @staticmethod
    def _empty_record(workspace: dict[str, Any]) -> dict[str, Any]:
        return {
            "version": 1,
            "workspaceId": workspace["workspace_id"],
            "root": workspace["root"],
            "generation": workspace["generation"],
            "services": [],
        }

    def _load(self, workspace: dict[str, Any]) -> dict[str, Any]:
        path = self._metadata_path(workspace)
        try:
            descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0))
        except FileNotFoundError:
            return self._empty_record(workspace)
        except OSError as exc:
            raise WorkspaceServiceUnavailable("Workspace service metadata cannot be opened safely") from exc
        try:
            info = os.fstat(descriptor)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                    or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > _MAX_METADATA_BYTES):
                raise WorkspaceServiceUnavailable("Workspace service metadata is unsafe or oversized")
            payload = bytearray()
            while len(payload) <= _MAX_METADATA_BYTES:
                chunk = os.read(descriptor, min(4096, _MAX_METADATA_BYTES + 1 - len(payload)))
                if not chunk:
                    break
                payload.extend(chunk)
            if len(payload) > _MAX_METADATA_BYTES:
                raise WorkspaceServiceUnavailable("Workspace service metadata is oversized")
        finally:
            os.close(descriptor)
        try:
            data = json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise WorkspaceServiceUnavailable("Workspace service metadata is malformed") from exc
        if not isinstance(data, dict) or set(data) != {
            "version", "workspaceId", "root", "generation", "services",
        } or data.get("version") != 1:
            raise WorkspaceServiceUnavailable("Workspace service metadata has an unsupported schema")
        if (data.get("workspaceId") != workspace["workspace_id"]
                or data.get("root") != workspace["root"]
                or data.get("generation") != workspace["generation"]):
            raise ValueError("Workspace root or generation changed; refusing stale service metadata")
        rows = data.get("services")
        if not isinstance(rows, list) or len(rows) > self.max_services:
            raise WorkspaceServiceUnavailable("Workspace service metadata exceeds its bound")
        for row in rows:
            if self._validate_definition(row) != row:
                raise WorkspaceServiceUnavailable("Workspace service metadata contains an invalid definition")
        self._validate_graph(rows)
        return data

    def _save(self, workspace: dict[str, Any], record: dict[str, Any]) -> None:
        payload = json.dumps(record, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
        if len(payload) > _MAX_METADATA_BYTES or len(record["services"]) > self.max_services:
            raise WorkspaceServiceCapacity("Workspace service metadata limit reached")
        destination = self._metadata_path(workspace)
        temporary = self.state_root / ("." + uuid.uuid4().hex + ".services.tmp")
        descriptor = -1
        try:
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0), 0o600)
            view = memoryview(payload)
            while view:
                written = os.write(descriptor, view)
                if written <= 0:
                    raise OSError("short service metadata write")
                view = view[written:]
            os.fsync(descriptor)
            os.close(descriptor)
            descriptor = -1
            os.replace(temporary, destination)
            directory_fd = os.open(self.state_root, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        except OSError as exc:
            raise WorkspaceServiceUnavailable("Workspace service metadata could not be persisted") from exc
        finally:
            if descriptor >= 0:
                os.close(descriptor)
            temporary.unlink(missing_ok=True)

    def _public_entry(self, workspace_id: str, entry: dict[str, Any]) -> dict[str, Any]:
        runtime = self._runtime.get((workspace_id, entry["name"]))
        return {
            "name": entry["name"],
            "argv": list(entry["argv"]),
            "cwd": entry["cwd"],
            "ports": [dict(port) for port in entry["ports"]],
            "restart": entry["restart"],
            "state": runtime["state"] if runtime else "registered",
            "exitCode": runtime["exitCode"] if runtime else None,
            "restarts": runtime["restarts"] if runtime else 0,
            "health": runtime["health"] if runtime else "unknown",
        }
