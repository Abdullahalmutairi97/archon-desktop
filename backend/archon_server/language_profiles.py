"""Pinned code-server language profiles with honest install and licence state.

A language profile names the pinned extensions that provide a language inside the
workspace IDE, the pinned debugger adapter if one exists, and the features this
host cannot provide. Each pin records what was actually fetched and measured:
the marketplace, the pinned version, the declared licence, the digest of the
licence file that was read, the digest of the downloaded VSIX and the digest of
the extracted extension directory that is installed on this host.

Nothing here claims a capability. `installed` means the pinned version is present
and its directory still hashes to the recorded value; a feature this host cannot
provide is reported as unsupported with the reason, never as working. An
installed extension that no pin covers is reported as unpinned rather than
silently accepted, because an automatically installed dependency has not been
licence- or source-verified.
"""
from __future__ import annotations

import hashlib
import json
import os
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

MAX_DIGEST_FILES = 20000
MAX_DIGEST_BYTES = 256 * 1024 * 1024
MAX_PACKAGE_BYTES = 512 * 1024
_EXTENSION_ID = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-."


@dataclass(frozen=True)
class ExtensionPin:
    """One verified extension artifact."""

    extension_id: str
    version: str
    marketplace: str
    declared_licence: str
    licence_sha256: str
    vsix_sha256: str
    vsix_bytes: int
    installed_sha256: str
    installed_files: int
    download_url: str
    target_platform: str | None = None


@dataclass(frozen=True)
class UnsupportedFeature:
    """A capability this host cannot provide, with the honest reason."""

    feature: str
    reason: str


@dataclass(frozen=True)
class LanguageProfile:
    """One language's pinned extensions and known gaps."""

    profile: str
    label: str
    language_ids: tuple[str, ...]
    extensions: tuple[ExtensionPin, ...]
    debuggers: tuple[ExtensionPin, ...]
    unsupported: tuple[UnsupportedFeature, ...]


PYTHON = LanguageProfile(
    profile="python",
    label="Python",
    language_ids=("python",),
    extensions=(
        ExtensionPin(
            extension_id="ms-python.python",
            version="2026.4.0",
            marketplace="open-vsx",
            declared_licence="MIT",
            licence_sha256="b3e677dfc054c000e37274dfb8bfcaefc221b71eb92b4f0b7502751b6d1f0210",
            vsix_sha256="232aeafb01f069824fdd92d3e628c1c442bbcfa1d3cc945ff97076340bb2b4a6",
            vsix_bytes=6826731,
            installed_sha256="8bb2ceec4e052f3bb12be5b8d2fad9dca3b68c3b60436a0fd97fdd7306759358",
            installed_files=2381,
            download_url="https://open-vsx.org/api/ms-python/python/2026.4.0/file/ms-python.python-2026.4.0.vsix",
        ),
    ),
    debuggers=(
        ExtensionPin(
            extension_id="ms-python.debugpy",
            version="2026.6.0",
            marketplace="open-vsx",
            declared_licence="MIT",
            licence_sha256="c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383",
            vsix_sha256="c7744af4bf72978f5792624a71c80e2b622a1118574fada3a903d70ac03d5bca",
            vsix_bytes=4700833,
            installed_sha256="22e2156c05315b2836e6d4d1c71349f78a33311ca5a66754f4f83c82da3b2ae4",
            installed_files=337,
            download_url=(
                "https://open-vsx.org/api/ms-python/debugpy/linux-x64/2026.6.0/file/"
                "ms-python.debugpy-2026.6.0@linux-x64.vsix"
            ),
            target_platform="linux-x64",
        ),
    ),
    unsupported=(
        UnsupportedFeature(
            feature="pylance-language-server",
            reason=(
                "The Python extension declares ms-python.vscode-pylance as a dependency, but "
                "Pylance is proprietary and is not published to this marketplace, so "
                "Pylance-based completion, type checking and refactoring are unavailable."
            ),
        ),
    ),
)

YAML = LanguageProfile(
    profile="yaml",
    label="YAML",
    language_ids=("yaml",),
    extensions=(
        ExtensionPin(
            extension_id="redhat.vscode-yaml",
            version="1.25.2026092308",
            marketplace="open-vsx",
            declared_licence="MIT",
            licence_sha256="2a6ebc3c5b441f0aef19c5190d17f5bfc1ab4f729db49fabb2db7d10bd9a6146",
            vsix_sha256="11fd0c6fef26e548458b25748a62ffaab70a3c5915aa43b468a03058f0a6aea8",
            vsix_bytes=1056571,
            installed_sha256="f6edc9e8823323b44fa37a32c5d5621537c4823e0b3247d8cd22ead5fe849be8",
            installed_files=41,
            download_url=(
                "https://open-vsx.org/api/redhat/vscode-yaml/1.25.2026092308/file/"
                "redhat.vscode-yaml-1.25.2026092308.vsix"
            ),
        ),
    ),
    debuggers=(),
    unsupported=(),
)

JAVASCRIPT_TYPESCRIPT = LanguageProfile(
    profile="javascript-typescript",
    label="JavaScript and TypeScript",
    language_ids=("javascript", "javascriptreact", "typescript", "typescriptreact"),
    extensions=(
        ExtensionPin(
            extension_id="dbaeumer.vscode-eslint",
            version="3.0.34",
            marketplace="open-vsx",
            declared_licence="MIT",
            licence_sha256="976f8ed671d885872afac0021bd78b3d84fe8d4783a98b46deb5a7dc4e29dbff",
            vsix_sha256="ca5334d46f6a39079e751ef4601bfc9f86bc3a46483e87291ec609239d161308",
            vsix_bytes=264365,
            installed_sha256="0522243e2ae31661f7ec9f17f0e55877ac82d280e15f5377f33936b14d65950a",
            installed_files=15,
            download_url=(
                "https://open-vsx.org/api/dbaeumer/vscode-eslint/3.0.34/file/"
                "dbaeumer.vscode-eslint-3.0.34.vsix"
            ),
        ),
    ),
    debuggers=(),
    unsupported=(
        UnsupportedFeature(
            feature="typescript-debugging",
            reason=(
                "No JavaScript debugger adapter is pinned for this marketplace, so breakpoint "
                "debugging is unsupported and no fake adapter is reported as available."
            ),
        ),
    ),
)

LANGUAGE_PROFILES: tuple[LanguageProfile, ...] = (PYTHON, JAVASCRIPT_TYPESCRIPT, YAML)

DEFAULT_EXTENSIONS_DIRECTORY = Path("~/.local/share/code-server/extensions")


def all_pins() -> tuple[ExtensionPin, ...]:
    pins: list[ExtensionPin] = []
    for profile in LANGUAGE_PROFILES:
        pins.extend(profile.extensions)
        pins.extend(profile.debuggers)
    return tuple(pins)


def _validate_pin(pin: ExtensionPin) -> None:
    if (not pin.extension_id or any(char not in _EXTENSION_ID for char in pin.extension_id)
            or pin.extension_id.count(".") != 1 or not pin.version
            or not pin.marketplace or not pin.declared_licence):
        raise ValueError("extension pin has an invalid identity")
    for digest in (pin.licence_sha256, pin.vsix_sha256, pin.installed_sha256):
        if len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
            raise ValueError("extension pin has an invalid digest")


for _profile in LANGUAGE_PROFILES:
    for _pin in (*_profile.extensions, *_profile.debuggers):
        _validate_pin(_pin)
del _profile, _pin


def directory_digest(directory: Path) -> dict[str, Any]:
    """Digest an installed extension directory, bounded and deterministic."""
    if not directory.is_dir():
        return {"state": "missing"}
    digest = hashlib.sha256()
    files = 0
    total = 0
    try:
        for root, directories, names in os.walk(directory):
            directories.sort()
            for name in sorted(names):
                path = Path(root) / name
                try:
                    info = path.lstat()
                    if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_DIGEST_BYTES:
                        return {"state": "unverifiable", "reason": "extension tree is not a bounded set of regular files"}
                    total += info.st_size
                    if total > MAX_DIGEST_BYTES or files >= MAX_DIGEST_FILES:
                        return {"state": "unverifiable", "reason": "extension tree exceeds the digest bound"}
                    with path.open("rb") as handle:
                        content = handle.read()
                except OSError:
                    return {"state": "unverifiable", "reason": "extension tree cannot be read completely"}
                digest.update(os.path.relpath(path, directory).encode("utf-8"))
                digest.update(b"\0")
                digest.update(hashlib.sha256(content).digest())
                files += 1
    except OSError:
        return {"state": "unverifiable", "reason": "extension tree cannot be walked"}
    return {"state": "digested", "sha256": digest.hexdigest(), "files": files}


def _read_extension_package(directory: Path) -> dict[str, Any] | None:
    package = directory / "package.json"
    try:
        descriptor = os.open(package, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0))
    except OSError:
        return None
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_PACKAGE_BYTES:
            return None
        payload = os.read(descriptor, MAX_PACKAGE_BYTES + 1)
    finally:
        os.close(descriptor)
    try:
        data = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _installed_directories(extensions_dir: Path) -> dict[str, Path]:
    """Map installed extension id -> directory, ignoring unreadable entries."""
    found: dict[str, Path] = {}
    if not extensions_dir.is_dir():
        return found
    try:
        entries = sorted(os.listdir(extensions_dir))
    except OSError:
        return found
    for name in entries:
        directory = extensions_dir / name
        if not directory.is_dir():
            continue
        package = _read_extension_package(directory)
        if package is None:
            continue
        publisher = package.get("publisher")
        extension = package.get("name")
        if not isinstance(publisher, str) or not isinstance(extension, str):
            continue
        found[f"{publisher}.{extension}"] = directory
    return found


def extension_state(pin: ExtensionPin, installed: dict[str, Path]) -> dict[str, Any]:
    """Report one pin's state against what is actually installed."""
    directory = installed.get(pin.extension_id)
    row: dict[str, Any] = {
        "extensionId": pin.extension_id,
        "version": pin.version,
        "marketplace": pin.marketplace,
        "declaredLicence": pin.declared_licence,
        "licenceSha256": pin.licence_sha256,
        "vsixSha256": pin.vsix_sha256,
        "vsixBytes": pin.vsix_bytes,
        "downloadUrl": pin.download_url,
        "targetPlatform": pin.target_platform,
        "pinnedInstalledSha256": pin.installed_sha256,
    }
    if directory is None:
        row.update({"state": "missing", "reason": "the pinned extension is not installed in this directory"})
        return row
    package = _read_extension_package(directory) or {}
    installed_version = package.get("version")
    row["installedVersion"] = installed_version if isinstance(installed_version, str) else None
    row["installedDirectory"] = directory.name
    if not isinstance(installed_version, str) or installed_version != pin.version:
        row.update({
            "state": "unverified",
            "reason": "the installed version does not match the pin, so the pinned licence and digest do not apply",
        })
        return row
    measured = directory_digest(directory)
    row["measuredSha256"] = measured.get("sha256")
    row["measuredFiles"] = measured.get("files")
    if measured["state"] != "digested":
        row.update({"state": "unverified", "reason": measured.get("reason", "the extension tree could not be digested")})
        return row
    if measured["sha256"] != pin.installed_sha256 or measured["files"] != pin.installed_files:
        row.update({
            "state": "modified",
            "reason": "the installed files no longer match the recorded digest for this pin",
        })
        return row
    licence = package.get("license")
    row["installedLicenceField"] = licence if isinstance(licence, str) else None
    if isinstance(licence, str) and licence.strip() and licence.strip() != pin.declared_licence:
        row.update({
            "state": "unverified",
            "reason": "the installed licence field differs from the declared licence for this pin",
        })
        return row
    row.update({"state": "installed", "reason": None})
    return row


def describe_profiles(extensions_dir: str | os.PathLike[str] | None = None) -> dict[str, Any]:
    """Report every pinned language profile against the real extensions directory."""
    directory = Path(extensions_dir).expanduser() if extensions_dir else DEFAULT_EXTENSIONS_DIRECTORY.expanduser()
    installed = _installed_directories(directory)
    pinned_ids = {pin.extension_id for pin in all_pins()}
    profiles = []
    for profile in LANGUAGE_PROFILES:
        profiles.append({
            "profile": profile.profile,
            "label": profile.label,
            "languageIds": list(profile.language_ids),
            "extensions": [extension_state(pin, installed) for pin in profile.extensions],
            "debuggers": [extension_state(pin, installed) for pin in profile.debuggers],
            "unsupported": [
                {"feature": feature.feature, "reason": feature.reason} for feature in profile.unsupported
            ],
        })
    unpinned = []
    for extension_id, path in sorted(installed.items()):
        if extension_id in pinned_ids:
            continue
        package = _read_extension_package(path) or {}
        measured = directory_digest(path)
        unpinned.append({
            "extensionId": extension_id,
            "installedVersion": package.get("version") if isinstance(package.get("version"), str) else None,
            "installedLicenceField": package.get("license") if isinstance(package.get("license"), str) else None,
            "measuredSha256": measured.get("sha256"),
            "state": "unpinned",
            "reason": "this installed extension is not covered by a verified pin",
        })
    return {
        "extensionsDirectory": str(directory),
        "profiles": profiles,
        "unpinnedInstalled": unpinned,
        "pinsVerified": False,
        "note": (
            "Installed means the pinned version is present and its files still hash to the recorded digest. "
            "This is an artefact record, not a behavioural qualification: no language feature is claimed to "
            "work because an extension is installed."
        ),
    }
