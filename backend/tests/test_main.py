import archon_server.main as main_module


def test_uvicorn_bounds_connection_shutdown_before_draining_workers(monkeypatch):
    captured = {}
    settings = type("Settings", (), {"bind_host": "127.0.0.1", "bind_port": 9999})()
    monkeypatch.setattr(main_module, "Settings", lambda: settings)
    monkeypatch.setattr(main_module, "create_app", lambda _settings: "app")
    monkeypatch.setattr(main_module.uvicorn, "run", lambda app, **kwargs: captured.update(app=app, **kwargs))

    main_module.main()

    assert captured["timeout_graceful_shutdown"] == 5
