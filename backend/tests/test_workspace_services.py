from __future__ import annotations

import asyncio
import json
import os
import shutil
import socket
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from archon_server.db import Database
from archon_server.app import create_app
from archon_server.config import Settings
from archon_server.local_pairing import LOCAL_PAIRING_AUDIENCE
from archon_server.services.workspace_services import (
    WorkspaceServiceCapacity,
    WorkspaceServiceConflict,
    WorkspaceServiceManager,
    WorkspaceServiceNotFound,
    WorkspaceServiceUnavailable,
)


OWNER_ID = "local-uid:1000"
WORKSPACE_ID = "workspace-0123456789abcdef0123456789abcdef"


def _manager(tmp_path: Path, *, health_probe=None, max_total_memory_mb: int = 4096,
             memory_enforcement: bool | None = None, cpu_enforcement: bool | None = None,
             tasks_enforcement: bool | None = None,
             filesystem_enforcement: bool | None = None,
             network_enforcement: bool | None = None) -> WorkspaceServiceManager:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir(exist_ok=True)
    database = Database(tmp_path / "database.sqlite3")
    try:
        database.get_workspace(WORKSPACE_ID)
    except KeyError:
        database.create_workspace(
            workspace_id=WORKSPACE_ID,
            root=str(workspace_root),
            owner_id=OWNER_ID,
            project_id="project-test",
            generation=1,
            isolation_profile="git-checkout",
        )
    return WorkspaceServiceManager(
        database,
        owner_id=OWNER_ID,
        state_root=tmp_path / "private-state",
        health_probe=health_probe,
        max_total_memory_mb=max_total_memory_mb,
        memory_enforcement=memory_enforcement,
        cpu_enforcement=cpu_enforcement,
        tasks_enforcement=tasks_enforcement,
        filesystem_enforcement=filesystem_enforcement,
        network_enforcement=network_enforcement,
    )


def _ledger_rows(tmp_path: Path) -> list[dict]:
    """Read the persisted service definitions from the private metadata ledger."""
    import hashlib as _hashlib

    digest = _hashlib.sha256(WORKSPACE_ID.encode("ascii")).hexdigest()
    path = tmp_path / "private-state" / (digest + ".services.json")
    return json.loads(path.read_text())["services"]


def _definition(**overrides) -> dict:
    definition = {"name": "web", "argv": ["/bin/echo", "hello"]}
    definition.update(overrides)
    return definition


def _paired_owner_headers(socket_path: Path) -> dict[str, str]:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(3)
        connection.connect(str(socket_path))
        stream = connection.makefile("rwb", buffering=0)
        stream.write(json.dumps({"op": "challenge", "audience": LOCAL_PAIRING_AUDIENCE}).encode() + b"\n")
        challenge = json.loads(stream.readline())["challenge"]
        stream.write(json.dumps({
            "op": "redeem",
            "audience": LOCAL_PAIRING_AUDIENCE,
            "nonce": challenge["nonce"],
        }).encode() + b"\n")
        credential = json.loads(stream.readline())["credential"]
    return {"Authorization": f"Bearer {credential['access_token']}"}


@pytest.mark.asyncio
async def test_define_lists_and_persists_bounded_definitions(tmp_path):
    manager = _manager(tmp_path)
    defined = await manager.define(WORKSPACE_ID, _definition(
        ports=[{"name": "http", "port": 4173}],
        health={"port": "http", "path": "/"},
        env=["PYTHONUNBUFFERED"],
        restart="on-failure",
        memoryLimitMb=512,
    ))
    assert defined["name"] == "web"
    assert defined["state"] == "registered"
    assert defined["ports"] == [{"name": "http", "port": 4173}]

    listed = await manager.list(WORKSPACE_ID)
    assert [entry["name"] for entry in listed] == ["web"]

    # A fresh manager on the same state root reads the persisted definition.
    reloaded = WorkspaceServiceManager(
        manager.database, owner_id=OWNER_ID, state_root=tmp_path / "private-state",
    )
    assert [entry["name"] for entry in await reloaded.list(WORKSPACE_ID)] == ["web"]


@pytest.mark.asyncio
async def test_declared_health_target_is_probed_on_loopback(tmp_path):
    calls: list[str] = []
    healthy = {"value": False}

    async def fake_probe(url: str) -> bool:
        calls.append(url)
        return healthy["value"]

    manager = _manager(tmp_path, health_probe=fake_probe)
    await manager.define(WORKSPACE_ID, _definition(
        name="web",
        argv=["/bin/sleep", "5"],
        ports=[{"name": "http", "port": 4173}],
        health={"port": "http", "path": "/health"},
    ))
    await manager.start(WORKSPACE_ID, "web")
    assert (await manager.list(WORKSPACE_ID))[0]["health"] == "starting"
    healthy["value"] = True
    for _ in range(40):
        await asyncio.sleep(0.05)
        if (await manager.list(WORKSPACE_ID))[0]["health"] == "healthy":
            break
    assert (await manager.list(WORKSPACE_ID))[0]["health"] == "healthy"
    assert calls and calls[0] == "http://127.0.0.1:4173/health"
    healthy["value"] = False
    for _ in range(80):
        await asyncio.sleep(0.05)
        if (await manager.list(WORKSPACE_ID))[0]["health"] == "unhealthy":
            break
    assert (await manager.list(WORKSPACE_ID))[0]["health"] == "unhealthy"
    await manager.shutdown()


@pytest.mark.asyncio
async def test_declared_memory_budget_launches_under_a_scope(tmp_path):
    spawned: list[list[str]] = []

    class FakeStream:
        async def read(self, _size: int) -> bytes:
            return b""

    class FakeProcess:
        def __init__(self) -> None:
            self.returncode = None
            self.stdout = FakeStream()

        async def wait(self) -> int:
            while self.returncode is None:
                await asyncio.sleep(0.01)
            return self.returncode

        def terminate(self) -> None:
            self.returncode = 0

        def kill(self) -> None:
            self.returncode = 0

    async def fake_spawn(*argv, **_kwargs):
        spawned.append(list(argv))
        return FakeProcess()

    manager = _manager(tmp_path)
    manager._spawn = fake_spawn
    await manager.define(WORKSPACE_ID, _definition(
        name="limited", argv=["/bin/echo", "hi"], memoryLimitMb=128,
    ))
    manager._memory_enforcement = True
    await manager.start(WORKSPACE_ID, "limited")
    assert spawned and spawned[0][:6] == [
        "systemd-run", "--user", "--scope", "--collect", "--quiet", "-p",
    ]
    assert "MemoryMax=128M" in spawned[0]
    assert "MemorySwapMax=0" in spawned[0]
    assert spawned[0][-3:] == ["--", "/bin/echo", "hi"]
    await manager.shutdown()


@pytest.mark.asyncio
async def test_service_without_health_target_reports_unknown(tmp_path):
    manager = _manager(tmp_path)
    await manager.define(WORKSPACE_ID, _definition(name="plain", argv=["/bin/sleep", "5"]))
    await manager.start(WORKSPACE_ID, "plain")
    await asyncio.sleep(0.2)
    assert (await manager.list(WORKSPACE_ID))[0]["health"] == "unknown"
    await manager.shutdown()


@pytest.mark.asyncio
async def test_define_rejects_invalid_definitions(tmp_path):
    manager = _manager(tmp_path)
    for bad in [
        {"name": "Web", "argv": ["/bin/echo"]},
        {"name": "web", "argv": []},
        {"name": "web", "argv": ["/bin/echo\nbad"]},
        {"name": "web", "argv": ["/bin/echo"], "cwd": "../escape"},
        {"name": "web", "argv": ["/bin/echo"], "cwd": "/etc"},
        {"name": "web", "argv": ["/bin/echo"], "env": ["ARCHON_TOKEN"]},
        {"name": "web", "argv": ["/bin/echo"], "ports": [{"name": "http", "port": 0}]},
        {"name": "web", "argv": ["/bin/echo"], "ports": [
            {"name": "http", "port": 80}, {"name": "http", "port": 81},
        ]},
        {"name": "web", "argv": ["/bin/echo"], "ports": [{"name": "http", "port": 80}],
         "health": {"port": "missing", "path": "/"}},
        {"name": "web", "argv": ["/bin/echo"], "dependsOn": ["web"]},
        {"name": "web", "argv": ["/bin/echo"], "restart": "always"},
        {"name": "web", "argv": ["/bin/echo"], "memoryLimitMb": 1},
        {"name": "web", "argv": ["/bin/echo"], "unknown": True},
    ]:
        with pytest.raises(ValueError):
            await manager.define(WORKSPACE_ID, bad)


@pytest.mark.asyncio
async def test_define_rejects_unknown_dependencies_and_cycles(tmp_path):
    manager = _manager(tmp_path)
    with pytest.raises(WorkspaceServiceConflict):
        await manager.define(WORKSPACE_ID, _definition(name="web", dependsOn=["db"]))
    await manager.define(WORKSPACE_ID, _definition(name="db"))
    await manager.define(WORKSPACE_ID, _definition(name="web", dependsOn=["db"]))
    with pytest.raises(WorkspaceServiceConflict):
        await manager.define(WORKSPACE_ID, _definition(name="db", dependsOn=["web"]))


@pytest.mark.asyncio
async def test_start_lifecycle_logs_and_stop(tmp_path):
    manager = _manager(tmp_path)
    await manager.define(WORKSPACE_ID, _definition(
        name="web", argv=["/bin/sh", "-c", "printf 'svc-line\\n'; sleep 5"],
    ))
    started = await manager.start(WORKSPACE_ID, "web")
    assert started["state"] in {"starting", "running"}
    await asyncio.sleep(0.4)
    running = {entry["name"]: entry for entry in await manager.list(WORKSPACE_ID)}
    assert running["web"]["state"] == "running"
    logs = await manager.logs(WORKSPACE_ID, "web", lines=50)
    assert "svc-line" in logs["text"]
    await manager.stop(WORKSPACE_ID, "web", confirm=True)
    stopped = {entry["name"]: entry for entry in await manager.list(WORKSPACE_ID)}
    assert stopped["web"]["state"] == "stopped"
    # A stopped definition can be started again.
    assert (await manager.start(WORKSPACE_ID, "web"))["state"] in {"starting", "running"}
    await manager.shutdown()


@pytest.mark.asyncio
async def test_start_requires_confirmation_to_stop_and_unknown_names_fail(tmp_path):
    manager = _manager(tmp_path)
    await manager.define(WORKSPACE_ID, _definition(name="web"))
    with pytest.raises(WorkspaceServiceNotFound):
        await manager.start(WORKSPACE_ID, "missing")
    with pytest.raises(WorkspaceServiceNotFound):
        await manager.logs(WORKSPACE_ID, "missing")
    await manager.define(WORKSPACE_ID, _definition(name="idle", argv=["/bin/sleep", "5"]))
    await manager.start(WORKSPACE_ID, "idle")
    with pytest.raises(PermissionError):
        await manager.stop(WORKSPACE_ID, "idle", confirm=False)
    await manager.stop(WORKSPACE_ID, "idle", confirm=True)
    await manager.shutdown()


@pytest.mark.asyncio
async def test_remove_requires_confirmation_and_blocks_dependents(tmp_path):
    manager = _manager(tmp_path)
    await manager.define(WORKSPACE_ID, _definition(name="db"))
    await manager.define(WORKSPACE_ID, _definition(name="web", dependsOn=["db"]))
    with pytest.raises(PermissionError):
        await manager.remove(WORKSPACE_ID, "db", confirm=False)
    with pytest.raises(WorkspaceServiceConflict):
        await manager.remove(WORKSPACE_ID, "db", confirm=True)
    await manager.remove(WORKSPACE_ID, "web", confirm=True)
    await manager.remove(WORKSPACE_ID, "db", confirm=True)
    assert await manager.list(WORKSPACE_ID) == []


@pytest.mark.asyncio
async def test_aggregate_memory_budget_is_enforced(tmp_path):
    class FakeStream:
        async def read(self, _size: int) -> bytes:
            return b""

    class FakeProcess:
        def __init__(self) -> None:
            self.returncode = None
            self.stdout = FakeStream()

        async def wait(self) -> int:
            while self.returncode is None:
                await asyncio.sleep(0.01)
            return self.returncode

        def terminate(self) -> None:
            self.returncode = 0

        def kill(self) -> None:
            self.returncode = 0

    async def fake_spawn(*_argv, **_kwargs):
        return FakeProcess()

    manager = _manager(tmp_path, max_total_memory_mb=256, memory_enforcement=True)
    manager._spawn = fake_spawn
    await manager.define(WORKSPACE_ID, _definition(name="a", argv=["/bin/sleep", "5"], memoryLimitMb=200))
    await manager.define(WORKSPACE_ID, _definition(name="b", argv=["/bin/sleep", "5"], memoryLimitMb=200))
    await manager.start(WORKSPACE_ID, "a")
    with pytest.raises(WorkspaceServiceCapacity):
        await manager.start(WORKSPACE_ID, "b")
    await manager.shutdown()


@pytest.mark.asyncio
async def test_declared_memory_budget_fails_closed_when_unenforced(tmp_path):
    manager = _manager(tmp_path, memory_enforcement=False)
    await manager.define(WORKSPACE_ID, _definition(name="limited", argv=["/bin/echo"], memoryLimitMb=128))
    with pytest.raises(WorkspaceServiceUnavailable):
        await manager.start(WORKSPACE_ID, "limited")
    # A service without a declared budget still starts.
    await manager.define(WORKSPACE_ID, _definition(name="plain", argv=["/bin/sleep", "5"]))
    await manager.start(WORKSPACE_ID, "plain")
    await manager.shutdown()


@pytest.mark.asyncio
async def test_resource_summary_counts_running_reserved_memory(tmp_path):
    class FakeStream:
        async def read(self, _size: int) -> bytes:
            return b""

    class FakeProcess:
        def __init__(self) -> None:
            self.returncode = None
            self.stdout = FakeStream()

        async def wait(self) -> int:
            while self.returncode is None:
                await asyncio.sleep(0.01)
            return self.returncode

        def terminate(self) -> None:
            self.returncode = 0

        def kill(self) -> None:
            self.returncode = 0

    async def fake_spawn(*_argv, **_kwargs):
        return FakeProcess()

    manager = _manager(tmp_path, memory_enforcement=True)
    manager._spawn = fake_spawn
    await manager.define(WORKSPACE_ID, _definition(name="a", argv=["/bin/sleep", "5"], memoryLimitMb=128))
    empty = await manager.resource_summary(WORKSPACE_ID)
    assert empty["services"] == {"registered": 1, "running": 0, "reservedMemoryMb": 0, "maxTotalMemoryMb": 4096}
    await manager.start(WORKSPACE_ID, "a")
    running = await manager.resource_summary(WORKSPACE_ID)
    assert running["services"]["running"] == 1
    assert running["services"]["reservedMemoryMb"] == 128
    await manager.shutdown()


@pytest.mark.asyncio
async def test_resource_summary_rejects_unknown_workspace(tmp_path):
    manager = _manager(tmp_path)
    with pytest.raises(KeyError):
        await manager.resource_summary("workspace-" + "0" * 32)


@pytest.mark.asyncio
async def test_failing_service_reports_failed_without_restart(tmp_path):
    manager = _manager(tmp_path)
    await manager.define(WORKSPACE_ID, _definition(name="bad", argv=["/bin/sh", "-c", "exit 3"]))
    await manager.start(WORKSPACE_ID, "bad")
    await asyncio.sleep(0.4)
    entry = (await manager.list(WORKSPACE_ID))[0]
    assert entry["state"] == "failed"
    assert entry["exitCode"] == 3


def test_local_owner_workspace_service_api_contract(tmp_path):
    settings = Settings(
        archon_root=tmp_path,
        hermes_home=tmp_path / ".hermes",
        data_dir=tmp_path / ".data",
        auth_token="legacy-token",
        local_owner_mode=True,
        start_worker=False,
    )
    with TestClient(create_app(settings)) as client:
        headers = _paired_owner_headers(settings.local_pairing_socket_path)
        workspace_root = tmp_path / "registered-checkout"
        workspace_root.mkdir()
        workspace_id = "workspace-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        client.app.state.store.db.create_workspace(
            workspace_id=workspace_id,
            root=str(workspace_root),
            owner_id=f"local-uid:{os.geteuid()}",
            project_id="project-api-test",
            generation=2,
            isolation_profile="git-checkout",
        )
        collection = f"/api/local/workspaces/{workspace_id}/services"
        assert client.get(collection).status_code == 401

        created = client.put(f"{collection}/web", headers=headers, json={
            "name": "web",
            "argv": ["/bin/sh", "-c", "printf 'api-line\\n'; sleep 5"],
            "ports": [{"name": "http", "port": 4173}],
            "health": {"port": "http", "path": "/"},
            "restart": "on-failure",
        })
        assert created.status_code == 200
        assert created.json()["service"]["state"] == "registered"

        listed = client.get(collection, headers=headers)
        assert listed.status_code == 200
        assert [entry["name"] for entry in listed.json()["services"]] == ["web"]

        mismatch = client.put(f"{collection}/other", headers=headers, json={
            "name": "web", "argv": ["/bin/echo"],
        })
        assert mismatch.status_code == 400
        invalid = client.put(f"{collection}/bad", headers=headers, json={
            "name": "bad", "argv": ["/bin/echo"], "env": ["ARCHON_TOKEN"],
        })
        assert invalid.status_code == 400

        started = client.post(f"{collection}/web/start", headers=headers)
        assert started.status_code == 200
        assert client.post(f"{collection}/missing/start", headers=headers).status_code == 404

        import time
        time.sleep(0.4)
        logs = client.get(f"{collection}/web/logs?lines=50", headers=headers)
        assert logs.status_code == 200
        assert "api-line" in logs.json()["text"]
        assert client.get(f"{collection}/web/logs?lines=999", headers=headers).status_code == 422

        assert client.post(f"{collection}/web/stop", headers=headers, json={"confirm": False}).status_code == 403
        stopped = client.post(f"{collection}/web/stop", headers=headers, json={"confirm": True})
        assert stopped.status_code == 200
        assert client.request("DELETE", f"{collection}/web", headers=headers, json={"confirm": False}).status_code == 403
        removed = client.request("DELETE", f"{collection}/web", headers=headers, json={"confirm": True})
        assert removed.status_code == 200
        assert client.get(collection, headers=headers).json() == {"services": []}

        resources = client.get(f"/api/local/workspaces/{workspace_id}/resources", headers=headers)
        assert resources.status_code == 200
        assert resources.headers["cache-control"] == "no-store"
        body = resources.json()
        assert body["services"] == {"registered": 0, "running": 0, "reservedMemoryMb": 0, "maxTotalMemoryMb": 4096}
        assert body["terminals"] == {"count": 0, "max": 16}


def test_workspace_code_server_template_api(tmp_path):
    settings = Settings(
        archon_root=tmp_path,
        hermes_home=tmp_path / ".hermes",
        data_dir=tmp_path / ".data",
        auth_token="legacy-token",
        local_owner_mode=True,
        start_worker=False,
    )
    with TestClient(create_app(settings)) as client:
        headers = _paired_owner_headers(settings.local_pairing_socket_path)
        workspace_root = tmp_path / "registered-checkout"
        workspace_root.mkdir()
        workspace_id = "workspace-cccccccccccccccccccccccccccccccc"
        client.app.state.store.db.create_workspace(
            workspace_id=workspace_id,
            root=str(workspace_root),
            owner_id=f"local-uid:{os.geteuid()}",
            project_id="project-codeserver",
            generation=1,
            isolation_profile="git-checkout",
        )
        created = client.post(
            f"/api/local/workspaces/{workspace_id}/services/code-server",
            headers=headers,
            json={"port": 4173},
        )
        assert created.status_code == 201
        service = created.json()["service"]
        assert service["name"] == "code-server"
        assert service["argv"][1:5] == ["--bind-addr", "127.0.0.1:4173", "--auth", "none"]
        assert service["ports"] == [{"name": "http", "port": 4173}]
        assert client.post(
            f"/api/local/workspaces/{workspace_id}/services/code-server",
            headers=headers, json={"port": 80},
        ).status_code == 422


def _recording_manager(tmp_path: Path, **kwargs):
    """A manager whose fake spawn records the argv every start would run."""
    manager = _manager(tmp_path, **kwargs)
    launches: list[list[str]] = []

    class FakeStream:
        async def read(self, _size: int) -> bytes:
            return b""

    class FakeProcess:
        def __init__(self) -> None:
            self.returncode = None
            self.stdout = FakeStream()

        async def wait(self) -> int:
            while self.returncode is None:
                await asyncio.sleep(0.01)
            return self.returncode

        def terminate(self) -> None:
            self.returncode = 0

        def kill(self) -> None:
            self.returncode = 0

    async def fake_spawn(*argv, **_kwargs):
        launches.append(list(argv))
        return FakeProcess()

    manager._spawn = fake_spawn
    return manager, launches


@pytest.mark.asyncio
async def test_declared_resource_controls_reach_the_user_scope(tmp_path):
    manager, launches = _recording_manager(
        tmp_path, cpu_enforcement=True, tasks_enforcement=True, memory_enforcement=True,
    )
    await manager.define(WORKSPACE_ID, _definition(
        name="bounded", argv=["/bin/sleep", "5"],
        memoryLimitMb=256, cpuQuotaPercent=50, tasksMax=64,
    ))
    await manager.start(WORKSPACE_ID, "bounded")
    command = launches[-1]
    assert command[:5] == ["systemd-run", "--user", "--scope", "--collect", "--quiet"]
    assert "MemoryMax=256M" in command and "MemorySwapMax=0" in command
    assert "CPUQuota=50%" in command and "TasksMax=64" in command
    assert command[command.index("--") + 1:] == ["/bin/sleep", "5"]
    # The API projection stays the shape the desktop validates; the declared
    # controls are persisted in the private ledger and applied through the scope.
    row = _ledger_rows(tmp_path)[0]
    assert row["cpuQuotaPercent"] == 50 and row["tasksMax"] == 64 and row["memoryLimitMb"] == 256
    listed = [item for item in await manager.list(WORKSPACE_ID) if item["name"] == "bounded"][0]
    assert set(listed) == {
        "name", "argv", "cwd", "ports", "restart", "state", "exitCode", "restarts", "health",
        "memoryLimitMb", "cpuQuotaPercent", "tasksMax", "filesystemIsolation", "networkIsolation",
    }
    assert listed["memoryLimitMb"] == 256 and listed["cpuQuotaPercent"] == 50 and listed["tasksMax"] == 64
    assert listed["filesystemIsolation"] == "none" and listed["networkIsolation"] == "host"
    await manager.shutdown()


@pytest.mark.asyncio
async def test_an_uncontrolled_service_is_still_started_without_a_scope(tmp_path):
    manager, launches = _recording_manager(tmp_path)
    await manager.define(WORKSPACE_ID, _definition(name="plain", argv=["/bin/sleep", "5"]))
    await manager.start(WORKSPACE_ID, "plain")
    assert launches[-1] == ["/bin/sleep", "5"]
    await manager.shutdown()


@pytest.mark.asyncio
async def test_cpu_and_task_controls_fail_closed_when_unenforced(tmp_path):
    manager = _manager(tmp_path, cpu_enforcement=False, tasks_enforcement=False)
    await manager.define(WORKSPACE_ID, _definition(name="cpu", argv=["/bin/echo"], cpuQuotaPercent=25))
    with pytest.raises(WorkspaceServiceUnavailable) as cpu_error:
        await manager.start(WORKSPACE_ID, "cpu")
    assert "CPU quota" in str(cpu_error.value)

    await manager.define(WORKSPACE_ID, _definition(name="tasks", argv=["/bin/echo"], tasksMax=32))
    with pytest.raises(WorkspaceServiceUnavailable) as tasks_error:
        await manager.start(WORKSPACE_ID, "tasks")
    assert "Task limit" in str(tasks_error.value)

    # An undeclared control does not block an ordinary start.
    await manager.define(WORKSPACE_ID, _definition(name="plain", argv=["/bin/echo"]))
    await manager.start(WORKSPACE_ID, "plain")
    await manager.shutdown()


@pytest.mark.asyncio
async def test_resource_control_definitions_are_validated(tmp_path):
    manager = _manager(tmp_path)
    for overrides in (
        {"cpuQuotaPercent": 0}, {"cpuQuotaPercent": 1601}, {"cpuQuotaPercent": True},
        {"cpuQuotaPercent": "50"}, {"tasksMax": 3}, {"tasksMax": 4097}, {"tasksMax": False},
        {"tasksMax": 1.0},
    ):
        with pytest.raises(ValueError):
            await manager.define(WORKSPACE_ID, _definition(name="bad", **overrides))
    await manager.define(WORKSPACE_ID, _definition(name="edges", cpuQuotaPercent=1, tasksMax=4))
    row = _ledger_rows(tmp_path)[0]
    assert row["cpuQuotaPercent"] == 1 and row["tasksMax"] == 4
    await manager.shutdown()


@pytest.mark.asyncio
async def test_absent_controls_are_recorded_as_null_not_zero(tmp_path):
    manager = _manager(tmp_path)
    await manager.define(WORKSPACE_ID, _definition(name="plain"))
    row = _ledger_rows(tmp_path)[0]
    assert row["cpuQuotaPercent"] is None and row["tasksMax"] is None
    await manager.shutdown()


@pytest.mark.skipif(
    shutil.which("systemd-run") is None,
    reason="systemd-run is unavailable on this host",
)
@pytest.mark.asyncio
async def test_this_host_enforces_cpu_quota_and_task_limits():
    """Evidence test: the probes must observe real enforcement here."""
    assert await WorkspaceServiceManager._probe_cpu_enforcement() is True
    assert await WorkspaceServiceManager._probe_tasks_enforcement() is True


@pytest.mark.asyncio
async def test_workspace_only_isolation_wraps_the_service_in_a_confined_mount_view(tmp_path):
    manager, launches = _recording_manager(tmp_path, filesystem_enforcement=True)
    await manager.define(WORKSPACE_ID, _definition(
        name="confined", argv=["/bin/sleep", "5"], filesystemIsolation="workspace-only",
    ))
    await manager.start(WORKSPACE_ID, "confined")
    command = launches[-1]
    assert command[0] == "bwrap" and "--die-with-parent" in command
    assert command[command.index("--ro-bind") + 1:command.index("--ro-bind") + 3] == ["/", "/"]
    workspace = tmp_path / "workspace"
    assert command[command.index("--bind") + 1:command.index("--bind") + 3] == [str(workspace), str(workspace)]
    assert command[command.index("--chdir") + 1] == str(workspace)
    assert command[command.index("--", command.index("--chdir")) + 1:] == ["/bin/sleep", "5"]
    # The confinement is separate from the resource scope.
    assert "systemd-run" not in command
    await manager.shutdown()


@pytest.mark.asyncio
async def test_isolation_and_resource_controls_compose_in_one_scope(tmp_path):
    manager, launches = _recording_manager(
        tmp_path, filesystem_enforcement=True, cpu_enforcement=True, memory_enforcement=True,
    )
    await manager.define(WORKSPACE_ID, _definition(
        name="both", argv=["/bin/sleep", "5"],
        filesystemIsolation="workspace-only", memoryLimitMb=128, cpuQuotaPercent=25,
    ))
    await manager.start(WORKSPACE_ID, "both")
    command = launches[-1]
    assert command[:2] == ["systemd-run", "--user"]
    assert "MemoryMax=128M" in command and "CPUQuota=25%" in command
    assert "bwrap" in command
    # The scope starts the sandbox, which then starts the service.
    assert command[command.index("--", command.index("--collect")) + 1] == "bwrap"
    await manager.shutdown()


@pytest.mark.asyncio
async def test_workspace_only_isolation_fails_closed_when_unavailable(tmp_path):
    manager = _manager(tmp_path, filesystem_enforcement=False)
    await manager.define(WORKSPACE_ID, _definition(
        name="confined", argv=["/bin/echo"], filesystemIsolation="workspace-only",
    ))
    with pytest.raises(WorkspaceServiceUnavailable) as refused:
        await manager.start(WORKSPACE_ID, "confined")
    assert "filesystem isolation" in str(refused.value)
    # The default profile is unaffected.
    await manager.define(WORKSPACE_ID, _definition(name="plain", argv=["/bin/echo"]))
    await manager.start(WORKSPACE_ID, "plain")
    await manager.shutdown()


@pytest.mark.asyncio
async def test_filesystem_isolation_definitions_are_validated(tmp_path):
    manager = _manager(tmp_path)
    for value in ("host", "workspace_only", "", "none ", 0, True, None):
        with pytest.raises(ValueError):
            await manager.define(WORKSPACE_ID, _definition(name="bad", filesystemIsolation=value))
    await manager.define(WORKSPACE_ID, _definition(name="plain"))
    assert _ledger_rows(tmp_path)[0]["filesystemIsolation"] == "none"
    await manager.define(WORKSPACE_ID, _definition(name="confined", filesystemIsolation="workspace-only"))
    rows = {row["name"]: row for row in _ledger_rows(tmp_path)}
    assert rows["confined"]["filesystemIsolation"] == "workspace-only"
    await manager.shutdown()


@pytest.mark.skipif(
    shutil.which("bwrap") is None,
    reason="bubblewrap is unavailable on this host",
)
@pytest.mark.asyncio
async def test_this_host_confines_a_service_to_its_workspace(tmp_path):
    """Evidence test: the probe must observe a denied host write and an allowed workspace write."""
    from archon_server.sandbox import probe_filesystem_confinement

    assert await asyncio.to_thread(probe_filesystem_confinement, tmp_path) is True


@pytest.mark.asyncio
async def test_network_isolated_service_runs_without_a_network_namespace_route(tmp_path):
    manager, launches = _recording_manager(tmp_path, network_enforcement=True)
    await manager.define(WORKSPACE_ID, _definition(
        name="offline", argv=["/bin/sleep", "5"], networkIsolation="isolated",
    ))
    await manager.start(WORKSPACE_ID, "offline")
    command = launches[-1]
    assert command[0] == "bwrap" and "--unshare-net" in command
    # No filesystem confinement was requested, so the filesystem stays as it was.
    assert "--ro-bind" not in command
    assert command[command.index("--", command.index("--proc")) + 1:] == ["/bin/sleep", "5"]
    await manager.shutdown()


@pytest.mark.asyncio
async def test_both_confinements_share_one_namespace_invocation(tmp_path):
    manager, launches = _recording_manager(tmp_path, network_enforcement=True, filesystem_enforcement=True)
    await manager.define(WORKSPACE_ID, _definition(
        name="sealed", argv=["/bin/sleep", "5"],
        filesystemIsolation="workspace-only", networkIsolation="isolated",
    ))
    await manager.start(WORKSPACE_ID, "sealed")
    command = launches[-1]
    assert command.count("bwrap") == 1
    assert "--ro-bind" in command and "--unshare-net" in command
    workspace = tmp_path / "workspace"
    assert command[command.index("--bind") + 1:command.index("--bind") + 3] == [str(workspace), str(workspace)]
    await manager.shutdown()


@pytest.mark.asyncio
async def test_network_isolation_fails_closed_when_unavailable(tmp_path):
    manager = _manager(tmp_path, network_enforcement=False)
    await manager.define(WORKSPACE_ID, _definition(
        name="offline", argv=["/bin/echo"], networkIsolation="isolated",
    ))
    with pytest.raises(WorkspaceServiceUnavailable) as refused:
        await manager.start(WORKSPACE_ID, "offline")
    assert "Network isolation" in str(refused.value)
    await manager.shutdown()


@pytest.mark.asyncio
async def test_network_isolation_definitions_are_validated(tmp_path):
    manager = _manager(tmp_path)
    for value in ("none", "off", "", True, 1, None):
        with pytest.raises(ValueError):
            await manager.define(WORKSPACE_ID, _definition(name="bad", networkIsolation=value))
    # A port or health target can never be reached without a network.
    for overrides in (
        {"ports": [{"name": "http", "port": 4173}]},
        {"ports": [{"name": "http", "port": 4173}], "health": {"port": "http", "path": "/"}},
    ):
        with pytest.raises(ValueError):
            await manager.define(WORKSPACE_ID, _definition(
                name="bad", networkIsolation="isolated", **overrides,
            ))
    await manager.define(WORKSPACE_ID, _definition(name="plain"))
    assert _ledger_rows(tmp_path)[0]["networkIsolation"] == "host"
    await manager.define(WORKSPACE_ID, _definition(name="offline", networkIsolation="isolated"))
    rows = {row["name"]: row for row in _ledger_rows(tmp_path)}
    assert rows["offline"]["networkIsolation"] == "isolated"
    await manager.shutdown()


@pytest.mark.skipif(
    shutil.which("bwrap") is None,
    reason="bubblewrap is unavailable on this host",
)
@pytest.mark.asyncio
async def test_this_host_blocks_network_access_inside_the_sandbox():
    """Evidence test: the probe must observe an unreachable network in the sandbox."""
    from archon_server.sandbox import probe_network_isolation

    assert await asyncio.to_thread(probe_network_isolation) is True
