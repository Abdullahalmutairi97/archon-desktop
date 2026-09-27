from pathlib import Path

import pytest

from archon_server.db import Database
from archon_server.tasks import TaskEngine, TaskStore
from archon_server.runtimes import RuntimeRegistry, RuntimeUnavailable


class RecordingRunner:
    def __init__(self, executable=None):
        if executable is not None:
            self.executable = executable
        self.calls = []

    async def run(self, task, emit):
        self.calls.append(task['id'])
        return {'text': 'finished'}


@pytest.mark.parametrize('profile', [None, 'default', 'prime', 'archon'])
def test_explicit_legacy_aliases_select_prime(profile):
    runner = RecordingRunner()
    registry = RuntimeRegistry({'prime': runner, 'pi': RecordingRunner()})
    assert registry.resolve(profile) == 'prime'
    assert registry.runner_for({'profile': profile}) is runner


def test_other_roster_profiles_do_not_fall_back_to_prime():
    registry = RuntimeRegistry({'prime': RecordingRunner(), 'pi': RecordingRunner()})
    with pytest.raises(ValueError, match='Unknown runtime'):
        registry.resolve('hermes-agent')
    assert registry.resolve('pi') == 'pi'
    configured = RuntimeRegistry({'prime': RecordingRunner()}, aliases={'reviewer': 'prime'})
    assert configured.resolve('reviewer') == 'prime'


def test_bound_runtime_identity_survives_profile_alias_changes():
    prime = RecordingRunner()
    pi = RecordingRunner()
    registry = RuntimeRegistry(
        {'prime': prime, 'pi': pi}, aliases={'pi-legacy': 'pi'},
    )
    task = {
        'runtime_id': 'pi', 'profile': 'pi-legacy',
        'approval_mode': 'auto', 'chat_only': False,
    }

    assert registry.runner_for(task) is pi
    assert registry.validate(task) == 'pi'

    registry.aliases['pi-legacy'] = 'prime'
    assert registry.runner_for(task) is pi
    assert registry.validate(task) == 'pi'


def test_invalid_bound_runtime_fails_closed_without_profile_fallback():
    registry = RuntimeRegistry({'prime': RecordingRunner(), 'pi': RecordingRunner()})
    task = {'runtime_id': 'unknown', 'profile': 'prime', 'approval_mode': 'auto'}

    with pytest.raises(ValueError, match='canonical runtime'):
        registry.runner_for(task)
    with pytest.raises(ValueError, match='canonical runtime'):
        registry.validate(task)


@pytest.mark.parametrize('aliases', [{'pi': 'prime'}, {'default': 'pi'}, {'other': 'missing'}])
def test_aliases_cannot_redefine_builtin_identity_or_target_unknown_runtime(aliases):
    with pytest.raises(ValueError):
        RuntimeRegistry({'prime': RecordingRunner(), 'pi': RecordingRunner()}, aliases=aliases)


@pytest.mark.parametrize('mode,chat_only', [('approve', False), ('plan', False), ('auto', True), (None, False)])
def test_restricted_modes_fail_closed(mode, chat_only):
    registry = RuntimeRegistry({'prime': RecordingRunner()})
    with pytest.raises(ValueError, match='not supported|explicit'):
        registry.validate({'approval_mode': mode, 'chat_only': chat_only})


def test_capabilities_are_honest_and_availability_is_a_filesystem_probe(tmp_path):
    executable = tmp_path / 'prime'
    executable.write_text('#!/bin/sh\ntouch SHOULD_NOT_RUN\n')
    registry = RuntimeRegistry({'prime': RecordingRunner(executable)})
    info = registry.describe()[0]
    assert info['id'] == 'prime'
    assert info['available'] is False
    with pytest.raises(RuntimeUnavailable, match='unavailable'):
        registry.validate({'approval_mode': 'auto'})
    executable.chmod(0o700)
    info = registry.describe()[0]
    assert info['available'] is True
    assert info['availability_check'] == 'executable_file'
    assert info['modes'] == [{'id': 'auto', 'label': 'Trusted execution', 'restricted': False}]
    assert info['chat_only'] is False
    assert info['sandboxed'] is False
    assert not (tmp_path / 'SHOULD_NOT_RUN').exists()
    assert registry.validate({'approval_mode': 'auto'}) == 'prime'
    executable.unlink()
    assert registry.describe()[0]['available'] is False
    # A disappeared executable must not prevent selecting its active runner for cancellation.
    assert registry.runner_for({'profile': 'prime'}) is registry.runners['prime']


def test_manifest_publishes_a_read_only_digest_without_executing(tmp_path):
    marker = tmp_path / 'ran'
    executable = tmp_path / 'prime'
    executable.write_text(f'#!/bin/sh\necho ran >> {marker}\n')
    executable.chmod(0o700)
    registry = RuntimeRegistry({'prime': RecordingRunner(executable)})
    info = registry.describe()[0]
    assert info['manifest_version'] == 1
    assert isinstance(info['executable_digest'], str) and len(info['executable_digest']) == 64
    assert info['version'] is None and info['version_verified'] is False
    assert info['capabilities'] == {
        'modalities': ['prompt'], 'resume': False, 'fork': False, 'steer': False,
        'approval': False, 'read_only': False, 'chat_only': False,
        'reconnect': 'task_event_replay', 'resource_formats': ['print'], 'transports': ['stdio'],
    }
    # Publishing the manifest must never execute the configured runtime.
    assert not marker.exists()


@pytest.mark.asyncio
async def test_worker_persists_policy_failure_and_continues(tmp_path):
    store = TaskStore(Database(tmp_path / 'state.db'))
    runner = RecordingRunner()
    registry = RuntimeRegistry({'prime': runner})
    engine = TaskEngine(store, {'prime': runner}, registry=registry)
    bad = store.submit('bad', profile='unknown', approval_mode='auto')
    protected = store.submit('protected', approval_mode='approve')
    good = store.submit('good', approval_mode='auto')
    for _ in range(3):
        assert await engine.run_once()
    assert store.get(bad['id'])['status'] == 'failed'
    assert 'Unknown runtime' in store.get(bad['id'])['error']
    assert store.get(protected['id'])['status'] == 'failed'
    assert store.events(bad['id'])[-1]['type'] == 'task.failed'
    assert store.get(good['id'])['status'] == 'completed'
    assert runner.calls == [good['id']]


@pytest.mark.asyncio
async def test_preflight_revalidates_before_runner_and_failure_is_durable(tmp_path):
    store = TaskStore(Database(tmp_path / 'state.db'))
    runner = RecordingRunner()
    workspace = tmp_path / 'workspace'
    workspace.mkdir()
    task = store.submit('work', cwd=str(workspace), approval_mode='auto')
    workspace.rmdir()
    def preflight(task):
        if not Path(task['cwd']).is_dir():
            raise ValueError('Working directory no longer exists')
    engine = TaskEngine(store, runner, registry=RuntimeRegistry({'prime': runner}), preflight=preflight)
    assert await engine.run_once()
    assert store.get(task['id'])['status'] == 'failed'
    assert 'no longer exists' in store.get(task['id'])['error']
    assert runner.calls == []


@pytest.mark.asyncio
async def test_legacy_mapping_dispatch_rejects_unknown_profile_without_worker_crash(tmp_path):
    store = TaskStore(Database(tmp_path / 'state.db'))
    runner = RecordingRunner()
    task = store.submit('work', profile='unknown')
    engine = TaskEngine(store, {'default': runner})
    assert await engine.run_once()
    assert store.get(task['id'])['status'] == 'failed'
    assert runner.calls == []
