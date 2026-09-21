import pytest
from fastapi.testclient import TestClient

from archon_server.app import create_app
from archon_server.config import Settings


def runtime_settings(tmp_path, **overrides):
    root = tmp_path / "workspace"
    root.mkdir(exist_ok=True)
    executable = tmp_path / "fixture-runtime"
    # Availability is inspected without launching the CLI during admission.
    executable.write_text("#!/bin/sh\nexit 99\n")
    executable.chmod(0o700)
    values = {
        "archon_root": root,
        "hermes_home": root / ".hermes",
        "data_dir": root / ".data",
        "auth_token": "test",
        "start_worker": False,
        "profile": "archon",
        "prime_executable": executable,
        "pi_executable": executable,
        "prime_agent_session_dir": root / ".prime/sessions",
        "pi_agent_session_dir": root / ".pi/sessions",
    }
    values.update(overrides)
    return Settings(**values)


@pytest.fixture
def runtime_api(tmp_path):
    settings = runtime_settings(tmp_path)
    app = create_app(settings)
    with TestClient(app) as client:
        client.headers["Authorization"] = "Bearer test"
        yield client, app, settings


def submit(client, **overrides):
    payload = {"prompt": "fixture task", "approval_mode": "auto"}
    payload.update(overrides)
    return client.post("/api/tasks", json=payload)


def assert_not_enqueued(client, response, expected=409):
    assert response.status_code == expected, response.text
    assert client.get("/api/tasks").json()["tasks"] == []


@pytest.mark.parametrize("owner,other", [("pi", None), (None, "pi")])
def test_reply_stays_with_session_runtime(runtime_api, owner, other):
    client, _, settings = runtime_api
    first_response = submit(client, profile=owner, cwd=str(settings.archon_root))
    assert first_response.status_code == 202, first_response.text
    first = first_response.json()["task"]
    reply = submit(client, session_id=first["session_id"], profile=other)
    assert reply.status_code == 202, reply.text
    assert reply.json()["task"]["profile"] == first["profile"]
    rows = client.get("/api/sessions").json()["sessions"]
    assert next(row for row in rows if row["id"] == first["session_id"])["runtime"] == (
        "pi" if owner else "prime"
    )


@pytest.mark.parametrize("profile", [None, "default", "prime", "archon", "pi"])
def test_only_registered_runtimes_and_explicit_legacy_aliases_are_admitted(runtime_api, profile):
    client, _, settings = runtime_api
    response = submit(client, profile=profile)
    assert response.status_code == 202, response.text
    task = response.json()["task"]
    assert task["cwd"] == str(settings.archon_root.resolve())
    rows = client.get("/api/sessions").json()["sessions"]
    assert next(row for row in rows if row["id"] == task["session_id"])["runtime"] == (
        "pi" if profile == "pi" else "prime"
    )


@pytest.mark.parametrize("profile", ["typo", "operator-roster"])
def test_unknown_or_roster_only_profile_is_rejected_before_enqueue(runtime_api, profile):
    client, _, settings = runtime_api
    roster = settings.hermes_home / "profiles" / "operator-roster"
    roster.mkdir(parents=True)
    (roster / "config.yaml").write_text("model:\n  default: fixture-model\n")
    assert_not_enqueued(client, submit(client, profile=profile))


@pytest.mark.parametrize("mode", [None, "approve", "plan"])
@pytest.mark.parametrize("profile", ["prime", "pi"])
def test_unsupported_protected_modes_are_rejected_before_enqueue(runtime_api, mode, profile):
    client, _, _ = runtime_api
    payload = {"prompt": "must not run", "profile": profile}
    if mode is not None:
        payload["approval_mode"] = mode
    assert_not_enqueued(client, client.post("/api/tasks", json=payload))


@pytest.mark.parametrize("profile", ["prime", "pi"])
def test_unverified_chat_only_restriction_is_rejected_before_enqueue(runtime_api, profile):
    client, _, _ = runtime_api
    assert_not_enqueued(client, submit(client, profile=profile, chat_only=True))


@pytest.mark.parametrize("profile", ["prime", "pi"])
@pytest.mark.parametrize("availability", ["missing", "not-executable"])
def test_unavailable_native_runtime_fails_before_enqueue(tmp_path, profile, availability):
    executable = tmp_path / "unavailable"
    if availability == "not-executable":
        executable.write_text("fixture")
        executable.chmod(0o600)
    settings = runtime_settings(tmp_path, **{f"{profile}_executable": executable})
    with TestClient(create_app(settings)) as client:
        client.headers["Authorization"] = "Bearer test"
        assert_not_enqueued(client, submit(client, profile=profile), expected=503)


def test_task_cwd_is_canonicalized_before_enqueue(runtime_api):
    client, _, settings = runtime_api
    target = settings.archon_root / "target"
    target.mkdir()
    alias = settings.archon_root / "alias"
    alias.symlink_to(target, target_is_directory=True)
    response = submit(client, cwd=str(alias / ".." / "alias"))
    assert response.status_code == 202, response.text
    assert response.json()["task"]["cwd"] == str(target.resolve())


@pytest.mark.parametrize("kind", ["missing", "file", "outside", "symlink-escape"])
def test_invalid_or_escaping_cwd_is_rejected_before_enqueue(runtime_api, tmp_path, kind):
    client, _, settings = runtime_api
    requested = settings.archon_root / kind
    if kind == "file":
        requested.write_text("not a directory")
    elif kind in {"outside", "symlink-escape"}:
        outside = tmp_path / "outside"
        outside.mkdir()
        if kind == "symlink-escape":
            requested.symlink_to(outside, target_is_directory=True)
        else:
            requested = outside
    assert_not_enqueued(client, submit(client, cwd=str(requested)))


def test_selected_project_defaults_to_its_registered_folder(runtime_api):
    client, _, _ = runtime_api
    project = client.post("/api/projects", json={"name": "Selected"}).json()["project"]
    response = submit(client, project_id=project["id"])
    assert response.status_code == 202, response.text
    assert response.json()["task"]["cwd"] == project["primary_path"]


def test_selected_project_rejects_a_different_registered_project_folder(runtime_api):
    client, _, _ = runtime_api
    first = client.post("/api/projects", json={"name": "First"}).json()["project"]
    second = client.post("/api/projects", json={"name": "Second"}).json()["project"]
    assert_not_enqueued(client, submit(client, project_id=first["id"], cwd=second["primary_path"]))


def test_registered_project_can_execute_outside_scratch_root(runtime_api, tmp_path):
    client, _, _ = runtime_api
    project = client.post(
        "/api/projects", json={"name": "Registered", "path": str(tmp_path / "registered")}
    ).json()["project"]
    response = submit(client, project_id=project["id"], cwd=project["primary_path"])
    assert response.status_code == 202, response.text
    assert response.json()["task"]["cwd"] == project["primary_path"]


def test_unknown_project_is_rejected_before_enqueue(runtime_api):
    client, _, _ = runtime_api
    assert_not_enqueued(client, submit(client, project_id="unknown-project"), expected=404)


def test_resume_rejects_explicit_cwd_that_differs_from_session_owner(runtime_api):
    client, _, settings = runtime_api
    first = submit(client).json()["task"]
    other = settings.archon_root / "other"
    other.mkdir()
    reply = submit(client, session_id=first["session_id"], cwd=str(other))
    assert reply.status_code == 409, reply.text
    assert len(client.get("/api/tasks").json()["tasks"]) == 1


def test_resume_does_not_fallback_when_original_cwd_disappears(runtime_api):
    client, _, settings = runtime_api
    original = settings.archon_root / "original"
    original.mkdir()
    first = submit(client, cwd=str(original)).json()["task"]
    original.rmdir()
    reply = submit(client, session_id=first["session_id"])
    assert reply.status_code == 409, reply.text
    assert len(client.get("/api/tasks").json()["tasks"]) == 1


def test_resume_rejects_conflicting_project_assignment(runtime_api):
    client, _, _ = runtime_api
    first = client.post("/api/projects", json={"name": "First"}).json()["project"]
    second = client.post("/api/projects", json={"name": "Second"}).json()["project"]
    task = submit(client, project_id=first["id"], cwd=first["primary_path"]).json()["task"]
    reply = submit(client, session_id=task["session_id"], project_id=second["id"])
    assert reply.status_code == 409, reply.text
    assert len(client.get("/api/tasks").json()["tasks"]) == 1
    with runtime_api[1].state.store.db.connect() as conn:
        row = conn.execute(
            "SELECT project_id FROM session_projects WHERE session_id=?", (task["session_id"],)
        ).fetchone()
    assert row["project_id"] == first["id"]


def test_runtime_descriptors_expose_only_verified_execution_capabilities(runtime_api):
    client, _, _ = runtime_api
    response = client.get("/api/runtimes")
    assert response.status_code == 200, response.text
    runtimes = {item["id"]: item for item in response.json()["runtimes"]}
    assert set(runtimes) == {"prime", "pi"}
    for runtime in runtimes.values():
        assert runtime["available"] is True
        assert runtime["modes"] == [{"id": "auto", "label": "Trusted execution", "restricted": False}]
        assert runtime["sandboxed"] is False
        assert runtime["chat_only"] is False
        assert runtime["availability_check"] == "executable_file"
    assert {"prime", "default", "archon"} <= set(runtimes["prime"]["aliases"])
    client.headers.pop("Authorization")
    assert client.get("/api/runtimes").status_code == 401


def test_runtime_descriptor_reports_unavailable_without_hiding_runtime(tmp_path):
    settings = runtime_settings(tmp_path, pi_executable=tmp_path / "missing-pi")
    with TestClient(create_app(settings)) as client:
        response = client.get("/api/runtimes", headers={"Authorization": "Bearer test"})
        assert response.status_code == 200, response.text
        runtimes = {item["id"]: item for item in response.json()["runtimes"]}
        assert runtimes["prime"]["available"] is True
        assert runtimes["pi"]["available"] is False


def test_projectless_task_uses_explicit_configured_scratch_root(tmp_path):
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    settings = runtime_settings(tmp_path, task_scratch_root=scratch)
    with TestClient(create_app(settings)) as client:
        client.headers["Authorization"] = "Bearer test"
        response = submit(client)
        assert response.status_code == 202, response.text
        assert response.json()["task"]["cwd"] == str(scratch.resolve())
        blocked = submit(client, cwd=str(settings.archon_root))
        assert blocked.status_code == 409, blocked.text
        assert len(client.get("/api/tasks").json()["tasks"]) == 1


def test_explicit_configured_profile_alias_can_select_runtime(tmp_path):
    settings = runtime_settings(tmp_path, runtime_profile_aliases={"personal-pi": "pi"})
    with TestClient(create_app(settings)) as client:
        client.headers["Authorization"] = "Bearer test"
        response = submit(client, profile="personal-pi")
        assert response.status_code == 202, response.text
        assert response.json()["task"]["profile"] == "pi"


class RecordingRuntime:
    def __init__(self):
        self.tasks = []

    async def run(self, task, emit):
        self.tasks.append(dict(task))
        return {"text": "fixture result"}


@pytest.mark.asyncio
@pytest.mark.parametrize("invalid", ["protected-mode", "deleted-cwd", "unknown-profile", "symlink-retarget"])
async def test_worker_revalidates_direct_store_tasks_before_calling_runner(tmp_path, invalid):
    settings = runtime_settings(tmp_path)
    runner = RecordingRuntime()
    app = create_app(settings, runner=runner)
    directory = settings.archon_root / "task-folder"
    directory.mkdir()
    with TestClient(app):
        task = app.state.store.submit(
            "fixture task", cwd=str(directory),
            approval_mode="approve" if invalid == "protected-mode" else "auto",
            profile="unknown" if invalid == "unknown-profile" else "prime",
        )
        if invalid in {"deleted-cwd", "symlink-retarget"}:
            directory.rmdir()
        if invalid == "symlink-retarget":
            outside = tmp_path / "outside"
            outside.mkdir()
            directory.symlink_to(outside, target_is_directory=True)
        assert await app.state.engine.run_once() is True
        saved = app.state.store.get(task["id"])
        assert saved["status"] == "failed"
        assert saved["error"]
        assert runner.tasks == []


@pytest.mark.asyncio
async def test_registered_project_outside_scratch_is_bound_before_worker_dispatch(tmp_path):
    settings = runtime_settings(tmp_path)
    runner = RecordingRuntime()
    app = create_app(settings, runner=runner)
    with TestClient(app) as client:
        client.headers["Authorization"] = "Bearer test"
        project = client.post(
            "/api/projects", json={"name": "External project", "path": str(tmp_path / "project")}
        ).json()["project"]
        response = submit(client, project_id=project["id"])
        assert response.status_code == 202, response.text
        task = response.json()["task"]
        assert await app.state.engine.run_once() is True
        assert app.state.store.get(task["id"])["status"] == "completed"
        assert len(runner.tasks) == 1
        assert runner.tasks[0]["cwd"] == project["primary_path"]
        with app.state.store.db.connect() as conn:
            assignment = conn.execute(
                "SELECT project_id FROM session_projects WHERE session_id=?", (task["session_id"],)
            ).fetchone()
        assert assignment["project_id"] == project["id"]
