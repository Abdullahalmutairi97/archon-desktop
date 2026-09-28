"""Same-uid /proc exposure: the server clears its dumpable flag, and it is verified.

Linux exposes `/proc/<pid>/environ` to any process of the same user unless the
target cleared its dumpable flag. The server holds provider credentials in its
own environment, so this test proves the channel is actually closed for a
hardened process, with an unhardened control that must stay readable.
"""
from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from archon_server.hardening import (
    PR_GET_DUMPABLE,
    PR_SET_DUMPABLE,
    disable_process_dumpability,
    process_dumpable,
)

LINUX_ONLY = pytest.mark.skipif(sys.platform != "linux", reason="prctl is Linux-only")

CHILD_SOURCE = """
import os, sys, time
sys.path.insert(0, {backend!r})
if sys.argv[1] == "harden":
    from archon_server.hardening import disable_process_dumpability
    assert disable_process_dumpability() is True
# A second child proves hardening does not break spawning.
import subprocess
grandchild = subprocess.run([sys.executable, "-c", "print('grandchild-ok')"], capture_output=True, text=True)
print("GRANDCHILD", grandchild.stdout.strip(), flush=True)
time.sleep(20)
"""


def _start_child(tmp_path: Path, mode: str) -> subprocess.Popen[str]:
    backend = str(Path(__file__).resolve().parents[1])
    script = tmp_path / f"child-{mode}.py"
    script.write_text(CHILD_SOURCE.format(backend=backend), encoding="utf-8")
    process = subprocess.Popen(
        [sys.executable, str(script), mode],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        env={**os.environ, "ARCHON_HARDENING_PROBE": "probe-value"},
    )
    assert process.stdout is not None
    line = process.stdout.readline()
    assert line.startswith("GRANDCHILD"), line
    return process


def _read_environ(pid: int) -> str | None:
    try:
        with open(f"/proc/{pid}/environ", "rb") as handle:
            return handle.read().decode("utf-8", errors="replace")
    except PermissionError:
        return None


@LINUX_ONLY
def test_a_hardened_process_hides_its_environment_from_the_same_user(tmp_path):
    control = _start_child(tmp_path, "control")
    hardened = _start_child(tmp_path, "harden")
    try:
        # The control stays readable, so the check below is about the flag.
        control_environ = _read_environ(control.pid)
        assert control_environ is not None and "ARCHON_HARDENING_PROBE=probe-value" in control_environ
        assert _read_environ(hardened.pid) is None
    finally:
        for process in (control, hardened):
            process.kill()
            process.wait(timeout=30)


@LINUX_ONLY
def test_the_helper_reports_the_kernel_state_and_is_idempotent():
    import ctypes

    libc = ctypes.CDLL(None, use_errno=True)
    before = libc.prctl(PR_GET_DUMPABLE, 0, 0, 0, 0)
    assert disable_process_dumpability() is True
    # The call is idempotent, and the reported state matches the kernel.
    assert disable_process_dumpability() is True
    assert process_dumpable() is False
    assert libc.prctl(PR_GET_DUMPABLE, 0, 0, 0, 0) == 0
    # Restore this pytest process so later tests keep their own /proc visibility.
    libc.prctl(PR_SET_DUMPABLE, before, 0, 0, 0)
    assert libc.prctl(PR_GET_DUMPABLE, 0, 0, 0, 0) == before


def test_the_server_entry_point_clears_the_flag_before_listening(monkeypatch):
    import archon_server.main as main_module

    events: list[str] = []
    settings = type("Settings", (), {"bind_host": "127.0.0.1", "bind_port": 9999})()
    monkeypatch.setattr(main_module, "Settings", lambda: settings)
    monkeypatch.setattr(main_module, "validate_server_security", lambda _value: events.append("validate"))
    monkeypatch.setattr(main_module, "create_app", lambda _value: events.append("app") or "app")
    monkeypatch.setattr(main_module.uvicorn, "run", lambda *_args, **_kwargs: events.append("run"))
    monkeypatch.setattr(
        main_module, "disable_process_dumpability", lambda: events.append("harden") or True,
    )

    main_module.main()

    # Hardening happens after configuration is validated and before the listener runs.
    assert events == ["validate", "harden", "app", "run"]
