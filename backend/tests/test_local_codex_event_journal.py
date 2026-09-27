from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path

import pytest

from archon_server.local_codex_event_journal import (
    MAX_EVENT_FRAME_BYTES,
    MAX_SAFE_SEQUENCE,
    LocalCodexEventJournal,
    LocalCodexEventJournalError,
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
