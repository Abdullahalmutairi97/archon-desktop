import base64
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from archon_server.app import create_app
from archon_server.config import Settings
from archon_server.services.logs import LogService
from archon_server.services.voice import VoiceService


class FakeCommands:
    def __init__(self, result):
        self.result = result
        self.calls = []

    async def run(self, argv, **kwargs):
        self.calls.append((list(argv), kwargs))
        return self.result


def test_log_service_merges_sources_sorts_and_redacts_credentials(tmp_path):
    logs = tmp_path / 'logs'
    logs.mkdir()
    (logs / 'agent.log').write_text(
        '2026-07-25 10:00:00,000 INFO runner: started token=super-secret\n'
        '2026-07-25 10:02:00,000 WARNING tools.terminal: slow command\n'
    )
    (logs / 'errors.log').write_text(
        '2026-07-25 10:01:00,000 ERROR gateway.run: request failed Authorization: Bearer abc123\n'
    )

    rows = LogService(logs).list(limit=20)

    assert [row['source'] for row in rows] == ['agent', 'errors', 'agent']
    assert [row['level'] for row in rows] == ['INFO', 'ERROR', 'WARNING']
    assert 'super-secret' not in json.dumps(rows)
    assert 'abc123' not in json.dumps(rows)
    assert '[REDACTED]' in json.dumps(rows)


@pytest.mark.asyncio
async def test_voice_service_uses_the_local_hermes_runtime_for_stt_and_tts(tmp_path):
    hermes_root = tmp_path / 'hermes-agent'
    python = hermes_root / 'venv/bin/python'
    python.parent.mkdir(parents=True)
    python.write_text('')
    profile_home = tmp_path / 'profile'
    profile_home.mkdir()

    transcript_commands = FakeCommands({
        'returncode': 0,
        'stdout': json.dumps({'success': True, 'transcript': 'hello Archon', 'provider': 'local'}),
        'stderr': '',
    })
    voice = VoiceService(hermes_root, profile_home, transcript_commands)
    payload = 'data:audio/webm;base64,' + base64.b64encode(b'not-real-audio').decode()

    result = await voice.transcribe(payload, 'audio/webm')

    assert result['transcript'] == 'hello Archon'
    assert transcript_commands.calls[0][0][0] == str(python)
    assert transcript_commands.calls[0][1]['cwd'] == hermes_root
    assert transcript_commands.calls[0][1]['env']['HERMES_HOME'] == str(profile_home)
    assert transcript_commands.calls[0][1]['environment_scope'] == 'voice'

    speech_commands = FakeCommands({
        'returncode': 0,
        'stdout': json.dumps({'success': True, 'provider': 'edge', 'data_url': 'data:audio/mpeg;base64,SUQz'}),
        'stderr': '',
    })
    speech = VoiceService(hermes_root, profile_home, speech_commands)
    spoken = await speech.speak('Ready.')
    assert spoken['data_url'].startswith('data:audio/mpeg;base64,')


def test_voice_and_log_routes_are_registered(tmp_path):
    root = tmp_path / 'host'
    root.mkdir()
    settings = Settings(
        archon_root=root,
        hermes_home=root / '.hermes',
        data_dir=root / '.data',
        auth_token='token',
        start_worker=False,
    )
    with TestClient(create_app(settings)) as client:
        paths = {getattr(route, 'path', '') for route in client.app.routes}
        assert '/api/audio/transcribe' in paths
        assert '/api/audio/speak' in paths
        assert '/api/logs' in paths
