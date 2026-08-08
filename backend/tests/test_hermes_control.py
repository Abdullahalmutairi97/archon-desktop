import json

from archon_server import hermes_control


class FakeAgent:
    def __init__(self):
        self.stream_delta_callback = None
        self.reasoning_callback = None
        self.tool_start_callback = None
        self.tool_complete_callback = None


def _payloads(capsys):
    lines = capsys.readouterr().err.splitlines()
    assert all(line.startswith("@@archon ") for line in lines)
    return [json.loads(line.removeprefix("@@archon ")) for line in lines]


def test_control_streams_reply_and_unique_reasoning_steps(capsys):
    agent = FakeAgent()
    control = hermes_control.install(agent)

    agent.stream_delta_callback("Hel")
    agent.reasoning_callback("**Inspecting state****Running tests**")
    agent.stream_delta_callback("lo")
    agent.reasoning_callback("**Inspecting state**")
    agent.reasoning_callback("**Applying ")
    agent.reasoning_callback("fix**")
    control.done()
    control.done()

    payloads = _payloads(capsys)
    assert [payload for payload in payloads if payload["event"] == "message.delta"] == [
        {"event": "message.delta", "text": "Hel"},
        {"event": "message.delta", "text": "lo"},
    ]
    assert [payload["text"] for payload in payloads if payload["event"] == "output"] == [
        "**Inspecting state**",
        "**Running tests**",
        "**Applying fix**",
    ]
    assert [payload for payload in payloads if payload["event"] == "message.done"] == [
        {"event": "message.done"}
    ]


def test_control_emits_correlated_shell_start_and_end_with_bounded_tail(capsys, monkeypatch):
    moments = iter([100.0, 112.41])
    monkeypatch.setattr(hermes_control.time, "monotonic", lambda: next(moments))
    agent = FakeAgent()
    hermes_control.install(agent)

    agent.tool_start_callback("call-1", "terminal", {"command": "pytest -k cancel"})
    agent.tool_complete_callback(
        "call-1",
        "terminal",
        {"command": "pytest -k cancel"},
        json.dumps({"output": "x" * 5000 + "TAIL", "exit_code": 0}),
    )

    payloads = _payloads(capsys)
    assert payloads[0] == {
        "event": "tool",
        "id": "call-1",
        "phase": "start",
        "tool": "shell",
        "target": "pytest -k cancel",
    }
    end = payloads[1]
    assert end["event"] == "tool"
    assert end["id"] == "call-1"
    assert end["phase"] == "end"
    assert end["tool"] == "shell"
    assert end["target"] == "pytest -k cancel"
    assert end["duration"] == 12.41
    assert end["exit_code"] == 0
    assert len(end["detail"]) <= 4000
    assert end["detail"].endswith("TAIL")


def test_control_emits_edit_diff_counts_and_bounded_unified_diff(tmp_path, capsys, monkeypatch):
    moments = iter([1.0, 1.5])
    monkeypatch.setattr(hermes_control.time, "monotonic", lambda: next(moments))
    path = tmp_path / "sample.txt"
    path.write_text("one\ntwo\n")
    agent = FakeAgent()
    hermes_control.install(agent)
    args = {"path": str(path), "content": "one\nthree\nfour\n"}

    agent.tool_start_callback("edit-1", "write_file", args)
    path.write_text(args["content"])
    agent.tool_complete_callback("edit-1", "write_file", args, json.dumps({"bytes_written": 15}))

    payloads = _payloads(capsys)
    assert payloads[0] == {
        "event": "tool",
        "id": "edit-1",
        "phase": "start",
        "tool": "edit",
        "target": str(path),
    }
    end = payloads[1]
    assert end["id"] == "edit-1"
    assert end["phase"] == "end"
    assert end["tool"] == "edit"
    assert end["target"] == str(path)
    assert end["duration"] == 0.5
    assert end["exit_code"] == 0
    assert end["added"] == 2
    assert end["removed"] == 1
    assert "--- " in end["detail"]
    assert "+++ " in end["detail"]
    assert "-two" in end["detail"]
    assert "+three" in end["detail"]
    assert len(end["detail"]) <= 4000
