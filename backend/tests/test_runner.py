import asyncio
import json
import os
from pathlib import Path

import pytest

from archon_server.hermes_runner import HermesRunner


@pytest.mark.asyncio
async def test_runner_invokes_profile_model_provider_skills_and_cwd(tmp_path):
    executable = tmp_path / "fake-hermes"
    args_file = tmp_path / "args.txt"
    executable.write_text(
        f'''#!/usr/bin/env bash
printf '%s\\n' "$PWD" "$@" > {args_file}
printf 'completed response\\n'
'''
    )
    executable.chmod(0o755)
    events = []
    runner = HermesRunner(executable, profile="archon")
    task = {
        "id": "task1",
        "prompt": "do work",
        "cwd": str(tmp_path),
        "model": "gpt-test",
        "provider": "provider-test",
        "session_id": "20260724_session",
        "skills": ["skill-a", "skill-b"],
    }

    result = await runner.run(task, lambda kind, data: _record(events, kind, data))

    args = args_file.read_text().splitlines()
    assert args[0] == str(tmp_path)
    assert args[1:4] == ["--profile", "archon", "chat"]
    assert "gpt-test" in args
    assert "provider-test" in args
    assert "--resume" in args
    assert "20260724_session" in args
    assert "--no-restore-cwd" in args
    assert "skill-a,skill-b" in args
    assert result["text"] == "completed response"
    assert any(kind == "output" for kind, _ in events)


@pytest.mark.asyncio
async def test_runner_returns_the_session_id_reported_by_hermes(tmp_path):
    executable = tmp_path / "fake-hermes"
    executable.write_text("#!/usr/bin/env bash\nprintf 'answer\\n'\nprintf '\\nsession_id: 20260725_session\\n' >&2\n")
    executable.chmod(0o755)
    runner = HermesRunner(executable, profile="archon")

    result = await runner.run(
        {"id": "new-chat", "prompt": "hello", "cwd": str(tmp_path), "skills": []},
        lambda kind, data: _record([], kind, data),
    )

    assert result == {"text": "answer", "exit_code": 0, "session_id": "20260725_session"}


@pytest.mark.asyncio
async def test_runner_announces_session_before_process_exit_and_only_once(tmp_path):
    executable = tmp_path / "fake-hermes"
    release_file = tmp_path / "release"
    executable.write_text(
        f'''#!/usr/bin/env bash
printf 'session_id: live-session\\n' >&2
while [ ! -e "{release_file}" ]; do sleep 0.02; done
printf 'session_id: live-session\\n' >&2
printf 'done\\n'
'''
    )
    executable.chmod(0o755)
    runner = HermesRunner(executable, profile="archon")
    events = []
    announced = asyncio.Event()

    async def record(kind, data):
        events.append((kind, data))
        if kind == "session":
            announced.set()

    running = asyncio.create_task(
        runner.run(
            {"id": "live-session-task", "prompt": "hello", "cwd": str(tmp_path), "skills": []},
            record,
        )
    )
    try:
        await asyncio.wait_for(announced.wait(), timeout=2)
        assert not running.done()
        assert [(kind, data) for kind, data in events if kind == "session"] == [
            ("session", {"session_id": "live-session"})
        ]
    finally:
        release_file.touch()

    result = await asyncio.wait_for(running, timeout=2)

    assert result["session_id"] == "live-session"
    assert len([kind for kind, _ in events if kind == "session"]) == 1


@pytest.mark.asyncio
async def test_runner_cancel_terminates_and_reaps_the_whole_process_group(tmp_path):
    executable = tmp_path / "fake-hermes"
    parent_file = tmp_path / "parent.pid"
    child_file = tmp_path / "child.pid"
    executable.write_text(
        f'''#!/usr/bin/env bash
printf '%s' "$$" > {parent_file}
sleep 60 &
child=$!
printf '%s' "$child" > {child_file}
wait "$child"
'''
    )
    executable.chmod(0o755)
    runner = HermesRunner(executable, profile="archon")
    task = {"id": "cancel-task", "prompt": "wait", "cwd": str(tmp_path), "skills": []}
    running = asyncio.create_task(runner.run(task, lambda kind, data: _record([], kind, data)))
    for _ in range(100):
        if child_file.exists():
            break
        await asyncio.sleep(0.02)
    assert child_file.exists()
    parent_pid = int(parent_file.read_text())
    child_pid = int(child_file.read_text())

    await runner.cancel(task["id"])

    with pytest.raises(Exception) as cancelled:
        await running
    assert cancelled.value.__class__.__name__ == "RunnerCancelled"
    for pid in (parent_pid, child_pid):
        with pytest.raises(ProcessLookupError):
            os.kill(pid, 0)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("approval_mode", "chat_only", "required", "forbidden"),
    [
        ("auto", False, ["--yolo"], []),
        ("approve", False, ["-t", "context_engine"], ["--yolo", "safe"]),
        ("plan", False, ["-t", "web,vision,session_search", "-s", "plan"], ["--yolo"]),
        ("auto", True, ["-t", "context_engine"], ["--yolo", "safe"]),
    ],
)
async def test_runner_enforces_approval_and_chat_only_modes(tmp_path, approval_mode, chat_only, required, forbidden):
    executable = tmp_path / "fake-hermes"
    args_file = tmp_path / "args.txt"
    executable.write_text(f'''#!/usr/bin/env bash
printf '%s\\n' "$@" > {args_file}
printf 'done\\n'
''')
    executable.chmod(0o755)
    runner = HermesRunner(executable, profile="archon")
    task = {
        "id": f"{approval_mode}-{chat_only}", "prompt": "work", "cwd": str(tmp_path),
        "skills": [], "approval_mode": approval_mode, "chat_only": chat_only,
    }

    await runner.run(task, lambda kind, data: _record([], kind, data))

    args = args_file.read_text().splitlines()
    for value in required:
        assert value in args
    for value in forbidden:
        assert value not in args
    if approval_mode == "approve" and not chat_only:
        assert any(value.startswith("APPROVE STEPS MODE:") for value in args)
    if approval_mode == "plan":
        assert any(value.startswith("PLAN MODE:") for value in args)


@pytest.mark.asyncio
async def test_runner_translates_archon_controls_and_preserves_existing_streams(tmp_path):
    executable = tmp_path / "fake-hermes"
    executable.write_text(
        '''#!/usr/bin/env python3
import json
import sys

def control(payload):
    print("@@archon " + json.dumps(payload, separators=(",", ":")), file=sys.stderr, flush=True)

control({"event": "message.delta", "text": "Hello "})
control({"event": "tool", "id": "call-1", "phase": "start", "tool": "shell", "target": "pytest -k cancel"})
control({"event": "message.delta", "text": "world"})
control({"event": "tool", "id": "call-1", "phase": "end", "tool": "shell", "target": "pytest -k cancel", "duration": 12.41, "exit_code": 0, "detail": "x" * 5000})
control({"event": "message.done"})
print("@@archon not-json", file=sys.stderr, flush=True)
print("session_id: live-session", file=sys.stderr, flush=True)
print("final output", flush=True)
'''
    )
    executable.chmod(0o755)
    runner = HermesRunner(executable, profile="archon")
    events = []

    result = await runner.run(
        {"id": "control-task", "prompt": "hello", "cwd": str(tmp_path), "skills": []},
        lambda kind, data: _record(events, kind, data),
    )

    controls = [(kind, data) for kind, data in events if kind in {"message.delta", "message.done", "tool"}]
    assert [kind for kind, _ in controls] == [
        "message.delta", "tool", "message.delta", "tool", "message.done"
    ]
    deltas = [data for kind, data in controls if kind == "message.delta"]
    assert "".join(delta["text"] for delta in deltas) == "Hello world"
    assert len({delta["message_id"] for delta in deltas}) == 1
    assert controls[-1] == ("message.done", {})
    tool_end = next(data for kind, data in controls if kind == "tool" and data["phase"] == "end")
    assert tool_end["id"] == "call-1"
    assert tool_end["duration"] == 12.41
    assert tool_end["exit_code"] == 0
    assert len(tool_end["detail"]) <= 4000
    assert ("diagnostic", {"text": "@@archon not-json"}) in events
    assert not any(
        kind == "diagnostic" and data.get("text", "").startswith("@@archon {")
        for kind, data in events
    )
    assert any(kind == "output" and data["text"] == "final output" for kind, data in events)
    assert ("session", {"session_id": "live-session"}) in events
    assert result["session_id"] == "live-session"


@pytest.mark.asyncio
async def test_runner_caps_and_chunks_text_payloads_without_losing_content(tmp_path):
    executable = tmp_path / "fake-hermes"
    executable.write_text(
        '''#!/usr/bin/env python3
import json
import sys

print("O" * 9000, flush=True)
print("D" * 9000, file=sys.stderr, flush=True)
print("@@archon " + json.dumps({"event": "message.delta", "text": "M" * 9000}), file=sys.stderr, flush=True)
print("@@archon " + json.dumps({"event": "message.done"}), file=sys.stderr, flush=True)
'''
    )
    executable.chmod(0o755)
    runner = HermesRunner(executable, profile="archon")
    events = []

    await runner.run(
        {"id": "cap-task", "prompt": "hello", "cwd": str(tmp_path), "skills": []},
        lambda kind, data: _record(events, kind, data),
    )

    for kind in ("output", "diagnostic", "message.delta"):
        payloads = [data["text"] for event_kind, data in events if event_kind == kind]
        assert payloads
        assert all(len(text) <= 4096 for text in payloads)
    assert "".join(data["text"] for kind, data in events if kind == "output") == "O" * 9000
    assert "".join(data["text"] for kind, data in events if kind == "diagnostic") == "D" * 9000
    assert "".join(data["text"] for kind, data in events if kind == "message.delta") == "M" * 9000


@pytest.mark.asyncio
async def test_runner_uses_a_new_message_id_for_each_reply(tmp_path):
    executable = tmp_path / "fake-hermes"
    executable.write_text(
        '''#!/usr/bin/env python3
import json
import sys
print("@@archon " + json.dumps({"event": "message.delta", "text": "reply"}), file=sys.stderr)
print("@@archon " + json.dumps({"event": "message.done"}), file=sys.stderr)
'''
    )
    executable.chmod(0o755)
    runner = HermesRunner(executable, profile="archon")
    reply_ids = []

    for task_id in ("reply-one", "reply-two"):
        events = []
        await runner.run(
            {"id": task_id, "prompt": "hello", "cwd": str(tmp_path), "skills": []},
            lambda kind, data: _record(events, kind, data),
        )
        reply_ids.append(next(data["message_id"] for kind, data in events if kind == "message.delta"))

    assert reply_ids[0] != reply_ids[1]


async def _record(events, kind, data):
    events.append((kind, data))
