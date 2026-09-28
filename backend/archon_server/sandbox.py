"""Shared bubblewrap confinement helpers.

Two callers need the same mechanics: a workspace service confined to its
checkout, and a runtime child process. Both need the host filesystem read-only,
a bounded set of writable directories, an optional private network namespace,
and a behavioural probe that proves the confinement is real before anything is
launched. An accepted-but-ignored option is worse than no option, so the probe
runs a real write test inside a real sandbox on every host it is used on.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Iterable, Sequence

PROBE_SCRIPT = (
    "import pathlib\n"
    "denied=False\n"
    "allowed=False\n"
    "try:\n"
    " pathlib.Path('/etc/.archon-isolation-probe').write_text('x')\n"
    "except OSError:\n"
    " denied=True\n"
    "target=pathlib.Path(__import__('sys').argv[1])/'.archon-isolation-probe'\n"
    "try:\n"
    " target.write_text('x')\n"
    " target.unlink()\n"
    " allowed=True\n"
    "except OSError:\n"
    " allowed=False\n"
    "print('denied=%s allowed=%s' % (denied, allowed))\n"
)

NETWORK_PROBE_SCRIPT = (
    "import socket\n"
    "s=socket.socket(); s.settimeout(3)\n"
    "code=s.connect_ex(('1.1.1.1', 443))\n"
    "print('connect=%d' % code)\n"
)


def bubblewrap_available() -> bool:
    """Report whether the sandbox binary and a Python interpreter are present."""
    return shutil.which("bwrap") is not None and shutil.which("python3") is not None


def bubblewrap_argv(
    writable_roots: Sequence[Path],
    *,
    confine_filesystem: bool = True,
    isolate_network: bool = False,
) -> list[str]:
    """Build a sandbox command prefix for the given writable directories.

    With `confine_filesystem` the whole host is bound read-only and only the
    listed directories are writable. Without it the filesystem is left alone,
    which is only useful together with `isolate_network`.
    """
    argv = ["bwrap", "--die-with-parent"]
    if confine_filesystem:
        argv += ["--ro-bind", "/", "/"]
        for root in writable_roots:
            argv += ["--bind", str(root), str(root)]
    else:
        argv += ["--bind", "/", "/"]
    argv += ["--dev-bind", "/dev", "/dev", "--proc", "/proc"]
    if isolate_network:
        argv.append("--unshare-net")
    return argv


def _run(argv: list[str], *, timeout: float = 30.0) -> subprocess.CompletedProcess[str] | None:
    try:
        return subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError):
        return None


def probe_filesystem_confinement(writable_root: Path) -> bool:
    """Prove that the host is read-only and one directory stays writable."""
    if not bubblewrap_available():
        return False
    probe_dir = None
    try:
        probe_dir = tempfile.mkdtemp(prefix="archon-isolation-probe-")
        os.chmod(probe_dir, 0o700)
        result = _run([
            *bubblewrap_argv([Path(probe_dir)]),
            "--", "python3", "-c", PROBE_SCRIPT, probe_dir,
        ])
    except OSError:
        return False
    finally:
        if probe_dir is not None:
            shutil.rmtree(probe_dir, ignore_errors=True)
    if result is None or result.returncode != 0:
        return False
    marker = [line for line in result.stdout.splitlines() if line.startswith("denied=")]
    if not marker:
        return False
    fields = dict(item.split("=", 1) for item in marker[-1].split() if "=" in item)
    return fields.get("denied") == "True" and fields.get("allowed") == "True"


def probe_network_isolation() -> bool:
    """Prove that a sandboxed process cannot reach the network."""
    if not bubblewrap_available():
        return False
    result = _run([
        *bubblewrap_argv([], confine_filesystem=False, isolate_network=True),
        "--", "python3", "-c", NETWORK_PROBE_SCRIPT,
    ])
    if result is None or result.returncode != 0:
        return False
    marker = [line for line in result.stdout.splitlines() if line.startswith("connect=")]
    if not marker:
        return False
    try:
        return int(marker[-1].split("=", 1)[1]) != 0
    except ValueError:
        return False


def confined_command(
    *, argv: Sequence[str], cwd: Path, writable_roots: Iterable[Path], isolate_network: bool = False,
) -> list[str]:
    """Wrap one command so it runs inside the sandbox with `cwd` writable."""
    roots: list[Path] = []
    for root in [cwd, *writable_roots]:
        resolved = Path(root)
        if resolved not in roots:
            roots.append(resolved)
    return [
        *bubblewrap_argv(roots, confine_filesystem=True, isolate_network=isolate_network),
        "--chdir", str(cwd),
        "--", *argv,
    ]


class RuntimeConfinementUnavailable(RuntimeError):
    """The requested runtime confinement is not enforced on this host."""


class RuntimeConfinement:
    """Opt-in confinement for a runtime child process.

    The profile is off by default: enabling it changes how the runtime is
    launched, and runtime compatibility inside the sandbox is only qualified by a
    real provider turn, which this module does not attempt. The probe proves the
    confinement mechanics (host read-only, declared directories writable) before
    any run starts, and a host without them refuses the run instead of launching
    unconfined.
    """

    PROFILE_NONE = "none"
    PROFILE_WORKSPACE_ONLY = "workspace-only"
    PROFILES = (PROFILE_NONE, PROFILE_WORKSPACE_ONLY)

    def __init__(self, profile: str = PROFILE_NONE, *, prober=probe_filesystem_confinement):
        if profile not in self.PROFILES:
            raise ValueError("runtime isolation profile must be 'none' or 'workspace-only'")
        self.profile = profile
        self._prober = prober
        self._available: bool | None = None

    @property
    def enabled(self) -> bool:
        return self.profile != self.PROFILE_NONE

    def ensure_available(self) -> None:
        """Fail closed when a requested profile is not enforced on this host."""
        if not self.enabled:
            return
        if self._available is None:
            try:
                self._available = bool(self._prober(Path(tempfile.gettempdir())))
            except Exception:
                self._available = False
        if not self._available:
            raise RuntimeConfinementUnavailable(
                "Runtime isolation is unavailable on this host; the run was not started"
            )

    def command(self, *, argv: Sequence[str], cwd: Path, writable_roots: Iterable[Path]) -> list[str]:
        """Return the command for one runtime invocation.

        With the profile disabled this returns the argv unchanged, because no
        confinement was requested. With it enabled, the command is confined or
        the run is refused.
        """
        if not self.enabled:
            return list(argv)
        self.ensure_available()
        return confined_command(argv=argv, cwd=cwd, writable_roots=writable_roots)
