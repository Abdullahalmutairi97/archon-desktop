from __future__ import annotations

from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from archon_server.app import create_app
from archon_server.config import Settings
from archon_server.readiness import WorkerTracker


class FixtureRunner:
    def __init__(self, executable):
        self.executable = executable
        self.calls = 0

    async def run(self, task, emit):
        self.calls += 1
        return {"text": "fixture result"}


def _executable(path):
    path.write_text("#!/bin/sh\nexit 0\n")
    path.chmod(0o700)
    return path


def _settings(tmp_path, *, start_worker=False, executable=None, **overrides):
    values = {
        "archon_root": tmp_path,
        "hermes_home": tmp_path / ".hermes",
        "data_dir": tmp_path / "data",
        "auth_token": "readiness-test-token",
        "start_worker": start_worker,
        "worker_count": 1,
        "worker_poll_seconds": 0.05,
        "prime_executable": executable or tmp_path / "missing-prime",
        "pi_executable": tmp_path / "missing-pi",
    }
    values.update(overrides)
    return Settings(**values)


def test_create_app_rejects_missing_auth_before_creating_database_directory(tmp_path):
    data_dir = tmp_path / "must-not-exist"

    with pytest.raises(ValueError, match="AUTH_TOKEN"):
        create_app(Settings(data_dir=data_dir, auth_token="", start_worker=False))

    assert not data_dir.exists()


def test_readiness_is_authenticated_and_reports_dispatch_evidence_only(tmp_path):
    executable = _executable(tmp_path / "prime-agent")
    settings = _settings(tmp_path, start_worker=True, executable=executable)
    app = create_app(settings, runner=FixtureRunner(executable))

    with TestClient(app) as client:
        assert client.get("/api/health").json() == {
            "ok": True,
            "service": "archon-desktop-server",
            "version": app.version,
        }
        assert client.get("/api/readiness").status_code == 401
        response = client.get(
            "/api/readiness",
            headers={"Authorization": "Bearer readiness-test-token"},
        )

    assert response.status_code == 200
    body = response.json()
    assert body["dispatch_ready"] is True
    assert body["execution_verified"] is False
    assert body["credentials_verified"] is False
    assert body["native_conformance_verified"] is False
    assert body["storage"] == {"status": "ready", "readable": True, "writable": True}
    assert body["workers"]["configured"] == 1
    assert body["workers"]["enabled"] is True
    assert body["workers"]["live"] == 1
    assert body["runtimes"] == [{
        "id": "prime",
        "available": True,
        "dispatch_ready": True,
        "check_type": "executable_file",
        "version_verified": False,
    }]
    assert body["transport"]["configuration_verified"] is True
    assert body["transport"]["private_tls_verified"] is False
    assert body["transport"]["verification_level"] == "configuration_only"
    assert app.state.runtimes.runners["prime"].calls == 0


def test_disabled_workers_and_unavailable_runtime_return_503(tmp_path):
    settings = _settings(tmp_path, start_worker=False, executable=tmp_path / "missing")
    app = create_app(settings)

    with TestClient(app) as client:
        response = client.get(
            "/api/readiness",
            headers={"Authorization": "Bearer readiness-test-token"},
        )

    assert response.status_code == 503
    body = response.json()
    assert body["dispatch_ready"] is False
    assert body["workers"]["enabled"] is False
    assert body["workers"]["live"] == 0
    assert body["runtimes"]
    assert not any(runtime["dispatch_ready"] for runtime in body["runtimes"])


def test_partial_runtime_outage_is_reported_per_canonical_runtime(tmp_path):
    prime = _executable(tmp_path / "prime-agent")
    pi = tmp_path / "missing-pi"
    app = create_app(_settings(
        tmp_path, executable=prime, prime_executable=prime, pi_executable=pi,
    ))

    with TestClient(app) as client:
        response = client.get(
            "/api/readiness",
            headers={"Authorization": "Bearer readiness-test-token"},
        )

    assert response.status_code == 503  # execution is disabled in this fixture
    runtimes = {item["id"]: item for item in response.json()["runtimes"]}
    assert runtimes["prime"]["dispatch_ready"] is True
    assert runtimes["pi"]["dispatch_ready"] is False
    assert runtimes["pi"]["last_error_code"] == "executable_unavailable"


def test_queue_readiness_uses_aggregate_counts_and_clamps_age(tmp_path):
    executable = _executable(tmp_path / "prime-agent")
    app = create_app(_settings(tmp_path, executable=executable))

    with TestClient(app) as client:
        app.state.store.submit("queued work", cwd=str(tmp_path), approval_mode="auto", runtime_id="prime")
        response = client.get(
            "/api/readiness",
            headers={"Authorization": "Bearer readiness-test-token"},
        )

    body = response.json()
    assert response.status_code == 503  # workers are deliberately disabled
    assert body["queue"]["queued"] == 1
    assert body["queue"]["running"] == 0
    assert body["queue"]["oldest_queued_age_seconds"] >= 0
    assert body["queue"]["oldest_queued_at"].endswith("+00:00")


def test_storage_failure_is_classified_without_exposing_exception_text(tmp_path, monkeypatch):
    app = create_app(_settings(tmp_path))

    def fail():
        raise OSError("private path and secret marker")

    with TestClient(app) as client:
        monkeypatch.setattr(app.state.store, "readiness_stats", fail)
        response = client.get(
            "/api/readiness",
            headers={"Authorization": "Bearer readiness-test-token"},
        )

    assert response.status_code == 503
    assert response.json()["storage"] == {
        "status": "unavailable",
        "readable": False,
        "writable": False,
        "last_error_code": "storage_unavailable",
    }
    assert "private path" not in response.text
    assert response.json()["queue"] == {"queued": None, "running": None}


def test_worker_tracker_reports_busy_stale_and_crashed_task_references():
    wall = [datetime(2026, 9, 26, tzinfo=timezone.utc)]
    ticks = [10.0]

    class FakeTask:
        is_done = False
        failure = None

        def done(self):
            return self.is_done

        def cancelled(self):
            return False

        def exception(self):
            return self.failure

    task = FakeTask()
    tracker = WorkerTracker(
        clock=lambda: wall[0], monotonic=lambda: ticks[0],
        heartbeat_timeout_seconds=5,
    )
    tracker.configure(["worker-1"])
    tracker.register("worker-1")
    tracker.claimed("worker-1", "task-a", "attempt-a")
    busy = tracker.snapshot({"worker-1": task})
    assert busy["live"] == busy["busy"] == 1
    assert busy["items"][0]["current_attempt_id"] == "attempt-a"

    ticks[0] = 13.0
    tracker.heartbeat("worker-1")  # a long native turn remains alive without output
    assert tracker.snapshot({"worker-1": task})["items"][0]["state"] == "busy"

    ticks[0] = 20.0
    stale = tracker.snapshot({"worker-1": task})
    assert stale["live"] == 0
    assert stale["items"][0]["state"] == "stale"

    task.is_done = True
    task.failure = RuntimeError("must not leak")
    crashed = tracker.snapshot({"worker-1": task})
    assert crashed["items"][0]["state"] == "crashed"
    assert crashed["items"][0]["last_error_code"] == "worker_loop_failed"


@pytest.mark.parametrize("message", [
    {},
    {"token": None},
    {"token": "wrong"},
    {"token": " readiness-test-token"},
    {"token": "readiness-test-token "},
])
def test_websocket_auth_rejects_missing_wrong_and_whitespace_tokens_before_bridge(tmp_path, message):
    app = create_app(_settings(tmp_path))
    bridge_called = False

    async def bridge(*_args):
        nonlocal bridge_called
        bridge_called = True
        raise AssertionError("unauthorized websocket reached the terminal bridge")

    with TestClient(app) as client:
        app.state.services["terminals"].bridge = bridge
        with client.websocket_connect("/api/terminals/test/ws") as socket:
            socket.send_json(message)
            with pytest.raises(WebSocketDisconnect) as closed:
                socket.receive_json()
        assert closed.value.code == 4401

    assert bridge_called is False


def test_websocket_auth_timeout_closes_without_starting_terminal_bridge(tmp_path, monkeypatch):
    import archon_server.app as app_module

    monkeypatch.setattr(app_module, "WEBSOCKET_AUTH_TIMEOUT_SECONDS", 0.02)
    app = create_app(_settings(tmp_path))

    with TestClient(app) as client:
        with client.websocket_connect("/api/terminals/test/ws") as socket:
            with pytest.raises(WebSocketDisconnect) as closed:
                socket.receive_json()

    assert closed.value.code == 4401


def test_websocket_malformed_auth_frame_closes_cleanly_before_bridge(tmp_path):
    app = create_app(_settings(tmp_path))
    bridge_called = False

    async def bridge(*_args):
        nonlocal bridge_called
        bridge_called = True

    with TestClient(app) as client:
        app.state.services["terminals"].bridge = bridge
        with client.websocket_connect("/api/terminals/test/ws") as socket:
            socket.send_text("not-json")
            with pytest.raises(WebSocketDisconnect) as closed:
                socket.receive_json()

    assert closed.value.code == 4401
    assert bridge_called is False


def test_websocket_valid_token_uses_shared_authorization_policy(tmp_path):
    app = create_app(_settings(tmp_path))
    bridged = []

    async def bridge(websocket, name):
        bridged.append(name)
        await websocket.send_json({"connected": True})

    with TestClient(app) as client:
        app.state.services["terminals"].bridge = bridge
        with client.websocket_connect("/api/terminals/work/ws") as socket:
            socket.send_json({"token": "readiness-test-token"})
            assert socket.receive_json() == {"connected": True}

    assert bridged == ["work"]
