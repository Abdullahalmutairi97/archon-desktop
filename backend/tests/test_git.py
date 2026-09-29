import json
import subprocess

import pytest
from fastapi.testclient import TestClient

from archon_server.app import create_app
from archon_server.config import Settings
from archon_server.services import git as git_module
from archon_server.services.files import FileService
from archon_server.services.git import GitCommandError, GitService

IDENTITY = {
    "GIT_AUTHOR_NAME": "Test", "GIT_AUTHOR_EMAIL": "test@example.invalid",
    "GIT_COMMITTER_NAME": "Test", "GIT_COMMITTER_EMAIL": "test@example.invalid",
}


@pytest.fixture(autouse=True)
def identity(monkeypatch):
    for key, value in IDENTITY.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", "/dev/null")
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")


def sh(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout


@pytest.fixture
def repo(tmp_path):
    root = tmp_path / "root"
    project = root / "project"
    project.mkdir(parents=True)
    sh(project, "init", "-q", "-b", "main")
    (project / "app.py").write_text("one\ntwo\nthree\n")
    (project / "old.txt").write_text("rename me\n")
    (project / ".env").write_text("TOKEN=first-secret\n")
    sh(project, "add", ".")
    sh(project, "commit", "-q", "-m", "initial")
    return root, project


@pytest.fixture
def service(repo):
    return GitService(FileService(repo[0]))


async def test_status_reports_branch_and_every_kind_of_change(repo, service):
    _, project = repo
    (project / "app.py").write_text("one\nTWO\nthree\n")
    sh(project, "mv", "old.txt", "new.txt")
    (project / "notes.md").write_text("draft\n")
    (project / "src").mkdir()
    (project / "src" / "deep.py").write_text("x = 1\n")

    status = await service.status("project/src")

    assert status["branch"] == "main" and not status["detached"] and not status["clean"]
    assert status["relative_root"] == "project"
    rows = {row["path"]: row for row in status["files"]}
    assert rows["app.py"]["unstaged"] and not rows["app.py"]["staged"]
    assert rows["new.txt"]["staged"] and rows["new.txt"]["orig_path"] == "old.txt"
    assert rows["notes.md"]["untracked"] and rows["src/deep.py"]["untracked"]


async def test_unstaged_diff_has_line_numbers_and_untracked_files(repo, service):
    _, project = repo
    (project / "app.py").write_text("one\nTWO\nthree\nfour\n")
    (project / "notes.md").write_text("draft\nsecond\n")

    diff = await service.diff("project", "unstaged")

    files = {row["path"]: row for row in diff["files"]}
    app = files["app.py"]
    assert (app["status"], app["additions"], app["deletions"]) == ("modified", 2, 1)
    lines = app["hunks"][0]["lines"]
    assert {"kind": "del", "text": "two", "old": 2, "new": None} in lines
    assert {"kind": "add", "text": "TWO", "old": None, "new": 2} in lines
    assert {"kind": "ctx", "text": "three", "old": 3, "new": 3} in lines
    notes = files["notes.md"]
    assert notes["status"] == "untracked" and notes["additions"] == 2
    assert [line["text"] for line in notes["hunks"][0]["lines"]] == ["draft", "second"]


async def test_secret_files_never_expose_content(repo, service):
    _, project = repo
    (project / ".env").write_text("TOKEN=second-secret\n")
    (project / "key.pem").write_text("PRIVATE-KEY-MATERIAL\n")

    unstaged = await service.diff("project", "unstaged")
    sh(project, "add", ".")
    staged = await service.diff("project", "staged")
    sh(project, "commit", "-q", "-m", "secrets")
    commit = await service.diff("project", "commit", ref="HEAD")

    for result in (unstaged, staged, commit):
        text = json.dumps(result)
        for leaked in ("first-secret", "second-secret", "PRIVATE-KEY-MATERIAL"):
            assert leaked not in text
        hidden = {row["path"] for row in result["files"] if row["hidden"]}
        assert {".env", "key.pem"} <= hidden
        assert all(not row["hunks"] for row in result["files"] if row["hidden"])


async def test_staged_commit_and_compare_scopes(repo, service):
    _, project = repo
    sh(project, "switch", "-q", "-c", "feature")
    sh(project, "mv", "old.txt", "renamed.txt")
    (project / "feature.py").write_text("print('hi')\n")
    sh(project, "add", ".")

    staged = await service.diff("project", "staged")
    renamed = next(row for row in staged["files"] if row["path"] == "renamed.txt")
    assert renamed["status"] == "renamed" and renamed["old_path"] == "old.txt"

    committed = await service.commit("project", "Add feature\n\nBody text")
    assert committed["subject"] == "Add feature" and committed["status"]["clean"]

    commit_diff = await service.diff("project", "commit", ref=committed["short"])
    assert {row["path"] for row in commit_diff["files"]} == {"renamed.txt", "feature.py"}

    compare = await service.diff("project", "compare", base="main")
    assert {row["path"] for row in compare["files"]} == {"renamed.txt", "feature.py"}
    only = await service.diff("project", "compare", base="main", file="feature.py")
    assert [row["path"] for row in only["files"]] == ["feature.py"]

    log = await service.log("project")
    assert [c["subject"] for c in log["commits"]] == ["Add feature", "initial"]
    assert len(log["commits"][0]["parents"]) == 1
    branches = await service.branches("project")
    assert branches["current"] == "feature" and branches["default_base"] == "main"
    assert {b["name"] for b in branches["local"]} == {"main", "feature"}


async def test_stage_unstage_and_confirmed_discard(repo, service):
    _, project = repo
    (project / "app.py").write_text("changed\n")
    (project / "scratch.txt").write_text("temp\n")

    staged = await service.stage("project", ["app.py", "scratch.txt"])
    assert {r["path"] for r in staged["files"] if r["staged"]} == {"app.py", "scratch.txt"}
    unstaged = await service.unstage("project", ["app.py", "scratch.txt"])
    assert not any(r["staged"] for r in unstaged["files"])

    with pytest.raises(PermissionError):
        await service.discard("project", ["app.py"], confirm=False)
    assert (project / "app.py").read_text() == "changed\n"

    after = await service.discard("project", ["app.py", "scratch.txt"], confirm=True)
    assert after["clean"]
    assert (project / "app.py").read_text() == "one\ntwo\nthree\n"
    assert not (project / "scratch.txt").exists()


async def test_first_commit_in_a_new_repository(tmp_path):
    root = tmp_path / "root"
    fresh = root / "fresh"
    fresh.mkdir(parents=True)
    sh(fresh, "init", "-q", "-b", "main")
    (fresh / "a.txt").write_text("a\n")
    service = GitService(FileService(root))

    status = await service.status("fresh")
    assert status["head"] is None and status["branch"] == "main"
    assert (await service.log("fresh"))["commits"] == []
    await service.stage("fresh", ["a.txt"])
    assert (await service.unstage("fresh", ["a.txt"]))["files"][0]["untracked"]
    await service.stage("fresh", ["a.txt"])
    assert (await service.commit("fresh", "first"))["subject"] == "first"


async def test_git_refusals_and_hostile_input(repo, service, tmp_path):
    _, project = repo
    with pytest.raises(ValueError):
        await service.commit("project", "   ")
    with pytest.raises(GitCommandError, match="nothing"):
        await service.commit("project", "empty")
    hook = project / ".git" / "hooks" / "pre-commit"
    hook.write_text("#!/bin/sh\necho 'lint failed: fix app.py' >&2\nexit 1\n")
    hook.chmod(0o755)
    (project / "app.py").write_text("x\n")
    sh(project, "add", "app.py")
    with pytest.raises(GitCommandError, match="lint failed"):
        await service.commit("project", "blocked")

    for ref in ("--output=/tmp/x", "-rf", "main..evil", "a b", "$(id)"):
        with pytest.raises(ValueError):
            await service.diff("project", "commit", ref=ref)
    with pytest.raises(ValueError):
        await service.switch("project", "-x")
    with pytest.raises(ValueError):
        await service.switch("project", "bad..name")
    with pytest.raises(PermissionError):
        await service.stage("project", ["../../outside.txt"])
    with pytest.raises(PermissionError):
        await service.status("../")
    (tmp_path / "root" / "plain").mkdir()
    with pytest.raises(FileNotFoundError):
        await service.status("plain")
    with pytest.raises(ValueError):
        await service.diff("project", "everything")


async def test_switch_create_and_push_to_a_remote(repo, service, tmp_path):
    _, project = repo
    remote = tmp_path / "remote.git"
    sh(tmp_path, "init", "-q", "--bare", str(remote))
    sh(project, "remote", "add", "origin", str(remote))

    switched = await service.switch("project", "agent/work", create=True)
    assert switched["branch"] == "agent/work"
    with pytest.raises(GitCommandError):
        await service.switch("project", "agent/work", create=True)

    with pytest.raises(PermissionError):
        await service.push("project", confirm=False)
    pushed = await service.push("project", confirm=True)
    assert pushed["upstream"] == "origin/agent/work" and pushed["ahead"] == 0
    assert "agent/work" in sh(remote, "branch")

    (project / "app.py").write_text("more\n")
    sh(project, "commit", "-qam", "more")
    assert (await service.status("project"))["ahead"] == 1
    assert (await service.push("project", confirm=True))["ahead"] == 0
    assert (await service.fetch("project"))["behind"] == 0


async def test_oversized_output_is_cut_and_flagged(repo, service, monkeypatch):
    _, project = repo
    monkeypatch.setattr(git_module, "MAX_OUTPUT_BYTES", 300)
    (project / "app.py").write_text("".join(f"line {n}\n" for n in range(500)))
    diff = await service._run(project, "diff")
    assert diff[1] is True and len(diff[0]) <= 300


def test_git_api_requires_the_token_and_maps_errors(repo):
    root, project = repo
    settings = Settings(data_dir=root.parent / "data", archon_root=root, auth_token="git-token", start_worker=False)
    auth = {"Authorization": "Bearer git-token"}
    (project / "app.py").write_text("edited\n")
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/git/status", params={"path": "project"}).status_code == 401
        status = client.get("/api/git/status", params={"path": "project"}, headers=auth)
        assert status.status_code == 200 and status.json()["branch"] == "main"
        diff = client.get("/api/git/diff", params={"path": "project", "scope": "unstaged"}, headers=auth).json()
        assert diff["files"][0]["path"] == "app.py"
        assert client.get("/api/git/diff", params={"path": "project", "scope": "nope"}, headers=auth).status_code == 422
        assert client.get("/api/git/status", params={"path": "missing"}, headers=auth).status_code == 404
        assert client.get("/api/git/status", params={"path": "../.."}, headers=auth).status_code == 403
        assert client.post("/api/git/discard", json={"path": "project", "files": ["app.py"]}, headers=auth).status_code == 403
        assert client.post("/api/git/commit", json={"path": "project", "message": "nothing staged"}, headers=auth).status_code == 409
        assert client.post("/api/git/stage", json={"path": "project", "files": ["app.py"]}, headers=auth).status_code == 200
        made = client.post("/api/git/commit", json={"path": "project", "message": "Edit app"}, headers=auth)
        assert made.status_code == 200 and made.json()["subject"] == "Edit app"
        log = client.get("/api/git/log", params={"path": "project", "limit": 1}, headers=auth).json()
        assert log["commits"][0]["subject"] == "Edit app"
        assert client.get("/api/git/branches", params={"path": "project"}, headers=auth).json()["current"] == "main"
        assert client.post("/api/git/switch", json={"path": "project", "branch": "topic", "create": True}, headers=auth).json()["branch"] == "topic"
