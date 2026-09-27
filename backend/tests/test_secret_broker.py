"""Secret broker: grants, binding denials, redaction and containment."""
from __future__ import annotations

import hashlib
import json
import os
import socket
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from archon_server.app import create_app
from archon_server.child_env import CHILD_ENV_SCOPES, build_child_env
from archon_server.config import Settings
from archon_server.local_pairing import LOCAL_PAIRING_AUDIENCE
from archon_server.secret_broker import (
    _MAX_RESPONSE_BYTES,
    _default_transport,
    EnvironmentSecretSource,
    SecretBroker,
    SecretBrokerError,
    SecretBrokerUnavailable,
    SecretGrantRejected,
    SecretReferenceExists,
    SecretReferenceUnknown,
    SecretTransportError,
    SecretValueUnavailable,
    SecretWorkspaceUnknown,
    action_digest,
)

WORKSPACE_ID = "workspace-0123456789abcdef0123456789abcdef"
OTHER_WORKSPACE_ID = "workspace-fedcba9876543210fedcba9876543210"
SECRET_VALUE = "sk-live-test-only-4f8c1c2b"
SOURCE_KEY = "ARCHON_TEST_PROVIDER_KEY"
TOOL = "provider.chat"
ATTEMPT = "attempt-3f2a91"
PRINCIPAL = "local-uid:1000"
ARGUMENTS = {
    "method": "POST",
    "path": "/v1/chat/completions",
    "body": {"model": "deepseek-flash", "stream": False},
}


class _Source:
    """Stand-in for a process environment that holds the credential."""

    def __init__(self, values: dict[str, str]):
        self._values = dict(values)

    def read(self, source_key: str) -> str | None:
        return self._values.get(source_key)


class _Clock:
    def __init__(self) -> None:
        self.now = datetime(2026, 1, 1, tzinfo=timezone.utc)

    def __call__(self) -> datetime:
        return self.now

    def advance(self, seconds: int) -> None:
        self.now += timedelta(seconds=seconds)


def _echo_transport(seen: dict | None = None):
    """Return 200 with the request headers echoed, so injection is observable."""

    def transport(request: dict) -> dict:
        if seen is not None:
            seen.update(request)
        return {
            "status": 200,
            "headers": {"content-type": "application/json", "set-cookie": "session=ignored"},
            "body": json.dumps({"echo": request["headers"]}).encode("utf-8"),
            "truncated": False,
        }

    return transport


def _broker(tmp_path, *, transport, values=None, generations=None, clock=None, **kwargs) -> SecretBroker:
    return SecretBroker(
        tmp_path / "secret-broker",
        values=_Source({SOURCE_KEY: SECRET_VALUE} if values is None else values),
        generation_lookup=lambda workspace_id: (generations or {WORKSPACE_ID: 4}).get(workspace_id),
        transport=transport or _echo_transport(),
        now=clock,
        **kwargs,
    )


def _mint(broker: SecretBroker, **overrides) -> dict:
    request = {
        "principal": PRINCIPAL,
        "reference": "provider-api",
        "tool": TOOL,
        "arguments": ARGUMENTS,
        "attempt_id": ATTEMPT,
        "workspace_id": WORKSPACE_ID,
    }
    request.update(overrides)
    return broker.mint_grant(**request)


def _register(broker: SecretBroker, **overrides) -> dict:
    request = {
        "provider": "deepseek",
        "purpose": "provider api",
        "source_key": SOURCE_KEY,
        "endpoint": "https://api.deepseek.com",
    }
    name = overrides.pop("reference", "provider-api")
    request.update(overrides)
    return broker.register_reference(name, **request)


def _invoke(broker: SecretBroker, grant_token: str, **overrides) -> dict:
    request = {
        "grant_token": grant_token,
        "principal": PRINCIPAL,
        "tool": TOOL,
        "arguments": ARGUMENTS,
        "attempt_id": ATTEMPT,
    }
    request.update(overrides)
    return broker.invoke(**request)


# -- references -------------------------------------------------------------


def test_reference_registration_is_metadata_only(tmp_path):
    broker = _broker(tmp_path, transport=_echo_transport())
    registered = _register(broker)
    assert registered["provider"] == "deepseek"
    assert registered["endpoint"] == "https://api.deepseek.com"
    assert registered["sourceKey"] == SOURCE_KEY

    ledger = (tmp_path / "secret-broker" / "secrets.json").read_bytes()
    assert SECRET_VALUE.encode() not in ledger
    assert os.stat(tmp_path / "secret-broker" / "secrets.json").st_mode & 0o777 == 0o600
    assert os.stat(tmp_path / "secret-broker").st_mode & 0o777 == 0o700
    assert SECRET_VALUE not in json.dumps(broker.list_references())

    with pytest.raises(SecretReferenceExists):
        _register(broker)
    with pytest.raises(ValueError):
        _register(broker, reference="provider-api-two", source_key="lowercase")
    with pytest.raises(SecretReferenceExists):
        _register(broker, reference="provider-api")


def test_endpoint_must_be_a_bare_https_origin(tmp_path):
    broker = _broker(tmp_path, transport=_echo_transport())
    for endpoint in (
        "http://api.deepseek.com",
        "https://user:pass@api.deepseek.com",
        "https://api.deepseek.com/v1",
        "https://api.deepseek.com?key=1",
        "https://api.deepseek.com#fragment",
        "not a url",
    ):
        with pytest.raises(ValueError):
            _register(broker, endpoint=endpoint)
    with pytest.raises(ValueError):
        _register(broker, auth_header="cookie")


# -- grants -----------------------------------------------------------------


def test_grant_binding_denies_other_principal_tool_arguments_and_attempt(tmp_path):
    broker = _broker(tmp_path, transport=_echo_transport())
    _register(broker)
    minted = _mint(broker)
    token = minted["grantToken"]
    assert minted["grant"]["workspaceGeneration"] == 4
    assert minted["grant"]["epoch"] == 1

    with pytest.raises(SecretGrantRejected) as principal_error:
        _invoke(broker, token, principal="local-uid:1001")
    assert (principal_error.value.reason, principal_error.value.status) == ("principal_mismatch", 403)

    with pytest.raises(SecretGrantRejected) as tool_error:
        _invoke(broker, token, tool="provider.other")
    assert (tool_error.value.reason, tool_error.value.status) == ("tool_mismatch", 403)

    other_arguments = {**ARGUMENTS, "body": {"model": "deepseek-flash", "stream": True}}
    with pytest.raises(SecretGrantRejected) as arguments_error:
        _invoke(broker, token, arguments=other_arguments)
    assert (arguments_error.value.reason, arguments_error.value.status) == ("arguments_mismatch", 403)

    with pytest.raises(SecretGrantRejected) as attempt_error:
        _invoke(broker, token, attempt_id="attempt-other")
    assert (attempt_error.value.reason, attempt_error.value.status) == ("attempt_mismatch", 403)

    # A denied decision does not consume the grant; the exact binding still works.
    result = _invoke(broker, token)
    assert result["ok"] is True and result["status"] == 200

    # The audit trail reads newest first.
    reasons = [entry["reason"] for entry in broker.audit(32) if entry["decision"] == "denied"]
    assert reasons == ["attempt_mismatch", "arguments_mismatch", "tool_mismatch", "principal_mismatch"]


def test_grant_is_single_use_and_replay_is_reported(tmp_path):
    broker = _broker(tmp_path, transport=_echo_transport())
    _register(broker)
    token = _mint(broker)["grantToken"]
    assert _invoke(broker, token)["ok"] is True
    with pytest.raises(SecretGrantRejected) as replay:
        _invoke(broker, token)
    assert (replay.value.reason, replay.value.status) == ("replayed_grant", 409)
    with pytest.raises(SecretGrantRejected) as unknown:
        _invoke(broker, "not-a-real-grant-token-value")
    assert (unknown.value.reason, unknown.value.status) == ("unknown_grant", 404)


def test_expired_stale_epoch_and_stale_generation_are_denied(tmp_path):
    clock = _Clock()
    generations = {WORKSPACE_ID: 4}
    broker = _broker(tmp_path, transport=_echo_transport(), clock=clock, generations=generations)
    _register(broker)

    expired = _mint(broker, ttl_seconds=5)["grantToken"]
    clock.advance(6)
    with pytest.raises(SecretGrantRejected) as expired_error:
        _invoke(broker, expired)
    assert (expired_error.value.reason, expired_error.value.status) == ("expired_grant", 403)

    # Revoking a reference drops its own grants, so a later attempt is unknown.
    revoked = _mint(broker)["grantToken"]
    assert broker.revoke_reference("provider-api")["epoch"] == 2
    with pytest.raises(SecretGrantRejected) as dropped:
        _invoke(broker, revoked)
    assert (dropped.value.reason, dropped.value.status) == ("unknown_grant", 404)
    with pytest.raises(SecretReferenceUnknown):
        _mint(broker)
    with pytest.raises(SecretReferenceUnknown):
        broker.revoke_reference("provider-api")

    # Any revocation bumps the epoch, which invalidates unrelated live grants too.
    _register(broker)
    _register(broker, reference="other-api", provider="other", endpoint="https://api.example.com")
    unrelated = _mint(broker)["grantToken"]
    assert broker.revoke_reference("other-api")["epoch"] == 3
    with pytest.raises(SecretGrantRejected) as stale_epoch:
        _invoke(broker, unrelated)
    assert (stale_epoch.value.reason, stale_epoch.value.status) == ("stale_epoch", 403)

    moved = _mint(broker)["grantToken"]
    generations[WORKSPACE_ID] = 5
    with pytest.raises(SecretGrantRejected) as stale_generation:
        _invoke(broker, moved)
    assert (stale_generation.value.reason, stale_generation.value.status) == ("stale_generation", 403)


def test_generation_and_ttl_are_validated(tmp_path):
    broker = _broker(tmp_path, transport=_echo_transport())
    _register(broker)
    with pytest.raises(SecretWorkspaceUnknown):
        _mint(broker, workspace_id=OTHER_WORKSPACE_ID)
    with pytest.raises(ValueError):
        _mint(broker, workspace_id="not-a-workspace")
    for ttl in (1, 901, True, "120"):
        with pytest.raises(ValueError):
            _mint(broker, ttl_seconds=ttl)
    with pytest.raises(ValueError):
        _mint(broker, delegate_principal="bad principal")


def test_delegate_grant_is_bound_to_its_principal(tmp_path):
    broker = _broker(tmp_path, transport=_echo_transport())
    _register(broker)
    delegate = "runner-" + "a" * 32
    minted = _mint(broker, delegate_principal=delegate)
    with pytest.raises(SecretGrantRejected) as owner_error:
        _invoke(broker, minted["grantToken"])
    assert owner_error.value.reason == "principal_mismatch"
    assert _invoke(broker, minted["grantToken"], principal=delegate)["ok"] is True


# -- value handling ---------------------------------------------------------


def test_missing_value_fails_closed_and_reports_unavailable(tmp_path):
    broker = _broker(tmp_path, transport=_echo_transport(), values={})
    _register(broker)
    assert broker.auth_states()["providers"][0]["state"] == "unavailable"
    token = _mint(broker)["grantToken"]
    with pytest.raises(SecretValueUnavailable):
        _invoke(broker, token)
    with pytest.raises(SecretGrantRejected) as replay:
        _invoke(broker, token)
    assert replay.value.reason == "replayed_grant"
    assert [entry["reason"] for entry in broker.audit(2)] == ["replayed_grant", "value_unavailable"]
    assert broker.auth_states()["providers"][0]["lastFailureReason"] == "value_unavailable"


def test_upstream_injection_is_redacted_from_the_result(tmp_path):
    seen: dict = {}
    broker = _broker(tmp_path, transport=_echo_transport(seen))
    _register(broker)
    result = _invoke(broker, _mint(broker)["grantToken"])

    assert seen["headers"]["authorization"] == f"Bearer {SECRET_VALUE}"
    assert seen["url"] == "https://api.deepseek.com/v1/chat/completions"
    assert seen["headers"]["content-type"] == "application/json"
    assert SECRET_VALUE not in json.dumps(result)
    assert result["body"]["echo"]["authorization"] == "Bearer [REDACTED]"
    assert result["redacted"] is True
    assert result["headers"] == {"content-type": "application/json"}
    assert result["ok"] is True
    assert broker.auth_states()["providers"][0]["state"] == "verified"


def test_upstream_failure_consumes_the_grant_and_redacts_the_error(tmp_path):
    def failing(_request: dict) -> dict:
        raise RuntimeError(f"connection reset for {SECRET_VALUE}")

    broker = _broker(tmp_path, transport=failing)
    _register(broker)
    token = _mint(broker)["grantToken"]
    with pytest.raises(SecretTransportError) as error:
        _invoke(broker, token)
    assert SECRET_VALUE not in str(error.value)
    assert "[REDACTED]" in str(error.value)
    with pytest.raises(SecretGrantRejected) as replay:
        _invoke(broker, token)
    assert replay.value.reason == "replayed_grant"
    state = broker.auth_states()["providers"][0]
    assert (state["state"], state["lastFailureReason"]) == ("unverified", "upstream_error")


def test_upstream_status_below_200_is_not_verified(tmp_path):
    broker = _broker(tmp_path, transport=lambda request: {
        "status": 401, "headers": {"content-type": "application/json"},
        "body": b'{"error": {"message": "invalid key"}}', "truncated": False,
    })
    _register(broker)
    result = _invoke(broker, _mint(broker)["grantToken"])
    assert result["ok"] is False and result["status"] == 401
    assert broker.audit(1)[0]["reason"] == "upstream_status"
    assert broker.auth_states()["providers"][0]["state"] == "unverified"


def test_request_shape_is_bounded(tmp_path):
    broker = _broker(tmp_path, transport=_echo_transport())
    _register(broker)
    token = _mint(broker)["grantToken"]
    for arguments in (
        {"method": "TRACE", "path": "/v1/x"},
        {"method": "GET", "path": "v1/x"},
        {"method": "GET", "path": "//evil.example/x"},
        {"method": "GET", "path": "/v1/../../etc/passwd"},
        {"method": "GET", "path": "/v1/x", "headers": {"authorization": "Bearer stolen"}},
        {"method": "GET", "path": "/v1/x", "headers": {"host": "evil.example"}},
        {"method": "GET", "path": "/v1/x", "extra": True},
        {"method": "GET", "path": "/v1/x", "body": {"blob": "x" * 70000}},
        {"method": "GET", "path": "/v1/x", "body": {"nested": {1, 2}}},
    ):
        with pytest.raises(ValueError):
            _invoke(broker, token, arguments=arguments)
    assert _invoke(broker, token)["ok"] is True


def test_upstream_redirect_is_not_verified_and_never_forwarded(tmp_path):
    """A 3xx is not a completed call, and policy headers never reach the caller."""
    broker = _broker(tmp_path, transport=lambda request: {
        "status": 302,
        "headers": {"content-type": "text/html", "location": "https://evil.example/collect"},
        "body": b"<html>moved</html>",
        "truncated": False,
    })
    _register(broker)
    result = _invoke(broker, _mint(broker)["grantToken"])
    assert result["ok"] is False and result["status"] == 302
    assert result["headers"] == {"content-type": "text/html"}
    assert "evil.example" not in json.dumps(result)
    assert broker.audit(1)[0]["reason"] == "upstream_redirect"
    assert broker.auth_states()["providers"][0]["state"] == "unverified"


def test_default_transport_neither_follows_a_redirect_nor_reads_past_the_bound():
    """Exercise the real transport: no redirect following, bounded body reads."""
    import http.server
    import threading

    hits: list[str] = []
    oversized = b"a" * (_MAX_RESPONSE_BYTES + 4096)

    class _Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_args):  # keep the test output clean
            return

        def do_GET(self):  # noqa: N802 - stdlib naming
            hits.append(self.path)
            if self.path == "/moved":
                self.send_response(302)
                self.send_header("Location", f"http://127.0.0.1:{self.server.server_port}/collect")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(oversized)))
            self.end_headers()
            self.wfile.write(oversized)

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        origin = f"http://127.0.0.1:{server.server_port}"
        redirected = _default_transport({
            "method": "GET", "url": origin + "/moved", "headers": {}, "body": None, "timeoutSeconds": 5.0,
        })
        assert redirected["status"] == 302
        assert hits == ["/moved"], "the transport must not follow a redirect"

        bounded = _default_transport({
            "method": "GET", "url": origin + "/collect", "headers": {}, "body": None, "timeoutSeconds": 5.0,
        })
        assert bounded["status"] == 200
        assert len(bounded["body"]) == _MAX_RESPONSE_BYTES and bounded["truncated"] is True
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_grant_token_is_never_persisted_in_the_ledger(tmp_path):
    broker = _broker(tmp_path, transport=_echo_transport())
    _register(broker)
    token = _mint(broker)["grantToken"]
    ledger = (tmp_path / "secret-broker" / "secrets.json").read_bytes()
    assert token.encode() not in ledger
    assert hashlib.sha256(token.encode()).hexdigest().encode() in ledger
    assert SECRET_VALUE.encode() not in ledger
    _invoke(broker, token)
    assert token.encode() not in (tmp_path / "secret-broker" / "secrets.json").read_bytes()


# -- ledger -----------------------------------------------------------------


def test_ledger_is_private_and_rejects_tampering(tmp_path):
    broker = _broker(tmp_path, transport=_echo_transport())
    _register(broker)
    path = tmp_path / "secret-broker" / "secrets.json"
    path.chmod(0o644)
    with pytest.raises(SecretBrokerUnavailable):
        broker.list_references()
    path.chmod(0o600)
    path.write_bytes(b'{"version": 1, "epoch": 1}')
    with pytest.raises(SecretBrokerUnavailable):
        broker.list_references()
    path.write_bytes(b"not json")
    with pytest.raises(SecretBrokerUnavailable):
        broker.list_references()
    assert SecretBroker(tmp_path / "fresh-broker", values=_Source({})).list_references() == []


def test_audit_is_bounded_and_carries_no_values(tmp_path):
    broker = _broker(tmp_path, transport=_echo_transport(), max_audit=8)
    _register(broker)
    for index in range(12):
        with pytest.raises(SecretGrantRejected):
            _invoke(broker, f"unknown-grant-token-{index:04d}")
    entries = broker.audit(8)
    assert len(entries) == 8
    assert all(entry["decision"] == "denied" and entry["reason"] == "unknown_grant" for entry in entries)
    assert SECRET_VALUE not in json.dumps(entries)
    assert SECRET_VALUE.encode() not in (tmp_path / "secret-broker" / "secrets.json").read_bytes()
    with pytest.raises(ValueError):
        broker.audit(0)


def test_action_digest_binds_tool_and_arguments():
    first = action_digest(TOOL, {"b": 1, "a": [1, {"z": True}]})
    assert first == action_digest(TOOL, {"a": [1, {"z": True}], "b": 1})
    assert first != action_digest("provider.other", {"a": 1, "b": [1, {"z": True}]})
    assert first != action_digest(TOOL, {"a": [1, {"z": False}], "b": 1})
    assert len(first) == 64
    with pytest.raises(ValueError):
        action_digest("bad tool!", {})
    with pytest.raises(ValueError):
        action_digest(TOOL, {"value": float("nan")})


def test_environment_source_never_exposes_a_blank_value():
    source = EnvironmentSecretSource({SOURCE_KEY: SECRET_VALUE, "ARCHON_TEST_BLANK_KEY": "  "})
    assert source.read(SOURCE_KEY) == SECRET_VALUE
    assert source.read("ARCHON_TEST_BLANK_KEY") is None
    assert source.read("ARCHON_TEST_ABSENT_KEY") is None


def test_child_environments_never_receive_a_broker_source_key():
    for scope in sorted(CHILD_ENV_SCOPES):
        child_env = build_child_env(scope, source={SOURCE_KEY: SECRET_VALUE, "PATH": "/usr/bin"}, overrides={})
        assert SOURCE_KEY not in child_env
        assert SECRET_VALUE not in json.dumps(child_env)


def test_broker_constructor_bounds(tmp_path):
    for kwargs in (
        {"max_ttl_seconds": 1},
        {"max_ttl_seconds": 4000},
        {"max_references": 0},
        {"max_grants": 0},
        {"max_audit": 0},
        {"timeout_seconds": 0},
        {"timeout_seconds": 60},
    ):
        with pytest.raises(ValueError):
            SecretBroker(tmp_path / "bounded", values=_Source({}), **kwargs)
    with pytest.raises(ValueError):
        SecretBroker("relative/path", values=_Source({}))


def test_grant_capacity_fails_closed(tmp_path):
    broker = _broker(tmp_path, transport=_echo_transport(), max_grants=2)
    _register(broker)
    _mint(broker)
    _mint(broker)
    with pytest.raises(SecretBrokerError):
        _mint(broker)


# -- HTTP surface -----------------------------------------------------------


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


def _owner_client(tmp_path, monkeypatch, transport):
    monkeypatch.setenv(SOURCE_KEY, SECRET_VALUE)
    settings = Settings(
        archon_root=tmp_path,
        hermes_home=tmp_path / ".hermes",
        data_dir=tmp_path / ".data",
        auth_token="legacy-token",
        local_owner_mode=True,
        start_worker=False,
    )
    client = TestClient(create_app(settings, secret_transport=transport))
    return client, settings


REFERENCE_BODY = {
    "reference": "provider-api",
    "provider": "deepseek",
    "purpose": "provider api",
    "sourceKey": SOURCE_KEY,
    "endpoint": "https://api.deepseek.com",
}


def test_secret_broker_api_contract(tmp_path, monkeypatch):
    seen: dict = {}
    client, settings = _owner_client(tmp_path, monkeypatch, _echo_transport(seen))
    with client:
        headers = _paired_owner_headers(settings.local_pairing_socket_path)
        workspace_id = "workspace-" + "b" * 32
        (tmp_path / "checkout").mkdir()
        client.app.state.store.db.create_workspace(
            workspace_id=workspace_id,
            root=str(tmp_path / "checkout"),
            owner_id=f"local-uid:{os.geteuid()}",
            project_id="project-secret",
            generation=2,
            isolation_profile="git-checkout",
        )

        assert client.get("/api/local/secrets/references").status_code == 401
        assert client.get("/api/local/secrets/references", headers=headers).json() == {
            "references": [], "epoch": 1,
        }
        registered = client.post("/api/local/secrets/references", headers=headers, json=REFERENCE_BODY)
        assert registered.status_code == 201
        assert SECRET_VALUE not in registered.text
        assert client.post("/api/local/secrets/references", headers=headers, json=REFERENCE_BODY).status_code == 409

        states = client.get("/api/local/secrets/auth-states", headers=headers)
        assert states.status_code == 200
        assert states.json()["providers"][0]["state"] == "unverified"
        assert states.json()["secretValuesExposed"] is False

        grant_body = {
            "reference": "provider-api",
            "tool": TOOL,
            "arguments": ARGUMENTS,
            "attemptId": ATTEMPT,
            "workspaceId": workspace_id,
        }
        minted = client.post("/api/local/secrets/grants", headers=headers, json=grant_body)
        assert minted.status_code == 201
        grant_token = minted.json()["grantToken"]
        assert minted.json()["grant"]["workspaceGeneration"] == 2
        assert SECRET_VALUE not in minted.text

        invoke_body = {"grantToken": grant_token, "tool": TOOL, "arguments": ARGUMENTS, "attemptId": ATTEMPT}
        invoked = client.post("/api/local/secrets/invoke", headers=headers, json=invoke_body)
        assert invoked.status_code == 200
        assert invoked.json()["ok"] is True and invoked.json()["redacted"] is True
        assert SECRET_VALUE not in invoked.text
        assert seen["headers"]["authorization"] == f"Bearer {SECRET_VALUE}"

        replayed = client.post("/api/local/secrets/invoke", headers=headers, json=invoke_body)
        assert replayed.status_code == 409
        assert replayed.json()["reason"] == "replayed_grant"

        assert client.post("/api/local/secrets/invoke", headers=headers, json={
            **invoke_body, "grantToken": "another-unknown-grant-token", "attemptId": "attempt-other-1",
        }).status_code == 404

        audit = client.get("/api/local/secrets/audit?limit=8", headers=headers)
        assert audit.status_code == 200
        decisions = [entry["decision"] for entry in audit.json()["audit"]]
        assert "allowed" in decisions and "denied" in decisions
        assert SECRET_VALUE not in audit.text

        states = client.get("/api/local/secrets/auth-states", headers=headers).json()
        assert states["providers"][0]["state"] == "verified"

        unknown_workspace = client.post("/api/local/secrets/grants", headers=headers, json={
            **grant_body, "workspaceId": "workspace-" + "c" * 32,
        })
        assert unknown_workspace.status_code == 404

        revoked = client.request("DELETE", "/api/local/secrets/references/provider-api", headers=headers)
        assert revoked.status_code == 200 and revoked.json()["epoch"] == 2
        assert client.post("/api/local/secrets/grants", headers=headers, json=grant_body).status_code == 404
        assert client.request("DELETE", "/api/local/secrets/references/provider-api", headers=headers).status_code == 404

        ledger = (tmp_path / ".data" / "secret-broker" / "secrets.json").read_bytes()
        assert SECRET_VALUE.encode() not in ledger


def test_secret_broker_api_requires_the_owner_credential(tmp_path, monkeypatch):
    client, _settings = _owner_client(tmp_path, monkeypatch, _echo_transport())
    with client:
        assert client.post("/api/local/secrets/grants", json={}).status_code == 401
        assert client.post("/api/local/secrets/invoke", json={}).status_code == 401
        assert client.get("/api/local/secrets/audit").status_code == 401
        assert client.get("/api/local/secrets/auth-states").status_code == 401


def test_runner_delegate_can_redeem_only_its_own_grant(tmp_path, monkeypatch):
    seen: dict = {}
    client, settings = _owner_client(tmp_path, monkeypatch, _echo_transport(seen))
    with client:
        headers = _paired_owner_headers(settings.local_pairing_socket_path)
        workspace_id = "workspace-" + "d" * 32
        (tmp_path / "checkout").mkdir()
        client.app.state.store.db.create_workspace(
            workspace_id=workspace_id,
            root=str(tmp_path / "checkout"),
            owner_id=f"local-uid:{os.geteuid()}",
            project_id="project-delegate",
            generation=1,
            isolation_profile="git-checkout",
        )
        client.post("/api/local/secrets/references", headers=headers, json=REFERENCE_BODY)
        enrolled = client.post("/api/local/runners", headers=headers, json={"name": "runner-one"})
        assert enrolled.status_code == 201
        runner = enrolled.json()["runner"]
        runner_secret = runner["secret"]
        runner_headers = {"Authorization": f"Bearer {runner_secret}"}

        grant_body = {
            "reference": "provider-api",
            "tool": TOOL,
            "arguments": ARGUMENTS,
            "attemptId": ATTEMPT,
            "workspaceId": workspace_id,
        }
        delegated = client.post("/api/local/secrets/grants", headers=headers, json={
            **grant_body, "delegatePrincipal": runner["runnerId"],
        })
        assert delegated.status_code == 201
        assert delegated.json()["grant"]["principal"] == runner["runnerId"]
        token = delegated.json()["grantToken"]

        # The owner's own principal cannot redeem a grant minted for the runner.
        owner_attempt = client.post("/api/local/secrets/invoke", headers=headers, json={
            "grantToken": token, "tool": TOOL, "arguments": ARGUMENTS, "attemptId": ATTEMPT,
        })
        assert owner_attempt.status_code == 403
        assert owner_attempt.json()["reason"] == "principal_mismatch"

        # The runner channel demands the runner secret, not the owner credential.
        runner_body = {"grantToken": token, "tool": TOOL, "arguments": ARGUMENTS, "attemptId": ATTEMPT}
        path = f"/api/runners/{runner['runnerId']}/secret-invoke"
        assert client.post(path, json=runner_body).status_code == 401
        assert client.post(path, headers=headers, json=runner_body).status_code == 401

        redeemed = client.post(path, headers=runner_headers, json=runner_body)
        assert redeemed.status_code == 200
        assert redeemed.json()["ok"] is True
        assert redeemed.json()["principal"] == runner["runnerId"]
        assert SECRET_VALUE not in redeemed.text
        assert client.post(path, headers=runner_headers, json=runner_body).status_code == 409

        # A grant minted for the owner is refused on the runner channel.
        owner_grant = client.post("/api/local/secrets/grants", headers=headers, json=grant_body).json()["grantToken"]
        refused = client.post(path, headers=runner_headers, json={
            "grantToken": owner_grant, "tool": TOOL, "arguments": ARGUMENTS, "attemptId": ATTEMPT,
        })
        assert refused.status_code == 403
        assert refused.json()["reason"] == "principal_mismatch"

        unknown_delegate = client.post("/api/local/secrets/grants", headers=headers, json={
            **grant_body, "delegatePrincipal": "runner-" + "e" * 32,
        })
        assert unknown_delegate.status_code == 404
