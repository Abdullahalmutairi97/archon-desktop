"""Hard policy precedence: a narrower scope can never widen a denial."""
from __future__ import annotations

import json
import os
import stat
from pathlib import Path

import pytest

from archon_server.policy import PolicyLedger, PolicyUnavailable


def _ledger(tmp_path: Path) -> PolicyLedger:
    return PolicyLedger(tmp_path / "policy")


def test_a_broader_denial_cannot_be_widened_by_a_narrower_allow(tmp_path):
    ledger = _ledger(tmp_path)
    ledger.set(scope="global", scope_id="*", capability="secret:*", effect="deny",
                note="no brokered calls on this host")
    ledger.set(scope="agent", scope_id="local-uid:1000", capability="secret:*", effect="allow")

    decided = ledger.effective(capability="secret.tool.send", agent="local-uid:1000")
    assert decided["decision"] == "deny"
    # The broadest denial is the floor and explains the decision, whatever sits below it.
    assert decided["decidingEntry"]["scope"] == "global"
    assert "cannot widen a denial" in decided["reason"]
    assert "did not change it" in decided["reason"]
    # The chain and every matching entry are reported, so precedence is inspectable.
    assert [row["scope"] for row in decided["chain"]] == ["global", "agent"]
    assert {row["effect"] for row in decided["matches"]} == {"allow", "deny"}


def test_a_narrower_denial_narrows_a_broader_allow(tmp_path):
    ledger = _ledger(tmp_path)
    ledger.set(scope="global", scope_id="*", capability="secret:*", effect="allow")
    ledger.set(scope="workspace", scope_id="workspace-abc",
               capability="secret.reference.openai_key", effect="deny")

    denied = ledger.effective(capability="secret.reference.openai_key", workspace="workspace-abc")
    assert denied["decision"] == "deny" and denied["decidingEntry"]["scope"] == "workspace"
    # The narrower denial does not affect another reference in the same scope.
    allowed = ledger.effective(capability="secret.reference.other_key", workspace="workspace-abc")
    assert allowed["decision"] == "allow" and allowed["decidingEntry"]["scope"] == "global"
    # A scope that only has the broad allow still sees it.
    assert ledger.effective(capability="secret.reference.openai_key",
                            workspace="workspace-other")["decision"] == "allow"


def test_external_names_become_lowercase_capability_tokens(tmp_path):
    from archon_server.policy import capability_token, matches

    # A tool or reference name comes from outside, so it is namespaced as a token:
    # lower case, with anything that is not part of a token replaced.
    assert capability_token("Send/Receive") == "send-receive"
    assert capability_token("OPENAI_KEY") == "openai_key"
    with pytest.raises(ValueError):
        capability_token("   ")
    # Subtrees match at a separator boundary, so a prefix cannot capture a neighbour.
    assert matches("secret.tool.send", "secret:*")
    assert matches("secret.reference.openai_key", "secret:*")
    assert not matches("secrets.write", "secret:*")
    assert matches("files.write", "files.write")
    assert not matches("files.write.extra", "files.write")


def test_no_entry_is_unset_and_never_an_allow(tmp_path):
    ledger = _ledger(tmp_path)
    ledger.set(scope="global", scope_id="*", capability="files.write", effect="deny")
    unset = ledger.effective(capability="terminal.create", workspace="workspace-abc")
    assert unset["decision"] == "unset" and unset["decidingEntry"] is None
    assert "not an allow" in unset["note"]
    assert ledger.require(capability="terminal.create") is None
    assert ledger.require(capability="files.write")["decision"] == "deny"


def test_wildcards_match_by_suffix_and_exact_names_stay_exact(tmp_path):
    ledger = _ledger(tmp_path)
    ledger.set(scope="global", scope_id="*", capability="secret:*", effect="deny")
    ledger.set(scope="global", scope_id="*", capability="runtime.pi", effect="allow")
    assert ledger.effective(capability="secret.tool:x")["decision"] == "deny"
    assert ledger.effective(capability="runtime.pi")["decision"] == "allow"
    # `runtime:pi` is an exact name: it does not cover a longer runtime id.
    assert ledger.effective(capability="runtime.pi-native")["decision"] == "unset"
    assert any(row["scope"] == "global" for row in ledger.entries())


def test_entries_are_bounded_validated_replaced_and_removable(tmp_path):
    ledger = _ledger(tmp_path)
    with pytest.raises(ValueError):
        ledger.set(scope="everyone", scope_id="*", capability="secret:*", effect="deny")
    with pytest.raises(ValueError):
        ledger.set(scope="global", scope_id="*", capability="Bad Capability", effect="deny")
    with pytest.raises(ValueError):
        ledger.set(scope="global", scope_id="*", capability="secret:*", effect="maybe")

    ledger.set(scope="global", scope_id="*", capability="secret:*", effect="allow")
    ledger.set(scope="global", scope_id="*", capability="secret:*", effect="deny")
    assert len(ledger.entries()) == 1  # same scope/capability replaces
    assert ledger.effective(capability="secret.tool.send")["decision"] == "deny"

    ledger.remove(scope="global", scope_id="*", capability="secret:*")
    assert ledger.effective(capability="secret.tool.send")["decision"] == "unset"
    with pytest.raises(PolicyUnavailable):
        ledger.remove(scope="global", scope_id="*", capability="secret:*")

    assert stat.S_IMODE(os.stat(tmp_path / "policy" / "policy.json").st_mode) == 0o600
    assert stat.S_IMODE(os.stat(tmp_path / "policy").st_mode) == 0o700


def test_an_unsafe_or_tampered_policy_ledger_fails_closed(tmp_path):
    ledger = _ledger(tmp_path)
    ledger.set(scope="global", scope_id="*", capability="secret:*", effect="deny")
    path = tmp_path / "policy" / "policy.json"
    path.chmod(0o644)
    with pytest.raises(PolicyUnavailable):
        ledger.effective(capability="secret.tool.send")
    path.chmod(0o600)
    path.write_bytes(json.dumps({"version": 2, "entries": []}).encode())
    with pytest.raises(PolicyUnavailable):
        ledger.effective(capability="secret.tool.send")
    path.write_bytes(json.dumps({"version": 1, "entries": {}}).encode())
    with pytest.raises(PolicyUnavailable):
        ledger.effective(capability="secret.tool.send")


def test_policy_api_is_owner_only_and_explains_a_decision(tmp_path):
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
        assert client.get("/api/local/policy").status_code == 401
        assert client.put("/api/local/policy", headers=headers, json={
            "scope": "global", "scopeId": "*", "capability": "secret:*", "effect": "deny",
            "note": "no brokered calls",
        }).status_code == 201
        assert client.put("/api/local/policy", headers=headers, json={
            "scope": "agent", "scopeId": "local-uid:1", "capability": "secret:*", "effect": "allow",
        }).status_code == 201

        listing = client.get("/api/local/policy", headers=headers).json()
        assert listing["scopeOrder"] == ["global", "project", "workspace", "agent"]
        assert len(listing["entries"]) == 2

        decided = client.get("/api/local/policy/effective", headers=headers,
                             params={"capability": "secret.tool.send", "agent": "local-uid:1"}).json()
        assert decided["decision"] == "deny"
        assert decided["decidingEntry"]["scope"] == "global"
        assert "cannot widen a denial" in decided["reason"]
        assert client.get("/api/local/policy/effective", headers=headers,
                          params={"capability": "bad capability"}).status_code == 400
        assert client.delete("/api/local/policy", headers=headers,
                             params={"scope": "global", "scope_id": "*", "capability": "secret:*"}).status_code == 200
        assert client.delete("/api/local/policy", headers=headers,
                             params={"scope": "global", "scope_id": "*", "capability": "secret:*"}).status_code == 404


def test_a_denied_reference_is_refused_at_grant_minting_and_at_invocation(tmp_path):
    """The policy gate sits on the brokered path, and an unset policy changes nothing."""
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
        grant = {
            "reference": "example_api", "tool": "send", "arguments": {"path": "/v1/send"},
            "attemptId": "attempt-1", "workspaceId": "workspace-" + "a" * 32,
        }
        # An unset policy is not an allow: the request reaches the broker and is refused
        # there for its own reason, not by policy.
        unset = client.post("/api/local/secrets/grants", headers=headers, json=grant)
        assert unset.status_code in {404, 409, 503}
        assert "denied by" not in unset.text

        client.put("/api/local/policy", headers=headers, json={
            "scope": "global", "scopeId": "*", "capability": "secret.tool.send", "effect": "deny",
            "note": "no outbound sends",
        })
        denied = client.post("/api/local/secrets/grants", headers=headers, json=grant)
        assert denied.status_code == 403
        assert "denied by global:*" in denied.json()["detail"]

        # The same capability is checked again at invocation, so a grant minted before
        # the denial cannot be spent after it.
        invoked = client.post("/api/local/secrets/invoke", headers=headers, json={
            "grantToken": "g" * 32, "tool": "send", "arguments": {"path": "/v1/send"},
            "attemptId": "attempt-1",
        })
        assert invoked.status_code == 403
        assert "denied by global:*" in invoked.json()["detail"]

        # A wildcard denial covers the same call, and a narrower scope cannot re-open it.
        client.delete("/api/local/policy", headers=headers,
                      params={"scope": "global", "scope_id": "*", "capability": "secret.tool.send"})
        client.put("/api/local/policy", headers=headers, json={
            "scope": "global", "scopeId": "*", "capability": "secret:*", "effect": "deny",
        })
        client.put("/api/local/policy", headers=headers, json={
            "scope": "agent", "scopeId": "local-uid:1000", "capability": "secret:*", "effect": "allow",
        })
        still_denied = client.post("/api/local/secrets/grants", headers=headers, json=grant)
        assert still_denied.status_code == 403
        # The narrow allow is visible in the chain and still cannot re-open the denial.
        explained = client.get("/api/local/policy/effective", headers=headers,
                               params={"capability": "secret.tool.send", "agent": "local-uid:1000"}).json()
        assert explained["decision"] == "deny"
        assert {row["effect"] for row in explained["matches"]} == {"allow", "deny"}
        assert explained["decidingEntry"]["scope"] == "global"


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

def test_a_denied_capability_is_refused_on_every_gate_that_uses_the_helper(tmp_path):
    """The same helper guards terminals, services, file writes and runtime selection."""
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
        local_workspace_terminal_tmux_executable=str(_fake_tmux(tmp_path)),
    )
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    workspace_root.chmod(0o700)
    workspace_id = "workspace-" + "b" * 32
    with TestClient(create_app(settings)) as client:
        headers = _paired_owner_headers(settings.local_pairing_socket_path)
        client.app.state.store.db.create_workspace(
            workspace_id=workspace_id, root=str(workspace_root),
            owner_id=f"local-uid:{os.geteuid()}", project_id="project-policy",
            generation=1, isolation_profile="git-checkout",
        )
        file_body = {"path": "notes.txt", "content": "changed", "expected_content": "hello"}

        # With no policy entry every gate keeps its own behaviour.
        allowed = client.post(f"/api/workspaces/{workspace_id}/files/create", headers=headers,
                              json={"path": "notes.txt", "content": "hello"})
        assert allowed.status_code in {200, 201}, allowed.text

        denied_capabilities = ["files.create", "files.write", "terminal.create", "service.start"]
        for capability in denied_capabilities:
            client.put("/api/local/policy", headers=headers, json={
                "scope": "workspace", "scopeId": workspace_id, "capability": capability, "effect": "deny",
                "note": "blocked for this checkout",
            })
        client.put("/api/local/policy", headers=headers, json={
            "scope": "global", "scopeId": "*", "capability": "runtime.pi", "effect": "deny",
        })

        created = client.post(f"/api/workspaces/{workspace_id}/files/create", headers=headers,
                              json={"path": "second.txt", "content": "hello"})
        assert created.status_code == 403
        assert "denied by workspace:" in created.json()["detail"]

        written = client.post(f"/api/workspaces/{workspace_id}/files/write", headers=headers,
                              json=file_body)
        assert written.status_code == 403
        terminal = client.post(f"/api/local/workspaces/{workspace_id}/terminals", headers=headers,
                               json={"expectedGeneration": 1})
        assert terminal.status_code == 403
        started = client.post(f"/api/local/workspaces/{workspace_id}/services/anything/start",
                              headers=headers)
        assert started.status_code == 403
        # A denied runtime is refused at admission, before any task is stored.
        before = len(client.app.state.store.list(50))
        task = client.post("/api/tasks", headers=headers, json={
            "prompt": "run", "profile": "pi", "approval_mode": "auto",
        })
        assert task.status_code == 403
        assert "runtime.pi" in task.json()["detail"]
        assert len(client.app.state.store.list(50)) == before

        # A narrower allow cannot re-open what a broader scope denied.
        client.put("/api/local/policy", headers=headers, json={
            "scope": "agent", "scopeId": f"local-uid:{os.geteuid()}", "capability": "runtime.pi",
            "effect": "allow",
        })
        still_denied = client.post("/api/tasks", headers=headers, json={
            "prompt": "run", "profile": "pi", "approval_mode": "auto",
        })
        assert still_denied.status_code == 403


def _fake_tmux(tmp_path: Path) -> Path:
    script = tmp_path / "fake-tmux"
    script.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    script.chmod(0o755)
    return script

