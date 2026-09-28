"""Declarative resource definitions, assignments and effective configuration."""
from __future__ import annotations

import json
import os
import stat
from pathlib import Path

import pytest

from archon_server.resource_definitions import (
    ResourceDefinitionLedger,
    ResourceDefinitionUnavailable,
)

DIGEST = "c" * 64
OTHER_DIGEST = "d" * 64


def _ledger(tmp_path: Path) -> ResourceDefinitionLedger:
    return ResourceDefinitionLedger(tmp_path / "definitions")


def test_definitions_record_identity_and_require_a_digest_for_artefacts(tmp_path):
    ledger = _ledger(tmp_path)
    definition = ledger.define(
        name="code-server", kind="runtime", version="4.139.1", digest=DIGEST,
        source="/home/owner/.local/bin/code-server", licence="MIT", note="pinned IDE",
    )
    assert definition["digest"] == DIGEST and definition["history"] == []
    assert stat.S_IMODE(os.stat(tmp_path / "definitions" / "definitions.json").st_mode) == 0o600
    assert stat.S_IMODE(os.stat(tmp_path / "definitions").st_mode) == 0o700

    # An artefact kind without a digest is refused; a configuration-only kind is not.
    with pytest.raises(ValueError):
        ledger.define(name="prime", kind="runtime", version="0.9.6")
    ledger.define(name="filesystem-tools", kind="mcp", version="1")
    assert {row["name"] for row in ledger.definitions()} == {"code-server", "filesystem-tools"}

    # Updating the digest keeps the previous one as history, and only as a record.
    updated = ledger.define(name="code-server", kind="runtime", version="4.140.0", digest=OTHER_DIGEST)
    assert updated["history"] == [DIGEST]
    assert ledger.define(name="code-server", kind="runtime", version="4.140.0",
                         digest=OTHER_DIGEST)["history"] == [DIGEST]


def test_definitions_are_bounded_validated_and_fail_closed(tmp_path):
    ledger = _ledger(tmp_path)
    for kwargs in (
        {"name": "Bad Name", "kind": "runtime", "version": "1", "digest": DIGEST},
        {"name": "ok", "kind": "unknown", "version": "1", "digest": DIGEST},
        {"name": "ok", "kind": "tool", "version": "1", "digest": "not-a-digest"},
        {"name": "ok", "kind": "tool", "version": "has space"},
        {"name": "ok", "kind": "tool", "version": "1", "note": "x" * 300},
    ):
        with pytest.raises(ValueError):
            ledger.define(**kwargs)
    with pytest.raises(ResourceDefinitionUnavailable):
        ledger.remove("missing")

    # A tampered or malformed ledger is refused rather than partially trusted.
    ledger.define(name="tool-one", kind="tool", version="1")
    path = tmp_path / "definitions" / "definitions.json"
    path.chmod(0o644)
    with pytest.raises(ResourceDefinitionUnavailable):
        ledger.definitions()
    path.chmod(0o600)
    path.write_bytes(json.dumps({"version": 2, "definitions": {}}).encode())
    with pytest.raises(ResourceDefinitionUnavailable):
        ledger.definitions()


def test_assignments_must_name_a_recorded_definition_and_are_removable(tmp_path):
    ledger = _ledger(tmp_path)
    ledger.define(name="code-server", kind="runtime", version="4.139.1", digest=DIGEST)
    with pytest.raises(ResourceDefinitionUnavailable):
        ledger.assign(scope="workspace", scope_id="workspace-abc", definition="missing")
    with pytest.raises(ValueError):
        ledger.assign(scope="everyone", scope_id="workspace-abc", definition="code-server")

    assigned = ledger.assign(scope="workspace", scope_id="workspace-abc", definition="code-server",
                             note="project IDE")
    assert assigned["definition"] == "code-server"
    # A definition that is still assigned cannot be removed.
    with pytest.raises(ResourceDefinitionUnavailable):
        ledger.remove("code-server")
    ledger.unassign(scope="workspace", scope_id="workspace-abc")
    with pytest.raises(ResourceDefinitionUnavailable):
        ledger.unassign(scope="workspace", scope_id="workspace-abc")
    ledger.remove("code-server")
    assert ledger.definitions() == []


def test_effective_configuration_prefers_the_narrowest_scope_and_reports_drift(tmp_path):
    ledger = _ledger(tmp_path)
    ledger.define(name="ide", kind="runtime", version="4.139.1", digest=DIGEST)
    ledger.define(name="yaml", kind="extension", version="1.2.3", digest=OTHER_DIGEST)
    ledger.define(name="tools", kind="mcp", version="1")
    ledger.assign(scope="project", scope_id="project-1", definition="ide")
    ledger.assign(scope="project", scope_id="project-1", definition="yaml")
    ledger.assign(scope="workspace", scope_id="workspace-abc", definition="ide")
    ledger.assign(scope="agent", scope_id="prime", definition="tools")

    effective = ledger.effective(
        agent="prime", workspace="workspace-abc", project="project-1",
        observed={"ide": DIGEST, "yaml": "e" * 64},
    )
    by_name = {row["name"]: row for row in effective["definitions"]}
    # `ide` is assigned at two scopes and appears once, from the narrower scope.
    assert [row["name"] for row in effective["definitions"]] == ["tools", "ide", "yaml"]
    assert by_name["ide"]["scope"] == "workspace" and by_name["ide"]["state"] == "current"
    assert by_name["yaml"]["state"] == "drifted" and by_name["yaml"]["observedDigest"] == "e" * 64
    assert by_name["tools"]["state"] == "configuration-only"
    assert "not evidence that a runtime loaded the definition" in effective["note"]

    # Nothing measured yet is unobserved, never current.
    unobserved = ledger.effective(agent="prime", workspace="workspace-abc", project="project-1",
                                  observed={})
    assert {row["state"] for row in unobserved["definitions"]} == {"unobserved", "configuration-only"}

    with pytest.raises(ValueError):
        ledger.effective(workspace="has space")


def test_definitions_assignments_and_effective_configuration_api(tmp_path):
    from fastapi.testclient import TestClient

    from archon_server.app import create_app
    from archon_server.config import Settings

    settings = Settings(
        archon_root=tmp_path,
        hermes_home=tmp_path / ".hermes",
        data_dir=tmp_path / ".data",
        auth_token="legacy-token",
        local_owner_mode=True,
        start_worker=False,
    )
    with TestClient(create_app(settings)) as client:
        headers = _paired_owner_headers(settings.local_pairing_socket_path)
        assert client.get("/api/local/resources/definitions").status_code == 401
        created = client.put("/api/local/resources/definitions/code-server", headers=headers, json={
            "name": "code-server", "kind": "runtime", "version": "4.139.1", "digest": DIGEST,
            "licence": "MIT",
        })
        assert created.status_code == 201 and created.json()["definition"]["kind"] == "runtime"
        assert client.put("/api/local/resources/definitions/other", headers=headers, json={
            "name": "different", "kind": "runtime", "version": "1", "digest": DIGEST,
        }).status_code == 400
        assert client.put("/api/local/resources/definitions/missing-digest", headers=headers, json={
            "name": "missing-digest", "kind": "runtime", "version": "1",
        }).status_code == 400

        assigned = client.put("/api/local/resources/assignments/workspace/workspace-abc",
                              headers=headers, json={"definition": "code-server"})
        assert assigned.status_code == 201
        assert client.put("/api/local/resources/assignments/workspace/workspace-abc",
                          headers=headers, json={"definition": "not-recorded"}).status_code == 409
        assert client.delete("/api/local/resources/definitions/code-server",
                             headers=headers).status_code == 409
        listing = client.get("/api/local/resources/assignments", headers=headers).json()
        assert listing["assignments"][0]["scopeId"] == "workspace-abc"

        effective = client.get("/api/local/resources/effective", headers=headers,
                               params={"workspace_id": "workspace-abc"}).json()
        row = effective["definitions"][0]
        assert row["name"] == "code-server" and row["scope"] == "workspace"
        assert row["state"] in {"unobserved", "current", "drifted"}
        assert client.get("/api/local/resources/effective", headers=headers,
                          params={"workspace_id": "bad id"}).status_code == 400
        assert client.delete("/api/local/resources/assignments/workspace/workspace-abc",
                             headers=headers).status_code == 200
        assert client.delete("/api/local/resources/definitions/code-server",
                             headers=headers).status_code == 200


def test_the_attempt_snapshot_carries_the_effective_definitions(tmp_path):
    from archon_server.resource_snapshots import ResourceSnapshotStore

    store = ResourceSnapshotStore(tmp_path / "attempts")
    record = store.record(
        task_id="task-1", attempt_id="attempt-1", runtime_id="prime",
        manifests=[{"id": "prime", "available": True, "executable_digest": DIGEST}],
        definitions=[{
            "name": "prime-runtime", "kind": "runtime", "version": "0.9.6", "digest": DIGEST,
            "observedDigest": DIGEST, "state": "current", "scope": "agent", "scopeId": "prime",
        }, {
            "name": "tools", "kind": "mcp", "version": "1", "digest": None,
            "observedDigest": None, "state": "configuration-only", "scope": "project",
            "scopeId": "project-1",
        }],
    )
    assert [row["name"] for row in record["definitions"]] == ["prime-runtime", "tools"]
    assert record["definitions"][0]["state"] == "current"
    read_back = store.read("task-1", "attempt-1")
    assert read_back["definitions"] == record["definitions"]

    # An unknown state is not trusted from disk; it is reported as unobserved.
    path = tmp_path / "attempts" / "task-1__attempt-1.json"
    document = json.loads(path.read_bytes())
    document["definitions"][0]["state"] = "invented"
    path.write_bytes(json.dumps(document).encode())
    assert store.read("task-1", "attempt-1")["definitions"][0]["state"] == "unobserved"


def _paired_owner_headers(socket_path: Path) -> dict[str, str]:
    """Self-contained pairing helper: CI runs pytest where `tests` is not a package."""
    import socket as _socket

    from archon_server.local_pairing import LOCAL_PAIRING_AUDIENCE

    with _socket.socket(_socket.AF_UNIX, _socket.SOCK_STREAM) as connection:
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
