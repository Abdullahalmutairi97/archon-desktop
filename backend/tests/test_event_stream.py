import json

from archon_server.app import _sse_event_batch
from archon_server.db import Database
from archon_server.tasks import TaskStore


def test_sse_event_batch_drains_a_burst_without_token_by_token_delay(tmp_path):
    store = TaskStore(Database(tmp_path / "state.db"))
    task = store.submit("stream quickly")
    start_cursor = store.latest_event_seq()
    for index in range(64):
        store.append_event(task["id"], "message.delta", {"text": str(index)})

    cursor, frames = _sse_event_batch(store, start_cursor)

    assert len(frames) == 64
    assert cursor == store.latest_event_seq()
    assert all("event: message.delta" in frame for frame in frames)
    assert '"text": "0"' in frames[0]
    assert '"text": "63"' in frames[-1]


def test_event_cursor_uses_highest_valid_resume_position():
    from archon_server.app import _event_cursor

    assert _event_cursor(12, "15") == 15
    assert _event_cursor(20, "15") == 20
    assert _event_cursor(0, "not-a-number") == 0
    assert _event_cursor(-4, "-2") == 0


def test_sse_event_batch_preserves_80_cross_session_events(tmp_path):
    store = TaskStore(Database(tmp_path / "state.db"))
    tasks = [store.submit(f"stream {index}") for index in range(4)]
    start = store.latest_event_seq()
    for index in range(80):
        task = tasks[index % len(tasks)]
        store.append_event(task["id"], "message.delta", {"index": index})

    cursor, frames = _sse_event_batch(store, start)
    assert len(frames) == 80
    assert cursor == store.latest_event_seq()
    assert [json.loads(frame.split("data: ", 1)[1]) ["data"]["index"] for frame in frames] == list(range(80))
