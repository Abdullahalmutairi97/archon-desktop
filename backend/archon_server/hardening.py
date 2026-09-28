"""Keep this server process's environment out of other same-uid processes.

Linux lets any process of the same user read `/proc/<pid>/environ`, `/proc/<pid>/mem`
and the process's `cwd`/`exe` links unless the target cleared its dumpable flag.
This server holds provider credentials in its own environment, so a workspace shell
that runs as the same account can read them there even though its own child
environment is filtered.

`PR_SET_DUMPABLE=0` closes that read channel: the kernel then denies those `/proc`
reads to other same-uid processes. It is deliberately narrow.

* It does not hide the credential from a process that shares this account *and* can
  write this server's private ledger or talk to its pairing socket; those processes
  are inside the same trust boundary, which is why the broker is described as a
  capability boundary and not an OS sandbox.
* It does not make the process unkillable, does not change signals between same-uid
  processes, and does not affect `/proc/<pid>/stat`, which the runner supervisor reads
  to follow a child's process group.
* On a platform where the call is unavailable this returns False and the server keeps
  running: the caller records that the channel is not closed rather than pretending.
"""
from __future__ import annotations

import ctypes
import logging
import os
import sys

logger = logging.getLogger(__name__)

PR_SET_DUMPABLE = 4  # linux/prctl.h
PR_GET_DUMPABLE = 3


def _libc():
    return ctypes.CDLL(None, use_errno=True)


def disable_process_dumpability() -> bool:
    """Clear this process's dumpable flag. Returns True when the kernel accepted it."""
    if sys.platform != "linux":
        return False
    try:
        libc = _libc()
        result = libc.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0)
    except (OSError, AttributeError, ValueError):
        return False
    return result == 0


def ensure_process_environment_is_private() -> bool:
    """Clear the dumpable flag and say so loudly when the host refuses.

    A host or kernel that rejects the call keeps running, because refusing to start
    would be worse, but the failure must not be silent: the warning names the exact
    channel that stays open.
    """
    hardened = disable_process_dumpability()
    if not hardened:
        logger.warning(
            "process environment hardening is unavailable: /proc/%s/environ stays readable "
            "by other same-uid processes on this host",
            os.getpid(),
        )
    return hardened


def process_dumpable() -> bool | None:
    """Report this process's dumpable flag, or None when it cannot be read."""
    if sys.platform != "linux":
        return None
    try:
        libc = _libc()
        result = libc.prctl(PR_GET_DUMPABLE, 0, 0, 0, 0)
    except (OSError, AttributeError, ValueError):
        return None
    if result not in (0, 1):
        return None
    return bool(result)


def main() -> int:
    """Entry point for the operator-facing check."""
    hardened = disable_process_dumpability()
    print(f"dumpable={process_dumpable()} hardened={hardened} pid={os.getpid()}")
    return 0 if hardened else 1


if __name__ == "__main__":
    raise SystemExit(main())
