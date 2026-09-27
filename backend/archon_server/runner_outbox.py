"""Durable per-runner outbox for enrolled remote runners.

Each enrolled runner gets its own private ``RunnerJournal`` (generation-fenced,
bounded, deduplicated by event key). The coordinator enqueues work through the
owner API; an enrolled runner claims unacknowledged entries over its own
authenticated channel and acknowledges them by sequence. Nothing is lost if the
runner or coordinator restarts: entries stay unacknowledged until the runner
acknowledges the exact sequence.
"""
from __future__ import annotations

import os
import re
import stat
from pathlib import Path
from typing import Any

from .runner_journal import AppendConflict, JournalEntry, OutboxFull, RunnerJournal


_RUNNER_ID = re.compile(r"runner-[0-9a-f]{32}\Z")
_EVENT_KEY = re.compile(r"[A-Za-z0-9._:-]{1,128}\Z")
_MAX_CLAIM = 64
_MAX_RUNNERS = 16


class RunnerOutboxError(RuntimeError):
    """Base error for the remote runner outbox."""


class RunnerOutboxUnavailable(RunnerOutboxError):
    """The outbox root is missing or unsafe."""


def _private_root(root: str | os.PathLike[str]) -> Path:
    directory = Path(root)
    if not directory.is_absolute():
        raise ValueError("outbox root must be an absolute server-owned path")
    was_present = directory.exists() or directory.is_symlink()
    directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    info = directory.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid()
            or (was_present and stat.S_IMODE(info.st_mode) != 0o700)
            or stat.S_IMODE(info.st_mode) & 0o077):
        raise RunnerOutboxUnavailable("outbox root must be a private directory owned by this user")
    if directory.resolve(strict=True) != directory.absolute():
        raise RunnerOutboxUnavailable("outbox root must not be a symlink")
    return directory.absolute()


class RunnerOutbox:
    """Enqueue, claim and acknowledge durable work for enrolled runners."""

    def __init__(self, root: str | os.PathLike[str], *, max_claim: int = _MAX_CLAIM):
        if isinstance(max_claim, bool) or not isinstance(max_claim, int) or not 1 <= max_claim <= 256:
            raise ValueError("max_claim must be between 1 and 256")
        self._root = _private_root(root)
        self._max_claim = max_claim

    @staticmethod
    def _validate_runner(runner_id: Any) -> str:
        if not isinstance(runner_id, str) or not _RUNNER_ID.fullmatch(runner_id):
            raise ValueError("runner id is invalid")
        return runner_id

    def _journal(self, runner_id: str) -> RunnerJournal:
        return RunnerJournal(self._root / f"{runner_id}.sqlite3", runner_id, 1)

    def enqueue(self, runner_id: Any, event_key: Any, payload: Any) -> dict[str, Any]:
        """Commit one work item for a runner; an exact retry returns the original."""
        runner = self._validate_runner(runner_id)
        if not isinstance(event_key, str) or not _EVENT_KEY.fullmatch(event_key):
            raise ValueError("event key is invalid")
        try:
            entry = self._journal(runner).append(event_key, payload)
        except OutboxFull as exc:
            raise RunnerOutboxError("runner outbox is full") from exc
        except AppendConflict as exc:
            raise RunnerOutboxError("event key already has a different payload") from exc
        return self._public(entry)

    def claim(self, runner_id: Any, limit: Any = None) -> list[dict[str, Any]]:
        """Return unacknowledged entries for the runner, oldest first."""
        runner = self._validate_runner(runner_id)
        count = self._max_claim if limit is None else limit
        if isinstance(count, bool) or not isinstance(count, int) or not 1 <= count <= self._max_claim:
            raise ValueError("claim limit is invalid")
        return [self._public(entry) for entry in self._journal(runner).replay_unacked()[:count]]

    def acknowledge(self, runner_id: Any, runner_seq: Any) -> None:
        runner = self._validate_runner(runner_id)
        if isinstance(runner_seq, bool) or not isinstance(runner_seq, int) or runner_seq < 1:
            raise ValueError("runner sequence is invalid")
        self._journal(runner).acknowledge(runner_seq)

    @staticmethod
    def _public(entry: JournalEntry) -> dict[str, Any]:
        return {
            "runnerId": entry.runner_id,
            "journalGeneration": entry.journal_generation,
            "runnerSeq": entry.runner_seq,
            "eventKey": entry.event_key,
            "payload": entry.payload,
        }
