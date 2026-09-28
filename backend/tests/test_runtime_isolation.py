"""Opt-in runtime confinement: mechanics, refusal and native sandbox behaviour."""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
from pathlib import Path

import pytest

from archon_server import sandbox
from archon_server.sandbox import (
    RuntimeConfinement,
    RuntimeConfinementUnavailable,
    bubblewrap_argv,
    confined_command,
    probe_filesystem_confinement,
    probe_network_isolation,
)

WORKSPACE_DIRNAME = "checkout"


def test_profile_validation_and_default_is_off(tmp_path):
    confinement = RuntimeConfinement()
    assert confinement.profile == "none" and confinement.enabled is False
    # A disabled profile never consults the probe, so its command is unchanged.
    assert confinement.command(argv=["/bin/true"], cwd=tmp_path, writable_roots=[]) == ["/bin/true"]
    with pytest.raises(ValueError):
        RuntimeConfinement("host")
    with pytest.raises(ValueError):
        RuntimeConfinement("workspace_only")


def test_confined_command_binds_the_checkout_read_only_host(tmp_path):
    checkout = tmp_path / WORKSPACE_DIRNAME
    checkout.mkdir()
    state = tmp_path / "state"
    state.mkdir()
    argv = confined_command(argv=["/bin/echo", "hi"], cwd=checkout, writable_roots=[state])
    assert argv[0] == "bwrap" and "--die-with-parent" in argv
    assert argv[argv.index("--ro-bind") + 1:argv.index("--ro-bind") + 3] == ["/", "/"]
    binds = [argv[index + 1:index + 3] for index, item in enumerate(argv) if item == "--bind"]
    assert [str(checkout), str(checkout)] in binds
    assert [str(state), str(state)] in binds
    assert argv[-3:] == ["--", "/bin/echo", "hi"]
    assert argv[argv.index("--chdir") + 1] == str(checkout)
    # A repeated writable root is bound once.
    deduped = confined_command(argv=["/bin/true"], cwd=checkout, writable_roots=[checkout, state, state])
    assert deduped.count("--bind") == 2


def test_missing_sandbox_refuses_the_run_instead_of_launching_unconfined():
    confinement = RuntimeConfinement("workspace-only", prober=lambda _path: False)
    with pytest.raises(RuntimeConfinementUnavailable) as refused:
        confinement.command(argv=["/bin/true"], cwd=Path("/"), writable_roots=[])
    assert "unavailable on this host" in str(refused.value)
    # A prober that raises is also treated as unavailable.
    broken = RuntimeConfinement("workspace-only", prober=lambda _path: (_ for _ in ()).throw(OSError("boom")))
    with pytest.raises(RuntimeConfinementUnavailable):
        broken.command(argv=["/bin/true"], cwd=Path("/"), writable_roots=[])


def test_network_isolation_adds_the_namespace_option():
    argv = bubblewrap_argv([Path("/tmp/x")], isolate_network=True)
    assert "--unshare-net" in argv
    assert "bwrap" in argv and argv.count("--ro-bind") == 1


@pytest.mark.skipif(shutil.which("bwrap") is None, reason="bubblewrap is unavailable on this host")
def test_this_host_enforces_the_runtime_confinement(tmp_path):
    """Evidence test: the probe must observe a denied host write."""
    checkout = tmp_path / WORKSPACE_DIRNAME
    checkout.mkdir()
    assert probe_filesystem_confinement(checkout) is True
    assert RuntimeConfinement("workspace-only").enabled is True


@pytest.mark.skipif(shutil.which("bwrap") is None, reason="bubblewrap is unavailable on this host")
@pytest.mark.asyncio
async def test_prime_runner_runs_inside_the_sandbox_and_stays_in_its_workspace(tmp_path):
    """A real sandboxed child: the checkout is writable, the host is not."""
    from archon_server.prime_runner import PrimeRunner

    checkout = tmp_path / WORKSPACE_DIRNAME
    checkout.mkdir()
    events = [
        {"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": "done"}},
        {"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": "done"}]}},
    ]
    executable = tmp_path / "fake-prime"
    # The fake runtime reports what the sandbox allowed it to touch.
    executable.write_text(
        "#!" + sys.executable + "\n"
        + "import json, pathlib, sys\n"
        + f"checkout = pathlib.Path({str(checkout)!r})\n"
        + "(checkout / 'inside.txt').write_text('written')\n"
        + "denied = False\n"
        + "try:\n"
        + "    pathlib.Path('/etc/.archon-runtime-probe').write_text('x')\n"
        + "except OSError:\n"
        + "    denied = True\n"
        + "print(json.dumps({'type': 'message_update', 'assistantMessageEvent': {'type': 'text_delta', 'delta': 'denied=%s ' % denied}}))\n"
        + "print(json.dumps({'type': 'message_end', 'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': 'denied=%s' % denied}]}}))\n"
    )
    executable.chmod(0o755)
    runner = PrimeRunner(
        executable, tmp_path / "sessions", tmp_path, tmp_path / "agent-sessions",
        isolation=RuntimeConfinement("workspace-only"),
    )
    result = await runner.run(
        {"id": "sandboxed", "approval_mode": "auto", "prompt": "go", "cwd": str(checkout)},
        lambda *_args: asyncio.sleep(0),
    )

    assert (checkout / "inside.txt").read_text() == "written"
    assert result["text"] == "denied=True"
    assert not Path("/etc/.archon-runtime-probe").exists()
    # The sandbox is applied to the runtime child, not to the supervisor wrapper.
    assert runner.isolation.enabled is True


def _recording_run(monkeypatch) -> list[str]:
    """Record every sandbox output while a probe runs, without changing behaviour."""
    outputs: list[str] = []
    real_run = sandbox._run

    def recording_run(argv, **kwargs):
        result = real_run(argv, **kwargs)
        outputs.append(result.stdout if result is not None else "")
        return result

    monkeypatch.setattr(sandbox, "_run", recording_run)
    return outputs


@pytest.mark.skipif(shutil.which("bwrap") is None, reason="bubblewrap is unavailable on this host")
def test_filesystem_probe_refuses_a_sandbox_that_ignores_the_confinement_request(tmp_path, monkeypatch):
    """Regression: a sandbox that confines nothing must not pass the probe.

    With the filesystem left unconfined, the unbound control directory stays
    writable inside the sandbox, so the probe must refuse the host. The earlier
    probe tested `/etc`, which this account cannot write with no sandbox at all,
    and therefore accepted exactly this host.
    """
    checkout = tmp_path / WORKSPACE_DIRNAME
    checkout.mkdir()
    real_argv = sandbox.bubblewrap_argv
    monkeypatch.setattr(
        sandbox, "bubblewrap_argv", lambda roots, **kwargs: real_argv(roots, confine_filesystem=False),
    )
    outputs = _recording_run(monkeypatch)

    assert probe_filesystem_confinement(checkout) is False
    # The sandbox ran and allowed both writes, so the refusal is the probe's.
    assert outputs and "control_visible=True" in outputs[-1]
    assert "denied=False" in outputs[-1] and "allowed=True" in outputs[-1]


@pytest.mark.skipif(shutil.which("bwrap") is None, reason="bubblewrap is unavailable on this host")
def test_network_probe_refuses_a_sandbox_that_ignores_the_namespace_option(monkeypatch):
    """Regression: reaching this host's listener inside the sandbox is not isolation."""
    real_argv = sandbox.bubblewrap_argv
    monkeypatch.setattr(
        sandbox, "bubblewrap_argv",
        lambda roots, **kwargs: [item for item in real_argv(roots, **kwargs) if item != "--unshare-net"],
    )
    outputs = _recording_run(monkeypatch)

    assert probe_network_isolation() is False
    # The sandboxed connect reached the listener this process serves.
    assert outputs and "connect=0" in outputs[-1]


@pytest.mark.skipif(shutil.which("bwrap") is None, reason="bubblewrap is unavailable on this host")
def test_filesystem_probe_requires_the_unsandboxed_control_write(tmp_path, monkeypatch):
    """A control that cannot write at all proves nothing, so the probe refuses."""
    checkout = tmp_path / WORKSPACE_DIRNAME
    checkout.mkdir()
    attempted: list[Path] = []

    def failing_control(directory, name):
        attempted.append(Path(directory) / name)
        return False

    monkeypatch.setattr(sandbox, "_control_write_succeeds", failing_control)

    assert probe_filesystem_confinement(checkout) is False
    # The unsandboxed control ran, and it targeted the unbound directory.
    assert attempted
    assert attempted[0].name == sandbox.CONTROL_FILENAME
    assert attempted[0].parent.name == sandbox.CONTROL_DIRNAME


@pytest.mark.skipif(shutil.which("bwrap") is None, reason="bubblewrap is unavailable on this host")
def test_network_probe_requires_the_unsandboxed_control_connect(monkeypatch):
    """A listener this host cannot reach proves nothing, so the probe refuses."""
    attempted: list[tuple[str, int]] = []

    def failing_control(host, port):
        attempted.append((host, port))
        return False

    monkeypatch.setattr(sandbox, "_control_connect", failing_control)

    assert probe_network_isolation() is False
    # The control connect ran against the loopback listener this process serves.
    assert attempted
    host, port = attempted[0]
    assert host == sandbox.LOOPBACK_HOST and port > 0


@pytest.mark.skipif(shutil.which("bwrap") is None, reason="bubblewrap is unavailable on this host")
def test_filesystem_probe_requires_the_writable_root_to_stay_writable(tmp_path):
    """A declared root the sandbox cannot write is refused, even with the host read-only."""
    checkout = tmp_path / WORKSPACE_DIRNAME
    checkout.mkdir()
    os.chmod(checkout, 0o500)
    try:
        assert probe_filesystem_confinement(checkout) is False
    finally:
        os.chmod(checkout, 0o700)
