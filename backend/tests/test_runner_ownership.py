import pytest
from fastapi.testclient import TestClient

from archon_server.app import create_app
from archon_server.config import Settings
from archon_server.runner_ownership import RunnerOwnershipLock


def test_only_one_app_lifespan_can_own_the_local_runner(tmp_path):
    settings = Settings(
        archon_root=tmp_path,
        hermes_home=tmp_path / ".hermes",
        data_dir=tmp_path / ".data",
        auth_token="test",
        start_worker=False,
    )
    first = create_app(settings)
    second_owner = RunnerOwnershipLock(settings.runner_journal_path.parent / "server.lock")

    with TestClient(first):
        with pytest.raises(RuntimeError, match="runner ownership is already held"):
            second_owner.acquire()

    # Shutdown releases the OS lock, so a subsequent server process can start.
    second_owner.acquire()
    second_owner.release()


def test_startup_replay_failure_releases_runner_ownership(tmp_path, monkeypatch):
    settings = Settings(
        archon_root=tmp_path,
        hermes_home=tmp_path / ".hermes",
        data_dir=tmp_path / ".data",
        auth_token="test",
        start_worker=False,
    )
    app = create_app(settings)

    def fail_replay(_engine):
        raise RuntimeError("injected replay failure")

    monkeypatch.setattr("archon_server.tasks.TaskEngine.replay_unacked", fail_replay)
    with pytest.raises(RuntimeError, match="injected replay failure"):
        with TestClient(app):
            pass

    owner = RunnerOwnershipLock(settings.runner_journal_path.parent / "server.lock")
    owner.acquire()
    owner.release()
