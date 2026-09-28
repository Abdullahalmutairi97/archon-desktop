"""Malformed and unknown native records become bounded diagnostics, not outcomes."""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

from archon_server.native_diagnostics import MAX_DIAGNOSTIC_EMISSIONS, NativeEventDiagnostics
from archon_server.pi_runner import PiRunner
from archon_server.prime_runner import PrimeRunner


def test_diagnostics_are_bounded_and_deduplicate_unknown_types():
    diagnostics = NativeEventDiagnostics("prime")
    rows = [diagnostics.note_malformed(f"line {index}") for index in range(2)]
    assert [row["kind"] for row in rows] == ["malformed_record"] * 2
    assert rows[-1]["malformed"] == 2

    # Each distinct unhandled type is reported once, up to the emission bound.
    unknown = [diagnostics.note_unknown(name) for name in ("turn_start", "turn_start", "usage", "kv", "extra")]
    reported = [row for row in unknown if row is not None]
    # The bound is global: two malformed rows left room for two distinct types.
    assert [row["detail"] for row in reported] == [
        "unhandled native record type: turn_start",
        "unhandled native record type: usage",
    ]
    assert diagnostics.note_unknown("extra") is None
    assert diagnostics.total == 8
    assert diagnostics.unknown == 6
    # The count keeps rising after the emission bound is reached.
    assert diagnostics.note_malformed("more") is None and diagnostics.malformed == 3
    assert NativeEventDiagnostics("pi", max_emissions=1).note_malformed("x" * 500)["detail"].endswith("...")


def _fake_runtime(tmp_path: Path, lines: list[str]) -> Path:
    executable = tmp_path / "fake-runtime"
    # Each line must reach stdout as written, including JSON objects and arrays.
    body = "\n".join("print(" + json.dumps(line) + ")" for line in lines)
    executable.write_text("#!" + sys.executable + "\n" + body + "\n")
    executable.chmod(0o755)
    return executable


PRIME_RECORDS = [
    "not json at all",
    "[1, 2, 3]",
    json.dumps({"type": "turn_start", "id": "t1"}),
    json.dumps({"type": "kv", "value": 1}),
    json.dumps({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": "hello"}}),
    json.dumps({"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": "hello"}]}}),
]

PI_RECORDS = [
    "not json at all",
    json.dumps(["not", "an", "object"]),
    json.dumps({"type": "kv", "value": 1}),
    json.dumps({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": "hi"}}),
    json.dumps({"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": "hi"}]}}),
]


@pytest.mark.asyncio
async def test_prime_runner_reports_malformed_and_unknown_records(tmp_path):
    executable = _fake_runtime(tmp_path, PRIME_RECORDS)
    emitted: list[tuple[str, dict]] = []

    async def emit(kind, data):
        emitted.append((kind, data))

    result = await PrimeRunner(executable, tmp_path / "sessions", tmp_path).run(
        {"id": "diag-prime", "approval_mode": "auto", "prompt": "go", "cwd": str(tmp_path)}, emit
    )

    # The valid record still completes the turn; the bad records never did.
    assert result["text"] == "hello"
    diagnostics = [data for kind, data in emitted if kind == "diagnostic"]
    # One unparsable line, one record that is valid JSON but not an object, and
    # two unhandled types; the bound allows exactly those four.
    assert [row["kind"] for row in diagnostics] == [
        "malformed_record", "malformed_record", "unknown_event_type", "unknown_event_type",
    ]
    assert [row["runtime"] for row in diagnostics] == ["prime"] * 4
    assert [row["malformed"] for row in diagnostics] == [1, 2, 2, 2]
    assert [row["unknown"] for row in diagnostics] == [0, 0, 1, 2]
    assert diagnostics[0]["detail"] == f"line is not JSON ({len(PRIME_RECORDS[0])} bytes)"
    assert diagnostics[1]["detail"] == "record is not a JSON object"
    assert [row["detail"] for row in diagnostics[2:]] == [
        "unhandled native record type: turn_start",
        "unhandled native record type: kv",
    ]
    # No diagnostic claims a completion or an outcome field.
    for row in diagnostics:
        assert not {"result", "text", "error", "exit_code"} & set(row)


@pytest.mark.asyncio
async def test_pi_runner_reports_malformed_and_unknown_records(tmp_path):
    executable = _fake_runtime(tmp_path, PI_RECORDS)
    emitted: list[tuple[str, dict]] = []

    async def emit(kind, data):
        emitted.append((kind, data))

    result = await PiRunner(executable, tmp_path / "sessions", tmp_path).run(
        {"id": "diag-pi", "approval_mode": "auto", "prompt": "go", "cwd": str(tmp_path)}, emit
    )

    assert result["text"] == "hi"
    diagnostics = [data for kind, data in emitted if kind == "diagnostic"]
    assert [row["kind"] for row in diagnostics] == ["malformed_record", "malformed_record", "unknown_event_type"]
    assert all(row["runtime"] == "pi" for row in diagnostics)
    assert diagnostics[-1]["detail"] == "unhandled native record type: kv"


@pytest.mark.asyncio
async def test_unhandled_record_types_alone_do_not_fail_a_turn(tmp_path):
    """An unknown type is a diagnostic; only unreadable output fails the turn."""
    executable = _fake_runtime(tmp_path, [
        json.dumps({"type": "turn_start"}),
        json.dumps({"type": "agent_end", "messages": []}),
    ])
    emitted: list[tuple[str, dict]] = []

    async def emit(kind, data):
        emitted.append((kind, data))

    result = await PrimeRunner(executable, tmp_path / "sessions", tmp_path).run(
        {"id": "unknown-only", "approval_mode": "auto", "prompt": "go", "cwd": str(tmp_path)}, emit
    )
    assert result["text"] == ""
    assert [data["kind"] for kind, data in emitted if kind == "diagnostic"] == ["unknown_event_type"]


@pytest.mark.asyncio
async def test_a_flood_of_malformed_records_stays_bounded(tmp_path):
    executable = _fake_runtime(tmp_path, ["garbage %d" % index for index in range(50)])
    emitted: list[tuple[str, dict]] = []

    async def emit(kind, data):
        emitted.append((kind, data))

    with pytest.raises(RuntimeError):
        # No valid record and no answer, so the turn fails rather than completing.
        await PrimeRunner(executable, tmp_path / "sessions", tmp_path).run(
            {"id": "flood", "approval_mode": "auto", "prompt": "go", "cwd": str(tmp_path)}, emit
        )
    diagnostics = [data for kind, data in emitted if kind == "diagnostic"]
    assert len(diagnostics) == MAX_DIAGNOSTIC_EMISSIONS
    assert [row["malformed"] for row in diagnostics] == [1, 2, 3, 4]
