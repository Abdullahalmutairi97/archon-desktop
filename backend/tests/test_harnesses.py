import json
import stat
import time

import pytest
from fastapi.testclient import TestClient

from archon_server.app import create_app
from archon_server.config import Settings
from archon_server.services.harnesses import Harness, HarnessError, HarnessService


def script(path, body):
    path.write_text("#!/bin/sh\n" + body + "\n")
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return path


@pytest.fixture
def setup(tmp_path):
    bins = tmp_path / "bin"
    bins.mkdir()
    prime = script(bins / "prime-agent", "echo 0.9.6")
    pi = script(bins / "pi", 'echo "pi 0.87.1"')
    log = tmp_path / "npm.log"
    npm = script(bins / "npm", f'echo "$@" >> {log}\nif [ "$1" = view ]; then echo 0.88.0; fi')
    auth = tmp_path / "auth.json"
    auth.write_text(json.dumps({"deepseek": {"key": "SECRET-VALUE"}, "empty": {}}))
    usage = {"pi": {"sessions": 3, "running": 0}}
    service = HarnessService([
        Harness("prime", "Prime", "d", prime, auth, None),
        Harness("pi", "Pi", "d", pi, auth, "@earendil-works/pi-coding-agent"),
        Harness("opencode", "OpenCode", "d", bins / "missing-opencode", None, "opencode-ai"),
    ], tmp_path / "state" / "harnesses.json", npm=str(npm), runtime_usage=lambda: usage)
    return service, usage, log, pi


def test_inventory_reports_install_version_sign_ins_and_usage(setup):
    service, *_ = setup
    rows = {row["id"]: row for row in service.list()}
    assert (rows["prime"]["version"], rows["pi"]["version"]) == ("0.9.6", "0.87.1")
    assert rows["pi"]["signed_in"] == ["deepseek"] and rows["pi"]["sessions"] == 3
    assert rows["opencode"]["installed"] is False and rows["opencode"]["ready"] is False
    assert rows["prime"]["can_update"] is False and rows["pi"]["can_update"] is True
    assert "SECRET-VALUE" not in json.dumps(rows)


def test_turning_off_and_default_model_persist(setup, tmp_path):
    service, *_ = setup
    assert service.configure("pi", enabled=False)["ready"] is False
    assert service.enabled("pi") is False and service.enabled("prime") is True
    assert service.configure("opencode", default_model="opencode/nemotron-3-ultra-free")["default_model"] == "opencode/nemotron-3-ultra-free"
    reloaded = HarnessService(list(service.harnesses.values()), tmp_path / "state" / "harnesses.json")
    assert reloaded.enabled("pi") is False and reloaded.default_model("opencode") == "opencode/nemotron-3-ultra-free"
    assert service.configure("opencode", default_model="")["default_model"] is None
    with pytest.raises(ValueError):
        service.configure("prime", default_model="openai/gpt")
    with pytest.raises(ValueError):
        service.configure("opencode", default_model="no slash; rm -rf")
    with pytest.raises(KeyError):
        service.configure("codex", enabled=True)


async def test_check_finds_updates_and_update_needs_confirmation(setup):
    service, usage, log, pi = setup
    checked = await service.check("pi")
    assert checked["ok"] and checked["latest"] == "0.88.0" and checked["update_available"]
    missing = await service.check("opencode")
    assert not missing["ok"] and "missing" in missing["problems"][0]

    with pytest.raises(PermissionError):
        await service.update("pi", confirm=False)
    with pytest.raises(ValueError):
        await service.update("prime", confirm=True)
    usage["pi"]["running"] = 1
    with pytest.raises(HarnessError, match="running work"):
        await service.update("pi", confirm=True)
    usage["pi"]["running"] = 0
    script(pi, 'echo "pi 0.88.0"')
    updated = await service.update("pi", confirm=True)
    assert "install -g @earendil-works/pi-coding-agent@latest" in log.read_text()
    assert updated["version"] == "0.88.0" and not updated["update_available"]


def test_turned_off_harnesses_refuse_new_and_continued_work(tmp_path):
    exe = tmp_path / "opencode"
    log = tmp_path / "calls.log"
    script(exe, f'''if [ "$1" = --version ]; then echo 1.18.33; exit 0; fi
if [ "$1" = models ]; then echo opencode/big-pickle; exit 0; fi
echo "$@" >> {log}
echo '{{"type":"text","sessionID":"ses_1","part":{{"type":"text","text":"done"}}}}\'''')
    settings = Settings(
        archon_root=tmp_path, hermes_home=tmp_path / "hermes", data_dir=tmp_path / "data",
        prime_agent_session_dir=tmp_path / "prime", prime_agent_artifact_dir=tmp_path / "artifacts",
        pi_agent_session_dir=tmp_path / "pi", prime_executable=tmp_path / "no-prime", pi_executable=tmp_path / "no-pi",
        opencode_executable=exe, auth_token="t", worker_poll_seconds=0.05,
    )
    with TestClient(create_app(settings)) as client:
        client.headers["Authorization"] = "Bearer t"

        def finish(task_id):
            for _ in range(200):
                task = client.get(f"/api/tasks/{task_id}").json()["task"]
                if task["status"] in ("completed", "failed"):
                    return task
                time.sleep(0.05)
            raise AssertionError("task did not finish")

        rows = {row["id"]: row for row in client.get("/api/harnesses").json()["harnesses"]}
        assert rows["opencode"]["ready"] and rows["opencode"]["version"] == "1.18.33"
        assert rows["pi"]["installed"] is False

        client.put("/api/harnesses/opencode", json={"default_model": "opencode/nemotron-3-ultra-free"})
        first = client.post("/api/tasks", json={"prompt": "hi", "profile": "opencode", "cwd": str(tmp_path)}).json()["task"]
        assert finish(first["id"])["status"] == "completed"
        assert "--model opencode/nemotron-3-ultra-free" in log.read_text()

        assert client.put("/api/harnesses/opencode", json={"enabled": False}).json()["ready"] is False
        refused = client.post("/api/tasks", json={"prompt": "again", "profile": "opencode"})
        assert refused.status_code == 409 and "turned off" in refused.json()["detail"]
        reply = client.post("/api/tasks", json={"prompt": "more", "session_id": f"prime-{first['id']}"})
        assert reply.status_code == 409
        assert client.get("/api/agents").json()["agents"][-1]["available"] is False

        client.put("/api/harnesses/opencode", json={"enabled": True})
        assert client.post("/api/tasks", json={"prompt": "back", "profile": "opencode"}).status_code == 202
        assert client.put("/api/harnesses/nope", json={"enabled": True}).status_code == 404
        assert client.post("/api/harnesses/opencode/update", json={}).status_code == 403
        assert client.post("/api/harnesses/prime/update", json={"confirm": True}).status_code == 400
