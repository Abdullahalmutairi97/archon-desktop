"""Create a one-time, private server environment file outside workspaces."""

from __future__ import annotations

import argparse
import os
import secrets
import stat
import sys
from pathlib import Path


DEFAULT_OUTPUT = Path("/etc/archon-desktop/server.env")


def _resolved_workspace_roots(values: list[str | os.PathLike[str]]) -> list[Path]:
    if not values:
        raise ValueError("At least one complete workspace root set is required")
    roots: list[Path] = []
    for value in values:
        path = Path(value)
        if not path.is_absolute():
            raise ValueError("Every workspace root must be an absolute existing directory")
        try:
            resolved = path.resolve(strict=True)
        except OSError as error:
            raise ValueError("Every workspace root must be an absolute existing directory") from error
        if not resolved.is_dir():
            raise ValueError("Every workspace root must be an absolute existing directory")
        roots.append(resolved)
    return roots


def _inside_workspace(candidate: Path, roots: list[Path]) -> bool:
    return any(candidate == root or root in candidate.parents for root in roots)


def _open_directory_no_symlinks(path: Path) -> int:
    """Open an absolute directory by walking each component without following links."""
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_CLOEXEC", 0)
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path.anchor or "/", flags)
    try:
        for component in path.parts[1:]:
            next_descriptor = os.open(component, flags | nofollow, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = next_descriptor
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def _check_destination(output: Path, directory_fd: int) -> None:
    try:
        existing = os.stat(output.name, dir_fd=directory_fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    if stat.S_ISLNK(existing.st_mode) or not stat.S_ISREG(existing.st_mode):
        raise ValueError("The output must be a new regular file path; symlinks are not allowed")
    raise FileExistsError("Refusing to replace an existing server environment file")


def validate_external_output_location(
    output: str | os.PathLike[str],
    workspace_roots: list[str | os.PathLike[str]],
    *,
    confirm_workspace_roots_complete: bool = False,
) -> Path:
    """Resolve and check an external destination without reading or creating it."""
    if not confirm_workspace_roots_complete:
        raise ValueError(
            "Confirm the supplied workspace roots are complete before provisioning"
        )
    roots = _resolved_workspace_roots(workspace_roots)
    requested = Path(output)
    if not requested.is_absolute():
        raise ValueError("The output path must be absolute")
    if requested.name in {"", ".", ".."}:
        raise ValueError("The output path must name a new regular file")
    try:
        if requested.is_symlink():
            raise ValueError("The output must be a new regular file path; symlinks are not allowed")
        parent = requested.parent.resolve(strict=False)
    except OSError as error:
        raise ValueError("The output parent directory could not be resolved safely") from error
    destination = parent / requested.name
    if _inside_workspace(destination, roots):
        raise ValueError("The output file must be outside all workspace roots")
    return destination


def create_server_env_file(
    output: str | os.PathLike[str],
    workspace_roots: list[str | os.PathLike[str]],
    *,
    confirm_workspace_roots_complete: bool = False,
) -> Path:
    """Write a fresh token to a mode-0600 file with exclusive publication.

    The caller must explicitly attest that ``workspace_roots`` includes every
    configured and registered workspace. The token is never returned.
    """
    requested = Path(output)
    resolved_output = validate_external_output_location(
        requested,
        workspace_roots,
        confirm_workspace_roots_complete=confirm_workspace_roots_complete,
    )

    try:
        resolved_output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        parent = requested.parent.resolve(strict=True)
    except OSError as error:
        raise ValueError("The output parent directory could not be created safely") from error
    resolved_output = parent / requested.name
    roots = _resolved_workspace_roots(workspace_roots)
    if _inside_workspace(resolved_output, roots):
        raise ValueError("The output file must be outside all workspace roots")

    directory_fd = _open_directory_no_symlinks(parent)
    temp_name: str | None = None
    try:
        directory_stat = os.fstat(directory_fd)
        if directory_stat.st_uid != os.geteuid() or stat.S_IMODE(directory_stat.st_mode) & 0o077:
            raise ValueError("The output parent must be owned by the current user and be a private directory")
        _check_destination(resolved_output, directory_fd)

        token = secrets.token_urlsafe(32)
        if (
            not isinstance(token, str)
            or len(token) < 43
            or not token.isascii()
            or any(not (char.isalnum() or char in "_-") for char in token)
        ):
            raise RuntimeError("Credential generation did not produce a valid token")
        payload = f"ARCHON_DESKTOP_AUTH_TOKEN={token}\n".encode("ascii")

        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)
        for _ in range(10):
            temp_name = f".{resolved_output.name}.{secrets.token_hex(8)}.tmp"
            try:
                temp_fd = os.open(temp_name, flags, 0o600, dir_fd=directory_fd)
                break
            except FileExistsError:
                temp_name = None
        else:
            raise RuntimeError("Could not allocate a private temporary file")

        try:
            os.fchmod(temp_fd, 0o600)
            with os.fdopen(temp_fd, "wb") as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            _check_destination(resolved_output, directory_fd)
            # Linking in the same directory publishes only a complete file and
            # fails atomically if another process created the target meanwhile.
            os.link(
                temp_name,
                resolved_output.name,
                src_dir_fd=directory_fd,
                dst_dir_fd=directory_fd,
                follow_symlinks=False,
            )
            os.fsync(directory_fd)
        except Exception:
            raise
        finally:
            if temp_name is not None:
                try:
                    os.unlink(temp_name, dir_fd=directory_fd)
                    os.fsync(directory_fd)
                except FileNotFoundError:
                    pass
        return resolved_output
    finally:
        os.close(directory_fd)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Provision a fresh bearer token in a private external service environment file."
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help=f"absolute external service environment path (default: {DEFAULT_OUTPUT})",
    )
    parser.add_argument(
        "--workspace-root",
        type=Path,
        action="append",
        required=True,
        help="absolute configured or registered workspace root; repeat for every root",
    )
    parser.add_argument(
        "--confirm-workspace-roots-complete",
        action="store_true",
        help="attest that all configured and registered workspace roots were supplied",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        path = create_server_env_file(
            args.output,
            args.workspace_root,
            confirm_workspace_roots_complete=args.confirm_workspace_roots_complete,
        )
    except (OSError, ValueError, RuntimeError) as error:
        print(f"Server credential provisioning failed: {error}", file=sys.stderr)
        return 2
    print(f"Created a new private server environment file at {path}.")
    print("The bearer token was written to that file and was not displayed.")
    print("Next: install the systemd unit with this file as its EnvironmentFile.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
