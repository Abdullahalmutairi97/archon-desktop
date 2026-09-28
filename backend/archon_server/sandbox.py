"""Shared bubblewrap confinement helpers.

Two callers need the same mechanics: a workspace service confined to its
checkout, and a runtime child process. Both need the host filesystem read-only,
a bounded set of writable directories, an optional private network namespace,
and a behavioural probe that proves the confinement is real before anything is
launched. An accepted-but-ignored option is worse than no option, so the probe
runs a real test inside a real sandbox on every host it is used on, next to a
positive control that proves the same action works with no sandbox at all.
"""
from __future__ import annotations

import contextlib
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import uuid
from pathlib import Path
from typing import Iterable, Iterator, Sequence

# The probe scripts are minimal stdlib-only programs, because they run inside the
# sandbox where only `python3` and its standard library are guaranteed. Each one
# prints a single key=value line that the caller parses literally: missing keys or
# unreadable output are doubt, and doubt makes a probe fail closed.
PROBE_CONTENT = "x"
PROBE_MARKER = ".archon-isolation-probe"
PROBE_PREFIX = "archon-isolation-probe-"
CONTROL_DIRNAME = "unbound"
CONTROL_FILENAME = "control"
LOOPBACK_HOST = "127.0.0.1"
FILESYSTEM_PROBE_TIMEOUT = 30.0
NETWORK_PROBE_TIMEOUT = 15.0

# `control_visible` proves the unbound directory is really there inside the
# sandbox, so a refused write is a refusal and not a missing path. `left_behind`
# re-checks the same directory after the attempt, and `allowed` is the second
# sandboxed leg: the caller's writable root must still accept a write.
PROBE_SCRIPT = (
    "import pathlib, sys\n"
    "control_dir = pathlib.Path(sys.argv[1])\n"
    "writable_root = pathlib.Path(sys.argv[2])\n"
    "marker_name = sys.argv[3]\n"
    "control_visible = control_dir.is_dir()\n"
    "denied = False\n"
    "error_number = 0\n"
    "try:\n"
    f"    (control_dir / '{CONTROL_FILENAME}').write_text('{PROBE_CONTENT}')\n"
    "except OSError as failure:\n"
    "    denied = True\n"
    "    error_number = failure.errno or 0\n"
    f"left_behind = (control_dir / '{CONTROL_FILENAME}').exists()\n"
    "allowed = False\n"
    "try:\n"
    "    marker = writable_root / marker_name\n"
    f"    marker.write_text('{PROBE_CONTENT}')\n"
    "    marker.unlink()\n"
    "    allowed = True\n"
    "except OSError:\n"
    "    allowed = False\n"
    "print('control_visible=%s denied=%s left_behind=%s allowed=%s errno=%d' % (\n"
    "    control_visible, denied, left_behind, allowed, error_number))\n"
)

# The network probe connects to a listener this process serves on loopback, so a
# successful connect is a served connection rather than a stale backlog entry.
NETWORK_PROBE_SCRIPT = (
    "import socket, sys\n"
    "s = socket.socket(); s.settimeout(3)\n"
    "code = s.connect_ex((sys.argv[1], int(sys.argv[2])))\n"
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


def _inside(child: Path, parent: Path) -> bool:
    """Report whether `child` is `parent` or lives below it."""
    try:
        child.relative_to(parent)
    except ValueError:
        return False
    return True


def _control_base(writable_root: Path) -> Path | None:
    """Return a writable base directory outside `writable_root`, or None.

    The control directory has to live outside the caller's writable root: a
    directory below a root the sandbox binds writable stays writable inside the
    sandbox, so it could never be denied. Finding no such base is doubt, and
    doubt refuses the probe.
    """
    candidates = [Path(tempfile.gettempdir()), Path("/var/tmp")]
    runtime_dir = os.environ.get("XDG_RUNTIME_DIR")
    if runtime_dir:
        candidates.append(Path(runtime_dir))
    candidates += [Path.home(), writable_root.parent]
    for base in candidates:
        try:
            if _inside(base, writable_root):
                continue
            if base.is_dir() and os.access(base, os.W_OK | os.X_OK):
                return base
        except OSError:
            continue
    return None


def _control_write_succeeds(directory: Path, name: str) -> bool:
    """Positive control: write and remove one small file with no sandbox.

    Returns False when this account cannot write the control directory at all.
    Nothing is then concluded from the sandbox, because a directory this account
    may not write is indistinguishable from a directory the sandbox denies.
    """
    path = Path(directory) / name
    try:
        path.write_text(PROBE_CONTENT, encoding="ascii")
        path.unlink()
    except OSError:
        return False
    return True


@contextlib.contextmanager
def _loopback_listener() -> Iterator[int]:
    """Serve a bounded loopback listener and yield the port it listens on."""
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    stop = threading.Event()
    worker: threading.Thread | None = None

    def drain() -> None:
        while not stop.is_set():
            try:
                connection, _peer = listener.accept()
            except TimeoutError:
                continue
            except OSError:
                return
            connection.close()

    try:
        listener.bind((LOOPBACK_HOST, 0))
        listener.listen(4)
        listener.settimeout(0.25)
        port = int(listener.getsockname()[1])
        worker = threading.Thread(target=drain, name="archon-isolation-probe-listener", daemon=True)
        worker.start()
        yield port
    finally:
        stop.set()
        listener.close()
        if worker is not None:
            worker.join(timeout=2.0)


def _control_connect(host: str, port: int, *, timeout: float = 3.0) -> bool:
    """Positive control: connect to the loopback listener with no sandbox."""
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def probe_filesystem_confinement(writable_root: Path) -> bool:
    """Prove that a sandbox denies a write this account can make, and allows one.

    Every leg must hold, or the probe reports False:

    1. positive control - this account writes a directory that is never bound
       into the sandbox, with no sandbox at all, so a later refusal there is
       evidence about the sandbox and not about the account or the path;
    2. inside the sandbox the same write to that unbound directory fails while
       the directory itself stays visible; and
    3. inside the sandbox a write to the caller's `writable_root` succeeds.

    A host whose sandbox enforces nothing fails leg 2, and a root that the
    sandbox does not keep writable fails leg 3. The earlier probe tried `/etc`
    instead of an unbound control directory, which this account cannot write
    even without any sandbox, so an unenforcing sandbox still passed it.
    """
    if not bubblewrap_available():
        return False
    root = Path(writable_root)
    base = _control_base(root)
    if base is None:
        return False
    marker_name = f"{PROBE_MARKER}-{uuid.uuid4().hex[:12]}"
    probe_root: Path | None = None
    try:
        probe_root = Path(tempfile.mkdtemp(prefix=PROBE_PREFIX, dir=str(base)))
        os.chmod(probe_root, 0o700)
        # The control directory is deliberately absent from the sandbox argv.
        control = probe_root / CONTROL_DIRNAME
        control.mkdir(mode=0o700)
        if not _control_write_succeeds(control, CONTROL_FILENAME):
            return False
        result = _run(
            [
                *bubblewrap_argv([root]),
                "--", "python3", "-c", PROBE_SCRIPT,
                str(control), str(root), marker_name,
            ],
            timeout=FILESYSTEM_PROBE_TIMEOUT,
        )
    except OSError:
        return False
    finally:
        if probe_root is not None:
            shutil.rmtree(probe_root, ignore_errors=True)
        try:
            (root / marker_name).unlink()
        except OSError:
            pass
    if result is None or result.returncode != 0:
        return False
    marker = [line for line in result.stdout.splitlines() if line.startswith("control_visible=")]
    if not marker:
        return False
    fields = dict(item.split("=", 1) for item in marker[-1].split() if "=" in item)
    return (
        fields.get("control_visible") == "True"
        and fields.get("denied") == "True"
        and fields.get("left_behind") == "False"
        and fields.get("allowed") == "True"
    )


def probe_network_isolation() -> bool:
    """Prove that a sandboxed process cannot reach a listener this host reaches.

    The probe serves a loopback listener, proves without a sandbox that the
    listener answers, and only then requires the same connect to fail inside the
    sandbox. A host with no egress at all can no longer be mistaken for a host
    whose sandbox drops the network namespace: an unreachable control is a failed
    probe, not isolation. A sandbox that ignores `--unshare-net` connects to the
    live listener, which is also a failed probe.
    """
    if not bubblewrap_available():
        return False
    try:
        with _loopback_listener() as port:
            if not _control_connect(LOOPBACK_HOST, port):
                return False
            result = _run(
                [
                    *bubblewrap_argv([], confine_filesystem=False, isolate_network=True),
                    "--", "python3", "-c", NETWORK_PROBE_SCRIPT,
                    LOOPBACK_HOST, str(port),
                ],
                timeout=NETWORK_PROBE_TIMEOUT,
            )
    except OSError:
        return False
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
