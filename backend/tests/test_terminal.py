import pytest

from archon_server.services.terminal import TmuxService


class FakeCommands:
    def __init__(self, results=None):
        self.calls = []
        self.kwargs = []
        self.results = list(results or [])

    async def run(self, argv, **kwargs):
        self.calls.append(list(argv))
        self.kwargs.append(kwargs)
        if self.results:
            return self.results.pop(0)
        return {"returncode": 0, "stdout": "", "stderr": ""}


@pytest.mark.asyncio
async def test_tmux_sessions_are_namespaced_and_portable(tmp_path):
    commands = FakeCommands([
        {"returncode": 1, "stdout": "", "stderr": "missing"},
        {"returncode": 0, "stdout": "", "stderr": ""},
        {"returncode": 0, "stdout": "archon-desktop-ops|2|1700000000\n", "stderr": ""},
    ])
    service = TmuxService(tmp_path, commands)

    created = await service.create("Ops Shell", ".")
    sessions = await service.list()

    assert created["name"] == "archon-desktop-ops-shell"
    assert commands.calls[0][:3] == ["tmux", "has-session", "-t"]
    assert commands.calls[1][:4] == ["tmux", "new-session", "-d", "-s"]
    assert commands.kwargs[1].get("detach_stdio") is True
    assert sessions[0]["name"] == "archon-desktop-ops"


@pytest.mark.asyncio
async def test_tmux_reuses_an_existing_namespaced_session(tmp_path):
    commands = FakeCommands([{"returncode": 0, "stdout": "", "stderr": ""}])
    service = TmuxService(tmp_path, commands)

    created = await service.create("Ops Shell", ".")

    assert created["name"] == "archon-desktop-ops-shell"
    assert len(commands.calls) == 1
    assert commands.calls[0][:3] == ["tmux", "has-session", "-t"]


@pytest.mark.asyncio
async def test_tmux_rejects_cwd_outside_root(tmp_path):
    service = TmuxService(tmp_path, FakeCommands())
    with pytest.raises(PermissionError):
        await service.create("bad", "../outside")


@pytest.mark.asyncio
async def test_tmux_list_ignores_malformed_metadata(tmp_path):
    commands = FakeCommands([
        {
            "returncode": 0,
            "stdout": "archon-desktop-bad|not-a-number|1700000000\narchon-desktop-good|1|1700000000\n",
            "stderr": "",
        }
    ])
    service = TmuxService(tmp_path, commands)

    sessions = await service.list()

    assert sessions == [{
        "name": "archon-desktop-good",
        "windows": 1,
        "created_at_epoch": 1700000000,
        "persistent": True,
    }]
