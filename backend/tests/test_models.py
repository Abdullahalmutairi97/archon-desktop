from pathlib import Path

from archon_server.services.models import ModelService


def test_model_get_handles_malformed_config(tmp_path: Path):
    config = tmp_path / "config.yaml"
    config.write_text("- invalid\n")
    auth = tmp_path / "auth.json"
    auth.write_text("{}")

    result = ModelService(config, auth_path=auth).get()

    assert result["current"]["provider"] is None
    assert result["choices"] == []


def test_model_service_ignores_non_object_auth_and_model_config(tmp_path):
    from archon_server.services.models import ModelService

    config = tmp_path / "config.yaml"
    config.write_text("model: [broken]\n")
    auth = tmp_path / "auth.json"
    auth.write_text("[broken]")
    service = ModelService(config, auth_path=auth)

    result = service.get()
    assert result["providers"] == []
    assert result["current"]["provider"] is None
