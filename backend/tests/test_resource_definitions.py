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

def test_install_requests_are_recorded_and_never_claim_an_installation(tmp_path):
    from archon_server.resource_definitions import ResourceInstallRequestLedger

    definitions = _ledger(tmp_path)
    definitions.define(name="code-server", kind="runtime", version="4.139.1", digest=DIGEST)
    ledger = ResourceInstallRequestLedger(tmp_path / "requests")
    assert ledger.status()["installationPerformed"] is False
    assert "never an install" in ledger.status()["note"]

    with pytest.raises(ResourceDefinitionUnavailable):
        ledger.request(definition="missing", reason="please", requested_by="local-uid:1000",
                       definitions={"code-server"})
    with pytest.raises(ValueError):
        ledger.request(definition="code-server", reason="", requested_by="local-uid:1000",
                       definitions={"code-server"})
    with pytest.raises(ValueError):
        ledger.request(definition="code-server", reason="please", requested_by="local-uid:1000",
                       definitions={"code-server"}, scope_id="workspace-abc")

    row = ledger.request(definition="code-server", reason="pin the accepted IDE",
                         requested_by="local-uid:1000", definitions={"code-server"},
                         scope="workspace", scope_id="workspace-abc")
    assert row["state"] == "requested" and row["installationPerformed"] is False
    assert row["installedBy"] is None and row["id"].startswith("req-")

    approved = ledger.decide(request_id=row["id"], decision="approved",
                            decided_by="local-uid:1000", note="provision out of band")
    assert approved["state"] == "approved" and approved["installationPerformed"] is False
    # A second decision on the same request is refused, and nothing reports an install.
    with pytest.raises(ResourceDefinitionUnavailable):
        ledger.decide(request_id=row["id"], decision="rejected", decided_by="local-uid:1000")
    with pytest.raises(ResourceDefinitionUnavailable):
        ledger.decide(request_id="req-" + "0" * 16, decision="approved", decided_by="local-uid:1000")
    with pytest.raises(ValueError):
        ledger.decide(request_id=row["id"], decision="installed", decided_by="local-uid:1000")
    assert all(listing["state"] in {"requested", "approved", "rejected"} for listing in ledger.list())
    assert stat.S_IMODE(os.stat(tmp_path / "requests" / "install-requests.json").st_mode) == 0o600


def test_the_install_request_api_is_owner_only_and_never_reports_an_install(tmp_path):
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
        client.put("/api/local/resources/definitions/code-server", headers=headers, json={
            "name": "code-server", "kind": "runtime", "version": "4.139.1", "digest": DIGEST,
        })
        assert client.get("/api/local/resources/install-requests").status_code == 401
        assert client.post("/api/local/resources/install-requests", headers=headers, json={
            "definition": "not-recorded", "reason": "please",
        }).status_code == 409

        created = client.post("/api/local/resources/install-requests", headers=headers, json={
            "definition": "code-server", "reason": "provision the pinned IDE",
            "scope": "workspace", "scopeId": "workspace-abc",
        })
        assert created.status_code == 201, created.text
        assert created.json()["installationPerformed"] is False
        request_id = created.json()["request"]["id"]

        decided = client.post(f"/api/local/resources/install-requests/{request_id}/decision",
                              headers=headers, json={"decision": "approved", "note": "out of band"})
        assert decided.status_code == 200
        assert decided.json()["request"]["state"] == "approved"
        assert decided.json()["installationPerformed"] is False
        assert client.post(f"/api/local/resources/install-requests/{request_id}/decision",
                           headers=headers, json={"decision": "rejected"}).status_code == 409
        listed = client.get("/api/local/resources/install-requests", headers=headers).json()
        assert listed["installationPerformed"] is False
        assert listed["requests"][0]["state"] == "approved"
        # No row can report an installation: the ledger has no such state, and every
        # row says the server performed none.
        rows = listed["requests"]
        assert rows and all(row["state"] in {"requested", "approved", "rejected"} for row in rows)
        assert all(row["installationPerformed"] is False and row["installedBy"] is None for row in rows)

def test_verification_reports_what_the_host_measured_and_never_an_install(tmp_path):
    from archon_server.resource_definitions import ResourceInstallRequestLedger

    definitions = _ledger(tmp_path)
    definitions.define(name="code-server", kind="runtime", version="4.139.1", digest=DIGEST)
    definitions.define(name="tools", kind="mcp", version="1")
    ledger = ResourceInstallRequestLedger(tmp_path / "requests")
    runtime = ledger.request(definition="code-server", reason="provision", requested_by="local-uid:1000",
                             definitions={"code-server", "tools"})
    config_only = ledger.request(definition="tools", reason="configure", requested_by="local-uid:1000",
                                 definitions={"code-server", "tools"})

    # Verification requires an approved request, and a configuration-only definition has
    # no digest, so it can never be reported as provisioned.
    with pytest.raises(ResourceDefinitionUnavailable):
        ledger.verify(request_id=runtime["id"], definition_digest=DIGEST, present=True,
                      observed_digest=DIGEST)
    ledger.decide(request_id=config_only["id"], decision="approved", decided_by="local-uid:1000")
    assert ledger.verify(request_id=config_only["id"], definition_digest=None, present=True,
                         observed_digest=None)["verification"]["state"] == "unverifiable"

    ledger.decide(request_id=runtime["id"], decision="approved", decided_by="local-uid:1000")
    provisioned = ledger.verify(request_id=runtime["id"], definition_digest=DIGEST, present=True,
                                observed_digest=DIGEST, note="measured")
    assert provisioned["verification"]["state"] == "provisioned"
    assert provisioned["installationPerformed"] is False and provisioned["installedBy"] is None

    drifted = ledger.verify(request_id=runtime["id"], definition_digest=DIGEST, present=True,
                            observed_digest=OTHER_DIGEST)
    assert drifted["verification"]["state"] == "drifted"
    missing = ledger.verify(request_id=runtime["id"], definition_digest=DIGEST, present=False)
    assert missing["verification"]["state"] == "missing"
    # Nothing measured is unverifiable, never provisioned.
    unmeasured = ledger.verify(request_id=runtime["id"], definition_digest=DIGEST, present=None)
    assert unmeasured["verification"]["state"] == "unverifiable"
    assert "never an install" in ledger.status()["note"]

    with pytest.raises(ValueError):
        ledger.verify(request_id=runtime["id"], definition_digest="not-a-digest", present=True,
                      observed_digest=DIGEST)
    with pytest.raises(ResourceDefinitionUnavailable):
        ledger.verify(request_id="req-" + "0" * 16, definition_digest=DIGEST, present=True,
                      observed_digest=DIGEST)


def test_verifying_an_approved_request_reports_the_host_state_through_the_api(tmp_path):
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
        # A definition that names no measurable runtime on this host.
        client.put("/api/local/resources/definitions/unknown-tool", headers=headers, json={
            "name": "unknown-tool", "kind": "runtime", "version": "1", "digest": DIGEST,
        })
        created = client.post("/api/local/resources/install-requests", headers=headers, json={
            "definition": "unknown-tool", "reason": "provision the pinned tool",
        })
        assert created.status_code == 201
        request_id = created.json()["request"]["id"]
        assert client.post(f"/api/local/resources/install-requests/{request_id}/verify",
                           json={}).status_code == 401

        # Nothing to verify before the decision.
        assert client.post(f"/api/local/resources/install-requests/{request_id}/verify",
                           headers=headers, json={}).status_code == 409
        client.post(f"/api/local/resources/install-requests/{request_id}/decision",
                    headers=headers, json={"decision": "approved"})
        verified = client.post(f"/api/local/resources/install-requests/{request_id}/verify",
                               headers=headers, json={"note": "checked"})
        assert verified.status_code == 200, verified.text
        body = verified.json()
        assert body["installationPerformed"] is False
        # The artefact is not measurable on this host, so the state is honest about that
        # rather than reporting a successful provisioning.
        assert body["request"]["verification"]["state"] in {"unverifiable", "missing", "drifted"}
        assert body["request"]["verification"]["checkedAt"]
        assert body["request"]["installedBy"] is None
        unknown = client.post("/api/local/resources/install-requests/req-" + "0" * 16 + "/verify",
                              headers=headers, json={})
        assert unknown.status_code == 409

