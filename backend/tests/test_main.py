import archon_server.main as main_module
import pytest


def test_uvicorn_bounds_connection_shutdown_before_draining_workers(monkeypatch):
    captured = {}
    events = []
    settings = type("Settings", (), {"bind_host": "127.0.0.1", "bind_port": 9999})()
    monkeypatch.setattr(main_module, "Settings", lambda: settings)
    monkeypatch.setattr(
        main_module, "validate_server_security", lambda value: events.append(("validate", value))
    )
    monkeypatch.setattr(
        main_module, "create_app", lambda value: events.append(("app", value)) or "app"
    )
    monkeypatch.setattr(
        main_module.uvicorn,
        "run",
        lambda app, **kwargs: (events.append(("run", app)), captured.update(app=app, **kwargs)),
    )

    main_module.main()

    assert [event[0] for event in events] == ["validate", "app", "run"]
    assert all(event[1] is settings for event in events[:2])
    assert captured["timeout_graceful_shutdown"] == 5
    assert captured["proxy_headers"] is False


def test_invalid_security_configuration_stops_before_app_construction(monkeypatch):
    settings = type("Settings", (), {"auth_token": "", "bind_host": "0.0.0.0"})()
    calls = []
    monkeypatch.setattr(main_module, "Settings", lambda: settings)
    monkeypatch.setattr(main_module, "create_app", lambda _settings: calls.append(("app", None)))
    monkeypatch.setattr(main_module.uvicorn, "run", lambda *_args, **_kwargs: calls.append(("run", None)))

    with pytest.raises(ValueError, match="ARCHON_DESKTOP_AUTH_TOKEN"):
        main_module.main()

    assert calls == []
