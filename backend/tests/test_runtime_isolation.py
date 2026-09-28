"""Opt-in runtime confinement: mechanics, refusal and native sandbox behaviour."""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
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
    assert "bwrap" in argv
    assert argv[argv.index("--ro-bind") + 1:argv.index("--ro-bind") + 3] == ["/", "/"]


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


def _masks(argv: list[str]) -> list[str]:
    return [argv[index + 1] for index, item in enumerate(argv) if item == "--tmpfs"]


def test_confined_view_hides_host_ipc_scratch_and_devices(tmp_path):
    """A read-only bind does not stop connect(), so IPC locations must be hidden."""
    argv = bubblewrap_argv([tmp_path])
    for root in ("/run", "/tmp", "/var/tmp"):
        assert root in _masks(argv)
    # A private minimal /dev replaces the host one (shared memory, device nodes).
    assert argv[argv.index("--dev") + 1] == "/dev" and "--dev-bind" not in argv
    # No process started inside may outlive the sandbox or signal host processes.
    assert "--unshare-pid" in argv and "--die-with-parent" in argv
    # Writable roots are bound after every mask, so they stay writable.
    assert argv.index("--bind") > max(index for index, item in enumerate(argv) if item == "--tmpfs")


def test_network_only_isolation_still_owns_its_pid_namespace():
    argv = bubblewrap_argv([], confine_filesystem=False, isolate_network=True)
    assert "--unshare-pid" in argv and "--unshare-net" in argv
    assert "--tmpfs" not in argv


def test_view_layers_apply_in_order(tmp_path):
    home = tmp_path / "home"
    package = home / "lib" / "pkg"
    config = home / ".runtime"
    for directory in (package, config):
        directory.mkdir(parents=True)
    view = sandbox.SandboxView(
        masked_roots=(home,),
        symlinks=(("../lib/pkg/cli", home / "bin" / "tool"),),
        readable_paths=(package,),
        private_homes=(config,),
    )
    argv = bubblewrap_argv([home / "work"], view=view)
    mask = argv.index(str(home))
    link = argv.index("--symlink")
    readable = argv.index(str(package))
    overlay = argv.index("--tmp-overlay")
    writable = argv.index("--bind")
    assert argv[mask - 1] == "--tmpfs"
    assert mask < link < readable < overlay < writable
    assert argv[overlay - 2:overlay + 2] == ["--overlay-src", str(config), "--tmp-overlay", str(config)]


def test_program_view_follows_links_and_the_interpreter_into_masked_locations(tmp_path):
    home = tmp_path / "home"
    package = home / ".local" / "lib" / "node_modules" / "@scope" / "agent"
    (package / "dist").mkdir(parents=True)
    script = package / "dist" / "cli.js"
    script.write_text("#!/usr/bin/env fakenode\nconsole.log(1)\n")
    script.chmod(0o755)
    bin_dir = home / ".local" / "bin"
    bin_dir.mkdir(parents=True)
    (bin_dir / "agent").symlink_to("../lib/node_modules/@scope/agent/dist/cli.js")
    node_bin = home / ".local" / "share" / "node" / "bin"
    node_bin.mkdir(parents=True)
    interpreter = node_bin / "fakenode"
    interpreter.write_text("#!/bin/sh\n")
    interpreter.chmod(0o755)

    links, readable = sandbox.program_view(
        str(bin_dir / "agent"), search_path=str(node_bin), masked=[home],
    )

    assert links == (("../lib/node_modules/@scope/agent/dist/cli.js", bin_dir / "agent"),)
    # The whole package (its modules and dependencies) and the interpreter's own
    # directory are shown; nothing else of the masked home is.
    assert readable == (package, node_bin)
    # A program outside every masked location needs nothing re-exposed.
    assert sandbox.program_view("/bin/sh", masked=[home]) == ((), ())


def test_program_view_never_reexposes_a_whole_masked_location(tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    tool = home / "tool"
    tool.write_text("#!/bin/sh\n")
    tool.chmod(0o755)
    _links, readable = sandbox.program_view(str(tool), masked=[home])
    # Its directory is the masked home itself, so only the file is shown.
    assert readable == (tool,)


def test_confined_command_refuses_a_writable_root_that_would_unmask_a_location(tmp_path):
    view = sandbox.SandboxView(masked_roots=(tmp_path / "home",))
    for root in (Path("/"), Path("/tmp"), Path("/run"), tmp_path / "home", tmp_path):
        with pytest.raises(ValueError):
            confined_command(argv=["/bin/true"], cwd=root, writable_roots=[], view=view)
    # A root below a masked location is fine: it is bound over the mask.
    workspace = tmp_path / "home" / "checkout"
    argv = confined_command(argv=["/bin/true"], cwd=workspace, writable_roots=[], view=view)
    assert [str(workspace), str(workspace)] == argv[argv.index("--bind") + 1:argv.index("--bind") + 3]


def test_runtime_confinement_refuses_to_confine_a_run_in_the_home_directory():
    confinement = RuntimeConfinement("workspace-only", prober=lambda _path: True)
    with pytest.raises(RuntimeConfinementUnavailable) as refused:
        confinement.command(argv=["/bin/true"], cwd=Path.home(), writable_roots=[])
    assert "the run was not started" in str(refused.value)


def test_runtime_confinement_masks_the_home_and_shows_the_native_home_privately(tmp_path):
    native = tmp_path / "native"
    native.mkdir()
    extra = tmp_path / "extra"
    confinement = RuntimeConfinement("workspace-only", prober=lambda _path: True, readable_paths=[extra])
    checkout = tmp_path / WORKSPACE_DIRNAME
    argv = confinement.command(
        argv=["/bin/true"], cwd=checkout, writable_roots=[], private_homes=[native],
    )
    for home in sandbox.account_homes():
        assert str(home) in _masks(argv)
    assert argv[argv.index("--overlay-src") + 1] == str(native)
    # A configured extra path is shown read-only when it exists, and skipped otherwise.
    assert str(extra) not in argv
    extra.mkdir()
    argv = confinement.command(argv=["/bin/true"], cwd=checkout, writable_roots=[])
    assert [str(extra), str(extra)] == argv[argv.index(str(extra)):argv.index(str(extra)) + 2]


def _bwrap_supports_overlay() -> bool:
    if shutil.which("bwrap") is None:
        return False
    try:
        return "--tmp-overlay" in subprocess.run(
            ["bwrap", "--help"], capture_output=True, text=True, timeout=10,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return False


@pytest.mark.skipif(shutil.which("bwrap") is None, reason="bubblewrap is unavailable on this host")
def test_filesystem_probe_refuses_a_view_that_leaves_host_ipc_reachable(monkeypatch):
    """Regression: a read-only /tmp and /run still let a sandbox connect to host sockets.

    That is how a confined process reached the user's session bus and ran
    `systemd-run --user` outside the sandbox. The probe serves sockets in those
    locations and must refuse a view that does not hide them.
    """
    monkeypatch.setattr(sandbox, "masked_system_roots", lambda: ())
    outputs = _recording_run(monkeypatch)

    assert probe_filesystem_confinement() is False
    assert outputs and "reached=0" not in outputs[-1]
    assert "denied=True" in outputs[-1] and "allowed=True" in outputs[-1]


@pytest.mark.skipif(shutil.which("bwrap") is None, reason="bubblewrap is unavailable on this host")
def test_filesystem_probe_refuses_a_view_that_lets_a_process_outlive_it(monkeypatch):
    """Regression: a daemonizing child survived the sandbox without a PID namespace."""
    real_argv = sandbox.bubblewrap_argv
    monkeypatch.setattr(
        sandbox, "bubblewrap_argv",
        lambda roots, **kwargs: [item for item in real_argv(roots, **kwargs) if item != "--unshare-pid"],
    )
    outputs = _recording_run(monkeypatch)

    assert probe_filesystem_confinement() is False
    # Every other leg held, so the refusal is the survivor check's.
    assert outputs and "reached=0" in outputs[-1] and "denied=True" in outputs[-1]
    assert not sandbox._survivors(sandbox.PROBE_PREFIX + "survivor-")


@pytest.mark.skipif(not _bwrap_supports_overlay(), reason="bubblewrap has no --tmp-overlay on this host")
def test_this_host_enforces_the_runtime_view_with_a_private_native_home():
    """Evidence test: every probe leg, including the discarded configuration layer."""
    assert probe_filesystem_confinement(private_homes=True) is True


@pytest.mark.skipif(shutil.which("bwrap") is None, reason="bubblewrap is unavailable on this host")
def test_a_confined_command_cannot_see_the_account_home_or_host_sockets(tmp_path):
    """Evidence test: the real view hides the home directory and /tmp sockets."""
    checkout = tmp_path / WORKSPACE_DIRNAME
    checkout.mkdir()
    listener_dir = Path(tempfile.mkdtemp(prefix="archon-view-test-", dir="/tmp"))
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    path = str(listener_dir / "s")
    try:
        listener.bind(path)
        listener.listen(1)
        script = (
            "import os, socket, sys\n"
            "client = socket.socket(socket.AF_UNIX)\n"
            "try:\n"
            "    client.connect(sys.argv[1]); reached = True\n"
            "except OSError:\n"
            "    reached = False\n"
            "home = os.path.expanduser('~')\n"
            "print('reached=%s home=%s' % (reached, ','.join(sorted(os.listdir(home))) or '-'))\n"
        )
        view = sandbox.workspace_view("python3")
        argv = confined_command(
            argv=["python3", "-c", script, path], cwd=checkout, writable_roots=[], view=view,
        )
        result = subprocess.run(argv, capture_output=True, text=True, timeout=30)
    finally:
        listener.close()
        shutil.rmtree(listener_dir, ignore_errors=True)
    assert result.returncode == 0, result.stderr
    fields = dict(item.split("=", 1) for item in result.stdout.split())
    assert fields["reached"] == "False"
    # The masked home holds nothing but the parents of what the view re-exposed.
    shown = {
        path.relative_to(Path.home()).parts[0]
        for path in [*view.readable_paths, *(link for _target, link in view.symlinks)]
        if sandbox._inside(path, Path.home())
    }
    visible = set() if fields["home"] == "-" else set(fields["home"].split(","))
    assert visible <= shown
    assert ".ssh" not in visible
