"""Shared bubblewrap confinement helpers.

Two callers need the same mechanics: a workspace service confined to its
checkout, and a runtime child process. Both need the host filesystem read-only,
a bounded set of writable directories, an optional private network namespace,
and a behavioural probe that proves the confinement is real before anything is
launched. An accepted-but-ignored option is worse than no option, so the probe
runs a real test inside a real sandbox on every host it is used on, next to a
positive control that proves the same action works with no sandbox at all.

A read-only view of the host is not enough on its own. A read-only mount stops
writes to files, not IPC: `connect()` on a unix socket needs no write access to
the mount it lives on, so every socket that stays visible stays reachable. On a
normal desktop that includes the user's session bus (`systemd-run --user`
starts a process outside any mount namespace), the docker and libvirt sockets
(root-equivalent for their groups), tmux and runtime daemons in `/tmp`, and
editor or IDE sockets under the home directory. A process that daemonizes also
outlives the sandbox's command unless the sandbox owns its PID namespace. The
confined view therefore also replaces `/run`, `/tmp`, `/var/tmp`, `/dev` and the
account's home directory with private, empty, discarded directories, runs in its
own PID namespace, and re-exposes read-only only what the confined program
needs to start.
"""
from __future__ import annotations

import contextlib
import json
import os
import pwd
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Iterator, Sequence

# The probe scripts are minimal stdlib-only programs, because they run inside the
# sandbox where only `python3` and its standard library are guaranteed. Each one
# prints a single key=value line that the caller parses literally: missing keys or
# unreadable output are doubt, and doubt makes a probe fail closed.
PROBE_CONTENT = "x"
PROBE_MARKER = ".archon-isolation-probe"
PROBE_PREFIX = "archon-isolation-probe-"
IPC_PREFIX = "archon-isolation-ipc-"
CONTROL_DIRNAME = "unbound"
CONTROL_FILENAME = "control"
EXPOSED_DIRNAME = "exposed"
WRITABLE_DIRNAME = "writable"
HOME_DIRNAME = "home"
HOME_FILENAME = "seed"
LOOPBACK_HOST = "127.0.0.1"
FILESYSTEM_PROBE_TIMEOUT = 30.0
NETWORK_PROBE_TIMEOUT = 15.0
# How long the kernel gets to tear down the sandbox's PID namespace before a
# process the probe detached inside it counts as a survivor.
SURVIVOR_GRACE_SECONDS = 2.0
# Resolution of the executable chain stops here; a longer chain is refused.
MAX_LINK_HOPS = 16
MAX_INTERPRETER_DEPTH = 4

# Host directories every confined view replaces with a private, empty tmpfs.
# `/var/run` is a symlink to `/run` on current systems and is masked with it; a
# host where it is a real directory gets it masked separately.
MASKED_SYSTEM_ROOTS = (Path("/run"), Path("/tmp"), Path("/var/tmp"))
# Name resolution goes through systemd-resolved where `/etc/resolv.conf` points
# into `/run`; only that directory is re-exposed so names still resolve on a
# shared network. Its sockets answer name lookups and nothing else.
RESOLVER_DIRS = (Path("/run/systemd/resolve"),)

# `control_visible` proves the unbound directory is really there inside the
# sandbox, so a refused write is a refusal and not a missing path. `left_behind`
# re-checks the same directory after the attempt, and `allowed` is the second
# sandboxed leg: every declared writable root must still accept a write.
# `reached` counts host unix sockets placed in masked locations that the sandbox
# could still connect to, and the detached sleeper is the survivor the caller
# looks for after the sandbox exits.
PROBE_SCRIPT = (
    "import json, pathlib, socket, subprocess, sys\n"
    "spec = json.loads(sys.argv[1])\n"
    "control_dir = pathlib.Path(spec['control'])\n"
    "control_visible = control_dir.is_dir()\n"
    "denied = False\n"
    "error_number = 0\n"
    "try:\n"
    f"    (control_dir / '{CONTROL_FILENAME}').write_text('{PROBE_CONTENT}')\n"
    "except OSError as failure:\n"
    "    denied = True\n"
    "    error_number = failure.errno or 0\n"
    f"left_behind = (control_dir / '{CONTROL_FILENAME}').exists()\n"
    "allowed = True\n"
    "for root in spec['writable']:\n"
    "    try:\n"
    "        marker = pathlib.Path(root) / spec['marker']\n"
    f"        marker.write_text('{PROBE_CONTENT}')\n"
    "        marker.unlink()\n"
    "    except OSError:\n"
    "        allowed = False\n"
    "home_written = False\n"
    "if spec['home_file']:\n"
    "    try:\n"
    "        pathlib.Path(spec['home_file']).write_text(spec['marker'])\n"
    "        home_written = True\n"
    "    except OSError:\n"
    "        home_written = False\n"
    "reached = 0\n"
    "for path in spec['sockets']:\n"
    "    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)\n"
    "    client.settimeout(2)\n"
    "    try:\n"
    "        client.connect(path)\n"
    "        reached += 1\n"
    "    except OSError:\n"
    "        pass\n"
    "    finally:\n"
    "        client.close()\n"
    "subprocess.Popen(\n"
    "    [sys.executable, '-c', 'import time; time.sleep(30)', spec['token']],\n"
    "    start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,\n"
    "    stderr=subprocess.DEVNULL, close_fds=True,\n"
    ")\n"
    "print('control_visible=%s denied=%s left_behind=%s allowed=%s errno=%d home_written=%s reached=%d' % (\n"
    "    control_visible, denied, left_behind, allowed, error_number, home_written, reached))\n"
)

# The network probe connects to a listener this process serves on loopback, so a
# successful connect is a served connection rather than a stale backlog entry.
NETWORK_PROBE_SCRIPT = (
    "import socket, sys\n"
    "s = socket.socket(); s.settimeout(3)\n"
    "code = s.connect_ex((sys.argv[1], int(sys.argv[2])))\n"
    "print('connect=%d' % code)\n"
)


@dataclass(frozen=True)
class SandboxView:
    """What a confined process sees of the host besides its writable roots.

    Layers apply in this order: `masked_roots` become private empty
    directories, `symlinks` recreate an executable's link chain inside them,
    `readable_paths` are bound back read-only, and `private_homes` show a
    runtime's own configuration with every write going to a discarded layer.
    Writable roots are bound last, so they stay writable wherever they live.
    """

    masked_roots: tuple[Path, ...] = ()
    symlinks: tuple[tuple[str, Path], ...] = ()
    readable_paths: tuple[Path, ...] = ()
    private_homes: tuple[Path, ...] = ()


def bubblewrap_available() -> bool:
    """Report whether the sandbox binary and a Python interpreter are present."""
    return shutil.which("bwrap") is not None and shutil.which("python3") is not None


def account_homes() -> tuple[Path, ...]:
    """Return the account's home directory, plus `$HOME` when it differs."""
    homes: list[Path] = []
    candidates = [pwd.getpwuid(os.getuid()).pw_dir, os.environ.get("HOME")]
    for candidate in candidates:
        if not candidate:
            continue
        home = Path(os.path.abspath(candidate))
        if home != Path("/") and home not in homes:
            homes.append(home)
    return tuple(homes)


def masked_system_roots() -> tuple[Path, ...]:
    """Return the host directories every confined view hides."""
    roots = list(MASKED_SYSTEM_ROOTS)
    legacy_run = Path("/var/run")
    if legacy_run.is_dir() and not legacy_run.is_symlink():
        roots.append(legacy_run)
    return tuple(roots)


def _private_runtime_dir() -> str | None:
    """Return the account's runtime directory when it lives in masked `/run`."""
    runtime_dir = os.environ.get("XDG_RUNTIME_DIR", "")
    if runtime_dir.startswith("/run/") and os.path.isabs(runtime_dir):
        return runtime_dir
    return None


def bubblewrap_argv(
    writable_roots: Sequence[Path],
    *,
    confine_filesystem: bool = True,
    isolate_network: bool = False,
    view: SandboxView | None = None,
) -> list[str]:
    """Build a sandbox command prefix for the given writable directories.

    With `confine_filesystem` the whole host is bound read-only, the IPC and
    scratch locations in `masked_system_roots()` plus the view's masked roots
    are private and empty, and only the listed directories are writable.
    Without it the filesystem is left alone, which is only useful together with
    `isolate_network`. Either way the sandbox owns its PID namespace, so no
    process started inside it outlives the confined command.
    """
    argv = ["bwrap", "--die-with-parent", "--unshare-pid"]
    if confine_filesystem:
        view = view or SandboxView()
        argv += ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"]
        for root in masked_system_roots():
            argv += ["--tmpfs", str(root)]
        for directory in RESOLVER_DIRS:
            if directory.is_dir():
                argv += ["--ro-bind", str(directory), str(directory)]
        runtime_dir = _private_runtime_dir()
        if runtime_dir is not None:
            # An empty private runtime directory: programs that expect one can
            # create their own sockets there, and none of the host's are visible.
            argv += ["--dir", runtime_dir]
        for root in view.masked_roots:
            argv += ["--tmpfs", str(root)]
        for target, link in view.symlinks:
            argv += ["--symlink", target, str(link)]
        for path in view.readable_paths:
            if os.path.lexists(path):
                argv += ["--ro-bind", str(path), str(path)]
        for home in view.private_homes:
            if Path(home).is_dir():
                argv += ["--overlay-src", str(home), "--tmp-overlay", str(home)]
        for root in writable_roots:
            argv += ["--bind", str(root), str(root)]
    else:
        argv += ["--bind", "/", "/", "--dev-bind", "/dev", "/dev", "--proc", "/proc"]
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


def _hidden(path: Path, masked: Sequence[Path]) -> bool:
    return any(_inside(path, root) for root in masked)


def _link_chain(path: Path) -> tuple[list[tuple[str, Path]], Path]:
    """Follow `path` through its symlinks, returning each link and the final file."""
    links: list[tuple[str, Path]] = []
    current = Path(os.path.abspath(path))
    for _hop in range(MAX_LINK_HOPS):
        if not current.is_symlink():
            return links, current
        target = os.readlink(current)
        links.append((target, current))
        current = Path(os.path.normpath(current.parent / target))
    raise ValueError(f"{path} has more than {MAX_LINK_HOPS} symbolic links")


def _install_root(target: Path) -> Path:
    """Return the directory a program needs besides its own file.

    A program inside a Node package needs the whole package (its modules and
    dependencies sit beside it); anything else is given its own directory.
    """
    parts = target.parts
    if "node_modules" in parts[:-1]:
        index = len(parts) - 1 - parts[::-1].index("node_modules")
        width = 3 if index + 1 < len(parts) and parts[index + 1].startswith("@") else 2
        if index + width <= len(parts) - 1:
            return Path(*parts[: index + width])
    return target.parent


def _interpreter(target: Path) -> str | None:
    """Return the interpreter a script names on its `#!` line, if any."""
    try:
        with target.open("rb") as handle:
            head = handle.readline(512)
    except OSError:
        return None
    if not head.startswith(b"#!"):
        return None
    words = head[2:].decode("utf-8", errors="replace").split()
    if not words:
        return None
    if Path(words[0]).name == "env":
        rest = [word for word in words[1:] if not word.startswith("-")]
        return rest[0] if rest else None
    return words[0]


def program_view(
    program: str,
    *,
    search_path: str | None = None,
    cwd: Path | None = None,
    masked: Sequence[Path] = (),
) -> tuple[tuple[tuple[str, Path], ...], tuple[Path, ...]]:
    """Return what must be re-exposed to start `program` inside a masked view.

    The program is resolved like `execvp` would (bare names on `search_path`,
    relative paths against `cwd`), followed through its symlinks and then
    through its `#!` interpreter. Links that live in a masked location are
    recreated, and each file that lives in one gets its install root bound back
    read-only. A root that would re-expose a whole masked location is narrowed
    to the file itself. Nothing outside the masked locations is touched.
    """
    symlinks: list[tuple[str, Path]] = []
    readable: list[Path] = []
    pending = [program]
    seen: set[Path] = set()
    while pending and len(seen) < MAX_INTERPRETER_DEPTH:
        name = pending.pop()
        if "/" in name:
            candidate = Path(name) if os.path.isabs(name) else Path(cwd or Path.cwd()) / name
        else:
            found = shutil.which(name, path=search_path)
            if found is None:
                continue
            candidate = Path(found)
        candidate = Path(os.path.abspath(candidate))
        if candidate in seen:
            continue
        seen.add(candidate)
        links, target = _link_chain(candidate)
        for link_target, link in links:
            if _hidden(link, masked) and (link_target, link) not in symlinks:
                symlinks.append((link_target, link))
        if _hidden(target, masked):
            root = _install_root(target)
            if any(_inside(mask, root) for mask in masked):
                root = target
            if root not in readable:
                readable.append(root)
        interpreter = _interpreter(target)
        if interpreter:
            pending.append(interpreter)
    return tuple(symlinks), tuple(readable)


def workspace_view(
    program: str,
    *,
    search_path: str | None = None,
    cwd: Path | None = None,
    readable_paths: Iterable[Path] = (),
    private_homes: Iterable[Path] = (),
) -> SandboxView:
    """Mask the account's home and re-expose only what `program` needs to start."""
    homes = account_homes()
    masked = (*masked_system_roots(), *homes)
    symlinks, needed = program_view(program, search_path=search_path, cwd=cwd, masked=masked)
    extra = [Path(os.path.abspath(path)) for path in readable_paths]
    return SandboxView(
        masked_roots=homes,
        symlinks=symlinks,
        readable_paths=tuple(dict.fromkeys([*needed, *extra])),
        private_homes=tuple(Path(os.path.abspath(home)) for home in private_homes),
    )


def _control_base(writable_root: Path | None) -> Path | None:
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
    candidates.append(Path.home())
    if writable_root is not None:
        candidates.append(writable_root.parent)
    for base in candidates:
        try:
            if writable_root is not None and _inside(base, writable_root):
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


def _ipc_locations() -> list[Path]:
    """Return masked locations where host sockets live and the probe can listen.

    `/tmp` holds tmux, X11 and runtime daemon sockets; the runtime directory in
    `/run` holds the session bus that `systemd-run --user` uses.
    """
    locations: list[Path] = []
    runtime_dir = _private_runtime_dir()
    for candidate in [Path("/tmp"), *([Path(runtime_dir)] if runtime_dir else [])]:
        try:
            if candidate.is_dir() and os.access(candidate, os.W_OK | os.X_OK):
                locations.append(candidate)
        except OSError:
            continue
    return locations


@contextlib.contextmanager
def _unix_listeners(locations: Sequence[Path]) -> Iterator[list[str]]:
    """Serve one unix socket in a private directory under each location.

    Yields the socket paths that this process could itself connect to; a
    listener that fails its own positive control is left out.
    """
    directories: list[Path] = []
    listeners: list[socket.socket] = []
    paths: list[str] = []
    try:
        for location in locations:
            try:
                directory = Path(tempfile.mkdtemp(prefix=IPC_PREFIX, dir=str(location)))
            except OSError:
                continue
            directories.append(directory)
            path = str(directory / "s")
            listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            listeners.append(listener)
            try:
                listener.bind(path)
                listener.listen(4)
            except OSError:
                continue
            client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            client.settimeout(2)
            try:
                client.connect(path)
            except OSError:
                continue
            finally:
                client.close()
            paths.append(path)
        yield paths
    finally:
        for listener in listeners:
            listener.close()
        for directory in directories:
            shutil.rmtree(directory, ignore_errors=True)


def _survivors(token: str) -> list[int]:
    """Return the PIDs whose command line carries the probe's survivor token."""
    needle = token.encode()
    found: list[int] = []
    try:
        entries = list(Path("/proc").iterdir())
    except OSError:
        return found
    for entry in entries:
        if not entry.name.isdigit():
            continue
        try:
            if needle in (entry / "cmdline").read_bytes():
                found.append(int(entry.name))
        except OSError:
            continue
    return found


def _reap_survivors(token: str) -> bool:
    """Wait for the survivor to vanish; kill it and report True if it did not."""
    deadline = time.monotonic() + SURVIVOR_GRACE_SECONDS
    while True:
        pids = _survivors(token)
        if not pids:
            return False
        if time.monotonic() >= deadline:
            for pid in pids:
                with contextlib.suppress(OSError):
                    os.kill(pid, 9)
            return True
        time.sleep(0.05)


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


def probe_filesystem_confinement(writable_root: Path | None = None, *, private_homes: bool = False) -> bool:
    """Prove that the confined view denies what it claims to deny, and allows the rest.

    Every leg must hold, or the probe reports False:

    1. positive control - this account writes a directory with no sandbox, so a
       later refusal there is evidence about the sandbox and not about the
       account or the path;
    2. inside the sandbox the same write fails while the directory stays
       visible (it is bound read-only the way re-exposed install trees are);
    3. inside the sandbox a write to every writable root succeeds, including
       the caller's `writable_root` when one is given;
    4. host unix sockets served in the masked `/tmp` and runtime directory -
       where tmux, runtime daemons and the session bus live - accept a
       connection with no sandbox and refuse it inside;
    5. a process detached inside the sandbox does not outlive it; and
    6. with `private_homes`, a write to a runtime's own configuration succeeds
       inside and leaves the host copy unchanged.

    A host whose sandbox enforces nothing fails leg 2, one that does not keep a
    root writable fails leg 3, a view that leaves host IPC reachable fails leg 4
    and one without a PID namespace fails leg 5. Any host where no masked
    location can hold a probe socket fails closed, because leg 4 would prove
    nothing there.
    """
    if not bubblewrap_available():
        return False
    root = Path(writable_root) if writable_root is not None else None
    base = _control_base(root)
    if base is None:
        return False
    marker_name = f"{PROBE_MARKER}-{uuid.uuid4().hex[:12]}"
    token = f"{PROBE_PREFIX}survivor-{uuid.uuid4().hex}"
    probe_root: Path | None = None
    home_seed = "original"
    home_file: Path | None = None
    survived = False
    try:
        probe_root = Path(tempfile.mkdtemp(prefix=PROBE_PREFIX, dir=str(base)))
        os.chmod(probe_root, 0o700)
        exposed = probe_root / EXPOSED_DIRNAME
        control = exposed / CONTROL_DIRNAME
        writable = exposed / WRITABLE_DIRNAME
        for directory in (exposed, control, writable):
            directory.mkdir(mode=0o700)
        if not _control_write_succeeds(control, CONTROL_FILENAME):
            return False
        homes: tuple[Path, ...] = ()
        if private_homes:
            home = probe_root / HOME_DIRNAME
            home.mkdir(mode=0o700)
            home_file = home / HOME_FILENAME
            home_file.write_text(home_seed, encoding="ascii")
            homes = (home,)
        locations = [
            location for location in _ipc_locations()
            if root is None or not _inside(location, root)
        ]
        with _unix_listeners(locations) as sockets:
            if not sockets:
                return False
            roots = [writable, *([root] if root is not None else [])]
            spec = {
                "control": str(control),
                "writable": [str(item) for item in roots],
                "marker": marker_name,
                "home_file": str(home_file) if home_file is not None else "",
                "sockets": sockets,
                "token": token,
            }
            view = SandboxView(readable_paths=(exposed,), private_homes=homes)
            result = _run(
                [
                    *bubblewrap_argv(roots, view=view),
                    "--", "python3", "-c", PROBE_SCRIPT, json.dumps(spec),
                ],
                timeout=FILESYSTEM_PROBE_TIMEOUT,
            )
        survived = _reap_survivors(token)
        home_intact = home_file is None or home_file.read_text(encoding="ascii") == home_seed
    except OSError:
        return False
    finally:
        if probe_root is not None:
            shutil.rmtree(probe_root, ignore_errors=True)
        if root is not None:
            try:
                (root / marker_name).unlink()
            except OSError:
                pass
    if result is None or result.returncode != 0 or survived or not home_intact:
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
        and fields.get("reached") == "0"
        and (not private_homes or fields.get("home_written") == "True")
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
    *,
    argv: Sequence[str],
    cwd: Path,
    writable_roots: Iterable[Path],
    isolate_network: bool = False,
    view: SandboxView | None = None,
) -> list[str]:
    """Wrap one command so it runs inside the sandbox with `cwd` writable.

    A writable root that is, or contains, a location the view hides would hand
    that whole location back writable - every socket and file in it - so it is
    refused with ValueError rather than silently weakening the view.
    """
    view = view or SandboxView()
    roots: list[Path] = []
    for root in [cwd, *writable_roots]:
        resolved = Path(os.path.abspath(root))
        if resolved not in roots:
            roots.append(resolved)
    hidden = (*masked_system_roots(), *view.masked_roots)
    for resolved in roots:
        if resolved == Path("/") or any(_inside(mask, resolved) for mask in hidden):
            raise ValueError(f"{resolved} would expose a masked location writable")
    return [
        *bubblewrap_argv(roots, confine_filesystem=True, isolate_network=isolate_network, view=view),
        "--chdir", str(cwd),
        "--", *argv,
    ]


class RuntimeConfinementUnavailable(RuntimeError):
    """The requested runtime confinement is not enforced on this host."""


def _probe_runtime_view(writable_root: Path | None = None) -> bool:
    return probe_filesystem_confinement(writable_root, private_homes=True)


class RuntimeConfinement:
    """Opt-in confinement for a runtime child process.

    The profile is off by default: enabling it changes how the runtime is
    launched, and runtime compatibility inside the sandbox is only qualified by a
    real provider turn, which this module does not attempt. The probe proves the
    confinement mechanics (host read-only, declared directories writable, host
    IPC hidden, no survivors, private configuration layer) before any run
    starts, and a host without them refuses the run instead of launching
    unconfined.

    The runtime sees its own install tree and interpreter, its own native home
    through a discarded write layer (so it can take its lock files without
    being able to rewrite its settings or credentials), the declared writable
    roots and nothing else of the account's home directory.
    """

    PROFILE_NONE = "none"
    PROFILE_WORKSPACE_ONLY = "workspace-only"
    PROFILES = (PROFILE_NONE, PROFILE_WORKSPACE_ONLY)

    def __init__(
        self,
        profile: str = PROFILE_NONE,
        *,
        prober=_probe_runtime_view,
        readable_paths: Iterable[Path] = (),
    ):
        if profile not in self.PROFILES:
            raise ValueError("runtime isolation profile must be 'none' or 'workspace-only'")
        self.profile = profile
        self._prober = prober
        self._available: bool | None = None
        # Extra host paths a runtime needs read-only (for example a package it
        # loads from outside its own install tree); configured by the operator.
        self.readable_paths = tuple(Path(path) for path in readable_paths)

    @property
    def enabled(self) -> bool:
        return self.profile != self.PROFILE_NONE

    def ensure_available(self) -> None:
        """Fail closed when a requested profile is not enforced on this host."""
        if not self.enabled:
            return
        if self._available is None:
            try:
                self._available = bool(self._prober(None))
            except Exception:
                self._available = False
        if not self._available:
            raise RuntimeConfinementUnavailable(
                "Runtime isolation is unavailable on this host; the run was not started"
            )

    def command(
        self,
        *,
        argv: Sequence[str],
        cwd: Path,
        writable_roots: Iterable[Path],
        private_homes: Iterable[Path] = (),
        search_path: str | None = None,
    ) -> list[str]:
        """Return the command for one runtime invocation.

        With the profile disabled this returns the argv unchanged, because no
        confinement was requested. With it enabled, the command is confined or
        the run is refused.
        """
        if not self.enabled:
            return list(argv)
        self.ensure_available()
        try:
            view = workspace_view(
                str(argv[0]), search_path=search_path, cwd=cwd,
                readable_paths=self.readable_paths, private_homes=private_homes,
            )
            return confined_command(argv=argv, cwd=cwd, writable_roots=writable_roots, view=view)
        except ValueError as exc:
            raise RuntimeConfinementUnavailable(
                f"Runtime isolation cannot confine this run ({exc}); the run was not started"
            ) from exc
