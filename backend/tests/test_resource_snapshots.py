"""Immutable per-attempt resource snapshots and runtime pins."""
from __future__ import annotations

import asyncio
import json
import os
import stat
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from archon_server.resource_snapshots import (
    ResourcePinLedger,
    ResourceSnapshotStore,
    ResourceSnapshotUnavailable,
)

DIGEST = "a" * 64
OTHER_DIGEST = "b" * 64


def _clock():
    state = {"now": datetime(2026, 1, 1, tzinfo=timezone.utc)}

    def read() -> datetime:
        return state["now"]

    read.advance = lambda seconds: state.update(now=state["now"] + timedelta(seconds=seconds))  # type: ignore[attr-defined]
    return read


def _manifest(**overrides):
    row = {
        "id": "prime",
        "available": True,
        "version": "0.9.6",
        "version_verified": False,
        "manifest_version": 1,
        "executable": "/home/owner/.local/bin/prime-agent",
        "executable_digest": DIGEST,
        "capabilities": {"modalities": ["prompt"], "resume": False, "secret": "ignored"},
    }
    row.update(overrides)
    return row


def test_a_snapshot_is_private_immutable_and_identity_only(tmp_path):
    store = ResourceSnapshotStore(tmp_path / "attempts")
    record = store.record(
        task_id="task-1", attempt_id="attempt-1", approval_mode="auto",
        workspace_id="workspace-abc", workspace_generation=3,
        manifests=[_manifest()], runtime_id="prime",
        pins={"digest": DIGEST, "pinnedAt": "2026-01-01T00:00:00+00:00", "drifted": False},
    )
    assert record["runtime"]["id"] == "prime" and record["runtime"]["executableDigest"] == DIGEST
    assert record["runtime"]["capabilities"] == {"modalities": ["prompt"], "resume": False}
    assert record["workspaceGeneration"] == 3 and record["approvalMode"] == "auto"
    assert record["pin"]["digest"] == DIGEST

    path = tmp_path / "attempts" / "task-1__attempt-1.json"
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    assert stat.S_IMODE(os.stat(path.parent).st_mode) == 0o700

    # A second record for the same attempt is refused: the snapshot is history.
    with pytest.raises(ResourceSnapshotUnavailable):
        store.record(task_id="task-1", attempt_id="attempt-1", manifests=[_manifest()])

    assert store.status()["rawValuesStored"] is False
    assert [row["attemptId"] for row in store.list(task_id="task-1")] == ["attempt-1"]
    assert store.clear() == 1
    assert store.list() == []


def test_snapshots_are_bounded_and_refuse_a_tampered_or_unsafe_file(tmp_path):
    store = ResourceSnapshotStore(tmp_path / "attempts", max_snapshots=2)
    for index in range(3):
        store.record(task_id=f"task-{index}", attempt_id="attempt-1", manifests=[_manifest()])
    assert len(store.list(limit=10)) == 2

    with pytest.raises(ValueError):
        store.record(task_id="bad id", attempt_id="attempt-1")
    with pytest.raises(ValueError):
        store.read("task-0", "no/slash")

    path = tmp_path / "attempts" / "task-2__attempt-1.json"
    if not path.exists():
        path = sorted((tmp_path / "attempts").glob("*.json"))[0]
    path.chmod(0o644)
    with pytest.raises(ResourceSnapshotUnavailable):
        store.read(path.stem.partition("__")[0], "attempt-1")
    path.chmod(0o600)
    path.write_bytes(b"not json")
    with pytest.raises(ResourceSnapshotUnavailable):
        store.read(path.stem.partition("__")[0], "attempt-1")
    path.write_bytes(json.dumps({"version": 2}).encode())
    with pytest.raises(ResourceSnapshotUnavailable):
        store.read(path.stem.partition("__")[0], "attempt-1")


def test_pins_report_drift_and_only_roll_back_to_a_recorded_identity(tmp_path):
    pins = ResourcePinLedger(tmp_path / "pins")
    pinned = pins.pin(runtime="prime", digest=DIGEST, note="accepted 0.9.6")
    assert pinned["pins"]["prime"]["digest"] == DIGEST

    # The host moved to a different binary: drift is reported, not corrected.
    drifted = pins.drift([_manifest(executable_digest=OTHER_DIGEST)])
    assert drifted["pins"][0]["drifted"] is True and drifted["pins"][0]["observedDigest"] == OTHER_DIGEST
    assert "never installs or restores a binary" in drifted["note"]

    # An unknown digest cannot be adopted, and a runtime with no pin has no history.
    with pytest.raises(ResourceSnapshotUnavailable):
        pins.pin(runtime="prime", digest=OTHER_DIGEST)
    with pytest.raises(ResourceSnapshotUnavailable):
        pins.pin(runtime="pi", digest=DIGEST, history=("rollback",))

    # Accepting the identity the host reports now is how an update becomes the pin,
    # and the previous digest stays available as a rollback target.
    accepted = pins.pin(runtime="prime", digest=OTHER_DIGEST, note="accept update", accept_observed=True)
    assert accepted["pins"]["prime"]["history"] == [DIGEST]
    assert pins.drift([_manifest(executable_digest=OTHER_DIGEST)])["pins"][0]["drifted"] is False

    # Rolling back re-adopts a digest this ledger recorded.
    pins.pin(runtime="prime", digest=DIGEST, note="rollback")
    assert pins.drift([_manifest(executable_digest=DIGEST)])["pins"][0]["drifted"] is False
    pins.unpin("prime")
    assert pins.drift([_manifest()])["pins"] == []
    with pytest.raises(ResourceSnapshotUnavailable):
        pins.unpin("prime")


def test_a_pin_ledger_with_an_unsafe_or_malformed_file_fails_closed(tmp_path):
    pins = ResourcePinLedger(tmp_path / "pins")
    pins.pin(runtime="prime", digest=DIGEST)
    path = tmp_path / "pins" / "pins.json"
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    path.chmod(0o640)
    with pytest.raises(ResourceSnapshotUnavailable):
        pins.drift([_manifest()])
    path.chmod(0o600)
    path.write_bytes(json.dumps({"version": 1, "pins": []}).encode())
    with pytest.raises(ResourceSnapshotUnavailable):
        pins.drift([_manifest()])


def test_constructor_bounds(tmp_path):
    for kwargs in ({"max_snapshots": 0}, {"max_snapshots": 9000}):
        with pytest.raises(ValueError):
            ResourceSnapshotStore(tmp_path / "bounded", **kwargs)
    with pytest.raises(ValueError):
        ResourceSnapshotStore("relative/path")
    store = ResourceSnapshotStore(tmp_path / "limits")
    with pytest.raises(ValueError):
        store.list(limit=0)
    with pytest.raises(ValueError):
        store.list(limit=1000)


@pytest.mark.asyncio
async def test_the_engine_snapshots_every_attempt_and_survives_a_broken_sink(tmp_path):
    from archon_server.db import Database
    from archon_server.tasks import TaskEngine, TaskStore

    class Runner:
        async def run(self, task, emit):
            await emit("delta", {"text": "working"})
            return {"text": "ok"}

    store = TaskStore(Database(tmp_path / "state.db"))
    snapshots = ResourceSnapshotStore(tmp_path / "attempts")
    recorded: list[dict] = []
    engine = TaskEngine(store, Runner(), snapshot_sink=lambda attempt: recorded.append(dict(attempt)))
    store.submit("do work")
    assert await engine.run_once() is True
    assert recorded[0]["task_id"] and recorded[0]["attempt_id"]
    assert recorded[0]["runtime_id"] in {None, "prime"}

    class BrokenSink:
        def __call__(self, attempt):
            raise RuntimeError("snapshot storage exploded")

    store_two = TaskStore(Database(tmp_path / "state2.db"))
    broken = TaskEngine(store_two, Runner(), snapshot_sink=BrokenSink())
    submitted = store_two.submit("do work anyway")
    assert await broken.run_once() is True
    assert store_two.get(submitted["id"])["status"] == "completed"


def test_the_snapshot_and_pin_api_is_owner_only(tmp_path):
    from fastapi.testclient import TestClient

    from archon_server.app import create_app
    from archon_server.config import Settings

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
        store = client.app.state.resource_snapshots
        pins = client.app.state.resource_pins
        store.record(task_id="task-1", attempt_id="attempt-1",
                     manifests=[{"id": "prime", "executable_digest": DIGEST, "available": True}],
                     runtime_id="prime", approval_mode="auto")
        pins.pin(runtime="prime", digest=DIGEST, note="accepted")

        assert client.get("/api/local/resources/snapshots").status_code == 401
        listed = client.get("/api/local/resources/snapshots", headers=headers).json()
        assert listed["rawValuesStored"] is False and listed["snapshots"][0]["attemptId"] == "attempt-1"
        # A filter selects only that task's attempts, and an invalid id is refused.
        other = client.get("/api/local/resources/snapshots", headers=headers, params={"task_id": "other"}).json()
        assert other["snapshots"] == []
        assert client.get("/api/local/resources/snapshots", headers=headers,
                          params={"task_id": "bad id"}).status_code == 400
        one = client.get("/api/local/resources/snapshots/task-1/attempt-1", headers=headers)
        assert one.status_code == 200 and one.json()["snapshot"]["runtime"]["id"] == "prime"
        assert client.get("/api/local/resources/snapshots/task-1/missing", headers=headers).status_code == 404

        drift = client.get("/api/local/resources/pins", headers=headers).json()
        assert drift["pins"][0]["runtime"] == "prime"
        # Pinning the observed identity needs an executable on this host. Where the
        # runtime is not installed there is nothing to pin, and the server says so
        # instead of recording an empty identity.
        observed_digest = next(
            (row.get("executable_digest") for row in client.app.state.runtimes.describe() if row["id"] == "prime"),
            None,
        )
        pinned = client.post("/api/local/resources/pins", headers=headers,
                             json={"runtime": "prime", "note": "re-accepted"})
        if observed_digest:
            assert pinned.status_code == 201
        else:
            assert pinned.status_code == 400 and "No executable digest" in pinned.json()["detail"]
        adopted = client.post("/api/local/resources/pins", headers=headers,
                              json={"runtime": "prime", "digest": OTHER_DIGEST})
        assert adopted.status_code == 409
        assert client.post("/api/local/resources/pins", headers=headers,
                           json={"runtime": "prime", "digest": "not-a-digest"}).status_code == 422
        removed = client.request("DELETE", "/api/local/resources/pins/prime", headers=headers)
        assert removed.status_code == 200 and removed.json()["pins"] == []
        cleared = client.request("DELETE", "/api/local/resources/snapshots", headers=headers)
        assert cleared.status_code == 200 and cleared.json()["removed"] == 1


def _paired_owner_headers(socket_path: Path) -> dict[str, str]:
    """Self-contained pairing helper: CI runs pytest where `tests` is not a package."""
    import socket as _socket

    from archon_server.local_pairing import LOCAL_PAIRING_AUDIENCE

    with _socket.socket(_socket.AF_UNIX, _socket.SOCK_STREAM) as connection:
        connection.settimeout(3)
        connection.connect(str(socket_path))
        stream = connection.makefile("rwb", buffering=0)
        stream.write(json.dumps({"op": "challenge", "audience": LOCAL_PAIRING_AUDIENCE}).encode() + b"\n")
        challenge = json.loads(stream.readline())["challenge"]
        stream.write(json.dumps({
            "op": "redeem", "audience": LOCAL_PAIRING_AUDIENCE, "nonce": challenge["nonce"],
        }).encode() + b"\n")
        credential = json.loads(stream.readline())["credential"]
    return {"Authorization": f"Bearer {credential['access_token']}"}
