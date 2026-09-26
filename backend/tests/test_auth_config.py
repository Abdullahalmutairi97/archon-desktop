import hmac

import pytest

from archon_server.config import Settings
from archon_server.security import token_authorized, validate_server_security


def make_settings(**overrides):
    return Settings(_env_file=None, **overrides)


def test_repository_dotenv_is_not_loaded_implicitly(tmp_path, monkeypatch):
    (tmp_path / ".env").write_text(
        "ARCHON_DESKTOP_AUTH_TOKEN=should-not-load\nARCHON_DESKTOP_BIND_HOST=0.0.0.0\n"
    )
    monkeypatch.chdir(tmp_path)

    settings = Settings()

    assert settings.auth_token == ""
    assert settings.bind_host == "127.0.0.1"
    assert "should-not-load" not in repr(settings)


@pytest.mark.parametrize("token", ["", "   "])
def test_blank_token_requires_explicit_fixture_mode(token):
    with pytest.raises(ValueError, match="AUTH_TOKEN"):
        validate_server_security(make_settings(auth_token=token))

    validate_server_security(make_settings(auth_token=token, fixture_mode=True))


@pytest.mark.parametrize("token", [" token", "token ", "token\nvalue", "bad\x00token", "bad\x7ftoken"])
def test_token_rejects_edge_whitespace_and_control_characters_without_echoing(token):
    with pytest.raises(ValueError) as error:
        validate_server_security(make_settings(auth_token=token))

    assert "token" not in str(error.value).lower() or "AUTH_TOKEN" in str(error.value)
    assert token not in str(error.value)


def test_control_characters_are_rejected_even_for_fixture_token():
    with pytest.raises(ValueError, match="AUTH_TOKEN"):
        validate_server_security(make_settings(auth_token="\t\n", fixture_mode=True))


def test_legacy_nonblank_token_length_is_not_changed_or_rejected():
    token = "legacy-token"
    settings = make_settings(auth_token=token)

    validate_server_security(settings)

    assert settings.auth_token == token
    assert token not in repr(settings)


@pytest.mark.parametrize("host", ["127.0.0.1", "127.0.0.2", "::1", "localhost"])
def test_literal_loopback_bind_hosts_are_supported(host):
    validate_server_security(make_settings(auth_token="configured", bind_host=host))


@pytest.mark.parametrize(
    "host",
    ["", "0.0.0.0", "::", "192.0.2.3", "100.64.0.1", "example.test", "fe80::1%lo", "LOCALHOST", "localhost.", " 127.0.0.1"],
)
def test_non_loopback_or_unresolved_bind_hosts_are_rejected(host):
    with pytest.raises(ValueError, match="BIND_HOST"):
        validate_server_security(make_settings(auth_token="configured", bind_host=host))


def test_fixture_mode_does_not_allow_a_non_loopback_listener():
    with pytest.raises(ValueError, match="BIND_HOST"):
        validate_server_security(
            make_settings(auth_token="", fixture_mode=True, bind_host="100.64.0.1")
        )


@pytest.mark.parametrize(
    "url",
    [
        "https://proxy.example.test",
        "https://proxy.example.test:443/archon",
        "https://[2001:db8::1]:8443/archon",
    ],
)
def test_private_tls_proxy_url_accepts_https_authority_and_path(url):
    validate_server_security(
        make_settings(
            auth_token="configured",
            remote_access_mode="private_tls_proxy",
            remote_base_url=url,
        )
    )


@pytest.mark.parametrize(
    "url",
    [
        "http://proxy.example.test",
        "https://user:password@proxy.example.test",
        "https://proxy.example.test?token=x",
        "https://proxy.example.test?",
        "https://proxy.example.test#fragment",
        "https://proxy.example.test#",
        "https://proxy.example.test:99999",
        "https://proxy.example.test:bad",
        "https://proxy.example.test:",
        "https:///missing-host",
        "https://bad_host.example.test",
    ],
)
def test_private_tls_proxy_url_rejects_unsafe_or_malformed_values(url):
    with pytest.raises(ValueError, match="REMOTE_BASE_URL") as error:
        validate_server_security(
            make_settings(
                auth_token="configured",
                remote_access_mode="private_tls_proxy",
                remote_base_url=url,
            )
        )
    assert url not in str(error.value)


def test_disabled_remote_mode_rejects_a_configured_url():
    with pytest.raises(ValueError, match="REMOTE_BASE_URL"):
        validate_server_security(
            make_settings(auth_token="configured", remote_base_url="https://proxy.example.test")
        )


def test_unknown_remote_mode_is_rejected_without_echoing_the_value():
    with pytest.raises(ValueError, match="REMOTE_ACCESS_MODE") as error:
        validate_server_security(
            make_settings(auth_token="configured", remote_access_mode="secret-value")
        )
    assert "secret-value" not in str(error.value)


def test_auth_comparison_uses_constant_time_helper(monkeypatch):
    calls = []
    original = hmac.compare_digest

    def recording_compare(left, right):
        calls.append((type(left), type(right)))
        return original(left, right)

    monkeypatch.setattr("archon_server.security.hmac.compare_digest", recording_compare)

    assert token_authorized(make_settings(auth_token="configured"), "configured")
    assert not token_authorized(make_settings(auth_token="configured"), "wrong")
    assert calls == [(bytes, bytes), (bytes, bytes)]


@pytest.mark.parametrize("supplied", [None, "", "   ", 5, object()])
def test_invalid_or_missing_supplied_tokens_fail_closed_outside_fixture_mode(supplied):
    assert not token_authorized(make_settings(auth_token="configured"), supplied)


@pytest.mark.parametrize("supplied", [None, "", "   "])
def test_anonymous_auth_is_available_only_for_explicit_blank_fixture_mode(supplied):
    assert token_authorized(make_settings(auth_token="", fixture_mode=True), supplied)
    assert not token_authorized(make_settings(auth_token=""), supplied)


def test_fixture_mode_does_not_disable_a_configured_token():
    settings = make_settings(auth_token="configured", fixture_mode=True)

    assert token_authorized(settings, "configured")
    assert not token_authorized(settings, None)
    assert not token_authorized(settings, "wrong")
