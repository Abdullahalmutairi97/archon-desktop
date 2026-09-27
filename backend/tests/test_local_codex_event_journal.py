from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path

import pytest

from archon_server.local_codex_event_journal import (
    MAX_EVENT_FRAME_BYTES,
    MAX_PROVISIONAL_TURNS,
    MAX_SAFE_SEQUENCE,
    LocalCodexEventJournal,
    LocalCodexEventJournalError,
    LocalCodexProvisionalOverflow,
)


def _journal_path(tmp_path: Path, name: str = "runner") -> Path:
    directory = tmp_path / name
    directory.mkdir(mode=0o700)
    directory.chmod(0o700)
    return directory / "events.sqlite3"


def test_reopen_preserves_sequence_and_cursor_reset_after_eviction(tmp_path: Path) -> None:
    path = _journal_path(tmp_path)
    journal = LocalCodexEventJournal(path, max_events=2, max_bytes=1024)

    assert journal.append({"kind": "one"}) == 1
    assert journal.append({"kind": "two"}) == 2
    assert journal.append({"kind": "three"}) == 3

    reopened = LocalCodexEventJournal(path, max_events=2, max_bytes=1024)
    stale = reopened.read(0, 10)
    assert stale == {
        "cursor": 3,
        "latest": 3,
        "oldest": 2,
        "reset": True,
        "events": [
            {"seq": 2, "event": {"kind": "two"}},
            {"seq": 3, "event": {"kind": "three"}},
        ],
    }
    assert reopened.read(2, 1) == {
        "cursor": 3,
        "latest": 3,
        "oldest": 2,
        "reset": False,
        "events": [{"seq": 3, "event": {"kind": "three"}}],
    }
    assert reopened.read(99, 1) == {
        "cursor": 3,
        "latest": 3,
        "oldest": 2,
        "reset": True,
        "events": [],
    }
    assert reopened.append({"kind": "four"}) == 4
    assert reopened.read(3, 1)["events"] == [{"seq": 4, "event": {"kind": "four"}}]
    assert os.stat(path).st_mode & 0o777 == 0o600


def test_v1_event_journal_migrates_to_turn_ledger_without_losing_events(tmp_path: Path) -> None:
    path = _journal_path(tmp_path)
    with sqlite3.connect(path) as connection:
        connection.execute("PRAGMA application_id=1095910216")  # ARCH
        connection.execute("PRAGMA user_version=1")
        connection.execute(
            "CREATE TABLE journal_state ("
            "singleton INTEGER PRIMARY KEY CHECK (singleton = 1), "
            "latest_seq INTEGER NOT NULL CHECK (latest_seq >= 0)"
            ")"
        )
        connection.execute("INSERT INTO journal_state(singleton, latest_seq) VALUES (1, 1)")
        connection.execute(
            "CREATE TABLE journal_events ("
            "seq INTEGER PRIMARY KEY CHECK (seq > 0), "
            "event_json TEXT NOT NULL, event_bytes INTEGER NOT NULL CHECK (event_bytes >= 0)"
            ")"
        )
        event = {"type": "turn.completed", "taskId": "codex-task:old"}
        encoded = json.dumps(event, separators=(",", ":"))
        connection.execute(
            "INSERT INTO journal_events(seq, event_json, event_bytes) VALUES (1, ?, ?)",
            (encoded, len(encoded.encode("utf-8"))),
        )
    path.chmod(0o600)

    journal = LocalCodexEventJournal(path)
    assert journal.read(0, 1)["events"] == [{"seq": 1, "event": event}]
    assert journal.read_turn("codex-task:old") is None
    with sqlite3.connect(path) as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 2
        assert connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='local_turns'"
        ).fetchone() == ("local_turns",)
        assert "turn_order" not in {
            row[1] for row in connection.execute("PRAGMA table_info(local_turns)")
        }


def test_turn_status_survives_event_retention_overflow(tmp_path: Path) -> None:
    path = _journal_path(tmp_path)
    journal = LocalCodexEventJournal(path, max_events=1, max_bytes=4096)
    first = {
        "taskId": "codex-task:first",
        "projectId": "codex-project:project",
        "sessionId": "codex:session-first",
        "state": "running",
    }
    journal.record_accepted_start(first)
    assert journal.append({"type": "turn.completed", "taskId": first["taskId"]}) == 1
    assert journal.append({"type": "turn.completed", "taskId": "codex-task:second"}) == 2

    reopened = LocalCodexEventJournal(path, max_events=1, max_bytes=4096)
    assert reopened.read(0, 1)["events"] == [{
        "seq": 2,
        "event": {"type": "turn.completed", "taskId": "codex-task:second"},
    }]
    assert reopened.read_turn(first["taskId"]) == {
        "taskId": first["taskId"],
        "projectId": first["projectId"],
        "sessionId": first["sessionId"],
        "state": "completed",
    }


def test_provisional_terminal_turns_fail_closed_at_bound_and_existing_fast_terminal_binds(tmp_path: Path) -> None:
    path = _journal_path(tmp_path)
    journal = LocalCodexEventJournal(path, max_events=2, max_bytes=4096)
    for number in range(MAX_PROVISIONAL_TURNS):
        journal.append({
            "type": "turn.completed",
            "taskId": f"codex-task:orphan-{number}",
        }, provisional_terminal=True)
    with pytest.raises(LocalCodexProvisionalOverflow):
        journal.append({
            "type": "turn.completed",
            "taskId": "codex-task:overflow",
        }, provisional_terminal=True)

    with sqlite3.connect(path) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM local_turns WHERE accepted=0"
        ).fetchone() == (MAX_PROVISIONAL_TURNS,)
        assert connection.execute(
            "SELECT COUNT(*) FROM local_turns WHERE task_id='codex-task:orphan-0'"
        ).fetchone() == (1,)

    latest = MAX_PROVISIONAL_TURNS - 1
    status = journal.record_accepted_start({
        "taskId": f"codex-task:orphan-{latest}",
        "projectId": "codex-project:project",
        "sessionId": "codex:session-latest",
        "state": "running",
    })
    assert status["state"] == "completed"


def test_startup_reconciliation_marks_only_accepted_running_turns_once(tmp_path: Path) -> None:
    path = _journal_path(tmp_path)
    journal = LocalCodexEventJournal(path)
    running = {
        "taskId": "codex-task:running",
        "projectId": "codex-project:project",
        "sessionId": "codex:session-running",
        "state": "running",
    }
    completed = {
        "taskId": "codex-task:completed",
        "projectId": "codex-project:project",
        "sessionId": "codex:session-completed",
        "state": "running",
    }
    journal.record_accepted_start(running)
    journal.record_accepted_start(completed)
    journal.append({"type": "turn.completed", "taskId": completed["taskId"]})
    journal.append({
        "type": "turn.completed", "taskId": "codex-task:orphan",
    }, provisional_terminal=True)

    reopened = LocalCodexEventJournal(path)
    assert reopened.reconcile_startup() == 1
    assert reopened.reconcile_startup() == 0
    assert reopened.read_turn(running["taskId"])["state"] == "outcome_unknown"
    assert reopened.read_turn(completed["taskId"])["state"] == "completed"
    assert reopened.read_turn("codex-task:orphan") is None
    assert reopened.read_latest_turns(16) == [
        {
            "taskId": completed["taskId"],
            "projectId": completed["projectId"],
            "sessionId": completed["sessionId"],
            "state": "completed",
        },
        {
            "taskId": running["taskId"],
            "projectId": running["projectId"],
            "sessionId": running["sessionId"],
            "state": "outcome_unknown",
        },
    ]


def test_latest_turn_readback_is_bounded_and_follows_durable_insertion_order(tmp_path: Path) -> None:
    journal = LocalCodexEventJournal(_journal_path(tmp_path))
    first = {
        "taskId": "codex-task:first",
        "projectId": "codex-project:project",
        "sessionId": "codex:session-first",
        "state": "running",
    }
    second = {
        "taskId": "codex-task:second",
        "projectId": "codex-project:project",
        "sessionId": "codex:session-second",
        "state": "running",
    }
    journal.record_accepted_start(first)
    journal.record_accepted_start(second)

    assert journal.read_latest_turns(1) == [{
        "taskId": second["taskId"],
        "projectId": second["projectId"],
        "sessionId": second["sessionId"],
        "state": "running",
    }]
    with pytest.raises(ValueError, match="status limit"):
        journal.read_latest_turns(17)


def test_rejects_symlink_and_insecure_existing_database_file(tmp_path: Path) -> None:
    symlink_path = _journal_path(tmp_path, "symlink-runner")
    target = tmp_path / "outside.sqlite3"
    target.write_bytes(b"private")
    symlink_path.symlink_to(target)
    with pytest.raises(LocalCodexEventJournalError):
        LocalCodexEventJournal(symlink_path)

    insecure_path = _journal_path(tmp_path, "insecure-runner")
    insecure_path.write_bytes(b"not a database")
    insecure_path.chmod(0o644)
    with pytest.raises(LocalCodexEventJournalError):
        LocalCodexEventJournal(insecure_path)

    unknown_path = _journal_path(tmp_path, "unknown-runner")
    with sqlite3.connect(unknown_path) as connection:
        connection.execute("CREATE TABLE unrelated (value TEXT)")
    unknown_path.chmod(0o600)
    with pytest.raises(LocalCodexEventJournalError):
        LocalCodexEventJournal(unknown_path)
    with sqlite3.connect(unknown_path) as connection:
        assert connection.execute("PRAGMA application_id").fetchone()[0] == 0
        assert connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'journal_state'"
        ).fetchone() is None

    hardlink_path = _journal_path(tmp_path, "hardlink-runner")
    original = hardlink_path.parent / "original.sqlite3"
    original.write_bytes(b"database")
    original.chmod(0o600)
    os.link(original, hardlink_path)
    with pytest.raises(LocalCodexEventJournalError):
        LocalCodexEventJournal(hardlink_path)


def test_rejects_event_that_fits_push_but_not_read_response_frame(tmp_path: Path) -> None:
    journal = LocalCodexEventJournal(_journal_path(tmp_path))
    event: dict[str, str] | None = None
    for padding in range(MAX_EVENT_FRAME_BYTES - 512, MAX_EVENT_FRAME_BYTES):
        candidate = {"payload": "x" * padding}
        record = {"seq": MAX_SAFE_SEQUENCE, "event": candidate}
        push_frame = {"event": record}
        read_response = {
            "id": "x" * 128,
            "ok": True,
            "result": {
                "cursor": MAX_SAFE_SEQUENCE,
                "latest": MAX_SAFE_SEQUENCE,
                "oldest": MAX_SAFE_SEQUENCE + 1,
                "reset": False,
                "events": [record],
            },
        }
        if (
            len(json.dumps(push_frame, separators=(",", ":")).encode("utf-8")) <= MAX_EVENT_FRAME_BYTES
            and len(json.dumps(read_response, separators=(",", ":")).encode("utf-8")) > MAX_EVENT_FRAME_BYTES
        ):
            event = candidate
            break

    assert event is not None
    with pytest.raises(ValueError, match="runner frame size limit"):
        journal.append(event)
    assert journal.read(0, 1)["latest"] == 0
