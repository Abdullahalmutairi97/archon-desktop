import pytest


@pytest.fixture(autouse=True)
def isolated_native_pi_history(tmp_path, monkeypatch):
    # Never discover or operate on the developer's real Pi session files in tests.
    monkeypatch.setenv('ARCHON_DESKTOP_PI_AGENT_SESSION_DIR', str(tmp_path / 'isolated-pi-history'))
