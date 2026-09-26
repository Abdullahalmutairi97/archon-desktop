import json
import subprocess
import sys
from pathlib import Path

import pytest

from archon_server.services.commands import CommandRunner
from archon_server.child_env import (
    COMMON_ENV_KEYS,
    CHILD_ENV_SCOPES,
    build_child_env,
)


ESSENTIALS = {
    "PATH": "/fixture/bin",
    "HOME": "/fixture/home",
    "USER": "fixture-user",
    "LOGNAME": "fixture-user",
    "LANG": "C.UTF-8",
    "LC_ALL": "C.UTF-8",
    "LC_CTYPE": "C.UTF-8",
    "TZ": "UTC",
    "TMPDIR": "/fixture/tmp",
    "XDG_CONFIG_HOME": "/fixture/config",
    "XDG_DATA_HOME": "/fixture/data",
    "XDG_CACHE_HOME": "/fixture/cache",
    "XDG_RUNTIME_DIR": "/fixture/runtime",
}

SENTINELS = {
    "ARCHON_DESKTOP_AUTH_TOKEN": "coordinator-sentinel",
    "ARCHON_DESKTOP_TELEGRAM_BOT_TOKEN": "telegram-sentinel",
    "TELEGRAM_BOT_TOKEN": "telegram-alias-sentinel",
    "OPENAI_API_KEY": "openai-sentinel",
    "ANTHROPIC_API_KEY": "anthropic-sentinel",
    "AWS_SECRET_ACCESS_KEY": "cloud-sentinel",
    "PYTHONPATH": "/ambient/pythonpath",
    "PYTHONHOME": "/ambient/pythonhome",
    "LD_PRELOAD": "/ambient/preload.so",
    "LD_LIBRARY_PATH": "/ambient/lib",
    "NODE_OPTIONS": "--require=/ambient/hook.js",
    "BASH_ENV": "/ambient/bashrc",
    "ENV": "/ambient/shrc",
    "SSH_AUTH_SOCK": "/ambient/ssh-agent.sock",
    "HTTPS_PROXY": "https://proxy-user:proxy-password@example.invalid",
}


def _fake_child_presence(env, keys):
    script = (
        "import json, os, sys\n"
        "print(json.dumps({key: key in os.environ for key in json.loads(sys.argv[1])}))\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", script, json.dumps(keys)],
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )
    # The fake child reports only key presence, never environment values.
    return json.loads(result.stdout)


@pytest.mark.parametrize("scope", sorted(CHILD_ENV_SCOPES))
def test_every_scope_keeps_only_approved_essentials_and_drops_ambient_secrets(scope):
    source = {**ESSENTIALS, **SENTINELS, "TERM": "xterm-256color", "CUSTOM_SETTING": "discard"}
    source_copy = dict(source)

    env = build_child_env(scope, source=source)

    assert {key: env[key] for key in ESSENTIALS} == ESSENTIALS
    assert set(env).issubset(set(COMMON_ENV_KEYS) | {"TERM"})
    assert not (set(env) & set(SENTINELS))
    assert "CUSTOM_SETTING" not in env
    assert source == source_copy
    assert env is not source


def test_terminal_scope_preserves_terminal_type_but_other_scopes_drop_it():
    source = {**ESSENTIALS, "TERM": "xterm-direct"}

    terminal = build_child_env("terminal", source=source)
    operations = build_child_env("operations", source=source)

    assert terminal["TERM"] == "xterm-direct"
    assert "TERM" not in operations


def test_unrelated_exported_function_keys_are_dropped_before_source_validation():
    source = {
        **ESSENTIALS,
        "BASH_FUNC_fixture%%": "() { :; }",
        "UNRELATED%%": "discard",
    }

    env = build_child_env("operations", source=source)

    assert env == ESSENTIALS


def test_voice_controlled_overrides_restore_only_hermes_home_and_pythonpath():
    source = {
        **ESSENTIALS,
        **SENTINELS,
        "HERMES_HOME": "/ambient/hermes",
        "CUSTOM_SETTING": "discard",
    }
    overrides = {"HERMES_HOME": "/fixture/voice-hermes", "PYTHONPATH": "/fixture/voice-modules"}
    overrides_copy = dict(overrides)

    env = build_child_env("voice", source=source, overrides=overrides)

    assert env["HERMES_HOME"] == "/fixture/voice-hermes"
    assert env["PYTHONPATH"] == "/fixture/voice-modules"
    assert source["HERMES_HOME"] == "/ambient/hermes"
    assert source["PYTHONPATH"] == SENTINELS["PYTHONPATH"]
    assert overrides == overrides_copy
    child_presence = _fake_child_presence(
        env,
        [*ESSENTIALS, *SENTINELS, "HERMES_HOME", "CUSTOM_SETTING"],
    )
    assert all(child_presence[key] for key in ESSENTIALS)
    assert not any(child_presence[key] for key in SENTINELS if key != "PYTHONPATH")
    assert child_presence["HERMES_HOME"]
    assert child_presence["PYTHONPATH"]
    assert not child_presence["CUSTOM_SETTING"]


def test_hermes_control_module_override_is_scoped_and_must_be_server_owned():
    source = {**ESSENTIALS, "ARCHON_DESKTOP_CONTROL_MODULE": "/ambient/evil.py"}
    control_module = str(Path(__file__).parents[1] / "archon_server" / "hermes_control.py")

    env = build_child_env(
        "hermes",
        source=source,
        overrides={"ARCHON_DESKTOP_CONTROL_MODULE": control_module},
    )

    assert env["ARCHON_DESKTOP_CONTROL_MODULE"] == control_module
    with pytest.raises(ValueError):
        build_child_env("pi", source=source, overrides={"ARCHON_DESKTOP_CONTROL_MODULE": control_module})
    with pytest.raises(ValueError):
        build_child_env("hermes", source=source, overrides={"ARCHON_DESKTOP_CONTROL_MODULE": "/tmp/evil.py"})


@pytest.mark.parametrize(
    "scope,key",
    [
        ("prime", "HERMES_HOME"),
        ("operations", "PYTHONPATH"),
        ("voice", "ARCHON_DESKTOP_AUTH_TOKEN"),
        ("voice", "ARCHON_DESKTOP_TELEGRAM_BOT_TOKEN"),
        ("pi", "TELEGRAM_BOT_TOKEN"),
        ("operations", "OPENAI_API_KEY"),
        ("resources", "UNLISTED_SETTING"),
    ],
)
def test_overrides_reject_cross_scope_or_secret_keys(scope, key):
    with pytest.raises(ValueError):
        build_child_env(scope, source=ESSENTIALS, overrides={key: "override-sentinel"})


@pytest.mark.parametrize("scope", ["", "default", "prime-agent", "telegram", "hermes "])
def test_unknown_scope_fails_closed(scope):
    with pytest.raises(ValueError):
        build_child_env(scope, source=ESSENTIALS)


@pytest.mark.parametrize(
    "source,overrides",
    [
        ({"PATH": "bad\x00path"}, None),
        ({"PATH": 4}, None),
        (ESSENTIALS, {"PATH": "bad\x00path"}),
        (ESSENTIALS, {"PATH": 4}),
    ],
)
def test_environment_values_and_names_must_be_strings_without_nul(source, overrides):
    with pytest.raises((TypeError, ValueError)):
        build_child_env("operations", source=source, overrides=overrides)


def test_environment_builder_returns_fresh_plain_mapping():
    source = dict(ESSENTIALS)
    env = build_child_env("resources", source=source, overrides={"PATH": "/fixture/override-bin"})

    assert type(env) is dict
    assert env is not source
    assert source["PATH"] == ESSENTIALS["PATH"]
    assert env["PATH"] == "/fixture/override-bin"


@pytest.mark.asyncio
async def test_command_runner_without_overrides_still_launches_with_filtered_environment(monkeypatch):
    monkeypatch.setenv("ARCHON_DESKTOP_AUTH_TOKEN", "coordinator-sentinel")
    monkeypatch.setenv("OPENAI_API_KEY", "provider-sentinel")
    monkeypatch.setenv("PYTHONPATH", "/ambient/pythonpath")
    monkeypatch.setenv("NODE_OPTIONS", "--require=/ambient/hook.js")
    keys = ["PATH", "HOME", "ARCHON_DESKTOP_AUTH_TOKEN", "OPENAI_API_KEY", "PYTHONPATH", "NODE_OPTIONS"]
    script = (
        "import json, os, sys\n"
        "print(json.dumps({key: key in os.environ for key in json.loads(sys.argv[1])}))\n"
    )

    result = await CommandRunner().run([sys.executable, "-c", script, json.dumps(keys)], timeout=5)

    assert result["returncode"] == 0
    presence = json.loads(result["stdout"])
    assert presence == {
        "PATH": True,
        "HOME": True,
        "ARCHON_DESKTOP_AUTH_TOKEN": False,
        "OPENAI_API_KEY": False,
        "PYTHONPATH": False,
        "NODE_OPTIONS": False,
    }
