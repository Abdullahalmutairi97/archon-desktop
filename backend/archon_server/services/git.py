"""Git status, history, diffs and everyday writes for repositories under the Archon root.

Every command is an argument array run with `git -C <repo root>`. Output is read
up to a byte ceiling, so a generated or minified file cannot exhaust memory.
Diffs never carry the content of secret-bearing files, matching the file API.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
from pathlib import Path

from .files import FileService

logger = logging.getLogger(__name__)

MAX_OUTPUT_BYTES = 4_000_000
MAX_FILE_LINES = 4_000
MAX_UNTRACKED_BYTES = 1_000_000
MAX_LOG = 200
_READ_ENV = {"GIT_OPTIONAL_LOCKS": "0"}
_BASE_ENV = {"GIT_TERMINAL_PROMPT": "0", "LC_ALL": "C", "GIT_PAGER": "cat", "GIT_EDITOR": "true"}
_REF = re.compile(r"^[A-Za-z0-9._/@{}~^+-]{1,200}$")
_HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$")
_STATUS_NAMES = {"A": "added", "M": "modified", "D": "deleted", "R": "renamed", "C": "copied", "T": "type-changed", "U": "conflicted"}


class GitCommandError(RuntimeError):
    """Git refused the operation; the message is what Git said."""


class GitService:
    def __init__(self, files: FileService, git: str = "git"):
        self.files = files
        self.git = git

    # ---------- process ----------

    async def _run(self, root: Path, *args: str, timeout: float = 30, read_only: bool = True,
                   ok: tuple[int, ...] = (0,), limit: int | None = None) -> tuple[str, bool]:
        limit = limit or MAX_OUTPUT_BYTES
        env = {**os.environ, **_BASE_ENV, **(_READ_ENV if read_only else {})}
        process = await asyncio.create_subprocess_exec(
            self.git, "-C", str(root), "-c", "core.quotepath=off", "-c", "color.ui=false", *args,
            stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            env=env,
        )

        async def drain(stream, cap: int) -> tuple[bytes, bool]:
            chunks, size = [], 0
            while chunk := await stream.read(65536):
                if size + len(chunk) > cap:
                    chunks.append(chunk[: cap - size])
                    return b"".join(chunks), True
                chunks.append(chunk)
                size += len(chunk)
            return b"".join(chunks), False

        async def read() -> tuple[bytes, bool, bytes]:
            errors = asyncio.create_task(drain(process.stderr, 65536))
            out, truncated = await drain(process.stdout, limit)
            if truncated:
                process.kill()
            err, _ = await errors
            await process.wait()
            return out, truncated, err

        try:
            out, truncated, err = await asyncio.wait_for(read(), timeout)
        except TimeoutError:
            process.kill()
            await process.wait()
            raise GitCommandError(f"git {args[0]} timed out after {timeout:g}s") from None
        if not truncated and process.returncode not in ok:
            message = (err.decode(errors="replace") or out.decode(errors="replace")).strip()
            raise GitCommandError(message[:2000] or f"git {args[0]} failed")
        return out.decode(errors="replace"), truncated

    async def repo(self, path: str) -> Path:
        target = self.files.resolve(path or ".", permit_secret=True)
        if not target.exists():
            raise FileNotFoundError(path)
        folder = target if target.is_dir() else target.parent
        try:
            top, _ = await self._run(folder, "rev-parse", "--show-toplevel")
        except GitCommandError as exc:
            raise FileNotFoundError(f"{path or '.'} is not inside a Git repository") from exc
        return self.files.resolve(top.strip(), permit_secret=True)

    def _relative(self, root: Path, name: str) -> str:
        if not isinstance(name, str) or not name or "\x00" in name:
            raise ValueError("invalid file name")
        candidate = (root / name).resolve() if not Path(name).is_absolute() else Path(name).resolve()
        try:
            return str(candidate.relative_to(root)) if candidate != root else "."
        except ValueError as exc:
            raise PermissionError(f"{name} is outside the repository") from exc

    @staticmethod
    def _ref(value: str | None, label: str) -> str | None:
        if value is None or value == "":
            return None
        if not _REF.match(value) or value.startswith("-") or ".." in value.replace("...", ""):
            raise ValueError(f"invalid {label}")
        return value

    async def _has_head(self, root: Path) -> bool:
        try:
            await self._run(root, "rev-parse", "--verify", "--quiet", "HEAD")
            return True
        except GitCommandError:
            return False

    # ---------- reads ----------

    async def status(self, path: str) -> dict:
        root = await self.repo(path)
        raw, _ = await self._run(root, "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all")
        info = {"root": str(root), "relative_root": self._display(root), "branch": None, "head": None,
                "detached": False, "upstream": None, "ahead": 0, "behind": 0, "files": []}
        fields = raw.split("\x00")
        i = 0
        while i < len(fields):
            entry = fields[i]
            i += 1
            if not entry:
                continue
            if entry.startswith("# branch.oid "):
                oid = entry[13:]
                info["head"] = None if oid == "(initial)" else oid
            elif entry.startswith("# branch.head "):
                head = entry[14:]
                info["detached"] = head == "(detached)"
                info["branch"] = None if info["detached"] else head
            elif entry.startswith("# branch.upstream "):
                info["upstream"] = entry[18:]
            elif entry.startswith("# branch.ab "):
                ahead, behind = entry[12:].split(" ")
                info["ahead"], info["behind"] = abs(int(ahead)), abs(int(behind))
            elif entry[0] in "12u":
                parts = entry.split(" ", {"1": 8, "2": 9, "u": 10}[entry[0]])
                xy, name = parts[1], parts[-1]
                orig = None
                if entry[0] == "2":
                    orig = fields[i]
                    i += 1
                conflicted = entry[0] == "u"
                info["files"].append(self._file(name, orig, xy[0], xy[1], conflicted=conflicted))
            elif entry[0] == "?":
                info["files"].append(self._file(entry[2:], None, "?", "?", untracked=True))
        info["clean"] = not info["files"]
        return info

    def _display(self, root: Path) -> str:
        try:
            return str(root.relative_to(self.files.root)) or "."
        except ValueError:
            return str(root)

    def _file(self, name: str, orig: str | None, index: str, worktree: str, *,
              conflicted: bool = False, untracked: bool = False) -> dict:
        return {
            "path": name, "orig_path": orig, "index": index, "worktree": worktree,
            "staged": not untracked and not conflicted and index not in ".?",
            "unstaged": untracked or conflicted or worktree not in ".",
            "untracked": untracked, "conflicted": conflicted,
            "secret": self.files.is_secret(Path(name)),
        }

    async def log(self, path: str, ref: str | None = None, limit: int = 50, skip: int = 0) -> dict:
        root = await self.repo(path)
        ref = self._ref(ref, "ref")
        limit, skip = max(1, min(int(limit), MAX_LOG)), max(0, int(skip))
        if not await self._has_head(root):
            return {"root": str(root), "commits": []}
        args = ["log", "-z", f"--max-count={limit}", f"--skip={skip}",
                "--format=%H%x1f%h%x1f%an%x1f%aI%x1f%P%x1f%s"]
        if ref:
            args += ["--end-of-options", ref]
        raw, _ = await self._run(root, *args)
        commits = []
        for record in filter(None, raw.split("\x00")):
            full, short, author, date, parents, subject = record.strip("\n").split("\x1f", 5)
            commits.append({"hash": full, "short": short, "author": author, "date": date,
                            "parents": parents.split() if parents else [], "subject": subject})
        return {"root": str(root), "commits": commits}

    async def branches(self, path: str) -> dict:
        root = await self.repo(path)
        raw, _ = await self._run(
            root, "for-each-ref", "--format=%(refname)%1f%(refname:short)%1f%(objectname:short)%1f%(upstream:short)%1f%(HEAD)",
            "refs/heads", "refs/remotes",
        )
        local, remote, current = [], [], None
        for line in filter(None, raw.splitlines()):
            full, short, oid, upstream, head = line.split("\x1f")
            if full.endswith("/HEAD"):
                continue
            row = {"name": short, "commit": oid, "upstream": upstream or None, "current": head == "*"}
            if row["current"]:
                current = short
            (local if full.startswith("refs/heads/") else remote).append(row)
        names = {row["name"] for row in local + remote}
        default_base = None
        try:
            symbolic, _ = await self._run(root, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD")
            default_base = symbolic.strip() or None
        except GitCommandError:
            pass
        if not default_base:
            default_base = next((name for name in ("origin/main", "origin/master", "main", "master") if name in names), None)
        return {"root": str(root), "current": current, "local": local, "remote": remote, "default_base": default_base}

    async def diff(self, path: str, scope: str = "unstaged", ref: str | None = None,
                   base: str | None = None, file: str | None = None) -> dict:
        root = await self.repo(path)
        ref, base = self._ref(ref, "ref"), self._ref(base, "base")
        only = [self._relative(root, file)] if file else []
        common = ["--no-color", "--no-ext-diff", "--no-textconv", "--find-renames", "-U3"]
        if scope == "unstaged":
            args = ["diff", *common]
        elif scope == "staged":
            args = ["diff", "--cached", *common]
        elif scope == "commit":
            if not ref:
                raise ValueError("a commit is required")
            args = ["show", *common, "--format=", "--diff-merges=first-parent", "--end-of-options", ref]
        elif scope == "compare":
            if not base:
                raise ValueError("a base branch is required")
            args = ["diff", *common, "--end-of-options", f"{base}...{ref or 'HEAD'}"]
        else:
            raise ValueError("scope must be unstaged, staged, commit or compare")
        names_raw, _ = await self._run(root, *self._name_status(args), "--", *only)
        patch, truncated = await self._run(root, *args, "--", *only)
        files = self._parse(patch, self._names(names_raw))
        if scope == "unstaged":
            files += await self._untracked(root, only)
        return {"root": str(root), "scope": scope, "ref": ref, "base": base, "files": files, "truncated": truncated}

    @staticmethod
    def _name_status(args: list[str]) -> list[str]:
        at = args.index("--end-of-options") if "--end-of-options" in args else len(args)
        return [*args[:at], "--name-status", "-z", *args[at:]]

    @staticmethod
    def _names(raw: str) -> list[dict]:
        fields, rows, i = raw.split("\x00"), [], 0
        while i < len(fields):
            code = fields[i]
            if not code:
                i += 1
                continue
            letter = code[0]
            if letter in "RC":
                rows.append({"status": _STATUS_NAMES[letter], "old_path": fields[i + 1], "path": fields[i + 2]})
                i += 3
            else:
                rows.append({"status": _STATUS_NAMES.get(letter, "modified"), "old_path": fields[i + 1], "path": fields[i + 1]})
                i += 2
        return rows

    def _parse(self, patch: str, names: list[dict]) -> list[dict]:
        sections = re.split(r"(?m)^(?=diff --(?:git|cc|combined) )", patch)
        sections = [s for s in sections if s.startswith("diff --")]
        files = []
        for index, name in enumerate(names):
            section = sections[index] if index < len(sections) else ""
            files.append(self._section(section, name, cut=index >= len(sections)))
        return files

    def _section(self, section: str, name: dict, *, cut: bool = False) -> dict:
        entry = {**name, "binary": False, "additions": 0, "deletions": 0, "hunks": [],
                 "hidden": self.files.is_secret(Path(name["path"])) or self.files.is_secret(Path(name["old_path"])),
                 "truncated": cut}
        hunk, count = None, 0
        old = new = 0
        in_hunks = False
        for line in section.split("\n"):
            if not in_hunks:
                if line.startswith("Binary files ") or line == "GIT binary patch":
                    entry["binary"] = True
                if line.startswith("@@"):
                    in_hunks = True
                else:
                    continue
            if line.startswith("@@"):
                match = _HUNK.match(line)
                if not match:
                    continue
                old, new = int(match.group(1)), int(match.group(3))
                hunk = {"header": line, "old_start": old, "new_start": new, "lines": []}
                if not entry["hidden"]:
                    entry["hunks"].append(hunk)
                continue
            if hunk is None or not line or line[0] not in "+- \\":
                continue
            kind = {"+": "add", "-": "del", " ": "ctx", "\\": "meta"}[line[0]]
            if kind == "add":
                entry["additions"] += 1
            elif kind == "del":
                entry["deletions"] += 1
            if entry["hidden"]:
                continue
            count += 1
            if count > MAX_FILE_LINES:
                entry["truncated"] = True
                continue
            row = {"kind": kind, "text": line[1:], "old": None, "new": None}
            if kind in ("del", "ctx"):
                row["old"] = old
                old += 1
            if kind in ("add", "ctx"):
                row["new"] = new
                new += 1
            hunk["lines"].append(row)
        return entry

    async def _untracked(self, root: Path, only: list[str]) -> list[dict]:
        raw, _ = await self._run(root, "ls-files", "--others", "--exclude-standard", "-z", "--", *only)
        files = []
        for name in filter(None, raw.split("\x00")):
            entry = {"status": "untracked", "path": name, "old_path": name, "binary": False,
                     "additions": 0, "deletions": 0, "hunks": [], "hidden": self.files.is_secret(Path(name)),
                     "truncated": False}
            target = root / name
            try:
                data = target.read_bytes()[: MAX_UNTRACKED_BYTES + 1] if target.is_file() and not target.is_symlink() else b""
            except OSError:
                data = b""
            if b"\x00" in data[:8000]:
                entry["binary"] = True
            elif not entry["hidden"] and data:
                entry["truncated"] = len(data) > MAX_UNTRACKED_BYTES
                lines = data[:MAX_UNTRACKED_BYTES].decode(errors="replace").splitlines()
                entry["additions"] = len(lines)
                if len(lines) > MAX_FILE_LINES:
                    lines, entry["truncated"] = lines[:MAX_FILE_LINES], True
                entry["hunks"] = [{"header": f"@@ -0,0 +1,{len(lines)} @@", "old_start": 0, "new_start": 1,
                                   "lines": [{"kind": "add", "text": text, "old": None, "new": n + 1} for n, text in enumerate(lines)]}]
            files.append(entry)
        return files

    # ---------- writes ----------

    async def _paths(self, root: Path, files: list[str]) -> list[str]:
        if not files:
            raise ValueError("choose at least one file")
        return [self._relative(root, name) for name in files]

    async def stage(self, path: str, files: list[str]) -> dict:
        root = await self.repo(path)
        await self._run(root, "add", "--all", "--", *await self._paths(root, files), read_only=False)
        return await self.status(str(root))

    async def unstage(self, path: str, files: list[str]) -> dict:
        root = await self.repo(path)
        names = await self._paths(root, files)
        if await self._has_head(root):
            await self._run(root, "restore", "--staged", "--", *names, read_only=False)
        else:
            await self._run(root, "rm", "--cached", "-r", "--quiet", "--", *names, read_only=False)
        return await self.status(str(root))

    async def discard(self, path: str, files: list[str], *, confirm: bool) -> dict:
        if not confirm:
            raise PermissionError("Discarding changes requires explicit confirmation")
        root = await self.repo(path)
        names = await self._paths(root, files)
        current = {row["path"]: row for row in (await self.status(str(root)))["files"]}
        untracked = [name for name in names if current.get(name, {}).get("untracked")]
        tracked = [name for name in names if name not in untracked and name in current]
        if tracked:
            await self._run(root, "restore", "--worktree", "--", *tracked, read_only=False)
        if untracked:
            await self._run(root, "clean", "--force", "--", *untracked, read_only=False)
        logger.info("git discard in %s: %s", root, names)
        return await self.status(str(root))

    async def commit(self, path: str, message: str) -> dict:
        message = (message or "").strip()
        if not message:
            raise ValueError("a commit message is required")
        if len(message) > 10_000:
            raise ValueError("commit message is too long")
        root = await self.repo(path)
        await self._run(root, "commit", "--quiet", "--message", message, read_only=False, timeout=180)
        head, _ = await self._run(root, "log", "-1", "--format=%H%x1f%h%x1f%s")
        full, short, subject = head.strip().split("\x1f", 2)
        logger.info("git commit in %s: %s", root, short)
        return {"hash": full, "short": short, "subject": subject, "status": await self.status(str(root))}

    async def switch(self, path: str, branch: str, *, create: bool = False) -> dict:
        root = await self.repo(path)
        branch = (branch or "").strip()
        if not branch or branch.startswith("-"):
            raise ValueError("invalid branch name")
        try:
            await self._run(root, "check-ref-format", "--branch", branch)
        except GitCommandError as exc:
            raise ValueError("invalid branch name") from exc
        await self._run(root, "switch", *(["--create"] if create else []), branch, read_only=False)
        return await self.status(str(root))

    async def fetch(self, path: str) -> dict:
        root = await self.repo(path)
        await self._run(root, "fetch", "--prune", read_only=False, timeout=120)
        return await self.status(str(root))

    async def push(self, path: str, *, confirm: bool) -> dict:
        if not confirm:
            raise PermissionError("Pushing requires explicit confirmation")
        root = await self.repo(path)
        state = await self.status(str(root))
        if not state["branch"]:
            raise ValueError("switch to a branch before pushing")
        if state["upstream"]:
            await self._run(root, "push", read_only=False, timeout=180)
        else:
            await self._run(root, "push", "--set-upstream", "origin", state["branch"], read_only=False, timeout=180)
        logger.info("git push in %s: %s", root, state["branch"])
        return await self.status(str(root))
