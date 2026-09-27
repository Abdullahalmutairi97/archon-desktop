from __future__ import annotations

import asyncio
import json
import os
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
             memory_enforcement: bool | None = None) -> WorkspaceServiceManager:
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
    )


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
