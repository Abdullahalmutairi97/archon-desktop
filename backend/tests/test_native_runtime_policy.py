import pytest

from archon_server.prime_runner import PrimeRunner
from archon_server.pi_runner import PiRunner


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


@pytest.mark.parametrize('runner_type', [PrimeRunner, PiRunner])
def test_relative_executable_is_anchored_before_task_cwd_changes(tmp_path, monkeypatch, runner_type):
    monkeypatch.chdir(tmp_path)
    runner = runner_type('native', tmp_path / 'sessions', tmp_path)
    workspace = tmp_path / 'workspace'
    workspace.mkdir()
    monkeypatch.chdir(workspace)
    assert runner.executable == tmp_path / 'native'
