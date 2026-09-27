"""Pinned language profiles: artefact states, honest gaps and the owner API."""
from __future__ import annotations

import json
import os
import shutil
import socket
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from archon_server.app import create_app
from archon_server.config import Settings
from archon_server.language_profiles import (
    DEFAULT_EXTENSIONS_DIRECTORY,
    JAVASCRIPT_TYPESCRIPT,
    LANGUAGE_PROFILES,
    PYTHON,
    YAML,
    all_pins,
    describe_profiles,
    directory_digest,
    extension_state,
)
from archon_server.local_pairing import LOCAL_PAIRING_AUDIENCE


def _install(directory: Path, extension_id: str, version: str, *, licence: str | None = "MIT",
             extra_files: int = 0) -> Path:
    publisher, name = extension_id.split(".", 1)
    target = directory / f"{extension_id}-{version}"
    target.mkdir(parents=True)
    package = {"name": name, "publisher": publisher, "version": version}
    if licence is not None:
        package["license"] = licence
    (target / "package.json").write_text(json.dumps(package), encoding="utf-8")
    (target / "extension.js").write_text("// extension\n", encoding="utf-8")
    for index in range(extra_files):
        (target / f"asset-{index}.js").write_text(f"// asset {index}\n", encoding="utf-8")
    return target


def test_every_pin_is_well_formed_and_unique(tmp_path):
    pins = all_pins()
    assert len({pin.extension_id for pin in pins}) == len(pins)
    for pin in pins:
        assert pin.marketplace == "open-vsx"
        assert pin.declared_licence in {"MIT", "Apache-2.0", "BSD-3-Clause"}
        assert pin.vsix_bytes > 0
        assert len(pin.vsix_sha256) == 64 and len(pin.installed_sha256) == 64
        assert pin.version and pin.extension_id.count(".") == 1
    # Every profile names at least one language and states its gaps explicitly.
    for profile in LANGUAGE_PROFILES:
        assert profile.language_ids
        assert profile.label


def test_unsupported_features_are_stated_with_a_reason(tmp_path):
    python = next(p for p in LANGUAGE_PROFILES if p.profile == "python")
    features = {feature.feature: feature.reason for feature in python.unsupported}
    assert "pylance-language-server" in features
    assert "proprietary" in features["pylance-language-server"]
    javascript = next(p for p in LANGUAGE_PROFILES if p.profile == "javascript-typescript")
    assert any("no" in feature.reason.lower() for feature in javascript.unsupported)


def test_missing_extensions_are_reported_as_missing(tmp_path):
    report = describe_profiles(tmp_path / "empty")
    assert report["extensionsDirectory"] == str(tmp_path / "empty")
    for profile in report["profiles"]:
        for row in profile["extensions"] + profile["debuggers"]:
            assert row["state"] == "missing"
            assert row["reason"]
    assert report["unpinnedInstalled"] == []
    assert report["pinsVerified"] is False


def test_installed_extension_with_a_matching_digest_is_reported_installed(tmp_path):
    directory = tmp_path / "extensions"
    directory.mkdir()
    target = _install(directory, "redhat.vscode-yaml", "1.25.2026092308", extra_files=3)
    digest = directory_digest(target)
    assert digest["state"] == "digested"
    pin = YAML.extensions[0]
    installed = {"redhat.vscode-yaml": target}
    # The recorded digest of this host does not apply to this synthetic tree.
    assert extension_state(pin, installed)["state"] == "modified"
    assert extension_state(pin, installed)["reason"].startswith("the installed files")

    matching = type(pin)(**{**pin.__dict__, "installed_sha256": digest["sha256"], "installed_files": digest["files"]})
    row = extension_state(matching, installed)
    assert row["state"] == "installed" and row["reason"] is None
    assert row["measuredFiles"] == digest["files"]


def test_version_and_licence_drift_are_unverified_not_installed(tmp_path):
    directory = tmp_path / "extensions"
    directory.mkdir()
    target = _install(directory, "redhat.vscode-yaml", "9999.0.0")
    pin = YAML.extensions[0]
    row = extension_state(pin, {"redhat.vscode-yaml": target})
    assert row["state"] == "unverified" and "does not match the pin" in row["reason"]

    target2 = _install(tmp_path / "other", "redhat.vscode-yaml", pin.version, licence="Proprietary")
    digest = directory_digest(target2)
    matching = type(pin)(**{**pin.__dict__, "installed_sha256": digest["sha256"], "installed_files": digest["files"]})
    row = extension_state(matching, {"redhat.vscode-yaml": target2})
    assert row["state"] == "unverified" and "licence field" in row["reason"]

    target3 = _install(tmp_path / "third", "redhat.vscode-yaml", pin.version, licence=None)
    digest3 = directory_digest(target3)
    matching3 = type(pin)(**{**pin.__dict__, "installed_sha256": digest3["sha256"], "installed_files": digest3["files"]})
    # A missing licence field is not a mismatch claim; the digest still decides.
    assert extension_state(matching3, {"redhat.vscode-yaml": target3})["state"] == "installed"


def test_unpinned_installed_extensions_are_reported(tmp_path):
    directory = tmp_path / "extensions"
    directory.mkdir()
    _install(directory, "somevendor.auto-dependency", "1.0.0", licence=None)
    report = describe_profiles(directory)
    unpinned = report["unpinnedInstalled"]
    assert [row["extensionId"] for row in unpinned] == ["somevendor.auto-dependency"]
    assert unpinned[0]["state"] == "unpinned"
    assert unpinned[0]["installedLicenceField"] is None
    assert unpinned[0]["measuredSha256"]


def test_digest_is_bounded_and_ignores_non_files(tmp_path):
    directory = tmp_path / "ext"
    directory.mkdir()
    (directory / "package.json").write_text('{"name":"x","publisher":"y","version":"1"}', encoding="utf-8")
    (directory / "nested").mkdir()
    (directory / "nested" / "file.js").write_text("// x\n", encoding="utf-8")
    os.symlink(directory / "nested", directory / "link")
    first = directory_digest(directory)
    assert first["state"] == "digested" and first["files"] == 2
    (directory / "nested" / "file.js").write_text("// changed\n", encoding="utf-8")
    assert directory_digest(directory)["sha256"] != first["sha256"]
    assert directory_digest(tmp_path / "absent") == {"state": "missing"}


def _paired_owner_headers(socket_path: Path) -> dict[str, str]:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(3)
        connection.connect(str(socket_path))
        stream = connection.makefile("rwb", buffering=0)
        stream.write(json.dumps({"op": "challenge", "audience": LOCAL_PAIRING_AUDIENCE}).encode() + b"\n")
        challenge = json.loads(stream.readline())["challenge"]
        stream.write(json.dumps({
            "op": "redeem", "audience": LOCAL_PAIRING_AUDIENCE, "nonce": challenge["nonce"],
        }).encode() + b"\n")
        credential = json.loads(stream.readline())["credential"]
    return {"Authorization": f"Bearer {credential['access_token']}"}


def test_language_profile_api_is_owner_scoped_and_read_only(tmp_path):
    settings = Settings(
        archon_root=tmp_path,
        hermes_home=tmp_path / ".hermes",
        data_dir=tmp_path / ".data",
        auth_token="legacy-token",
        local_owner_mode=True,
        start_worker=False,
        code_server_extensions_dir=tmp_path / "code-server-extensions",
    )
    with TestClient(create_app(settings)) as client:
        headers = _paired_owner_headers(settings.local_pairing_socket_path)
        workspace_root = tmp_path / "checkout"
        workspace_root.mkdir()
        workspace_root.chmod(0o700)
        workspace_id = "workspace-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
        client.app.state.store.db.create_workspace(
            workspace_id=workspace_id,
            root=str(workspace_root),
            owner_id=f"local-uid:{os.geteuid()}",
            project_id="project-profiles",
            generation=1,
            isolation_profile="git-checkout",
        )
        path = f"/api/local/workspaces/{workspace_id}/language-profiles"
        assert client.get(path).status_code == 401
        assert client.get("/api/local/workspaces/workspace-ffffffffffffffffffffffffffffffff/language-profiles",
                          headers=headers).status_code == 404

        body = client.get(path, headers=headers).json()
        assert body["extensionsDirectory"] == str(tmp_path / "code-server-extensions")
        assert {profile["profile"] for profile in body["profiles"]} == {
            "python", "javascript-typescript", "yaml",
        }
        states = {
            row["extensionId"]: row["state"]
            for profile in body["profiles"]
            for row in profile["extensions"] + profile["debuggers"]
        }
        assert set(states) == {pin.extension_id for pin in all_pins()}
        assert set(states.values()) == {"missing"}
        python = next(profile for profile in body["profiles"] if profile["profile"] == "python")
        assert python["unsupported"][0]["feature"] == "pylance-language-server"

        # The endpoint reports artefacts and never a value from the workspace.
        assert "workspace-" not in json.dumps(body.get("pinsVerified"))
        assert client.get(path, headers=headers).headers["cache-control"] == "no-store"


@pytest.mark.skipif(
    not DEFAULT_EXTENSIONS_DIRECTORY.expanduser().is_dir(),
    reason="no code-server extensions directory on this host",
)
def test_this_host_pins_match_the_installed_extensions():
    """Evidence test: the recorded digests must describe the real installation."""
    report = describe_profiles()
    states = {}
    for profile in report["profiles"]:
        for row in profile["extensions"] + profile["debuggers"]:
            states[row["extensionId"]] = row
    assert set(states) == {pin.extension_id for pin in all_pins()}
    for extension_id, row in states.items():
        assert row["state"] == "installed", (extension_id, row)
    # The Python extension's declared Pylance dependency is genuinely absent here.
    assert states["ms-python.python"]["state"] == "installed"
    assert "ms-python.vscode-pylance" not in {
        row["extensionId"] for row in report["unpinnedInstalled"]
    }
