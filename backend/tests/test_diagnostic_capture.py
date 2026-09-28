"""Bounded, redacted, expiring diagnostic capture."""
from __future__ import annotations

import asyncio
import base64
import json
import os
import stat
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from archon_server.diagnostic_capture import (
    DiagnosticCapture,
    DiagnosticCaptureUnavailable,
    redact,
)


class _Clock:
    def __init__(self) -> None:
        self.now = datetime(2026, 1, 1, tzinfo=timezone.utc)

    def __call__(self) -> datetime:
        return self.now

    def advance(self, seconds: int) -> None:
        self.now += timedelta(seconds=seconds)


def test_records_are_private_bounded_and_carry_identity(tmp_path):
    capture = DiagnosticCapture(tmp_path / "capture", max_entries=4, ttl_seconds=600)
    stored = capture.record(
        kind="malformed_record", detail="line is not JSON (15 bytes)",
        task_id="task-1", attempt_id="attempt-1", runtime="prime",
    )
    assert stored is not None
    assert stored["kind"] == "malformed_record"
    assert stored["taskId"] == "task-1" and stored["attemptId"] == "attempt-1"
    path = tmp_path / "capture" / "diagnostics.json"
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    assert stat.S_IMODE(os.stat(path.parent).st_mode) == 0o700

    # Unknown kinds are stored as "other" rather than trusted verbatim.
    row = capture.record(kind="invented", detail="x")
    assert row["kind"] == "other"
    # An empty detail is not stored at all.
    assert capture.record(kind="other", detail="   ") is None


def test_credentials_are_redacted_before_storage(tmp_path):
    capture = DiagnosticCapture(tmp_path / "capture")
    capture.record(kind="runner_error", detail="failed with token=abc123 and Bearer sk-live-abcdefghijklmnop")
    capture.record(kind="other", detail="key AKIAIOSFODNN7EXAMPLE")
    ledger = (tmp_path / "capture" / "diagnostics.json").read_bytes()
    assert b"abc123" not in ledger
    assert b"sk-live-abcdefghijklmnop" not in ledger
    assert b"AKIAIOSFODNN7EXAMPLE" not in ledger
    details = [row["detail"] for row in capture.list(10)]
    assert all("abc123" not in detail for detail in details)
    assert any("[REDACTED]" in detail for detail in details)


def test_redaction_keeps_ordinary_diagnostic_text():
    assert redact("unhandled native record type: turn_start") == "unhandled native record type: turn_start"
    assert redact("line is not JSON (15 bytes)") == "line is not JSON (15 bytes)"
    assert redact("the key is here in prose") == "the key is here in prose"
    assert redact("token=abc123") == "token=[REDACTED]"
    # Control characters never reach the ledger.
    assert "\x07" not in redact("bell\x07here")
    # Long text is truncated, not silently dropped.
    assert len(redact("x " * 1000)) <= 512


def test_entries_expire_and_the_ledger_stays_bounded(tmp_path):
    clock = _Clock()
    capture = DiagnosticCapture(tmp_path / "capture", max_entries=3, ttl_seconds=600, now=clock)
    for index in range(5):
        capture.record(kind="other", detail=f"record {index}")
    # The oldest records are dropped once the cap is reached.
    assert [row["detail"] for row in capture.list(3)] == ["record 4", "record 3", "record 2"]

    clock.advance(601)
    assert capture.list(3) == []
    assert capture.clear() == 0


def test_clear_removes_unexpired_records(tmp_path):
    capture = DiagnosticCapture(tmp_path / "capture", ttl_seconds=600)
    capture.record(kind="other", detail="one")
    capture.record(kind="other", detail="two")
    assert capture.clear() == 2
    assert capture.list(5) == []


def test_status_declares_that_raw_output_is_not_stored(tmp_path):
    capture = DiagnosticCapture(tmp_path / "capture", max_entries=8, ttl_seconds=900)
    status = capture.status()
    assert status["rawCapture"] is False
    assert status["maxEntries"] == 8 and status["ttlSeconds"] == 900
    assert status["entryCount"] == 0
    assert "never raw process output" in status["note"]


def test_an_unsafe_or_tampered_ledger_fails_closed(tmp_path):
    capture = DiagnosticCapture(tmp_path / "capture")
    capture.record(kind="other", detail="one")
    path = tmp_path / "capture" / "diagnostics.json"

    path.chmod(0o644)
    with pytest.raises(DiagnosticCaptureUnavailable):
        capture.list(5)
    path.chmod(0o600)

    path.write_bytes(b"not json")
    with pytest.raises(DiagnosticCaptureUnavailable):
        capture.list(5)

    path.write_bytes(json.dumps({"version": 1, "entries": [{"kind": "other"}]}).encode())
    with pytest.raises(DiagnosticCaptureUnavailable):
        capture.list(5)

    path.write_bytes(json.dumps({"version": 2, "entries": []}).encode())
    with pytest.raises(DiagnosticCaptureUnavailable):
        capture.list(5)

    # A ledger with an invalid kind or an oversized detail is refused too.
    row = {"recordedAt": "2026-01-01T00:00:00+00:00", "expiresAt": "2027-01-01T00:00:00+00:00",
           "kind": "invented", "detail": "x", "taskId": None, "attemptId": None, "runtime": None}
    path.write_bytes(json.dumps({"version": 1, "entries": [row]}).encode())
    with pytest.raises(DiagnosticCaptureUnavailable):
        capture.list(5)


def test_the_ledger_is_encrypted_at_rest_under_a_key_held_only_in_memory(tmp_path):
    key = bytes(range(32))
    capture = DiagnosticCapture(tmp_path / "capture", key=key)
    capture.record(kind="runner_error", detail="runtime prime could not parse line 7",
                   task_id="task-plain", runtime="prime")
    root = tmp_path / "capture"
    ledger = (root / "diagnostics.json").read_bytes()
    # Nothing a record carries is readable on disk: not the detail, the kind or its identity.
    for fragment in (b"could not parse", b"runner_error", b"task-plain", b"prime", b"expiresAt"):
        assert fragment not in ledger
    envelope = json.loads(ledger)
    assert set(envelope) == {"version", "cipher", "keyId", "nonce", "ciphertext"}
    assert envelope["version"] == 2 and envelope["cipher"] == "AES-256-GCM"
    # The key is never persisted next to the ledger.
    assert sorted(path.name for path in root.iterdir()) == ["diagnostics.json"]
    assert key.hex().encode() not in ledger
    # A fresh nonce is used for every write, so identical content never repeats on disk.
    capture.clear()
    first = json.loads((root / "diagnostics.json").read_bytes())["nonce"]
    capture.clear()
    assert json.loads((root / "diagnostics.json").read_bytes())["nonce"] != first
    # The same key reads it back.
    reopened = DiagnosticCapture(root, key=key)
    assert reopened.list(5) == []


def test_a_ledger_from_a_previous_process_key_is_discarded_not_trusted(tmp_path):
    root = tmp_path / "capture"
    DiagnosticCapture(root).record(kind="other", detail="written before a restart")
    # A new process draws a new key: the old records are unreadable and dropped.
    restarted = DiagnosticCapture(root)
    assert restarted.list(5) == []
    status = restarted.status()
    assert status["entryCount"] == 0
    assert status["encryptedAtRest"] is True
    assert status["discardedUnreadableLedgers"] == 1
    # Writing replaces the unreadable ledger with one under the current key.
    restarted.record(kind="other", detail="after the restart")
    assert [row["detail"] for row in restarted.list(5)] == ["after the restart"]
    assert restarted.status()["discardedUnreadableLedgers"] == 1


def test_a_tampered_ciphertext_under_the_current_key_fails_closed(tmp_path):
    root = tmp_path / "capture"
    capture = DiagnosticCapture(root, key=b"k" * 32)
    capture.record(kind="other", detail="authentic")
    path = root / "diagnostics.json"
    envelope = json.loads(path.read_bytes())
    ciphertext = bytearray(base64.b64decode(envelope["ciphertext"]))
    ciphertext[0] ^= 0x01
    envelope["ciphertext"] = base64.b64encode(bytes(ciphertext)).decode()
    path.write_bytes(json.dumps(envelope).encode())
    with pytest.raises(DiagnosticCaptureUnavailable):
        capture.list(5)
    # A wrong-sized key is refused outright.
    with pytest.raises(ValueError):
        DiagnosticCapture(tmp_path / "other", key=b"short")


def test_missing_encryption_support_disables_capture_instead_of_storing_plaintext(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from archon_server import diagnostic_capture as module
    from archon_server.app import create_app
    from archon_server.config import Settings

    monkeypatch.setattr(module, "AESGCM", None)
    with pytest.raises(DiagnosticCaptureUnavailable):
        DiagnosticCapture(tmp_path / "capture")
    assert not (tmp_path / "capture" / "diagnostics.json").exists()

    # The server still starts; only the diagnostics surface reports itself unavailable.
    settings = Settings(
        archon_root=tmp_path, hermes_home=tmp_path / ".hermes", data_dir=tmp_path / ".data",
        auth_token="legacy-token", local_owner_mode=True, start_worker=False,
    )
    with TestClient(create_app(settings)) as client:
        assert client.app.state.diagnostic_capture is None
        headers = _paired_owner_headers(settings.local_pairing_socket_path)
        assert client.get("/api/local/diagnostics", headers=headers).status_code == 503


def test_constructor_bounds_and_limit_validation(tmp_path):
    for kwargs in ({"max_entries": 0}, {"max_entries": 513}, {"ttl_seconds": 10}, {"ttl_seconds": 4_000_000}):
        with pytest.raises(ValueError):
            DiagnosticCapture(tmp_path / "bounded", **kwargs)
    with pytest.raises(ValueError):
        DiagnosticCapture("relative/path")
    capture = DiagnosticCapture(tmp_path / "limits")
    with pytest.raises(ValueError):
        capture.list(0)
    with pytest.raises(ValueError):
        capture.list(9999)


@pytest.mark.asyncio
async def test_the_task_engine_forwards_diagnostics_to_the_sink(tmp_path):
    """A runner diagnostic reaches the sink, and a failing sink never fails a turn."""
    from archon_server.db import Database
    from archon_server.tasks import TaskEngine, TaskStore

    class DiagnosticRunner:
        async def run(self, task, emit):
            await emit("diagnostic", {
                "kind": "malformed_record", "runtime": "prime",
                "detail": "line is not JSON (15 bytes)", "malformed": 1, "unknown": 0,
            })
            return {"text": "ok"}

    store = TaskStore(Database(tmp_path / "state.db"))
    capture = DiagnosticCapture(tmp_path / "capture")
    engine = TaskEngine(store, DiagnosticRunner(), diagnostic_sink=capture.record_mapping)
    store.submit("diagnose")
    assert await engine.run_once() is True
    rows = capture.list(5)
    assert len(rows) == 1
    assert rows[0]["kind"] == "malformed_record" and rows[0]["runtime"] == "prime"
    assert rows[0]["taskId"]

    class BrokenSink:
        def __call__(self, row):
            raise RuntimeError("capture exploded")

    store_two = TaskStore(Database(tmp_path / "state2.db"))
    broken = TaskEngine(store_two, DiagnosticRunner(), diagnostic_sink=BrokenSink())
    submitted = store_two.submit("diagnose anyway")
    # The turn completes even though the sink raised.
    assert await broken.run_once() is True
    assert store_two.get(submitted["id"])["status"] == "completed"

def _paired_owner_headers(socket_path: Path) -> dict[str, str]:
    """Self-contained pairing helper: CI runs pytest where `tests` is not a package."""
    import socket as _socket

    from archon_server.local_pairing import LOCAL_PAIRING_AUDIENCE

    with _socket.socket(_socket.AF_UNIX, _socket.SOCK_STREAM) as connection:
        connection.settimeout(3)
        connection.connect(str(socket_path))
        stream = connection.makefile("rwb", buffering=0)
        stream.write(json.dumps({"op": "challenge", "audience": LOCAL_PAIRING_AUDIENCE}).encode() + b"\n")
        challenge = json.loads(stream.readline())["challenge"]
        stream.write(json.dumps({
            "op": "redeem", "audience": LOCAL_PAIRING_AUDIENCE, "nonce": challenge["nonce"],
        }).encode() + b"\n")
        credential = json.loads(stream.readline())["credential"]
    return {"Authorization": f"Bearer {credential['access_token']}"}


def test_diagnostic_capture_api_is_owner_only_and_clearable(tmp_path):
    """The ledger is readable and clearable by the owner, and holds no raw output."""
    from fastapi.testclient import TestClient

    from archon_server.app import create_app
    from archon_server.config import Settings

    settings = Settings(
        archon_root=tmp_path,
        hermes_home=tmp_path / ".hermes",
        data_dir=tmp_path / ".data",
        auth_token="legacy-token",
        local_owner_mode=True,
        start_worker=False,
    )
    with TestClient(create_app(settings)) as client:
        headers = _paired_owner_headers(settings.local_pairing_socket_path)
        capture = client.app.state.diagnostic_capture
        assert isinstance(capture, DiagnosticCapture)
        capture.record(kind="runner_error", detail="failed with token=abc123",
                       task_id="task-1", runtime="prime")

        assert client.get("/api/local/diagnostics").status_code == 401
        body = client.get("/api/local/diagnostics?limit=8", headers=headers).json()
        assert body["rawCapture"] is False
        assert body["entries"], body
        entry = body["entries"][0]
        assert entry["kind"] == "runner_error" and entry["runtime"] == "prime"
        assert "abc123" not in json.dumps(body)
        assert "[REDACTED]" in entry["detail"]
        assert client.get("/api/local/diagnostics?limit=999", headers=headers).status_code == 422

        assert client.get("/api/local/diagnostics", headers={"Authorization": "Bearer legacy-token"}).status_code == 401
        cleared = client.request("DELETE", "/api/local/diagnostics", headers=headers)
        assert cleared.status_code == 200 and cleared.json()["removed"] == 1
        assert client.get("/api/local/diagnostics", headers=headers).json()["entries"] == []

