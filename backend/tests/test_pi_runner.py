import json
import sys

import pytest

from archon_server import pi_runner as pi_module
from archon_server.pi_runner import PiRunner


def _write_python(path, body):
    path.write_text(f"#!{sys.executable}\n{body}")
    path.chmod(0o700)
    return path


@pytest.mark.asyncio
async def test_pi_runner_accepts_jsonl_record_larger_than_default_stream_limit(tmp_path):
    text = "x" * (80 * 1024)
    events = [
        {
            "type": "message_update",
            "assistantMessageEvent": {"type": "text_delta", "delta": text},
        },
        {"type": "agent_end", "messages": []},
    ]
    executable = _write_python(
        tmp_path / "fake-pi",
        "import json\n"
        f"events = {events!r}\n"
        "for event in events: print(json.dumps(event), flush=True)\n",
    )
    emitted = []

    async def emit(kind, data):
        emitted.append((kind, data))

    result = await PiRunner(executable, tmp_path / "sessions", tmp_path).run(
        {"id": "large-record", "session_id": "pi-large-record", "approval_mode": "auto", "prompt": "fixture"},
        emit,
    )

    assert result == {"text": text, "session_id": "pi-large-record"}
    assert ("message.delta", {"message_id": "large-record", "text": text, "session_id": "pi-large-record"}) in emitted


@pytest.mark.asyncio
async def test_pi_runner_rejects_jsonl_record_over_its_explicit_bound(tmp_path, monkeypatch):
    executable = _write_python(
        tmp_path / "fake-pi",
        "print('x' * 2048, flush=True)\n",
    )
    monkeypatch.setattr(pi_module, "MAX_JSONL_RECORD_BYTES", 1024)

    async def emit(_kind, _data):
        return None

    with pytest.raises(RuntimeError, match="Pi JSONL record exceeds 1024 bytes"):
        await PiRunner(executable, tmp_path / "sessions", tmp_path).run(
            {"id": "oversized-record", "session_id": "pi-oversized-record", "approval_mode": "auto", "prompt": "fixture"},
            emit,
        )
