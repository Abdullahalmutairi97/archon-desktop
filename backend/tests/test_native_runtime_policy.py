import json
from pathlib import Path

import pytest

from archon_server.hermes_runner import HermesRunner
from archon_server.prime_runner import PrimeRunner
from archon_server.pi_runner import PiRunner


async def _ignore_event(*_):
    return None


@pytest.mark.asyncio
@pytest.mark.parametrize('runner_type', [PrimeRunner, PiRunner])
@pytest.mark.parametrize('mode,chat_only', [('plan', False), ('approve', False), ('auto', True), (None, False)])
async def test_native_runner_rejects_unenforced_modes_before_launch(tmp_path, monkeypatch, runner_type, mode, chat_only):
    async def unexpected_launch(*args, **kwargs):
        pytest.fail('Native execution must not start for an unsupported mode')
    monkeypatch.setattr('asyncio.create_subprocess_exec', unexpected_launch)
    runner = runner_type(tmp_path / 'native', tmp_path / 'sessions', tmp_path)
    with pytest.raises(ValueError, match='not supported|explicit'):
        await runner.run({'id': 'blocked', 'prompt': 'work', 'approval_mode': mode, 'chat_only': chat_only}, None)
    assert not (tmp_path / 'sessions').exists()


@pytest.mark.asyncio
@pytest.mark.parametrize('runner_type', [PrimeRunner, PiRunner])
async def test_native_runner_never_falls_back_from_missing_cwd(tmp_path, monkeypatch, runner_type):
    executable = tmp_path / 'native'
    executable.write_text('#!/bin/sh\nexit 0\n')
    executable.chmod(0o700)
    async def unexpected_launch(*args, **kwargs):
        pytest.fail('A missing directory must not silently switch workspace')
    monkeypatch.setattr('asyncio.create_subprocess_exec', unexpected_launch)
    runner = runner_type(executable, tmp_path / 'sessions', tmp_path)
    with pytest.raises(ValueError, match='Working directory'):
        await runner.run({'id': 'blocked', 'prompt': 'work', 'approval_mode': 'auto', 'cwd': str(tmp_path / 'missing')}, None)


@pytest.mark.asyncio
@pytest.mark.parametrize('runner_type', [PrimeRunner, PiRunner])
async def test_native_runner_rejects_retargeted_stored_cwd(tmp_path, monkeypatch, runner_type):
    executable = tmp_path / 'native'
    executable.write_text('#!/bin/sh\nexit 0\n')
    executable.chmod(0o700)
    workspace = tmp_path / 'workspace'
    workspace.mkdir()
    workspace.rename(tmp_path / 'original-workspace')
    elsewhere = tmp_path / 'elsewhere'
    elsewhere.mkdir()
    workspace.symlink_to(elsewhere, target_is_directory=True)
    async def unexpected_launch(*args, **kwargs):
        pytest.fail('A stored canonical directory must not follow a replacement symlink')
    monkeypatch.setattr('asyncio.create_subprocess_exec', unexpected_launch)
    runner = runner_type(executable, tmp_path / 'sessions', tmp_path)
    with pytest.raises(ValueError, match='canonical'):
        await runner.run({'id': 'blocked', 'prompt': 'work', 'approval_mode': 'auto', 'cwd': str(workspace)}, None)


@pytest.mark.asyncio
async def test_prime_rechecks_preflight_after_waiting_for_session_lease(tmp_path, monkeypatch):
    import asyncio
    import archon_server.prime_runner as prime_module
    from archon_server.runtimes import execution_cwd
    workspace = tmp_path / 'workspace'
    workspace.mkdir()
    root = tmp_path / 'sessions'
    held = await prime_module._acquire_session_lease(root, 'shared')
    original_acquire = prime_module._acquire_session_lease
    waiting = asyncio.Event()
    async def acquire(*args, **kwargs):
        waiting.set()
        return await original_acquire(*args, **kwargs)
    monkeypatch.setattr(prime_module, '_acquire_session_lease', acquire)
    checks = []
    def preflight(task):
        checks.append(task['cwd'])
        execution_cwd(task['cwd'])
    async def unexpected_launch(*args, **kwargs):
        pytest.fail('Changed workspace must be rejected after waiting for the lease')
    monkeypatch.setattr('asyncio.create_subprocess_exec', unexpected_launch)
    runner = PrimeRunner(tmp_path / 'native', root, tmp_path)
    runner.preflight = preflight
    running = asyncio.create_task(runner.run({'id': 'blocked', 'session_id': 'shared', 'prompt': 'work', 'approval_mode': 'auto', 'cwd': str(workspace)}, None))
    try:
        await asyncio.wait_for(waiting.wait(), 1)
        assert checks == []
        workspace.rename(tmp_path / 'previous')
        workspace.symlink_to(tmp_path / 'previous', target_is_directory=True)
        held.close()
        with pytest.raises(ValueError, match='canonical'):
            await asyncio.wait_for(running, 1)
        assert checks == [str(workspace)]
    finally:
        held.close()
        if not running.done():
            running.cancel()
            await asyncio.gather(running, return_exceptions=True)


@pytest.mark.asyncio
@pytest.mark.parametrize('runner_type', [PrimeRunner, PiRunner])
async def test_native_runtime_children_receive_only_their_scoped_environment(tmp_path, monkeypatch, runner_type):
    marker = tmp_path / 'environment-presence.json'
    keys = [
        'PATH', 'HOME', 'ARCHON_DESKTOP_AUTH_TOKEN', 'TELEGRAM_BOT_TOKEN',
        'OPENAI_API_KEY', 'PYTHONPATH', 'NODE_OPTIONS',
    ]
    executable = tmp_path / 'fake-native'
    executable.write_text(
        '#!/usr/bin/env python3\n'
        'import json, os\n'
        f'with open({str(marker)!r}, "w") as handle:\n'
        f'    json.dump({{key: key in os.environ for key in {keys!r}}}, handle)\n'
        'print(json.dumps({"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}), flush=True)\n'
    )
    executable.chmod(0o700)
    monkeypatch.setenv('ARCHON_DESKTOP_AUTH_TOKEN', 'coordinator-sentinel')
    monkeypatch.setenv('TELEGRAM_BOT_TOKEN', 'telegram-sentinel')
    monkeypatch.setenv('OPENAI_API_KEY', 'provider-sentinel')
    monkeypatch.setenv('PYTHONPATH', '/ambient/pythonpath')
    monkeypatch.setenv('NODE_OPTIONS', '--require=/ambient/hook.js')
    runner = runner_type(executable, tmp_path / f'{runner_type.__name__}-sessions', tmp_path)

    result = await runner.run(
        {'id': 'env-check', 'prompt': 'fixture only', 'approval_mode': 'auto'},
        _ignore_event,
    )

    assert result['text'] == 'ok'
    assert json.loads(marker.read_text()) == {
        'PATH': True,
        'HOME': True,
        'ARCHON_DESKTOP_AUTH_TOKEN': False,
        'TELEGRAM_BOT_TOKEN': False,
        'OPENAI_API_KEY': False,
        'PYTHONPATH': False,
        'NODE_OPTIONS': False,
    }


@pytest.mark.asyncio
async def test_hermes_child_gets_configured_home_and_no_ambient_secrets(tmp_path, monkeypatch):
    marker = tmp_path / 'hermes-environment-presence.json'
    configured_home = tmp_path / 'configured-hermes'
    control_module = str(Path(__file__).parents[1] / 'archon_server' / 'hermes_control.py')
    executable = tmp_path / 'fake-hermes'
    executable.write_text(
        '#!/usr/bin/env python3\n'
        'import json, os\n'
        f'with open({str(marker)!r}, "w") as handle:\n'
        f'    json.dump({{"home_is_configured": os.environ.get("HERMES_HOME") == {str(configured_home)!r}, '
        f'"control_module_is_server_path": os.environ.get("ARCHON_DESKTOP_CONTROL_MODULE") == {control_module!r}, '
        '"auth_token": "ARCHON_DESKTOP_AUTH_TOKEN" in os.environ, '
        '"provider_key": "OPENAI_API_KEY" in os.environ, '
        '"pythonpath": "PYTHONPATH" in os.environ}, handle)\n'
        'print("fixture response", flush=True)\n'
    )
    executable.chmod(0o700)
    monkeypatch.setenv('HERMES_HOME', '/ambient/hermes')
    monkeypatch.setenv('ARCHON_DESKTOP_AUTH_TOKEN', 'coordinator-sentinel')
    monkeypatch.setenv('OPENAI_API_KEY', 'provider-sentinel')
    monkeypatch.setenv('PYTHONPATH', '/ambient/pythonpath')
    runner = HermesRunner(executable, default_cwd=tmp_path, hermes_home=configured_home)

    result = await runner.run(
        {'id': 'hermes-env-check', 'prompt': 'fixture only', 'skills': []},
        _ignore_event,
    )

    assert result['text'] == 'fixture response'
    assert json.loads(marker.read_text()) == {
        'home_is_configured': True,
        'control_module_is_server_path': True,
        'auth_token': False,
        'provider_key': False,
        'pythonpath': False,
    }


@pytest.mark.parametrize('runner_type', [PrimeRunner, PiRunner])
def test_relative_executable_is_anchored_before_task_cwd_changes(tmp_path, monkeypatch, runner_type):
    monkeypatch.chdir(tmp_path)
    runner = runner_type('native', tmp_path / 'sessions', tmp_path)
    workspace = tmp_path / 'workspace'
    workspace.mkdir()
    monkeypatch.chdir(workspace)
    assert runner.executable == tmp_path / 'native'
