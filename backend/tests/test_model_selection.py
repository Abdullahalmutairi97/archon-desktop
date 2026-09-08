from pathlib import Path
from archon_server.services.models import ModelService


def test_astra_selectable(tmp_path):
    auth = tmp_path / 'auth.json'
    auth.write_text('{"openai-codex":{"access":"test-placeholder"}}')
    svc = ModelService(tmp_path / 'config.yaml', auth_path=auth)
    assert {'provider': 'openai-codex', 'model': 'gpt-6-astra'} in svc.get()['choices']
    assert svc.set_default('openai-codex', 'gpt-6-astra')['current']['model'] == 'gpt-6-astra'


def test_default_repairs_malformed_model_config(tmp_path):
    auth = tmp_path / 'auth.json'
    auth.write_text('{"openai-codex":{"access":"test-placeholder"}}')
    cfg = tmp_path / 'config.yaml'
    cfg.write_text('model: [broken]\n')
    svc = ModelService(cfg, auth_path=auth)
    assert svc.set_default('openai-codex', 'gpt-5.5')['current']['model'] == 'gpt-5.5'
