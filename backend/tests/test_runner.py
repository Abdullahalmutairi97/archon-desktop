import asyncio
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


async def _record(events, kind, data):
    events.append((kind, data))
