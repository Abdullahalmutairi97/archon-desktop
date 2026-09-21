"""Filesystem admission checks for a task's initial working directory.

These checks bind a task to a configured scratch directory or registered project
folder. They are not a filesystem sandbox: trusted execution can access other
paths, and a filesystem mutation can still race a later process launch.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class SessionWorkspace:
    cwd: str | None
    project_id: str | None = None


@dataclass(frozen=True)
class AdmittedWorkspace:
    cwd: str
    project_id: str | None
    authorized_roots: tuple[str, ...]


def _directory(value: str | Path, label: str, *, canonical: bool = False) -> Path:
    if not isinstance(value, (str, Path)) or not str(value).strip():
        raise ValueError(f"{label} must name an existing absolute directory")
    try:
        path = Path(value).expanduser()
        if not path.is_absolute():
            raise ValueError(f"{label} must be an absolute directory")
        resolved = path.resolve(strict=True)
        if not resolved.is_dir():
            raise ValueError(f"{label} must be a directory")
        if canonical and str(path) != str(resolved):
            raise ValueError(f"{label} is no longer its stored canonical directory")
        return resolved
    except (OSError, RuntimeError) as exc:
        raise ValueError(f"{label} must name an existing accessible directory") from exc


def _project_roots(project: Mapping[str, Any]) -> tuple[tuple[Path, ...], Path | None]:
    primary_value = project.get("primary_path")
    values = [primary_value] if primary_value else []
    for folder in project.get("folders", []):
        if not isinstance(folder, Mapping) or not folder.get("path"):
            raise ValueError("Registered project folder is missing its path")
        values.append(folder["path"])
    roots = tuple(dict.fromkeys(
        _directory(value, "Registered project root", canonical=True) for value in values
    ))
    if not roots:
        raise ValueError("Project has no registered directory roots")
    primary = _directory(primary_value, "Project primary root", canonical=True) if primary_value else None
    return roots, primary


def _require_contained(cwd: Path, roots: Sequence[Path]) -> None:
    if not roots:
        raise ValueError("Task has no authorized directory roots")
    if not any(cwd.is_relative_to(root) for root in roots):
        raise ValueError("Task cwd is outside its registered workspace roots")


def admit_workspace(
    *,
    scratch_root: str | Path,
    projects: Sequence[Mapping[str, Any]],
    cwd: str | None = None,
    project_id: str | None = None,
    session: SessionWorkspace | None = None,
) -> AdmittedWorkspace:
    """Resolve a new task, preserving an existing session's workspace identity.

    ``projects`` is the active registered project catalog. A project outside the
    scratch root must be explicitly selected or already own the session. A
    projectless session cannot be reassigned through task submission.
    """
    owner_cwd = None
    if session is not None:
        if session.cwd is None:
            raise ValueError("Existing session has no recorded cwd; explicit workspace repair is required")
        owner_cwd = _directory(session.cwd, "Existing session cwd", canonical=True)
        if project_id is not None and project_id != session.project_id:
            raise ValueError("Requested project does not match the existing session project")
        project_id = session.project_id
        if cwd is not None and _directory(cwd, "Requested cwd") != owner_cwd:
            raise ValueError("Requested cwd does not match the existing session cwd")

    if project_id is None:
        roots = (_directory(scratch_root, "Registered scratch root"),)
        default_cwd = roots[0]
    else:
        matches = [project for project in projects if project.get("id") == project_id]
        if not matches:
            raise ValueError("Requested project is not an active registered project")
        if len(matches) != 1:
            raise ValueError("Requested project identity is ambiguous")
        roots, primary = _project_roots(matches[0])
        default_cwd = primary or (roots[0] if len(roots) == 1 else None)

    if owner_cwd is not None:
        resolved = owner_cwd
    elif cwd is not None:
        resolved = _directory(cwd, "Requested cwd")
    elif default_cwd is not None:
        resolved = default_cwd
    else:
        raise ValueError("Project has no unambiguous primary directory; specify cwd")
    _require_contained(resolved, roots)
    return AdmittedWorkspace(
        cwd=str(resolved),
        project_id=project_id,
        authorized_roots=tuple(str(root) for root in roots),
    )


def revalidate_workspace(cwd: str, authorized_roots: Sequence[str]) -> str:
    """Recheck canonical directory names immediately before dispatch or launch.

    Callers must obtain roots from current authorization state. This rejects
    removed paths and symlink retargeting; it cannot prevent later OS races or
    detect replacement of a directory at the same canonical path.
    """
    resolved = _directory(cwd, "Stored task cwd", canonical=True)
    roots = tuple(
        _directory(root, "Authorized root", canonical=True) for root in authorized_roots
    )
    _require_contained(resolved, roots)
    return str(resolved)
