import json
import stat
import time

import pytest
from fastapi.testclient import TestClient

from archon_server.app import create_app
from archon_server.config import Settings
from archon_server.opencode_runner import OpenCodeModels, OpenCodeRunner

FAKE = r'''#!/usr/bin/env python3
import json, os, sys
log = os.environ["FAKE_OPENCODE_LOG"]
args = sys.argv[1:]
with open(log, "a") as fh:
    fh.write(json.dumps({"argv": args, "config": os.environ.get("OPENCODE_CONFIG_CONTENT"), "cwd": os.getcwd()}) + "\n")
if args[:1] == ["models"]:
    print("opencode/big-pickle\nopencode/nemotron-3-ultra-free\nnot a model line")
    sys.exit(0)
prompt = args[-1]
session = args[args.index("--session") + 1] if "--session" in args else "ses_fake123"
def emit(kind, part):
    part.setdefault("sessionID", session)
    print(json.dumps({"type": kind, "sessionID": session, "part": part}), flush=True)
if prompt == "explode":
    print(json.dumps({"type": "error", "sessionID": session, "error": {"name": "APIError", "data": {"message": "model unavailable"}}}), flush=True)
    sys.exit(1)
emit("step_start", {"type": "step-start"})
emit("tool_use", {"type": "tool", "tool": "read", "callID": "c1", "state": {"status": "completed", "input": {"filePath": "a.py"}, "output": "print(1)"}})
emit("text", {"type": "text", "text": "Looking at a.py."})
emit("tool_use", {"type": "tool", "tool": "edit", "callID": "c2", "state": {"status": "error", "input": {"filePath": "a.py"}, "error": "The user rejected permission"}})
emit("text", {"type": "text", "text": "Answer: " + prompt})
emit("step_finish", {"type": "step-finish", "reason": "stop"})
'''


@pytest.fixture
def fake(tmp_path, monkeypatch):
    exe = tmp_path / "opencode"
    exe.write_text(FAKE)
    exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
    log = tmp_path / "calls.jsonl"
    monkeypatch.setenv("FAKE_OPENCODE_LOG", str(log))
    return exe, log


def calls(log):
    return [json.loads(line) for line in log.read_text().splitlines() if line.strip()]


async def test_turns_stream_events_mirror_history_and_continue_the_session(tmp_path, fake):
    exe, log = fake
    runner = OpenCodeRunner(exe, tmp_path / "sessions", tmp_path)
    events = []

    async def emit(kind, data):
        events.append((kind, data))

    first = await runner.run({"id": "t1", "prompt": "hello", "cwd": str(tmp_path), "approval_mode": "approve"}, emit)
    assert first == {"text": "Answer: hello", "session_id": "prime-t1"}
    call = calls(log)[0]
    assert call["argv"][:3] == ["run", "--format", "json"]
    assert call["argv"][call["argv"].index("--model") + 1] == "opencode/big-pickle"
    assert "--auto" not in call["argv"] and "--session" not in call["argv"]
    assert json.loads(call["config"])["permission"] == {"edit": "ask", "bash": "ask", "webfetch": "allow"}
    assert call["argv"][-2:] == ["--", "hello"] and call["cwd"] == str(tmp_path)
    assert [k for k, _ in events].count("message.delta") == 2
    tools = [d for k, d in events if k == "tool"]
    assert [(t["tool"], t["phase"], t.get("exit_code")) for t in tools] == [("read", "start", None), ("read", "end", 0), ("edit", "start", None), ("edit", "end", 1)]

    folder = tmp_path / "sessions" / "prime-t1"
    assert json.loads((folder / "opencode-session.json").read_text()) == {"session": "ses_fake123"}
    records = [json.loads(line) for line in (folder / "opencode.jsonl").read_text().splitlines()]
    assert records[0]["type"] == "session" and records[0]["cwd"] == str(tmp_path)
    roles = [r["message"]["role"] for r in records if r["type"] == "message"]
    assert roles == ["user", "assistant", "toolResult", "assistant", "assistant", "toolResult", "assistant"]

    second = await runner.run({"id": "t2", "session_id": "prime-t1", "prompt": "again", "approval_mode": "auto",
                               "provider": "opencode", "model": "opencode/nemotron-3-ultra-free"}, emit)
    assert second["session_id"] == "prime-t1"
    call = calls(log)[1]
    assert call["argv"][call["argv"].index("--session") + 1] == "ses_fake123"
    assert "--auto" in call["argv"] and call["config"] is None
    assert call["argv"][call["argv"].index("--model") + 1] == "opencode/nemotron-3-ultra-free"


async def test_plan_chat_and_foreign_models(tmp_path, fake):
    exe, log = fake
    runner = OpenCodeRunner(exe, tmp_path / "sessions", tmp_path)

    async def emit(*_):
        pass

    await runner.run({"id": "p", "prompt": "plan it", "approval_mode": "plan", "provider": "openai-codex", "model": "gpt-5.6-sol"}, emit)
    await runner.run({"id": "c", "prompt": "chat", "approval_mode": "auto", "chat_only": True}, emit)
    plan, chat = calls(log)
    for call in (plan, chat):
        assert call["argv"][call["argv"].index("--agent") + 1] == "plan" and "--auto" not in call["argv"]
    assert plan["argv"][plan["argv"].index("--model") + 1] == "opencode/big-pickle"


async def test_failures_surface_the_opencode_message(tmp_path, fake):
    exe, _ = fake
    runner = OpenCodeRunner(exe, tmp_path / "sessions", tmp_path)

    async def emit(*_):
        pass

    with pytest.raises(RuntimeError, match="model unavailable"):
        await runner.run({"id": "x", "prompt": "explode"}, emit)
    with pytest.raises(RuntimeError, match="not found"):
        await OpenCodeRunner(tmp_path / "missing", tmp_path / "s", tmp_path).run({"id": "y", "prompt": "hi"}, emit)
    with pytest.raises(ValueError):
        await runner.run({"id": "z", "session_id": "../escape", "prompt": "hi"}, emit)


def test_model_list_is_parsed_and_cached(tmp_path, fake):
    exe, log = fake
    models = OpenCodeModels(exe)
    assert models.list() == ["opencode/big-pickle", "opencode/nemotron-3-ultra-free"]
    models.list()
    assert len(calls(log)) == 1
    assert OpenCodeModels(tmp_path / "missing").list() == []


def test_opencode_sessions_run_through_the_api(tmp_path, fake):
    exe, log = fake
    settings = Settings(
        archon_root=tmp_path, hermes_home=tmp_path / "hermes", data_dir=tmp_path / "data",
        prime_agent_session_dir=tmp_path / "prime", prime_agent_artifact_dir=tmp_path / "artifacts",
        pi_agent_session_dir=tmp_path / "pi", prime_executable=tmp_path / "no-prime",
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

        created = client.post("/api/tasks", json={"prompt": "build it", "profile": "opencode", "cwd": str(tmp_path), "approval_mode": "auto"})
        assert created.status_code == 202
        task = finish(created.json()["task"]["id"])
        assert task["status"] == "completed", task.get("error")
        session_id = f"prime-{task['id']}"

        rows = {row["id"]: row for row in client.get("/api/sessions").json()["sessions"]}
        assert rows[session_id]["runtime"] == "opencode" and rows[session_id]["source"] == "opencode"
        messages = client.get(f"/api/sessions/{session_id}/messages").json()["messages"]
        texts = [m["content"] for m in messages if m["kind"] == "text"]
        assert texts == ["build it", "Looking at a.py.", "Answer: build it"]

        follow = client.post("/api/tasks", json={"prompt": "more", "session_id": session_id, "profile": None, "approval_mode": "auto"})
        assert finish(follow.json()["task"]["id"])["status"] == "completed"
        last = calls(log)[-1]
        assert last["argv"][last["argv"].index("--session") + 1] == "ses_fake123"

        agents = {a["name"]: a for a in client.get("/api/agents").json()["agents"]}
        assert agents["opencode"]["available"] is True
        choices = client.get("/api/models").json()["choices"]
        assert {"provider": "opencode", "model": "opencode/big-pickle"} in choices


@pytest.mark.parametrize("name", ["opencode", "pi", "prime"])
async def test_relative_working_folders_resolve_inside_the_archon_root(tmp_path, fake, monkeypatch, name):
    from archon_server.pi_runner import PiRunner
    from archon_server.prime_runner import PrimeRunner
    exe, log = fake
    root = tmp_path / "archon-root"
    (root / "webapp").mkdir(parents=True)
    elsewhere = tmp_path / "service-cwd"
    elsewhere.mkdir()
    monkeypatch.chdir(elsewhere)
    runner = {
        "opencode": lambda: OpenCodeRunner(exe, tmp_path / "sessions", root),
        "pi": lambda: PiRunner(exe, tmp_path / "sessions", root),
        "prime": lambda: PrimeRunner(exe, tmp_path / "sessions", root, tmp_path / "prime-native"),
    }[name]()

    async def emit(*_):
        pass

    for cwd in (".", "webapp"):
        try:
            await runner.run({"id": f"{name}-{cwd.strip('.') or 'root'}", "prompt": "where", "cwd": cwd}, emit)
        except Exception:
            pass  # the fake speaks OpenCode's protocol; only the launch folder matters here
    assert [call["cwd"] for call in calls(log)] == [str(root), str(root / "webapp")]
