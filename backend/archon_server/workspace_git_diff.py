"""Bounded read-only Git diffs for registered workspace text files."""
from __future__ import annotations

import difflib
import os
import selectors
import signal
import subprocess
import time
from pathlib import Path
from typing import Any

from .workspace_files import WorkspaceFileService, WorkspaceFilesError


MAX_DIFF_BYTES = 64 * 1024
MAX_DIFF_INPUT_BYTES = 64 * 1024
DIFF_TIMEOUT_SECONDS = 3.0


class WorkspaceGitDiffService:
    """Return a bounded diff for one existing, visible text file."""

    def __init__(self, file_service: WorkspaceFileService | None = None) -> None:
        self.file_service = file_service or WorkspaceFileService()

    @staticmethod
    def _environment(root: str) -> dict[str, str]:
        # Ignore machine/user configuration. Plumbing below reads object IDs
        # and blobs only, so it never invokes repository filters or diff tools.
        return {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": os.devnull,
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_COUNT": "1",
            "GIT_CONFIG_KEY_0": "core.fsmonitor",
            "GIT_CONFIG_VALUE_0": "false",
            "GIT_ATTR_NOSYSTEM": "1",
            "GIT_OPTIONAL_LOCKS": "0",
            "GIT_NO_REPLACE_OBJECTS": "1",
            "GIT_TERMINAL_PROMPT": "0",
            # Do not discover a repository above the registered workspace.
            "GIT_CEILING_DIRECTORIES": root,
        }

    @staticmethod
    def _kill_process_group(process: subprocess.Popen[bytes]) -> None:
        # Try the group even when its leader already exited: a Git subprocess
        # could have inherited stdout and remained alive in the same group.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except OSError:
            if process.poll() is None:
                try:
                    process.kill()
                except OSError:
                    pass

    @classmethod
    def _run_git(
        cls,
        root: str,
        arguments: list[str],
        output_limit: int,
        deadline: float,
    ) -> tuple[bytes, bool, int]:
        process: subprocess.Popen[bytes] | None = None
        selector: selectors.BaseSelector | None = None
        output = bytearray()
        truncated = False
        eof = False
        try:
            process = subprocess.Popen(
                ["git", *arguments],
                cwd=Path(root),
                env=cls._environment(root),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                close_fds=True,
                start_new_session=True,
            )
            assert process.stdout is not None
            os.set_blocking(process.stdout.fileno(), False)
            selector = selectors.DefaultSelector()
            selector.register(process.stdout, selectors.EVENT_READ)

            while not eof or process.poll() is None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    cls._kill_process_group(process)
                    process.wait()
                    raise WorkspaceFilesError(504, "Git diff timed out")
                events = selector.select(min(remaining, 0.05))
                if not events:
                    continue
                try:
                    chunk = os.read(process.stdout.fileno(), min(8192, output_limit + 1 - len(output)))
                except BlockingIOError:
                    continue
                if not chunk:
                    eof = True
                    selector.unregister(process.stdout)
                    continue
                available = output_limit - len(output)
                if len(chunk) > available:
                    output.extend(chunk[:available])
                    truncated = True
                    cls._kill_process_group(process)
                    process.wait()
                    break
                output.extend(chunk)

            return bytes(output), truncated, process.returncode if process is not None else -1
        except WorkspaceFilesError:
            raise
        except (OSError, subprocess.SubprocessError):
            if process is not None:
                cls._kill_process_group(process)
                process.wait()
            raise WorkspaceFilesError(503, "Workspace diff service is temporarily unavailable") from None
        finally:
            if selector is not None:
                selector.close()
            if process is not None and process.stdout is not None:
                process.stdout.close()
            if process is not None and process.poll() is None:
                cls._kill_process_group(process)
                process.wait()

    @staticmethod
    def _decode_blob(data: bytes) -> str:
        if b"\x00" in data:
            raise WorkspaceFilesError(415, "Binary files are not supported")
        try:
            return data.decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            raise WorkspaceFilesError(415, "File is not valid UTF-8 text") from None

    @staticmethod
    def _format_diff(path: str, before: str, after: str) -> bytes:
        lines = list(difflib.unified_diff(
            before.splitlines(keepends=True),
            after.splitlines(keepends=True),
            fromfile=f"a/{path}",
            tofile=f"b/{path}",
            lineterm="\n",
        ))
        if not lines:
            return b""
        return (f"diff --git a/{path} b/{path}\n" + "".join(lines)).encode("utf-8")

    def diff_text(self, root: str, path: str) -> dict[str, Any]:
        # Snapshot the safe, visible UTF-8 worktree file before starting Git.
        current = self.file_service.read_text(root, path, MAX_DIFF_INPUT_BYTES)
        if current["truncated"]:
            raise WorkspaceFilesError(413, "Workspace file is too large to diff")
        after = current["content"]

        deadline = time.monotonic() + DIFF_TIMEOUT_SECONDS
        head_output, head_truncated, head_status = self._run_git(
            root, ["rev-parse", "--verify", "HEAD"], 128, deadline,
        )
        if head_truncated or head_status != 0 or not head_output.strip():
            raise WorkspaceFilesError(409, "Tracked Git diff is unavailable for this workspace")

        # rev-parse treats HEAD:path as a tree lookup, not a pathspec. A file
        # absent from HEAD (for example, an untracked file) has no tracked diff.
        blob_output, blob_oid_truncated, blob_oid_status = self._run_git(
            root, ["rev-parse", "--verify", f"HEAD:{path}"], 128, deadline,
        )
        if blob_oid_status != 0 and not blob_oid_truncated:
            return {"path": path, "diff": "", "truncated": False}
        if blob_oid_truncated:
            raise WorkspaceFilesError(409, "Tracked Git diff is unavailable for this workspace")
        blob_oid = blob_output.strip().decode("ascii", errors="ignore")
        if not blob_oid or any(character not in "0123456789abcdefABCDEF" for character in blob_oid):
            raise WorkspaceFilesError(409, "Tracked Git diff is unavailable for this workspace")

        before_output, before_truncated, before_status = self._run_git(
            root, ["cat-file", "blob", blob_oid], MAX_DIFF_INPUT_BYTES, deadline,
        )
        if before_truncated:
            raise WorkspaceFilesError(413, "Tracked file is too large to diff")
        if before_status != 0:
            raise WorkspaceFilesError(409, "Tracked Git diff is unavailable for this workspace")
        before = self._decode_blob(before_output)

        diff_bytes = self._format_diff(path, before, after)
        truncated = len(diff_bytes) > MAX_DIFF_BYTES
        bounded = diff_bytes[:MAX_DIFF_BYTES]
        # Dropping an incomplete final code point keeps the UTF-8 response at
        # or below the byte cap expected by the desktop bridge.
        diff = bounded.decode("utf-8", errors="ignore" if truncated else "strict")
        return {"path": path, "diff": diff, "truncated": truncated}
