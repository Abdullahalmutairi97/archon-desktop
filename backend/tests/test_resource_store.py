"""Managed provisioning: a verified, content-addressed store with atomic activation and rollback."""
from __future__ import annotations

import hashlib
import json
import os
import socket
import stat
from pathlib import Path

import pytest

from archon_server.resource_store import (
    ResourceStore,
    ResourceStoreRejected,
    ResourceStoreUnavailable,
)


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _store(tmp_path: Path, **kwargs) -> ResourceStore:
    return ResourceStore(tmp_path / "store", staging_root=tmp_path / "staging", **kwargs)


def _stage(store: ResourceStore, name: str, data: bytes) -> Path:
    path = store.staging_root / name
    path.write_bytes(data)
    path.chmod(0o600)
    return path


def test_an_artefact_is_installed_only_when_its_bytes_match_the_digest(tmp_path):
    store = _store(tmp_path)
    data = b"#!/bin/sh\necho pinned tool v1\n"
    staged = _stage(store, "tool-v1", data)

    row = store.install(name="pinned-tool", kind="runtime", digest=_sha(data), source=staged)
    assert row["activeDigest"] == _sha(data)
    assert row["previousDigests"] == []
    current = store.root / "current" / "pinned-tool"
    assert current.is_symlink()
    assert current.resolve() == (store.root / "objects" / _sha(data)).resolve()
    assert current.read_bytes() == data
    assert row["path"] == str(current)
    # The stored object is immutable and private; a runtime object is owner-executable.
    obj = store.root / "objects" / _sha(data)
    assert stat.S_IMODE(os.stat(obj).st_mode) == 0o500
    assert stat.S_IMODE(os.stat(store.root).st_mode) == 0o700
    assert stat.S_IMODE(os.stat(store.root / "store.json").st_mode) == 0o600
    # The staged source is left for the owner to remove; the store never deletes inputs.
    assert staged.exists()

    extension = b"PK\x03\x04 extension bytes"
    staged_ext = _stage(store, "ext.vsix", extension)
    store.install(name="pinned-ext", kind="extension", digest=_sha(extension), source=staged_ext)
    assert stat.S_IMODE(os.stat(store.root / "objects" / _sha(extension)).st_mode) == 0o400

    measured = store.measure("pinned-tool")
    assert measured == {"present": True, "digest": _sha(data), "path": str(current)}
    assert store.measure("never-installed") == {"present": False, "digest": None, "path": None}


def test_a_digest_mismatch_installs_and_activates_nothing(tmp_path):
    store = _store(tmp_path)
    staged = _stage(store, "tool", b"tampered bytes")
    with pytest.raises(ResourceStoreRejected, match="digest"):
        store.install(name="pinned-tool", kind="runtime", digest="a" * 64, source=staged)
    assert not (store.root / "current" / "pinned-tool").exists()
    assert list((store.root / "objects").iterdir()) == []
    assert store.entries() == []


def test_the_source_must_be_a_private_regular_file_directly_in_the_staging_directory(tmp_path):
    store = _store(tmp_path)
    data = b"payload"
    outside = tmp_path / "outside"
    outside.write_bytes(data)
    with pytest.raises(ResourceStoreRejected):
        store.install(name="tool", kind="runtime", digest=_sha(data), source=outside)

    # A link inside staging to a file outside it is refused rather than followed.
    link = store.staging_root / "link"
    link.symlink_to(outside)
    with pytest.raises(ResourceStoreRejected):
        store.install(name="tool", kind="runtime", digest=_sha(data), source=link)

    # A traversal that lands outside the staging directory is refused.
    with pytest.raises(ResourceStoreRejected):
        store.install(name="tool", kind="runtime", digest=_sha(data),
                      source=store.staging_root / ".." / "outside")

    nested = store.staging_root / "nested"
    nested.mkdir()
    (nested / "tool").write_bytes(data)
    with pytest.raises(ResourceStoreRejected):
        store.install(name="tool", kind="runtime", digest=_sha(data), source=nested / "tool")

    with pytest.raises(ResourceStoreRejected):
        store.install(name="tool", kind="runtime", digest=_sha(data), source=nested)

    # Another account could have rewritten a group- or world-writable input.
    writable = _stage(store, "shared", data)
    writable.chmod(0o666)
    with pytest.raises(ResourceStoreRejected):
        store.install(name="tool", kind="runtime", digest=_sha(data), source=writable)

    with pytest.raises(ResourceStoreRejected):
        store.install(name="tool", kind="runtime", digest=_sha(data), source=Path("relative"))

    sock_path = store.staging_root / "sock"
    server = socket.socket(socket.AF_UNIX)
    try:
        server.bind(str(sock_path))
        with pytest.raises(ResourceStoreRejected):
            store.install(name="tool", kind="runtime", digest=_sha(data), source=sock_path)
    finally:
        server.close()

    # Oversized input is refused before it is copied.
    small = _store(tmp_path / "small", max_bytes=4)
    big = _stage(small, "big", b"12345")
    with pytest.raises(ResourceStoreRejected, match="large"):
        small.install(name="tool", kind="runtime", digest=_sha(b"12345"), source=big)


def test_names_kinds_and_digests_are_validated(tmp_path):
    store = _store(tmp_path)
    data = b"x"
    staged = _stage(store, "x", data)
    for kwargs in ({"name": "../escape"}, {"name": "Upper"}, {"kind": "mcp"}, {"kind": "tool"},
                   {"digest": "not-a-digest"}):
        arguments = {"name": "tool", "kind": "runtime", "digest": _sha(data), "source": staged, **kwargs}
        with pytest.raises(ValueError):
            store.install(**arguments)


def test_an_update_keeps_the_previous_object_and_rollback_restores_it(tmp_path):
    store = _store(tmp_path)
    v1, v2 = b"tool v1", b"tool v2"
    store.install(name="tool", kind="runtime", digest=_sha(v1), source=_stage(store, "v1", v1))
    updated = store.install(name="tool", kind="runtime", digest=_sha(v2), source=_stage(store, "v2", v2))
    assert updated["activeDigest"] == _sha(v2)
    assert updated["previousDigests"] == [_sha(v1)]
    assert (store.root / "current" / "tool").read_bytes() == v2

    # Installing the digest that is already active is a no-op, not a new history entry.
    again = store.install(name="tool", kind="runtime", digest=_sha(v2), source=_stage(store, "v2b", v2))
    assert again["activeDigest"] == _sha(v2) and again["previousDigests"] == [_sha(v1)]

    rolled = store.rollback(name="tool")
    assert rolled["activeDigest"] == _sha(v1)
    assert rolled["previousDigests"] == [_sha(v2)]
    assert (store.root / "current" / "tool").read_bytes() == v1
    operations = [row["operation"] for row in rolled["history"]]
    assert operations == ["install", "install", "rollback"]

    # Rolling forward by naming a retained digest works; an unknown digest does not.
    assert store.rollback(name="tool", digest=_sha(v2))["activeDigest"] == _sha(v2)
    with pytest.raises(ResourceStoreRejected):
        store.rollback(name="tool", digest="e" * 64)
    with pytest.raises(ResourceStoreRejected):
        store.rollback(name="never-installed")


def test_a_modified_object_is_never_activated_or_reported_as_current(tmp_path):
    store = _store(tmp_path)
    v1, v2 = b"tool v1", b"tool v2"
    store.install(name="tool", kind="runtime", digest=_sha(v1), source=_stage(store, "v1", v1))
    store.install(name="tool", kind="runtime", digest=_sha(v2), source=_stage(store, "v2", v2))
    old = store.root / "objects" / _sha(v1)
    old.chmod(0o700)
    old.write_bytes(b"swapped after install")
    old.chmod(0o500)
    with pytest.raises(ResourceStoreUnavailable, match="digest"):
        store.rollback(name="tool")
    # The active object is untouched by the refused rollback.
    assert (store.root / "current" / "tool").read_bytes() == v2

    active = store.root / "objects" / _sha(v2)
    active.chmod(0o700)
    active.write_bytes(b"modified in place")
    active.chmod(0o500)
    measured = store.measure("tool")
    assert measured["present"] is True and measured["digest"] == _sha(b"modified in place")


def test_a_link_that_leaves_the_store_is_not_measured_as_installed(tmp_path):
    store = _store(tmp_path)
    data = b"tool"
    store.install(name="tool", kind="runtime", digest=_sha(data), source=_stage(store, "t", data))
    outside = tmp_path / "elsewhere"
    outside.write_bytes(data)
    link = store.root / "current" / "tool"
    link.unlink()
    link.symlink_to(outside)
    with pytest.raises(ResourceStoreUnavailable):
        store.measure("tool")


def test_an_unsafe_or_tampered_store_fails_closed(tmp_path):
    store = _store(tmp_path)
    data = b"tool"
    store.install(name="tool", kind="runtime", digest=_sha(data), source=_stage(store, "t", data))
    ledger = store.root / "store.json"
    ledger.chmod(0o644)
    with pytest.raises(ResourceStoreUnavailable):
        store.entries()
    ledger.chmod(0o600)
    ledger.write_text(json.dumps({"version": 9, "entries": {}}))
    with pytest.raises(ResourceStoreUnavailable):
        store.entries()
    ledger.write_text(json.dumps({"version": 1, "entries": {"tool": {"activeDigest": "zz"}}}))
    with pytest.raises(ResourceStoreUnavailable):
        store.entries()

    shared = tmp_path / "shared-store"
    shared.mkdir(mode=0o755)
    shared.chmod(0o755)
    with pytest.raises(ResourceStoreUnavailable):
        ResourceStore(shared, staging_root=tmp_path / "staging2")
    with pytest.raises(ValueError):
        ResourceStore(Path("relative"), staging_root=tmp_path / "staging3")


def _paired_owner_headers(socket_path: Path) -> dict[str, str]:
    """Self-contained pairing helper: CI runs pytest where `tests` is not a package."""
    from archon_server.local_pairing import LOCAL_PAIRING_AUDIENCE

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


def _approved_request(client, headers, name: str, digest: str, kind: str = "runtime") -> str:
    assert client.put(f"/api/local/resources/definitions/{name}", headers=headers, json={
        "name": name, "kind": kind, "version": "1", "digest": digest,
    }).status_code == 201
    created = client.post("/api/local/resources/install-requests", headers=headers,
                          json={"definition": name, "reason": "provision the accepted build"})
    assert created.status_code == 201, created.text
    request_id = created.json()["request"]["id"]
    decided = client.post(f"/api/local/resources/install-requests/{request_id}/decision",
                          headers=headers, json={"decision": "approved"})
    assert decided.status_code == 200, decided.text
    assert decided.json()["request"]["approvedDigest"] == digest
    return request_id


def test_an_approved_request_is_provisioned_verified_and_rolled_back_through_the_api(tmp_path):
    from fastapi.testclient import TestClient

    from archon_server.app import create_app
    from archon_server.config import Settings

    settings = Settings(
        archon_root=tmp_path, hermes_home=tmp_path / ".hermes", data_dir=tmp_path / ".data",
        auth_token="legacy-token", local_owner_mode=True, start_worker=False,
    )
    v1, v2 = b"#!/bin/sh\necho v1\n", b"#!/bin/sh\necho v2\n"
    with TestClient(create_app(settings)) as client:
        headers = _paired_owner_headers(settings.local_pairing_socket_path)
        assert client.get("/api/local/resources/store").status_code == 401
        store = client.get("/api/local/resources/store", headers=headers).json()
        staging = Path(store["stagingRoot"])
        assert store["entries"] == []
        for name, data in (("tool-v1", v1), ("tool-v2", v2), ("wrong", b"wrong bytes")):
            (staging / name).write_bytes(data)
            (staging / name).chmod(0o600)

        request_id = _approved_request(client, headers, "pinned-tool", _sha(v1))
        route = f"/api/local/resources/install-requests/{request_id}/provision"
        assert client.post(route, json={"artifact": "tool-v1", "confirm": True}).status_code == 401
        # Installing needs an explicit confirmation and a bare file name inside staging.
        assert client.post(route, headers=headers, json={"artifact": "tool-v1"}).status_code == 422
        assert client.post(route, headers=headers,
                           json={"artifact": "tool-v1", "confirm": False}).status_code == 400
        assert client.post(route, headers=headers,
                           json={"artifact": "../tool-v1", "confirm": True}).status_code == 422
        # Bytes that do not match the approved digest are refused and nothing is recorded.
        mismatch = client.post(route, headers=headers, json={"artifact": "wrong", "confirm": True})
        assert mismatch.status_code == 409 and "digest" in mismatch.json()["detail"]
        listed = client.get("/api/local/resources/install-requests", headers=headers).json()
        assert listed["requests"][0]["installationPerformed"] is False

        provisioned = client.post(route, headers=headers, json={"artifact": "tool-v1", "confirm": True})
        assert provisioned.status_code == 200, provisioned.text
        body = provisioned.json()
        assert body["installationPerformed"] is True
        row = body["request"]
        assert row["installationPerformed"] is True
        assert row["installedBy"].startswith("local-")
        assert row["installation"]["digest"] == _sha(v1)
        current = Path(row["installation"]["path"])
        assert current.read_bytes() == v1
        # One approval provisions once; an update needs its own request.
        assert client.post(route, headers=headers,
                           json={"artifact": "tool-v1", "confirm": True}).status_code == 409

        verified = client.post(f"/api/local/resources/install-requests/{request_id}/verify",
                               headers=headers, json={})
        assert verified.status_code == 200
        assert verified.json()["request"]["verification"]["state"] == "provisioned"
        assert verified.json()["installationPerformed"] is True

        # An update, then a rollback to the retained digest.
        update_id = _approved_request(client, headers, "pinned-tool", _sha(v2))
        assert client.post(f"/api/local/resources/install-requests/{update_id}/provision", headers=headers,
                           json={"artifact": "tool-v2", "confirm": True}).status_code == 200
        assert current.read_bytes() == v2
        rollback = "/api/local/resources/store/pinned-tool/rollback"
        assert client.post(rollback, json={"confirm": True}).status_code == 401
        assert client.post(rollback, headers=headers, json={"confirm": False}).status_code == 400
        rolled = client.post(rollback, headers=headers, json={"confirm": True})
        assert rolled.status_code == 200, rolled.text
        assert rolled.json()["entry"]["activeDigest"] == _sha(v1)
        assert current.read_bytes() == v1
        assert client.post("/api/local/resources/store/never-installed/rollback", headers=headers,
                           json={"confirm": True}).status_code == 409
        entries = client.get("/api/local/resources/store", headers=headers).json()["entries"]
        assert [entry["name"] for entry in entries] == ["pinned-tool"]
        assert [row["operation"] for row in entries[0]["history"]] == ["install", "install", "rollback"]


def test_an_approval_binds_the_digest_of_an_old_request_beyond_the_listing_window(tmp_path):
    from archon_server.resource_definitions import ResourceDefinitionLedger, ResourceInstallRequestLedger

    definitions = ResourceDefinitionLedger(tmp_path / "definitions")
    definitions.define(name="tool", kind="runtime", version="1", digest="a" * 64)
    ledger = ResourceInstallRequestLedger(tmp_path / "requests", max_requests=300)
    oldest = ledger.request(definition="tool", reason="first", requested_by="local-uid:1",
                            definitions={"tool"})
    for _ in range(140):
        ledger.request(definition="tool", reason="later", requested_by="local-uid:1", definitions={"tool"})
    assert all(row["id"] != oldest["id"] for row in ledger.list(128))
    assert ledger.get(oldest["id"])["id"] == oldest["id"]
    assert ledger.get("req-" + "0" * 16) is None
    with pytest.raises(ValueError):
        ledger.get("not-an-id")


def test_provisioning_refuses_a_changed_definition_a_denied_policy_and_configuration_kinds(tmp_path):
    from fastapi.testclient import TestClient

    from archon_server.app import create_app
    from archon_server.config import Settings

    settings = Settings(
        archon_root=tmp_path, hermes_home=tmp_path / ".hermes", data_dir=tmp_path / ".data",
        auth_token="legacy-token", local_owner_mode=True, start_worker=False,
        resource_staging_dir=tmp_path / "staging",
    )
    data = b"tool bytes"
    with TestClient(create_app(settings)) as client:
        headers = _paired_owner_headers(settings.local_pairing_socket_path)
        staging = tmp_path / "staging"
        assert client.get("/api/local/resources/store", headers=headers).json()["stagingRoot"] == str(staging)
        (staging / "tool").write_bytes(data)
        (staging / "tool").chmod(0o600)

        # Not yet approved.
        client.put("/api/local/resources/definitions/pending", headers=headers, json={
            "name": "pending", "kind": "runtime", "version": "1", "digest": _sha(data),
        })
        pending = client.post("/api/local/resources/install-requests", headers=headers,
                              json={"definition": "pending", "reason": "later"}).json()["request"]["id"]
        assert client.post(f"/api/local/resources/install-requests/{pending}/provision", headers=headers,
                           json={"artifact": "tool", "confirm": True}).status_code == 409

        # The definition changed after the approval: the approved identity is no longer it.
        changed = _approved_request(client, headers, "changed-tool", _sha(data))
        client.put("/api/local/resources/definitions/changed-tool", headers=headers, json={
            "name": "changed-tool", "kind": "runtime", "version": "2", "digest": "f" * 64,
        })
        refused = client.post(f"/api/local/resources/install-requests/{changed}/provision", headers=headers,
                              json={"artifact": "tool", "confirm": True})
        assert refused.status_code == 409 and "changed after" in refused.json()["detail"]

        # A policy deny decides before anything is copied.
        denied = _approved_request(client, headers, "denied-tool", _sha(data))
        client.put("/api/local/policy", headers=headers, json={
            "scope": "global", "scopeId": "*", "capability": "resource.install.denied-tool", "effect": "deny",
        })
        blocked = client.post(f"/api/local/resources/install-requests/{denied}/provision", headers=headers,
                              json={"artifact": "tool", "confirm": True})
        assert blocked.status_code == 403
        assert client.get("/api/local/resources/store", headers=headers).json()["entries"] == []

        # A configuration-only definition has no artefact to provision.
        client.put("/api/local/resources/definitions/tools", headers=headers, json={
            "name": "tools", "kind": "mcp", "version": "1",
        })
        config_only = client.post("/api/local/resources/install-requests", headers=headers,
                                  json={"definition": "tools", "reason": "configure"}).json()["request"]["id"]
        client.post(f"/api/local/resources/install-requests/{config_only}/decision", headers=headers,
                    json={"decision": "approved"})
        assert client.post(f"/api/local/resources/install-requests/{config_only}/provision", headers=headers,
                           json={"artifact": "tool", "confirm": True}).status_code == 409

        # A rollback can be denied on its own capability.
        allowed = _approved_request(client, headers, "rollback-tool", _sha(data))
        assert client.post(f"/api/local/resources/install-requests/{allowed}/provision", headers=headers,
                           json={"artifact": "tool", "confirm": True}).status_code == 200
        client.put("/api/local/policy", headers=headers, json={
            "scope": "global", "scopeId": "*", "capability": "resource.rollback.rollback-tool", "effect": "deny",
        })
        assert client.post("/api/local/resources/store/rollback-tool/rollback", headers=headers,
                           json={"confirm": True}).status_code == 403
