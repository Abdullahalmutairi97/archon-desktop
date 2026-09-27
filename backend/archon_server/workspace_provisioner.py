"""Provision independent, revision-pinned Git checkouts for registered projects.

This creates a separate working copy. It does not provide OS-level process or
filesystem isolation for code later run inside that workspace.
"""
from __future__ import annotations

import hashlib
import os
import re
import shutil
import signal
import stat
import subprocess
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .db import Database
from .services.workspace import ProjectService


_WORKSPACE_ID = re.compile(r"workspace-[0-9a-f]{32}\Z")
_OBJECT_ID = re.compile(r"[0-9a-fA-F]+\Z")
_CONFIG_KEY = re.compile(r"[a-z][a-z0-9.-]*(?:\.[a-z0-9-]+)*\Z")
_MAX_CONFIG_BYTES = 64 * 1024

_SAFE_CORE_CONFIG = frozenset({
    "core.repositoryformatversion",
    "core.filemode",
    "core.bare",
    "core.logallrefupdates",
    "core.ignorecase",
    "core.precomposeunicode",
    "core.symlinks",
})


@dataclass(frozen=True)
class _SourceIdentity:
    path: Path
    device: int
    inode: int
    git_directory_device: int
    git_directory_inode: int
    config_device: int
    config_inode: int
    config_size: int
    config_mtime_ns: int
    config_digest: str


@dataclass(frozen=True)
class _DirectoryIdentity:
    path: Path
    device: int
    inode: int


class WorkspaceCheckoutProvisioner:
    """Create one independent checkout from an active registered project.

    `projects` is the server-side project registry. The public operation only
    accepts a project ID and immutable commit object ID; it never accepts a
    renderer-provided checkout path or cwd.
    """

    def __init__(
        self,
        *,
        database: Database,
        projects: ProjectService,
        workspace_root: str | os.PathLike[str],
        owner_id: str,
        isolation_profile: str,
        timeout_seconds: float = 30.0,
        prepare_workspace_root: bool = True,
    ):
        self.database = database
        self.projects = projects
        self.owner_id = _identity_text(owner_id, "owner_id")
        self.isolation_profile = _identity_text(isolation_profile, "isolation_profile")
        if (isinstance(timeout_seconds, bool) or not isinstance(timeout_seconds, (int, float))
                or timeout_seconds <= 0 or timeout_seconds > 300):
            raise ValueError("timeout_seconds must be positive and at most 300")
        self.timeout_seconds = float(timeout_seconds)

        candidate = Path(workspace_root)
        if not candidate.is_absolute():
            raise ValueError("workspace_root must be an absolute server-owned path")
        if prepare_workspace_root:
            self.workspace_root, self._workspace_root_identity = _prepare_private_root(candidate)
        else:
            self.workspace_root = Path(os.path.abspath(candidate))
            self._workspace_root_identity = None

        git = shutil.which("git")
        if git is None:
            raise RuntimeError("Git is required to provision a workspace")
        self.git_executable = str(Path(git).resolve(strict=True))
        self._git_environment = {
            "HOME": str(self.workspace_root),
            "PATH": str(Path(self.git_executable).parent),
            "LC_ALL": "C",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_ASKPASS": os.devnull,
            "GIT_OPTIONAL_LOCKS": "0",
            "GIT_NO_REPLACE_OBJECTS": "1",
            "GIT_TEMPLATE_DIR": os.devnull,
        }

    def provision(self, *, project_id: str, revision: str, generation: int) -> dict[str, Any]:
        """Create and register a clean detached checkout at one full commit ID."""
        project_id = _identity_text(project_id, "project_id")
        if isinstance(generation, bool) or not isinstance(generation, int) or generation < 1:
            raise ValueError("generation must be a positive integer")
        if self._workspace_root_identity is None:
            self.workspace_root, self._workspace_root_identity = _prepare_private_root(self.workspace_root)
        self._assert_workspace_root()

        project = self._registered_project(project_id)
        source = self._registered_source_path(project)
        if (self.workspace_root == source or self.workspace_root.is_relative_to(source)
                or source.is_relative_to(self.workspace_root)):
            raise ValueError("workspace root and registered source must not overlap")
        source_identity = self._inspect_source(source)
        self._assert_source_identity(source_identity)
        if self._repo_output(source, ["rev-parse", "--show-toplevel"]) != str(source):
            raise ValueError("registered project path is not the Git checkout root")
        if self._repo_output(source, ["rev-parse", "--is-bare-repository"]) != "false":
            raise ValueError("bare repositories cannot be provisioned as workspaces")
        object_format = self._repo_output(source, ["rev-parse", "--show-object-format"])
        object_id_length = {"sha1": 40, "sha256": 64}.get(object_format)
        if object_id_length is None:
            raise ValueError("source Git object format is unsupported")
        if (not isinstance(revision, str) or len(revision) != object_id_length
                or not _OBJECT_ID.fullmatch(revision)):
            raise ValueError("revision must be a full immutable Git commit object ID")
        commit_oid = self._repo_output(
            source, ["rev-parse", "--verify", "--quiet", "--end-of-options", f"{revision}^{{commit}}"],
        ).lower()
        if commit_oid != revision.lower():
            raise ValueError("revision does not identify the requested full commit")
        self._assert_source_identity(source_identity)

        workspace_id = "workspace-" + uuid.uuid4().hex
        if not _WORKSPACE_ID.fullmatch(workspace_id):
            raise RuntimeError("Generated workspace ID is invalid")
        destination = self.workspace_root / workspace_id
        # mkdir is intentionally exclusive: an existing directory or symlink
        # is never reused, followed, or removed.
        os.mkdir(destination, 0o700)
        os.chmod(destination, 0o700, follow_symlinks=False)
        destination_identity = self._capture_directory(destination, "new checkout")
        persisted = False
        try:
            self._assert_workspace_root()
            self._assert_source_identity(source_identity)
            self._repo_git(
                destination,
                ["init", "--quiet", "--template=/dev/null", f"--object-format={object_format}"],
            )
            self._assert_checkout_identity(destination_identity)
            self._assert_source_identity(source_identity)
            self._repo_git(
                destination,
                ["-c", "protocol.file.allow=always", "fetch", "--no-tags", "--no-recurse-submodules",
                 "--no-write-fetch-head", "--quiet", str(source), commit_oid],
            )
            self._assert_checkout_identity(destination_identity)
            self._assert_source_identity(source_identity)
            self._repo_git(
                destination,
                ["checkout", "--quiet", "--detach", "--force", commit_oid],
            )
            self._assert_checkout_identity(destination_identity)
            self._assert_no_checkout_symlinks(destination_identity)
            checked_out_oid = self._repo_output(destination, ["rev-parse", "--verify", "HEAD^{commit}"]).lower()
            if checked_out_oid != commit_oid:
                raise RuntimeError("Git checkout did not produce the verified commit")
            self._assert_source_identity(source_identity)
            if self._registered_source_path(self._registered_project(project_id)) != source:
                raise RuntimeError("registered project source changed during checkout")

            workspace = self.database.create_workspace(
                workspace_id=workspace_id,
                root=str(destination),
                owner_id=self.owner_id,
                project_id=project_id,
                generation=generation,
                isolation_profile=self.isolation_profile,
                base_revision=commit_oid,
                head_revision=commit_oid,
            )
            persisted = True
            return workspace
        finally:
            if not persisted:
                self._remove_created_checkout(destination_identity)

    def head_revision(self, *, project_id: str) -> str:
        """Return the current full commit ID for one safe registered Git source."""
        project_id = _identity_text(project_id, "project_id")
        project = self._registered_project(project_id)
        source = self._registered_source_path(project)
        source_identity = self._inspect_source(source)
        self._assert_source_identity(source_identity)
        if self._repo_output(source, ["rev-parse", "--show-toplevel"]) != str(source):
            raise ValueError("registered project path is not the Git checkout root")
        if self._repo_output(source, ["rev-parse", "--is-bare-repository"]) != "false":
            raise ValueError("bare repositories cannot be used as project sources")
        object_format = self._repo_output(source, ["rev-parse", "--show-object-format"])
        object_id_length = {"sha1": 40, "sha256": 64}.get(object_format)
        if object_id_length is None:
            raise ValueError("source Git object format is unsupported")
        revision = self._repo_output(
            source, ["rev-parse", "--verify", "--quiet", "--end-of-options", "HEAD^{commit}"],
        ).lower()
        if not re.fullmatch(rf"[0-9a-f]{{{object_id_length}}}", revision):
            raise RuntimeError("Git returned an invalid full commit object ID")
        self._assert_source_identity(source_identity)
        if self._registered_source_path(self._registered_project(project_id)) != source:
            raise RuntimeError("registered project source changed while reading HEAD")
        return revision

    def _registered_project(self, project_id: str) -> dict[str, Any]:
        projects = self.projects.list()
        if not isinstance(projects, list):
            raise ValueError("registered project catalog is unavailable")
        matches = [project for project in projects
                   if isinstance(project, dict) and project.get("id") == project_id]
        if len(matches) != 1:
            raise ValueError("registered project is missing or ambiguous")
        selected = matches[0]
        primary = selected.get("primary_path")
        if not isinstance(primary, str) or not primary:
            raise ValueError("registered project source is ambiguous")
        for project in projects:
            if not isinstance(project, dict) or project.get("id") == project_id:
                continue
            registered_roots = [project.get("primary_path")]
            folders = project.get("folders", [])
            if not isinstance(folders, list):
                raise ValueError("registered project catalog is ambiguous")
            registered_roots.extend(
                folder.get("path") for folder in folders if isinstance(folder, dict)
            )
            for registered_root in registered_roots:
                if not isinstance(registered_root, str) or not registered_root:
                    continue
                candidate = Path(registered_root)
                if not candidate.is_absolute():
                    raise ValueError("registered project catalog is ambiguous")
                try:
                    canonical_candidate = candidate.resolve(strict=False)
                except (OSError, RuntimeError) as exc:
                    raise ValueError("registered project catalog is ambiguous") from exc
                if str(canonical_candidate) == primary:
                    raise ValueError("registered project source is ambiguous")
        return selected

    @staticmethod
    def _registered_source_path(project: dict[str, Any]) -> Path:
        primary = project.get("primary_path")
        folders = project.get("folders")
        if not isinstance(primary, str) or not isinstance(folders, list):
            raise ValueError("registered project source is ambiguous")
        primary_folders = [folder for folder in folders
                           if isinstance(folder, dict) and folder.get("is_primary") is True]
        if len(primary_folders) != 1 or primary_folders[0].get("path") != primary:
            raise ValueError("registered project source is ambiguous")
        path = Path(primary)
        if not path.is_absolute():
            raise ValueError("registered project source must be absolute")
        _assert_no_symlink_components(path, "registered project source")
        try:
            canonical = path.resolve(strict=True)
        except (OSError, RuntimeError) as exc:
            raise ValueError("registered project source is unavailable") from exc
        if str(canonical) != primary:
            raise ValueError("registered project source is not canonical")
        info = os.stat(path, follow_symlinks=False)
        if not stat.S_ISDIR(info.st_mode):
            raise ValueError("registered project source is not a directory")
        return path

    def _inspect_source(self, source: Path) -> _SourceIdentity:
        info = os.stat(source, follow_symlinks=False)
        if not stat.S_ISDIR(info.st_mode):
            raise ValueError("registered project source is not a directory")
        git_directory = source / ".git"
        try:
            git_info = os.stat(git_directory, follow_symlinks=False)
        except OSError as exc:
            raise ValueError("registered project must be a normal Git checkout") from exc
        if not stat.S_ISDIR(git_info.st_mode):
            raise ValueError("linked worktrees and symlinked Git metadata are not supported")
        config_path = git_directory / "config"
        try:
            config_info = os.stat(config_path, follow_symlinks=False)
            if not stat.S_ISREG(config_info.st_mode) or config_info.st_size > _MAX_CONFIG_BYTES:
                raise ValueError("source Git config is not a bounded regular file")
            raw_config = config_path.read_bytes()
        except OSError as exc:
            raise ValueError("source Git config cannot be inspected") from exc
        if len(raw_config) > _MAX_CONFIG_BYTES:
            raise ValueError("source Git config exceeds its size limit")
        self._validate_source_config(config_path)
        alternates = git_directory / "objects" / "info" / "alternates"
        if alternates.exists() or alternates.is_symlink():
            raise ValueError("source Git object alternates are not supported")
        shallow = git_directory / "shallow"
        if shallow.exists() or shallow.is_symlink():
            raise ValueError("shallow source repositories are not supported")
        return _SourceIdentity(
            path=source,
            device=info.st_dev,
            inode=info.st_ino,
            git_directory_device=git_info.st_dev,
            git_directory_inode=git_info.st_ino,
            config_device=config_info.st_dev,
            config_inode=config_info.st_ino,
            config_size=config_info.st_size,
            config_mtime_ns=config_info.st_mtime_ns,
            config_digest=hashlib.sha256(raw_config).hexdigest(),
        )

    def _validate_source_config(self, config_path: Path) -> None:
        result = self._run_git(
            ["config", "--no-includes", "--null", "--file", str(config_path), "--list"],
        )
        if len(result.stdout) > _MAX_CONFIG_BYTES * 2:
            raise ValueError("source Git config exceeds its parsed size limit")
        try:
            rows = result.stdout.split(b"\0")
            for row in rows:
                if not row:
                    continue
                key_bytes, separator, value_bytes = row.partition(b"\n")
                if not separator:
                    raise ValueError("source Git config is malformed")
                key = key_bytes.decode("ascii").casefold()
                value = value_bytes.decode("utf-8")
                if not _CONFIG_KEY.fullmatch(key) or not self._source_config_key_allowed(key):
                    raise ValueError("source contains unsafe Git config")
                if key.endswith(".url") and re.match(r"^[A-Za-z0-9.+-]+::", value):
                    raise ValueError("source contains an unsafe Git remote helper")
        except UnicodeDecodeError as exc:
            raise ValueError("source Git config is not valid text") from exc

    @staticmethod
    def _source_config_key_allowed(key: str) -> bool:
        if key in _SAFE_CORE_CONFIG or key in {"user.name", "user.email"}:
            return True
        if key == "extensions.objectformat":
            return True
        if re.fullmatch(r"remote\.[a-z0-9._-]+\.(url|fetch)", key):
            return True
        if re.fullmatch(r"branch\.[a-z0-9._/-]+\.(remote|merge|rebase)", key):
            return True
        return False

    def _repo_output(self, cwd: Path, arguments: list[str]) -> str:
        result = self._repo_git(cwd, arguments)
        try:
            output = result.stdout.decode("ascii").strip()
        except UnicodeDecodeError as exc:
            raise RuntimeError("Git returned an invalid identity value") from exc
        if not output:
            raise RuntimeError("Git returned an empty identity value")
        return output

    def _repo_git(self, cwd: Path, arguments: list[str]) -> subprocess.CompletedProcess[bytes]:
        return self._run_git(
            ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
             "-c", "credential.helper=", "-c", "core.pager=cat", *arguments],
            cwd=cwd,
        )

    def _run_git(
        self,
        arguments: list[str],
        *,
        cwd: Path | None = None,
    ) -> subprocess.CompletedProcess[bytes]:
        process: subprocess.Popen[bytes] | None = None
        try:
            process = subprocess.Popen(
                [self.git_executable, *arguments],
                cwd=cwd,
                env=self._git_environment,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                start_new_session=True,
            )
            stdout, stderr = process.communicate(timeout=self.timeout_seconds)
        except (OSError, subprocess.SubprocessError, RuntimeError) as exc:
            if process is not None and process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except OSError:
                    try:
                        process.kill()
                    except ProcessLookupError:
                        pass
            if process is not None:
                process.wait()
            raise RuntimeError("Git operation failed") from exc
        finally:
            if process is not None:
                for stream in (process.stdout, process.stderr):
                    if stream is not None and not stream.closed:
                        stream.close()
        return_code = process.returncode if process is not None else -1
        if return_code != 0:
            raise RuntimeError("Git operation failed")
        return subprocess.CompletedProcess(
            [self.git_executable, *arguments], return_code,
            stdout, stderr,
        )

    def _assert_workspace_root(self) -> None:
        if self._workspace_root_identity is None:
            raise RuntimeError("private workspace root was not prepared")
        _assert_no_symlink_components(self.workspace_root, "workspace root")
        info = os.stat(self.workspace_root, follow_symlinks=False)
        identity = self._workspace_root_identity
        if ((info.st_dev, info.st_ino) != (identity.device, identity.inode)
                or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700):
            raise RuntimeError("private workspace root was replaced or became accessible")

    def _assert_source_identity(self, identity: _SourceIdentity) -> None:
        _assert_no_symlink_components(identity.path, "registered project source")
        try:
            source_info = os.stat(identity.path, follow_symlinks=False)
            git_info = os.stat(identity.path / ".git", follow_symlinks=False)
            config_info = os.stat(identity.path / ".git" / "config", follow_symlinks=False)
            config_bytes = (identity.path / ".git" / "config").read_bytes()
        except OSError as exc:
            raise RuntimeError("registered project source changed during checkout") from exc
        if (not stat.S_ISDIR(source_info.st_mode) or not stat.S_ISDIR(git_info.st_mode)
                or not stat.S_ISREG(config_info.st_mode)
                or (source_info.st_dev, source_info.st_ino) != (identity.device, identity.inode)
                or (git_info.st_dev, git_info.st_ino) != (identity.git_directory_device, identity.git_directory_inode)
                or (config_info.st_dev, config_info.st_ino, config_info.st_size, config_info.st_mtime_ns)
                != (identity.config_device, identity.config_inode, identity.config_size, identity.config_mtime_ns)
                or hashlib.sha256(config_bytes).hexdigest() != identity.config_digest):
            raise RuntimeError("registered project source changed during checkout")

    def _capture_directory(self, path: Path, label: str) -> _DirectoryIdentity:
        info = os.stat(path, follow_symlinks=False)
        if not stat.S_ISDIR(info.st_mode):
            raise ValueError(f"{label} is not a directory")
        return _DirectoryIdentity(path, info.st_dev, info.st_ino)

    def _assert_checkout_identity(self, identity: _DirectoryIdentity) -> None:
        self._assert_workspace_root()
        try:
            info = os.stat(identity.path, follow_symlinks=False)
        except OSError as exc:
            raise RuntimeError("checkout destination disappeared during Git operation") from exc
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid()
                or stat.S_IMODE(info.st_mode) != 0o700
                or (info.st_dev, info.st_ino) != (identity.device, identity.inode)):
            raise RuntimeError("checkout destination was replaced during Git operation")

    def _assert_no_checkout_symlinks(self, identity: _DirectoryIdentity) -> None:
        self._assert_checkout_identity(identity)
        for current, directories, files in os.walk(identity.path, followlinks=False):
            for name in [*directories, *files]:
                candidate = Path(current) / name
                info = os.lstat(candidate)
                if stat.S_ISLNK(info.st_mode):
                    raise RuntimeError("Git checkout contains symlinks and is not supported")
        self._assert_checkout_identity(identity)

    def _remove_created_checkout(self, identity: _DirectoryIdentity) -> None:
        try:
            self._assert_workspace_root()
            info = os.stat(identity.path, follow_symlinks=False)
        except (OSError, RuntimeError, ValueError):
            return
        if (stat.S_ISDIR(info.st_mode)
                and (info.st_dev, info.st_ino) == (identity.device, identity.inode)):
            shutil.rmtree(identity.path)


def _identity_text(value: Any, name: str) -> str:
    if (not isinstance(value, str) or not value or value != value.strip()
            or len(value) > 200 or any(ord(char) < 32 or ord(char) == 127 for char in value)):
        raise ValueError(f"{name} must be a non-empty value of at most 200 characters")
    return value


def _assert_no_symlink_components(path: Path, label: str) -> None:
    if not path.is_absolute():
        raise ValueError(f"{label} must be an absolute path")
    current = Path(path.anchor)
    try:
        for part in path.parts[1:]:
            current = current / part
            info = os.lstat(current)
            if stat.S_ISLNK(info.st_mode):
                raise ValueError(f"{label} contains a symlink")
            if not stat.S_ISDIR(info.st_mode):
                raise ValueError(f"{label} contains a non-directory path component")
    except OSError as exc:
        raise ValueError(f"{label} is unavailable") from exc


def _prepare_private_root(path: Path) -> tuple[Path, _DirectoryIdentity]:
    if ".." in path.parts:
        raise ValueError("workspace_root cannot contain parent-directory components")
    path = Path(os.path.abspath(path))
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current = current / part
        try:
            info = os.lstat(current)
        except FileNotFoundError:
            os.mkdir(current, 0o700)
            os.chmod(current, 0o700, follow_symlinks=False)
            info = os.lstat(current)
        except OSError as exc:
            raise ValueError("workspace root path cannot be inspected") from exc
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise ValueError("workspace root contains a symlink or non-directory component")
    _assert_no_symlink_components(path, "workspace root")
    info = os.stat(path, follow_symlinks=False)
    if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError("workspace root must be owned by the server user and private")
    return path, _DirectoryIdentity(path, info.st_dev, info.st_ino)
