import os
import sqlite3
import stat

import pytest

from archon_server.runner_journal import (
    AppendConflict,
    InvalidAcknowledgement,
    OutboxFull,
    PendingJournalEntries,
    RunnerJournal,
    RunnerJournalError,
    StaleJournalGeneration,
)


def test_append_commits_replays_in_order_and_duplicate_is_idempotent(tmp_path):
    path = tmp_path / "runner.sqlite3"
    journal = RunnerJournal(path, "prime-1", 1)

    first = journal.append("evt-1", {"text": "one"})
    duplicate = journal.append("evt-1", {"text": "one"})
    second = journal.append("evt-2", {"text": "two"})

    assert duplicate == first
    assert [entry.runner_seq for entry in RunnerJournal(path, "prime-1", 1).replay_unacked()] == [1, 2]
    assert second.runner_seq > first.runner_seq


def test_append_conflicts_when_key_payload_differs(tmp_path):
    journal = RunnerJournal(tmp_path / "runner.sqlite3", "prime-1", 1)
    journal.append("evt-1", {"text": "one"})

    with pytest.raises(AppendConflict):
        journal.append("evt-1", {"text": "different"})


def test_ack_prunes_current_entries_and_sequence_continues_after_reopen(tmp_path):
    path = tmp_path / "runner.sqlite3"
    journal = RunnerJournal(path, "prime-1", 1)
    first = journal.append("evt-1", {"n": 1})
    second = journal.append("evt-2", {"n": 2})

    journal.acknowledge(first.runner_seq)
    assert [entry.runner_seq for entry in journal.replay_unacked()] == [second.runner_seq]
    assert journal.append("evt-1", {"n": 1}) == first
    with pytest.raises(AppendConflict):
        journal.append("evt-1", {"n": "changed after ack"})

    reopened = RunnerJournal(path, "prime-1", 1)
    third = reopened.append("evt-3", {"n": 3})
    assert third.runner_seq > second.runner_seq
    assert [entry.runner_seq for entry in reopened.replay_unacked()] == [second.runner_seq, third.runner_seq]


def test_generation_advance_requires_drained_outbox_and_fences_old_handle(tmp_path):
    path = tmp_path / "runner.sqlite3"
    old = RunnerJournal(path, "prime-1", 4)
    pending = old.append("evt-1", {"n": 1})

    with pytest.raises(PendingJournalEntries):
        RunnerJournal(path, "prime-1", 5)

    old.acknowledge(pending.runner_seq)
    current = RunnerJournal(path, "prime-1", 5)
    with pytest.raises(StaleJournalGeneration):
        old.append("evt-2", {"n": 2})

    current_entry = current.append("evt-3", {"n": 3})
    with pytest.raises(StaleJournalGeneration):
        old.acknowledge(current_entry.runner_seq)
    assert [entry.runner_seq for entry in current.replay_unacked()] == [current_entry.runner_seq]


def test_ack_rejects_unknown_sequence_without_pruning_other_entries(tmp_path):
    journal = RunnerJournal(tmp_path / "runner.sqlite3", "prime-1", 1)
    entry = journal.append("evt-1", {"n": 1})

    with pytest.raises(InvalidAcknowledgement):
        journal.acknowledge(entry.runner_seq + 1)
    assert [item.runner_seq for item in journal.replay_unacked()] == [entry.runner_seq]


def test_outbox_limit_fails_closed_but_duplicate_retry_still_succeeds(tmp_path):
    journal = RunnerJournal(tmp_path / "runner.sqlite3", "prime-1", 1, max_unacked_events=1)
    entry = journal.append("evt-1", {"n": 1})

    assert journal.append("evt-1", {"n": 1}) == entry
    with pytest.raises(OutboxFull):
        journal.append("evt-2", {"n": 2})
    assert [item.runner_seq for item in journal.replay_unacked()] == [entry.runner_seq]


def test_outbox_byte_limit_rejects_oversized_payload(tmp_path):
    journal = RunnerJournal(tmp_path / "runner.sqlite3", "prime-1", 1, max_unacked_bytes=6)

    with pytest.raises(OutboxFull):
        journal.append("evt-1", {"n": 1})


def test_database_and_parent_are_private(tmp_path):
    path = tmp_path / "runner.sqlite3"
    RunnerJournal(path, "prime-1", 1)

    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert stat.S_IMODE(path.parent.stat().st_mode) & 0o077 == 0


def test_unsafe_shared_parent_fails_closed(tmp_path):
    shared = tmp_path / "shared"
    shared.mkdir(mode=0o700)
    os.chmod(shared, 0o750)

    with pytest.raises(PermissionError):
        RunnerJournal(shared / "runner.sqlite3", "prime-1", 1)


def test_journal_rejects_different_runner_identity(tmp_path):
    path = tmp_path / "runner.sqlite3"
    RunnerJournal(path, "prime-1", 1)

    with pytest.raises(RunnerJournalError):
        RunnerJournal(path, "prime-2", 1)


def test_journal_rejects_unknown_schema_version(tmp_path):
    path = tmp_path / "runner.sqlite3"
    RunnerJournal(path, "prime-1", 1)
    with sqlite3.connect(path) as connection:
        connection.execute("PRAGMA user_version=99")

    with pytest.raises(RunnerJournalError):
        RunnerJournal(path, "prime-1", 1)


@pytest.mark.parametrize("corruption", ["drop_event_table", "delete_state_row"])
def test_journal_fails_closed_on_partial_schema_or_missing_state(tmp_path, corruption):
    path = tmp_path / "runner.sqlite3"
    journal = RunnerJournal(path, "prime-1", 1)
    journal.append("evt-1", {"n": 1})
    with sqlite3.connect(path) as connection:
        if corruption == "drop_event_table":
            connection.execute("DROP TABLE runner_journal_events")
        else:
            connection.execute("DELETE FROM runner_journal_state WHERE singleton=1")

    with pytest.raises(RunnerJournalError):
        RunnerJournal(path, "prime-1", 1)
